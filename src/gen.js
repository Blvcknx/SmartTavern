// SmartTavern — generation adapter: per-call connection profiles (via the built-in
// Connection Manager) with fallback to the active connection, plus a reentrancy guard
// so our internal LLM calls never trigger the pipeline itself.
import { getContext } from '../../../../extensions.js';
import { getSettings, clampInt, warn } from './state.js';
import { activityEntry } from './progress.js';

let internalDepth = 0;

export function isInternalGeneration() {
    return internalDepth > 0;
}

export async function withInternalGeneration(fn) {
    internalDepth++;
    try {
        return await fn();
    } finally {
        internalDepth--;
    }
}

let sharedServicePromise = null;
let missingServiceWarningShown = false;
// generateRaw temporarily changes shared token-budget state in ST. Profiled
// requests can overlap, but active-connection calls (including fallbacks) cannot.
let activeQueue = Promise.resolve();

function getServiceFromContext() {
    return getContext().ConnectionManagerRequestService ?? null;
}

// Fallback for ST versions that do not expose the service through the context object yet.
async function loadServiceFallback() {
    if (!sharedServicePromise) {
        sharedServicePromise = import('../../../shared.js').catch(() => null);
    }
    const module = await sharedServicePromise;
    return module?.ConnectionManagerRequestService ?? null;
}

function warnNoConnectionManager() {
    if (missingServiceWarningShown) return;
    missingServiceWarningShown = true;
    toastr.warning('Connection Manager not found — SmartTavern will use the active connection for all internal calls.', 'SmartTavern');
}

export function listConnectionProfiles() {
    const profiles = getContext().extensionSettings?.connectionManager?.profiles;
    return Array.isArray(profiles) ? profiles : [];
}

export function getConnectionProfile(id) {
    if (!id) return null;
    return listConnectionProfiles().find(p => p?.id === id) ?? null;
}

/**
 * Runs one internal LLM call. If a connection profile is given (and available), the request
 * is sent directly against that saved API/preset/instruct without mutating global state;
 * any failure falls back to `generateRaw` on the active connection.
 *
 * @param {object} options
 * @param {string} [options.profileId] Connection Manager profile id ('' = active connection)
 * @param {string} [options.systemPrompt]
 * @param {string|Array} [options.prompt] Plain text (preferred) or Chat Completion message array
 * @param {number} [options.maxTokens]
 * @param {object|null} [options.jsonSchema] `{ name, description?, strict?, value }`; `value` is the JSON schema
 * @returns {Promise<{content: string, reasoning: string}>}
 */
export async function generateVia({ profileId = '', systemPrompt = '', prompt = '', maxTokens = 512, jsonSchema = null } = {}) {
    const context = getContext();
    const profile = profileId ? getConnectionProfile(profileId) : null;

    if (profileId && !profile) {
        warn(`Connection profile "${profileId}" not found; falling back to the active connection.`);
    }

    if (profile) {
        const service = getServiceFromContext() ?? await loadServiceFallback();
        if (service && typeof service.sendRequest === 'function') {
            try {
                const result = await generateViaService(service, profile, { systemPrompt, prompt, maxTokens, jsonSchema });
                // A technically successful request can still return garbage (sampling
                // collapse, reasoning corruption). Treat that like a failure so the
                // active connection gets a chance before any retry logic kicks in.
                const degenerate = resultDegenerateReason(result);
                if (!degenerate) return result;
                warn(`Profiled request returned ${degenerate}; falling back to the active connection.`);
            } catch (error) {
                warn('Profiled request via Connection Manager failed; falling back to the active connection.', error);
            }
        } else {
            warnNoConnectionManager();
        }
    }

    const request = activeQueue.then(() => generateViaActive(context, { systemPrompt, prompt, maxTokens, jsonSchema }));
    activeQueue = request.catch(() => {});
    return request;
}

async function generateViaService(service, profile, { systemPrompt, prompt, maxTokens, jsonSchema }) {
    const isChatCompletion = (profile.mode ?? 'cc') === 'cc';
    let payloadPrompt;
    const overridePayload = {};

    if (isChatCompletion) {
        const messages = [];
        if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
        if (Array.isArray(prompt)) messages.push(...prompt);
        else if (prompt) messages.push({ role: 'user', content: prompt });
        payloadPrompt = messages;
        if (jsonSchema) {
            overridePayload.response_format = {
                type: 'json_schema',
                json_schema: {
                    name: jsonSchema.name ?? 'response',
                    schema: jsonSchema.value ?? jsonSchema,
                    strict: jsonSchema.strict === true,
                },
            };
        }
    } else {
        let text = typeof prompt === 'string' ? prompt : flattenMessages(prompt);
        if (systemPrompt) text = `${systemPrompt}\n\n${text}`;
        if (jsonSchema) {
            text += `\n\nRespond with ONLY a valid JSON object that conforms to this schema:\n${JSON.stringify(jsonSchema.value ?? jsonSchema)}`;
        }
        payloadPrompt = text;
    }

    const result = await service.sendRequest(profile.id, payloadPrompt, maxTokens, {
        stream: false,
        extractData: true,
        includePreset: true,
        includeInstruct: true,
    }, overridePayload);

    return {
        content: String(result?.content ?? ''),
        reasoning: String(result?.reasoning ?? ''),
    };
}

