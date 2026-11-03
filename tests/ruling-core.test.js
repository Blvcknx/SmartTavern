// SmartTavern — unit tests for the character-ruling ledger's pure core (ruling-core.js).
// Run: node --test tests/   (from the extension root)
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
    tokenize, cleanKeys, normalizeRuling, validateOracleAnswer,
    reuseScore, surfaceScore, selectRulings, reuseCandidate,
    applySupersede, enforceCap, expireTentative, promoteOnUse,
    RULING_MAX_WORDS,
} from '../src/ruling-core.js';

const EXCLUDE = new Set(['mara', 'user']);

const baseRuling = {
    id: 1,
    subject: 'mara.png',
    question: 'How does Mara react when asked about her past?',
    ruling: 'When pressed about her past, Mara deflects with humor and goes cold if asked twice.',
    keys: ['past', 'secrets', 'deflection'],
    confidence: 'high',
    status: 'active',
    pinned: false,
    uses: 0,
    atMsg: 4,
    createdAt: 1000,
    supersedes: null,
    source: 'oracle',
};

const sorted = tokens => [...tokens].sort();

// --------------------------------------------------------------------------------------------
// tokenize
// --------------------------------------------------------------------------------------------

test('tokenize: stopwords out, light stemming in', () => {
    const tokens = sorted(tokenize('The guards are asking about her past'));
    assert.deepEqual(tokens, ['ask', 'guard', 'past']);
});

test('tokenize: -s/-es only strip above four characters (asks is kept, asked/asking collapse)', () => {
    assert.deepEqual(sorted(tokenize('asks asked asking')), ['ask', 'asks']);
});

test('tokenize: CJK runs yield single characters plus bigrams', () => {
    const tokens = tokenize('她提到过去');
    for (const single of ['她', '提', '到', '过', '去']) assert.ok(tokens.includes(single), `missing ${single}`);
    for (const gram of ['她提', '提到', '到过', '过去']) assert.ok(tokens.includes(gram), `missing ${gram}`);
});

test('tokenize: the exclude set removes name tokens (raw and stemmed)', () => {
    assert.deepEqual(sorted(tokenize('Mara keeps her own past', { exclude: EXCLUDE })), ['keep', 'past']);
    assert.ok(!tokenize('maras secrets', { exclude: EXCLUDE }).includes('mara'));
});

// --------------------------------------------------------------------------------------------
// cleanKeys / normalizeRuling / validateOracleAnswer
// --------------------------------------------------------------------------------------------

test('cleanKeys: lowercases, dedupes, drops name keys and caps at six', () => {
    const keys = cleanKeys(['Past', 'past', 'Mara', 'secrets', 'temper', 'flattery', 'money', 'sleep'], { exclude: EXCLUDE });
    assert.deepEqual(keys, ['past', 'secrets', 'temper', 'flattery', 'money', 'sleep']);
});

test('cleanKeys: a key made only of excluded tokens dies', () => {
    assert.deepEqual(cleanKeys(['Mara', 'mara'], { exclude: EXCLUDE }), []);
});

test('normalizeRuling: word cap, canonical fields, unknown fields dropped', () => {
    const long = 'she deflects '.repeat(12).trim(); // 24 words → x3 padding below
    const seventyWord = Array.from({ length: 70 }, (_, i) => `word${i}`).join(' ');
    const record = normalizeRuling({
        question: '  How does she react to flattery?  ',
        ruling: seventyWord,
        keys: ['flattery', 'Temper', 'flattery'],
        confidence: 'high',
        nonsense: 'dropped',
    }, { id: 7, subject: 'mara.png', now: 1234, atMsg: 9, exclude: EXCLUDE });
    assert.ok(record);
    assert.equal(record.id, 7);
    assert.equal(record.question, 'How does she react to flattery?');
    assert.equal(record.ruling.split(/\s+/).length, RULING_MAX_WORDS);
    assert.deepEqual(record.keys, ['flattery', 'temper']);
    assert.deepEqual(Object.keys(record).sort(), [
        'atMsg', 'confidence', 'createdAt', 'id', 'keys', 'pinned', 'question',
        'ruling', 'source', 'status', 'subject', 'supersedes', 'uses',
    ]);
    assert.equal(record.atMsg, 9);
    assert.equal(record.createdAt, 1234);
    assert.equal(record.status, 'active');
    assert.equal(record.source, 'oracle');
    assert.ok(!record.ruling.includes(long || 'x')); // sanity only
});

