// SmartTavern — character-ruling ledger pure core. NO SillyTavern imports (precedent:
// agent-core.js / story-core.js): tokenizer, oracle-answer validation, reuse/surface
// scoring, candidate selection and ledger maintenance rules. Everything here is
// deterministic and unit-testable under `node --test`; ST-bound storage, the oracle
// call and the undo log live in rulings.js.
//
// Rulings are durable CHARACTER BEHAVIOR ("when X happens, she does Y"): world facts
// stay in the memory_* tools, momentary feelings stay in consult_character.

import { wordCount, wordTrim, isPlainObject } from './agent-core.js';

// --------------------------------------------------------------------------------------------
// Constants
// --------------------------------------------------------------------------------------------

export const RULING_MAX_WORDS = 60;          // hard cap of the stored ruling text
export const RULING_BRIEF_MAX_WORDS = 30;    // per-ruling cap inside the Turn Brief
export const RULING_KEY_MIN = 2;
export const RULING_KEY_MAX = 6;
export const RULING_STATUSES = Object.freeze(['active', 'tentative', 'superseded']);
export const RULING_CONFIDENCES = Object.freeze(['high', 'medium', 'low']);
export const TENTATIVE_TTL_MESSAGES = 30;    // tentative rulings expire after this many new messages
const REUSE_STRONG_CAP = 0.3;                // fewer than 2 strong matches can never clear the cap

const EMPTY_SET = new Set();

// --------------------------------------------------------------------------------------------
// Tokenizer (EN + CJK). NFKC → lowercase → split on non-letter/number; small EN
// stopword list; light suffix stemming; CJK runs yield single characters + bigrams.
// --------------------------------------------------------------------------------------------

const EN_STOPWORDS = new Set([
    'a', 'an', 'the', 'and', 'or', 'but', 'if', 'when', 'what', 'how', 'why', 'who', 'whom', 'whose',
    'which', 'that', 'this', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'am',
    'do', 'does', 'did', 'doing', 'done', 'has', 'have', 'had', 'having', 'of', 'in', 'on', 'at', 'to',
    'from', 'by', 'with', 'without', 'for', 'as', 'into', 'onto', 'about', 'over', 'under', 'up', 'down',
    'out', 'off', 'again', 'then', 'once', 'here', 'there', 'all', 'any', 'both', 'each', 'few', 'more',
    'most', 'other', 'some', 'such', 'no', 'nor', 'not', 'only', 'same', 'so', 'than', 'too', 'very',
    'can', 'will', 'just', 'should', 'would', 'could', 'might', 'must', 'shall', 'may', 'now', 'own',
    'also', 'ever', 'never', 'still', 'yet', 'her', 'his', 'their', 'its', 'my', 'our', 'your', 'she',
    'he', 'they', 'it', 'we', 'you', 'i', 'me', 'us', 'him', 'them',
]);

// Longest first so '-ing' wins over '-s'; one suffix only, and only for words > 4 chars
// ("asks" is NOT stemmed — fixtures rely on that).
const SUFFIXES = ['ing', 'ed', 'es', 'ly', 's'];

const CJK_RUN = /[\u2e80-\ufaff]/;
const CJK_ONLY = /^[\u2e80-\ufaff]+$/;

function stem(word) {
    if (word.length <= 4) return word;
    for (const suffix of SUFFIXES) {
        if (word.endsWith(suffix)) return word.slice(0, -suffix.length);
    }
    return word;
}

/**
 * Deterministic token set for scoring. `exclude` (typically the character's and the
 * user's name tokens) is applied last, to raw and stemmed forms alike.
 */
