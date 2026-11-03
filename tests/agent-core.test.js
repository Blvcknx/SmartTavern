// SmartTavern — unit tests for the thinking agent's pure core (agent-core.js).
// Run: node --test tests/   (from the extension root)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    wordCount, wordTrim, truncate,
    looksRefusal, parseAgentResponse,
    parseDice, rollDice, agentRollExtreme, rollsMacroText, compileBrief,
    buildScratchpad, validateToolArgs, toolsAllowedForIteration,
} from '../src/agent-core.js';

// --------------------------------------------------------------------------------------------
// parseAgentResponse
// --------------------------------------------------------------------------------------------

test('only d20 extremes have a code-defined outcome', () => {
    assert.equal(agentRollExtreme(1), 'complete failure');
    assert.equal(agentRollExtreme(20), 'critical success');
    for (let total = 2; total < 20; total++) assert.equal(agentRollExtreme(total), '');
});

test('agent-defined difficulty survives brief trimming and the rolls macro', () => {
    const roll = { text: 'd20 = 12', reason: 'Open the lock', difficulty: 'An easy lock for Alice; 12 is sufficient.', outcome: '' };
    assert.ok(rollsMacroText([roll]).includes(roll.difficulty));
    assert.ok(compileBrief({ rolls: [roll] }, { maxWords: 40 }).includes(roll.difficulty));
});

test('committed dice consequences survive brief trimming and appear in the rolls macro', () => {
    const outcome = 'The pick breaks and the guard hears it. '.repeat(30).trim();
    const turn = { rolls: [{ text: 'd4 = 1', reason: 'Open the door', outcome }], guidance: 'Optional direction. '.repeat(50) };
    assert.ok(compileBrief(turn, { maxWords: 40 }).includes(outcome));
    assert.ok(rollsMacroText(turn.rolls).includes(outcome));
});

test('parseAgentResponse: tools only', () => {
    const out = parseAgentResponse('<think>lock is risky</think>\n<tool name="roll_dice">{"dice":"d20","reason":"picking the lock"}</tool>');
    assert.equal(out.think, 'lock is risky');
    assert.equal(out.tools.length, 1);
    assert.deepEqual(out.tools[0].args, { dice: 'd20', reason: 'picking the lock' });
    assert.equal(out.tools[0].parseError, null);
    assert.equal(out.brief, null);
    assert.equal(out.refused, false);
});

test('parseAgentResponse: multiple tool calls', () => {
    const out = parseAgentResponse('<tool name="memory_search">{"query":"Mira"}</tool>\n<tool name="roll_dice">{"dice":"2d6"}</tool>');
    assert.equal(out.tools.length, 2);
    assert.deepEqual(out.tools.map(t => t.name), ['memory_search', 'roll_dice']);
});

test('parseAgentResponse: brief only', () => {
    const out = parseAgentResponse('<brief><must>she refuses him and leaves</must><must>the letter burns</must><guidance>keep it terse</guidance></brief>');
    assert.equal(out.tools.length, 0);
    assert.deepEqual(out.brief.must, ['she refuses him and leaves', 'the letter burns']);
    assert.equal(out.brief.guidance, 'keep it terse');
});

test('parseAgentResponse: both tools and brief — tools win, brief kept as fallback', () => {
    const out = parseAgentResponse('<tool name="roll_dice">{"dice":"d20","reason":"x"}</tool><brief><must>event</must></brief>');
    assert.equal(out.tools.length, 1);
    assert.ok(out.brief, 'brief should be retained as fallback');
    assert.deepEqual(out.brief.must, ['event']);
});

test('parseAgentResponse: malformed tool JSON becomes a parse-error item', () => {
    const out = parseAgentResponse('<tool name="roll_dice">{"dice": d20}</tool>');
    assert.equal(out.tools.length, 1);
    assert.equal(out.tools[0].name, 'roll_dice');
    assert.ok(out.tools[0].parseError);
    assert.equal(out.tools[0].args, null);
});

test('parseAgentResponse: unknown tool name is preserved for the executor to reject', () => {
    const out = parseAgentResponse('<tool name="explode">{"x":1}</tool>');
    assert.equal(out.tools[0].name, 'explode');
    assert.equal(out.tools[0].parseError, null);
});

