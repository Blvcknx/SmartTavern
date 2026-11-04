// SmartTavern — thinking agent tool registry (MCP-shaped, local implementations).
// Every tool is a pure declaration plus an ST-bound `run`; the loop (agent.js) drives
// them through executeToolCall, which enforces per-turn caps and argument validation
// and turns every failure into an {"error": "..."} result the agent can read — the
// loop never crashes on a bad tool call.
//
// Memory tools write ONLY into the chat-bound lorebook (the chat's single binding
// slot, shared with the user — ownership is per-entry via the `smarttavern` flag and
// the "[ST] " comment prefix) and ONLY to agent-owned entries for update/delete.
import { getContext } from '../../../../extensions.js';
import {
    world_names, selected_world_info, world_info, METADATA_KEY,
    createNewWorldInfo, createWorldInfoEntry, deleteWorldInfoEntry,
    saveWorldInfo, loadWorldInfo,
} from '../../../../world-info.js';
import {
    getSettings, getChatStore, saveChatStore, cardText, chatExcerpt,
    getMainCharacter, isPlainObject, clampInt, warn, captureChatScope,
} from './state.js';
import { generateWithRetry, withInternalGeneration, isAbortError, throwIfAborted } from './gen.js';
import { serializeProfile, extractJson } from './profiles.js';
import { parseDice, rollDice, agentRollExtreme, validateToolArgs, looksRefusal, wordTrim, truncate } from './agent-core.js';
import { consultOracle } from './rulings.js';

// --------------------------------------------------------------------------------------------
// Chat lorebook helpers (the chat binds exactly ONE book; SmartTavern shares it)
// --------------------------------------------------------------------------------------------

export const OWNERSHIP_PREFIX = '[ST] ';
const MEMORY_CONTENT_MAX_WORDS = 80;

/** Scene facts are grounded in saved messages; edited/deleted/swiped sources stop applying.
 * Keep earlier versions so rewinding a conversation restores its earlier facts. */
export function getSceneState(chat = getContext().chat) {
    const state = Object.create(null);
    const saved = getContext().chat ?? [];
    const history = getChatStore().agentScene;
    for (const fact of (Array.isArray(history) ? [...history].sort((a, b) => a?.sourceIndex - b?.sourceIndex) : [])) {
        if (!fact || saved[fact.sourceIndex]?.mes !== fact.sourceText
            || !chat?.some(message => !message.is_system && message.mes === fact.sourceText)) continue;
        if (fact.value) state[fact.key] = fact.value;
        else delete state[fact.key];
    }
    return state;
}

const EXPERT_SCHEMA = {
    name: 'smarttavern_expert', strict: false,
    value: {
        type: 'object',
        properties: {
            assessment: { type: 'string' },
            reasons: { type: 'array', items: { type: 'string' } },
            uncertainties: { type: 'array', items: { type: 'string' } },
            alternatives: { type: 'array', items: { type: 'string' } },
        },
        required: ['assessment', 'reasons', 'uncertainties', 'alternatives'],
        additionalProperties: false,
    },
};

function expertAnswer(result) {
    const answer = extractJson(result?.content);
    return isPlainObject(answer) && typeof answer.assessment === 'string' && answer.assessment.trim()
        && ['reasons', 'uncertainties', 'alternatives'].every(key => Array.isArray(answer[key])
            && answer[key].every(item => typeof item === 'string')) ? answer : null;
}

/** True only for entries SmartTavern created (flag survives saves; prefix is the fallback). */
export function isAgentOwnedEntry(entry) {
    if (!entry) return false;
    if (entry.smarttavern === true) return true;
    return String(entry.comment ?? '').startsWith(OWNERSHIP_PREFIX);
}

/** ST's /getchatbook naming convention for the chat-bound lorebook. */
function chatBookNameFor(chatId) {
    return `Chat Book ${chatId}`.replace(/[^a-z0-9 -]/gi, '_').replace(/_{2,}/g, '_').substring(0, 64);
}

function currentChatId() {
    const context = getContext();
    return context.chatId ?? (typeof context.getCurrentChatId === 'function' ? context.getCurrentChatId() : null);
}

async function persistMetadata() {
    const context = getContext();
    if (typeof context.saveMetadata === 'function') await context.saveMetadata();
}

/**
 * Returns the chat-bound lorebook name, creating and binding a book only when the chat
 * has no valid binding. NEVER overwrites an existing binding and never recreates a
 * book that already exists (createNewWorldInfo refuses duplicates anyway).
 * @returns {Promise<string|null>}
 */
export async function ensureChatBook(ctx) {
    const context = getContext();
    const chatId = currentChatId();
    if (!chatId) return null;
    const metadata = context.chatMetadata;
    if (!isPlainObject(metadata)) return null;

    const bound = metadata[METADATA_KEY];
    if (bound) return bound;

    const base = chatBookNameFor(chatId);
    let name = base;
    for (let suffix = 1; world_names.includes(name); suffix++) {
        const ending = ` (${suffix})`;
        name = base.slice(0, 64 - ending.length) + ending;
    }
    assertToolCurrent(ctx);
    const created = await createNewWorldInfo(name, { interactive: false });
    assertToolCurrent(ctx);
    if (!created) {
        warn(`could not create the chat lorebook "${name}"`);
        return null;
    }
    metadata[METADATA_KEY] = name;
    await persistMetadata();
    return name;
}

/** The lorebooks active for this chat: chat book + global select + the character's books. */
export function activeBookNames() {
    const context = getContext();
    const names = new Set();
    const chatBook = isPlainObject(context.chatMetadata) ? context.chatMetadata[METADATA_KEY] : null;
    if (chatBook && world_names.includes(chatBook)) names.add(chatBook);
    for (const name of selected_world_info) if (name) names.add(name);
    const char = getMainCharacter();
    const baseWorld = char?.data?.extensions?.world;
    if (baseWorld) names.add(baseWorld);
    // charLore entries are keyed by the character's avatar filename (see getCharaFilename).
    const fileName = char?.avatar ? String(char.avatar).replace(/\.[^/.]+$/, '') : null;
    const extra = fileName ? world_info?.charLore?.find(e => e?.name === fileName) : null;
    for (const book of (Array.isArray(extra?.extraBooks) ? extra.extraBooks : [])) names.add(book);
    return [...names];
}

// --------------------------------------------------------------------------------------------
// Memory search / undo log
// --------------------------------------------------------------------------------------------

