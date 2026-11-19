import test from 'node:test';
import assert from 'node:assert/strict';
import {
    resolveScene, renderScene, sortSceneEntries, sceneToObject, parseSceneOps, isValidSceneOutput,
    makeFact, upsertFact, compactFacts, filterSceneOps, lastAnchorIndex, withKeyToggled, isKeyInList,
    pushSceneLog, planUndo, buildTrackerPrompt, normalizeKey, MAX_TRACKER_OPS, EMPTY_SCENE_TEXT,
} from '../src/scene-core.js';

const fact = (key, value, sourceIndex, sourceText, extra = {}) => ({ key, value, evidence: '', sourceIndex, sourceText, by: 'tracker', at: 0, ...extra });
const plain = entries => ({ ...sceneToObject(entries) });
const chat = [{ mes: 'm0' }, { mes: 'm1' }, { mes: 'm2' }];

test('resolveScene applies facts in sourceIndex order regardless of storage order', () => {
    const facts = [fact('location', 'cellar', 2, 'm2'), fact('location', 'tavern', 0, 'm0'), fact('time', 'dusk', 1, 'm1')];
    const entries = resolveScene(facts, chat);
    assert.deepEqual(plain(entries), { location: 'cellar', time: 'dusk' });
});

test('resolveScene drops facts whose source message changed and restores older ones (rewind)', () => {
    const facts = [fact('location', 'tavern', 0, 'm0'), fact('location', 'cellar', 2, 'm2')];
    assert.equal(sceneToObject(resolveScene(facts, chat)).location, 'cellar');
    assert.equal(sceneToObject(resolveScene(facts, [chat[0], chat[1], { mes: 'm2 swiped' }])).location, 'tavern');
    assert.equal(sceneToObject(resolveScene(facts, chat.slice(0, 2))).location, 'tavern');
    assert.equal(sceneToObject(resolveScene(facts, [{ mes: 'other' }])).location, undefined);
});

test('resolveScene: empty value removes, later facts re-add, keys match case-insensitively with first-seen casing', () => {
    const facts = [fact('Alice.Position', 'door', 0, 'm0'), fact('alice.position', 'window', 1, 'm1')];
    let entries = resolveScene(facts, chat);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].key, 'Alice.Position');
    assert.equal(entries[0].value, 'window');
    facts.push(fact('ALICE.POSITION', '', 2, 'm2'));
    assert.deepEqual(resolveScene(facts, chat), []);
    facts.push(fact('alice.position', 'hall', 2, 'm2'));
    entries = resolveScene(facts, chat);
    assert.equal(entries[0].key, 'alice.position'); // removed, so the new casing starts fresh
});

test('resolveScene visible-chat filtering requires the source text in a non-system visible message', () => {
    const facts = [fact('location', 'tavern', 0, 'm0'), fact('time', 'dusk', 1, 'm1')];
    const visible = [{ mes: 'm0' }, { mes: 'm1', is_system: true }];
    assert.deepEqual(plain(resolveScene(facts, chat, visible)), { location: 'tavern' });
    assert.deepEqual(plain(resolveScene(facts, chat, null)), { location: 'tavern', time: 'dusk' });
});

test('resolveScene ignores malformed facts and keeps storage order within one message', () => {
    const facts = [null, { key: '', value: 'x', sourceIndex: 0, sourceText: 'm0' }, fact('a', 'x', 'bad', 'm0'),
        fact('a', 'first', 1, 'm1'), fact('a', 'second', 1, 'm1', { evidence: 'later' })];
    const entries = resolveScene(facts, chat);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].value, 'second');
});

test('maxFacts evicts the least recently set unpinned keys and never pinned ones', () => {
    const facts = ['a', 'b', 'c', 'd'].map((key, index) => fact(key, key.toUpperCase(), 0, 'm0', { at: index }));
    facts.push(fact('a', 'A2', 1, 'm1')); // 'a' becomes the most recently set
    const keys = entries => entries.map(entry => entry.key).sort();
    assert.deepEqual(keys(resolveScene(facts, chat, null, { maxFacts: 3 })), ['a', 'c', 'd']);
    assert.deepEqual(keys(resolveScene(facts, chat, null, { maxFacts: 2 })), ['a', 'd']);
    assert.deepEqual(keys(resolveScene(facts, chat, null, { maxFacts: 2, pinned: ['B'] })), ['a', 'b']);
    assert.deepEqual(keys(resolveScene(facts, chat, null, { maxFacts: 1, pinned: ['b', 'c'] })), ['b', 'c']); // pinned never evicted
    assert.equal(resolveScene(facts, chat, null, { maxFacts: 0 }).length, 4);
    // Eviction is a read-time view: a rewind that removes the newer fact changes the result.
    assert.deepEqual(keys(resolveScene(facts, chat.slice(0, 1), null, { maxFacts: 3 })), ['b', 'c', 'd']);
});

