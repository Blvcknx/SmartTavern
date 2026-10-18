// SmartTavern — macro expansion, dependency-aware block generation, ephemeral prompt
// injection and the manifest-registered generation interceptor.
//
// The interceptor receives the post-processing "core chat" array that SillyTavern builds
// for the current generation. Inserting an ephemeral message here feeds the block into
// World Info scanning and the final prompt for THIS generation only — the real chat
// history is a different array and is never mutated.
import { getContext } from '../../../../extensions.js';
import {
    log, warn, getSettings,
    cardText, chatExcerpt, charKey, getChatStore, getStoredProfile,
    resolveTargetChar, clampInt, substituteParamsSafe, STEP_ROLES,
} from './state.js';
import { system_message_types } from '../../../../system-messages.js';
import { generateVia, withInternalGeneration, isInternalGeneration } from './gen.js';
import { bootstrapProfile, serializeProfile } from './profiles.js';
import { activityStart, activityStatus, activityEntry, activityFail, activityEnd } from './progress.js';
import { stagePromptTail, clearPromptTail } from './tail.js';

export const EPHEMERAL_FLAG = 'smarttavern_ephemeral';

const MACRO_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

const STEP_SYSTEM = 'You are a state-assessment engine for an interactive fiction platform. Follow the task instructions precisely and output only the requested prose with no preamble, headings or meta commentary.';

// Characters whose bootstrap already failed this session — no retry spam per generation.
const failedBootstraps = new Set();

// Most recent pipeline run (generation or dry run), shown in the panel's Results tab.
let lastRunResult = null;

export function getLastRunResult() {
    return lastRunResult;
}

function recordLastRun(result, source) {
    lastRunResult = {
        char: result.char,
        profile: result.profile,
        stepOutputs: result.stepOutputs,
        injectionText: result.injectionText ?? '',
        source,
        at: Date.now(),
    };
    return result;
}

