// Run: node --test tests/native-core.test.js
// Native function calling, pure half: source support, schemas, raw response shapes per source.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
    toolSupport, forcedToolChoice, sanitizeSchema, toOpenAiTools, definitionProblems, normalizeToolResponse,
    parseCallArguments, assistantToolMessage, toolResultMessage, TOOL_CALLING_SOURCES,
} from '../src/native-core.js';
import { SUBMIT_BRIEF_DEFINITION, gmOutputFromSubmit } from '../src/gm-core.js';

const ids = () => { let n = 0; return () => `gen_${++n}`; };

test('toolSupport mirrors ST: chat-completion profiles on tool-capable sources only', () => {
    assert.equal(toolSupport({ mode: 'cc' }, 'openai').supported, true);
    for (const source of ['claude', 'makersuite', 'vertexai', 'cohere', 'openrouter', 'custom', 'deepseek']) assert.equal(toolSupport({ mode: 'cc' }, source).supported, true, source);
    assert.equal(toolSupport({ mode: 'cc' }, 'perplexity').supported, false);
    assert.equal(toolSupport({ mode: 'cc' }, '').supported, false);
    assert.match(toolSupport({ mode: 'tc' }, 'openai').reason, /not a Chat Completion/);
    assert.match(toolSupport(null, 'openai').reason, /no connection profile/);
    assert.equal(toolSupport({ mode: 'cc', model: 'gpt-6-astra-x' }, 'openai').supported, false);
    assert.equal(toolSupport({ mode: 'cc', model: 'gpt-6-astra-x' }, 'claude').supported, true);
    for (const mode of ['', 'merge_tools', 'semi_tools', 'strict_tools']) assert.equal(toolSupport({ mode: 'cc', 'prompt-post-processing': mode }, 'openai').supported, true, mode);
    for (const mode of ['merge', 'semi', 'strict', 'single', 'claude']) assert.equal(toolSupport({ mode: 'cc', 'prompt-post-processing': mode }, 'openai').supported, false, mode);
    assert.ok(TOOL_CALLING_SOURCES.includes('openai'));
});

test('forcedToolChoice: Claude takes "any" (ST wraps it as {type}), the rest "required"', () => {
    assert.equal(forcedToolChoice('claude'), 'any');
    assert.equal(forcedToolChoice('openai'), 'required');
    assert.equal(forcedToolChoice('makersuite'), 'required');
    assert.equal(forcedToolChoice('perplexity'), null);
});

test('sanitizeSchema produces provider-safe JSON Schema', () => {
    const schema = sanitizeSchema({
        $schema: 'x', additionalProperties: false, required: ['a', 'ghost'],
        properties: {
            a: { type: 'string', default: 'z', minLength: 2 },
            mode: { enum: ['advantage', 'disadvantage'] },
            n: { enum: [1, 2] },
            list: { type: 'array', items: 'string', minItems: 1, maxItems: 3 },
            bare: { type: 'array' },
            nested: { properties: { x: { type: 'number' } }, required: ['x', 'y'] },
        },
    });
    assert.equal(schema.type, 'object');
    assert.equal(schema.$schema, undefined);
    assert.equal(schema.additionalProperties, undefined);
    assert.deepEqual(schema.required, ['a']);
    assert.equal(schema.properties.a.default, undefined);
    assert.equal(schema.properties.a.minLength, 2);
    assert.equal(schema.properties.mode.type, 'string');
    assert.equal(schema.properties.n.type, 'number');
    assert.deepEqual(schema.properties.list.items, { type: 'string' });
    assert.equal(schema.properties.list.maxItems, 3);
    assert.deepEqual(schema.properties.bare.items, { type: 'string' });
    assert.equal(schema.properties.nested.type, 'object');
    assert.deepEqual(schema.properties.nested.required, ['x']);
    assert.deepEqual(sanitizeSchema(undefined), { type: 'object', properties: {} });
});