test('renderScene puts location, time, weather first, then keys alphabetically', () => {
    const entries = [{ key: 'Bob.mood', value: 'tense' }, { key: 'weather', value: 'rain' }, { key: 'alice.position', value: 'door' },
        { key: 'time', value: 'night' }, { key: 'Location', value: 'inn' }];
    assert.equal(renderScene(entries), 'Location: inn\ntime: night\nweather: rain\nalice.position: door\nBob.mood: tense');
    assert.equal(renderScene([]), EMPTY_SCENE_TEXT);
    assert.equal(EMPTY_SCENE_TEXT, '(no scene facts yet)');
    assert.deepEqual(sortSceneEntries([{ key: 'b' }, { key: 'a' }]).map(entry => entry.key), ['a', 'b']);
});

test('parseSceneOps reads well-formed output', () => {
    const parsed = parseSceneOps('<set key="Alice.position">kneeling by the fire</set>\n<remove key="Alice.inventory"/>\n<set key="location">cellar</set>');
    assert.deepEqual(parsed.ops, [
        { op: 'set', key: 'Alice.position', value: 'kneeling by the fire' },
        { op: 'remove', key: 'Alice.inventory', value: '' },
        { op: 'set', key: 'location', value: 'cellar' },
    ]);
    assert.equal(parsed.none, false);
    assert.equal(isValidSceneOutput('<none/>'), true);
    assert.equal(parseSceneOps('<none/>').none, true);
    assert.equal(parseSceneOps('<NONE />').none, true);
    assert.equal(isValidSceneOutput('I think nothing changed.'), false);
    assert.equal(isValidSceneOutput(''), false);
});

test('parseSceneOps tolerates messy output', () => {
    const messy = [
        '<think>maybe <set key="ghost">x</set> and <none/></think>',
        'Sure! Here you go:',
        '```xml',
        "<set key='Bob.mood'>  wary,   watching\nthe door </set>",
        '<set key=time>late evening</set>',
        '<unknown foo="1">ignored</unknown>',
        '<set key="Alice.clothing">a green cloak',
        '<remove key=Bob.inventory>',
        '<set key="x" value="y"/>',
        '```',
    ].join('\n');
    const parsed = parseSceneOps(messy);
    assert.deepEqual(parsed.ops, [
        { op: 'set', key: 'Bob.mood', value: 'wary, watching the door' },
        { op: 'set', key: 'time', value: 'late evening' },
        { op: 'set', key: 'Alice.clothing', value: 'a green cloak' }, // unclosed: salvaged to end of line
        { op: 'remove', key: 'Bob.inventory', value: '' },
        { op: 'set', key: 'x', value: 'y' },
    ]);
    assert.equal(parsed.none, false); // the <none/> inside <think> does not count
});

test('parseSceneOps: later op for a key wins, empty set is a removal, entities decode, ops are capped', () => {
    assert.deepEqual(parseSceneOps('<set key="a">1</set><set key="A">2</set><set key="b"></set>').ops,
        [{ op: 'set', key: 'A', value: '2' }, { op: 'remove', key: 'b', value: '' }]);
    assert.equal(parseSceneOps('<set key="a">Tom &amp; Jerry &quot;ok&quot;</set>').ops[0].value, 'Tom & Jerry "ok"');
    const many = Array.from({ length: 30 }, (_, index) => `<set key="k${index}">v</set>`).join('\n');
    const parsed = parseSceneOps(many);
    assert.equal(parsed.ops.length, MAX_TRACKER_OPS);
    assert.equal(parsed.truncated, true);
    assert.equal(MAX_TRACKER_OPS, 12);
    assert.deepEqual(parseSceneOps('<set>no key</set>').ops, []);
});

