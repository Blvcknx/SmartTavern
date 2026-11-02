// SmartTavern — macro expansion, dependency-aware block generation, ephemeral prompt
// injection and the manifest-registered generation interceptor.
//
// Dual pipelines that run together without interfering: 'expansion' runs its steps
// BEFORE generation and injects their outputs into the reply prompt; 'refinement'
// lets SillyTavern draft the reply first, then runs its passes sequentially as
// post-generation refinement. Each pipeline has its own step list and its own
// enable toggle — both, either, or neither can be active.
//
// The interceptor receives the post-processing "core chat" array that SillyTavern builds
// for the current generation. Inserting an ephemeral message here feeds the block into
// World Info scanning and the final prompt for THIS generation only — the real chat
// history is a different array and is never mutated.
import { getContext } from '../../../../extensions.js';
import {
    log, warn, getSettings, getStory,
    cardText, chatExcerpt, charKey, getChatStore, getStoredProfile,
    resolveTargetChar, resolveMemberByMessageName, getMainCharacter, isPlainObject,
    clampInt, substituteParamsSafe, STEP_ROLES, captureChatScope,
} from './state.js';
import { system_message_types } from '../../../../system-messages.js';
import { generateWithRetry, withInternalGeneration, isInternalGeneration, createGenerationControl, isAbortError, throwIfAborted, withInterceptorScope } from './gen.js';
import { bootstrapProfile, serializeProfile } from './profiles.js';
import { activityStart, activityStatus, activityEntry, activityFail, activityEnd, activitySteps, activityStepState, activityRefinementControls } from './progress.js';
import { refinementIssues, hasRefinedPayload, parseDraftEdits, editIssues, applyDraftEdits, numberedDraft, paragraphBlocks, stripThinkBlocks } from './refinement-checks.js';
import { applyVeil, setVeilStep, setVeilStatus, revealVeil, dismissVeil, armPreVeil } from './veil.js';
import { stagePromptTail, clearPromptTail } from './tail.js';
import {
    prepareStoryDirective, storyMacroContext, hasStory,
    markStoryBeatDelivered, recordDirectiveInjection, resetStoryGenerationState,
    recordedDirective, compileStoryDirective,
} from './story.js';
import {
    agentActiveForTurn, runAgentLoop, resetAgentTurn, agentTurnRequirements,
} from './agent.js';
import { rollsMacroText } from './agent-core.js';

export const EPHEMERAL_FLAG = 'smarttavern_ephemeral';

const MACRO_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

const STEP_SYSTEM = 'You are a state-assessment engine for an interactive fiction platform. Follow the task instructions precisely and output only the requested prose with no preamble, headings or meta commentary.';

const REFINEMENT_SYSTEM = 'You are a surgical prose editor and continuity auditor for an interactive fiction platform. Make only the targeted adjustments requested by the user prompt while preserving the original scene events, pacing, and structure. Output only the final revised reply (or the requested XML tags) with no meta-commentary or preamble.';

// Surgical passes ('editMode: surgical'): the draft arrives as numbered paragraphs
// (<p id="1">…) and the model returns only the paragraphs it changed, as
// <edit id="N">…</edit>, <delete id="N"/> and <insert after="N">…</insert> tags.
// Unchanged paragraphs are never re-emitted, so a pass that touches 10% of the
// reply costs a fraction of a full rewrite's output tokens — this is the whole
// point of the mode: drastically faster passes. <audit>PASS</audit> keeps the
// draft. Tag-based (never JSON) so reasoning models cannot corrupt a payload.
const SURGICAL_SYSTEM = 'You are a surgical prose editor for an interactive fiction platform. The draft reply is provided as numbered paragraphs (<p id="1">, <p id="2">, …). Make only the targeted adjustments requested by the user prompt. Output <edit id="N">…</edit> containing the complete replacement text for every paragraph you change, <delete id="N"/> to remove a paragraph, and <insert after="N">…</insert> (or <insert after="end">) to add a new one. Ids must match the draft exactly. Never quote or re-output paragraphs you are not changing: unchanged paragraphs must not appear in your output at all. If nothing needs changing, output <audit>PASS</audit> only. Output only the requested tags with no meta-commentary or preamble.';

// Built-in enforcement pass, prepended to the refinement list while REQUIRED EVENTS are
// pending: the story beat's must, the thinking agent's musts and one line per binding
// dice roll. Runs in surgical mode (see SURGICAL_SYSTEM): <audit>PASS</audit> keeps the
// draft, otherwise <audit>reasoning</audit> plus only the paragraphs that must change —
// <edit id="N">…</edit> / <insert after="N">…</insert> tags weaving the missing event(s)
// in, usually near the top of the draft.
const DIRECTIVE_ENFORCEMENT_NAME = 'Directive Enforcement';
const DIRECTIVE_ENFORCEMENT_PROMPT = [
    'You are checking the DRAFT reply of {{char}} against a list of REQUIRED EVENTS.',
    'REQUIRED EVENTS (each must visibly happen on the page, not merely be alluded to):',
    '{{must}}',
    '',
    'Recent chat:',
    '{{chat}}',
    '',
    'DRAFT (paragraphs are numbered):',
    '{{draft}}',
    '',
    'If every event is contained: output <audit>PASS</audit> only.',
    'If any is missing: reason briefly in <audit>...</audit>, then weave the missing event(s) in with <edit id="N">...</edit> (full replacement text for that paragraph) and/or <insert after="N">...</insert> tags, editing as few paragraphs as possible and placing the event(s) in the first half. Match voice and format. Dice results are binding: the reply must reflect their outcome (a low roll fails, a high roll succeeds). Delete nothing meaningful. Never add actions, words or feelings for {{user}}.',
].join('\n');

// Characters whose bootstrap already failed this session — no retry spam per generation.
const failedBootstraps = new Set();

// Most recent run per pipeline (generation or dry run), shown in the panel's Results tab.
let lastExpansionRun = null;
let lastRefinementRun = null;

// Re-entrancy guard: renders (swipe views, scrollback) can re-fire the refinement event.
let refinementBusy = false;
let activeRefinement = null;

/** Accept the last completed pass and discard the currently running pass. */
export function stopRefinement() {
    if (!activeRefinement) return false;
    activeRefinement.accepted = true;
    activeRefinement.cancel();
    return true;
}

/** Discard only the active pass, then continue with the last accepted draft. */
export function skipRefinementStep() {
    const pass = activeRefinement?.pass;
    if (!pass || pass.signal.aborted) return false;
    pass.skipped = true;
    pass.cancel();
    return true;
}