test('toOpenAiTools emits function tools; submit_brief is a valid definition', () => {
    const tools = toOpenAiTools([SUBMIT_BRIEF_DEFINITION]);
    assert.equal(tools[0].type, 'function');
    assert.equal(tools[0].function.name, 'submit_brief');
    assert.deepEqual(tools[0].function.parameters.required, ['brief']);
    assert.equal(tools[0].function.parameters.properties.branches.items.properties.if.type, 'string');
    assert.equal(tools[0].function.parameters.properties.musts.maxItems, 3);
    assert.deepEqual(definitionProblems({ name: 'submit_brief', description: SUBMIT_BRIEF_DEFINITION.description, inputSchema: tools[0].function.parameters }), []);
    assert.ok(definitionProblems({ name: 'bad name', description: '', inputSchema: { type: 'object', properties: { a: { description: 'no type' } }, required: ['b'] } }).length >= 4);
    assert.ok(definitionProblems({ name: 'f', description: 'd', inputSchema: { type: 'object', properties: { a: { type: 'string', check() {} } } } }).some(text => /functions/.test(text)));
});

test('parseCallArguments accepts JSON text or objects and reports bad input', () => {
    assert.deepEqual(parseCallArguments('{"a":1}'), { args: { a: 1 }, parseError: '' });
    assert.deepEqual(parseCallArguments({ a: 1 }), { args: { a: 1 }, parseError: '' });
    assert.deepEqual(parseCallArguments(''), { args: {}, parseError: '' });
    assert.match(parseCallArguments('{oops').parseError, /not valid JSON/);
    assert.match(parseCallArguments('[1]').parseError, /JSON object/);
    assert.match(parseCallArguments('3').parseError, /JSON object/);
});

test('OpenAI-style responses: content, tool_calls, reasoning_content, bad arguments, missing ids', () => {
    const out = normalizeToolResponse({ choices: [{ index: 0, message: {
        content: 'Thinking aloud.', reasoning_content: 'Because.',
        tool_calls: [
            { id: 'call_a', type: 'function', function: { name: 'roll_dice', arguments: '{"reason":"x"}' } },
            { type: 'function', function: { name: 'clock', arguments: '{broken' } },
            { id: 'call_c', function: { name: 'npc_intent', arguments: { name: 'Voss' } } },
        ],
    } }] }, { makeId: ids() });
    assert.equal(out.content, 'Thinking aloud.');
    assert.equal(out.reasoning, 'Because.');
    assert.deepEqual(out.toolCalls.map(call => call.id), ['call_a', 'gen_1', 'call_c']);
    assert.deepEqual(out.toolCalls[0].args, { reason: 'x' });
    assert.equal(out.toolCalls[1].parseError, 'tool arguments were not valid JSON');
    assert.deepEqual(out.toolCalls[2].args, { name: 'Voss' });
    // Content parts, reasoning string field and OpenRouter encrypted signatures.
    const router = normalizeToolResponse({ choices: [{ index: 0, message: {
        content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], reasoning: 'r',
        tool_calls: [{ id: 't1', function: { name: 'x', arguments: '{}' } }],
        reasoning_details: [{ id: 't1', type: 'reasoning.encrypted', data: 'SIG' }],
    } }] });
    assert.equal(router.content, 'a\n\nb');
    assert.equal(router.reasoning, 'r');
    assert.equal(router.toolCalls[0].signature, 'SIG');
    assert.deepEqual(normalizeToolResponse({ choices: [{ index: 0, message: { content: 'only text' } }] }).toolCalls, []);
});

test('Claude responses: text, thinking and tool_use blocks', () => {
    const out = normalizeToolResponse({ id: 'msg', content: [
        { type: 'thinking', thinking: 'hm' }, { type: 'text', text: 'Calling.' },
        { type: 'tool_use', id: 'toolu_1', name: 'consult_expert', input: { question: 'q' } },
        { type: 'tool_use', id: 'toolu_2', name: 'clock', input: { action: 'create', name: 'n' } },
    ] });
    assert.equal(out.content, 'Calling.');
    assert.equal(out.reasoning, 'hm');
    assert.deepEqual(out.toolCalls.map(call => [call.id, call.name]), [['toolu_1', 'consult_expert'], ['toolu_2', 'clock']]);
    assert.deepEqual(out.toolCalls[1].args, { action: 'create', name: 'n' });
});

