// SmartTavern — native function calling, pure half. NO SillyTavern imports.
//
// Mirrors what SillyTavern's own ToolManager (public/scripts/tool-calling.js) and its
// chat-completions backend know about tool calling, for the one place SmartTavern uses it:
// the GM tick sending OpenAI-format `tools` through a Connection Manager profile.
//
//   * which chat-completion sources accept `tools`           (toolSupport)
//   * OpenAI function definitions from registry schemas      (toOpenAiTools, sanitizeSchema)
//   * which `tool_choice` forces a call, per source          (forcedToolChoice)
//   * the raw response shapes the ST backend returns         (normalizeToolResponse)
//   * OpenAI-format messages for the next round of the loop  (assistantToolMessage, toolResultMessage)
//
// ST's backend returns, with `extractData:false`:
//   - OpenAI-compatible sources: { choices: [{ message: { content, tool_calls, reasoning_content } }] }
//   - Claude: the native body { content: [{ type: 'text' | 'thinking' | 'tool_use', … }] }
//   - Gemini (makersuite / vertexai): { choices: [{ message: { content } }], responseContent: { parts } }
//     where function calls and thought parts exist ONLY in responseContent.parts
//   - Cohere v2: { message: { content: [{ type: 'text', text }], tool_calls, tool_plan } }

/** Same list as ToolManager.isToolCallingSupported (minus per-model capability flags, which
 *  the extension cannot see; a model that rejects tools is handled by the tags fallback). */
export const TOOL_CALLING_SOURCES = Object.freeze([
    'openai', 'custom', 'mistralai', 'claude', 'openrouter', 'aimlapi', 'groq', 'cohere', 'deepseek',
    'makersuite', 'vertexai', 'ai21', 'xai', 'pollinations', 'moonshot', 'fireworks', 'cometapi', 'chutes',
    'electronhub', 'azure_openai', 'zai', 'siliconflow', 'nanogpt', 'workers_ai', 'minimax',
]);

// Prompt post-processing modes that keep past tool calls in the prompt (ST drops them otherwise).
const TOOL_SAFE_POST_PROCESSING = ['', 'merge_tools', 'semi_tools', 'strict_tools'];

/**
 * Can a Connection Manager profile do native tool calling?
 * @param {{mode?: string, model?: string, 'prompt-post-processing'?: string}|null} profile
 * @param {string} source chat-completion source of the profile's API (CONNECT_API_MAP[api].source)
 * @returns {{supported: boolean, reason: string}}
 */
export function toolSupport(profile, source) {
    if (!profile) return { supported: false, reason: 'no connection profile (the active connection is not used for native tools)' };
    if ((profile.mode ?? 'cc') !== 'cc') return { supported: false, reason: 'the profile is not a Chat Completion profile' };
    if (!TOOL_CALLING_SOURCES.includes(source)) return { supported: false, reason: `the "${source || 'unknown'}" source has no tool calling` };
    if (['openai', 'azure_openai'].includes(source) && /^gpt-6-astra/.test(String(profile.model ?? ''))) {
        return { supported: false, reason: 'this model supports tool calling only through the Responses API' };
    }
    if (!TOOL_SAFE_POST_PROCESSING.includes(String(profile['prompt-post-processing'] ?? ''))) {
        return { supported: false, reason: 'the profile\'s prompt post-processing removes tool calls from the prompt' };
    }
    return { supported: true, reason: '' };
}

/**
 * `tool_choice` that makes the model call a tool. Callers offer only the tool they want
 * called in that request, so "any tool" equals "that tool". ST's Claude path wraps the
 * string as { type } (so 'any'), every other path takes the OpenAI value.
 */
export function forcedToolChoice(source) {
    if (!TOOL_CALLING_SOURCES.includes(source)) return null;
    return source === 'claude' ? 'any' : 'required';
}

// --------------------------------------------------------------------------------------------
// Schemas
// --------------------------------------------------------------------------------------------

// Keywords some providers reject (Gemini) and that carry no meaning for the model.
const DROP_KEYS = new Set(['$schema', 'additionalProperties', 'default', 'exclusiveMinimum', 'exclusiveMaximum', 'propertyNames', 'examples']);

const inferType = rule => {
    const sample = Array.isArray(rule.enum) ? rule.enum[0] : undefined;
    if (typeof sample === 'number') return 'number';
    if (typeof sample === 'boolean') return 'boolean';
    return 'string';
};