function tokenize(query) {
    const value = String(query ?? '').toLowerCase();
    const tokens = new Set();
    for (const word of value.split(/[^\p{L}\p{N}]+/u)) {
        if (word.length >= 2) tokens.add(word);
    }
    // CJK queries rarely split on punctuation: add single characters as fallbacks.
    for (const ch of value) {
        if (/[\u2e80-\ufaff]/.test(ch)) tokens.add(ch);
    }
    return [...tokens];
}

/**
 * Simple scored match over every active lorebook: +5 per primary/secondary key hit,
 * +1 per content token. Disabled entries are skipped. Best 5 wins.
 */
export async function searchMemory(query) {
    const tokens = tokenize(query);
    if (!tokens.length) return [];
    const hits = [];
    for (const name of activeBookNames()) {
        const data = await loadWorldInfo(name);
        if (!data?.entries) continue;
        for (const entry of Object.values(data.entries)) {
            if (!entry || entry.disable) continue;
            let score = 0;
            const content = String(entry.content ?? '').toLowerCase();
            for (const key of [...(entry.key ?? []), ...(entry.keysecondary ?? [])]) {
                const k = String(key ?? '').trim().toLowerCase();
                if (k && tokens.some(t => k.includes(t) || t.includes(k))) score += 5;
            }
            for (const token of tokens) if (content.includes(token)) score += 1;
            if (score > 0) {
                hits.push({
                    book: name,
                    uid: entry.uid,
                    title: String(entry.comment ?? '').replace(OWNERSHIP_PREFIX, '') || truncate(String(entry.content ?? ''), 60),
                    content: String(entry.content ?? ''),
                    score,
                    agent: isAgentOwnedEntry(entry),
                });
            }
        }
    }
    hits.sort((a, b) => b.score - a.score);
    return hits.slice(0, 5);
}

/** The chat store's agent memory undo log (capped, newest last). */
export function memoryLog() {
    const store = getChatStore();
    if (!Array.isArray(store.agentMemoryLog)) store.agentMemoryLog = [];
    return store.agentMemoryLog;
}

function pushMemoryLog(record) {
    const log = memoryLog();
    log.push(record);
    while (log.length > 50) log.shift();
    saveChatStore();
}

/**
 * Reverses one undo-log row: create → delete, delete → recreate from the snapshot,
 * update → restore the previous fields. The row is dropped either way.
 */
export async function undoMemoryLogEntry(index) {
    const isCurrentChat = captureChatScope();
    const log = memoryLog();
    const record = log[Number(index)];
    if (!record) return false;
    let undone = false;
    try {
        const data = await loadWorldInfo(record.book);
        if (!isCurrentChat()) return false;
        if (record.after && JSON.stringify(data?.entries?.[record.uid]) !== JSON.stringify(record.after)) return false;
        if (data?.entries) {
            if (record.action === 'create') {
                if (data.entries[record.uid] && isAgentOwnedEntry(data.entries[record.uid])) {
                    delete data.entries[record.uid];
                    await saveWorldInfo(record.book, data, true);
                    undone = true;
                }
            } else if (record.action === 'delete') {
                const before = isPlainObject(record.before) ? record.before : {};
                if (data.entries[record.uid] || !isAgentOwnedEntry(before)) return false;
                data.entries[record.uid] = { ...structuredClone(before), uid: record.uid };
                await saveWorldInfo(record.book, data, true);
                undone = true;
            } else if (record.action === 'update') {
                const current = data.entries[record.uid];
                if (current && isAgentOwnedEntry(current)) {
                    Object.assign(current, structuredClone(isPlainObject(record.before) ? record.before : {}));
                    await saveWorldInfo(record.book, data, true);
                    undone = true;
                }
            }
        }
    } catch (error) {
        warn('memory undo failed', error);
    }
    if (undone && isCurrentChat()) {
        log.splice(Number(index), 1);
        saveChatStore();
    }
    return undone;
}

/** Every agent-owned entry across the chat's active books (panel + /smarttavern-memory). */
export async function listAgentOwnedEntries() {
    const out = [];
    for (const name of activeBookNames()) {
        const data = await loadWorldInfo(name);
        for (const entry of Object.values(data?.entries ?? {})) {
            if (!entry || !isAgentOwnedEntry(entry)) continue;
            out.push({
                book: name,
                uid: entry.uid,
                title: String(entry.comment ?? '').replace(OWNERSHIP_PREFIX, '') || `(uid ${entry.uid})`,
                keys: Array.isArray(entry.key) ? entry.key : [],
                content: String(entry.content ?? ''),
            });
        }
    }
    return out;
}

// --------------------------------------------------------------------------------------------
// Shared write path (create / update / delete / NPC persist)
// --------------------------------------------------------------------------------------------

function assertToolCurrent(ctx) {
    throwIfAborted(ctx?.signal);
    if (ctx?.isCurrentChat && !ctx.isCurrentChat()) throw new DOMException('Chat changed', 'AbortError');
}

function memoryGate(ctx) {
    assertToolCurrent(ctx);
    if (ctx.dryRun) return '{"error":"memory writes are unavailable during a dry run"}';
    const settings = ctx.settings;
    if (settings.agentToolsEnabled?.memory === false) return '{"error":"memory tools are disabled by the user"}';
    if (settings.agentMemoryMode === 'off') return '{"error":"memory writes are disabled (agentMemoryMode is off)"}';
    const cap = clampInt(settings.agentMemoryWritesPerTurn, 0, 10, 3);
    if ((ctx.turn.memoryWrites ?? 0) >= cap) {
        return `{"error":"per-turn memory write budget (${cap}) reached — finish without writing"}`;
    }
    return null;
}

async function confirmMemoryWrite(title, content, ctx) {
    const context = getContext();
    const body = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = `Allow the agent to write memory? — ${title}`;
    const pre = document.createElement('pre');
    pre.textContent = content;
    body.append(heading, pre);
    const popup = new context.Popup(body, context.POPUP_TYPE.CONFIRM, '', { wide: true });
    const close = () => { void popup.complete(context.POPUP_RESULT.CANCELLED); };
    assertToolCurrent(ctx);
    ctx.pauseClock?.();
    ctx.signal?.addEventListener('abort', close, { once: true });
    try {
        const result = await popup.show();
        assertToolCurrent(ctx);
        return result === context.POPUP_RESULT.AFFIRMATIVE;
    } finally {
        ctx.signal?.removeEventListener('abort', close);
        ctx.resumeClock?.();
    }
}

