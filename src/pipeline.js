// SmartTavern — macro expansion, the chained multi-pass pipeline, ephemeral prompt
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
    resolveTargetChar, clampInt, substituteParamsSafe,
} from './state.js';
import { generateVia, withInternalGeneration, isInternalGeneration } from './gen.js';
import { bootstrapProfile, serializeProfile } from './profiles.js';

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

export function assembleInjection({ settings, char, profile, chat, stepOutputs }) {
    const resolve = makeMacroResolver({ char, profile, chat, stepOutputs, settings });
    const parts = [];
    const header = expandMacros(settings.injectionHeader ?? '', resolve).trim();
    if (header) parts.push(header);
    for (const step of (Array.isArray(settings.steps) ? settings.steps : [])) {
        if (!step || step.enabled === false) continue;
        const output = String(stepOutputs?.[step.name] ?? '').trim();
        if (!output) continue;
        parts.push(`[${step.name}]\n${output}`);
    }
    const footer = expandMacros(settings.injectionFooter ?? '', resolve).trim();
    if (footer) parts.push(footer);
    return parts.join('\n\n').trim();
}

export function injectEphemeral(chatArr, text, settings) {
    const context = getContext();
    const depth = clampInt(settings.injectDepth, 0, 50, 1);
    const index = Math.max(0, chatArr.length - depth);
    const message = {
        name: settings.injectName || 'SmartTavern',
        is_user: false,
        is_system: true,
        mes: text,
        send_date: typeof context.humanizedDateTime === 'function' ? context.humanizedDateTime() : new Date().toISOString(),
        extra: { isSmartTavern: true },
        [EPHEMERAL_FLAG]: true,
    };
    chatArr.splice(index, 0, message);
    return index;
}

// --------------------------------------------------------------------------------------------
// Pipeline
// --------------------------------------------------------------------------------------------

async function runSteps({ char, profile, chat, settings }) {
    const stepOutputs = {};
    const steps = (Array.isArray(settings.steps) ? settings.steps : [])
        .filter(s => s && s.enabled !== false && String(s?.prompt ?? '').trim());
    const resolve = makeMacroResolver({ char, profile, chat, stepOutputs, settings });
    for (const step of steps) {
        const label = step.name || 'Unnamed step';
        try {
            const expanded = expandMacros(step.prompt, resolve);
            const result = await withInternalGeneration(() => generateVia({
                profileId: step.profileId || '',
                systemPrompt: STEP_SYSTEM,
                prompt: substituteParamsSafe(expanded),
                maxTokens: settings.stepMaxTokens,
            }));
            stepOutputs[step.name] = String(result?.content ?? '').trim();
            log(`step "${label}" finished (${stepOutputs[step.name].length} chars)`);
        } catch (error) {
            warn(`pipeline step "${label}" failed`, error);
            stepOutputs[step.name] = '';
        }
    }
    return stepOutputs;
}

/**
 * Runs the full SmartTavern flow: optional inline bootstrap, then all enabled steps
 * sequentially, then (unless `inject: false`) the ephemeral state-block injection.
 *
 * @returns {Promise<{char, profile, stepOutputs}|null>} null when nothing ran
 */
export async function runPipeline({ chat = null, inject = true, bootstrap = true, type = 'normal' } = {}) {
    const context = getContext();
    const settings = getSettings();
    if (!settings.enabled) return null;
    if (type === 'quiet' || type === 'impersonate') return null;
    if (isInternalGeneration()) return null;

    const arr = Array.isArray(chat) ? chat : (context.chat ?? []);
    if (!arr.length) return null;

    if (inject) sweepEphemeral(arr);

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
    const stepOutputs = await runSteps({ char, profile, chat: arr, settings });

    if (!inject) return recordLastRun({ char, profile, stepOutputs }, 'dry run');

    const text = assembleInjection({ settings, char, profile, chat: arr, stepOutputs });
    if (!text) return recordLastRun({ char, profile, stepOutputs }, 'generation');

    const index = injectEphemeral(arr, text, settings);
    log(`injected state block at core chat index ${index}`);
    return recordLastRun({ char, profile, stepOutputs }, 'generation');
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
