import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseGmOutput, parseFitCheck, createClock, advanceClock, removeClock, findClock, clockMust, renderClocks,
    normalizeClock, setAgenda, deleteAgenda, renderAgendas, normalizeAgendas, isAnchorValid, makeAnchor,
    normalizePrepared, compileGmBrief, planFromPrepared, normalizeGmStore, capTranscript, parseQuestionAnswer,
    renderBible, renderPrepared, GM_MAX_MUSTS, GM_MAX_BRANCHES, CLOCK_MAX, AGENDA_MAX,
} from '../src/gm-core.js';
import { wordCount } from '../src/agent-core.js';

// --------------------------------------------------------------------------------------------
// Output parser
// --------------------------------------------------------------------------------------------

test('parseGmOutput reads a well-formed final output', () => {
    const out = parseGmOutput([
        '<brief>Mara bars the door and demands to know who sent the stranger.</brief>',
        '<must>A knock hammers the door twice</must>',
        '<must>Mara draws her knife</must>',
        '<branch if="the player opens the door">Captain Voss steps in, hand on his sword</branch>',
        '<branch if="the player stays silent">The knocking stops; a note slides under the door</branch>',
        '<fields>Mood, Goals</fields>',
        '<skip>Tactics</skip>',
    ].join('\n'));
    assert.equal(out.brief, 'Mara bars the door and demands to know who sent the stranger.');
    assert.deepEqual(out.musts, ['A knock hammers the door twice', 'Mara draws her knife']);
    assert.deepEqual(out.branches, [
        { if: 'the player opens the door', then: 'Captain Voss steps in, hand on his sword' },
        { if: 'the player stays silent', then: 'The knocking stops; a note slides under the door' },
    ]);
    assert.deepEqual(out.fields, ['Mood', 'Goals']);
    assert.deepEqual(out.skips, ['Tactics']);
    assert.equal(out.valid, true);
    assert.equal(out.refused, false);
    assert.deepEqual(out.tools, []);
});

test('parseGmOutput salvages messy output: unclosed tags, nesting, quotes, fences, case', () => {
    const out = parseGmOutput('```\n<BRIEF>The guards regroup.\n<MUST>The bell rings\n<branch if=\'she runs\'>Archers loose arrows\n<skip>Tactics\n```');
    assert.equal(out.brief, 'The guards regroup.');
    assert.deepEqual(out.musts, ['The bell rings']);
    assert.deepEqual(out.branches, [{ if: 'she runs', then: 'Archers loose arrows' }]);
    assert.deepEqual(out.skips, ['Tactics']);
    // The legacy shape (musts nested in the brief, <guidance>) still yields a usable result.
    const legacy = parseGmOutput('<brief><must>The door bursts open</must><guidance>Keep it tense.</guidance></brief>');
    assert.deepEqual(legacy.musts, ['The door bursts open']);
    assert.equal(legacy.brief, 'Keep it tense.');
    assert.equal(legacy.valid, true);
    // A branch without a condition or an outcome is dropped; so is an empty must.
    const broken = parseGmOutput('<brief>x</brief><branch>no condition</branch><branch if="a"></branch><must>  </must>');
    assert.deepEqual(broken.branches, []);
    assert.deepEqual(broken.musts, []);
});

test('parseGmOutput ignores think blocks (including tag lookalikes) and keeps tools separate', () => {
    const out = parseGmOutput('<think>Maybe <must>fake</must> and <brief>fake</brief>…</think><brief>Real brief.</brief>');
    assert.equal(out.brief, 'Real brief.');
    assert.deepEqual(out.musts, []);
    assert.equal(out.think.includes('fake'), true);
    const mixed = parseGmOutput('<tool name="roll_dice">{"reason":"Pick the lock","difficulty":"Hard lock, untrained"}</tool><brief>Fallback brief.</brief>');
    assert.equal(mixed.tools.length, 1);
    assert.equal(mixed.tools[0].name, 'roll_dice');
    assert.equal(mixed.brief, 'Fallback brief.');
    assert.equal(mixed.valid, true);
    // Tool bodies are not mistaken for tags of the final output.
    const toolOnly = parseGmOutput('<tool name="clock">{"action":"create","name":"<must>x</must>"}</tool>');
    assert.equal(toolOnly.valid, false);
});