function flattenMessages(prompt) {
    if (Array.isArray(prompt)) {
        return prompt.map(m => (typeof m === 'string' ? m : `[${m.role ?? 'user'}] ${m.content ?? ''}`)).join('\n\n');
    }
    return String(prompt ?? '');
}

async function generateViaActive(context, { systemPrompt, prompt, maxTokens, jsonSchema }) {
    if (typeof context.generateRaw !== 'function') {
        throw new Error('SillyTavern context does not expose generateRaw()');
    }
    const text = await context.generateRaw({
        systemPrompt,
        prompt,
        responseLength: maxTokens > 0 ? maxTokens : null,
        jsonSchema: jsonSchema ? { ...jsonSchema, returnInvalid: true } : null,
    });
    // With a schema, generateRaw returns an extracted JSON string; without, the cleaned message.
    return { content: String(text ?? ''), reasoning: '' };
}

// --------------------------------------------------------------------------------------------
// Output sanity checks and retries
// --------------------------------------------------------------------------------------------

// Some models occasionally collapse into emitting one tiny fragment forever
// ("!!!!{p{p{p{…"), often in the reasoning channel. Such a payload is garbage even
// though the request itself succeeded, so it is treated as a failure everywhere:
// profiled requests fall back to the active connection, generateWithRetry re-attempts.
const DEGENERATE_WINDOW = 2000;
const DEGENERATE_MATCH_RE = /(.{1,8}?)(?:\1){19,}/s;
const DEGENERATE_MIN_SHARE = 0.6;

/** True for empty output or output dominated by one short, endlessly repeated fragment. */
export function looksDegenerate(text) {
    const value = String(text ?? '').trim();
    if (!value) return true;
    const check = (sample) => {
        const match = sample.match(DEGENERATE_MATCH_RE);
        return Boolean(match) && (match[0].length / sample.length) >= DEGENERATE_MIN_SHARE;
    };
    // Head and tail are checked separately: a corrupted stream can start clean and
    // derail midway, and short legitimate repetitions (markdown rules, dotted
    // leaders) never dominate a whole sample.
    return check(value.length > DEGENERATE_WINDOW ? value.slice(0, DEGENERATE_WINDOW) : value)
        || check(value.length > DEGENERATE_WINDOW ? value.slice(-DEGENERATE_WINDOW) : value);
}

/** Why a finished call's result is unusable, or null when it looks fine. */
function resultDegenerateReason(result) {
    if (!result) return 'no result';
    if (looksDegenerate(result.content)) return 'empty or degenerate output';
    // The active-connection path has no reasoning channel — only judge it when present.
    if (result.reasoning && looksDegenerate(result.reasoning)) return 'degenerate reasoning';
    return null;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * generateVia with retries. A call is re-attempted when it throws, returns empty or
 * degenerate output, or fails the optional `validate(result)` check (e.g. JSON
 * parseability for profile runs). The delay grows linearly with the attempt number.
 * Once attempts are exhausted the last error is rethrown, or an unusable final
 * result raises a descriptive error.
 */
export async function generateWithRetry(options = {}) {
    const settings = getSettings();
    const attempts = 1 + clampInt(settings.genRetries, 0, 5, 2);
    const baseDelay = clampInt(settings.genRetryDelayMs, 0, 30000, 500);
    for (let attempt = 1; attempt <= attempts; attempt++) {
        let result;
        try {
            result = await generateVia(options);
        } catch (error) {
            warn(`internal generation attempt ${attempt}/${attempts} failed`, error);
            if (attempt === attempts) throw error;
            activityEntry({ title: `Attempt ${attempt}/${attempts} failed — retrying`, text: String(error?.message ?? error), tone: 'info' });
            await sleep(baseDelay * attempt);
            continue;
        }
        const reason = resultDegenerateReason(result)
            ?? (typeof options.validate === 'function' && !options.validate(result) ? 'failed the result check' : null);
        if (!reason) return result;
        warn(`internal generation attempt ${attempt}/${attempts} was unusable (${reason})`);
        if (attempt === attempts) throw new Error(`Unusable model output after ${attempts} attempt(s) — ${reason}`);
        activityEntry({ title: `Attempt ${attempt}/${attempts} unusable — retrying (${reason})`, tone: 'info' });
        await sleep(baseDelay * attempt);
    }
}
