// SmartTavern — shared scene state (ST-bound half; the pure logic is scene-core.js).
//
// ONE store per chat, chatMetadata.smarttavern.scene, written by three authors:
//   tracker — the background call that runs after each finalized character reply,
//   agent   — the legacy thinking agent's update_scene tool,
//   user    — edits made in the panel's Scene tab.
// { facts: [...rewind-safe facts...], pinned: [keys], locked: [keys], log: [undo], tick }
// Facts are anchored to saved chat messages (see scene-core.js), so swipes, edits and
// rewinds drop and restore them automatically — nothing here has to react to them.
import { getContext } from '../../../../extensions.js';
import {
    getSettings, getChatStore, saveChatStore, captureChatScope, chatExcerpt, clampInt,
    isPlainObject, getGroupMembers, log, warn,
} from './state.js';
import { generateWithRetry, withInternalGeneration, createGenerationControl, isAbortError } from './gen.js';
import { activityStart, activityEntry, activityFail, activityEnd, activitySteps } from './progress.js';
import {
    SCENE_TRACKER_SYSTEM, SCENE_LOG_CAP,
    resolveScene, sceneToObject, renderScene, makeFact, upsertFact, compactFacts, lastAnchorIndex,
    filterSceneOps, parseSceneOps, isValidSceneOutput, buildTrackerPrompt, isKeyInList, withKeyToggled,
    keyId, normalizeKey, pushSceneLog, planUndo,
} from './scene-core.js';

// --------------------------------------------------------------------------------------------
// Store
// --------------------------------------------------------------------------------------------

function emptyStore() {
    return { facts: [], pinned: [], locked: [], log: [], tick: 0 };
}

/**
 * The chat's scene store. `create: false` never attaches a new store to the metadata
 * (read paths on chats that never used the scene stay write-free).
 * One-time per-chat migration: the legacy agent's `agentScene` facts move into
 * `scene.facts` as by:'agent' and the old array is deleted.
 */
export function getSceneStore({ create = true } = {}) {
    const chatStore = getChatStore();
    const legacy = Array.isArray(chatStore.agentScene) ? chatStore.agentScene : null;
    let scene = chatStore.scene;
    if (!isPlainObject(scene)) {
        if (!create && !legacy) return emptyStore();
        scene = chatStore.scene = emptyStore();
    }
    for (const key of ['facts', 'pinned', 'locked', 'log']) if (!Array.isArray(scene[key])) scene[key] = [];
    if (!Number.isFinite(scene.tick)) scene.tick = 0;
    if (legacy) {
        for (const fact of legacy) {
            if (isPlainObject(fact) && typeof fact.key === 'string') scene.facts.push({ ...fact, by: 'agent', at: Number(fact.at) || 0 });
        }
        delete chatStore.agentScene;
        saveChatStore();
    }
    return scene;
}

/** Resolved scene entries (rewind-safe, capped) for the given visible chat. */
export function getSceneEntries(visibleChat = getContext().chat) {
    const store = getSceneStore({ create: false });
    return resolveScene(store.facts, getContext().chat ?? [], visibleChat, {
        pinned: store.pinned, maxFacts: clampInt(getSettings().sceneMaxFacts, 10, 200, 40),
    });
}

/** key -> value view of the resolved scene (what the legacy agent reads). */
export function getSceneObject(visibleChat = getContext().chat) {
    return sceneToObject(getSceneEntries(visibleChat));
}

/** The {{scene}} macro text. */
export function getSceneText(visibleChat = getContext().chat) {
    return renderScene(getSceneEntries(visibleChat));
}

export function sceneLog() {
    return getSceneStore({ create: false }).log;
}

function notifySceneChanged() {
    document.dispatchEvent(new CustomEvent('smarttavern:scene-updated', { detail: {} }));
}

// --------------------------------------------------------------------------------------------
// Writes
// --------------------------------------------------------------------------------------------

/**
 * Appends facts anchored to the saved message at `sourceIndex`.
 * Locked keys are only writable by the user; for tracker / agent they are skipped and
 * reported. Returns { written: [{key,value}], locked: [key] }.
 * @param {{ key: string, value?: string, evidence?: string }[]} items empty value = removal
 */
export function writeSceneFacts(items, { by = 'tracker', sourceIndex }) {
    const saved = getContext().chat ?? [];
    const store = getSceneStore();
    const result = { written: [], locked: [] };
    const sourceText = saved[sourceIndex]?.mes;
    if (typeof sourceText !== 'string') return result;
    for (const item of items) {
        const key = normalizeKey(item.key);
        if (!key) continue;
        if (by !== 'user' && isKeyInList(key, store.locked)) { result.locked.push(key); continue; }
        upsertFact(store.facts, makeFact({ key, value: item.value ?? '', evidence: item.evidence ?? '', by, sourceIndex, sourceText, at: Date.now() }));
        result.written.push({ key, value: String(item.value ?? '').trim() });
    }
    if (result.written.length) {
        compactFacts(store.facts, saved);
        saveChatStore();
        notifySceneChanged();
    }
    return result;
}

