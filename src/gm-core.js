// SmartTavern — GM engine pure core. NO SillyTavern imports (precedent: story-core.js /
// agent-core.js): the tag-grammar parser for the GM's between-turns output, the fit-check
// parser, progress-clock and NPC-agenda math, the prepared-brief anchor rules, the Turn
// Brief compiler adapter and the plain-text renderers. Everything here is deterministic
// and unit-testable under `node --test`; storage, prompts and LLM calls live in gm.js.
//
// Core principle mirrored from the Story Director: the GM MAY see secrets (bible, cast
// agendas, clocks); the reply model never does. Only the compiled Turn Brief crosses over,
// and dice in it come from code records (rollDice), never from the GM's own text.
import { wordTrim, truncate, isPlainObject, looksRefusal, compileBrief, parseAgentResponse } from './agent-core.js';
import { stepActivation } from './lean-core.js';

export const GM_MAX_MUSTS = 3;
export const GM_MAX_BRANCHES = 4;
export const GM_BRIEF_HARD_WORDS = 120;   // the contract asks for ~100; anything longer is cut
export const GM_MUST_WORDS = 40;
export const GM_BRANCH_IF_WORDS = 20;
export const GM_BRANCH_THEN_WORDS = 40;
export const GM_INTENT_WORDS = 40;
export const CLOCK_MAX = 8;               // active + filled clocks kept per chat
export const CLOCK_MIN_SEGMENTS = 2;
export const CLOCK_MAX_SEGMENTS = 12;
export const CLOCK_NAME_CHARS = 60;
export const CLOCK_CONSEQUENCE_WORDS = 40;
export const AGENDA_MAX = 12;
export const AGENDA_NAME_CHARS = 60;
export const TRANSCRIPT_MAX_ENTRIES = 40;
export const TRANSCRIPT_TEXT_CHARS = 1500;

const asText = value => String(value ?? '').trim();
const oneLine = value => asText(value).replace(/\s*\n\s*/g, ' ').replace(/\s{2,}/g, ' ');
const cut = (value, chars) => oneLine(value).slice(0, chars).trim();
const clamp = (value, min, max, fallback) => {
    const num = Number(value);
    return Number.isFinite(num) ? Math.min(max, Math.max(min, Math.round(num))) : fallback;
};

// --------------------------------------------------------------------------------------------
// Output grammar (tolerant tag parser, never JSON)
//
//   <think>…</think>                         optional
//   then EITHER tool calls (agent-core's <tool name="x">{json}</tool>)
//   OR the final output:
//     <brief>≈100 words of guidance</brief>
//     <must>required observable event</must>            0–3
//     <branch if="condition">outcome</branch>           0–4
//     <fields>Name, Name</fields>                       optional
//     <skip>Block name</skip>                           0–n
//
// Same philosophy as parseAgentResponse: salvage unclosed tags (a tag ends at its close tag,
// at the next sibling tag or at the end of the text), drop refusals, and let tool calls win
// over a final output that arrives in the same message (the caller keeps it as a fallback).
// --------------------------------------------------------------------------------------------

const SIBLING_TAGS = 'brief|guidance|must|branch|fields|skip|use|tool';

function tagMatches(text, name) {
    const re = new RegExp(`<${name}\\b((?:[^>"']|"[^"]*"|'[^']*')*)>([\\s\\S]*?)(?:<\\/${name}\\s*>|(?=<(?:${SIBLING_TAGS})\\b)|$)`, 'gi');
    return [...String(text ?? '').matchAll(re)].map(match => ({
        attrs: String(match[1] ?? ''),
        body: /\/\s*$/.test(match[1] ?? '') && !String(match[2] ?? '').trim() ? '' : String(match[2] ?? ''),
    }));
}

/** Tag-free, single-line text of a tag body. */
function plainBody(body) {
    return oneLine(String(body ?? '').replace(/<[^>]*>/g, ' '));
}

function stripThink(text) {
    return String(text ?? '').replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '');
}