function cleanRule(rule) {
    if (typeof rule === 'string') return { type: rule }; // registry shorthand: items: 'string'
    if (Array.isArray(rule)) return rule.map(cleanRule);
    if (rule === null || typeof rule !== 'object') return rule;
    const out = {};
    for (const [key, value] of Object.entries(rule)) {
        if (DROP_KEYS.has(key)) continue;
        if (key === 'properties' && value && typeof value === 'object') {
            out.properties = Object.fromEntries(Object.entries(value).map(([name, item]) => [name, cleanRule(item)]));
        } else if (key === 'items') {
            out.items = cleanRule(value);
        } else if (['anyOf', 'oneOf', 'allOf'].includes(key) && Array.isArray(value)) {
            out[key] = value.map(cleanRule);
        } else {
            out[key] = value;
        }
    }
    if (out.type === undefined && !out.anyOf && !out.oneOf && !out.allOf && !out.$ref) {
        if (Array.isArray(out.enum)) out.type = inferType(out);
        else if (out.properties) out.type = 'object';
        else if (out.items) out.type = 'array';
    }
    if (out.type === 'array' && out.items === undefined) out.items = { type: 'string' };
    if (out.type === 'object' && out.properties && Array.isArray(out.required)) {
        out.required = out.required.filter(name => Object.hasOwn(out.properties, name));
        if (!out.required.length) delete out.required;
    }
    return out;
}

/** A provider-safe JSON Schema for a tool's arguments: always `{type:'object', properties}`. */
export function sanitizeSchema(schema) {
    const cleaned = cleanRule(schema && typeof schema === 'object' ? schema : {});
    return { ...cleaned, type: 'object', properties: cleaned.properties ?? {} };
}

/** OpenAI `tools` array from [{name, description, inputSchema}]. */
export function toOpenAiTools(definitions) {
    return (Array.isArray(definitions) ? definitions : []).map(tool => ({
        type: 'function',
        function: { name: tool.name, description: String(tool.description ?? '').slice(0, 1024), parameters: sanitizeSchema(tool.inputSchema) },
    }));
}

/**
 * Structural check used by tests (and as a guard before sending): a definition is usable
 * when its name is provider-legal and its schema is a plain, function-free JSON object.
 * @returns {string[]} problems; empty when valid
 */
export function definitionProblems(definition) {
    const problems = [];
    const name = definition?.name;
    if (typeof name !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(name)) problems.push(`bad tool name "${name}"`);
    if (typeof definition?.description !== 'string' || !definition.description.trim()) problems.push(`${name}: description is missing`);
    const walk = (rule, where) => {
        if (typeof rule === 'function') { problems.push(`${where}: functions are not JSON`); return; }
        if (rule === null || typeof rule !== 'object') return;
        if (Array.isArray(rule)) { rule.forEach((item, index) => walk(item, `${where}[${index}]`)); return; }
        for (const [key, value] of Object.entries(rule)) {
            if (key === 'properties') {
                for (const [prop, item] of Object.entries(value ?? {})) {
                    if (item === null || typeof item !== 'object' || Array.isArray(item)) problems.push(`${where}.${prop}: must be a schema object`);
                    else if (item.type === undefined && !item.anyOf && !item.oneOf && !item.allOf && !item.$ref) problems.push(`${where}.${prop}: has no type`);
                    walk(item, `${where}.${prop}`);
                }
            } else {
                walk(value, `${where}.${key}`);
            }
        }
    };
    const schema = definition?.parameters ?? definition?.inputSchema;
    if (schema?.type !== 'object') problems.push(`${name}: schema type must be "object"`);
    if (schema === null || typeof schema?.properties !== 'object') problems.push(`${name}: schema needs "properties"`);
    for (const required of schema?.required ?? []) if (!Object.hasOwn(schema.properties ?? {}, required)) problems.push(`${name}: required "${required}" is not a property`);
    walk(schema, name);
    return problems;
}

// --------------------------------------------------------------------------------------------
// Responses
// --------------------------------------------------------------------------------------------

const randomId = () => `call_${Math.random().toString(36).slice(2, 12)}`;

/** Turns the arguments of a tool call (string or object) into {args, parseError}. */
export function parseCallArguments(raw) {
    if (raw === undefined || raw === null || raw === '') return { args: {}, parseError: '' };
    let value = raw;
    if (typeof raw === 'string') {
        try {
            value = JSON.parse(raw);
        } catch {
            return { args: {}, parseError: 'tool arguments were not valid JSON' };
        }
    }
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return { args: {}, parseError: 'tool arguments must be a JSON object' };
    return { args: value, parseError: '' };
}