test('parseGmOutput caps everything: musts, branches, words', () => {
    const many = Array.from({ length: 6 }, (_, i) => `<must>event ${i}</must>`).join('')
        + Array.from({ length: 7 }, (_, i) => `<branch if="cond ${i}">outcome ${i}</branch>`).join('');
    const out = parseGmOutput(`<brief>${'word '.repeat(300)}</brief>${many}<must>${'long '.repeat(80)}</must>`);
    assert.equal(out.musts.length, GM_MAX_MUSTS);
    assert.equal(out.branches.length, GM_MAX_BRANCHES);
    assert.ok(wordCount(out.brief) <= 120);
    const long = parseGmOutput(`<brief>b</brief><must>${'long '.repeat(80)}</must><branch if="${'c '.repeat(60)}">${'o '.repeat(90)}</branch>`);
    assert.ok(wordCount(long.musts[0]) <= 40);
    assert.ok(wordCount(long.branches[0].if) <= 20);
    assert.ok(wordCount(long.branches[0].then) <= 40);
    // Duplicates collapse case-insensitively.
    assert.deepEqual(parseGmOutput('<brief>b</brief><must>Same</must><must>same</must>').musts, ['Same']);
});

test('parseGmOutput: fields tag semantics and refusals', () => {
    assert.equal(parseGmOutput('<brief>b</brief>').fields, null);
    assert.deepEqual(parseGmOutput('<brief>b</brief><fields>none</fields>').fields, []);
    assert.deepEqual(parseGmOutput('<brief>b</brief><fields>Mood; goals, Mood</fields>').fields, ['Mood', 'goals']);
    const refused = parseGmOutput('I\'m sorry, but I can\'t help with that request.');
    assert.equal(refused.refused, true);
    assert.equal(refused.valid, false);
    // A must that merely mentions "can't" is story content, not a refusal.
    const story = parseGmOutput('<brief>She tells him she can\'t marry him.</brief><must>She refuses and leaves</must>');
    assert.equal(story.refused, false);
    assert.equal(story.valid, true);
    assert.equal(parseGmOutput('').valid, false);
    assert.equal(parseGmOutput(null).valid, false);
});

// --------------------------------------------------------------------------------------------
// Fit check
// --------------------------------------------------------------------------------------------

test('parseFitCheck understands numbers, none and garbage', () => {
    assert.deepEqual(parseFitCheck('<use>1,3</use>', 4), { ok: true, use: [1, 3], none: false });
    assert.deepEqual(parseFitCheck('<think>no</think> <use> 3 and 1 </use>', 4).use, [1, 3]);
    assert.deepEqual(parseFitCheck('<use>2, 2, 9, 0</use>', 3).use, [2]);
    assert.deepEqual(parseFitCheck('<use>none</use>', 3), { ok: true, use: [], none: true });
    assert.deepEqual(parseFitCheck('<use>None of them</use>', 3).none, true);
    assert.equal(parseFitCheck('<use>2', 3).ok, true);
    for (const bad of ['', 'branch 1 applies', '<use>banana</use>', '<use>7</use>', null]) {
        assert.deepEqual(parseFitCheck(bad, 3), { ok: false, use: [], none: false });
    }
});

// --------------------------------------------------------------------------------------------
// Clocks
// --------------------------------------------------------------------------------------------