test('normalizeRuling: fewer than two usable keys return null', () => {
    assert.equal(normalizeRuling({ ruling: 'She deflects.', keys: ['Mara', 'mara'] }, { exclude: EXCLUDE }), null);
    assert.equal(normalizeRuling({ ruling: 'She deflects.', keys: ['past'] }, { exclude: EXCLUDE }), null);
});

test('validateOracleAnswer: happy path has no issues', () => {
    assert.deepEqual(validateOracleAnswer({
        ruling: 'When pressed about her past, Mara deflects with humor.',
        confidence: 'high',
        keys: ['past', 'secrets'],
        supersedes: null,
    }, { exclude: EXCLUDE }), []);
    assert.deepEqual(validateOracleAnswer({
        ruling: 'She goes cold when asked twice.',
        confidence: 'low',
        keys: ['past', 'temper'],
        supersedes: 3,
    }, { exclude: EXCLUDE }), []);
});

test('validateOracleAnswer: word cap, placeholders, first person, keys, enum, supersedes type', () => {
    const seventyWords = Array.from({ length: 61 }, (_, i) => `w${i}`).join(' ');
    const issues = validateOracleAnswer({
        ruling: seventyWords, confidence: 'certain', keys: ['Mara', 'past'], supersedes: '3',
    }, { exclude: EXCLUDE });
    assert.ok(issues.some(text => text.includes('words')));
    assert.ok(issues.some(text => text.includes('first person')) === false); // not triggered here
    assert.ok(issues.some(text => text.includes('keys')));
    assert.ok(issues.some(text => text.includes('confidence')));
    assert.ok(issues.some(text => text.includes('supersedes')));

    assert.ok(validateOracleAnswer({ ruling: 'She uses {{char}} tricks.', confidence: 'high', keys: ['a', 'b'] }, { exclude: EXCLUDE })
        .some(text => text.includes('{{')));
    assert.ok(validateOracleAnswer({ ruling: 'I usually deflect with humor.', confidence: 'high', keys: ['a', 'b'] }, { exclude: EXCLUDE })
        .some(text => text.includes('first-person')));
    assert.ok(validateOracleAnswer({ ruling: "We're never sure.", confidence: 'high', keys: ['a', 'b'] }, { exclude: EXCLUDE })
        .some(text => text.includes('first-person')));
    assert.deepEqual(validateOracleAnswer('junk', { exclude: EXCLUDE }), ['the answer is not a JSON object']);
});

// --------------------------------------------------------------------------------------------
// reuseScore
// --------------------------------------------------------------------------------------------

test('reuseScore: a paraphrase of the saved question clears the reuse threshold', () => {
    const score = reuseScore('How does Mara react if asked about her own past?', baseRuling, { exclude: EXCLUDE });
    assert.ok(score >= 0.6, `paraphrase scored ${score}`);
});

test('reuseScore: an unrelated question stays below 0.3', () => {
    const score = reuseScore('What weapon does the guard carry at the gate?', baseRuling, { exclude: EXCLUDE });
    assert.ok(score < 0.3, `unrelated scored ${score}`);
});

test('reuseScore: fewer than two strong matches cap the score at 0.3', () => {
    // 'deflect' and 'humor' hit only the ruling TEXT, never keys or the question.
    const score = reuseScore('Does she deflect with humor?', baseRuling, { exclude: EXCLUDE });
    assert.equal(score, 0.3);
});

test('reuseScore: empty queries and empty records score zero', () => {
    assert.equal(reuseScore('', baseRuling, { exclude: EXCLUDE }), 0);
    assert.equal(reuseScore('anything at all', null, { exclude: EXCLUDE }), 0);
});

// --------------------------------------------------------------------------------------------
// surfaceScore
// --------------------------------------------------------------------------------------------