async function reviewRefinementPass(label, reasons, output, signal, reviewing = false) {
    throwIfAborted(signal);
    const context = getContext();
    const content = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = `${reviewing ? 'Review failed pass' : 'Refinement pass rejected'} · ${label}`;
    const body = document.createElement('p');
    body.textContent = `${reasons.join(' ')} The last accepted draft has been kept.${reviewing && !output ? ' Accept will keep that draft because no output was returned.' : ''}`;
    content.append(heading, body);
    if (reviewing) {
        const draft = document.createElement('pre');
        draft.className = 'smarttavern_review_draft';
        draft.textContent = output || '(No output returned)';
        content.append(draft);
    }
    const popup = new context.Popup(content, context.POPUP_TYPE.CONFIRM, '', {
        okButton: reviewing ? 'Accept' : 'Retry pass', cancelButton: 'Skip Pass',
        customButtons: [{ text: reviewing ? 'Retry' : 'Review', result: context.POPUP_RESULT.CUSTOM1 }],
        defaultResult: reviewing ? context.POPUP_RESULT.CUSTOM1 : context.POPUP_RESULT.AFFIRMATIVE,
        wide: reviewing, leftAlign: reviewing,
    });
    const cancel = () => { void popup.complete(context.POPUP_RESULT.CANCELLED); };
    signal.addEventListener('abort', cancel, { once: true });
    try {
        const result = await popup.show();
        throwIfAborted(signal);
        if (result === context.POPUP_RESULT.CUSTOM1) {
            if (reviewing) return 'retry';
            signal.removeEventListener('abort', cancel);
            return await reviewRefinementPass(label, reasons, output, signal, true);
        }
        if (result === context.POPUP_RESULT.AFFIRMATIVE) return reviewing ? 'accept' : 'retry';
        return 'skip';
    } finally {
        signal.removeEventListener('abort', cancel);
    }
}

// Fresh-reply tracking: the interceptor bumps `generationEpoch` on every real
// generation, so refinement can tell a freshly generated reply apart from an existing
// message that is merely being (re-)rendered — chat loads, scrollback and the greeting
// of a brand-new chat must never be refined or veiled.
let generationEpoch = 0;
let refinedEpoch = 0;

export function markFreshGeneration() {
    generationEpoch++;
}

export function hasFreshReply() {
    return generationEpoch > refinedEpoch;
}

export function cancelFreshReply() {
    generationEpoch++;
    refinedEpoch = generationEpoch;
}

/** Consumes the fresh-reply mark; false when this render did not follow a generation. */
function consumeFreshReply() {
    if (!hasFreshReply()) return false;
    refinedEpoch = generationEpoch;
    return true;
}

export function isRefinementBusy() {
    return refinementBusy;
}

export function getLastRunResults() {
    return { expansion: lastExpansionRun, refinement: lastRefinementRun };
}

function recordLastRun(result, pipeline, source) {
    const record = {
        char: result.char,
        profile: result.profile,
        stepOutputs: result.stepOutputs,
        stepStats: result.stepStats ?? [],
        injectionText: result.injectionText ?? '',
        storyDirective: result.storyDirective ?? '',
        agentRan: Boolean(result.agentRan),
        brief: result.brief ?? '',
        agentTranscript: result.agentTranscript ?? null,
        source,
        at: Date.now(),
    };
    if (pipeline === 'refinement') lastRefinementRun = record;
    else lastExpansionRun = record;
    return result;
}

function bootstrapKey(char) {
    const context = getContext();
    return JSON.stringify([context.groupId ?? context.characterId, context.chatId ?? 'no-chat', charKey(char)]);
}

export function resetBootstrapFailures() {
    failedBootstraps.clear();
}

/** Removes leftover ephemeral messages. Defensive only: the real chat array is never touched. */
export function sweepEphemeral(chatArr = null) {
    const arr = Array.isArray(chatArr) ? chatArr : (getContext().chat ?? []);
    let removed = 0;
    for (let i = arr.length - 1; i >= 0; i--) {
        if (arr[i]?.[EPHEMERAL_FLAG]) {
            arr.splice(i, 1);
            removed++;
        }
    }
    if (removed) warn(`swept ${removed} leftover ephemeral message(s)`);
    return removed;
}

// --------------------------------------------------------------------------------------------
// Macros
// --------------------------------------------------------------------------------------------

/**
 * Rewrites an echoed numbered draft back to plain text. A paragraph wrapped as
 * <p id="N">…</p> (close tag optional) becomes its inner text; wrappers joined
 * by blank lines keep that layout naturally. Wrappers around an unchanged draft
 * must vanish before the text is shown or saved.
 */
