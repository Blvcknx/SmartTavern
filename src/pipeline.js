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
    log, warn, getSettings,
    cardText, chatExcerpt, charKey, getChatStore, getStoredProfile,
    resolveTargetChar, resolveMemberByMessageName, getMainCharacter, isPlainObject,
    clampInt, substituteParamsSafe, STEP_ROLES, captureChatScope,
} from './state.js';
import { system_message_types } from '../../../../system-messages.js';
import { generateWithRetry, withInternalGeneration, isInternalGeneration, createGenerationControl, isAbortError, throwIfAborted, withInterceptorScope } from './gen.js';
import { bootstrapProfile, serializeProfile } from './profiles.js';
import { activityStart, activityStatus, activityEntry, activityFail, activityEnd, activitySteps, activityStepState, activityRefinementControls } from './progress.js';
import { refinementIssues, hasRefinedPayload } from './refinement-checks.js';
import { applyVeil, setVeilStep, setVeilStatus, revealVeil, dismissVeil, armPreVeil } from './veil.js';
import { stagePromptTail, clearPromptTail } from './tail.js';

export const EPHEMERAL_FLAG = 'smarttavern_ephemeral';

const MACRO_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

const STEP_SYSTEM = 'You are a state-assessment engine for an interactive fiction platform. Follow the task instructions precisely and output only the requested prose with no preamble, headings or meta commentary.';

const REFINEMENT_SYSTEM = 'You are a surgical prose editor and continuity auditor for an interactive fiction platform. Make only the targeted adjustments requested by the user prompt while preserving the original scene events, pacing, and structure. Output only the final revised reply (or the requested XML tags) with no meta-commentary or preamble.';

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
 * Builds the resolver for SmartTavern macros. Unknown macros return null so they are left
 * intact for SillyTavern's own substitution pass.
 *
 * `step` (optional) carries a per-step `lookback` override for {{chat}}. `stepsList`
 * selects the step list behind {{step:Name}} / {{steps}} (expansion steps or refinement
 * passes — refinement macros must never resolve against the expansion list).
 * `currentDraft` / `originalDraft` feed {{draft}} / {{original_draft}} in refinement
 * passes; `draftMessageId` excludes the message being refined from chat excerpts so
 * the draft is never duplicated inside {{chat}}.
 */