test('surfaceScore: fraction of keys fully present in the context', () => {
    const ruling = { ...baseRuling, keys: ['past', 'secrets', 'old mill'] };
    assert.equal(surfaceScore('She asked about the past and the secrets of the old mill', ruling, { exclude: EXCLUDE }), 1);
    assert.equal(surfaceScore('She asked about the old tower', ruling, { exclude: EXCLUDE }), 0);
    // multi-word keys need ALL their tokens — 'old' alone is not 'old mill'
    assert.ok(Math.abs(surfaceScore('The old door creaks; the past stays buried', ruling, { exclude: EXCLUDE }) - 1 / 3) < 1e-9);
    assert.equal(surfaceScore('weather is fine today', ruling, { exclude: EXCLUDE }), 0);
    assert.equal(surfaceScore('past secrets old mill', { ...baseRuling, keys: [] }, { exclude: EXCLUDE }), 0);
});

// --------------------------------------------------------------------------------------------
// selectRulings
// --------------------------------------------------------------------------------------------

test('selectRulings: subject + status filtering, k limit, deterministic ranking', () => {
    const other = { ...baseRuling, id: 9, subject: 'bob.png', ruling: 'OTHER-SUBJECT-SECRET-MARKER' };
    const tentative = { ...baseRuling, id: 2, status: 'tentative' };
    const superseded = { ...baseRuling, id: 3, status: 'superseded' };
    const lowScore = { ...baseRuling, id: 4, keys: ['past', 'secrets', 'unobtainium'] };
    const pinnedNew = { ...baseRuling, id: 5, pinned: true, createdAt: 5000, uses: 7 };
    const context = 'She asked about the past and the secrets came up';
    const picked = selectRulings([other, tentative, superseded, lowScore, pinnedNew, baseRuling], context, { subject: 'mara.png', k: 2, exclude: EXCLUDE });
    // baseRuling and pinnedNew both score 1.0; pinned wins the tie; then id 1.
    assert.deepEqual(picked.map(record => record.id), [5, 1]);
    assert.ok(!picked.some(record => record.ruling.includes('OTHER-SUBJECT-SECRET-MARKER')));
    // k applies after ranking
    assert.equal(selectRulings([pinnedNew, baseRuling], context, { subject: 'mara.png', k: 1, exclude: EXCLUDE }).length, 1);
    // minScore default 0.34 excludes weak partial matches (1 of 3 keys = 0.33)
    const weak = selectRulings([lowScore], 'She asked about the past quietly', { subject: 'mara.png', k: 5, exclude: EXCLUDE });
    assert.equal(weak.length, 0);
});

test('selectRulings: ties break by uses, then newest, then lowest id', () => {
    const context = 'the past and the secrets again';
    const older = { ...baseRuling, id: 1, createdAt: 100, uses: 3 };
    const newerMoreUses = { ...baseRuling, id: 2, createdAt: 200, uses: 9 };
    const sameAsTwo = { ...baseRuling, id: 3, createdAt: 200, uses: 9 };
    assert.deepEqual(
        selectRulings([older, newerMoreUses, sameAsTwo], context, { subject: 'mara.png', k: 3, exclude: EXCLUDE }).map(r => r.id),
        [2, 3, 1],
    );
});

// --------------------------------------------------------------------------------------------
// reuseCandidate
// --------------------------------------------------------------------------------------------

test('reuseCandidate: threshold and the active+tentative status set', () => {
    const question = 'How does Mara react if asked about her own past?';
    const found = reuseCandidate([baseRuling], question, { subject: 'mara.png', threshold: 0.6, exclude: EXCLUDE });
    assert.equal(found.ruling.id, 1);
    assert.ok(found.score >= 0.6);
    // below threshold → null even though the text overlaps
    assert.equal(reuseCandidate([baseRuling], 'Does she deflect with humor?', { subject: 'mara.png', threshold: 0.6, exclude: EXCLUDE }), null);
    // superseded is never a candidate; tentative is
    assert.equal(reuseCandidate([{ ...baseRuling, status: 'superseded' }], question, { subject: 'mara.png', threshold: 0.6, exclude: EXCLUDE }), null);
    assert.equal(reuseCandidate([{ ...baseRuling, id: 6, status: 'tentative' }], question, { subject: 'mara.png', threshold: 0.6, exclude: EXCLUDE }).ruling.id, 6);
    // subject must match
    assert.equal(reuseCandidate([baseRuling], question, { subject: 'bob.png', threshold: 0.6, exclude: EXCLUDE }), null);
});