function stripNumberedParagraphs(text) {
    if (!/<p\s+id\s*=/i.test(text)) return text;
    return text.replace(/<p\s+id\s*=\s*["']?\s*\d+\s*["']?\s*>([\s\S]*?)(?:<\/p\s*>|$)/gi, (whole, inner) => inner.trim());
}

/**
 * The REQUIRED EVENTS list for the built-in enforcement pass (and the {{must}}
 * macro): the story beat's must plus the thinking agent's musts plus one line per
 * binding dice roll. Single source of truth — refinement passes and the panel read
 * the same list.
 */
export function turnMustList(storyMust = null) {
    const items = [];
    const story = String(storyMust ?? '').trim();
    if (story) items.push(story);
    const agent = agentTurnRequirements();
    items.push(...agent.must);
    for (const roll of agent.rolls) {
        items.push(roll.outcome
            ? `Binding dice outcome (${roll.text}): ${roll.outcome}`
            : `the outcome of the dice roll (${roll.spec ?? ''}${roll.spec ? ' ' : ''}${roll.text}) is reflected in what happens`);
    }
    return items.filter(Boolean);
}

export function turnMustText(storyMust = null) {
    return turnMustList(storyMust).map(item => `- ${item}`).join('\n');
}

/**
 * True when the built-in Directive Enforcement pass belongs to the refinement list:
 * enforcement is on, refinement runs, and at least one required event exists — the
 * story beat's must, an agent must, or a binding dice roll. Before the pipeline runs
 * (pre-veil arming, dry runs) the live story is compiled speculatively — the same pure
 * function, so the prediction matches what will be injected.
 */
export function turnEnforcementActive(settings = getSettings()) {
    if (!settings || settings.enabled === false || settings.refinementEnabled === false) return false;
    if (settings.turnEnforce === false) return false;
    const directive = recordedDirective();
    let storyMust = directive?.must ?? '';
    if (!directive) {
        try {
            storyMust = compileStoryDirective(getStory(), settings)?.must ?? '';
        } catch {
            storyMust = '';
        }
    }
    if (storyMust) return true;
    const agent = agentTurnRequirements();
    return agent.must.length > 0 || agent.rolls.length > 0;
}

/**
 * Builds the resolver for SmartTavern macros. Unknown macros return null so they are left
 * intact for SillyTavern's own substitution pass.
 *
 * `step` (optional) carries a per-step `lookback` override for {{chat}}. `stepsList`
 * selects the step list behind {{step:Name}} / {{steps}} (expansion steps or refinement
 * passes — refinement macros must never resolve against the expansion list).
 * `currentDraft` / `originalDraft` feed {{draft}} / {{original_draft}} in refinement
 * passes; `draftMessageId` excludes the message being refined from chat excerpts so
 * the draft is never duplicated inside {{chat}}. `draftPlain` is the unrendered
 * working draft: surgical passes pass the numbered rendering as `currentDraft` and
 * the plain text as `draftPlain`, so {{draft}} shows the numbered paragraphs while
 * {{draft_plain}} / {{draft_paragraphs}} still resolve usefully.
 */
export function makeMacroResolver({ char, profile, chat, stepOutputs, settings, step = null, stepsList = null, currentDraft = null, originalDraft = null, draftPlain = null, draftMessageId = null, story = null, agent = null }) {
    const fieldLookup = new Map((settings.fields ?? []).map(f => [String(f?.name ?? '').trim().toLowerCase(), String(f?.name ?? '')]));
    const list = Array.isArray(stepsList) ? stepsList : (Array.isArray(settings.steps) ? settings.steps : []);
    const stepLookup = new Map(list.map(s => [String(s?.name ?? '').trim().toLowerCase(), String(s?.name ?? '')]));
    const excerptChat = (draftMessageId != null && Array.isArray(chat))
        ? chat.filter((_message, index) => index !== draftMessageId)
        : chat;
    const isCount = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;
    const lookback = isCount(step?.lookback) ? Math.round(step.lookback) : (settings.chatLookback ?? 24);

    return (macro) => {
        const raw = String(macro ?? '').trim();
        const m = raw.toLowerCase();
        const context = getContext();
        if (m === 'char') return char?.name ?? '';
        if (m === 'user') return context.name1 ?? 'User';
        if (m === 'card') return cardText(char);
        if (m === 'draft') return currentDraft ?? '';
        // {{draft_plain}}: the working draft without the numbered-paragraph
        // rendering surgical passes apply to {{draft}}.
        if (m === 'draft_plain') return draftPlain ?? currentDraft ?? '';
        // {{draft_paragraphs}}: the numbered rendering even in full-rewrite passes
        // (identical to {{draft}} in surgical mode).
        if (m === 'draft_paragraphs') {
            const base = draftPlain ?? currentDraft;
            return base ? numberedDraft(base) : '';
        }
        if (m === 'original_draft') return originalDraft ?? '';
        if (m === 'definitions') return serializeProfile(profile, settings.fields ?? []) || '(no profile stored yet)';
        if (m === 'chat') return chatExcerpt(excerptChat, lookback);
        const chatN = m.match(/^chat:(\d+)$/);
        if (chatN) return chatExcerpt(excerptChat, Number(chatN[1]));
        if (m === 'steps') return stepBlocks(list, stepOutputs).join('\n\n') || '(no step outputs yet)';
        if (m.startsWith('field:')) {
            const canonical = fieldLookup.get(raw.slice(6).trim().toLowerCase());
            const value = canonical ? profile?.fields?.[canonical] : undefined;
            return typeof value === 'string' ? value : '';
        }
        if (m.startsWith('step:')) {
            const canonical = stepLookup.get(raw.slice(5).trim().toLowerCase());
            const value = canonical ? stepOutputs?.[canonical] : undefined;
            return typeof value === 'string' ? value : '';
        }
        // Story Director macros. story-core's compiled directive contains no secrets,
        // cast secrets or future chapters — neither may any of these.
        if (m === 'story') return story?.text ?? '';
        // {{must}} is the full REQUIRED EVENTS list (story beat + agent musts + rolls).
        if (m === 'must') return turnMustText(story?.must ?? null) || String(story?.must ?? '');
        if (m === 'beat') return story?.beat ?? '';
        if (m === 'chapter') return story?.chapter ?? '';
        if (m === 'ledger') return story?.ledger ?? '';
        // Thinking agent macros: the compiled Turn Brief and the dice line(s).
        if (m === 'brief') return agent?.brief ?? '';
        if (m === 'rolls') return agent?.rollsText ?? '';
        return null;
    };
}

export function expandMacros(template, resolve) {
    return String(template ?? '').replace(MACRO_RE, (whole, inner) => {
        const value = resolve(inner);
        return (value === null || value === undefined) ? whole : String(value);
    });
}

// --------------------------------------------------------------------------------------------
// Injection
// --------------------------------------------------------------------------------------------

/** "[Name]\noutput" blocks for every enabled step with non-empty output, in list order. */
function stepBlocks(stepsList, stepOutputs) {
    const parts = [];
    for (const step of (Array.isArray(stepsList) ? stepsList : [])) {
        if (!step || step.enabled === false) continue;
        const output = String(stepOutputs?.[step.name] ?? '').trim();
        if (!output) continue;
        parts.push(`[${step.name}]\n${output}`);
    }
    return parts;
}

export function assembleInjection({ settings, char, profile, chat, stepOutputs, story = null }) {
    return assembleInjectionBlocks({ settings, char, profile, chat, stepOutputs, story })
        .map(block => block.text).join('\n\n');
}

export function assembleInjectionBlocks({ settings, char, profile, chat, stepOutputs, story = null }) {
    const resolve = makeMacroResolver({ char, profile, chat, stepOutputs, settings, story });
    const parts = [];
    const roleFor = step => STEP_ROLES.includes(step?.role) ? step.role : 'assistant';
    const add = (text, role) => { if (text) parts.push({ text, role }); };
    const header = expandMacros(settings.injectionHeader ?? '', resolve).trim();
    for (const step of settings.steps ?? []) {
        if (!step || step.enabled === false) continue;
        const output = String(stepOutputs?.[step.name] ?? '').trim();
        if (output) add(`[${step.name}]\n${output}`, roleFor(step));
    }
    const footer = expandMacros(settings.injectionFooter ?? '', resolve).trim();
    // No prompt/header-only injection when every assessment failed.
    if (!parts.length) return parts;
    if (header) parts[0].text = `${header}\n\n${parts[0].text}`;
    if (footer) parts[parts.length - 1].text += `\n\n${footer}`;
    return parts;
}

function findLastUserIndex(chatArr) {
    for (let i = chatArr.length - 1; i >= 0; i--) {
        if (chatArr[i]?.is_user) return i;
    }
    return -1;
}

/**
 * Insert position of the ephemeral block in the core chat array. The anchor defines where
 * the block sits relative to the user's latest message; legacy 'depth' (and any Situation
 * without a user message) falls back to injectDepth-from-the-end.
 */
function resolveInjectIndex(chatArr, settings) {
    const depth = clampInt(settings.injectDepth, 0, 50, 1);
    const fallback = Math.max(0, chatArr.length - depth);
    switch (settings.injectAnchor) {
        case 'top-of-history':
            return 0;
        case 'before-last-user':
        case 'after-last-user': {
            const i = findLastUserIndex(chatArr);
            if (i === -1) return fallback;
            return settings.injectAnchor === 'before-last-user' ? i : i + 1;
        }
        default:
            return fallback;
    }
}

export function injectEphemeral(chatArr, text, settings, role = 'assistant', index = resolveInjectIndex(chatArr, settings)) {
    const context = getContext();
    const message = {
        name: role === 'user' ? context.name1 : (context.name2 || settings.injectName || 'SmartTavern'),
        is_user: role === 'user',
        is_system: role === 'system',
        mes: text,
        send_date: typeof context.humanizedDateTime === 'function' ? context.humanizedDateTime() : new Date().toISOString(),
        // ST maps narrator messages to the system role; is_system alone does not.
        extra: { isSmartTavern: true, ...(role === 'system' ? { type: system_message_types.NARRATOR } : {}) },
        [EPHEMERAL_FLAG]: true,
    };
    chatArr.splice(index, 0, message);
    return index;
}

// --------------------------------------------------------------------------------------------
// Pipeline
// --------------------------------------------------------------------------------------------

async function runSteps({ char, profile, chat, settings, signal }) {
    const stepOutputs = Object.create(null);
    const steps = (Array.isArray(settings.steps) ? settings.steps : [])
        .filter(s => s && s.enabled !== false && String(s?.prompt ?? '').trim());
    const stepStats = steps.map(step => ({ name: step.name || 'Unnamed step', chars: 0, elapsedMs: 0, skipped: true }));
    activitySteps({ names: steps.map(s => s.name || 'Unnamed step') });
    const runStep = async (step, index) => {
        const label = step.name || 'Unnamed step';
        activityStatus(`Step ${index + 1}/${steps.length} · ${label}`);
        activityStepState(index, 'running');
        const startedAt = Date.now();
        try {
            throwIfAborted(signal);
            const earlierOutputs = Object.fromEntries(steps.slice(0, index)
                .filter(previous => Object.hasOwn(stepOutputs, previous.name))
                .map(previous => [previous.name, stepOutputs[previous.name]]));
            const resolve = makeMacroResolver({ char, profile, chat, stepOutputs: earlierOutputs, settings, stepsList: steps, step });
            const expanded = expandMacros(step.prompt, resolve);
            const text = substituteParamsSafe(expanded);
            const result = await withInternalGeneration(() => generateWithRetry({
                signal,
                profileId: step.profileId || '',
                systemPrompt: STEP_SYSTEM,
                prompt: text,
                maxTokens: settings.stepMaxTokens,
            }));
            const output = String(result?.content ?? '').trim();
            stepOutputs[step.name] = output;
            stepStats[index] = { name: label, chars: output.length, elapsedMs: Date.now() - startedAt, failed: false };
            activityStepState(index, 'done');
            activityEntry({
                title: `${label} · ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ${output.length} chars`,
                text: output,
            });
            log(`step "${label}" finished (${output.length} chars)`);
        } catch (error) {
            if (isAbortError(error)) throw error;
            warn(`pipeline step "${label}" failed`, error);
            stepOutputs[step.name] = '';
            stepStats[index] = { name: label, chars: 0, elapsedMs: Date.now() - startedAt, failed: true };
            activityStepState(index, 'failed');
            activityFail(`Step "${label}" failed — ${error?.message ?? error}`);
        }
    };
    // Only explicit macro dependencies impose ordering. {{steps}} needs all earlier
    // outputs. Forward references stay empty, matching sequential execution.
    const tasks = [];
    steps.forEach((step, index) => {
        const macros = [...String(step.prompt).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)]
            .map(match => match[1].trim().toLowerCase());
        const dependencies = steps.slice(0, index).flatMap((previous, previousIndex) => {
            const name = String(previous.name ?? '').trim().toLowerCase();
            const depends = settings.stepExecution === 'sequential' || macros.includes('steps')
                || name === String(step.name ?? '').trim().toLowerCase()
                || macros.some(macro => macro.startsWith('step:') && macro.slice(5).trim() === name);
            return depends ? [tasks[previousIndex]] : [];
        });
        tasks.push(Promise.all(dependencies).then(() => runStep(step, index)));
    });
    await Promise.all(tasks);
    return { stepOutputs, stepStats };
}

/**
 * Runs the full SmartTavern expansion flow: optional inline bootstrap, enabled steps in
 * dependency order, then (unless `inject: false`) ephemeral history injection or
 * prompt-tail staging. Refinement is a separate pipeline (see runRefinementPipeline).
 *
 * @returns {Promise<{char, profile, stepOutputs, stepStats, injectionText}|null>} null when nothing ran
 */
export async function runPipeline({ chat = null, inject = true, bootstrap = true, type = 'normal' } = {}) {
    const context = getContext();
    const isCurrentChat = captureChatScope();
    const settings = getSettings();
    if (!settings.enabled) return null;
    if (type === 'quiet' || type === 'impersonate') return null;
    if (isInternalGeneration()) return null;

    const arr = Array.isArray(chat) ? chat : (context.chat ?? []);
    if (!arr.length) return null;

    // Story directive — its own gate, independent of expansion. Compiled here (and,
    // for swipe/regenerate, re-armed first) so it can feed the {{story}} macros below
    // AND the thinking agent (which must see exactly what the reply model is told).
    // Any compile error fails open to null (no directive, never a blocked generation).
    const directive = prepareStoryDirective({ type, mutate: inject });
    // The thinking agent is its own gate too: it runs (and injects its brief) even
    // when expansion is disabled and no story exists.
    const agentWanted = agentActiveForTurn(settings);
    if (!settings.expansionEnabled && !directive && !agentWanted) return null;

    if (inject) {
        clearPromptTail();
        sweepEphemeral(arr);
    }

    const char = resolveTargetChar(arr);
    if (!char) return null;

    const key = charKey(char);
    const store = getChatStore();
    const failureKey = bootstrapKey(char);
    const control = createGenerationControl();
    const isDryRun = !inject;
    activityStart({ status: `${isDryRun ? 'Dry run' : 'Pipeline'} · ${char.name}` });
    let failed = false;
    let summary = isDryRun ? 'Dry run finished' : 'State block injected';
    try {
        if (bootstrap && settings.bootstrapOnFirstMessage && !store.profiles[key] && !failedBootstraps.has(failureKey)) {
            try {
                toastr.info(`SmartTavern is compiling the living profile for ${char.name}…`, 'SmartTavern', { timeOut: 10000 });
                await withInternalGeneration(() => bootstrapProfile(char, { notify: false, signal: control.signal }));
            } catch (error) {
                if (isAbortError(error)) throw error;
                failedBootstraps.add(failureKey);
                warn(`profile bootstrap failed for ${char.name}; continuing without injection`, error);
            }
        }
        if (!isCurrentChat()) return null;
        const profile = getStoredProfile(key);
        activityEntry({
            title: profile
                ? `Living profile loaded — ${Object.keys(profile.fields ?? {}).length} fields`
                : 'No living profile stored yet',
            tone: 'info',
        });

        const expand = settings.expansionEnabled !== false;
        let stepOutputs = Object.create(null);
        let stepStats = [];
        if (expand) {
            ({ stepOutputs, stepStats } = await runSteps({ char, profile, chat: arr, settings, signal: control.signal }));
        } else {
            activitySteps({ names: [] }); // no expansion chips to show
        }
        throwIfAborted(control.signal);
        if (!isCurrentChat()) return null;

        // Thinking agent: runs AFTER the expansion steps (it may read their outputs as
        // context) and BEFORE the directive placement (the brief sits in front of it).
        // Any failure fails open to an empty brief — the generation continues.
        let agentResult = null;
        if (agentWanted) {
            agentResult = await runAgentLoop({
                chat: arr, char, profile, stepOutputs, directive, settings, type, dryRun: isDryRun,
            });
        }
        throwIfAborted(control.signal);
        if (!isCurrentChat()) return null;

        const storyContext = directive ? storyMacroContext(directive) : null;
        const briefText = agentResult?.brief ?? '';
        const agentMacro = briefText || (agentResult?.turn?.rolls?.length)
            ? { brief: briefText, rollsText: rollsMacroText(agentResult?.turn?.rolls ?? []) }
            : null;
        const resolve = makeMacroResolver({ char, profile, chat: arr, stepOutputs, settings, stepsList: settings.steps, story: storyContext, agent: agentMacro });
        const hasStepBlocks = stepBlocks(settings.steps, stepOutputs).length > 0;
        // A tail template that embeds {{story}} / {{brief}} carries those sections
        // itself; otherwise they are appended below in fixed order — expansion outputs,
        // then the Turn Brief, then the directive as the FINAL tail section closest to
        // generation (brief last when the Story Director is inactive).
        const tailTemplate = String(settings.tailPrompt ?? '');
        const usesStoryMacro = /\{\{\s*story\s*\}\}/i.test(tailTemplate);
        const usesBriefMacro = /\{\{\s*(brief|rolls)\s*\}\}/i.test(tailTemplate);
        let injectionText = '';
        if (settings.injectAnchor === 'prompt-end') {
            if ((expand && hasStepBlocks) || (directive && usesStoryMacro) || (briefText && usesBriefMacro)) {
                injectionText = substituteParamsSafe(expandMacros(tailTemplate, resolve)).trim();
            }
            if (briefText && !injectionText.includes(briefText)) {
                injectionText = injectionText ? `${injectionText}\n\n${briefText}` : briefText;
            }
            if (directive?.text && !injectionText.includes(directive.text)) {
                injectionText = injectionText ? `${injectionText}\n\n${directive.text}` : directive.text;
            }
        } else if (expand && hasStepBlocks) {
            injectionText = assembleInjection({ settings, char, profile, chat: arr, stepOutputs, story: storyContext });
            if (briefText && !injectionText.includes(briefText)) {
                injectionText = injectionText ? `${injectionText}\n\n${briefText}` : briefText;
            }
            if (directive?.text && !injectionText.includes(directive.text)) {
                injectionText = injectionText ? `${injectionText}\n\n${directive.text}` : directive.text;
            }
        } else if (briefText || directive?.text) {
            injectionText = [briefText, directive?.text ?? ''].filter(Boolean).join('\n\n');
        }
        // Templates may reference these macros anywhere. Relocate their complete
        // sections so the directive is still last and the brief directly precedes it.
        const turnSections = [briefText, directive?.text ?? ''].filter(Boolean);
        for (const section of turnSections) injectionText = injectionText.split(section).join('').trim();
        injectionText = [injectionText, ...turnSections].filter(Boolean).join('\n\n');
        const agentRecord = {
            agentRan: Boolean(agentResult),
            brief: briefText,
            agentTranscript: agentResult?.transcript ?? null,
        };
        if (!inject) return recordLastRun({ char, profile, stepOutputs, stepStats, injectionText, storyDirective: directive?.text ?? '', ...agentRecord }, 'expansion', 'dry run');

        if (settings.injectAnchor === 'prompt-end') {
            if (injectionText) {
                const role = STEP_ROLES.includes(settings.tailRole) ? settings.tailRole : 'assistant';
                const reservation = stagePromptTail(injectionText, role);
                // Preserve the actual final history message: continue-generation
                // processing must not mistake our reservation for its target.
                injectEphemeral(arr, reservation, settings, role, Math.max(0, arr.length - 1));
                if (directive?.text) recordDirectiveInjection(directive);
                summary = 'Reply prompt tail prepared';
                activityEntry({ title: `Prompt tail prepared · ${role} · ${injectionText.length} chars`, tone: 'info', text: injectionText });
            } else summary = 'Nothing to inject';
            return recordLastRun({ char, profile, stepOutputs, stepStats, injectionText, storyDirective: directive?.text ?? '', ...agentRecord }, 'expansion', 'generation');
        }
        const blocks = (expand ? assembleInjectionBlocks({ settings, char, profile, chat: arr, stepOutputs, story: storyContext }) : [])
            .map(block => ({ ...block, text: turnSections.reduce((text, section) => text.split(section).join(''), block.text).trim() }))
            .filter(block => block.text);
        const blockRole = STEP_ROLES.includes(settings.tailRole) ? settings.tailRole : 'assistant';
        // Turn Brief first, then the directive — history anchors keep the same relative
        // order as the prompt-end tail (expansion outputs → brief → directive last).
        if (briefText && !blocks.some(block => block.text.includes(briefText))) {
            blocks.push({ text: briefText, role: blockRole });
        }
        if (directive?.text && !blocks.some(block => block.text.includes(directive.text))) {
            blocks.push({ text: directive.text, role: blockRole });
        }
        if (!blocks.length) {
            summary = 'Nothing to inject';
            return recordLastRun({ char, profile, stepOutputs, stepStats, injectionText, storyDirective: directive?.text ?? '', ...agentRecord }, 'expansion', 'generation');
        }

        let index = resolveInjectIndex(arr, settings);
        for (const block of blocks) {
            injectEphemeral(arr, block.text, settings, block.role, index++);
            activityEntry({ title: `Injecting ${block.text.length} chars as ${block.role}`, tone: 'info', text: block.text });
        }
        if (directive?.text) recordDirectiveInjection(directive);
        return recordLastRun({ char, profile, stepOutputs, stepStats, injectionText, storyDirective: directive?.text ?? '', ...agentRecord }, 'expansion', 'generation');
    } catch (error) {
        if (isAbortError(error)) {
            control.cancel();
            summary = 'Expansion cancelled';
            return null;
        }
        failed = true;
        summary = 'Pipeline failed — see console for details';
        activityFail(summary);
        throw error;
    } finally {
        control.dispose();
        activityEnd({ ok: !failed, summary });
    }
}

// --------------------------------------------------------------------------------------------
// Refinement pipeline (post-generation multi-pass reply editing)
// --------------------------------------------------------------------------------------------

/**
 * The refinement pass list that actually runs: the enabled user passes plus the
 * built-in Directive Enforcement pass prepended while REQUIRED EVENTS are pending
 * (story beat, agent musts, dice outcomes; see turnEnforcementActive). Single source
 * of truth for everything that enumerates passes: runRefinementPipeline, the
 * interceptor's pre-veil check, chips and veil names.
 */
export function effectiveRefinementSteps(settings) {
    const steps = (Array.isArray(settings.refinementSteps) ? settings.refinementSteps : [])
        .filter(s => s && s.enabled !== false && String(s?.prompt ?? '').trim())
        .map(s => ({ ...s }));
    if (turnEnforcementActive(settings)) {
        steps.unshift({
            name: DIRECTIVE_ENFORCEMENT_NAME,
            builtin: true,
            enabled: true,
            role: 'assistant',
            profileId: settings.storyProfileId || '',
            lookback: 3,
            editMode: 'surgical',
            prompt: DIRECTIVE_ENFORCEMENT_PROMPT,
        });
    }
    return steps;
}

/** Strips audit blocks, stray refinement tags, reasoning blocks and a surrounding code fence. */
function stripRefinedNoise(text) {
    let out = stripThinkBlocks(String(text ?? '')).trim();
    const fenced = out.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    if (fenced) out = fenced[1].trim();
    out = out.replace(/<audit>[\s\S]*?<\/audit>/gi, '');
    out = out.replace(/<\/?(?:revised_reply|final_reply|audit)>/gi, '');
    // Repair: paragraphs echoed as the numbered <p id="N">…</p> draft (or wrapped
    // inside a full rewrite) recover their plain text.
    out = stripNumberedParagraphs(out);
    return out.trim();
}

/**
 * Extracts the refined reply from a refinement pass. Models may reason inside
 * <audit>...</audit> first; only the <revised_reply>/<final_reply> payload (or the
 * cleaned raw output) becomes the new draft. `<audit>PASS</audit>` keeps the draft.
 *
 * `blocks` switches the pass into surgical mode: the output is parsed as an
 * <edit>/<delete>/<insert> patch against the numbered draft instead, applied on
 * top of `fallbackDraft`'s paragraph structure. A patch that fails validation is
 * ignored (the caller surfaces it through the retry/review flow); a full
 * <revised_reply> inside a surgical pass is still honored as an escape hatch.
 */
export function extractRefinedDraft(rawOutput, fallbackDraft, { blocks = null } = {}) {
    const fallback = typeof fallbackDraft === 'string' ? fallbackDraft : String(fallbackDraft ?? '');
    const text = String(rawOutput ?? '').trim();
    if (!text) return fallback;
    if (blocks) {
        const patch = parseDraftEdits(text);
        if (!editIssues(patch, blocks).length) {
            const patched = applyDraftEdits(patch, blocks);
            if (patched) return patched;
        }
        return fallback;
    }
    const wrapped = text.match(/<revised_reply>([\s\S]*?)<\/revised_reply>/i)
        ?? text.match(/<final_reply>([\s\S]*?)<\/final_reply>/i);
    if (wrapped) return stripRefinedNoise(wrapped[1]) || fallback;
    if (/<audit>\s*PASS\s*<\/audit>/i.test(text)) return fallback;
    return stripRefinedNoise(text) || fallback;
}

/** Last non-hidden character message with content; the refinement draft candidate. */
export function findLastCharacterMessage(chatArr) {
    if (!Array.isArray(chatArr)) return null;
    for (let i = chatArr.length - 1; i >= 0; i--) {
        const message = chatArr[i];
        if (!message || message.is_user || message.is_system || message[EPHEMERAL_FLAG] || message.is_hidden) continue;
        if (String(message.mes ?? '').trim()) return message;
    }
    return null;
}

/** Persists the chat with the conditional save when the build provides it. */
async function saveRefinedChat() {
    const context = getContext();
    const save = typeof context.saveChatConditional === 'function' ? context.saveChatConditional : context.saveChat;
    if (typeof save === 'function') await save();
}

/** Re-renders the refined message in the chat DOM, then persists the chat. */
async function updateRefinedMessage(messageId, message) {
    const context = getContext();
    if (typeof context.updateMessageBlock === 'function') {
        context.updateMessageBlock(messageId, message);
    } else {
        // Fallback for builds without updateMessageBlock on the context object.
        const $mes = $(`#chat .mes[mesid="${messageId}"]`);
        const $text = $mes.find('.mes_text');
        if ($text.length && typeof context.messageFormatting === 'function') {
            $text.empty().append(context.messageFormatting(
                message.mes, message.name, message.is_system, message.is_user, messageId,
            ));
        }
    }
    await saveRefinedChat();
}

/** Append a revision with matching metadata, preserving existing alternative replies. */
function appendRefinementSwipe(message, draft, originalDraft) {
    if (!Array.isArray(message.swipes) || !message.swipes.length) {
        message.swipes = [originalDraft];
        message.swipe_id = 0;
    }
    if (!Array.isArray(message.swipe_info)) message.swipe_info = [];
    const makeInfo = () => ({
        send_date: message.send_date, gen_started: message.gen_started,
        gen_finished: message.gen_finished,
        extra: JSON.parse(JSON.stringify(message.extra ?? {})),
    });
    for (let index = 0; index < message.swipes.length; index++) {
        message.swipe_info[index] ??= makeInfo();
    }
    message.swipe_info[message.swipes.length] = makeInfo();
    message.swipes.push(draft);
    message.swipe_id = message.swipes.length - 1;
}

/**
 * Runs the enabled refinement passes strictly sequentially against the freshly generated
 * character reply. Every pass receives the current draft via {{draft}} and may return a
 * revised reply; changes are written to the message in place (and appended to the message
 * swipes when `savePassesAsSwipes` is on). With `dryRun: true` nothing is mutated — the final
 * revision is only previewed in the Results tab.
 *
 * Refinement (and its veil) only ever runs for a fresh generation — see
 * `markFreshGeneration`/`consumeFreshReply`. A dry run may be requested at any time.
 *
 * @param {number} messageId Index of the draft message inside `context.chat`
 * @param {{dryRun?: boolean, bootstrap?: boolean}} [options]
 * @returns {Promise<{char, profile, stepOutputs, stepStats, workingDraft, changed}|null>}
 */
export async function runRefinementPipeline(messageId, { dryRun = false, bootstrap = true } = {}) {
    const context = getContext();
    const isCurrentChat = captureChatScope();
    const epoch = generationEpoch;
    const settings = getSettings();
    if (!settings.enabled || !settings.refinementEnabled) return null;
    if (isInternalGeneration() || refinementBusy) return null;
    // Fresh generations only: an existing message re-rendered (new chat load, scrollback)
    // must never be refined or veiled.

    const arr = context.chat ?? [];
    const message = Number.isInteger(messageId) ? arr[messageId] : null;
    if (!message || message.is_user || message.is_system || message[EPHEMERAL_FLAG] || message.is_hidden) return null;
    const originalDraft = String(message.mes ?? '').trim();
    if (!originalDraft) return null;
    // Refined once already: swipe views and re-renders must not refine again.
    if (!dryRun && isPlainObject(message.extra) && message.extra.smarttavernRefined) return null;

    const char = context.groupId
        ? (resolveMemberByMessageName(message.name) ?? resolveTargetChar(arr))
        : (getMainCharacter() ?? resolveTargetChar(arr));
    if (!char) return null;
    if (!dryRun && !consumeFreshReply()) return null;
    let expectedDraft = message.mes;
    let expectedSwipe = message.swipe_id;
    const isCurrentDraft = () => isCurrentChat() && arr[messageId] === message
        && message.mes === expectedDraft && message.swipe_id === expectedSwipe
        && settings.enabled && settings.refinementEnabled
        && (dryRun || generationEpoch === epoch);

    const steps = effectiveRefinementSteps(settings);
    const control = createGenerationControl();
    control.accepted = false;
    if (!dryRun) activeRefinement = control;

    // Veiled mode blurs the rendered draft until the final pass lands. The veil goes up
    // BEFORE the optional bootstrap so a first-reply draft is never readable "for free"
    // while the profile compiles. Dry runs preview from the panel and never veil the
    // chat. A veiled run also saves only draft + final as swipes — per-pass swipes would
    // reintroduce the spoiler in one click.
    const veiled = !dryRun && settings.refinementDisplay === 'veiled' && steps.length > 0 && applyVeil(messageId, {
        names: steps.map(s => s.name || 'Unnamed pass'),
        allowPeek: settings.veilAllowPeek !== false,
        onEnough: stopRefinement,
        onSkip: skipRefinementStep,
    });

    const key = charKey(char);
    const store = getChatStore();
    let profile = null;
    refinementBusy = true;
    let failed = false;
    let summary = 'No pass changed the reply';
    const stepOutputs = Object.create(null);
    const stepStats = steps.map(step => ({ name: step.name || 'Unnamed pass', chars: 0, elapsedMs: 0, skipped: true }));
    let workingDraft = originalDraft;
    let changed = 0;
    let refinementSwipeAdded = false;
    const failureKey = bootstrapKey(char);

    activityStart({ status: `${dryRun ? 'Refinement dry run' : 'Refining reply'} · ${char.name}` });
    try {
        if (bootstrap && settings.bootstrapOnFirstMessage && !store.profiles[key] && !failedBootstraps.has(failureKey)) {
            try {
                toastr.info(`SmartTavern is compiling the living profile for ${char.name}…`, 'SmartTavern', { timeOut: 10000 });
                await withInternalGeneration(() => bootstrapProfile(char, { notify: false, signal: control.signal }));
            } catch (error) {
                if (isAbortError(error)) throw error;
                failedBootstraps.add(failureKey);
                warn(`profile bootstrap failed for ${char.name}; continuing without a profile`, error);
            }
        }
        if (!isCurrentDraft()) return null;
        profile = getStoredProfile(key);
        // Profile runs clear the step row, so restore it after bootstrap.
        activitySteps({ names: steps.map(s => s.name || 'Unnamed pass') });
        activityEntry({
            title: profile
                ? `Living profile loaded — ${Object.keys(profile.fields ?? {}).length} fields`
                : 'No living profile stored yet',
            tone: 'info',
        });

        // Refinement is inherently sequential: every pass refines the previous draft.
        // The story macro context carries the {{must}} of the directive injected into
        // THIS generation (the built-in enforcement pass) plus {{story}}/{{beat}}/
        // {{chapter}}/{{ledger}} for user passes.
        const storyCtx = storyMacroContext();
        for (let index = 0; index < steps.length; index++) {
            if (!isCurrentDraft()) return null;
            const step = steps[index];
            const label = step.name || 'Unnamed pass';
            activityStatus(`Pass ${index + 1}/${steps.length} · ${label}`);
            activityStepState(index, 'running');
            setVeilStatus(messageId, `Pass ${index + 1}/${steps.length} · ${label}`);
            setVeilStep(messageId, index, 'running');
            const startedAt = Date.now();
            const currentDraft = workingDraft;
            const passControl = createGenerationControl();
            const cancelPass = () => passControl.cancel();
            control.signal.addEventListener('abort', cancelPass, { once: true });
            if (control.signal.aborted) passControl.cancel();
            control.pass = passControl;
            activityRefinementControls({ onSkip: () => {
                passControl.skipped = true;
                passControl.cancel();
            }, onEnough: () => { control.accepted = true; control.cancel(); } });
            try {
                // Surgical mode: the draft travels as numbered paragraphs and the
                // model returns only the paragraphs it changes (see SURGICAL_SYSTEM).
                // Full mode keeps the classic whole-reply <revised_reply> contract.
                const surgical = step.editMode === 'surgical';
                const draftBlocks = surgical ? paragraphBlocks(currentDraft) : null;
                const resolve = makeMacroResolver({
                    char, profile, chat: arr, stepOutputs, settings,
                    stepsList: steps, step,
                    currentDraft: surgical ? numberedDraft(currentDraft) : currentDraft,
                    draftPlain: currentDraft,
                    originalDraft, draftMessageId: messageId, story: storyCtx,
                });
                const text = substituteParamsSafe(expandMacros(step.prompt, resolve));
                let output;
                let extracted;
                let attempts = 0;
                while (true) {
                    attempts++;
                    output = '';
                    extracted = currentDraft;
                    let issues;
                    try {
                        const result = await withInternalGeneration(() => generateWithRetry({
                            signal: passControl.signal,
                            profileId: step.profileId || '',
                            systemPrompt: surgical ? SURGICAL_SYSTEM : REFINEMENT_SYSTEM,
                            prompt: text,
                            maxTokens: settings.stepMaxTokens,
                            checkOutput: false,
                        }));
                        throwIfAborted(passControl.signal);
                        if (!isCurrentDraft()) return null;
                        output = String(result?.content ?? '').trim();
                        extracted = extractRefinedDraft(output, workingDraft, { blocks: draftBlocks });
                        issues = refinementIssues(output, draftBlocks);
                    } catch (error) {
                        if (isAbortError(error)) throw error;
                        issues = [`Generation failed: ${error?.message ?? error}`];
                    }
                    if (!isCurrentDraft()) return null;
                    if (!issues.length) break;
                    activityEntry({ title: `Pass "${label}" rejected`, text: issues.join('\n'), tone: 'error' });
                    stepStats[index] = { name: label, chars: 0, elapsedMs: Date.now() - startedAt, failed: true, attempts, issues };
                    activityStepState(index, 'failed');
                    setVeilStep(messageId, index, 'failed');
                    activityStatus(`Pass rejected · ${label} · awaiting retry or skip`);
                    setVeilStatus(messageId, `Pass rejected · ${label} · awaiting retry or skip`);
                    const decision = await reviewRefinementPass(label, issues, output, passControl.signal);
                    if (!isCurrentDraft()) return null;
                    if (decision === 'accept') break;
                    if (decision === 'skip') { passControl.skipped = true; passControl.cancel(); }
                    throwIfAborted(passControl.signal);
                    activityStepState(index, 'running');
                    setVeilStep(messageId, index, 'running');
                    activityStatus(`Retrying pass ${index + 1}/${steps.length} · ${label}`);
                    setVeilStatus(messageId, `Retrying pass ${index + 1}/${steps.length} · ${label}`);
                }
                control.pass = null;
                activityRefinementControls();
                // Directive Enforcement: a clean pass (PASS audit, or a revision that
                // wove the event in) means the required event is on the page — deliver
                // the beat. Skipped/failed passes leave it pending for re-injection.
                if (step.builtin && !dryRun && markStoryBeatDelivered(messageId)) {
                    activityEntry({ title: 'Story beat delivered', tone: 'info', text: 'The required event is on the page; its fact joined the story ledger.' });
                }
                // A pass that returned no revised payload (bare prose, or only an
                // audit) is a skip, not a revision: keep the last accepted draft
                // rather than adopting untagged output as the reply.
                if (output && !hasRefinedPayload(output, draftBlocks)) {
                    stepOutputs[step.name] = '';
                    stepStats[index] = { name: label, chars: 0, elapsedMs: Date.now() - startedAt, skipped: true, attempts };
                    activityStepState(index, 'skipped');
                    setVeilStep(messageId, index, 'skipped');
                    activityEntry({ title: `Pass "${label}" skipped · no revised reply returned`, tone: 'info', text: output });
                    continue;
                }
                stepOutputs[step.name] = output;
                stepStats[index] = { name: label, chars: output.length, elapsedMs: Date.now() - startedAt, failed: false, attempts };
                activityStepState(index, 'done');
                setVeilStep(messageId, index, 'done');
                // Surgical passes log the edit footprint ("2 of 7 paragraphs") —
                // the whole speed argument of the mode — full passes log chars.
                const patch = draftBlocks ? parseDraftEdits(output) : null;
                const opsLabel = patch?.kind === 'ops'
                    ? `${patch.ops.length} edit(s) across ${new Set(patch.ops.map(op => op.type === 'insert' && op.anchor === 'end' ? 'end' : op.type === 'insert' ? op.anchor : op.id)).size} of ${draftBlocks.length} paragraphs`
                    : 'full rewrite';
                activityEntry({
                    title: `${label} · ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ${draftBlocks ? opsLabel : `${output.length} chars`}`,
                    text: output,
                });
                if (extracted && extracted !== workingDraft) {
                    workingDraft = extracted;
                    changed++;
                    if (!dryRun) {
                        message.mes = workingDraft;
                        if (settings.savePassesAsSwipes && (!veiled || !refinementSwipeAdded)) {
                            appendRefinementSwipe(message, workingDraft, originalDraft);
                            refinementSwipeAdded = true;
                        }
                        // Keep the selected swipe consistent even when saving extra
                        // revisions is disabled; switching away and back must not undo edits.
                        if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
                            message.swipes[message.swipe_id] = workingDraft;
                        }
                        expectedDraft = message.mes;
                        expectedSwipe = message.swipe_id;
                        await updateRefinedMessage(messageId, message);
                        if (!isCurrentDraft()) return null;
                    }
                }
            } catch (error) {
                if (isAbortError(error)) {
                    if (passControl.skipped && !control.signal.aborted && isCurrentDraft()) {
                        stepStats[index] = { ...stepStats[index], name: label, chars: 0, elapsedMs: Date.now() - startedAt, skipped: true };
                        activityStepState(index, 'skipped');
                        setVeilStep(messageId, index, 'skipped');
                        activityEntry({ title: `Pass "${label}" skipped · kept the last accepted draft`, tone: 'info' });
                        continue;
                    }
                    if (!control.accepted || !isCurrentDraft()) return null;
                    stepStats[index] = { name: label, chars: 0, elapsedMs: Date.now() - startedAt, cancelled: true };
                    activityStepState(index, 'skipped');
                    setVeilStep(messageId, index, 'skipped');
                    break;
                }
                warn(`refinement step "${label}" failed`, error);
                stepOutputs[step.name] = '';
                stepStats[index] = { name: label, chars: 0, elapsedMs: Date.now() - startedAt, failed: true };
                activityStepState(index, 'failed');
                setVeilStep(messageId, index, 'failed');
                activityFail(`Pass "${label}" failed — ${error?.message ?? error}`);
            } finally {
                control.signal.removeEventListener('abort', cancelPass);
                passControl.dispose();
                control.pass = null;
                activityRefinementControls();
            }
        }

        summary = changed
            ? (dryRun ? `Dry run · ${changed} pass(es) would revise the reply` : `Reply refined · ${changed} pass(es) applied`)
            : (dryRun ? 'Dry run · no pass would change the reply' : 'No pass changed the reply');
        if (control.accepted) summary = 'Refinement stopped · kept the last completed pass';

        if (!dryRun && changed) {
            // Mark as refined so re-renders (swipe views, scrollback) do not refine again;
            // the interceptor clears this flag whenever a fresh generation starts.
            if (isPlainObject(message.extra)) message.extra.smarttavernRefined = true;
            else message.extra = { smarttavernRefined: true };
            if (Array.isArray(message.swipes) && Number.isInteger(message.swipe_id)) {
                message.swipes[message.swipe_id] = workingDraft;
            }
            await saveRefinedChat();
        }
        return { char, profile, stepOutputs, stepStats, workingDraft, changed, stopped: control.accepted };
    } catch (error) {
        if (isAbortError(error)) {
            summary = control.accepted ? 'Refinement stopped · kept the original draft' : 'Refinement cancelled';
            return control.accepted && isCurrentDraft()
                ? { char, profile, stepOutputs, stepStats, workingDraft, changed, stopped: true } : null;
        }
        failed = true;
        summary = 'Refinement failed — see console for details';
        activityFail(summary);
        return null;
    } finally {
        control.dispose();
        if (activeRefinement === control) activeRefinement = null;
        stepStats.forEach((stat, index) => {
            if (!stat.skipped && !stat.cancelled) return;
            activityStepState(index, 'skipped');
            if (veiled && isCurrentChat()) setVeilStep(messageId, index, 'skipped');
        });
        recordLastRun({ char, profile, stepOutputs, stepStats, injectionText: workingDraft }, 'refinement', dryRun ? 'dry run' : 'refinement');
        // Failure reveals instantly; completion animates. message.mes always holds the
        // best draft saved so far, so both paths show real content.
        if (veiled && isCurrentChat()) revealVeil(messageId, { failed });
        // Take down any pre-veil (see armPreVeil) this run did not adopt: early exits
        // (busy, already refined, no fresh reply, empty draft) must never leave the
        // message blurred. No-op when no veil is active for the id.
        else if (!dryRun) dismissVeil(messageId);
        activityEnd({ ok: !failed, summary });
        refinementBusy = false;
    }
}