test('clock math: create, advance, fill, resolve', () => {
    const clocks = [];
    const made = createClock(clocks, { name: 'Guards close in', segments: 4, consequence: 'Guards pound on the door.' });
    assert.equal(made.ok, true);
    assert.deepEqual(clocks[0], { id: 1, name: 'Guards close in', segments: 4, filled: 0, consequence: 'Guards pound on the door.', status: 'active' });
    assert.equal(createClock(clocks, { name: 'guards CLOSE in' }).ok, false); // names are unique, case-insensitively
    let moved = advanceClock(clocks, 'guards close in', 1);
    assert.deepEqual([moved.ok, moved.clock.filled, moved.justFilled], [true, 1, false]);
    moved = advanceClock(clocks, 1, 3); // by id; 1 + 3 reaches the 4 segments
    assert.deepEqual([moved.clock.filled, moved.justFilled, moved.clock.status], [4, true, 'filled']);
    assert.equal(clockMust(moved.clock), 'Guards pound on the door.');
    assert.equal(advanceClock(clocks, 'Guards close in').ok, false); // a filled clock cannot advance again
    assert.equal(advanceClock(clocks, 'nope').ok, false);
    assert.equal(removeClock(clocks, 'Guards close in').ok, true);
    assert.equal(clocks.length, 0);
    assert.equal(removeClock(clocks, 'Guards close in').ok, false);
});

test('clock limits: segments clamp, advance clamp, count cap, missing names', () => {
    const clocks = [];
    assert.equal(createClock(clocks, { name: 'a', segments: 99 }).clock.segments, 12);
    assert.equal(createClock(clocks, { name: 'b', segments: 0 }).clock.segments, 2);
    assert.equal(createClock(clocks, { name: 'c', segments: 'x' }).clock.segments, 6);
    const moved = advanceClock(clocks, 'a', 99); // by is clamped to 3
    assert.equal(moved.clock.filled, 3);
    assert.equal(advanceClock(clocks, 'a', -5).clock.filled, 4); // and to at least 1
    assert.equal(createClock(clocks, { name: '   ' }).ok, false);
    for (let i = 0; i < CLOCK_MAX; i++) createClock(clocks, { name: `extra ${i}` });
    assert.equal(clocks.length, CLOCK_MAX);
    assert.equal(createClock(clocks, { name: 'one too many' }).ok, false);
    // A clock that fills mid-way by a small clock still reports justFilled exactly once.
    const small = [];
    createClock(small, { name: 's', segments: 2 });
    assert.equal(advanceClock(small, 's', 1).justFilled, false);
    assert.equal(advanceClock(small, 's', 2).justFilled, true);
});

test('clock helpers: ids, default must, normalization and rendering', () => {
    const clocks = [];
    createClock(clocks, { name: 'A', consequence: 'x' });
    createClock(clocks, { name: 'B' });
    removeClock(clocks, 'A');
    assert.equal(createClock(clocks, { name: 'C' }).clock.id, 3); // ids never repeat while a higher one lives
    assert.equal(findClock(clocks, '2').name, 'B');
    assert.match(clockMust({ name: 'B', consequence: '' }), /"B" clock is full/);
    assert.equal(normalizeClock({ id: 1, name: 'x', segments: 4, filled: 9 }).status, 'filled');
    assert.equal(normalizeClock({ id: 0, name: 'x' }), null);
    assert.equal(normalizeClock('junk'), null);
    const text = renderClocks([{ id: 1, name: 'Doom', segments: 6, filled: 2, consequence: 'The city burns', status: 'active' },
        { id: 2, name: 'Old', segments: 3, filled: 3, consequence: '', status: 'filled' }]);
    assert.match(text, /Doom \[2\/6\] — when full: The city burns/);
    assert.match(text, /Old \[FULL 3\/3\]/);
});

// --------------------------------------------------------------------------------------------
// NPC agendas
// --------------------------------------------------------------------------------------------