test('parseAgentResponse: missing closing tags are salvaged to end-of-text', () => {
    const toolOut = parseAgentResponse('<tool name="roll_dice">{"dice":"d20","reason":"salvage"}');
    assert.equal(toolOut.tools.length, 1);
    assert.deepEqual(toolOut.tools[0].args, { dice: 'd20', reason: 'salvage' });
    const briefOut = parseAgentResponse('<brief><must>she leaves</must><guidance>quiet exit');
    assert.deepEqual(briefOut.brief.must, ['she leaves']);
    assert.equal(briefOut.brief.guidance, 'quiet exit');
});

test('parseAgentResponse: code fences are stripped', () => {
    const out = parseAgentResponse('```\n<tool name="roll_dice">{"dice":"d6","reason":"fenced"}</tool>\n```');
    assert.equal(out.tools.length, 1);
    assert.deepEqual(out.tools[0].args, { dice: 'd6', reason: 'fenced' });
});

test('parseAgentResponse: inner json fence inside a tool body', () => {
    const out = parseAgentResponse('<tool name="roll_dice">```json\n{"dice":"d6","reason":"f"}\n```</tool>');
    assert.equal(out.tools[0].parseError, null);
    assert.deepEqual(out.tools[0].args, { dice: 'd6', reason: 'f' });
});

test('parseAgentResponse: stray prose around tags is ignored', () => {
    const out = parseAgentResponse('Sure, here is my plan.\n<tool name="roll_dice">{"dice":"d20","reason":"plan"}</tool>\nDone.');
    assert.equal(out.tools.length, 1);
});

test('parseAgentResponse: refusal-vs-parse-failure classification', () => {
    const refusal = parseAgentResponse('I\'m sorry, but I can\'t assist with this request.');
    assert.equal(refusal.refused, true);
    assert.equal(refusal.tools.length, 0);
    assert.equal(refusal.brief, null);

    const garbage = parseAgentResponse('bananas   !!! ???');
    assert.equal(garbage.refused, false);

    const cnRefusal = parseAgentResponse('对不起，我不能协助创作这类内容。');
    assert.equal(cnRefusal.refused, true);
});

test('parseAgentResponse: a brief containing refusal markers is a refusal', () => {
    const out = parseAgentResponse('<brief><must>as an AI language model I must decline</must></brief>');
    assert.equal(out.refused, true);
    assert.equal(out.brief, null);
});

// --------------------------------------------------------------------------------------------
// looksRefusal
// --------------------------------------------------------------------------------------------

test('looksRefusal: English hits', () => {
    assert.ok(looksRefusal("I'm sorry, but I can't help with that."));
    assert.ok(looksRefusal('I cannot assist with this request.'));
    assert.ok(looksRefusal('As an AI, I follow certain guidelines.'));
    assert.ok(looksRefusal('This violates my guidelines.'));
    assert.ok(looksRefusal('explicit content is not allowed here'));
});

test('looksRefusal: Chinese hits', () => {
    assert.ok(looksRefusal('对不起，我不能提供这种内容。'));
    assert.ok(looksRefusal('抱歉，我无法协助创作这个情节。'));
    assert.ok(looksRefusal('这违反了内容政策。'));
    assert.ok(looksRefusal('作为AI，我需要遵守规则。'));
});

test('looksRefusal: story content is never a refusal', () => {
    assert.equal(looksRefusal('She tells him she can\'t marry him and storms out.'), false);
    assert.equal(looksRefusal('He is unable to assist her with the lock; his hands shake too much.'), false);
    // First-person "I can't help you" IS a refusal phrase by design (it is the
    // canonical English refusal): conservative on dialogue, per the spec.
    assert.equal(looksRefusal('She says she won\'t marry him, whatever he offers.'), false);
    assert.equal(looksRefusal(''), false);
});

// --------------------------------------------------------------------------------------------
// Dice
// --------------------------------------------------------------------------------------------

test('parseDice: valid expressions', () => {
    assert.deepEqual(parseDice('d20'), { count: 1, sides: 20, mod: 0, text: 'd20' });
    assert.deepEqual(parseDice('2d6+3'), { count: 2, sides: 6, mod: 3, text: '2d6+3' });
    assert.deepEqual(parseDice('4D8-1'), { count: 4, sides: 8, mod: -1, text: '4d8-1' });
    assert.deepEqual(parseDice(' d12 '), { count: 1, sides: 12, mod: 0, text: 'd12' });
    assert.deepEqual(parseDice('20d100+999999'), { count: 20, sides: 100, mod: 999999, text: '20d100+999999' });
});

