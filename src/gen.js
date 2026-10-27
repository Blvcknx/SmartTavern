// SmartTavern — generation adapter: per-call connection profiles (via the built-in
// Connection Manager) with fallback to the active connection, plus a reentrancy guard
// so our internal LLM calls never trigger the pipeline itself.
import { getContext } from '../../../../extensions.js';
import { getSettings, clampInt, warn } from './state.js';
import { activityEntry } from './progress.js';

let internalDepth = 0;
const internalEvents = new WeakSet();
// generateRaw emits the same prompt hooks as a foreground reply. Identify its
// event by a temporary marker, strip it before dispatch, and retain event identity
// for later hooks without globally classifying other requests as internal.
const rawMarkers = new Set();
let rawSequence = 0;

export function isInternalGeneration(event = null) {
    if (event && typeof event === 'object') {
        if (internalEvents.has(event)) return true;
        const clean = text => {
            if (typeof text !== 'string') return text;
            for (const marker of rawMarkers) {
                if (!text.includes(marker)) continue;
                internalEvents.add(event);
                text = text.split(marker).join('');
            }
            return text;
        };
        if (typeof event.prompt === 'string') event.prompt = clean(event.prompt);
        for (const message of event.chat ?? []) {
            if (typeof message.content === 'string') message.content = clean(message.content);
            else if (Array.isArray(message.content)) {
                for (const part of message.content) if (part && typeof part.text === 'string') part.text = clean(part.text);
            }
        }
        if (internalEvents.has(event)) return true;
    }
    return internalDepth > 0;
}

// Only guard synchronous entry. Keeping this set across an await also suppresses
// unrelated foreground generations while a background profile request is pending.
export function withInternalGeneration(fn) {
    internalDepth++;
    try {
        return fn();
    } finally {
        internalDepth--;
    }
}

// Interceptor scope: marks calls made while the foreground generation is parked on
// SmartTavern's own generate_interceptor. Their shared token-budget mutation
// (generateRaw's TempResponseLength) cannot collide with a concurrently assembling
// foreground request — the foreground is blocked on us — so they skip the
// foreground-idle wait below.
let interceptorDepth = 0;

export async function withInterceptorScope(fn) {
    interceptorDepth++;
    try {
        return await fn();
    } finally {
        interceptorDepth--;
    }
}

// Active-connection calls borrow generateRaw, which temporarily rewrites shared
// token-budget state (TempResponseLength saves/restores oai_settings.openai_max_tokens
// or amount_gen around the request). A foreground generation that starts assembling
// its own request while that override is live could ship it inside the user's payload
// (or make our call capture their token limit). Calls made outside the interceptor
// therefore wait for the foreground generation to finish before dispatching. A tiny
// residual window remains — the override lives only milliseconds — but the practical
// overlaps (auto-continue firing mid-refinement, panel commands during generation)
// are serialized away.
let foregroundBusy = false;
let foregroundTrackerReady = false;
const FOREGROUND_WAIT_MS = 250;
const FOREGROUND_WAIT_CAP_MS = 60 * 1000;

function initForegroundTracker() {
    if (foregroundTrackerReady) return;
    foregroundTrackerReady = true;
    const context = getContext();
    const eventSource = context.eventSource;
    if (!eventSource) return;
    const events = context.event_types ?? context.eventTypes ?? {};
    if (events.GENERATION_STARTED) {
        eventSource.on(events.GENERATION_STARTED, () => { foregroundBusy = true; });
    }
    for (const type of [events.GENERATION_ENDED, events.GENERATION_STOPPED, events.CHAT_CHANGED].filter(Boolean)) {
        eventSource.on(type, () => { foregroundBusy = false; });
    }
}

/** Resolves once no foreground generation is running (or the safety cap is hit). */
async function waitForegroundIdle(signal) {
    initForegroundTracker();
    if (!foregroundBusy || interceptorDepth > 0) return;
    const deadline = Date.now() + FOREGROUND_WAIT_CAP_MS;
    while (foregroundBusy && interceptorDepth === 0 && Date.now() < deadline) {
        await sleep(FOREGROUND_WAIT_MS, signal);
    }
}

export function isAbortError(error) {
    return error?.name === 'AbortError' || (error?.cause && isAbortError(error.cause));
}

function abortReason(signal) {
    return signal?.reason ?? new DOMException('Generation cancelled', 'AbortError');
}

export function throwIfAborted(signal) {
    if (signal?.aborted) throw abortReason(signal);
}