test('Gemini responses: calls and thoughts only exist in responseContent.parts', () => {
    const out = normalizeToolResponse({
        choices: [{ message: { content: 'visible' } }],
        responseContent: { parts: [
            { text: 'private thought', thought: true }, { text: 'visible' },
            { functionCall: { name: 'roll_dice', args: { reason: 'r' } }, thoughtSignature: 'TS' },
            { functionCall: { name: 'submit_brief', args: { brief: 'b' } } },
        ] },
    }, { makeId: ids() });
    assert.equal(out.content, 'visible');
    assert.equal(out.reasoning, 'private thought');
    assert.deepEqual(out.toolCalls.map(call => [call.id, call.name, call.signature]), [['gen_1', 'roll_dice', 'TS'], ['gen_2', 'submit_brief', undefined]]);
    assert.deepEqual(out.toolCalls[0].args, { reason: 'r' });
});

test('Cohere v2 responses: message.tool_calls and tool_plan', () => {
    const out = normalizeToolResponse({ message: { role: 'assistant', tool_plan: 'I will roll.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'roll_dice', arguments: '{"reason":"r"}' } }] } });
    assert.equal(out.content, 'I will roll.');
    assert.equal(out.toolCalls[0].name, 'roll_dice');
    const text = normalizeToolResponse({ message: { content: [{ type: 'text', text: 'hello' }] } });
    assert.equal(text.content, 'hello');
});

test('degenerate bodies never throw', () => {
    for (const raw of [null, undefined, 5, {}, [], { choices: [] }, { choices: [{}] }, 'plain text']) {
        const out = normalizeToolResponse(raw);
        assert.deepEqual(out.toolCalls, []);
        assert.equal(typeof out.content, 'string');
    }
    assert.equal(normalizeToolResponse('plain text').content, 'plain text');
    assert.equal(normalizeToolResponse({ choices: [{ text: 'legacy' }] }).content, 'legacy');
});

test('messages for the next request: assistant tool_calls and role:tool results', () => {
    const calls = [{ id: 'a', name: 'roll_dice', args: { reason: 'x' }, parseError: '', signature: 'S' }, { id: 'b', name: 'clock', args: { z: 1 }, parseError: 'tool arguments were not valid JSON' }];
    const message = assistantToolMessage('hm', calls);
    assert.equal(message.role, 'assistant');
    assert.equal(message.content, 'hm');
    assert.deepEqual(message.tool_calls[0], { id: 'a', type: 'function', function: { name: 'roll_dice', arguments: '{"reason":"x"}' }, signature: 'S' });
    assert.equal(message.tool_calls[1].function.arguments, '{}'); // a broken call is replayed as valid JSON
    assert.deepEqual(toolResultMessage(calls[0], 'ok'), { role: 'tool', tool_call_id: 'a', content: 'ok' });
});

test('gmOutputFromSubmit applies the tag grammar limits and refusal rule', () => {
    const out = gmOutputFromSubmit({
        brief: ` ${'word '.repeat(200)}`, musts: ['One', 'one', 'Two', 'Three', 'Four'],
        branches: [{ if: 'a', then: 'b' }, { if: '', then: 'x' }, ...Array.from({ length: 8 }, (_, i) => ({ if: `c${i}`, then: `d${i}` }))],
        fields: ['Mood', 'mood', 'none'], skips: ['Tactics', ''],
    });
    assert.equal(out.valid, true);
    assert.ok(out.brief.split(/\s+/).length <= 121);
    assert.deepEqual(out.musts, ['One', 'Two', 'Three']);
    assert.equal(out.branches.length, 4);
    assert.deepEqual(out.fields, ['Mood']);
    assert.deepEqual(out.skips, ['Tactics']);
    assert.deepEqual(out.tools, []);
    assert.equal(gmOutputFromSubmit({ brief: 'x' }).fields, null); // absent = leave field choice to the rules
    assert.deepEqual(gmOutputFromSubmit({ brief: 'x', fields: [] }).fields, []);
    assert.equal(gmOutputFromSubmit({}).valid, false);
    assert.equal(gmOutputFromSubmit({ musts: ['A bell tolls'] }).valid, true);
    assert.equal(gmOutputFromSubmit('nonsense').valid, false);
    const refused = gmOutputFromSubmit({ brief: "I'm sorry, but I can't help with that request." });
    assert.equal(refused.valid, false);
    assert.equal(refused.refused, true);
});
