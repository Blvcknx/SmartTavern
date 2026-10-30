// SmartTavern — Story Director pure core. NO SillyTavern imports (precedent:
// refinement-checks.js): everything here is deterministic and unit-testable under
// `node --test`. All story-state logic that does not need ST lives in this file;
// story.js owns storage, prompts and LLM calls.
//
// Core principle mirrored in the code: the reply model NEVER sees the bible. The
// directive assembled by compileDirective draws only from the current chapter's
// frame, the ledger and the beat — never from bible secrets, cast secrets or any
// chapter other than the current one.

export const BEAT_MAX_WORDS = 45;
export const BEAT_FACT_MAX_WORDS = 15;
export const LEDGER_MAX_FACTS = 6;
export const DIRECTIVE_LEDGER_LINES = 5;
export const DIRECTIVE_DEFAULT_MAX_WORDS = 140;

export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function wordCount(text) {
    const value = String(text ?? '').trim();
    return value ? value.split(/\s+/).length : 0;
}

/** Truncates to at most `maxWords` words on a word boundary (no trailing ellipsis). */
export function wordTrim(text, maxWords) {
    const value = String(text ?? '').trim();
    const cap = Math.max(0, Math.round(Number(maxWords) || 0));
    if (!value || wordCount(value) <= cap) return value;
    return value.split(/\s+/).slice(0, cap).join(' ');
}

// --------------------------------------------------------------------------------------------
// Bible / beat normalization
// --------------------------------------------------------------------------------------------

const asText = (value) => String(value ?? '').trim();

export function normalizeChapter(raw) {
    if (!isPlainObject(raw)) return null;
    const chapter = {
        title: asText(raw.title),
        situation: asText(raw.situation),
        goal: asText(raw.goal),
        exit: asText(raw.exit),
        clues: asText(raw.clues),
    };
    return (chapter.title || chapter.situation) ? chapter : null;
}

export function normalizeCastMember(raw) {
    if (!isPlainObject(raw)) return null;
    const member = {
        name: asText(raw.name),
        role: asText(raw.role),
        wants: asText(raw.wants),
        secret: asText(raw.secret),
    };
    return member.name ? member : null;
}

/**
 * Repairs a parsed story bible into its canonical shape. Returns null when there is
 * no usable chapter list (a bible without chapters cannot drive anything).
 */
export function normalizeBible(raw) {
    if (!isPlainObject(raw)) return null;
    const chapters = (Array.isArray(raw.chapters) ? raw.chapters : [])
        .map(normalizeChapter)
        .filter(Boolean);
    if (!chapters.length) return null;
    const cast = (Array.isArray(raw.cast) ? raw.cast : [])
        .map(normalizeCastMember)
        .filter(Boolean);
    return {
        title: asText(raw.title) || 'Untitled story',
        premise: asText(raw.premise),
        setting: asText(raw.setting),
        tone: asText(raw.tone),
        conflict: asText(raw.conflict),
        secrets: asText(raw.secrets),
        cast,
        chapters,
    };
}

/**
 * Validates a compiled beat. Returns a list of issues (empty = usable). Used as the
 * `validate` gate of the Director's generateWithRetry call, so beats that are empty,
 * too long, missing their fallbacks or that ignore the cast are re-requested.
 */
export function validateBeat(beat, { castNames = [], maxWords = BEAT_MAX_WORDS, factMaxWords = BEAT_FACT_MAX_WORDS } = {}) {
    const issues = [];
    const text = asText(beat?.text);
    if (!text) issues.push('The beat text is empty.');
    else if (wordCount(text) > maxWords) issues.push(`The beat text exceeds ${maxWords} words.`);
    const fact = asText(beat?.fact);
    if (!fact) issues.push('The beat fact is empty.');
    else if (wordCount(fact) > factMaxWords) issues.push(`The beat fact exceeds ${factMaxWords} words.`);
    const escalations = (Array.isArray(beat?.escalations) ? beat.escalations : [])
        .filter(e => asText(e));
    if (escalations.length < 2) issues.push('Two escalation events are required.');
    const cast = (Array.isArray(castNames) ? castNames : []).map(n => asText(n).toLowerCase()).filter(Boolean);
    if (cast.length && text && !cast.some(name => text.toLowerCase().includes(name))) {
        issues.push('The beat must name at least one cast member.');
    }
    return issues;
}

// --------------------------------------------------------------------------------------------
// Idle clock / ledger
// --------------------------------------------------------------------------------------------

/**
 * Deterministic idle clock: 0 below the idle threshold, then one rung per further
 * `idleTurns` completed replies, clamped to `maxRung` (escalations holds two entries,
 * so the default clamp is 1).
 */
export function selectRung(turnsSinceDelivery, idleTurns, maxRung = 1) {
    const turns = Math.max(0, Math.floor(Number(turnsSinceDelivery) || 0));
    const idle = Math.floor(Number(idleTurns));
    if (!Number.isFinite(idle) || idle < 1) return 0;
    if (turns < idle) return 0;
    const rung = Math.floor((turns - idle) / idle);
    return Math.max(0, Math.min(maxRung, rung));
}

/** Appends an established fact to the ledger in place, dropping the oldest past the cap. */
export function pushFact(ledger, fact, cap = LEDGER_MAX_FACTS) {
    const list = Array.isArray(ledger) ? ledger : [];
    const value = asText(fact);
    if (value) list.push(value);
    while (list.length > cap) list.shift();
    return list.length;
}