test('agendas: set, replace case-insensitively, cap words and count, delete', () => {
    const agendas = {};
    assert.equal(setAgenda(agendas, 'Voss', 'seals the harbor', 5).ok, true);
    assert.equal(setAgenda(agendas, 'voss', 'sends scouts to the inn', 6).name, 'Voss');
    assert.deepEqual(Object.keys(agendas), ['Voss']);
    assert.equal(agendas.Voss.intent, 'sends scouts to the inn');
    assert.ok(wordCount(setAgenda(agendas, 'Mara', 'word '.repeat(100)).intent) <= 40);
    assert.equal(setAgenda(agendas, '', 'x').ok, false);
    assert.equal(setAgenda(agendas, 'N', '  ').ok, false);
    for (let i = 0; i < AGENDA_MAX + 3; i++) setAgenda(agendas, `Npc ${i}`, 'wants something', 100 + i);
    assert.equal(Object.keys(agendas).length, AGENDA_MAX);
    assert.equal('Voss' in agendas, false); // the oldest were evicted
    assert.equal(deleteAgenda(agendas, 'npc 14'), true);
    assert.equal(deleteAgenda(agendas, 'npc 14'), false);
    assert.equal(renderAgendas({ Voss: { intent: 'x', at: 1 } }), '- Voss: x');
    assert.deepEqual(normalizeAgendas({ '__proto__': { intent: 'x' }, ok: 'plain text', bad: { intent: '' } }), { ok: { intent: 'plain text', at: 0 } });
});

// --------------------------------------------------------------------------------------------
// Anchor validity
// --------------------------------------------------------------------------------------------

const msg = (text, extra = {}) => ({ mes: text, ...extra });
const user = text => msg(text, { is_user: true });

test('anchor: valid for the next user message, invalid after an edit or a newer reply', () => {
    const chat = [user('hi'), msg('reply A'), user('go')];
    const prepared = makeAnchor(chat, 1);
    assert.deepEqual(prepared, { anchorIndex: 1, anchorText: 'reply A' });
    assert.equal(isAnchorValid(prepared, chat), true);
    assert.equal(isAnchorValid(prepared, [chat[0], msg('reply A (edited)'), chat[2]]), false);
    assert.equal(isAnchorValid(prepared, [...chat, msg('reply B')]), false);                        // superseded
    assert.equal(isAnchorValid(prepared, [chat[0], chat[1], user('one'), user('two')]), true);       // any number of user messages
    assert.equal(isAnchorValid(prepared, [chat[0]]), false);                                          // anchor gone
    assert.equal(isAnchorValid(prepared, [chat[0], user('now a user'), chat[2]]), false);            // index holds a user message
    assert.equal(isAnchorValid(null, chat), false);
    assert.equal(isAnchorValid({ anchorIndex: 'x' }, chat), false);
});

test('anchor: swipes / regenerates of the NEXT reply reuse it, those of the anchor do not', () => {
    const prepared = { anchorIndex: 1, anchorText: 'reply A' };
    const next = [user('hi'), msg('reply A'), user('go'), msg('reply B')];
    for (const type of ['swipe', 'regenerate', 'continue']) assert.equal(isAnchorValid(prepared, next, { type }), true, type);
    assert.equal(isAnchorValid(prepared, next, { type: 'normal' }), false); // a NORMAL send after reply B is a newer turn
    // The generation target IS the anchor: a swipe / regenerate / continue of it never qualifies.
    const anchorLast = [user('hi'), msg('reply A')];
    for (const type of ['swipe', 'regenerate', 'continue']) assert.equal(isAnchorValid(prepared, anchorLast, { type }), false, type);
    assert.equal(isAnchorValid(prepared, anchorLast, { type: 'normal' }), true); // sending with no user message
    // Two replies after the anchor can never be a swipe of one reply.
    assert.equal(isAnchorValid(prepared, [...next, msg('reply C')], { type: 'swipe' }), false);
    // System and ephemeral messages never count.
    assert.equal(isAnchorValid(prepared, [user('hi'), msg('reply A'), msg('note', { is_system: true }), user('go'), msg('x', { smarttavern_ephemeral: true })]), true);
});

// --------------------------------------------------------------------------------------------
// Prepared record, brief compiler, plan
// --------------------------------------------------------------------------------------------

const prepared = () => ({
    anchorIndex: 3, anchorText: 'reply', brief: 'Voss tightens the net around the inn.',
    musts: ['A bell tolls from the harbor'],
    branches: [{ if: 'the player flees', then: 'Scouts spot the player on the roof' }, { if: 'the player fights', then: 'The inn door splinters' }],
    rolls: [{ spec: 'd20', text: 'd20 = 1', total: 1, reason: 'Voss reads the room', difficulty: 'hard', outcome: 'complete failure', natural: 1 }],
    fields: ['Mood'], skips: ['Tactics'], createdAt: 1, model: 'm',
});