function stripOuterFence(text) {
    const value = String(text ?? '').trim();
    const fenced = value.match(/^```[^\n]*\n([\s\S]*?)\n?```$/);
    return fenced ? fenced[1].trim() : value;
}

function uniqueCaseInsensitive(list) {
    const seen = new Set();
    return list.filter(item => {
        const key = item.toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

/**
 * Parses one GM iteration output.
 * @returns {{think: string, tools: object[], brief: string, musts: string[],
 *   branches: {if: string, then: string}[], fields: string[]|null, skips: string[],
 *   refused: boolean, valid: boolean}}
 *   `valid` = a usable final output (a brief and/or at least one must). `fields` is null
 *   when the tag was absent (leave field selection to the keyword rules), [] when the GM
 *   named none.
 */
export function parseGmOutput(raw, { maxBriefWords = GM_BRIEF_HARD_WORDS } = {}) {
    const parsed = parseAgentResponse(raw);
    const text = stripOuterFence(stripThink(raw)).replace(/<tool\b[\s\S]*?(?:<\/tool>|$)/gi, '');

    let brief = '';
    for (const tag of [...tagMatches(text, 'brief'), ...tagMatches(text, 'guidance')]) {
        const candidate = plainBody(tag.body);
        if (candidate) { brief = candidate; break; }
    }
    // A model that falls back to the legacy shape nests <must> inside <brief>; those are
    // still collected below because every tag is scanned over the whole text.
    brief = wordTrim(brief, maxBriefWords);

    const musts = uniqueCaseInsensitive(tagMatches(text, 'must')
        .map(tag => wordTrim(plainBody(tag.body), GM_MUST_WORDS))
        .filter(Boolean)).slice(0, GM_MAX_MUSTS);

    const branches = [];
    for (const tag of tagMatches(text, 'branch')) {
        const condition = tag.attrs.match(/\bif\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
        const when = wordTrim(oneLine(condition?.[1] ?? condition?.[2] ?? condition?.[3] ?? ''), GM_BRANCH_IF_WORDS);
        const then = wordTrim(plainBody(tag.body), GM_BRANCH_THEN_WORDS);
        if (when && then && branches.length < GM_MAX_BRANCHES) branches.push({ if: when, then });
    }

    const fieldTags = tagMatches(text, 'fields');
    let fields = null;
    if (fieldTags.length) {
        fields = uniqueCaseInsensitive(plainBody(fieldTags[0].body).split(/[,;]/)
            .map(item => item.trim()).filter(item => item && !/^(none|n\/a|-)$/i.test(item)));
    }

    const skips = uniqueCaseInsensitive(tagMatches(text, 'skip')
        .map(tag => plainBody(tag.body)).filter(Boolean));

    // Refusals never become a brief: judge the cleaned text, not the think block.
    const briefRefused = Boolean(brief) && looksRefusal(brief, { inCharacter: true });
    if (briefRefused) brief = '';
    const valid = Boolean(brief) || musts.length > 0;
    const refused = briefRefused || (!parsed.tools.length && !valid && looksRefusal(text));
    return { think: parsed.think, tools: parsed.tools, brief, musts, branches, fields, skips, refused, valid };
}

// --------------------------------------------------------------------------------------------
// Native tool transport: `submit_brief`
//
// With native function calling the GM ends its tick by CALLING this tool instead of writing
// the tag grammar. gmOutputFromSubmit applies the same trims, caps and refusal rule as
// parseGmOutput, so both transports feed one normalization path (finish() in gm.js).
// --------------------------------------------------------------------------------------------

export const SUBMIT_BRIEF_TOOL = 'submit_brief';

export const SUBMIT_BRIEF_DEFINITION = Object.freeze({
    name: SUBMIT_BRIEF_TOOL,
    description: 'FINAL STEP. Submit the prepared brief for the next reply; calling this ends your turn, so do all other tool calls first. brief = about 100 words for the writer (what the world and NPCs do next, tone, pacing). musts = required, observable events for the next reply (0-3). branches = conditional outcomes keyed to the player\'s likely next move (0-4). fields = names of RELEVANT-MODE FIELDS that matter next turn (omit when none are listed). skips = exact names of planner-activated blocks that add nothing next turn.',
    inputSchema: {
        type: 'object',
        required: ['brief'],
        properties: {
            brief: { type: 'string', description: 'About 100 words for the writer' },
            musts: { type: 'array', maxItems: GM_MAX_MUSTS, items: { type: 'string' }, description: 'Required observable events, one each' },
            branches: {
                type: 'array', maxItems: GM_MAX_BRANCHES,
                items: {
                    type: 'object', required: ['if', 'then'],
                    properties: {
                        if: { type: 'string', description: 'Short condition on the player\'s next message' },
                        then: { type: 'string', description: 'What happens in that case' },
                    },
                },
            },
            fields: { type: 'array', items: { type: 'string' }, description: 'Profile field names that matter next turn' },
            skips: { type: 'array', items: { type: 'string' }, description: 'Exact block names to skip' },
        },
    },
});

/**
 * Normalizes the arguments of a submit_brief call into the shape parseGmOutput returns
 * (`tools` is always empty). `fields` is null when the argument was absent.
 */
export function gmOutputFromSubmit(args, { maxBriefWords = GM_BRIEF_HARD_WORDS } = {}) {
    const input = isPlainObject(args) ? args : {};
    const strings = value => (Array.isArray(value) ? value : (typeof value === 'string' && value.trim() ? [value] : []))
        .map(item => oneLine(typeof item === 'string' ? item : '')).filter(Boolean);
    let brief = wordTrim(oneLine(typeof input.brief === 'string' ? input.brief : ''), maxBriefWords);
    const musts = uniqueCaseInsensitive(strings(input.musts).map(item => wordTrim(item, GM_MUST_WORDS)).filter(Boolean)).slice(0, GM_MAX_MUSTS);
    const branches = [];
    for (const item of Array.isArray(input.branches) ? input.branches : []) {
        const when = wordTrim(oneLine(isPlainObject(item) && typeof item.if === 'string' ? item.if : ''), GM_BRANCH_IF_WORDS);
        const then = wordTrim(oneLine(isPlainObject(item) && typeof item.then === 'string' ? item.then : ''), GM_BRANCH_THEN_WORDS);
        if (when && then && branches.length < GM_MAX_BRANCHES) branches.push({ if: when, then });
    }
    const fields = Array.isArray(input.fields)
        ? uniqueCaseInsensitive(strings(input.fields).filter(item => !/^(none|n\/a|-)$/i.test(item)))
        : null;
    const skips = uniqueCaseInsensitive(strings(input.skips));
    const refused = Boolean(brief) && looksRefusal(brief, { inCharacter: true });
    if (refused) brief = '';
    return { think: '', tools: [], brief, musts, branches, fields, skips, refused, valid: Boolean(brief) || musts.length > 0 };
}

// --------------------------------------------------------------------------------------------
// Fit check: `<use>1,3</use>` | `<use>none</use>`
// --------------------------------------------------------------------------------------------

/**
 * @returns {{ok: boolean, use: number[], none: boolean}} `use` holds 1-based branch numbers
 *   within 1..count. ok=false means the answer was unusable (callers fail open: no branches).
 */
export function parseFitCheck(raw, count) {
    const total = Math.max(0, Math.round(Number(count) || 0));
    const match = stripThink(raw).match(/<use\b[^>]*>([\s\S]*?)(?:<\/use\s*>|$)/i);
    if (!match) return { ok: false, use: [], none: false };
    const body = plainBody(match[1]);
    if (!body || /^(none|no|nothing|n\/a|-|0)\b/i.test(body)) return { ok: true, use: [], none: true };
    const numbers = [...new Set([...body.matchAll(/\d+/g)].map(item => Number(item[0])))]
        .filter(number => number >= 1 && number <= total)
        .sort((a, b) => a - b);
    return numbers.length ? { ok: true, use: numbers, none: false } : { ok: false, use: [], none: false };
}

// --------------------------------------------------------------------------------------------
// Progress clocks. Plain arrays of { id, name, segments, filled, consequence, status }
// with status 'active' | 'filled'. Every mutator edits the array in place and returns a
// result object; failures are { ok: false, error } and never throw.
// --------------------------------------------------------------------------------------------

export function normalizeClock(raw) {
    if (!isPlainObject(raw)) return null;
    const name = cut(raw.name, CLOCK_NAME_CHARS);
    const id = Math.round(Number(raw.id));
    if (!name || !Number.isInteger(id) || id < 1) return null;
    const segments = clamp(raw.segments, CLOCK_MIN_SEGMENTS, CLOCK_MAX_SEGMENTS, 6);
    const filled = clamp(raw.filled, 0, segments, 0);
    return {
        id, name, segments, filled,
        consequence: wordTrim(oneLine(raw.consequence), CLOCK_CONSEQUENCE_WORDS),
        status: raw.status === 'filled' || filled >= segments ? 'filled' : 'active',
    };
}

export function nextClockId(clocks) {
    return (Array.isArray(clocks) ? clocks : []).reduce((max, clock) => Math.max(max, Number(clock?.id) || 0), 0) + 1;
}

/** Finds a clock by numeric id or case-insensitive name. */
export function findClock(clocks, ref) {
    const list = Array.isArray(clocks) ? clocks : [];
    if (typeof ref === 'number' || /^\d+$/.test(String(ref ?? '').trim())) {
        const byId = list.find(clock => clock.id === Number(ref));
        if (byId) return byId;
    }
    const wanted = oneLine(ref).toLowerCase();
    return wanted ? list.find(clock => clock.name.toLowerCase() === wanted) ?? null : null;
}

export function createClock(clocks, { name, segments = 6, consequence = '' } = {}) {
    const clean = cut(name, CLOCK_NAME_CHARS);
    if (!clean) return { ok: false, error: 'a clock needs a name' };
    if (findClock(clocks, clean)) return { ok: false, error: `a clock named "${clean}" already exists — advance it instead` };
    if (clocks.length >= CLOCK_MAX) return { ok: false, error: `at most ${CLOCK_MAX} clocks per chat — resolve or delete one first` };
    const clock = normalizeClock({
        id: nextClockId(clocks), name: clean, segments: clamp(segments, CLOCK_MIN_SEGMENTS, CLOCK_MAX_SEGMENTS, 6),
        filled: 0, consequence, status: 'active',
    });
    clocks.push(clock);
    return { ok: true, clock };
}

/** Advances an ACTIVE clock by 1..3 segments; `justFilled` is true on the filling call. */
export function advanceClock(clocks, ref, by = 1) {
    const clock = findClock(clocks, ref);
    if (!clock) return { ok: false, error: `no clock "${oneLine(ref)}"` };
    if (clock.status === 'filled') return { ok: false, error: `the "${clock.name}" clock is already filled — resolve it or create a new one` };
    clock.filled = Math.min(clock.segments, clock.filled + clamp(by, 1, 3, 1));
    const justFilled = clock.filled >= clock.segments;
    if (justFilled) clock.status = 'filled';
    return { ok: true, clock, justFilled };
}

/** Removes a clock (resolve = its story is over, delete = discarded; both drop it). */
export function removeClock(clocks, ref) {
    const clock = findClock(clocks, ref);
    if (!clock) return { ok: false, error: `no clock "${oneLine(ref)}"` };
    clocks.splice(clocks.indexOf(clock), 1);
    return { ok: true, clock };
}

/** The required event for a clock that just filled. */
export function clockMust(clock) {
    const consequence = asText(clock?.consequence);
    return consequence || `The "${asText(clock?.name)}" clock is full: its threat or deadline arrives now.`;
}

export function renderClocks(clocks) {
    const list = (Array.isArray(clocks) ? clocks : []).map(normalizeClock).filter(Boolean);
    if (!list.length) return '';
    return list.map(clock => (clock.status === 'filled'
        ? `- ${clock.name} [FULL ${clock.segments}/${clock.segments}]${clock.consequence ? ` — consequence (already delivered or due): ${clock.consequence}` : ''}`
        : `- ${clock.name} [${clock.filled}/${clock.segments}]${clock.consequence ? ` — when full: ${clock.consequence}` : ''}`)).join('\n');
}

// --------------------------------------------------------------------------------------------
// NPC agendas: { [name]: { intent, at } }
// --------------------------------------------------------------------------------------------

export function normalizeAgendas(raw) {
    const out = {};
    if (!isPlainObject(raw)) return out;
    for (const [key, value] of Object.entries(raw)) {
        const name = cut(key, AGENDA_NAME_CHARS);
        const intent = wordTrim(oneLine(isPlainObject(value) ? value.intent : value), GM_INTENT_WORDS);
        if (name && intent && name !== '__proto__') out[name] = { intent, at: Number(value?.at) || 0 };
    }
    return out;
}

export function setAgenda(agendas, name, intent, at = Date.now()) {
    const cleanName = cut(name, AGENDA_NAME_CHARS);
    const cleanIntent = wordTrim(oneLine(intent), GM_INTENT_WORDS);
    if (!cleanName || cleanName === '__proto__') return { ok: false, error: 'an NPC needs a name' };
    if (!cleanIntent) return { ok: false, error: 'an intent is required (≤ 40 words)' };
    const existing = Object.keys(agendas).find(key => key.toLowerCase() === cleanName.toLowerCase());
    if (existing) delete agendas[existing];
    agendas[existing ?? cleanName] = { intent: cleanIntent, at };
    // Over the cap: the least recently updated agenda goes first.
    const keys = Object.keys(agendas);
    if (keys.length > AGENDA_MAX) {
        const oldest = keys.sort((a, b) => agendas[a].at - agendas[b].at)[0];
        delete agendas[oldest];
    }
    return { ok: true, name: existing ?? cleanName, intent: cleanIntent };
}

export function deleteAgenda(agendas, name) {
    const key = Object.keys(agendas).find(item => item.toLowerCase() === oneLine(name).toLowerCase());
    if (!key) return false;
    delete agendas[key];
    return true;
}

export function renderAgendas(agendas) {
    const entries = Object.entries(normalizeAgendas(agendas));
    return entries.map(([name, value]) => `- ${name}: ${value.intent}`).join('\n');
}

// --------------------------------------------------------------------------------------------
// Story bible (the GM's view — secrets included; NEVER passed to the reply model)
// --------------------------------------------------------------------------------------------

export function renderBible(story) {
    const bible = isPlainObject(story) ? story.bible : null;
    if (!isPlainObject(bible)) return '';
    const chapters = Array.isArray(bible.chapters) ? bible.chapters : [];
    const index = chapters.length ? Math.max(0, Math.min(chapters.length - 1, Math.floor(Number(story.chapterIndex)) || 0)) : -1;
    const lines = [`Title: ${asText(bible.title)}`];
    for (const [label, key] of [['Premise', 'premise'], ['Setting', 'setting'], ['Tone', 'tone'], ['Conflict', 'conflict'], ['Secrets', 'secrets']]) {
        if (asText(bible[key])) lines.push(`${label}: ${asText(bible[key])}`);
    }
    const cast = Array.isArray(bible.cast) ? bible.cast : [];
    if (cast.length) {
        lines.push('Cast:');
        for (const member of cast) {
            lines.push(`- ${asText(member?.name)}${asText(member?.role) ? ` (${asText(member.role)})` : ''}${asText(member?.wants) ? ` — wants: ${asText(member.wants)}` : ''}${asText(member?.secret) ? ` — SECRET: ${asText(member.secret)}` : ''}`);
        }
    }
    if (chapters.length) {
        lines.push('Chapters:');
        chapters.forEach((chapter, i) => {
            const parts = [asText(chapter?.title) || 'Untitled'];
            for (const [label, key] of [['situation', 'situation'], ['goal', 'goal'], ['exit', 'exit'], ['clues', 'clues']]) {
                if (asText(chapter?.[key])) parts.push(`${label}: ${asText(chapter[key])}`);
            }
            lines.push(`${i === index ? '→' : ' '} ${i + 1}. ${parts.join(' · ')}`);
        });
    }
    const ledger = (Array.isArray(story.ledger) ? story.ledger : []).map(asText).filter(Boolean);
    if (ledger.length) lines.push(`So far: ${ledger.slice(-6).join(' | ')}`);
    if (asText(story.beat?.text)) lines.push(`Current beat (${asText(story.beat.status) || 'pending'}): ${asText(story.beat.text)}`);
    return lines.join('\n');
}

// --------------------------------------------------------------------------------------------
// Prepared brief: anchor + validity
// --------------------------------------------------------------------------------------------

/** Ignorable for turn ordering: system messages and SmartTavern's own ephemerals. */
const countable = message => Boolean(message) && !message.is_system && !message.smarttavern_ephemeral && !message.extra?.isSmartTavern;

/** Index/text pair identifying the reply a brief was prepared after. */
export function makeAnchor(chat, index) {
    const message = Array.isArray(chat) ? chat[index] : null;
    return message ? { anchorIndex: index, anchorText: String(message.mes ?? '') } : null;
}

/**
 * True when `prepared` may be used for the generation now starting, judged against the
 * SAVED chat (never the interceptor's copy):
 *  - the anchor message still exists at its index with exactly the same text and is a
 *    character reply;
 *  - no other character reply follows it, except — for swipe / regenerate / continue —
 *    the one reply being redone (swipes of the NEXT reply reuse the brief);
 *  - a replay whose target IS the anchor (swipe/regenerate/continue of the anchor
 *    itself) never qualifies: the brief was written for what comes AFTER it.
 * Any number of user messages may sit in between.
 */
export function isAnchorValid(prepared, chat, { type = 'normal' } = {}) {
    if (!isPlainObject(prepared) || !Array.isArray(chat)) return false;
    const index = Number(prepared.anchorIndex);
    const anchor = chat[index];
    if (!Number.isInteger(index) || !anchor || anchor.is_user || anchor.is_system) return false;
    if (String(anchor.mes ?? '') !== String(prepared.anchorText ?? '')) return false;
    const replay = type === 'swipe' || type === 'regenerate' || type === 'continue';
    let others = 0;
    let last = -1;
    for (let i = index + 1; i < chat.length; i++) {
        if (!countable(chat[i])) continue;
        last = i;
        if (!chat[i].is_user) others++;
    }
    if (replay && last < 0) return false; // the anchor itself is the generation target
    return others <= (replay ? 1 : 0);
}

/** Drops unusable fields of a stored prepared brief; null when nothing valid is left. */
export function normalizePrepared(raw) {
    if (!isPlainObject(raw) || !Number.isInteger(Number(raw.anchorIndex))) return null;
    const list = value => (Array.isArray(value) ? value : []).map(asText).filter(Boolean);
    return {
        anchorIndex: Number(raw.anchorIndex),
        anchorText: String(raw.anchorText ?? ''),
        brief: asText(raw.brief),
        musts: list(raw.musts),
        branches: (Array.isArray(raw.branches) ? raw.branches : [])
            .map(branch => ({ if: oneLine(branch?.if), then: oneLine(branch?.then) })).filter(branch => branch.if && branch.then),
        rolls: (Array.isArray(raw.rolls) ? raw.rolls : []).filter(isPlainObject),
        fields: Array.isArray(raw.fields) ? list(raw.fields) : null,
        skips: list(raw.skips),
        createdAt: Number(raw.createdAt) || 0,
        model: asText(raw.model),
        npc: isPlainObject(raw.npc) && asText(raw.npc.name) ? { name: asText(raw.npc.name), want: asText(raw.npc.want), tell: asText(raw.npc.tell) } : null,
        voice: asText(raw.voice),
        reaction: asText(raw.reaction),
        qa: isPlainObject(raw.qa) && asText(raw.qa.answer) ? { question: asText(raw.qa.question), answer: asText(raw.qa.answer) } : null,
    };
}

// --------------------------------------------------------------------------------------------
// Turn Brief compilation (reuses agent-core's compiler so the enforcement pass, the
// {{brief}} macros and the word cap behave exactly as for the legacy agent)
// --------------------------------------------------------------------------------------------

/**
 * @param {object} prepared a normalizePrepared() record
 * @param {{chosen?: number[], qa?: {question: string, answer: string}|null, char?: string,
 *   user?: string, maxWords?: number}} options `chosen` = 1-based branch numbers the fit check picked
 * @returns {{text: string, turn: object, chosen: {if: string, then: string}[]}}
 */
export function compileGmBrief(prepared, { chosen = [], qa = null, char = '', user = '', maxWords = 130 } = {}) {
    const record = normalizePrepared(prepared) ?? normalizePrepared({ anchorIndex: 0 });
    const picked = [...new Set(chosen)].map(number => record.branches[number - 1]).filter(Boolean);
    const answer = (qa && asText(qa.answer)) ? { question: asText(qa.question), answer: asText(qa.answer) } : record.qa;
    const turn = {
        rolls: record.rolls,
        answer,
        voice: record.voice ? { output: record.voice } : null,
        consults: record.reaction ? [{ mode: 'react', output: record.reaction }] : [],
        npc: record.npc,
        // Branch outcomes first: the player's message already satisfied their condition,
        // so they are the last musts the word cap may trim.
        must: [...picked.map(branch => branch.then), ...record.musts],
        guidance: record.brief,
        rulings: [],
        toolCalls: 0,
        memoryWrites: 0,
    };
    const text = compileBrief(turn, { char, user, maxWords, maxRulings: 0 });
    return { text, turn, chosen: picked };
}

/**
 * Applies a prepared brief's skip / field choices to the configured expansion blocks.
 * Only blocks whose activation is 'planner' can be skipped (same rule as the planner's
 * `## Skip`); field names are validated against the 'relevant'-mode fields.
 * @returns {{steps: object[], skipped: {name: string, reason: string}[], fields: string[]|null}}
 */
export function planFromPrepared(prepared, configured, { limit = 5, relevantFieldNames = [] } = {}) {
    const steps = (Array.isArray(configured) ? configured : []).slice(0, limit);
    const record = normalizePrepared(prepared);
    const skipped = [];
    for (const wanted of (record?.skips ?? [])) {
        const lower = wanted.toLowerCase();
        // "Name" or "Name — reason": the exact name, or the longest block name that prefixes it.
        const block = steps.filter(step => stepActivation(step) === 'planner').filter(step => {
            const name = String(step.name).trim().toLowerCase();
            return lower === name || (lower.startsWith(name) && /^[\s:—–-]/.test(lower.slice(name.length)));
        }).sort((a, b) => String(b.name).length - String(a.name).length)[0];
        if (block && !skipped.some(item => item.name === block.name)) skipped.push({ name: block.name, reason: 'skipped by the GM' });
    }
    let fields = null;
    if (record && Array.isArray(record.fields) && relevantFieldNames.length) {
        const known = new Map(relevantFieldNames.map(name => [String(name).trim().toLowerCase(), String(name)]));
        fields = uniqueCaseInsensitive(record.fields.map(item => known.get(item.toLowerCase())).filter(Boolean));
    }
    return { steps: steps.filter(step => !skipped.some(item => item.name === step.name)), skipped, fields };
}

// --------------------------------------------------------------------------------------------
// Store normalization + transcript cap + renderers
// --------------------------------------------------------------------------------------------

/** Canonical chatMetadata.smarttavern.gm shape (mutates and returns `store`). */
export function normalizeGmStore(store) {
    const target = isPlainObject(store) ? store : {};
    target.prepared = target.prepared ? normalizePrepared(target.prepared) : null;
    // The brief that was in force when the newest reply was generated: swipes of that reply
    // are a turn of the PREVIOUS anchor, whose brief the newer tick has already replaced.
    target.previous = target.previous ? normalizePrepared(target.previous) : null;
    target.clocks = (Array.isArray(target.clocks) ? target.clocks : []).map(normalizeClock).filter(Boolean).slice(0, CLOCK_MAX);
    target.agendas = normalizeAgendas(target.agendas);
    target.pendingQuestion = isPlainObject(target.pendingQuestion) && asText(target.pendingQuestion.question)
        ? { question: asText(target.pendingQuestion.question), at: Number(target.pendingQuestion.at) || 0 } : null;
    target.tick = Number.isFinite(Number(target.tick)) ? Math.max(0, Math.floor(Number(target.tick))) : 0;
    target.transcript = capTranscript(target.transcript);
    target.status = isPlainObject(target.status)
        ? { at: Number(target.status.at) || 0, ok: target.status.ok !== false, text: asText(target.status.text) } : null;
    return target;
}

/** Keeps the newest entries, each trimmed — the stored transcript must stay small. */
export function capTranscript(entries, { maxEntries = TRANSCRIPT_MAX_ENTRIES, maxChars = TRANSCRIPT_TEXT_CHARS } = {}) {
    return (Array.isArray(entries) ? entries : []).filter(isPlainObject).slice(-maxEntries).map(entry => ({
        title: truncate(asText(entry.title), 200),
        ...(asText(entry.text) ? { text: truncate(asText(entry.text), maxChars) } : {}),
        tone: ['ok', 'info', 'error'].includes(entry.tone) ? entry.tone : 'info',
    }));
}

/** Extracts the answer from askPlannerUser's "Question: …\nAnswer: …" text. */
export function parseQuestionAnswer(text, fallbackQuestion = '') {
    const match = String(text ?? '').match(/^Question:\s*([\s\S]*?)\nAnswer:\s*([\s\S]*)$/);
    const answer = asText(match?.[2]);
    return answer ? { question: asText(match[1]) || asText(fallbackQuestion), answer } : null;
}

export function formatClock(timestamp) {
    const date = new Date(Number(timestamp) || 0);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Plain-text view of a prepared brief (panel, popup, next tick's continuity block). */
export function renderPrepared(prepared) {
    const record = normalizePrepared(prepared);
    if (!record) return '';
    const lines = [`Brief: ${record.brief || '(none)'}`];
    if (record.musts.length) lines.push(`Must:\n${record.musts.map(item => `- ${item}`).join('\n')}`);
    if (record.branches.length) lines.push(`Branches:\n${record.branches.map((branch, i) => `${i + 1}. if ${branch.if} → ${branch.then}`).join('\n')}`);
    if (record.rolls.length) lines.push(`Dice (rolled by code): ${record.rolls.map(roll => `${asText(roll.text)}${roll.reason ? ` "${roll.reason}"` : ''}${roll.outcome ? ` → ${roll.outcome}` : ''}`).join('; ')}`);
    if (record.npc) lines.push(`New NPC: ${record.npc.name} — wants: ${record.npc.want}. Tell: ${record.npc.tell}.`);
    if (record.fields) lines.push(`Profile fields: ${record.fields.join(', ') || '(none)'}`);
    if (record.skips.length) lines.push(`Skip blocks: ${record.skips.join(', ')}`);
    if (record.qa) lines.push(`Player answered "${record.qa.question}": ${record.qa.answer}`);
    return lines.join('\n');
}