export function chapterIndexAt(story) {
    if (!isPlainObject(story) || !isPlainObject(story.bible)) return -1;
    const chapters = Array.isArray(story.bible.chapters) ? story.bible.chapters : [];
    if (!chapters.length) return -1;
    const index = Math.floor(Number(story.chapterIndex));
    if (!Number.isFinite(index)) return 0;
    return Math.max(0, Math.min(chapters.length - 1, index));
}

export function chapterAt(story) {
    const index = chapterIndexAt(story);
    return index === -1 ? null : (story.bible.chapters[index] ?? null);
}

export function storyCastNames(story) {
    if (!isPlainObject(story) || !isPlainObject(story.bible)) return [];
    return (Array.isArray(story.bible.cast) ? story.bible.cast : [])
        .map(member => asText(member?.name))
        .filter(Boolean);
}

// --------------------------------------------------------------------------------------------
// Directive compilation (deterministic, NO LLM call)
// --------------------------------------------------------------------------------------------

/**
 * Compiles the standing scene directive for the next reply. Three states:
 *  - 'pending'   — the beat has not been delivered yet: the reply MUST show beat.text.
 *  - 'steady'    — delivered and below the idle threshold: keep developing the chapter.
 *  - 'escalate'  — delivered and idle for `idleTurns`+ turns: MUST show escalations[rung].
 *
 * The result never contains bible secrets, cast secrets or any chapter other than the
 * current one. `char`/`user` are substituted at compile time (the directive is appended
 * after the tail's macro passes, so {{char}}/{{user}} tokens would never resolve there).
 * Hard word cap: ledger lines are shed first, then the text is trimmed.
 *
 * @returns {{state, must, text, chapterIndex}|null} null when the story cannot drive a reply
 */
export function compileDirective(story, { char = '', user = '', idleTurns = 3, maxWords = DIRECTIVE_DEFAULT_MAX_WORDS } = {}) {
    if (!isPlainObject(story) || !isPlainObject(story.bible)) return null;
    const chapters = Array.isArray(story.bible.chapters) ? story.bible.chapters : [];
    const chapterIndex = chapterIndexAt(story);
    if (!chapters.length || chapterIndex === -1) return null;
    const beat = isPlainObject(story.beat) ? story.beat : null;
    const beatText = asText(beat?.text);
    if (!beat || !beatText) return null;

    const chapter = chapters[chapterIndex];
    const idle = Number.isFinite(Number(idleTurns)) ? Math.max(1, Math.round(Number(idleTurns))) : 3;
    const turns = Math.max(0, Math.floor(Number(story.turnsSinceDelivery) || 0));

    let state = 'steady';
    let must = null;
    if (beat.status !== 'delivered') {
        state = 'pending';
        must = beatText;
    } else if (turns >= idle) {
        state = 'escalate';
        const escalations = (Array.isArray(beat.escalations) ? beat.escalations : [])
            .map(asText).filter(Boolean);
        const rung = Math.min(selectRung(turns, idle), Math.max(0, escalations.length - 1));
        must = escalations[rung] ?? escalations[escalations.length - 1] ?? beatText;
    }

    const charName = asText(char) || 'the character';
    const userName = asText(user) || 'the user';
    const ledger = (Array.isArray(story.ledger) ? story.ledger : []).map(asText).filter(Boolean);
    const header = '[SCENE DIRECTIVE — highest priority for this reply]';
    const frame = `Story: ${asText(story.bible.title) || 'Untitled'} · Chapter ${chapterIndex + 1}/${chapters.length}: ${asText(chapter.title) || 'Untitled'} · Tone: ${asText(story.bible.tone) || 'unspecified'}`;
    const body = state === 'steady'
        ? `Keep developing: ${asText(chapter.situation) || '(no situation set)'}. Let the cast act on their own goals. Do not repeat events listed above.`
        : [
            `THIS REPLY MUST SHOW, in ${charName}'s own voice and within its first half:`,
            `→ ${must}`,
            `End the reply with ${charName} waiting on ${userName}'s response or decision.`,
            `Never write ${userName}'s actions, words or feelings.`,
        ].join('\n');

    const cap = Math.max(1, Math.round(Number(maxWords) || DIRECTIVE_DEFAULT_MAX_WORDS));
    const assemble = (factCount) => {
        const lines = [header, frame];
        if (factCount > 0) lines.push('So far:', ...ledger.slice(-factCount).map(fact => `- ${fact}`));
        lines.push(body, '[END DIRECTIVE]');
        return lines.join('\n');
    };
    let count = Math.min(DIRECTIVE_LEDGER_LINES, ledger.length);
    let text = assemble(count);
    while (wordCount(text) > cap && count > 0) {
        count--;
        text = assemble(count);
    }
    if (wordCount(text) > cap) text = wordTrim(text, cap);
    return { state, must, text, chapterIndex };
}

/**
 * Swipe/regenerate re-injection (pure half): when the message the beat was delivered
 * in is about to be regenerated, the beat returns to pending, its fact leaves the
 * ledger and the idle clock resets. Returns false when the beat is not delivered at
 * `targetMsgIndex` (nothing to re-arm).
 */
export function rearmPending(story, targetMsgIndex) {
    if (!isPlainObject(story) || !isPlainObject(story.beat)) return false;
    const beat = story.beat;
    if (beat.status !== 'delivered' || beat.deliveredAtMsg !== targetMsgIndex) return false;
    beat.status = 'pending';
    beat.deliveredAtMsg = null;
    beat.rung = 0;
    story.turnsSinceDelivery = 0;
    const fact = asText(beat.fact);
    const ledger = Array.isArray(story.ledger) ? story.ledger : [];
    const index = fact ? ledger.lastIndexOf(fact) : -1;
    if (index !== -1) ledger.splice(index, 1);
    return true;
}