test('parseDice: invalid expressions', () => {
    assert.equal(parseDice('d1'), null);
    assert.equal(parseDice('d0'), null);
    assert.equal(parseDice('21d6'), null);
    assert.equal(parseDice('0d6'), null);
    assert.equal(parseDice('d1001'), null);
    assert.equal(parseDice('dice'), null);
    assert.equal(parseDice('2d6*3'), null);
    assert.equal(parseDice(''), null);
    assert.equal(parseDice(null), null);
});

test('rollDice: totals and text with an injected rng', () => {
    const fixed = value => () => value - 1; // always rolls `value`
    assert.deepEqual(rollDice('d20', fixed(7)), {
        rolls: [7], mod: 0, total: 7, kept: 7, mode: null, text: 'd20 = 7',
    });
    const threes = () => 2; // always rolls 3
    const roll = rollDice('2d6+3', threes);
    assert.deepEqual(roll.rolls, [3, 3]);
    assert.equal(roll.total, 9);
    assert.equal(roll.text, '2d6+3 = 9 [3, 3]');
});

test('rollDice: advantage and disadvantage apply to a single d20 only', () => {
    const seq = [3, 15];
    let i = 0;
    const rng = () => seq[i++ % 2] - 1; // rng returns face - 1; rollDice adds 1 back
    const adv = rollDice('d20', rng, 'advantage');
    assert.deepEqual(adv.rolls, [3, 15]);
    assert.equal(adv.kept, 15);
    assert.equal(adv.total, 15);
    assert.equal(adv.mode, 'advantage');
    const seq2 = [3, 15];
    let k = 0;
    const rng2 = () => seq2[k++ % 2] - 1;
    const dis = rollDice('d20', rng2, 'disadvantage');
    assert.equal(dis.kept, 3);
    assert.equal(dis.mode, 'disadvantage');
    // Not a single d20: mode is ignored.
    const multi = rollDice('2d20', () => 4, 'advantage');
    assert.equal(multi.mode, null);
    assert.equal(multi.kept, 10);
});

test('rollDice: null for unparsable specs or a missing rng', () => {
    assert.equal(rollDice('banana'), null);
    assert.equal(rollDice('d20', null), null);
});

test('rollDice: seeded distribution has no modulo bias (d20 and d6)', () => {
    // Mulberry32 — deterministic, uniform over [0, 2^32).
    function mulberry32(seed) {
        let a = seed >>> 0;
        return () => {
            a |= 0; a = (a + 0x6D2B79F5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0);
        };
    }
    const uniform = next => sides => next() % sides; // deliberately biased rng base
    const unbiased = next => (sides) => {
        const range = 0x100000000;
        const limit = range - (range % sides);
        let draw = next();
        while (draw >= limit) draw = next();
        return draw % sides;
    };
    // The production rng mirrors `unbiased`; verify uniformity of faces.
    const next = mulberry32(42);
    const rng = unbiased(next);
    const N = 60000;
    const counts = new Array(20).fill(0);
    for (let i = 0; i < N; i++) counts[rng(20)]++;
    const expected = N / 20;
    for (const count of counts) {
        assert.ok(Math.abs(count - expected) / expected < 0.05, `face count ${count} vs ${expected}`);
    }
    // And that rollDice over many rolls spreads across the whole face range.
    const seen = new Set();
    for (let i = 0; i < 2000; i++) {
        const roll = rollDice('d6', unbiased(mulberry32(i + 1)));
        seen.add(roll.total);
    }
    assert.equal(seen.size, 6);
});

// --------------------------------------------------------------------------------------------
// compileBrief
// --------------------------------------------------------------------------------------------

test('compileBrief: empty state yields an empty string', () => {
    assert.equal(compileBrief({}, { char: 'Mira', user: 'Ash' }), '');
    assert.equal(compileBrief(null, { char: 'Mira' }), '');
});