function bootstrapKey() {
    return String(getContext().chatId ?? 'no-chat');
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
 */
export function makeMacroResolver({ char, profile, chat, stepOutputs, settings }) {
    const fieldLookup = new Map((settings.fields ?? []).map(f => [String(f?.name ?? '').trim().toLowerCase(), String(f?.name ?? '')]));
    const stepLookup = new Map((settings.steps ?? []).map(s => [String(s?.name ?? '').trim().toLowerCase(), String(s?.name ?? '')]));

    return (macro) => {
        const raw = String(macro ?? '').trim();
        const m = raw.toLowerCase();
        const context = getContext();
        if (m === 'char') return char?.name ?? '';
        if (m === 'user') return context.name1 ?? 'User';
        if (m === 'card') return cardText(char);
        if (m === 'definitions') return serializeProfile(profile, settings.fields ?? []) || '(no profile stored yet)';
        if (m === 'chat') return chatExcerpt(chat, settings.chatLookback ?? 24);
        if (m === 'steps') return stepBlocks(settings, stepOutputs).join('\n\n') || '(no step outputs yet)';
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

/** "[Name]\noutput" blocks for every enabled step with non-empty output, in pipeline order. */
function stepBlocks(settings, stepOutputs) {
    const parts = [];
    for (const step of (Array.isArray(settings.steps) ? settings.steps : [])) {
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

async function runSteps({ char, profile, chat, settings }) {
    const stepOutputs = Object.create(null);
    const steps = (Array.isArray(settings.steps) ? settings.steps : [])
        .filter(s => s && s.enabled !== false && String(s?.prompt ?? '').trim());
    const runStep = async (step, index) => {
        const label = step.name || 'Unnamed step';
        activityStatus(`Step ${index + 1}/${steps.length} · ${label}`);
        const startedAt = Date.now();
        try {
            const earlierOutputs = Object.fromEntries(steps.slice(0, index)
                .filter(previous => Object.hasOwn(stepOutputs, previous.name))
                .map(previous => [previous.name, stepOutputs[previous.name]]));
            const resolve = makeMacroResolver({ char, profile, chat, stepOutputs: earlierOutputs, settings });
            const expanded = expandMacros(step.prompt, resolve);
            const text = substituteParamsSafe(expanded);
            const result = await withInternalGeneration(() => generateVia({
                profileId: step.profileId || '',
                systemPrompt: STEP_SYSTEM,
                prompt: text,
                maxTokens: settings.stepMaxTokens,
            }));
            const output = String(result?.content ?? '').trim();
            stepOutputs[step.name] = output;
            activityEntry({
                title: `${label} · ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ${output.length} chars`,
                text: output,
            });
            log(`step "${label}" finished (${output.length} chars)`);
        } catch (error) {
            warn(`pipeline step "${label}" failed`, error);
            stepOutputs[step.name] = '';
            activityFail(`Step "${label}" failed — ${error?.message ?? error}`);
        }
    };
    // Only explicit macro dependencies impose ordering. {{steps}} needs all earlier
    // outputs. Forward references stay empty, matching sequential execution.
    const pending = new Set(steps.map((_, index) => index));
    while (pending.size) {
        const ready = [...pending].filter(index => {
            if (settings.stepExecution === 'sequential') return index === Math.min(...pending);
            const macros = [...String(steps[index].prompt).matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)]
                .map(match => match[1].trim().toLowerCase());
            return ![...pending].some(previous => previous < index && (
                macros.includes('steps') ||
                String(steps[previous].name ?? '').trim().toLowerCase() === String(steps[index].name ?? '').trim().toLowerCase() ||
                macros.some(macro => macro.startsWith('step:') && macro.slice(5).trim() === String(steps[previous].name ?? '').trim().toLowerCase())
            ));
        });
        await Promise.all(ready.map(index => runStep(steps[index], index)));
        ready.forEach(index => pending.delete(index));
    }
    return stepOutputs;
}

/**
 * Runs the full SmartTavern flow: optional inline bootstrap, enabled steps in dependency order,
 * then (unless `inject: false`) ephemeral history injection or prompt-tail staging.
 *
 * @returns {Promise<{char, profile, stepOutputs, injectionText}|null>} null when nothing ran
 */
export async function runPipeline({ chat = null, inject = true, bootstrap = true, type = 'normal' } = {}) {
    const context = getContext();
    const settings = getSettings();
    if (!settings.enabled) return null;
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

    if (bootstrap && settings.bootstrapOnFirstMessage && !store.profiles[key] && !failedBootstraps.has(bootstrapKey())) {
        try {
            toastr.info(`SmartTavern is compiling the living profile for ${char.name}…`, 'SmartTavern', { timeOut: 10000 });
            await withInternalGeneration(() => bootstrapProfile(char, { notify: false }));
        } catch (error) {
            failedBootstraps.add(bootstrapKey());
            warn(`profile bootstrap failed for ${char.name}; continuing without injection`, error);
        }
    }

    const profile = getStoredProfile(key);
    const isDryRun = !inject;
    activityStart({ status: `${isDryRun ? 'Dry run' : 'Pipeline'} · ${char.name}` });
    let failed = false;
    let summary = isDryRun ? 'Dry run finished' : 'State block injected';
    try {
        activityEntry({
            title: profile
                ? `Living profile loaded — ${Object.keys(profile.fields ?? {}).length} fields`
                : 'No living profile stored yet',
            tone: 'info',
        });

        const stepOutputs = await runSteps({ char, profile, chat: arr, settings });
        const resolve = makeMacroResolver({ char, profile, chat: arr, stepOutputs, settings });
        const injectionText = stepBlocks(settings, stepOutputs).length
            ? (settings.injectAnchor === 'prompt-end'
                ? substituteParamsSafe(expandMacros(settings.tailPrompt ?? '', resolve)).trim()
                : assembleInjection({ settings, char, profile, chat: arr, stepOutputs }))
            : '';
        if (!inject) return recordLastRun({ char, profile, stepOutputs, injectionText }, 'dry run');

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
            return recordLastRun({ char, profile, stepOutputs, injectionText }, 'generation');
        }
        const blocks = assembleInjectionBlocks({ settings, char, profile, chat: arr, stepOutputs });
        if (!blocks.length) {
            summary = 'Nothing to inject';
            return recordLastRun({ char, profile, stepOutputs, injectionText }, 'generation');
        }

        let index = resolveInjectIndex(arr, settings);
        for (const block of blocks) {
            injectEphemeral(arr, block.text, settings, block.role, index++);
            activityEntry({ title: `Injecting ${block.text.length} chars as ${block.role}`, tone: 'info', text: block.text });
        }
        return recordLastRun({ char, profile, stepOutputs, injectionText }, 'generation');
    } catch (error) {
        failed = true;
        summary = 'Pipeline failed — see console for details';
        activityFail(summary);
        throw error;
    } finally {
        activityEnd({ ok: !failed, summary });
    }
}

// --------------------------------------------------------------------------------------------
// Interceptor (referenced by manifest.json as generate_interceptor)
// --------------------------------------------------------------------------------------------

export async function smarttavernInterceptor(chat, _contextSize, _abort, type) {
    try {
        await runPipeline({ chat, inject: true, type });
    } catch (error) {
        // Fail open: the generation proceeds without the SmartTavern block.
        warn('interceptor error; generation continues without the SmartTavern injection', error);
    }
}