test('filterSceneOps separates locked keys and no-op changes', () => {
    const entries = [{ key: 'Location', value: 'Inn' }, { key: 'time', value: 'dusk' }];
    const ops = [{ op: 'set', key: 'LOCATION', value: 'inn' }, { op: 'set', key: 'time', value: 'night' }, { op: 'remove', key: 'weather' },
        { op: 'set', key: 'Alice.mood', value: 'calm' }, { op: 'remove', key: 'TIME' }];
    const result = filterSceneOps(ops, entries, ['time']);
    assert.deepEqual(result.apply.map(op => op.key), ['Alice.mood']);
    assert.deepEqual(result.locked.map(op => op.key), ['time', 'TIME']);
    assert.deepEqual(result.unchanged.map(op => op.key), ['LOCATION', 'weather']);
});

test('fact helpers: upsert replaces the same key and revision, compaction drops dead facts first', () => {
    const facts = [];
    upsertFact(facts, makeFact({ key: ' Alice.position ', value: 'door', sourceIndex: 0, sourceText: 'm0', by: 'agent' }));
    upsertFact(facts, makeFact({ key: 'alice.position', value: 'window', sourceIndex: 0, sourceText: 'm0', by: 'bogus' }));
    upsertFact(facts, makeFact({ key: 'alice.position', value: 'hall', sourceIndex: 1, sourceText: 'm1' }));
    assert.deepEqual(facts.map(item => item.value), ['window', 'hall']);
    assert.equal(facts[0].by, 'agent'); // unknown author falls back to agent
    assert.equal(normalizeKey('  a   b '), 'a b');
    const big = [fact('a', '1', 5, 'gone'), fact('b', '2', 0, 'm0'), fact('c', '3', 1, 'm1')];
    compactFacts(big, chat, 2);
    assert.deepEqual(big.map(item => item.key), ['b', 'c']);
    compactFacts(big, chat, 1);
    assert.deepEqual(big.map(item => item.key), ['c']);
});

test('pin / lock list helpers and the anchor index', () => {
    let list = withKeyToggled([], ' Alice.position ', true);
    assert.deepEqual(list, ['Alice.position']);
    list = withKeyToggled(list, 'alice.POSITION', true);
    assert.deepEqual(list, ['alice.POSITION']);
    assert.equal(isKeyInList('ALICE.position', list), true);
    assert.deepEqual(withKeyToggled(list, 'Alice.Position', false), []);
    assert.equal(isKeyInList('', ['']), false);
    assert.equal(lastAnchorIndex([{ mes: 'a' }, { mes: 'b', is_system: true }, { mes: 'c', smarttavern_ephemeral: true }]), 0);
    assert.equal(lastAnchorIndex([{ mes: 'a', is_user: true }, { mes: 'b' }]), 1);
    assert.equal(lastAnchorIndex([]), -1);
});

test('undo log is capped and an undo is only planned while the scene still matches', () => {
    const log = [];
    for (let index = 0; index < 35; index++) pushSceneLog(log, { at: index, action: 'edit', changes: [] });
    assert.equal(log.length, 30);
    assert.equal(log[0].at, 5);
    const entry = { action: 'edit', changes: [{ key: 'Location', before: 'inn', after: 'cellar' }, { key: 'time', before: null, after: 'dusk' }] };
    const now = [{ key: 'location', value: 'cellar' }, { key: 'time', value: 'dusk' }];
    assert.deepEqual(planUndo(entry, now), [{ key: 'Location', value: 'inn' }, { key: 'time', value: '' }]);
    assert.equal(planUndo(entry, [{ key: 'location', value: 'attic' }, { key: 'time', value: 'dusk' }]), null);
    assert.equal(planUndo({ changes: [] }, now), null);
});

test('buildTrackerPrompt lists the scene with LOCKED marks, participants, conventions and messages', () => {
    const prompt = buildTrackerPrompt({
        entries: [{ key: 'location', value: 'inn' }, { key: 'Alice.mood', value: 'calm' }],
        locked: ['Location', 'weather'], names: ['Alice', 'User', 'Alice'], messages: 'Alice: Hello.',
    });
    assert.match(prompt, /location: inn {2}\[LOCKED\]/);
    assert.match(prompt, /Alice\.mood: calm\n/);
    assert.match(prompt, /LOCKED KEYS WITHOUT A VALUE[^\n]*\nweather/);
    assert.match(prompt, /PARTICIPANTS[^\n]*\nAlice, User\n/);
    assert.match(prompt, /<Name>\.position/);
    assert.match(prompt, /newest last\]\nAlice: Hello\./);
    assert.match(buildTrackerPrompt({ entries: [], messages: 'x' }), /\(no scene facts yet\)/);
});