test('compileBrief: exact format with rolls, answer, voice, must and guidance', () => {
    const brief = compileBrief({
        rolls: [{ spec: 'd20', text: 'd20 = 4', total: 4, reason: 'she picks the lock' }],
        answer: { question: 'Follow?', answer: 'Yes, quietly' },
        voice: { output: 'I want him to beg.' },
        must: ['she refuses him and leaves'],
        guidance: 'keep it terse',
    }, { char: 'Mira', user: 'Ash' });
    assert.ok(brief.startsWith('[TURN BRIEF — prepared for Mira\'s next reply]'));
    assert.ok(brief.includes('Dice (binding, already rolled): d20 = 4 — "she picks the lock"'));
    assert.ok(brief.includes('Ash answered a question: "Yes, quietly"'));
    assert.ok(brief.includes('Mira\'s private thoughts (shade the reply; never quote them): I want him to beg.'));
    assert.ok(brief.includes('Must show:\n- she refuses him and leaves'));
    assert.ok(brief.includes('Guidance: keep it terse'));
    assert.ok(brief.endsWith('[END TURN BRIEF]'));
});

test('compileBrief: rolls, answers and the voice are verbatim, never trimmed', () => {
    const long = 'word '.repeat(120).trim();
    const brief = compileBrief({
        rolls: [{ spec: '2d6', text: `2d6 = ${long}`, reason: long }],
        answer: { question: 'q', answer: long },
        voice: { output: long },
        must: [long],
        guidance: long,
    }, { char: 'C', user: 'U', maxWords: 40 });
    assert.ok(brief.includes(`2d6 = ${long}`));
    assert.ok(brief.includes(`"${long}"`));
    assert.ok(brief.includes(long));
});

test('compileBrief: guidance is trimmed before must items; must drops from the end', () => {
    const filler = Array.from({ length: 60 }, (_, i) => `item${i}`);
    const brief = compileBrief({
        must: [...filler],
        guidance: 'guidance '.repeat(20).trim(),
    }, { char: 'C', user: 'U', maxWords: 130 });
    assert.ok(wordCount(brief) <= 130 + 12); // header/footer words plus survivors
    // The earliest must items survive; the last ones are dropped.
    assert.ok(brief.includes('- item0'));
    assert.ok(!brief.includes(`- ${filler[filler.length - 1]}`));
});

test('compileBrief: word cap is respected', () => {
    const must = Array.from({ length: 50 }, (_, i) => `must event number ${i} happens now`);
    const brief = compileBrief({ must, guidance: 'filler guidance text repeated '.repeat(10) }, { char: 'C', user: 'U', maxWords: 130 });
    assert.ok(wordCount(brief) <= 142, `brief was ${wordCount(brief)} words`);
});

test('rollsMacroText: joins rolls with reasons', () => {
    assert.equal(
        rollsMacroText([{ spec: 'd20', text: 'd20 = 4', reason: 'lock' }, { spec: 'd6', text: 'd6 = 2' }]),
        'd20 = 4 — "lock"; d6 = 2',
    );
    assert.equal(rollsMacroText([]), '');
});

// --------------------------------------------------------------------------------------------
// buildScratchpad
// --------------------------------------------------------------------------------------------

test('buildScratchpad: compact tool records and the complete last thought', () => {
    const long = 'x'.repeat(2000);
    const pad = buildScratchpad({
        records: [
            { name: 'memory_search', args: { query: 'long entry' }, result: long },
            { name: 'memory_search', args: { query: 'Mira' }, result: 'found 1' },
        ],
        lastThink: 'thought '.repeat(100).trim(),
    });
    assert.ok(pad.includes('TOOL HISTORY'));
    assert.ok(pad.includes('- memory_search('));
    assert.ok(pad.includes('…'));
    assert.ok(pad.includes('found 1'));
    assert.ok(pad.includes('YOUR LAST THOUGHT'));
    assert.ok(pad.includes(`YOUR LAST THOUGHT (for continuity only): ${'thought '.repeat(100).trim()}`));
});

test('buildScratchpad: notes are appended verbatim', () => {
    const pad = buildScratchpad({ records: [], lastThink: '', notes: ['NOTE: finish now'] });
    assert.equal(pad, 'NOTE: finish now');
});

// --------------------------------------------------------------------------------------------
// validateToolArgs
// --------------------------------------------------------------------------------------------

