// Pure "lean context" logic: block activation, per-field reply injection, reusable
// assessments and the reply-tail token budget. No SillyTavern imports, so it is unit
// testable on its own (same style as planner-core.js / story-core.js).

export const ACTIVATIONS = Object.freeze(['always', 'keywords', 'planner']);
export const FIELD_INJECT_MODES = Object.freeze(['always', 'relevant', 'never']);
export const DEFAULT_SCAN_DEPTH = 2;
export const DEFAULT_PRIORITY = 50;

// Fixed priorities of the non-step tail sections (steps carry their own `priority`).
export const PRIORITY_BRIEF = 90;
export const PRIORITY_USER_ANSWERS = 80;
export const PRIORITY_SCENE = 70;
export const PRIORITY_PROFILE = 60;

// --------------------------------------------------------------------------------------------
// Keywords
// --------------------------------------------------------------------------------------------

/**
 * Parses a keyword list: entries are separated by commas or newlines. An entry wrapped
 * as /pattern/flags is a regular expression, anything else a case-insensitive substring.
 * A regex that contains a comma must sit alone on its own line. Invalid regexes are
 * dropped. The stateful g / y flags are ignored so matching is repeatable.
 * @returns {{ text: string, regex: RegExp|null }[]}
 */
export function parseKeywords(value) {
    const entries = [];
    for (const line of String(value ?? '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const whole = parseKeywordEntry(trimmed);
        if (whole?.regex) {
            entries.push(whole);
            continue;
        }
        for (const piece of trimmed.split(',')) {
            const entry = parseKeywordEntry(piece.trim());
            if (entry) entries.push(entry);
        }
    }
    return entries;
}

function parseKeywordEntry(text) {
    if (!text) return null;
    const match = text.match(/^\/(.+)\/([a-z]*)$/s);
    if (match) {
        try {
            return { text, regex: new RegExp(match[1], match[2].replace(/[gy]/g, '')) };
        } catch {
            return null;
        }
    }
    return { text: text.toLowerCase(), regex: null };
}

export function hasKeywords(value) {
    return parseKeywords(value).length > 0;
}

/** True when at least one keyword entry matches `text` (an empty list never matches). */
export function keywordsMatch(value, text) {
    const haystack = String(text ?? '');
    const lower = haystack.toLowerCase();
    return parseKeywords(value).some(entry => entry.regex ? entry.regex.test(haystack) : lower.includes(entry.text));
}

/** The last `depth` non-system chat messages (ST-injected ones excluded), newest last, as one text. */
export function scanText(chat, depth = DEFAULT_SCAN_DEPTH) {
    const count = Math.max(1, Math.min(20, Math.round(Number(depth)) || DEFAULT_SCAN_DEPTH));
    return (Array.isArray(chat) ? chat : [])
        .filter(message => message && !message.is_system && !message.extra?.isSmartTavern && !message.smarttavern_ephemeral
            && String(message.mes ?? '').trim())
        .slice(-count).map(message => String(message.mes)).join('\n');
}

// --------------------------------------------------------------------------------------------
// 1a. Block activation
// --------------------------------------------------------------------------------------------

export function stepActivation(step) {
    return ACTIVATIONS.includes(step?.activation) ? step.activation : 'always';
}

/**
 * Splits blocks into the ones that may run and the ones a keyword gate switched off.
 * 'planner' blocks always pass here — the planner decides later (fail open).
 * @returns {{ active: object[], inactive: { name: string }[] }}
 */
export function partitionByActivation(steps, recentText) {
    const active = [];
    const inactive = [];
    for (const step of (Array.isArray(steps) ? steps : [])) {
        if (stepActivation(step) === 'keywords' && !keywordsMatch(step.keywords, recentText)) {
            inactive.push({ name: String(step?.name ?? '') });
        } else active.push(step);
    }
    return { active, inactive };
}

// --------------------------------------------------------------------------------------------
// 1b. Per-field reply injection
// --------------------------------------------------------------------------------------------

export function fieldInjectMode(field) {
    return FIELD_INJECT_MODES.includes(field?.inject) ? field.inject : 'always';
}

/**
 * The schema fields the REPLY model sees (description override and reply-tail
 * {{definitions}}). 'always' fields are in, 'never' fields are out. A 'relevant' field is
 * in when the planner listed it, or when its keywords match the recent messages. When the
 * planner gave no answer (it did not run, failed or sent no ## Fields heading) a relevant
 * field WITHOUT keywords stays in — fail open; one WITH keywords is decided by them.
 * @param {object[]} fields
 * @param {{ plannerFields?: string[]|null, plannerRan?: boolean, recentText?: string }} [options]
 * @returns {object[]} the selected fields, in schema order
 */
export function selectReplyFields(fields, { plannerFields = null, plannerRan = false, recentText = '' } = {}) {
    const listed = new Set((Array.isArray(plannerFields) ? plannerFields : []).map(name => String(name).trim().toLowerCase()));
    const answered = plannerRan && Array.isArray(plannerFields);
    return (Array.isArray(fields) ? fields : []).filter(field => {
        const mode = fieldInjectMode(field);
        if (mode === 'always') return true;
        if (mode === 'never') return false;
        if (listed.has(String(field?.name ?? '').trim().toLowerCase())) return true;
        if (keywordsMatch(field?.keywords, recentText)) return true;
        return !answered && !hasKeywords(field?.keywords);
    });
}

// --------------------------------------------------------------------------------------------
// 1c. Reusable assessments
// --------------------------------------------------------------------------------------------

export const NO_PREVIOUS = '(none yet)';

/**
 * True when a step answered "nothing changed": exactly UNCHANGED, or UNCHANGED followed
 * by only punctuation / whitespace (case-insensitive).
 */
export function isUnchangedOutput(output) {
    return /^unchanged[\s\p{P}]*$/iu.test(String(output ?? '').trim());
}

/**
 * Index of the newest saved chat message equal to the last non-system message of the
 * generation's chat array (the interceptor works on a copy), or -1.
 */
export function anchorIndex(savedChat, coreChat) {
    const usable = message => message && !message.is_system && !message.extra?.isSmartTavern && !message.smarttavern_ephemeral;
    const last = [...(Array.isArray(coreChat) ? coreChat : [])].reverse().find(usable);
    if (!last) return -1;
    const saved = Array.isArray(savedChat) ? savedChat : [];
    for (let index = saved.length - 1; index >= 0; index--) {
        const message = saved[index];
        if (usable(message) && message.mes === last.mes && Boolean(message.is_user) === Boolean(last.is_user)) return index;
    }
    return -1;
}

/**
 * Stored step output usable as {{previous}} for a generation anchored at `currentIndex`.
 * Anchoring rule: an entry remembers the last chat message that existed when the output
 * was produced (sourceIndex + sourceText). It applies only while that message is still
 * in the saved chat unchanged AND the new generation is anchored LATER than it, so an
 * entry from an earlier turn carries over to the next turn. A swipe or regenerate of the
 * reply, an edited message or a rewound chat leaves the anchor equal, changed or gone —
 * then there is no previous output.
 */
export function previousFromMemory(entry, savedChat, currentIndex) {
    if (!entry || typeof entry.text !== 'string' || !entry.text.trim()) return '';
    const saved = Array.isArray(savedChat) ? savedChat : [];
    if (!Number.isInteger(entry.sourceIndex) || saved[entry.sourceIndex]?.mes !== entry.sourceText) return '';
    if (!(currentIndex > entry.sourceIndex)) return '';
    return entry.text;
}

// --------------------------------------------------------------------------------------------
// 1d. Reply-tail budget
// --------------------------------------------------------------------------------------------

export function estimateTokens(text) {
    return Math.ceil(String(text ?? '').length / 3.5);
}

/**
 * Chooses which tail sections to keep within `budget` tokens (0 = unlimited).
 * Whole sections are dropped, lowest priority first (ties: the later section first),
 * never mid-text. Sections flagged `required` are never dropped, so the result may stay
 * over budget when only those remain.
 * @param {{ id: string, tokens: number, priority?: number, required?: boolean }[]} sections in tail order
 * @returns {{ keep: string[], dropped: string[], tokens: number }}
 */
export function planTailBudget(sections, budget) {
    const list = Array.isArray(sections) ? sections : [];
    let total = list.reduce((sum, section) => sum + (Number(section.tokens) || 0), 0);
    const dropped = new Set();
    if (budget > 0) {
        const candidates = list.map((section, order) => ({ section, order })).filter(item => !item.section.required && Number(item.section.tokens) > 0)
            .sort((a, b) => (Number(a.section.priority ?? DEFAULT_PRIORITY) - Number(b.section.priority ?? DEFAULT_PRIORITY)) || (b.order - a.order));
        for (const { section } of candidates) {
            if (total <= budget) break;
            dropped.add(section.id);
            total -= Number(section.tokens) || 0;
        }
    }
    return { keep: list.filter(section => !dropped.has(section.id)).map(section => section.id), dropped: list.filter(section => dropped.has(section.id)).map(section => section.id), tokens: total };
}