test('normalizePrepared repairs fields and rejects junk', () => {
    assert.equal(normalizePrepared(null), null);
    assert.equal(normalizePrepared({ anchorIndex: 'x' }), null);
    const out = normalizePrepared({ anchorIndex: '2', branches: [{ if: 'a' }, { if: 'b', then: 'c' }], musts: ['  x ', '', 3], fields: 'no', rolls: ['x', { text: 't' }], npc: { name: '' } });
    assert.equal(out.anchorIndex, 2);
    assert.deepEqual(out.branches, [{ if: 'b', then: 'c' }]);
    assert.deepEqual(out.musts, ['x', '3']);
    assert.equal(out.fields, null);
    assert.deepEqual(out.rolls, [{ text: 't' }]);
    assert.equal(out.npc, null);
    assert.equal(normalizePrepared({ anchorIndex: 0, fields: [] }).fields.length, 0);
});

test('compileGmBrief: brief, chosen branches first, musts, binding dice, Q/A', () => {
    const compiled = compileGmBrief(prepared(), { chosen: [1], qa: { question: 'Which door?', answer: 'The cellar' }, char: 'Mara', user: 'Sam', maxWords: 200 });
    assert.match(compiled.text, /\[TURN BRIEF — prepared for Mara's next reply\]/);
    assert.match(compiled.text, /Dice \(binding, already rolled\): d20 = 1/);
    assert.match(compiled.text, /Sam answered a question: "The cellar"/);
    assert.match(compiled.text, /Guidance: Voss tightens the net around the inn\./);
    const must = compiled.text.slice(compiled.text.indexOf('Must show:'));
    assert.ok(must.indexOf('Scouts spot the player on the roof') < must.indexOf('A bell tolls from the harbor'));
    assert.equal(compiled.text.includes('The inn door splinters'), false); // the branch that did not fire stays out
    assert.deepEqual(compiled.turn.must, ['Scouts spot the player on the roof', 'A bell tolls from the harbor']);
    assert.equal(compiled.turn.rolls.length, 1);
    assert.deepEqual(compiled.chosen.map(branch => branch.if), ['the player flees']);
    // The enforcement list reads turn.must / turn.rolls: they hold exactly what was compiled.
    assert.equal(compiled.turn.rulings.length, 0);
});

test('compileGmBrief: no branch chosen, out-of-range numbers, word cap, empty prepared', () => {
    const none = compileGmBrief(prepared(), { chosen: [], maxWords: 200 });
    assert.deepEqual(none.turn.must, ['A bell tolls from the harbor']);
    assert.deepEqual(compileGmBrief(prepared(), { chosen: [9, 2, 2] }).turn.must, ['The inn door splinters', 'A bell tolls from the harbor']);
    const big = { ...prepared(), brief: 'word '.repeat(120), musts: ['m1', 'm2', 'm3'] };
    const capped = compileGmBrief(big, { chosen: [1, 2], maxWords: 40 });
    assert.ok(wordCount(capped.text) <= 40 || capped.text.split('\n').length <= 4); // guidance trims first, dice never
    assert.match(capped.text, /Dice \(binding/);
    assert.equal(compileGmBrief({ anchorIndex: 0 }, {}).text, '');
    // Stored Q/A is used when none is passed (swipes reuse the same answer).
    assert.match(compileGmBrief({ ...prepared(), qa: { question: 'q', answer: 'stored' } }, { user: 'Sam' }).text, /answered a question: "stored"/);
});

test('planFromPrepared: only planner-activated blocks skip; fields validate against relevant names', () => {
    const steps = [
        { name: 'Tactics', activation: 'planner' }, { name: 'Always', activation: 'always' },
        { name: 'Motives', activation: 'planner' }, { name: 'Keyword', activation: 'keywords', keywords: 'x' },
    ];
    const plan = planFromPrepared({ ...prepared(), skips: ['tactics', 'Always', 'Motives — adds nothing', 'Nope'], fields: ['mood', 'Bogus'] }, steps, { relevantFieldNames: ['Mood', 'Goals'] });
    assert.deepEqual(plan.skipped.map(item => item.name), ['Tactics', 'Motives']);
    assert.deepEqual(plan.steps.map(step => step.name), ['Always', 'Keyword']);
    assert.deepEqual(plan.fields, ['Mood']);
    assert.equal(planFromPrepared({ ...prepared(), fields: null }, steps, { relevantFieldNames: ['Mood'] }).fields, null);
    assert.equal(planFromPrepared(prepared(), steps, { relevantFieldNames: [] }).fields, null); // nothing is relevant-mode
    assert.deepEqual(planFromPrepared({ ...prepared(), fields: [] }, steps, { relevantFieldNames: ['Mood'] }).fields, []); // "none matter"
    assert.equal(planFromPrepared(prepared(), steps, { limit: 2 }).steps.length, 1); // limit applies before skips
});

// --------------------------------------------------------------------------------------------
// Store, transcript, text helpers
// --------------------------------------------------------------------------------------------

test('normalizeGmStore builds the canonical shape and repairs damage', () => {
    const empty = normalizeGmStore({});
    assert.deepEqual(empty, { prepared: null, previous: null, clocks: [], agendas: {}, pendingQuestion: null, tick: 0, transcript: [], status: null });
    const damaged = normalizeGmStore({ prepared: 'x', clocks: [{ id: 1, name: 'A', segments: 3 }, 'junk'], agendas: [], pendingQuestion: { question: ' ?' , at: 'x' }, tick: -4, transcript: 'no', status: { at: 5, ok: false, text: 'bad' } });
    assert.equal(damaged.prepared, null);
    assert.equal(damaged.clocks.length, 1);
    assert.deepEqual(damaged.agendas, {});
    assert.deepEqual(damaged.pendingQuestion, { question: '?', at: 0 });
    assert.equal(damaged.tick, 0);
    assert.deepEqual(damaged.status, { at: 5, ok: false, text: 'bad' });
    const same = { prepared: prepared() };
    assert.equal(normalizeGmStore(same), same); // normalizes in place
});

test('capTranscript keeps the newest entries and trims text', () => {
    const entries = Array.from({ length: 60 }, (_, i) => ({ title: `t${i}`, text: 'x'.repeat(5000), tone: i % 2 ? 'ok' : 'weird' }));
    const capped = capTranscript(entries);
    assert.equal(capped.length, 40);
    assert.equal(capped[0].title, 't20');
    assert.ok(capped[0].text.length <= 1501);
    assert.equal(capped[0].tone, 'info');
    assert.deepEqual(capTranscript('nope'), []);
});

test('parseQuestionAnswer and text renderers', () => {
    assert.deepEqual(parseQuestionAnswer('Question: Which door?\nAnswer: The cellar'), { question: 'Which door?', answer: 'The cellar' });
    assert.equal(parseQuestionAnswer(''), null);
    assert.equal(parseQuestionAnswer('Question: q\nAnswer:   '), null);
    const story = { bible: { title: 'T', secrets: 'The duke is dead', cast: [{ name: 'Voss', wants: 'power', secret: 'poisoner' }], chapters: [{ title: 'One', situation: 's' }, { title: 'Two', situation: 'u' }] }, chapterIndex: 1, ledger: ['a'], beat: { text: 'b', status: 'pending' } };
    const bible = renderBible(story);
    assert.match(bible, /Secrets: The duke is dead/);
    assert.match(bible, /SECRET: poisoner/);
    assert.match(bible, /→ 2\. Two/);
    assert.equal(renderBible(null), '');
    assert.match(renderPrepared(prepared()), /1\. if the player flees → Scouts spot the player on the roof/);
    assert.equal(renderPrepared(null), '');
});