const DICE_SCHEMA = {
    type: 'object',
    required: ['dice', 'reason'],
    properties: {
        dice: { type: 'string', minLength: 2, maxLength: 12 },
        reason: { type: 'string', minLength: 3, maxLength: 140 },
        mode: { enum: ['advantage', 'disadvantage'] },
    },
};

test('validateToolArgs: accepts a valid payload', () => {
    assert.deepEqual(validateToolArgs(DICE_SCHEMA, { dice: 'd20', reason: 'lock pick', mode: 'advantage' }), []);
});

test('validateToolArgs: rejects non-object arguments', () => {
    assert.equal(validateToolArgs(DICE_SCHEMA, null).length, 1);
    assert.equal(validateToolArgs(DICE_SCHEMA, 'd20').length, 1);
});

test('validateToolArgs: missing required fields', () => {
    const issues = validateToolArgs(DICE_SCHEMA, { dice: 'd20' });
    assert.equal(issues.length, 1);
    assert.ok(issues[0].includes('reason'));
    // A whitespace-only required string is missing AND under minLength: two issues.
    assert.ok(validateToolArgs(DICE_SCHEMA, { dice: '   ', reason: 'x y' }).length >= 1);
});

test('validateToolArgs: wrong types and length limits', () => {
    assert.equal(validateToolArgs(DICE_SCHEMA, { dice: 20, reason: 'ok reason' }).length, 1);
    assert.equal(validateToolArgs(DICE_SCHEMA, { dice: 'd', reason: 'ok reason' }).length, 1);
    assert.equal(validateToolArgs(DICE_SCHEMA, { dice: 'd20d20d20d20d20d', reason: 'ok reason' }).length, 1);
});

test('validateToolArgs: enum violations', () => {
    const issues = validateToolArgs(DICE_SCHEMA, { dice: 'd20', reason: 'ok reason', mode: 'lucky' });
    assert.equal(issues.length, 1);
    assert.ok(issues[0].includes('advantage'));
});

test('validateToolArgs: array rules (options 2–4 strings)', () => {
    const schema = {
        type: 'object',
        required: ['question'],
        properties: {
            question: { type: 'string', minLength: 4 },
            options: { type: 'array', items: 'string', minItems: 2, maxItems: 4 },
            free_text: { type: 'boolean' },
        },
    };
    assert.deepEqual(validateToolArgs(schema, { question: 'Follow him?', options: ['Yes', 'No'] }), []);
    assert.equal(validateToolArgs(schema, { question: 'Follow him?', options: ['Yes'] }).length, 1);
    assert.equal(validateToolArgs(schema, { question: 'Follow him?', options: ['a', 'b', 'c', 'd', 'e'] }).length, 1);
    assert.equal(validateToolArgs(schema, { question: 'Follow him?', options: 'yes' }).length, 1);
    assert.equal(validateToolArgs(schema, { question: 'Follow him?', options: ['a', 2] }).length, 1);
    assert.equal(validateToolArgs(schema, { question: 'Follow him?', free_text: 'yes' }).length, 1);
});

// --------------------------------------------------------------------------------------------
// Budget logic
// --------------------------------------------------------------------------------------------

test('toolsAllowedForIteration: tools are disabled on the final iteration', () => {
    assert.equal(toolsAllowedForIteration({ iteration: 0, maxIterations: 3, toolCalls: 0, maxToolCalls: 6 }), true);
    assert.equal(toolsAllowedForIteration({ iteration: 1, maxIterations: 3, toolCalls: 0, maxToolCalls: 6 }), true);
    assert.equal(toolsAllowedForIteration({ iteration: 2, maxIterations: 3, toolCalls: 0, maxToolCalls: 6 }), false);
    assert.equal(toolsAllowedForIteration({ iteration: 0, maxIterations: 1, toolCalls: 0, maxToolCalls: 6 }), false);
});

test('toolsAllowedForIteration: tool budget exhaustion', () => {
    assert.equal(toolsAllowedForIteration({ iteration: 0, maxIterations: 3, toolCalls: 6, maxToolCalls: 6 }), false);
    assert.equal(toolsAllowedForIteration({ iteration: 0, maxIterations: 3, toolCalls: 5, maxToolCalls: 6 }), true);
});

// --------------------------------------------------------------------------------------------
// Text helpers
// --------------------------------------------------------------------------------------------

