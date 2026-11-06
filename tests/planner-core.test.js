import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseExpansionPlan, configuredBlocks, recentMessages, fitHistory } from '../src/planner-core.js';

test('plain user headings share expansion validation, dependencies, and block budget', () => {
    const result = parseExpansionPlan(`## User: Destination
Where do you want to travel?
## Expansion: Route
Use {{step:Destination}} to assess the route.
## User: destination
Duplicate question.
## User: Empty
## Expansion: Weather
Assess the weather.`);
    assert.deepEqual(result.additions, [
        { name: 'Destination', prompt: 'Where do you want to travel?', kind: 'user' },
        { name: 'Route', prompt: 'Use {{step:Destination}} to assess the route.' },
        { name: 'Weather', prompt: 'Assess the weather.' },
    ]);
    assert.equal(result.issues.length, 2);
    assert.equal(parseExpansionPlan('## User: Choice\nWhich way?', Array(5).fill({ name: 'Saved' })).additions.length, 0);
});

test('planner text contract accepts headings and fences without JSON', () => {
    const result = parseExpansionPlan('```markdown\nSome preamble.\n  ##   Expansion : Weather  \nDescribe the weather.\n\n## Expansion: Travel\nUse {{step:Weather}} to assess travel.\n```');
    assert.deepEqual(result.additions, [
        { name: 'Weather', prompt: 'Describe the weather.' },
        { name: 'Travel', prompt: 'Use {{step:Weather}} to assess travel.' },
    ]);
    assert.deepEqual(result.issues, []);
    assert.deepEqual(parseExpansionPlan('<think>Ignore this</think>\nNO ADDITIONS'), { additions: [], issues: [] });
});

test('planner rejects duplicate, empty, unknown, and forward-dependent blocks, preserving valid ones', () => {
    const result = parseExpansionPlan(`## Expansion: Existing
Duplicate
## Expansion: Empty
## Expansion: Future
Use {{step:Later}}.
## Expansion: Unknown
Use {{step:Missing}}.
## Expansion: Later
Useful context
## Expansion: later
Duplicate case
## Expansion: Valid
Use {{step:Existing}} and {{step:Later}}.`, [{ name: 'Existing' }]);
    assert.deepEqual(result.additions.map(block => block.name), ['Later', 'Valid']);
    assert.equal(result.issues.length, 5);
    assert.equal(parseExpansionPlan('Just some commentary').additions.length, 0);
    assert.equal(parseExpansionPlan('Just some commentary').issues.length, 1);
});

test('planner counts configured usable blocks and never fills beyond five total', () => {
    const steps = configuredBlocks([{ name: 'A', prompt: 'a' }, { prompt: '', enabled: true }, { prompt: 'x', enabled: false }]);
    assert.equal(steps.length, 1);
    const response = Array.from({ length: 8 }, (_, index) => `## Expansion: Block ${index}\nPrompt ${index}`).join('\n');
    assert.equal(parseExpansionPlan(response, steps).additions.length, 4);
    assert.equal(parseExpansionPlan(response, Array(5).fill({ name: 'A' })).additions.length, 0);
});

test('history selects 24 visible messages, excluding hidden/system/injected context', () => {
    const chat = Array.from({ length: 30 }, (_, index) => ({ name: 'Alice', mes: `Message ${index}` }));
    chat.push({ mes: 'hidden', is_hidden: true }, { mes: 'system', is_system: true },
        { mes: 'injection', extra: { isSmartTavern: true } }, { mes: 'ephemeral', smarttavern_ephemeral: true });
    const history = recentMessages(chat);
    assert.equal(history.length, 24);
    assert.equal(history[0], 'Alice: Message 6');
    assert.equal(history.at(-1), 'Alice: Message 29');
});

test('budgeting removes oldest whole messages, then preserves the newest suffix', async () => {
    const count = async text => text.length;
    assert.deepEqual(await fitHistory({ history: ['old', 'newest'], fixed: 'fixed', budget: 14, count }), ['newest']);
    const long = 'old'.repeat(300) + 'NEWEST';
    const fitted = await fitHistory({ history: [long], fixed: 'fixed', budget: 200, count });
    assert.ok(fitted[0].endsWith('NEWEST'));
    assert.ok(fitted[0].length < 200);
    await assert.rejects(fitHistory({ history: ['x'], fixed: 'fixed', budget: 3, count }), /instructions and block definitions/);
});
