// Story Director pure-core tests (node --test). story-core.js has no SillyTavern
// imports, so these run under plain Node with no stubs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    normalizeBible, validateBeat, compileDirective, selectRung, pushFact,
    rearmPending, chapterIndexAt, wordCount, wordTrim,
    BEAT_MAX_WORDS, BEAT_FACT_MAX_WORDS, LEDGER_MAX_FACTS, DIRECTIVE_DEFAULT_MAX_WORDS,
} from '../src/story-core.js';

// Distinctive markers so leak tests cannot pass by coincidence.
const SECRET_MARKER = 'BIBLE-SECRET-MARKER-xyz';
const CAST_SECRET_MARKER = 'CAST-SECRET-MARKER-abc';
const FUTURE_CHAPTER_MARKER = 'FUTURE-CHAPTER-MARKER-qrs';

function fixtureStory(overrides = {}) {
    return {
        v: 1,
        chapterIndex: 0,
        turnsSinceDelivery: 0,
        ledger: ['The archive closed at dusk.', 'Mara took the ledger key.'],
        beat: {
            text: 'Mara slams the ledger key onto the desk and demands the night off.',
            escalations: [
                'Mara locks the archive early and pockets the only key.',
                'The archive alarm goes off and Mara is nowhere to be found.',
            ],
            fact: 'Mara demanded the night off.',
            status: 'pending',
            rung: 0,
            deliveredAtMsg: null,
        },
        bible: {
            title: 'The Night Ledger',
            premise: 'A new hire discovers the archive hides a ledger of debts.',
            setting: 'A rain-soaked harbor town, late autumn.',
            tone: 'slow-burn thriller',
            conflict: 'Loyalty to Mara versus the truth in the ledger.',
            secrets: `The ledger names ${SECRET_MARKER} as the town's true creditor.`,
            cast: [
                { name: 'Mara', role: 'archivist', wants: 'to protect her sister', secret: `Mara forged ${CAST_SECRET_MARKER} entries.` },
                { name: 'Ilse', role: 'harbor clerk', wants: 'a way out of town', secret: 'Ilse sold the ledger key once.' },
            ],
            chapters: [
                {
                    title: 'The New Hire',
                    situation: 'The first night shift alone with Mara.',
                    goal: 'Earn Mara\u2019s trust.',
                    exit: 'The ledger key changes hands.',
                    clues: 'A burnt page in the waste bin.',
                },
                {
                    title: 'Quiet Debts',
                    situation: `A creditor's letter mentions ${FUTURE_CHAPTER_MARKER}.`,
                    goal: 'Trace the letter.',
                    exit: 'Ilse boards the night ferry.',
                    clues: 'Wax seal with a harbor stamp.',
                },
            ],
        },
        seed: '',
        createdAt: 0,
        ...overrides,
    };
}

// --------------------------------------------------------------------------------------------
// compileDirective — three states
// --------------------------------------------------------------------------------------------