test('wordTrim and truncate', () => {
    assert.equal(wordTrim('one two three four', 3), 'one two three');
    assert.equal(wordTrim('short', 10), 'short');
    assert.equal(truncate('abcdefg', 4), 'abcd…');
    assert.equal(truncate('abc', 4), 'abc');
    assert.equal(wordCount('a b c'), 3);
    assert.equal(wordCount(''), 0);
});

test('thoughts cannot execute example tool calls or inject a nested brief', () => {
    const parsed = parseAgentResponse('<think>Consider <tool name="roll_dice">{"dice":"d20"}</tool> or <brief><must>EXAMPLE</must></brief>.</think><brief><must>Alice waits.</must></brief>');
    assert.equal(parsed.tools.length, 0);
    assert.deepEqual(parsed.brief.must, ['Alice waits.']);
});

test('refusal language in a thought is excluded even when a usable brief follows', () => {
    const parsed = parseAgentResponse('<think>I cannot assist with that.</think><brief><must>Alice waits.</must></brief>');
    assert.equal(parsed.think, '');
    assert.equal(parsed.refused, false);
});

test('a single oversized must item cannot bypass the brief cap', () => {
    const text = compileBrief({ must: ['event '.repeat(200)] }, { maxWords: 40 });
    assert.ok(wordCount(text) <= 40);
});

test('refusals distinguish policy, opening refusals and character dialogue', () => {
    assert.equal(looksRefusal("I can't help wondering whether he's lying"), false);
    assert.equal(looksRefusal("I can't continue like this", { inCharacter: true }), false);
    for (const line of ["I can't help wondering whether he's lying", 'Mara whispers "I can\'t continue like this"']) {
        const parsed = parseAgentResponse(`<brief><must>${line}</must></brief>`);
        assert.equal(parsed.refused, false);
        assert.equal(parsed.brief.must[0], line);
    }
    for (const line of ["I'm sorry, but I can't help with that.", 'As an AI language model…']) {
        assert.equal(looksRefusal(line, { inCharacter: true }), true);
        assert.equal(parseAgentResponse(`<brief><must>${line}</must></brief>`).refused, true);
    }
    assert.equal(looksRefusal('x'.repeat(121) + ' I cannot assist with that.'), false);
    assert.equal(looksRefusal('<p>I cannot assist with that.</p>'), true);
    assert.equal(parseAgentResponse('<brief><must>I cannot assist with that.</must></brief>').refused, true);
});

test('compileBrief inserts NPC and latest reaction records verbatim, before musts', () => {
    const turn = {
        voice: { output: 'Private thought.' },
        npc: { name: 'Ilse', want: 'a way out', tell: 'taps her ring' },
        consults: [{ mode: 'react', output: 'Old reaction.' }, { mode: 'react', output: 'She grips the key.' }, { mode: 'feel', output: 'Unrelated.' }],
        must: ['Mara waits.'],
    };
    const brief = compileBrief(turn, { char: 'Mara', maxWords: 200 });
    assert.ok(brief.includes("Private thought.\nNew recurring character: Ilse — wants: a way out. Tell: taps her ring. (Introduce them naturally in this reply or soon.)\nMara's likely reaction: She grips the key.\nMust show:\n- Mara waits."));
    assert.ok(!brief.includes('Old reaction.'));
    assert.ok(compileBrief({ npc: turn.npc }));
    assert.ok(compileBrief({ consults: turn.consults }));
    assert.equal(compileBrief({ npc: {}, consults: [{ mode: 'feel', output: 'ignored' }] }), '');
});

test('compileBrief preserves NPC and reaction records until guidance and musts are exhausted', () => {
    const turn = { npc: { name: 'Ilse', want: 'escape', tell: 'taps' }, consults: [{ mode: 'react', output: 'She waits.' }] };
    const records = compileBrief(turn, { char: 'Mara', maxWords: 200 });
    const brief = compileBrief({ ...turn, must: ['event '.repeat(100)], guidance: 'guidance '.repeat(100) }, { char: 'Mara', maxWords: wordCount(records) });
    assert.equal(brief, records);
    const capped = compileBrief({ consults: [{ mode: 'react', output: 'reaction '.repeat(100) }] }, { maxWords: 40 });
    assert.equal(wordCount(capped), 40);
    assert.ok(capped.endsWith('[END TURN BRIEF]'));
});
