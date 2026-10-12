// SmartTavern — generation adapter: per-call connection profiles (via the built-in
// Connection Manager) with fallback to the active connection, plus a reentrancy guard
// so our internal LLM calls never trigger the pipeline itself.
import { getContext } from '../../../../extensions.js';
import { warn } from './state.js';

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
                return await generateViaService(service, profile, { systemPrompt, prompt, maxTokens, jsonSchema });
            } catch (error) {
                warn('Profiled request via Connection Manager failed; falling back to the active connection.', error);
            }
        } else {
            warnNoConnectionManager();
        }
    }

    return generateViaActive(context, { systemPrompt, prompt, maxTokens, jsonSchema, profileId });
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

async function generateViaActive(context, { systemPrompt, prompt, maxTokens, jsonSchema, profileId }) {
    if (typeof context.generateRaw !== 'function') {
        throw new Error('SillyTavern context does not expose generateRaw()');
    }
    const text = await context.generateRaw({
        systemPrompt,
        prompt: typeof prompt === 'string' ? prompt : flattenMessages(prompt),
        responseLength: maxTokens > 0 ? maxTokens : null,
        jsonSchema: jsonSchema ? { ...jsonSchema, returnInvalid: true } : null,
        // Forward-compat: per-call connection profile override (ST proposal). Ignored if unsupported.
        connectionProfile: profileId || undefined,
    });
    // With a schema, generateRaw returns an extracted JSON string; without, the cleaned message.
    return { content: String(text ?? ''), reasoning: '' };
}