/**
 * Panel edits (set / add / delete). Anchored to the LAST chat message, so they are
 * rewind-safe like every other fact; recorded in the undo log.
 * @returns {boolean} false when there is no message to anchor to or nothing changed
 */
export function userSetFacts(items, action = 'edit') {
    const saved = getContext().chat ?? [];
    const sourceIndex = lastAnchorIndex(saved);
    if (sourceIndex < 0) return false;
    const before = new Map(getSceneEntries().map(entry => [keyId(entry.key), entry.value]));
    const changes = [];
    for (const item of items) {
        const key = normalizeKey(item.key);
        const value = String(item.value ?? '').trim();
        const previous = before.get(keyId(key)) ?? null;
        if (!key || previous === (value || null)) continue;
        changes.push({ key, before: previous, after: value || null });
    }
    if (!changes.length) return false;
    writeSceneFacts(changes.map(change => ({ key: change.key, value: change.after ?? '', evidence: 'edited by user' })), { by: 'user', sourceIndex });
    pushSceneLog(getSceneStore().log, { at: Date.now(), action, changes }, SCENE_LOG_CAP);
    saveChatStore();
    return true;
}

export function userRemoveFact(key) {
    return userSetFacts([{ key, value: '' }], 'delete');
}

/**
 * "Clear scene": appends removal facts for every active UNPINNED key (anchored to the
 * last message, by:'user'). Deliberately not a truncation of the store: a rewind past
 * this point restores the older scene, and the action is one undoable log entry.
 * @returns {number} keys removed
 */
export function clearScene() {
    const store = getSceneStore({ create: false });
    const items = getSceneEntries().filter(entry => !isKeyInList(entry.key, store.pinned)).map(entry => ({ key: entry.key, value: '' }));
    return items.length && userSetFacts(items, 'clear') ? items.length : 0;
}

/** Undoes log entry `index` by writing the previous values back; false when the scene moved on. */
export function undoSceneLogEntry(index) {
    const store = getSceneStore({ create: false });
    const entry = store.log[index];
    if (!entry) return false;
    const writes = planUndo(entry, getSceneEntries());
    const sourceIndex = lastAnchorIndex(getContext().chat);
    if (!writes || sourceIndex < 0) return false;
    writeSceneFacts(writes.map(write => ({ ...write, evidence: 'undo' })), { by: 'user', sourceIndex });
    store.log.splice(index, 1);
    saveChatStore();
    return true;
}

export function setScenePinned(key, on) {
    const store = getSceneStore();
    store.pinned = withKeyToggled(store.pinned, key, on);
    saveChatStore();
}

export function setSceneLocked(key, on) {
    const store = getSceneStore();
    store.locked = withKeyToggled(store.locked, key, on);
    saveChatStore();
}

// --------------------------------------------------------------------------------------------
// Tracker (background call)
// --------------------------------------------------------------------------------------------

// Chats with a tracker call in flight (ticks never overlap within one chat).
const busyChats = new Set();

export function isSceneBusy() {
    return busyChats.has(String(getContext().chatId ?? ''));
}

/** Replies the tracker may read: a character's, never user / system / narration / ephemeral. */
function isTrackable(message) {
    return Boolean(message) && !message.is_user && !message.is_system && !message.smarttavern_ephemeral
        && !message.extra?.smarttavernNarration && typeof message.mes === 'string';
}

/**
 * Hook after a finalized character reply (same place and order as maybeAutoUpdate).
 * Counts replies per chat and runs the tracker on every `sceneTrackerEvery`-th one.
 * Returns a promise that settles (never rejects) once this reply's tracking is over —
 * immediately when the tracker does not run — so the GM tick can read the updated scene.
 */
export function maybeTrackScene(message) {
    try {
        const settings = getSettings();
        if (!settings.enabled || !settings.sceneTrackerEnabled || !isTrackable(message)) return Promise.resolve();
        const store = getSceneStore();
        store.tick = (store.tick || 0) + 1;
        saveChatStore();
        if (store.tick % clampInt(settings.sceneTrackerEvery, 1, 20, 1) !== 0) return Promise.resolve();
        return runSceneTracker(message)
            .then(() => {}, error => warn('background scene tracking failed', error));
    } catch (error) {
        warn('scene tracker check failed', error);
        return Promise.resolve();
    }
}