function normalizeContent(content) {
    return wordTrim(String(content ?? '').trim(), MEMORY_CONTENT_MAX_WORDS);
}

function normalizeKeys(keys) {
    const list = Array.isArray(keys) ? keys : [];
    const out = [];
    for (const key of list) {
        const value = String(key ?? '').trim();
        if (value && !out.includes(value)) out.push(value);
    }
    return out;
}

/** "Book Name #12" | "#12" | 12 → { book, uid } (book defaults to the chat book). */
function parseMemoryId(raw) {
    const value = String(raw ?? '').trim();
    const match = value.match(/^(?:(.+?)\s*#\s*)?(\d+)$/);
    if (!match) return null;
    return { book: match[1] || null, uid: Number(match[2]) };
}

/**
 * Creates an agent-owned entry in the chat-bound lorebook. Shared by memory_create and
 * introduce_npc persistence.
 */
async function createMemoryEntry(ctx, { title, keys, content }) {
    const gate = memoryGate(ctx);
    if (gate) return { error: gate };
    const cleanTitle = String(title ?? '').trim().slice(0, 100 - OWNERSHIP_PREFIX.length);
    const cleanContent = normalizeContent(content);
    if (!cleanTitle || !cleanContent) return { error: '{"error":"title and content are required"}' };
    const book = await ensureChatBook(ctx);
    if (!book) return { error: '{"error":"no chat lorebook available in this context"}' };
    if (ctx.settings.agentMemoryMode === 'confirm') {
        const allowed = await confirmMemoryWrite(cleanTitle, cleanContent, ctx);
        if (!allowed) return { error: '{"error":"the user declined this memory write"}' };
    }
    const data = await loadWorldInfo(book);
    assertToolCurrent(ctx);
    if (!data?.entries) return { error: '{"error":"chat lorebook could not be loaded"}' };
    const entry = createWorldInfoEntry(book, data);
    entry.key = normalizeKeys(keys);
    entry.comment = `${OWNERSHIP_PREFIX}${cleanTitle}`;
    entry.content = cleanContent;
    entry.smarttavern = true;
    await saveWorldInfo(book, data, true);
    assertToolCurrent(ctx);
    ctx.turn.memoryWrites = (ctx.turn.memoryWrites ?? 0) + 1;
    pushMemoryLog({ at: Date.now(), action: 'create', book, uid: entry.uid, title: cleanTitle, after: structuredClone(entry) });
    return { entry, book };
}

// --------------------------------------------------------------------------------------------
// Nested LLM call helpers (consult_character, introduce_npc)
// --------------------------------------------------------------------------------------------

const CONSULT_MODES = {
    feel: 'what they feel right now but would NOT say aloud (hidden emotion, subtext)',
    react: 'how they would visibly react to the situation in the focus line',
    backstory: 'what in their past explains their reaction to the focus line',
};

async function consultCharacter(args, ctx) {
    const settings = ctx.settings;
    const mode = CONSULT_MODES[args.mode] ? args.mode : 'feel';
    const focus = String(args.focus ?? '').trim();
    const charName = ctx.char?.name ?? 'the character';
    const definitions = serializeProfile(ctx.profile, settings.fields ?? []);
    const excerpt = chatExcerpt(ctx.chat, clampInt(settings.agentLookback, 0, 100, 8));
    // Saved rulings about this character: momentary reactions must respect them.
    const established = (Array.isArray(ctx.turn?.rulings) ? ctx.turn.rulings : [])
        .map(record => String(record?.ruling ?? '').trim())
        .filter(Boolean);
    const prompt = [
        `You ARE ${charName} in an ongoing interactive story. Speak in first person, as ${charName}.`,
        '',
        definitions ? `Your living profile:\n${definitions}` : `Your character card:\n${cardText(ctx.char)}`,
        '',
        excerpt ? `Recent conversation:\n${excerpt}` : '',
        established.length ? `Established behavior (stay consistent):\n${established.map(line => `- ${line}`).join('\n')}` : '',
        focus ? `Situation to consider: ${focus}` : '',
        '',
        `Task: ${CONSULT_MODES[mode]}. 1–4 sentences, at most 80 words, plain first-person prose. No preamble, no headings, no out-of-character commentary.`,
    ].filter(Boolean).join('\n');
    const result = await withInternalGeneration(() => generateWithRetry({
        signal: ctx.signal,
        profileId: settings.innerVoiceProfileId || settings.agentProfileId || '',
        systemPrompt: `You are the inner voice of ${charName}. You stay fully in character and never moralize or break the fourth wall.`,
        prompt,
        maxTokens: settings.agentAuxMaxTokens,
    }));
    throwIfAborted(ctx.signal);
    const output = wordTrim(String(result?.content ?? '').trim(), 80);
    if (!output || looksRefusal(output, { inCharacter: true })) {
        return { refused: true, output: '' };
    }
    const record = { mode, focus, output };
    ctx.turn.consults.push(record);
    if (mode === 'feel') ctx.turn.voice = { output };
    return { refused: false, output, record };
}

const NPC_SCHEMA = {
    name: 'smarttavern_npc',
    description: 'A compact recurring side character',
    strict: false,
    value: {
        type: 'object',
        properties: {
            name: { type: 'string', description: 'Full name' },
            want: { type: 'string', description: 'One line: what they want' },
            tell: { type: 'string', description: 'One line: their tell / mannerism' },
        },
        required: ['name', 'want', 'tell'],
        additionalProperties: false,
    },
};

async function inventNpc(args, ctx) {
    const settings = ctx.settings;
    const charName = ctx.char?.name ?? 'the character';
    const definitions = serializeProfile(ctx.profile, settings.fields ?? []);
    const excerpt = chatExcerpt(ctx.chat, clampInt(settings.agentLookback, 0, 100, 8));
    const prompt = [
        `Invent ONE compact side character for an ongoing interactive story, grounded in the setting below. They should fit ${charName}'s world and be useful as a RECURRING character.`,
        '',
        definitions ? `Setting context (living profile of ${charName}):\n${definitions}` : `Setting context:\n${cardText(ctx.char)}`,
        '',
        excerpt ? `Recent conversation:\n${excerpt}` : '',
        '',
        `Role hint: ${String(args.role_hint ?? '').trim()}`,
        '',
        'Return ONLY the JSON object.',
    ].filter(Boolean).join('\n');
    const result = await withInternalGeneration(() => generateWithRetry({
        signal: ctx.signal,
        profileId: settings.agentProfileId || '',
        systemPrompt: 'You are a character designer for an interactive fiction platform. Output only the requested JSON object.',
        prompt,
        maxTokens: settings.agentAuxMaxTokens,
        jsonSchema: NPC_SCHEMA,
        validate: (candidate) => Boolean(extractJson(candidate?.content)?.name),
    }));
    throwIfAborted(ctx.signal);
    if (looksRefusal(result?.content)) return null;
    return extractJson(result?.content);
}

// --------------------------------------------------------------------------------------------
// Tool registry
// --------------------------------------------------------------------------------------------

export const TOOL_REGISTRY = [
    {
        name: 'roll_dice',
        description: 'Roll a d20 for an uncertain, possible action. Only the extremes are fixed: 1 -- complete failure; 20 -- critical success. Define the difficulty yourself before rolling, based on the situation, abilities and stakes. Interpret results 2-19 yourself against that difficulty, and put the concrete consequence in your brief. Code does not decide intermediate success, failure or thresholds. The roll is binding; never reroll or soften an extreme.',
        usage: '<tool name="roll_dice">{"reason":"pick the lock","difficulty":"A rusty lock, difficult for an untrained character; decide whether the result overcomes it."}</tool>',
        inputSchema: {
            type: 'object',
            required: ['reason', 'difficulty'],
            properties: {
                dice: { type: 'string', enum: ['d20', '1d20'], description: 'Optional; always an unmodified d20' },
                reason: { type: 'string', minLength: 3, maxLength: 140 },
                mode: { enum: ['advantage', 'disadvantage'], description: 'd20 only' },
                difficulty: { type: 'string', minLength: 3, maxLength: 1000, description: 'Your assessment of the action difficulty; code does not interpret this text' },
            },
        },
        mode: 'read',
        maxPerTurn: 3,
        enabled: settings => settings.agentToolsEnabled?.roll_dice !== false,
        run(args, ctx) {
            const dice = parseDice(args.dice ?? 'd20');
            if (!dice || dice.count !== 1 || dice.sides !== 20 || dice.mod !== 0) return { ok: false, result: '{"error":"agent rolls use an unmodified d20: 1 -- complete failure; 20 -- critical success"}' };
            const prior = ctx.turn.rolls.find(record => record.spec === dice.text && record.reason === String(args.reason).trim());
            if (prior) return { ok: true, result: `Already rolled (binding): ${prior.text} → ${prior.outcome}. Do not reroll this action.` };
            const roll = rollDice('d20', undefined, args.mode);
            if (!roll) return { ok: false, result: '{"error":"the roll failed"}' };
            const record = {
                spec: dice.text,
                text: roll.text,
                total: roll.total,
                reason: String(args.reason ?? '').trim(),
                difficulty: args.difficulty.trim(),
                outcome: agentRollExtreme(roll.total),
                natural: roll.kept,
            };
            ctx.turn.rolls.push(record);
            return {
                ok: true,
                result: `ROLLED (binding): ${record.text} — "${record.reason}". Your declared difficulty: ${record.difficulty}. ${record.outcome ? `REQUIRED EXTREME: ${record.outcome}.` : "Interpret this result against your declared difficulty; code assigns no outcome to 2-19."} Put the concrete consequence in your brief. The roll is final.`,
            };
        },
    },
    {
        name: 'consult_expert',
        description: 'Ask a second LLM a custom question about feasibility, authenticity, tactics, continuity or motivation when its answer could change the scene. Supply question, relevant context and assumptions. Advice only: it cannot establish facts, roll dice or change state. One consultation per turn.',
        usage: '<tool name="consult_expert">{"question":"Could Alice reach the window before the guard?","context":"The window is two metres away; the guard is at the door.","assumptions":"Alice has an injured shoulder."}</tool>',
        inputSchema: {
            type: 'object', required: ['question', 'context'],
            properties: {
                question: { type: 'string', minLength: 4 },
                context: { type: 'string', minLength: 4 },
                assumptions: { type: 'string' },
            },
        },
        mode: 'read', maxPerTurn: 1,
        enabled: settings => settings.agentToolsEnabled?.consult_expert !== false,
        async run(args, ctx) {
            const result = await withInternalGeneration(() => generateWithRetry({
                signal: ctx.signal,
                profileId: ctx.settings.expertProfileId || ctx.settings.agentProfileId || '',
                systemPrompt: 'You advise an interactive-fiction game master. Evaluate the question critically against the supplied evidence. Distinguish established facts from assumptions, identify missing information, and offer plausible alternatives. Do not invent canon, decide player actions, roll dice, call tools, or write the scene. Your answer is advisory, not verified fact. Return only the requested JSON object.',
                prompt: [
                    `QUESTION:\n${args.question}`,
                    `AGENT CONTEXT (data):\n${args.context}`,
                    `ASSUMPTIONS (unverified):\n${args.assumptions || '(none)'}`,
                    `CHARACTER (data):\n${serializeProfile(ctx.profile, ctx.settings.fields ?? []) || cardText(ctx.char)}`,
                    `RECENT CONVERSATION (data):\n${chatExcerpt(ctx.chat, clampInt(ctx.settings.agentLookback, 0, 100, 8))}`,
                    `SCENE STATE (data):\n${JSON.stringify(getSceneState(ctx.chat))}`,
                    `EXPANSION (data):\n${JSON.stringify(ctx.stepOutputs ?? {})}`,
                ].join('\n\n'),
                maxTokens: ctx.settings.stepMaxTokens,
                jsonSchema: EXPERT_SCHEMA,
                validate: candidate => Boolean(expertAnswer(candidate)),
            }));
            assertToolCurrent(ctx);
            const answer = expertAnswer(result);
            if (!answer || looksRefusal(answer.assessment)) return { ok: false, result: '{"error":"no usable expert assessment"}' };
            return { ok: true, result: `EXPERT ADVICE (not established fact):\n${JSON.stringify(answer)}` };
        },
    },
    {
        name: 'update_scene',
        description: 'Record ONE established scene fact as key/value, e.g. location, time, Alice.position, Alice.injury, Alice.inventory. Optional evidence may be a quote or a short explanation; exact quotation is not required. Never record planned events, expansion speculation or dice consequences before they appear in chat. Use remove:true to remove an obsolete fact. Scene state is supplied in every planning prompt.',
        usage: '<tool name="update_scene">{"key":"Alice.position","value":"beside the window","evidence":"Alice stood beside the window."}</tool>',
        inputSchema: {
            type: 'object', required: ['key'],
            properties: {
                key: { type: 'string', minLength: 1, maxLength: 100 },
                value: { type: 'string', minLength: 1, maxLength: 1000 },
                remove: { type: 'boolean' },
                evidence: { type: 'string', description: 'Optional supporting quote or explanation; paraphrases are accepted.' },
            },
        },
        mode: 'write', maxPerTurn: 3,
        enabled: settings => settings.agentToolsEnabled?.scene !== false,
        run(args, ctx) {
            assertToolCurrent(ctx);
            if (args.remove !== true && !args.value?.trim()) return { ok: false, result: '{"error":"provide a value or remove:true"}' };
            const saved = getContext().chat ?? [];
            const evidence = args.evidence?.trim() ?? '';
            let sourceIndex = -1;
            let latestIndex = -1;
            for (let index = saved.length - 1; index >= 0; index--) {
                const message = saved[index];
                if (!message?.is_system && typeof message?.mes === 'string'
                    && ctx.chat?.some(visible => !visible.is_system && visible.mes === message.mes)) {
                    if (latestIndex < 0) latestIndex = index;
                    if (evidence && message.mes.includes(evidence)) {
                        sourceIndex = index;
                        break;
                    }
                }
            }
            // Prefer a quoted source when available; otherwise anchor to the current
            // conversation revision so paraphrases and omitted evidence support rewinds.
            if (sourceIndex < 0) sourceIndex = latestIndex;
            if (sourceIndex < 0) return { ok: false, result: '{"error":"no conversation message available to attach the scene update to"}' };
            const store = getChatStore();
            if (!Array.isArray(store.agentScene)) store.agentScene = [];
            const key = args.key.trim();
            const value = args.remove === true ? '' : args.value.trim();
            // Replace only the same key/source revision; retain older messages for rewinds.
            const fact = { key, value, evidence, sourceIndex, sourceText: saved[sourceIndex].mes };
            const existing = store.agentScene.findIndex(entry => entry.key === key && entry.sourceIndex === sourceIndex && entry.sourceText === fact.sourceText);
            if (existing < 0) store.agentScene.push(fact);
            else store.agentScene[existing] = fact;
            saveChatStore();
            return { ok: true, result: `Scene fact ${value ? 'recorded' : 'removed'}: ${key}${value ? ` = ${value}` : ''}. Established facts only; planned outcomes remain in the brief.` };
        },
    },
    {
        name: 'consult_character',
        description: 'Ask the target character for their inner take. feel = what they feel but won\'t say (hidden emotion); react = how they\'d visibly react to a situation; backstory = what in their past explains the reaction.',
        usage: '<tool name="consult_character">{"mode":"feel","focus":"the stranger\'s invitation"}</tool>',
        inputSchema: {
            type: 'object',
            required: ['mode'],
            properties: {
                mode: { enum: ['feel', 'react', 'backstory'] },
                focus: { type: 'string', maxLength: 300, description: 'The situation to consider (required for react/backstory)' },
            },
        },
        mode: 'read',
        maxPerTurn: 1,
        enabled: settings => settings.agentToolsEnabled?.consult_character !== false,
        async run(args, ctx) {
            const { refused, output, record } = await consultCharacter(args, ctx);
            if (refused) return { ok: false, result: '{"error":"no in-character answer was produced — continue without it"}' };
            return { ok: true, result: `${ctx.char?.name ?? 'The character'} (${record.mode}):\n${output}` };
        },
    },
    {
        name: 'character_ruling',
        description: 'Ask the character oracle how the character would behave in a KIND of situation; the answer is saved as a reusable behavioral ruling that later turns surface automatically. For durable character behavior only — momentary feelings use consult_character, world facts use the memory tools. The oracle reuses an existing matching ruling instead of answering again, so consult sparingly.',
        usage: '<tool name="character_ruling">{"question":"How does she behave when asked about her past?","situation":"A stranger asks about the fire at the mill"}</tool>',
        inputSchema: {
            type: 'object',
            required: ['question'],
            properties: {
                question: { type: 'string', minLength: 4, maxLength: 300, description: 'The behavioral question, phrased for reuse (a KIND of situation, not this exact one)' },
                situation: { type: 'string', maxLength: 300, description: 'Optional current-situation context grounding the question' },
                save: { type: 'boolean', description: 'default true — store the ruling in the chat ledger for reuse' },
            },
        },
        mode: 'read', // consults (and reuses) even during dry runs; consultOracle itself never persists then
        maxPerTurn: settings => clampInt(settings.agentConsultPerTurn, 0, 4, 2),
        enabled: settings => settings.agentRulingsEnabled !== false && settings.agentToolsEnabled?.ruling !== false,
        async run(args, ctx) {
            const outcome = await consultOracle({
                question: args.question,
                situation: args.situation,
                save: args.save !== false,
                char: ctx.char,
                profile: ctx.profile,
                chat: ctx.chat,
                settings: ctx.settings,
                signal: ctx.signal,
                isCurrentChat: ctx.isCurrentChat,
                dryRun: ctx.dryRun,
                isReplay: ctx.isReplay,
            });
            if (outcome?.error) return { ok: false, result: `{"error":"${String(outcome.error).replace(/"/g, "'")}"}` };
            const ruling = outcome.ruling;
            // Carry the ruling verbatim into the brief even if auto-surface missed it.
            if (ruling && Array.isArray(ctx.turn?.rulings)) {
                const dedupeKey = Number(ruling.id) > 0 ? `id:${ruling.id}` : `text:${ruling.ruling}`;
                if (!ctx.turn.rulings.some(record => (Number(record?.id) > 0 ? `id:${record.id}` : `text:${record?.ruling}`) === dedupeKey)) {
                    ctx.turn.rulings.push({ id: Number(ruling.id) || 0, ruling: String(ruling.ruling ?? '').trim() });
                }
            }
            // Reuses (and fresh creates) were already accounted for this turn.
            if (ruling && Number(ruling.id) > 0 && !ctx.dryRun && ctx.turn?.rulingUsesCounted instanceof Set) {
                ctx.turn.rulingUsesCounted.add(Number(ruling.id));
            }
            return { ok: true, result: outcome.text };
        },
    },
    {
        name: 'ask_user',
        description: 'Ask the user ONE question when a decision truly belongs to them and the story cannot proceed sensibly without it. Optional 2–4 choice buttons; free_text adds a text answer.',
        usage: '<tool name="ask_user">{"question":"Follow the stranger into the alley?","options":["Yes, quietly","Refuse and leave"],"free_text":true}</tool>',
        inputSchema: {
            type: 'object',
            required: ['question'],
            properties: {
                question: { type: 'string', minLength: 4, maxLength: 300 },
                options: { type: 'array', items: 'string', minItems: 2, maxItems: 4 },
                free_text: { type: 'boolean' },
            },
        },
        mode: 'interactive',
        maxPerTurn: settings => clampInt(settings.agentAskPerTurn, 0, 3, 1),
        enabled: settings => settings.agentAskUser !== false && settings.agentToolsEnabled?.ask_user !== false,
        async run(args, ctx) {
            const question = String(args.question ?? '').trim();
            const options = (Array.isArray(args.options) ? args.options : []).map(o => String(o ?? '').trim()).filter(Boolean).slice(0, 4);
            const freeText = args.free_text !== false || !options.length;

            // Swipes/regenerates reuse the answer cached for the same user message.
            const cacheKey = ctx.answerKey();
            if (cacheKey && ctx.cachedAnswer(cacheKey)) {
                const cached = ctx.cachedAnswer(cacheKey);
                ctx.turn.answer = { question: cached.question, answer: cached.answer };
                return { ok: true, result: `The user already answered this question: "${cached.answer || '(no answer given)'}"` };
            }
            if (ctx.isReplay || ctx.dryRun) {
                return { ok: false, result: '{"error":"ask_user is unavailable for swipes/regenerations and no cached answer exists for this message — proceed without asking"}' };
            }

            // The timeout clock pauses while the user reads the popup.
            ctx.pauseClock?.();
            let answer = '';
            try {
                answer = await askUserPopup(ctx, question, options, freeText);
            } finally {
                ctx.resumeClock?.();
            }
            assertToolCurrent(ctx);
            ctx.turn.answer = { question, answer };
            if (cacheKey) ctx.rememberAnswer(cacheKey, { question, answer });
            if (!answer) {
                return { ok: true, result: 'The user skipped the question (no answer given). Proceed without assuming their decision.' };
            }
            return { ok: true, result: `THE USER ANSWERED: "${answer}"` };
        },
    },
    {
        name: 'introduce_npc',
        description: 'Invent a compact new side character (name, one-line want, one-line tell/mannerism) grounded in the setting, suitable for recurring. Optionally persists them to memory so they recur.',
        usage: '<tool name="introduce_npc">{"role_hint":"a night porter who owes a favor"}</tool>',
        inputSchema: {
            type: 'object',
            required: ['role_hint'],
            properties: {
                role_hint: { type: 'string', minLength: 3, maxLength: 200 },
                persist: { type: 'boolean', description: 'default true — store as a memory entry keyed on the name' },
            },
        },
        mode: 'read',
        maxPerTurn: 1,
        enabled: settings => settings.agentToolsEnabled?.introduce_npc !== false,
        async run(args, ctx) {
            const npc = await inventNpc(args, ctx);
            const name = String(npc?.name ?? '').trim();
            if (!name) return { ok: false, result: '{"error":"no usable NPC was produced — continue without one"}' };
            const want = String(npc?.want ?? '').trim();
            const tell = String(npc?.tell ?? '').trim();
            ctx.turn.npc = { name, want, tell };

            let persisted = false;
            if (args.persist !== false) {
                const created = await createMemoryEntry(ctx, {
                    title: `NPC: ${name}`,
                    keys: [name],
                    content: `${name} — wants: ${want}. Tell/mannerism: ${tell}.`.trim(),
                });
                persisted = Boolean(created.entry);
            }
            return {
                ok: true,
                result: `NEW NPC: ${name} — wants: ${want || '?'}. Tell: ${tell || '?'}${persisted ? ' (saved to the chat lorebook; they can recur)' : ' (not persisted)'}.`,
            };
        },
    },
    {
        name: 'memory_search',
        description: 'Search the chat\'s active lorebooks for recorded facts (promises, names, injuries, places). Read-only.',
        usage: '<tool name="memory_search">{"query":"Mira promise dawn"}</tool>',
        inputSchema: {
            type: 'object',
            required: ['query'],
            properties: { query: { type: 'string', minLength: 2, maxLength: 200 } },
        },
        mode: 'read',
        maxPerTurn: 3,
        enabled: settings => settings.agentToolsEnabled?.memory !== false,
        async run(args, ctx) {
            throwIfAborted(ctx.signal);
            const hits = await searchMemory(args.query);
            if (!hits.length) return { ok: true, result: 'No matching entries found.' };
            const lines = hits.map(hit => `- [${hit.book} #${hit.uid}] ${hit.title}: ${hit.content}`);
            return { ok: true, result: [`Found ${hits.length} matching entr${hits.length === 1 ? 'y' : 'ies'} (best first):`, ...lines].join('\n') };
        },
    },
    {
        name: 'memory_create',
        description: 'Record a durable fact (new name, promise, injury, place, NPC) as a lorebook entry in THIS chat. Key it on proper nouns — never on brief boilerplate. Third person, factual, ≤80 words.',
        usage: '<tool name="memory_create">{"title":"Mira\'s promise","keys":["Mira"],"content":"Mira promised to return at dawn with the ledger."}</tool>',
        inputSchema: {
            type: 'object',
            required: ['title', 'keys', 'content'],
            properties: {
                title: { type: 'string', minLength: 1, maxLength: 90 },
                keys: { type: 'array', items: 'string', minItems: 1, maxItems: 6 },
                content: { type: 'string', minLength: 4, maxLength: 800 },
            },
        },
        mode: 'write',
        maxPerTurn: Infinity,
        enabled: settings => settings.agentToolsEnabled?.memory !== false && settings.agentMemoryMode !== 'off',
        async run(args, ctx) {
            const created = await createMemoryEntry(ctx, args);
            if (created.error) return { ok: false, result: created.error };
            return {
                ok: true,
                result: `Saved memory entry "${created.entry.comment.slice(OWNERSHIP_PREFIX.length)}" (id: ${created.book} #${created.entry.uid}). It activates when its keys appear in recent chat (reliably from next turn).`,
            };
        },
    },
    {
        name: 'memory_update',
        description: 'Correct or extend an EXISTING agent-created memory entry (only agent-created entries can be edited).',
        usage: '<tool name="memory_update">{"id":"12","content":"Mira returned at dawn without the ledger."}</tool>',
        inputSchema: {
            type: 'object',
            required: ['id'],
            properties: {
                id: { type: 'string', description: 'uid from memory_search, e.g. "12" or "Chat Book x #12"' },
                content: { type: 'string', minLength: 4, maxLength: 800 },
                keys: { type: 'array', items: 'string', minItems: 1, maxItems: 6 },
            },
        },
        mode: 'write',
        maxPerTurn: Infinity,
        enabled: settings => settings.agentToolsEnabled?.memory !== false && settings.agentMemoryMode !== 'off',
        async run(args, ctx) {
            const gate = memoryGate(ctx);
            if (gate) return { ok: false, result: gate };
            const target = parseMemoryId(args.id);
            if (!target) return { ok: false, result: '{"error":"id must be a uid number, optionally prefixed \\"Book Name #\\""}' };
            const book = target.book ?? await ensureChatBook(ctx);
            if (book !== getContext().chatMetadata?.[METADATA_KEY]) return { ok: false, result: '{"error":"writes are limited to this chat lorebook"}' };
            if (!book) return { ok: false, result: '{"error":"no chat lorebook available"}' };
            const data = await loadWorldInfo(book);
            assertToolCurrent(ctx);
            const entry = data?.entries?.[target.uid];
            if (!entry) return { ok: false, result: `{"error":"entry ${target.uid} not found in ${book}"}` };
            if (!isAgentOwnedEntry(entry)) {
                return { ok: false, result: '{"error":"refusing to edit a user-authored lorebook entry"}' };
            }
            const before = structuredClone(entry);
            const nextContent = args.content !== undefined ? normalizeContent(args.content) : null;
            const nextKeys = args.keys !== undefined ? normalizeKeys(args.keys) : null;
            if (!nextContent && !nextKeys) return { ok: false, result: '{"error":"nothing to update — provide content and/or keys"}' };
            if (ctx.settings.agentMemoryMode === 'confirm') {
                const allowed = await confirmMemoryWrite(before.comment.replace(OWNERSHIP_PREFIX, ''), nextContent ?? before.content, ctx);
                if (!allowed) return { ok: false, result: '{"error":"the user declined this memory write"}' };
            }
            if (nextContent) entry.content = nextContent;
            if (nextKeys) entry.key = nextKeys;
            entry.smarttavern = true;
            await saveWorldInfo(book, data, true);
            assertToolCurrent(ctx);
            ctx.turn.memoryWrites = (ctx.turn.memoryWrites ?? 0) + 1;
            pushMemoryLog({ at: Date.now(), action: 'update', book, uid: target.uid, title: before.comment.replace(OWNERSHIP_PREFIX, ''), before, after: structuredClone(entry) });
            return { ok: true, result: `Updated memory entry ${book} #${target.uid}.` };
        },
    },
    {
        name: 'memory_delete',
        description: 'Delete an agent-created memory entry that is wrong or obsolete (only agent-created entries can be deleted).',
        usage: '<tool name="memory_delete">{"id":"12"}</tool>',
        inputSchema: {
            type: 'object',
            required: ['id'],
            properties: { id: { type: 'string' } },
        },
        mode: 'write',
        maxPerTurn: Infinity,
        enabled: settings => settings.agentToolsEnabled?.memory !== false && settings.agentMemoryMode !== 'off',
        async run(args, ctx) {
            const gate = memoryGate(ctx);
            if (gate) return { ok: false, result: gate };
            const target = parseMemoryId(args.id);
            if (!target) return { ok: false, result: '{"error":"id must be a uid number, optionally prefixed \\"Book Name #\\""}' };
            const book = target.book ?? await ensureChatBook(ctx);
            if (book !== getContext().chatMetadata?.[METADATA_KEY]) return { ok: false, result: '{"error":"writes are limited to this chat lorebook"}' };
            if (!book) return { ok: false, result: '{"error":"no chat lorebook available"}' };
            const data = await loadWorldInfo(book);
            assertToolCurrent(ctx);
            const entry = data?.entries?.[target.uid];
            if (!entry) return { ok: false, result: `{"error":"entry ${target.uid} not found in ${book}"}` };
            if (!isAgentOwnedEntry(entry)) {
                return { ok: false, result: '{"error":"refusing to delete a user-authored lorebook entry"}' };
            }
            if (ctx.settings.agentMemoryMode === 'confirm') {
                const allowed = await confirmMemoryWrite(`DELETE — ${String(entry.comment ?? '').replace(OWNERSHIP_PREFIX, '')}`, entry.content ?? '', ctx);
                if (!allowed) return { ok: false, result: '{"error":"the user declined this memory change"}' };
            }
            const before = structuredClone(entry);
            const deleted = await deleteWorldInfoEntry(data, target.uid, { silent: true });
            assertToolCurrent(ctx);
            if (!deleted) return { ok: false, result: '{"error":"the entry could not be deleted"}' };
            await saveWorldInfo(book, data, true);
            assertToolCurrent(ctx);
            ctx.turn.memoryWrites = (ctx.turn.memoryWrites ?? 0) + 1;
            pushMemoryLog({ at: Date.now(), action: 'delete', book, uid: target.uid, title: before.comment.replace(OWNERSHIP_PREFIX, ''), before });
            return { ok: true, result: `Deleted memory entry ${book} #${target.uid}.` };
        },
    },
];

// --------------------------------------------------------------------------------------------
// Registry helpers used by the loop, the panel and the catalog
// --------------------------------------------------------------------------------------------

export function getTool(name) {
    return TOOL_REGISTRY.find(tool => tool.name === name) ?? null;
}

/** Tool toggle from settings (the memory_* family shares the `memory` switch). */
export function toolEnabled(name, settings = getSettings()) {
    const tool = getTool(name);
    if (!tool) return false;
    try {
        return tool.enabled(settings) !== false;
    } catch {
        return false;
    }
}

/** One-line catalog of the tools available this turn, for the agent prompt. */
export function availableTools(settings = getSettings(), { dryRun = false, toolState = {}, turn = {}, toolsOn = true } = {}) {
    if (!toolsOn) return [];
    return TOOL_REGISTRY.filter(tool => {
        if (!toolEnabled(tool.name, settings) || (dryRun && tool.mode === 'write')) return false;
        const cap = typeof tool.maxPerTurn === 'function' ? tool.maxPerTurn(settings) : tool.maxPerTurn;
        if ((toolState[tool.name] ?? 0) >= cap) return false;
        if (/^memory_(?:create|update|delete)$/.test(tool.name)
            && (turn.memoryWrites ?? 0) >= clampInt(settings.agentMemoryWritesPerTurn, 0, 10, 3)) return false;
        return true;
    });
}

// Turn-local receipts; a later successful write invalidates that subsystem's receipt.
const writeReceipts = new WeakMap();
function writeSignature(name, args) {
    return JSON.stringify([name, Object.fromEntries(Object.entries(args ?? {}).sort(([a], [b]) => a.localeCompare(b)))]);
}

export function toolCatalog(settings = getSettings(), options = {}) {
    const { isReplay = false } = options;
    const lines = [];
    for (const tool of availableTools(settings, options)) {
        const argList = Object.entries(tool.inputSchema?.properties ?? {})
            .map(([key, rule]) => `${key}${(tool.inputSchema?.required ?? []).includes(key) ? '' : '?'}:${rule.enum ? rule.enum.join('|') : (rule.type ?? 'any')}`)
            .join(', ');
        let note = '';
        if (tool.name === 'ask_user' && isReplay) note = ' (this turn: cached answers only — no popup)';
        lines.push(`- ${tool.name}(${argList}): ${tool.description}${note}`);
        if (tool.usage) lines.push(`  Example: ${tool.usage}`);
    }
    return lines.length ? lines.join('\n') : '(no tools available this turn — finish with a brief)';
}

/**
 * Validates and runs one tool call, converting every failure mode (unknown tool,
 * parse error, disabled tool, per-turn cap, argument issues, runtime error) into an
 * error RESULT instead of an exception. Aborts always propagate.
 */
export async function executeToolCall(call, ctx) {
    ctx.isCurrentChat ??= captureChatScope();
    assertToolCurrent(ctx);
    const name = String(call?.name ?? '');
    const wrap = outcome => ({ name, args: call?.args ?? null, ...outcome });
    const tool = getTool(name);
    if (ctx.dryRun && tool?.mode === 'write') return wrap({ ok: false, result: '{"error":"persistent writes are unavailable during a dry run"}' });
    if (!tool) return wrap({ ok: false, result: `{"error":"unknown tool \\"${name}\\" — use one from the catalog"}` });
    if (call.parseError) return wrap({ ok: false, result: `{"error":"${call.parseError}"}` });
    if (!toolEnabled(name, ctx.settings)) return wrap({ ok: false, result: '{"error":"this tool is disabled"}' });
    const subsystem = name === 'update_scene' ? 'scene' : /^memory_(create|update|delete)$/.test(name) ? 'memory' : null;
    const receipts = writeReceipts.get(ctx.turn) ?? {};
    writeReceipts.set(ctx.turn, receipts);
    const signature = subsystem ? writeSignature(name, call.args) : null;
    if (subsystem && receipts[subsystem]?.signature === signature) {
        return wrap({ ...receipts[subsystem].outcome, reused: true });
    }
    const count = ctx.toolState[name] ?? 0;
    const cap = typeof tool.maxPerTurn === 'function' ? tool.maxPerTurn(ctx.settings) : tool.maxPerTurn;
    if (Number.isFinite(cap) && count >= cap) {
        return wrap({ ok: false, result: `{"error":"per-turn limit (${cap}) reached for ${name}"}` });
    }
    if (!availableTools(ctx.settings, ctx).some(candidate => candidate.name === name)) {
        return wrap({ ok: false, result: '{"error":"tool is no longer available; use the current catalog or finish with a brief"}' });
    }
    if (name === 'roll_dice' && typeof call.args?.dice === 'string') {
        call.args.dice = call.args.dice.toLowerCase();
    }
    const issues = validateToolArgs(tool.inputSchema, call.args ?? {});
    if (issues.length) return wrap({ ok: false, result: `{"error":"${issues.join(' ').replace(/"/g, "'")}"}` });
    try {
        ctx.toolState[name] = count + 1;
        const memoryWritesBefore = ctx.turn.memoryWrites ?? 0;
        const outcome = await tool.run(call.args ?? {}, ctx);
        if ((ctx.turn.memoryWrites ?? 0) !== memoryWritesBefore) delete receipts.memory;
        if (subsystem && outcome?.ok === true) receipts[subsystem] = { signature, outcome };
        return wrap({ ok: outcome?.ok !== false, result: String(outcome?.result ?? ''), interactive: tool.mode === 'interactive' || undefined });
    } catch (error) {
        if (isAbortError(error) || ctx.signal?.aborted) throw error;
        warn(`agent tool "${name}" failed`, error);
        return wrap({ ok: false, result: `{"error":"tool failed: ${String(error?.message ?? error).replace(/"/g, "'")}"}` });
    }
}

// --------------------------------------------------------------------------------------------
// ask_user popup (the timeout clock pauses while it is open; abort closes it)
// --------------------------------------------------------------------------------------------

async function askUserPopup(ctx, question, options, freeText) {
    const context = getContext();
    const content = document.createElement('div');
    content.className = 'smarttavern_ask_body';
    const heading = document.createElement('h3');
    heading.textContent = 'The scene is asking you something';
    const body = document.createElement('p');
    body.className = 'smarttavern_ask_question';
    body.textContent = question;
    content.append(heading, body);
    if (freeText) {
        const hint = document.createElement('div');
        hint.className = 'smarttavern_ask_hint';
        hint.textContent = 'Type below or pick a button.';
        content.append(hint);
    }

    const customButtons = options.map((text, index) => ({
        text,
        result: context.POPUP_RESULT?.[`CUSTOM${index + 1}`] ?? (2 + index),
    }));
    const popup = new context.Popup(content, context.POPUP_TYPE.INPUT, '', {
        okButton: freeText ? 'Answer' : false,
        cancelButton: 'Skip',
        customButtons: customButtons.length ? customButtons : null,
        rows: 2,
        wide: true,
    });
    const close = () => { void popup.complete(context.POPUP_RESULT.CANCELLED); };
    ctx.signal?.addEventListener('abort', close, { once: true });
    let answer = '';
    try {
        const value = await popup.show();
        assertToolCurrent(ctx);
        const result = popup.result;
        if (result === null || result === context.POPUP_RESULT.CANCELLED || result === context.POPUP_RESULT.NEGATIVE) {
            answer = '';
        } else {
            const text = typeof value === 'string' ? value.trim() : '';
            const optionIndex = customButtons.findIndex(button => button.result === result);
            answer = optionIndex >= 0 ? (text || options[optionIndex]) : text;
        }
    } catch (error) {
        if (ctx.signal?.aborted || isAbortError(error)) throw error;
        answer = '';
    } finally {
        ctx.signal?.removeEventListener('abort', close);
    }
    return answer;
}