// Some older active-connection APIs cannot abort their transport. Release the
// caller immediately but keep the physical request in activeQueue until it settles.
function abortable(promise, signal) {
    if (!signal) return promise;
    return new Promise((resolve, reject) => {
        const abort = () => reject(abortReason(signal));
        signal.addEventListener('abort', abort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
        if (signal.aborted) abort();
    });
}

/** One cancellation scope shared by a run, its queued calls and retry delays. */
export function createGenerationControl() {
    const controller = new AbortController();
    const context = getContext();
    const events = context.event_types ?? context.eventTypes ?? {};
    const types = [events.GENERATION_STOPPED, events.CHAT_CHANGED].filter(Boolean);
    const cancel = () => controller.abort(new DOMException('Generation cancelled', 'AbortError'));
    for (const type of types) context.eventSource?.on(type, cancel);
    return {
        signal: controller.signal, cancel,
        dispose() { for (const type of types) context.eventSource?.removeListener(type, cancel); },
    };
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
 * @param {AbortSignal|null} [options.signal] Cancels queued calls, retries and supported transports
 * @param {boolean} [options.checkOutput=true] Disable generic sanity filters when the caller reviews output itself
 * @returns {Promise<{content: string, reasoning: string}>}
 */
export async function generateVia({ profileId = '', systemPrompt = '', prompt = '', maxTokens = 512, jsonSchema = null, signal = null, checkOutput = true } = {}) {
    throwIfAborted(signal);
    const context = getContext();
    const profile = profileId ? getConnectionProfile(profileId) : null;

    if (profileId && !profile) {
        warn(`Connection profile "${profileId}" not found; falling back to the active connection.`);
    }

    if (profile) {
        const service = getServiceFromContext() ?? await loadServiceFallback();
        if (service && typeof service.sendRequest === 'function') {
            try {
                const result = await abortable(generateViaService(service, profile, { systemPrompt, prompt, maxTokens, jsonSchema, signal }), signal);
                // A technically successful request can still return garbage (sampling
                // collapse, reasoning corruption). Treat that like a failure so the
                // active connection gets a chance before any retry logic kicks in.
                const degenerate = checkOutput ? resultDegenerateReason(result) : null;
                if (!degenerate) return result;
                warn(`Profiled request returned ${degenerate}; falling back to the active connection.`);
            } catch (error) {
                if (signal?.aborted || isAbortError(error)) throw error;
                warn('Profiled request via Connection Manager failed; falling back to the active connection.', error);
            }
        } else {
            warnNoConnectionManager();
        }
    }

    const request = activeQueue.then(async () => {
        throwIfAborted(signal);
        await waitForegroundIdle(signal);
        return generateViaActive(context, { systemPrompt, prompt, maxTokens, jsonSchema });
    });
    activeQueue = request.catch(() => {});
    return abortable(request, signal);
}

async function generateViaService(service, profile, { systemPrompt, prompt, maxTokens, jsonSchema, signal }) {
    throwIfAborted(signal);
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

    let result = await service.sendRequest(profile.id, payloadPrompt, maxTokens, {
        stream: false,
        signal,
        extractData: true,
        includePreset: true,
        includeInstruct: true,
    }, overridePayload);

    // If the service returns a stream factory despite the non-streaming request,
    // awaiting sendRequest only waits for the headers. Consume its cumulative
    // snapshots through completion
    // before running any output checks (including on a manually retried pass).
    if (typeof result === 'function') result = result();
    if (result && typeof result[Symbol.asyncIterator] === 'function') {
        let content = '';
        let reasoning = '';
        for await (const chunk of result) {
            throwIfAborted(signal);
            content = String(chunk?.text ?? chunk?.content ?? content);
            reasoning = String(chunk?.state?.reasoning ?? chunk?.reasoning ?? reasoning);
        }
        result = { content, reasoning };
    }
    throwIfAborted(signal);
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
    const marker = `[SMARTTAVERN-INTERNAL-${Date.now()}-${++rawSequence}]`;
    rawMarkers.add(marker);
    let text;
    try {
        text = await withInternalGeneration(() => context.generateRaw({
            systemPrompt: `${marker}${systemPrompt}`,
            prompt,
            responseLength: maxTokens > 0 ? maxTokens : null,
            jsonSchema: jsonSchema ? { ...jsonSchema, returnInvalid: true } : null,
        }));
    } finally {
        rawMarkers.delete(marker);
    }
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

function sleep(ms, signal) {
    return new Promise((resolve, reject) => {
        throwIfAborted(signal);
        const finish = () => { signal?.removeEventListener('abort', abort); resolve(); };
        const timer = setTimeout(finish, ms);
        const abort = () => { clearTimeout(timer); reject(abortReason(signal)); };
        signal?.addEventListener('abort', abort, { once: true });
    });
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
        throwIfAborted(options.signal);
        let result;
        try {
            result = await generateVia(options);
        } catch (error) {
            if (options.signal?.aborted || isAbortError(error)) throw error;
            warn(`internal generation attempt ${attempt}/${attempts} failed`, error);
            if (attempt === attempts) throw error;
            activityEntry({ title: `Attempt ${attempt}/${attempts} failed — retrying`, text: String(error?.message ?? error), tone: 'info' });
            await sleep(baseDelay * attempt, options.signal);
            continue;
        }
        const reason = (options.checkOutput === false ? null : resultDegenerateReason(result))
            ?? (typeof options.validate === 'function' && !options.validate(result) ? 'failed the result check' : null);
        if (!reason) return result;
        warn(`internal generation attempt ${attempt}/${attempts} was unusable (${reason})`);
        if (attempt === attempts) throw new Error(`Unusable model output after ${attempts} attempt(s) — ${reason}`);
        activityEntry({ title: `Attempt ${attempt}/${attempts} unusable — retrying (${reason})`, tone: 'info' });
        await sleep(baseDelay * attempt, options.signal);
    }
}