test('compileDirective: PENDING state musts the beat text', () => {
    const story = fixtureStory();
    const directive = compileDirective(story, { char: 'Mara', user: 'Sam', idleTurns: 3 });
    assert.ok(directive);
    assert.equal(directive.state, 'pending');
    assert.equal(directive.must, story.beat.text);
    assert.match(directive.text, /\[SCENE DIRECTIVE — highest priority for this reply\]/);
    assert.match(directive.text, /Story: The Night Ledger · Chapter 1\/2: The New Hire · Tone: slow-burn thriller/);
    assert.match(directive.text, /So far:/);
    assert.match(directive.text, /- Mara took the ledger key\./);
    assert.match(directive.text, /THIS REPLY MUST SHOW, in Mara's own voice and within its first half:/);
    assert.match(directive.text, new RegExp(`→ ${story.beat.text}`));
    assert.match(directive.text, /End the reply with Mara waiting on Sam's response or decision\./);
    assert.match(directive.text, /Never write Sam's actions, words or feelings\./);
    assert.match(directive.text, /\[END DIRECTIVE\]/);
});

test('compileDirective: STEADY state keeps developing the chapter situation', () => {
    const story = fixtureStory({
        beat: { ...fixtureStory().beat, status: 'delivered', deliveredAtMsg: 4 },
        turnsSinceDelivery: 2,
    });
    const directive = compileDirective(story, { char: 'Mara', user: 'Sam', idleTurns: 3 });
    assert.ok(directive);
    assert.equal(directive.state, 'steady');
    assert.equal(directive.must, null);
    assert.match(directive.text, /Keep developing: The first night shift alone with Mara\./);
    assert.match(directive.text, /Let the cast act on their own goals\. Do not repeat events listed above\./);
    assert.doesNotMatch(directive.text, /THIS REPLY MUST SHOW/);
});

test('compileDirective: ESCALATE state musts the rung escalation', () => {
    const base = fixtureStory();
    const story = fixtureStory({
        beat: { ...base.beat, status: 'delivered', deliveredAtMsg: 4 },
        turnsSinceDelivery: 3, // at the threshold → rung 0 escalation
    });
    let directive = compileDirective(story, { char: 'Mara', user: 'Sam', idleTurns: 3 });
    assert.equal(directive.state, 'escalate');
    assert.equal(directive.must, base.beat.escalations[0]);
    assert.match(directive.text, new RegExp(`→ ${base.beat.escalations[0]}`));

    story.turnsSinceDelivery = 6; // one further idle stretch → rung 1
    directive = compileDirective(story, { char: 'Mara', user: 'Sam', idleTurns: 3 });
    assert.equal(directive.state, 'escalate');
    assert.equal(directive.must, base.beat.escalations[1]);
    assert.match(directive.text, new RegExp(`→ ${base.beat.escalations[1]}`));
});

test('compileDirective: stays under the word cap, shedding ledger lines first', () => {
    const longFact = 'word '.repeat(20).trim(); // each ledger line alone is 20 words
    const story = fixtureStory({
        ledger: Array.from({ length: 6 }, (_, i) => `${longFact} #${i}`),
    });
    const directive = compileDirective(story, { char: 'Mara', user: 'Sam', idleTurns: 3, maxWords: 90 });
    assert.ok(directive);
    assert.ok(wordCount(directive.text) <= 90, `expected <= 90 words, got ${wordCount(directive.text)}`);
    // The frame and the MUST block survive; ledger lines are the sacrificial part.
    assert.match(directive.text, /THIS REPLY MUST SHOW/);
    assert.match(directive.text, /The Night Ledger/);
});

test('compileDirective: no beat or no bible yields null', () => {
    assert.equal(compileDirective(null), null);
    assert.equal(compileDirective({ bible: null }), null);
    const beatless = fixtureStory({ beat: null });
    assert.equal(compileDirective(beatless), null);
});

test('compileDirective: char/user names fall back when empty', () => {
    const directive = compileDirective(fixtureStory(), {});
    assert.ok(directive);
    assert.match(directive.text, /in the character's own voice/);
    assert.match(directive.text, /waiting on the user's response/);
});

// --------------------------------------------------------------------------------------------
// The directive NEVER leaks Director-only material
// --------------------------------------------------------------------------------------------

for (const state of ['pending', 'steady', 'escalate']) {
    test(`leak guard (${state}): directive contains no secrets and no future chapter text`, () => {
        const base = fixtureStory();
        const story = state === 'pending'
            ? base
            : fixtureStory({
                beat: { ...base.beat, status: 'delivered', deliveredAtMsg: 4 },
                turnsSinceDelivery: state === 'escalate' ? 30 : 0,
            });
        const directive = compileDirective(story, { char: 'Mara', user: 'Sam', idleTurns: 3 });
        assert.ok(directive);
        assert.ok(!directive.text.includes(SECRET_MARKER), 'bible secrets leaked');
        assert.ok(!directive.text.includes(CAST_SECRET_MARKER), 'cast secret leaked');
        assert.ok(!directive.text.includes(FUTURE_CHAPTER_MARKER), 'future chapter text leaked');
        // Never any cast secret field, even without a marker.
        for (const member of story.bible.cast) {
            if (member.secret) assert.ok(!directive.text.includes(member.secret));
        }
        // Never another chapter's situation.
        for (const [index, chapter] of story.bible.chapters.entries()) {
            if (index === directive.chapterIndex) continue;
            assert.ok(!directive.text.includes(chapter.situation), `chapter ${index + 1} situation leaked`);
            assert.ok(!directive.text.includes(chapter.title), `chapter ${index + 1} title leaked`);
        }
    });
}

test('leak guard: a later chapter directive never names earlier chapter situations either', () => {
    const base = fixtureStory();
    const story = fixtureStory({
        chapterIndex: 1,
        beat: { ...base.beat, status: 'delivered', deliveredAtMsg: 9 },
        turnsSinceDelivery: 0,
    });
    const directive = compileDirective(story, { char: 'Mara', user: 'Sam', idleTurns: 3 });
    assert.equal(directive.state, 'steady');
    assert.match(directive.text, /Chapter 2\/2: Quiet Debts/);
    assert.ok(!directive.text.includes(story.bible.chapters[0].situation));
});

// --------------------------------------------------------------------------------------------
// Idle clock / rung selection
// --------------------------------------------------------------------------------------------

test('selectRung: threshold, progression and clamping', () => {
    assert.equal(selectRung(0, 3), 0);
    assert.equal(selectRung(2, 3), 0);
    assert.equal(selectRung(3, 3), 0); // at the threshold the first escalation fires
    assert.equal(selectRung(4, 3), 0);
    assert.equal(selectRung(6, 3), 1); // one further stretch → rung 1
    assert.equal(selectRung(30, 3), 1); // clamped (two escalations)
    assert.equal(selectRung(30, 3, 5), 5); // explicit clamp
    assert.equal(selectRung(10, 0), 0); // invalid idle → rung 0
    assert.equal(selectRung(-4, 3), 0);
});

test('pushFact: appends and caps the ledger at 6, dropping the oldest', () => {
    const ledger = [];
    for (let i = 1; i <= 8; i++) pushFact(ledger, `fact ${i}`);
    assert.equal(ledger.length, LEDGER_MAX_FACTS);
    assert.deepEqual(ledger, ['fact 3', 'fact 4', 'fact 5', 'fact 6', 'fact 7', 'fact 8']);
    assert.equal(pushFact(ledger, ''), 6); // empty facts are ignored
    assert.equal(ledger.length, 6);
    const custom = [];
    pushFact(custom, 'a', 2);
    pushFact(custom, 'b', 2);
    pushFact(custom, 'c', 2);
    assert.deepEqual(custom, ['b', 'c']);
});

// --------------------------------------------------------------------------------------------
// Beat validation (the Director's generateWithRetry gate)
// --------------------------------------------------------------------------------------------

const goodBeat = () => ({
    text: 'Mara slams the ledger key onto the desk and demands the night off.',
    escalations: ['Mara locks the archive early.', 'The archive alarm goes off.'],
    fact: 'Mara demanded the night off.',
});

test('validateBeat: accepts a well-formed beat naming the cast', () => {
    assert.deepEqual(validateBeat(goodBeat(), { castNames: ['Mara', 'Ilse'] }), []);
    assert.deepEqual(validateBeat(goodBeat(), {}), []); // no cast → no name requirement
});

test('validateBeat: rejects empty and over-long beats', () => {
    const empty = validateBeat({ text: '', escalations: [], fact: '' }, {});
    assert.ok(empty.some(i => i.includes('empty')));
    assert.ok(empty.some(i => i.includes('escalation')));
    const long = goodBeat();
    long.text = 'word '.repeat(BEAT_MAX_WORDS + 1).trim();
    const issues = validateBeat(long, {});
    assert.ok(issues.some(i => i.includes(`exceeds ${BEAT_MAX_WORDS} words`)));
});

test('validateBeat: rejects a beat that names no cast member when a cast exists', () => {
    const beat = goodBeat();
    beat.text = 'A stranger arrives with a sealed letter and reads it aloud.';
    const issues = validateBeat(beat, { castNames: ['Mara', 'Ilse'] });
    assert.ok(issues.some(i => i.includes('cast member')));
    // Naming any member passes — case-insensitively.
    beat.text = 'ILSE countersigns the manifest without looking up.';
    assert.deepEqual(validateBeat(beat, { castNames: ['Mara', 'Ilse'] }), []);
});

test('validateBeat: rejects a fact over 15 words and missing escalations', () => {
    const beat = goodBeat();
    beat.fact = 'fact '.repeat(BEAT_FACT_MAX_WORDS + 1).trim();
    assert.ok(validateBeat(beat, {}).some(i => i.includes(`fact exceeds ${BEAT_FACT_MAX_WORDS}`)));
    const oneEscalation = goodBeat();
    oneEscalation.escalations = ['Only one fallback.'];
    assert.ok(validateBeat(oneEscalation, {}).some(i => i.includes('Two escalation')));
});

// --------------------------------------------------------------------------------------------
// Swipe / regenerate re-arm
// --------------------------------------------------------------------------------------------

test('rearmPending: re-arms only the exact delivered message and pops its fact', () => {
    const base = fixtureStory();
    const story = fixtureStory({
        ledger: ['The archive closed at dusk.', base.beat.fact, 'Ilse left early.'],
        beat: { ...base.beat, status: 'delivered', deliveredAtMsg: 7, rung: 1 },
        turnsSinceDelivery: 5,
    });
    assert.equal(rearmPending(story, 7), true);
    assert.equal(story.beat.status, 'pending');
    assert.equal(story.beat.deliveredAtMsg, null);
    assert.equal(story.beat.rung, 0);
    assert.equal(story.turnsSinceDelivery, 0);
    assert.deepEqual(story.ledger, ['The archive closed at dusk.', 'Ilse left early.']);
});

test('rearmPending: other message indices and pending beats are untouched', () => {
    const base = fixtureStory();
    const deliveredElsewhere = fixtureStory({
        beat: { ...base.beat, status: 'delivered', deliveredAtMsg: 3 },
        ledger: [base.beat.fact],
    });
    assert.equal(rearmPending(deliveredElsewhere, 9), false);
    assert.equal(deliveredElsewhere.beat.status, 'delivered');
    assert.equal(deliveredElsewhere.beat.deliveredAtMsg, 3);
    assert.deepEqual(deliveredElsewhere.ledger, [base.beat.fact]);

    const stillPending = fixtureStory(); // status pending, deliveredAtMsg null
    assert.equal(rearmPending(stillPending, 0), false);
    assert.equal(stillPending.beat.status, 'pending');
});

// --------------------------------------------------------------------------------------------
// Bible normalization + small helpers
// --------------------------------------------------------------------------------------------

test('normalizeBible: repairs a valid payload and drops junk entries', () => {
    const bible = normalizeBible({
        title: '  The Night Ledger  ',
        tone: 'thriller',
        chapters: [
            { title: 'One', situation: 'First night.', junk: true },
            null,
            { situation: 'No title but a situation.' },
            { title: '', situation: '' }, // dropped: nothing usable
        ],
        cast: [{ name: 'Mara', role: 'archivist' }, { role: 'no name' }],
    });
    assert.ok(bible);
    assert.equal(bible.title, 'The Night Ledger');
    assert.equal(bible.chapters.length, 2);
    assert.equal(bible.cast.length, 1);
    assert.equal(bible.cast[0].secret, ''); // secrets normalized to strings
});

test('normalizeBible: null on garbage or a chapter-less payload', () => {
    assert.equal(normalizeBible(null), null);
    assert.equal(normalizeBible('text'), null);
    assert.equal(normalizeBible({ title: 'No chapters', chapters: [] }), null);
    assert.equal(normalizeBible({ chapters: [{ title: '', situation: ' ' }] }), null);
});

test('chapterIndexAt: clamps and returns -1 without chapters', () => {
    assert.equal(chapterIndexAt(fixtureStory()), 0);
    assert.equal(chapterIndexAt(fixtureStory({ chapterIndex: 99 })), 1);
    assert.equal(chapterIndexAt(fixtureStory({ chapterIndex: -3 })), 0);
    assert.equal(chapterIndexAt({ bible: { chapters: [] } }), -1);
    assert.equal(chapterIndexAt(null), -1);
});

test('wordTrim and wordCount', () => {
    assert.equal(wordCount(''), 0);
    assert.equal(wordCount(null), 0);
    assert.equal(wordCount('one two  three\n\nfour'), 4);
    assert.equal(wordTrim('a b c d e', 3), 'a b c');
    assert.equal(wordTrim('a b', 5), 'a b'); // under the cap → unchanged
    assert.equal(wordTrim('', 3), '');
    assert.equal(wordTrim('a b c d e', 0), '');
    // The default directive cap is a sane hard ceiling.
    assert.ok(DIRECTIVE_DEFAULT_MAX_WORDS >= 60 && DIRECTIVE_DEFAULT_MAX_WORDS <= 400);
});
