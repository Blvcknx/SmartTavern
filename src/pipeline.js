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
    resolveTargetChar, clampInt, substituteParamsSafe, STEP_ROLES,
} from './state.js';
import { generateVia, withInternalGeneration, isInternalGeneration } from './gen.js';
import { bootstrapProfile, serializeProfile } from './profiles.js';
import { activityStart, activityStatus, activityEntry, activityFail, activityEnd } from './progress.js';

export const EPHEMERAL_FLAG = 'smarttavern_ephemeral';

const MACRO_RE = /\{\{\s*([^{}]+?)\s*\}\}/g;

const STEP_SYSTEM = 'You are a state-assessment engine for an interactive fiction platform. Follow the task instructions precisely and output only the requested prose with no preamble, headings or meta commentary.';

const FINAL_SYSTEM = 'You are a state-synthesis engine for an interactive fiction platform. Follow the task instructions precisely and output only the requested prose with no preamble, headings or meta commentary.';

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
        finalOutput: result.finalOutput ?? '',
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

export function assembleInjection({ settings, char, profile, chat, stepOutputs, finalOutput = '' }) {
    const resolve = makeMacroResolver({ char, profile, chat, stepOutputs, settings });
    const parts = [];
    const header = expandMacros(settings.injectionHeader ?? '', resolve).trim();
    if (header) parts.push(header);
    // 'replace' mode: the final pass output becomes the whole injected block. When the final
    // pass is off, failed, or in 'append' mode, the raw step blocks are injected instead
    // (append adds the final output as one extra block).
    const finalCfg = settings.finalStep;
    const finalText = finalCfg && finalCfg.enabled !== false ? String(finalOutput ?? '').trim() : '';
    if (finalText && (finalCfg.mode ?? 'replace') === 'replace') {
        parts.push(finalText);
    } else {
        parts.push(...stepBlocks(settings, stepOutputs));
        if (finalText) parts.push(`[${finalCfg.name || 'Final'}]\n${finalText}`);
    }
    const footer = expandMacros(settings.injectionFooter ?? '', resolve).trim();
    if (footer) parts.push(footer);
    return parts.join('\n\n').trim();
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

export function injectEphemeral(chatArr, text, settings) {
    const context = getContext();
    const index = resolveInjectIndex(chatArr, settings);
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
    let index = 0;
    for (const step of steps) {
        index++;
        const label = step.name || 'Unnamed step';
        activityStatus(`Step ${index}/${steps.length} · ${label}`);
        const startedAt = Date.now();
        try {
            const expanded = expandMacros(step.prompt, resolve);
            const text = substituteParamsSafe(expanded);
            const role = STEP_ROLES.includes(step.role) ? step.role : 'user';
            // 'system' merges the body into the system message (single system turn, empty prompt);
            // 'assistant' sends it as an assistant message (prefill-style); 'user' is the default.
            const result = await withInternalGeneration(() => generateVia({
                profileId: step.profileId || '',
                systemPrompt: role === 'system' ? `${STEP_SYSTEM}\n\n${text}` : STEP_SYSTEM,
                prompt: role === 'assistant' ? [{ role: 'assistant', content: text }] : (role === 'system' ? '' : text),
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
    }
    return stepOutputs;
}

/**
 * Optional last pass: a single synthesis call over all step outputs. Returns '' when
 * disabled or failed — the injection then falls back to the raw step blocks.
 */
async function runFinalStep({ char, profile, chat, stepOutputs, settings }) {
    const finalCfg = settings.finalStep;
    if (!finalCfg || finalCfg.enabled === false) return '';
    const template = String(finalCfg.prompt ?? '').trim();
    if (!template) return '';
    const resolve = makeMacroResolver({ char, profile, chat, stepOutputs, settings });
    const text = substituteParamsSafe(expandMacros(template, resolve));
    try {
        const role = STEP_ROLES.includes(finalCfg.role) ? finalCfg.role : 'user';
        activityStatus(`Final pass · ${finalCfg.name || 'Final'}`);
        const startedAt = Date.now();
        const result = await withInternalGeneration(() => generateVia({
            profileId: finalCfg.profileId || '',
            systemPrompt: role === 'system' ? `${FINAL_SYSTEM}\n\n${text}` : FINAL_SYSTEM,
            prompt: role === 'assistant' ? [{ role: 'assistant', content: text }] : (role === 'system' ? '' : text),
            maxTokens: Number(finalCfg.maxTokens) > 0 ? Number(finalCfg.maxTokens) : settings.stepMaxTokens,
        }));
        const output = String(result?.content ?? '').trim();
        activityEntry({
            title: `${finalCfg.name || 'Final'} · ${((Date.now() - startedAt) / 1000).toFixed(1)}s · ${output.length} chars`,
            text: output,
        });
        return output;
    } catch (error) {
        warn('final pass failed; falling back to the raw step blocks', error);
        activityFail(`Final pass failed — ${error?.message ?? error}`);
        return '';
    }
}

/**
 * Runs the full SmartTavern flow: optional inline bootstrap, all enabled steps sequentially,
 * the optional final synthesis pass, then (unless `inject: false`) the ephemeral state-block
 * injection.
 *
 * @returns {Promise<{char, profile, stepOutputs, finalOutput}|null>} null when nothing ran
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
        const finalOutput = await runFinalStep({ char, profile, chat: arr, stepOutputs, settings });

        if (!inject) return recordLastRun({ char, profile, stepOutputs, finalOutput }, 'dry run');

        const text = assembleInjection({ settings, char, profile, chat: arr, stepOutputs, finalOutput });
        if (!text) {
            summary = 'Nothing to inject';
            return recordLastRun({ char, profile, stepOutputs, finalOutput }, 'generation');
        }

        const index = injectEphemeral(arr, text, settings);
        log(`injected state block at core chat index ${index}`);
        activityEntry({ title: `Injecting ${text.length} chars at core chat index ${index}`, tone: 'info', text });
        return recordLastRun({ char, profile, stepOutputs, finalOutput }, 'generation');
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