export function tokenize(text, { exclude = EMPTY_SET } = {}) {
    const value = String(text ?? '').normalize('NFKC').toLowerCase();
    const out = new Set();
    const excluded = token => exclude.has(token);
    for (const run of value.split(/[^\p{L}\p{N}]+/u)) {
        if (!run) continue;
        // Mixed-script runs split first; CJK sub-runs become single chars + bigrams.
        for (const part of run.split(/([\u2e80-\ufaff]+)/).filter(Boolean)) {
            if (CJK_ONLY.test(part)) {
                for (const ch of part) if (!excluded(ch)) out.add(ch);
                for (let i = 0; i + 1 < part.length; i++) {
                    const gram = part.slice(i, i + 2);
                    if (!excluded(gram)) out.add(gram);
                }
                continue;
            }
            if (part.length < 2 || EN_STOPWORDS.has(part)) continue;
            const token = stem(part);
            if (excluded(part) || excluded(token) || token.length < 2) continue;
            out.add(token);
        }
    }
    return [...out];
}

// --------------------------------------------------------------------------------------------
// Keys / records
// --------------------------------------------------------------------------------------------

/** Lowercased, deduped key strings; a key dies when it has no tokens or touches `exclude`. */
export function cleanKeys(keys, { exclude = EMPTY_SET } = {}) {
    const out = [];
    const seen = new Set();
    for (const raw of (Array.isArray(keys) ? keys : [])) {
        const key = String(raw ?? '').trim().toLowerCase();
        if (!key || seen.has(key)) continue;
        if (!tokenize(key, { exclude }).length) continue;
        seen.add(key);
        out.push(key);
        if (out.length >= RULING_KEY_MAX) break;
    }
    return out;
}

const FIRST_PERSON_START = /^\s*(?:i(?:\s+(?:am|'m|’m|will|'ll|’ll|would|'d|’d|have|'ve|’ve)|'m|’m|'ll|’ll|'d|’d|'ve|’ve)?|my|mine|we|us|our|ours)\b/i;

/**
 * Canonical 13-field ruling record from any raw input; unknown fields are dropped.
 * Returns null when the ruling is empty or fewer than RULING_KEY_MIN keys survive cleaning.
 */
export function normalizeRuling(raw, { id = 0, subject = '', now = 0, atMsg = 0, exclude = EMPTY_SET } = {}) {
    if (!isPlainObject(raw)) return null;
    const ruling = wordTrim(String(raw.ruling ?? '').trim(), RULING_MAX_WORDS);
    if (!ruling) return null;
    const keys = cleanKeys(raw.keys, { exclude });
    if (keys.length < RULING_KEY_MIN) return null;
    const num = (value, fallback) => (Number.isFinite(Number(value)) ? Number(value) : fallback);
    return {
        id: num(id, 0),
        subject: String(subject ?? '').trim(),
        question: String(raw.question ?? '').trim(),
        ruling,
        keys,
        confidence: RULING_CONFIDENCES.includes(raw.confidence) ? raw.confidence : 'medium',
        status: RULING_STATUSES.includes(raw.status) ? raw.status : 'active',
        pinned: raw.pinned === true,
        uses: Math.max(0, Math.round(num(raw.uses, 0))),
        atMsg: num(raw.atMsg, num(atMsg, 0)),
        createdAt: num(raw.createdAt, num(now, 0)),
        supersedes: Number.isInteger(raw.supersedes) ? raw.supersedes : null,
        source: raw.source === 'manual' ? 'manual' : 'oracle',
    };
}

/**
 * Oracle-answer lint. Deliberately does NOT try to detect "decides the user's
 * actions" — the system prompt owns that. Returns a list of issues (empty = valid).
 */
export function validateOracleAnswer(obj, { exclude = EMPTY_SET } = {}) {
    if (!isPlainObject(obj)) return ['the answer is not a JSON object'];
    const issues = [];
    const ruling = String(obj.ruling ?? '').trim();
    if (!ruling) issues.push('ruling is empty');
    else {
        if (wordCount(ruling) > RULING_MAX_WORDS) issues.push(`ruling exceeds ${RULING_MAX_WORDS} words`);
        if (ruling.includes('{{')) issues.push('ruling contains unreplaced {{placeholders}}');
        if (FIRST_PERSON_START.test(ruling)) issues.push('ruling must be third person (starts with a first-person pronoun)');
    }
    if (cleanKeys(obj.keys, { exclude }).length < RULING_KEY_MIN) {
        issues.push(`fewer than ${RULING_KEY_MIN} usable keys after cleaning`);
    }
    if (!RULING_CONFIDENCES.includes(obj.confidence)) issues.push('confidence must be high, medium or low');
    if (obj.supersedes != null && !Number.isInteger(obj.supersedes)) issues.push('supersedes must be an integer or null');
    return issues;
}