// --------------------------------------------------------------------------------------------
// applySupersede / enforceCap / expireTentative / promoteOnUse
// --------------------------------------------------------------------------------------------

test('applySupersede: marks the target unless pinned, missing or foreign-subject', () => {
    const rulings = () => [
        { ...baseRuling, id: 1 },
        { ...baseRuling, id: 2, pinned: true },
        { ...baseRuling, id: 3, subject: 'bob.png' },
        { ...baseRuling, id: 10 }, // the fresh replacement, same subject
    ];
    const hit = applySupersede(rulings(), 10, 1);
    assert.equal(hit.superseded.status, 'superseded');
    assert.equal(hit.rulings.find(r => r.id === 1).status, 'superseded');
    assert.equal(hit.rulings.find(r => r.id === 2).status, 'active');
    assert.equal(hit.rulings.find(r => r.id === 10).status, 'active');
    assert.equal(applySupersede(rulings(), 10, 2).superseded, null); // pinned
    assert.equal(applySupersede(rulings(), 10, 3).superseded, null); // other subject
    assert.equal(applySupersede(rulings(), 10, 99).superseded, null); // missing
    assert.equal(applySupersede(rulings(), 10, null).superseded, null);
    // already superseded stays untouched
    const second = applySupersede([...hit.rulings, { ...baseRuling, id: 11 }], 11, 1);
    assert.equal(second.superseded, null);
    assert.equal(second.rulings.find(r => r.id === 1).status, 'superseded');
});

test('enforceCap: superseded first, then tentative, then lowest uses/oldest unpinned active', () => {
    const mk = (id, status, uses, createdAt) => ({ ...baseRuling, id, status, uses, createdAt });
    const rulings = [
        mk(1, 'active', 5, 100),   // survives
        mk(2, 'superseded', 0, 50), // evicted first
        mk(3, 'tentative', 0, 60),  // evicted second
        mk(4, 'active', 2, 40),     // oldest low-uses active — evicted third
        mk(5, 'active', 2, 70),     // survives
    ];
    const { kept, evicted } = enforceCap(rulings, 2);
    assert.deepEqual(evicted.map(r => r.id), [2, 3, 4]);
    assert.deepEqual(kept.map(r => r.id).sort(), [1, 5]);
});

test('enforceCap: pinned rulings are never evicted, even alone over the cap', () => {
    const pinned = { ...baseRuling, id: 1, pinned: true };
    const { kept, evicted } = enforceCap([pinned, { ...baseRuling, id: 2, pinned: true }], 1);
    assert.equal(evicted.length, 0);
    assert.equal(kept.length, 2);
});

test('expireTentative: ttl overrun and rewind expire tentative only', () => {
    const mk = (id, status, atMsg) => ({ ...baseRuling, id, status, atMsg });
    const { kept, expired } = expireTentative([
        mk(1, 'tentative', 10), // 40 - 10 = 30 ≤ 30 → kept
        mk(2, 'tentative', 9),  // 40 - 9 = 31 > 30 → expired
        mk(3, 'tentative', 50), // chatLength < atMsg → rewound → expired
        mk(4, 'active', 50),    // active never auto-expires
        mk(5, 'active', 0),     // ancient but active
    ], { chatLength: 40 });
    assert.deepEqual(expired.map(r => r.id), [2, 3]);
    assert.deepEqual(kept.map(r => r.id), [1, 4, 5]);
    assert.deepEqual(expireTentative([mk(1, 'tentative', 0)], { chatLength: 5, ttl: 5 }).kept.map(r => r.id), [1]);
    assert.deepEqual(expireTentative([mk(1, 'tentative', 0)], { chatLength: 6, ttl: 5 }).expired.map(r => r.id), [1]);
});

test('promoteOnUse: tentative becomes active on its second use', () => {
    const once = { ...baseRuling, status: 'tentative', uses: 1 };
    assert.equal(promoteOnUse(once), once); // same reference, no promotion
    const twice = { ...baseRuling, status: 'tentative', uses: 2 };
    const promoted = promoteOnUse(twice);
    assert.notEqual(promoted, twice);
    assert.equal(promoted.status, 'active');
    const active = { ...baseRuling, status: 'active', uses: 9 };
    assert.equal(promoteOnUse(active), active);
});