// --------------------------------------------------------------------------------------------
// Interceptor (referenced by manifest.json as generate_interceptor)
// --------------------------------------------------------------------------------------------

export async function smarttavernInterceptor(chat, _contextSize, _abort, type) {
    try {
        if (isInternalGeneration()) return;
        const settings = getSettings();
        if (type === 'quiet' || type === 'impersonate') return;
        if (!settings.enabled) return;
        if (settings.refinementEnabled) {
            // A real generation is starting: mark the reply that is about to be rendered as
            // fresh, so refinement (and the veil) may only ever touch it — never an existing
            // message that is merely re-rendered (chat loads, a new chat's greeting).
            markFreshGeneration();
            // A fresh generation clears the refined-flag so the new draft gets refined
            // again; merely viewing an existing message (swipes) never runs this. ST
            // pops the swiped message from the interceptor's core-chat copy, so the
            // flag must be cleared on the live chat: its last character message is
            // where swipe and continue drafts land (a normal reply is a brand-new
            // message that never carried the flag).
            clearRefinedFlag();
        }
        // A new generation invalidates the previous one's story bookkeeping before the
        // directive is compiled (swipe/regenerate re-arm the beat as pending inside).
        resetStoryGenerationState();
        // …and the previous generation's thinking-agent turn state (its musts/rolls feed
        // the enforcement pass for THIS generation's reply, so it must be fresh).
        resetAgentTurn();
        // The story directive and the thinking agent are their own gates: with an active
        // story or an active agent the pipeline runs (and injects) even when expansion
        // is disabled.
        if (settings.expansionEnabled || (settings.storyEnabled !== false && hasStory()) || agentActiveForTurn(settings)) {
            // The foreground generation is parked on this interceptor while the pipeline
            // runs, so its internal calls are exempt from gen.js's foreground-idle wait.
            await withInterceptorScope(() => runPipeline({ chat, inject: true, type }));
        }
        // Armed after the pipeline so the directive it just recorded is visible to
        // effectiveRefinementSteps (the enforcement pass joins the veil chips). Still
        // before any reply token renders — the reply only starts after this returns.
        if (settings.refinementEnabled && settings.refinementDisplay === 'veiled'
            && effectiveRefinementSteps(settings).length) {
            armPreVeil({ isValid: () => hasFreshReply() });
        }
    } catch (error) {
        // Fail open: the generation proceeds without the SmartTavern block.
        warn('interceptor error; generation continues without the SmartTavern injection', error);
    }
}

/**
 * Clears the refined marker on the live chat's last character message — the message a
 * swipe or continue draft lands in. The interceptor's array is a shallow core-chat
 * copy that EXCLUDES the swiped message (Generate pops it for 'swipe'), so clearing
 * on it would leave the real target flagged and every later swipe draft would skip
 * refinement.
 */
function clearRefinedFlag() {
    const target = findLastCharacterMessage(getContext().chat ?? []);
    if (target && isPlainObject(target.extra)) delete target.extra.smarttavernRefined;
}

/**
 * Refinement dry run against the last character message: previews what the enabled
 * passes would change without mutating the message, the chat or the veil.
 * Used by the panel's Results tab and the /smarttavern-run command.
 */
export async function runRefinementDryRun() {
    const arr = getContext().chat ?? [];
    const target = findLastCharacterMessage(arr);
    if (!target) return null;
    return runRefinementPipeline(arr.indexOf(target), { dryRun: true, bootstrap: false });
}