// --------------------------------------------------------------------------------------------
// Scoring
// --------------------------------------------------------------------------------------------

/** Query→ruling similarity in [0,1], normalized by the query token count. Keys hit
 *  hardest, then the saved question, then the ruling text. Fewer than 2 strong
 *  (keys/question) matches caps the score at 0.3 — text overlap alone is not reuse. */
export function reuseScore(queryText, ruling, { exclude = EMPTY_SET } = {}) {
    const queryTokens = tokenize(queryText, { exclude });
    if (!queryTokens.length || !isPlainObject(ruling)) return 0;
    const keyTokens = new Set();
    for (const key of (Array.isArray(ruling.keys) ? ruling.keys : [])) {
        for (const token of tokenize(key, { exclude })) keyTokens.add(token);
    }
    const questionTokens = new Set(tokenize(ruling.question, { exclude }));
    const textTokens = new Set(tokenize(ruling.ruling, { exclude }));
    let sum = 0;
    let strong = 0;
    for (const token of queryTokens) {
        let weight = 0;
        if (keyTokens.has(token)) weight = 1;
        else if (questionTokens.has(token)) weight = 0.75;
        else if (textTokens.has(token)) weight = 0.4;
        sum += weight;
        if (weight >= 0.75) strong++;
    }
    const score = sum / queryTokens.length;
    return strong >= 2 ? score : Math.min(score, REUSE_STRONG_CAP);
}

/** Context→ruling relevance in [0,1]: the fraction of the ruling's KEYS fully present
 *  in the context tokens (multi-word keys need all their tokens). No keys hit → 0.
 *  Deliberately different from reuseScore: the context is a whole chat message. */
export function surfaceScore(contextText, ruling, { exclude = EMPTY_SET, contextTokens = null } = {}) {
    const keys = Array.isArray(ruling?.keys) ? ruling.keys : [];
    if (!keys.length) return 0;
    const tokens = contextTokens ?? new Set(tokenize(contextText, { exclude }));
    if (!tokens.size) return 0;
    let hits = 0;
    let counted = 0;
    for (const key of keys) {
        const keyTokens = tokenize(key, { exclude });
        if (!keyTokens.length) continue;
        counted++;
        if (keyTokens.every(token => tokens.has(token))) hits++;
    }
    return counted ? hits / counted : 0;
}

/** Active rulings for `subject` ranked for the brief: score, then pinned, then uses,
 *  then newest; deterministic tie-break by id. Returns [{id, ruling, score}]. */
export function selectRulings(rulings, contextText, { subject = '', k = 2, minScore = 0.34, exclude = EMPTY_SET } = {}) {
    const contextTokens = new Set(tokenize(contextText, { exclude }));
    if (!contextTokens.size) return [];
    const scored = [];
    for (const record of (Array.isArray(rulings) ? rulings : [])) {
        if (!isPlainObject(record) || record.status !== 'active') continue;
        if (subject && record.subject !== subject) continue;
        const score = surfaceScore(contextText, record, { exclude, contextTokens });
        if (score >= minScore) scored.push({ record, score });
    }
    scored.sort((a, b) => (b.score - a.score)
        || (Number(b.record.pinned === true) - Number(a.record.pinned === true))
        || (Number(b.record.uses ?? 0) - Number(a.record.uses ?? 0))
        || (Number(b.record.createdAt ?? 0) - Number(a.record.createdAt ?? 0))
        || (Number(a.record.id) - Number(b.record.id)));
    const limit = Math.max(0, Math.round(Number(k) || 0));
    return scored.slice(0, limit).map(({ record, score }) => ({ id: record.id, ruling: String(record.ruling ?? ''), score }));
}

