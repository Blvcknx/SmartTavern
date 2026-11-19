import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    parseKeywords, keywordsMatch, scanText, partitionByActivation, selectReplyFields, isUnchangedOutput,
    anchorIndex, previousFromMemory, estimateTokens, planTailBudget,
} from '../src/lean-core.js';

test('keywords: substrings are case-insensitive, /regex/flags entries are regexes, bad regexes are dropped', () => {
    assert.equal(parseKeywords('rain, /sto+rm/i\n  \n/a,b/\nfog,').length, 4);
    assert.equal(parseKeywords('/(/').length, 0);
    assert.equal(keywordsMatch('Rain', 'heavy rAIN'), true);
    assert.equal(keywordsMatch('/sto+rm/i', 'A STOOORM'), true);
    assert.equal(keywordsMatch('/^storm/', 'a storm'), false);
    assert.equal(keywordsMatch('/storm/gi', 'storm'), true);
    assert.equal(keywordsMatch('/storm/gi', 'storm'), true); // g/y ignored: no lastIndex state
    assert.equal(keywordsMatch('', 'anything'), false);
    assert.equal(keywordsMatch('/a,b/', 'a,b'), true);
});

test('scanText takes the last N non-system, non-injected messages', () => {
    const chat = [{ mes: 'one' }, { mes: 'sys', is_system: true }, { mes: 'two' }, { mes: 'tail', extra: { isSmartTavern: true } },
        { mes: 'eph', smarttavern_ephemeral: true }, { mes: '  ' }, { mes: 'three' }];
    assert.equal(scanText(chat, 2), 'two\nthree');
    assert.equal(scanText(chat, 99), 'one\ntwo\nthree');
    assert.equal(scanText(null, 2), '');
});

test('partitionByActivation gates keyword blocks only; planner blocks pass', () => {
    const steps = [{ name: 'A' }, { name: 'B', activation: 'keywords', keywords: 'fog' }, { name: 'C', activation: 'keywords' }, { name: 'D', activation: 'planner' }];
    const result = partitionByActivation(steps, 'dense Fog');
    assert.deepEqual(result.active.map(step => step.name), ['A', 'B', 'D']);
    assert.deepEqual(result.inactive, [{ name: 'C' }]);
});

test('selectReplyFields: always / never / relevant with planner, keywords and fail-open', () => {
    const fields = [{ name: 'A' }, { name: 'B', inject: 'never' }, { name: 'C', inject: 'relevant' },
        { name: 'D', inject: 'relevant', keywords: 'sea' }, { name: 'E', inject: 'relevant', keywords: '/^never$/' }];
    const names = options => selectReplyFields(fields, options).map(field => field.name);
    // Planner did not run: keyword-less relevant fields stay (fail open); keywords decide the others.
    assert.deepEqual(names({ recentText: 'x' }), ['A', 'C']);
    assert.deepEqual(names({ recentText: 'the SEA' }), ['A', 'C', 'D']);
    // Planner ran and answered: only listed (case-insensitive) or keyword-matched fields.
    assert.deepEqual(names({ plannerRan: true, plannerFields: ['d', 'E'], recentText: '' }), ['A', 'D', 'E']);
    assert.deepEqual(names({ plannerRan: true, plannerFields: [], recentText: 'sea' }), ['A', 'D']);
    // Planner ran but sent no field list, or failed: fail open again.
    assert.deepEqual(names({ plannerRan: true, plannerFields: null, recentText: '' }), ['A', 'C']);
    assert.deepEqual(names({ plannerRan: false, plannerFields: ['D'], recentText: '' }), ['A', 'C', 'D']);
    assert.deepEqual(selectReplyFields([{ name: 'Legacy' }]).map(field => field.name), ['Legacy']);
});

test('UNCHANGED detection', () => {
    for (const text of ['UNCHANGED', ' unchanged. ', 'Unchanged!!!', 'UNCHANGED —', '\nUNCHANGED\n']) assert.equal(isUnchangedOutput(text), true, text);
    for (const text of ['UNCHANGED, but tired', 'Not UNCHANGED', '', 'changed']) assert.equal(isUnchangedOutput(text), false, text);
});

test('step memory anchoring: valid for a later anchor on an unchanged message only', () => {
    const saved = [{ mes: 'Hello', is_user: true }, { mes: 'Hi' }, { mes: 'Next', is_user: true }];
    const entry = { text: 'Tired', sourceIndex: 0, sourceText: 'Hello' };
    assert.equal(anchorIndex(saved, [{ mes: 'Hello', is_user: true }, { mes: 'Hi' }, { mes: 'Next', is_user: true }]), 2);
    assert.equal(anchorIndex(saved, [{ mes: 'ghost' }]), -1);
    assert.equal(anchorIndex(saved, [{ mes: 'Hi' }, { mes: 'tail', smarttavern_ephemeral: true }]), 1);
    assert.equal(previousFromMemory(entry, saved, 2), 'Tired');
    assert.equal(previousFromMemory(entry, saved, 0), '');
    assert.equal(previousFromMemory({ ...entry, sourceText: 'Edited' }, saved, 2), '');
    assert.equal(previousFromMemory({ ...entry, sourceIndex: 9 }, saved, 12), '');
    assert.equal(previousFromMemory(null, saved, 2), '');
});

test('planTailBudget drops whole sections, lowest priority first, later first on ties, never required ones', () => {
    const sections = [
        { id: 'fixed', tokens: 30, required: true }, { id: 'a', tokens: 50, priority: 50 }, { id: 'b', tokens: 50, priority: 50 },
        { id: 'profile', tokens: 40, priority: 60 }, { id: 'brief', tokens: 20, priority: 90 }, { id: 'directive', tokens: 25, required: true },
    ];
    assert.deepEqual(planTailBudget(sections, 0), { keep: sections.map(section => section.id), dropped: [], tokens: 215 });
    assert.deepEqual(planTailBudget(sections, 215).dropped, []);
    assert.deepEqual(planTailBudget(sections, 200).dropped, ['b']);
    assert.deepEqual(planTailBudget(sections, 150).dropped, ['a', 'b']);
    assert.deepEqual(planTailBudget(sections, 100).dropped, ['a', 'b', 'profile']);
    const floor = planTailBudget(sections, 1);
    assert.deepEqual(floor.keep, ['fixed', 'directive']);
    assert.equal(floor.tokens, 55);
    assert.equal(planTailBudget([{ id: 'x', tokens: 0, priority: 0 }, { id: 'y', tokens: 9, priority: 1 }], 5).dropped.join(), 'y');
    assert.equal(estimateTokens('x'.repeat(35)), 10);
    assert.equal(estimateTokens(''), 0);
});