/**
 * "Track now": runs the tracker on the newest character reply, ignoring the every-N
 * counter and the tracker enable switch. Returns the run summary, or null when busy,
 * cancelled or discarded; throws on generation failure.
 */
export async function trackSceneNow() {
    if (!getSettings().enabled) return { error: 'SmartTavern is disabled.' };
    const chat = getContext().chat ?? [];
    for (let index = chat.length - 1; index >= 0; index--) {
        if (isTrackable(chat[index]) && String(chat[index].mes).trim()) return runSceneTracker(chat[index]);
    }
    return { error: 'There is no character reply to track yet.' };
}

/**
 * One tracker call for `message` (a saved chat message). Facts are anchored to that
 * message (sourceIndex + its current text); the result is discarded when the chat
 * changed or the reply was edited / swiped while the model was thinking.
 * @returns {Promise<{ applied: number, ops: object[], none: boolean }|null>}
 */
export async function runSceneTracker(message) {
    const context = getContext();
    const chat = context.chat ?? [];
    const index = chat.lastIndexOf(message);
    const sourceText = message?.mes;
    if (index < 0 || !String(sourceText ?? '').trim()) return null;
    const busyKey = String(context.chatId ?? '');
    if (busyChats.has(busyKey)) return null;
    busyChats.add(busyKey);
    const isCurrentChat = captureChatScope();
    const control = createGenerationControl();
    const settings = getSettings();
    try {
        activityStart({ status: 'Tracking scene' });
        activitySteps({ names: [] });
        const store = getSceneStore({ create: false });
        const names = [message.name, ...(context.groupId ? getGroupMembers().map(member => member?.name) : [context.name2]), context.name1];
        const prompt = buildTrackerPrompt({
            entries: getSceneEntries(chat), locked: store.locked, names,
            messages: chatExcerpt(chat.slice(0, index + 1), clampInt(settings.sceneTrackerLookback, 1, 20, 4)),
        });
        const result = await withInternalGeneration(() => generateWithRetry({
            signal: control.signal,
            profileId: settings.sceneTrackerProfileId ?? '',
            systemPrompt: SCENE_TRACKER_SYSTEM,
            prompt,
            maxTokens: clampInt(settings.sceneTrackerMaxTokens, 128, 32000, 1024),
            // The grammar is its own check (and <none/> is a legitimately short answer).
            checkOutput: false,
            validate: res => isValidSceneOutput(String(res?.content ?? '')),
        }));
        const raw = String(result?.content ?? '');
        activityEntry({ title: `Scene payload · ${raw.length} chars`, tone: 'info', text: raw });
        const parsed = parseSceneOps(raw);
        if (!isCurrentChat() || context.chat?.[index] !== message || message.mes !== sourceText) {
            activityEnd({ ok: true, summary: 'Scene result discarded — chat or reply changed' });
            return null;
        }
        const filtered = filterSceneOps(parsed.ops, getSceneEntries(chat), getSceneStore({ create: false }).locked);
        const { written, locked } = filtered.apply.length
            ? writeSceneFacts(filtered.apply.map(op => ({ key: op.key, value: op.value, evidence: 'scene tracker' })), { by: 'tracker', sourceIndex: index })
            : { written: [], locked: [] };
        if (filtered.locked.length) {
            activityEntry({ title: `Scene: ignored ${filtered.locked.length} locked key(s)`, text: filtered.locked.map(op => op.key).join(', '), tone: 'info' });
        }
        const lines = written.map(item => (item.value ? `+ ${item.key}: ${item.value}` : `- ${item.key}`));
        if (written.length) activityEntry({ title: `Scene: ${written.length} update${written.length === 1 ? '' : 's'}`, text: lines.join('\n') });
        if (parsed.truncated) activityEntry({ title: 'Scene: output truncated to the first operations', tone: 'info' });
        log(`scene tracker: ${written.length} update(s)${locked.length ? `, ${locked.length} locked` : ''}`);
        activityEnd({ ok: true, summary: written.length ? `Scene: ${written.length} update${written.length === 1 ? '' : 's'}` : 'Scene: no changes' });
        return { applied: written.length, ops: written, none: parsed.none };
    } catch (error) {
        if (isAbortError(error)) {
            activityEnd({ ok: true, summary: 'Scene tracking cancelled' });
            return null;
        }
        activityFail(`Scene tracking failed — ${error?.message ?? error}`);
        activityEnd({ ok: false, summary: 'Scene tracking failed' });
        throw error;
    } finally {
        control.dispose();
        busyChats.delete(busyKey);
    }
}