/** Best active-or-tentative reuse candidate for a question above `threshold`. */
export function reuseCandidate(rulings, question, { subject = '', threshold = 0.6, exclude = EMPTY_SET } = {}) {
    let best = null;
    for (const record of (Array.isArray(rulings) ? rulings : [])) {
        if (!isPlainObject(record)) continue;
        if (subject && record.subject !== subject) continue;
        if (record.status !== 'active' && record.status !== 'tentative') continue;
        const score = reuseScore(question, record, { exclude });
        if (score < threshold) continue;
        if (!best || score > best.score || (score === best.score && Number(record.id) < Number(best.ruling.id))) {
            best = { ruling: record, score };
        }
    }
    return best;
}

// --------------------------------------------------------------------------------------------
// Ledger maintenance (all pure; rulings.js owns persistence and the undo log)
// --------------------------------------------------------------------------------------------

/**
 * Marks the target of `supersedesId` as 'superseded'. No-op when the id is missing,
 * already superseded, pinned, or belongs to another subject than the new ruling.
 * Returns { rulings, superseded } where `superseded` is the marked copy or null.
 */
export function applySupersede(rulings, newId, supersedesId) {
    const list = Array.isArray(rulings) ? rulings : [];
    if (!Number.isInteger(supersedesId)) return { rulings: list, superseded: null };
    const fresh = list.find(record => record?.id === newId);
    const target = list.find(record => record?.id === supersedesId);
    if (!fresh || !target || target.status === 'superseded' || target.pinned === true) return { rulings: list, superseded: null };
    if (String(target.subject ?? '') !== String(fresh.subject ?? '')) return { rulings: list, superseded: null };
    return {
        rulings: list.map(record => record === target ? { ...record, status: 'superseded' } : record),
        superseded: { ...target, status: 'superseded' },
    };
}

/** Eviction order: superseded → tentative → lowest uses, then oldest, unpinned active.
 *  Pinned rulings are never evicted; if only pinned remain, nothing is evicted. */
export function enforceCap(rulings, max) {
    const list = Array.isArray(rulings) ? rulings : [];
    const cap = Math.max(0, Math.round(Number(max) || 0));
    if (list.length <= cap) return { kept: list, evicted: [] };
    const rank = { superseded: 0, tentative: 1, active: 2 };
    const evictable = list
        .filter(record => !record?.pinned)
        .sort((a, b) => (rank[a.status] ?? 3) - (rank[b.status] ?? 3)
            || Number(a.uses ?? 0) - Number(b.uses ?? 0)
            || Number(a.createdAt ?? 0) - Number(b.createdAt ?? 0)
            || Number(a.id) - Number(b.id));
    const evictIds = new Set(evictable.slice(0, list.length - cap).map(record => record.id));
    if (!evictIds.size) return { kept: list, evicted: [] };
    const evicted = list.filter(record => evictIds.has(record.id));
    return { kept: list.filter(record => !evictIds.has(record.id)), evicted };
}

/**
 * Tentative rulings expire when the chat has moved TENTATIVE_TTL_MESSAGES past their
 * creation (stale guess) or when chatLength < atMsg (their part of the chat was
 * rewound). Active rulings are never auto-expired.
 */
export function expireTentative(rulings, { chatLength = 0, ttl = TENTATIVE_TTL_MESSAGES } = {}) {
    const list = Array.isArray(rulings) ? rulings : [];
    const kept = [];
    const expired = [];
    for (const record of list) {
        const atMsg = Number(record?.atMsg ?? 0);
        const stale = record?.status === 'tentative' && (chatLength < atMsg || (chatLength - atMsg) > ttl);
        if (stale) expired.push(record);
        else kept.push(record);
    }
    return { kept, expired };
}

/** A tentative ruling becomes active on its second use; otherwise the same reference. */
export function promoteOnUse(ruling) {
    if (isPlainObject(ruling) && ruling.status === 'tentative' && Number(ruling.uses ?? 0) >= 2) {
        return { ...ruling, status: 'active' };
    }
    return ruling;
}