const textOf = content => {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter(part => part && (part.type === 'text' || part.type === undefined) && typeof part.text === 'string').map(part => part.text).join('\n\n');
    return '';
};

function makeCall(id, name, rawArguments, makeId, extra = {}) {
    const { args, parseError } = parseCallArguments(rawArguments);
    return { id: typeof id === 'string' && id ? id : makeId(), name: String(name ?? ''), args, parseError, ...extra };
}

/**
 * Normalizes a raw (extractData:false) chat-completion response.
 * @returns {{content: string, reasoning: string, toolCalls: {id: string, name: string, args: object, parseError: string, signature?: string}[]}}
 */
export function normalizeToolResponse(raw, { makeId = randomId } = {}) {
    const result = { content: '', reasoning: '', toolCalls: [] };
    if (typeof raw === 'string') { result.content = raw; return result; }
    if (raw === null || typeof raw !== 'object') return result;

    // Claude: native content blocks.
    if (Array.isArray(raw.content)) {
        result.content = raw.content.filter(part => part?.type === 'text').map(part => String(part.text ?? '')).join('\n\n');
        result.reasoning = raw.content.filter(part => part?.type === 'thinking').map(part => String(part.thinking ?? '')).join('\n\n');
        for (const part of raw.content) {
            if (part?.type === 'tool_use') result.toolCalls.push(makeCall(part.id, part.name, part.input ?? {}, makeId));
        }
        return result;
    }

    // Gemini: the OpenAI-shaped reply has only the text; calls and thoughts live in the parts.
    const parts = raw.responseContent?.parts;
    if (Array.isArray(parts)) {
        result.content = parts.filter(part => typeof part?.text === 'string' && !part.thought).map(part => part.text).join('\n\n');
        result.reasoning = parts.filter(part => typeof part?.text === 'string' && part.thought).map(part => part.text).join('\n\n');
        for (const part of parts) {
            if (part?.functionCall) {
                result.toolCalls.push(makeCall(null, part.functionCall.name, part.functionCall.args ?? {}, makeId, part.thoughtSignature ? { signature: part.thoughtSignature } : {}));
            }
        }
        if (!result.content && typeof raw.choices?.[0]?.message?.content === 'string') result.content = raw.choices[0].message.content;
        return result;
    }

    // OpenAI-compatible (index 0 like ToolManager, else the first choice).
    const choice = Array.isArray(raw.choices) ? (raw.choices.find(item => item?.index === 0) ?? raw.choices[0]) : null;
    const message = choice?.message ?? raw.message; // `message` alone = Cohere v2
    if (message && typeof message === 'object') {
        result.content = textOf(message.content) || (typeof message.tool_plan === 'string' ? message.tool_plan : '');
        const reasoning = message.reasoning_content ?? (typeof message.reasoning === 'string' ? message.reasoning : '');
        result.reasoning = typeof reasoning === 'string' ? reasoning : '';
        const calls = Array.isArray(message.tool_calls) ? message.tool_calls : (message.tool_calls && typeof message.tool_calls === 'object' ? [message.tool_calls] : []);
        for (const call of calls) {
            if (!call) continue;
            const detail = Array.isArray(message.reasoning_details) ? message.reasoning_details.find(item => item?.id === call.id && item.type === 'reasoning.encrypted' && item.data) : null;
            const signature = call.signature ?? detail?.data;
            result.toolCalls.push(makeCall(call.id, call.function?.name ?? call.name, call.function?.arguments ?? call.arguments ?? {}, makeId, signature ? { signature } : {}));
        }
    } else if (typeof raw.choices?.[0]?.text === 'string') {
        result.content = raw.choices[0].text;
    } else if (typeof raw.text === 'string') {
        result.content = raw.text;
    }
    return result;
}

// --------------------------------------------------------------------------------------------
// Messages for the next request (OpenAI format; ST's backend converts per source)
// --------------------------------------------------------------------------------------------

/** The assistant turn that carries `calls`, replayed before their tool results. */
export function assistantToolMessage(content, calls) {
    return {
        role: 'assistant',
        content: String(content ?? ''),
        tool_calls: calls.map(call => ({
            id: call.id, type: 'function',
            function: { name: call.name, arguments: JSON.stringify(call.parseError ? {} : (call.args ?? {})) },
            ...(call.signature ? { signature: call.signature } : {}),
        })),
    };
}

export const toolResultMessage = (call, text) => ({ role: 'tool', tool_call_id: call.id, content: String(text ?? '') });