export function makeMacroResolver({ char, profile, chat, stepOutputs, settings, step = null, stepsList = null, currentDraft = null, originalDraft = null, draftMessageId = null }) {
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

export function assembleInjection({ settings, char, profile, chat, stepOutputs }) {
    return assembleInjectionBlocks({ settings, char, profile, chat, stepOutputs })
        .map(block => block.text).join('\n\n');
}

export function assembleInjectionBlocks({ settings, char, profile, chat, stepOutputs }) {
    const resolve = makeMacroResolver({ char, profile, chat, stepOutputs, settings });
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
    if (!settings.enabled || !settings.expansionEnabled) return null;
    if (type === 'quiet' || type === 'impersonate') return null;
    if (isInternalGeneration()) return null;

    const arr = Array.isArray(chat) ? chat : (context.chat ?? []);
    if (!arr.length) return null;

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

        const { stepOutputs, stepStats } = await runSteps({ char, profile, chat: arr, settings, signal: control.signal });
        throwIfAborted(control.signal);
        if (!isCurrentChat()) return null;
        const resolve = makeMacroResolver({ char, profile, chat: arr, stepOutputs, settings, stepsList: settings.steps });
        const injectionText = stepBlocks(settings.steps, stepOutputs).length
            ? (settings.injectAnchor === 'prompt-end'
                ? substituteParamsSafe(expandMacros(settings.tailPrompt ?? '', resolve)).trim()
                : assembleInjection({ settings, char, profile, chat: arr, stepOutputs }))
            : '';
        if (!inject) return recordLastRun({ char, profile, stepOutputs, stepStats, injectionText }, 'expansion', 'dry run');

        if (settings.injectAnchor === 'prompt-end') {
            if (injectionText) {
                const role = STEP_ROLES.includes(settings.tailRole) ? settings.tailRole : 'assistant';
                const reservation = stagePromptTail(injectionText, role);
                // Preserve the actual final history message: continue-generation
                // processing must not mistake our reservation for its target.
                injectEphemeral(arr, reservation, settings, role, Math.max(0, arr.length - 1));
                summary = 'Reply prompt tail prepared';
                activityEntry({ title: `Prompt tail prepared · ${role} · ${injectionText.length} chars`, tone: 'info', text: injectionText });
            } else summary = 'Nothing to inject';
            return recordLastRun({ char, profile, stepOutputs, stepStats, injectionText }, 'expansion', 'generation');
        }
        const blocks = assembleInjectionBlocks({ settings, char, profile, chat: arr, stepOutputs });
        if (!blocks.length) {
            summary = 'Nothing to inject';
            return recordLastRun({ char, profile, stepOutputs, stepStats, injectionText }, 'expansion', 'generation');
        }

        let index = resolveInjectIndex(arr, settings);
        for (const block of blocks) {
            injectEphemeral(arr, block.text, settings, block.role, index++);
            activityEntry({ title: `Injecting ${block.text.length} chars as ${block.role}`, tone: 'info', text: block.text });
        }
        return recordLastRun({ char, profile, stepOutputs, stepStats, injectionText }, 'expansion', 'generation');
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

/** Enabled refinement passes (non-empty prompt), shared by veil arming and the pipeline. */
function enabledRefinementSteps(settings) {
    return (Array.isArray(settings.refinementSteps) ? settings.refinementSteps : [])
        .filter(s => s && s.enabled !== false && String(s?.prompt ?? '').trim());
}

/** Strips audit blocks, stray refinement tags and a surrounding code fence. */
function stripRefinedNoise(text) {
    let out = String(text ?? '').trim();
    const fenced = out.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    if (fenced) out = fenced[1].trim();
    out = out.replace(/<audit>[\s\S]*?<\/audit>/gi, '');
    out = out.replace(/<\/?(?:revised_reply|final_reply|audit)>/gi, '');
    return out.trim();
}

/**
 * Extracts the refined reply from a refinement pass. Models may reason inside
 * <audit>...</audit> first; only the <revised_reply>/<final_reply> payload (or the
 * cleaned raw output) becomes the new draft. `<audit>PASS</audit>` keeps the draft.
 */
export function extractRefinedDraft(rawOutput, fallbackDraft) {
    const fallback = typeof fallbackDraft === 'string' ? fallbackDraft : String(fallbackDraft ?? '');
    const text = String(rawOutput ?? '').trim();
    if (!text) return fallback;
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

    const steps = enabledRefinementSteps(settings);
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
                const resolve = makeMacroResolver({
                    char, profile, chat: arr, stepOutputs, settings,
                    stepsList: steps, step, currentDraft, originalDraft, draftMessageId: messageId,
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
                            systemPrompt: REFINEMENT_SYSTEM,
                            prompt: text,
                            maxTokens: settings.stepMaxTokens,
                            checkOutput: false,
                        }));
                        throwIfAborted(passControl.signal);
                        if (!isCurrentDraft()) return null;
                        output = String(result?.content ?? '').trim();
                        extracted = extractRefinedDraft(output, workingDraft);
                        issues = refinementIssues(output);
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
                // A pass that returned no revised payload (bare prose, or only an
                // audit) is a skip, not a revision: keep the last accepted draft
                // rather than adopting untagged output as the reply.
                if (output && !hasRefinedPayload(output)) {
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
                activityEntry({
                    title: `${label} · ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ${output.length} chars`,
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
        // A real generation is starting: mark the reply that is about to be rendered as
        // fresh, so refinement (and the veil) may only ever touch it — never an existing
        // message that is merely re-rendered (chat loads, a new chat's greeting).
        if (settings.refinementEnabled) {
            markFreshGeneration();
            // A fresh generation clears the refined-flag so the new draft gets refined
            // again; merely viewing an existing message (swipes) never runs this. ST
            // pops the swiped message from the interceptor's core-chat copy, so the
            // flag must be cleared on the live chat: its last character message is
            // where swipe and continue drafts land (a normal reply is a brand-new
            // message that never carried the flag).
            clearRefinedFlag();
            // Veiled mode blurs the reply the moment its DOM node appears — the render
            // event that starts refinement fires only once the (possibly streamed)
            // reply is complete, which would leave a streamed draft fully readable.
            if (settings.refinementDisplay === 'veiled' && enabledRefinementSteps(settings).length) {
                armPreVeil({ isValid: () => hasFreshReply() });
            }
        }
        // Expansion is a separate, independent pipeline: it runs BEFORE the reply and
        // injects its outputs into the prompt; refinement runs after rendering.
        if (settings.expansionEnabled) {
            // The foreground generation is parked on this interceptor while the pipeline
            // runs, so its internal calls are exempt from gen.js's foreground-idle wait.
            await withInterceptorScope(() => runPipeline({ chat, inject: true, type }));
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
