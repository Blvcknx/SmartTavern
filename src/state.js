// SmartTavern — settings, per-chat profile store, character resolution and shared helpers.
import { getContext } from '../../../../extensions.js';

export const MODULE_NAME = 'SmartTavern';
export const LOG_PREFIX = '[SmartTavern]';
export const SETTINGS_KEY = 'smarttavern';
export const STORE_KEY = 'smarttavern';
export const STORE_VERSION = 1;

// Soft cap for a single message inside chat excerpts; high enough that chat history
// reaches internal prompts essentially uncut.
export const MAX_EXCERPT_MESSAGE_CHARS = 100000;

export const DEFAULT_FIELDS = Object.freeze([
    { name: 'Brief Summary', description: 'One short paragraph distilling who the character is right now.' },
    { name: 'Appearance', description: 'The character\'s current appearance, clothing and notable physical details.' },
    { name: 'Background', description: 'A long, winding account of the character\'s life and history up to the present. May accumulate detail over time.' },
    { name: 'Personality', description: 'Personality, temperament, mannerisms and speech patterns, including sexual preferences. Should remain essentially stable over time.' },
    { name: 'Aspirations', description: 'What the character wants, strives for and dreams of.' },
    { name: 'Fears', description: 'What the character fears, avoids and dreads.' },
    { name: 'Values', description: 'Political, ethical, moral and religious values and convictions.' },
]);

export const DEFAULT_STEPS = Object.freeze([
    {
        name: 'Physical Condition',
        enabled: true,
        role: 'assistant',
        profileId: '',
        lookback: null,
        prompt: [
            'You are narrating the body of {{char}}.',
            '',
            'Character profile:',
            '{{definitions}}',
            '',
            'Recent conversation:',
            '{{chat}}',
            '',
            'Task: Describe {{char}}\'s immediate PHYSICAL state only — health, injuries, pain, exhaustion, arousal, breathing, posture and energy level. Be concrete and consistent with the profile and the recent events. Write in second person ("you"). 3–6 sentences. No preamble, no headings, no out-of-character commentary.',
        ].join('\n'),
    },
    {
        name: 'Mental Condition',
        enabled: true,
        role: 'assistant',
        profileId: '',
        lookback: null,
        prompt: [
            'You are narrating the mind of {{char}}.',
            '',
            'Character profile:',
            '{{definitions}}',
            '',
            'Physical state (just assessed):',
            '{{step:Physical Condition}}',
            '',
            'Recent conversation:',
            '{{chat}}',
            '',
            'Task: Describe {{char}}\'s immediate MENTAL and EMOTIONAL state — mood, thoughts, desires and what they are fixated on right now. It must be consistent with the profile\'s Personality, Values, Fears and Aspirations, and with the physical state that was just assessed. Write in second person ("you"). 3–6 sentences. No preamble, no headings, no out-of-character commentary.',
        ].join('\n'),
    },
]);

// Preset for 'refinement' pipeline: each pass audits and surgically edits the fresh reply.
// Per-step `lookback`: messages of chat history for {{chat}} in that step
// (null = use the global `chatLookback`, 0 = no chat history).
export const DEFAULT_REFINEMENT_STEPS = Object.freeze([
    {
        name: 'Body & Spatial Awareness',
        enabled: true,
        role: 'assistant',
        profileId: '',
        lookback: 3,
        prompt: [
            'You are auditing the latest reply of {{char}} (the DRAFT) for body and spatial continuity.',
            '',
            'Recent conversation (context):',
            '{{chat}}',
            '',
            'DRAFT reply to refine:',
            '{{draft}}',
            '',
            'Task: Check the draft against the recent conversation for physical posture and position, held or worn objects, injuries, pain, exhaustion, arousal, breathing, and the continuity of the surrounding space and anatomy. Fix ONLY physical and spatial inconsistencies with minimal, surgical edits so positions, objects and body states agree with the conversation. Preserve every event, action, line of dialogue (including its meaning), pacing, formatting and length.',
            'First reason briefly inside <audit>...</audit>, then output the full corrected reply inside <revised_reply>...</revised_reply>. If nothing needs changing, output <audit>PASS</audit> and nothing else.',
        ].join('\n'),
    },
    {
        name: 'Character & Psychological Authenticity',
        enabled: true,
        role: 'assistant',
        profileId: '',
        lookback: 6,
        prompt: [
            'You are auditing the latest reply of {{char}} (the DRAFT) for character and psychological authenticity.',
            '',
            'Character definitions:',
            '{{definitions}}',
            '',
            'Recent conversation (context):',
            '{{chat}}',
            '',
            'DRAFT reply to refine:',
            '{{draft}}',
            '',
            'Task: Check the draft against the character definitions and the recent conversation for voice and speech patterns, psychology, temperament, values, fears, aspirations, and motivations. Adjust ONLY passages that break character or motivation consistency — surgical adjustments, never full rewrites. Preserve every event, action, line of dialogue (including its meaning), pacing, formatting and length.',
            'First reason briefly inside <audit>...</audit>, then output the full adjusted reply inside <revised_reply>...</revised_reply>. If nothing needs changing, output <audit>PASS</audit> and nothing else.',
        ].join('\n'),
    },
    {
        name: 'Prose & Wording Polish',
        enabled: true,
        role: 'assistant',
        profileId: '',
        lookback: 0,
        prompt: [
            'You are polishing the prose of the latest reply of {{char}} (the DRAFT).',
            '',
            'DRAFT reply to polish:',
            '{{draft}}',
            '',
            'Task: Perform purely linguistic and prose enhancements — wording choice, sentence flow, repetition removal, grammar, punctuation and paragraphing. Do NOT alter events, actions, or the meaning of any dialogue, and do not add or remove information. Judge the text on its own; no chat history or character definitions are provided.',
            'First reason briefly inside <audit>...</audit>, then output the full polished reply inside <revised_reply>...</revised_reply>. If the prose is already clean, output <audit>PASS</audit> and nothing else.',
        ].join('\n'),
    },
]);

// Valid values for per-step and tail `role` and the injection anchor.
export const STEP_ROLES = Object.freeze(['user', 'system', 'assistant']);
export const INJECT_ANCHORS = Object.freeze(['prompt-end', 'before-last-user', 'after-last-user', 'top-of-history', 'depth']);

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoUpdate: true,
    bootstrapOnFirstMessage: true,
    // Swap the card's description text for the stored living profile inside the
    // assembled generation prompt (Prompt Manager "Char Description" entry, instruct
    // story string, {{description}} macro in custom prompts). The card itself is never
    // modified; without a stored profile the original description is kept.
    replaceDescription: true,
    // Dual pipelines that run together: 'expansion' injects its step outputs into
    // the reply prompt BEFORE generation; 'refinement' post-edits the fresh reply
    // AFTER it. Each pipeline has its own step list and can be toggled off.
    expansionEnabled: true,
    refinementEnabled: true,
    // 'veiled' blurs the fresh reply in chat until the final pass lands (spoiler-free);
    // 'off' keeps the classic behavior where every pass lands visibly in the message.
    refinementDisplay: 'veiled',
    veilAllowPeek: true,
    savePassesAsSwipes: true,
    // Story Director: a manually triggered director that crafts a scenario (bible),
    // compiles one concrete event per turn (beat) and injects it as the final tail
    // section. The reply model never sees the bible — only the compiled directive.
    storyEnabled: true,
    // A built-in first refinement pass (Directive Enforcement) checks that the
    // required event is on the page and weaves it in when missing.
    storyEnforce: true,
    // Idle turns after delivery before the world escalates on its own (deterministic
    // idle clock: rung advances every further storyIdleTurns turns).
    storyIdleTurns: 3,
    // Hard word cap of the compiled directive (ledger lines are shed first).
    storyDirectiveMaxWords: 140,
    // Connection Manager profile for the Director/architect calls.
    storyProfileId: '',
    updateInterval: 12,
    chatLookback: 24,
    profileUpdateLookback: 24,
    injectDepth: 1,
    // 'prompt-end' relocates the budgeted reservation after assembly. Other
    // anchors retain history placement for comparisons.
    injectAnchor: 'prompt-end',
    injectName: 'SmartTavern',
    injectionHeader: [
        '[Living profile of {{char}} — dynamically maintained; treat as authoritative over the static character card when they conflict]',
        '{{definitions}}',
        '',
        '[Current state assessment — freshly computed; highly relevant to {{char}}\'s next reply:]',
    ].join('\n'),
    injectionFooter: '[End of SmartTavern state block]',
    tailRole: 'assistant',
    tailPrompt: [
        '[Working assessments for {{char}}\'s upcoming reply]',
        '',
        'Living profile:',
        '{{definitions}}',
        '',
        '{{steps}}',
        '',
        'Use these assessments to guide the upcoming reply: account for the current physical state, motivations, and relevant constraints. Treat assessments as working interpretations; the latest explicit conversation evidence takes precedence. Continue the scene as {{char}} in response to {{user}}. Keep these notes out of the visible reply; do not summarize or repeat them.',
    ].join('\n'),
    profileUpdateProfileId: '',
    updaterMaxTokens: 100000,
    stepMaxTokens: 100000,
    stepExecution: 'dependencies',
    // Internal LLM calls (pipeline steps, profile bootstrap/update) are retried when
    // they fail, come back empty, or collapse into a repetition loop. `genRetries`
    // counts EXTRA attempts after the first; the delay grows linearly per attempt.
    genRetries: 2,
    genRetryDelayMs: 500,
    // Floating UI: the summoned panel, the avatar context menu and the wand-menu button.
    // `ui` stores the last open tab and the panel position (null = default, left-center).
    disableFloatingUI: false,
    ui: { tab: 'profile', x: null, y: null },
    fields: clone(DEFAULT_FIELDS),
    steps: clone(DEFAULT_STEPS),                 // expansion steps (pre-reply context)
    refinementSteps: clone(DEFAULT_REFINEMENT_STEPS), // refinement passes (post-reply editing)
});

function clone(value) {
    if (typeof structuredClone === 'function') {
        try {
            return structuredClone(value);
        } catch {
            /* fall through */
        }
    }
    return JSON.parse(JSON.stringify(value));
}

export function isPlainObject(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Recursively fills missing keys from `source` into `target`. Existing values (including
// arrays like fields/steps) are always preserved — defaults never overwrite user data.
export function deepMerge(target, source) {
    for (const [key, sourceValue] of Object.entries(source)) {
        const targetValue = target[key];
        if (targetValue === undefined || targetValue === null) {
            target[key] = clone(sourceValue);
            continue;
        }
        if (isPlainObject(targetValue) && isPlainObject(sourceValue)) {
            deepMerge(targetValue, sourceValue);
        }
    }
    return target;
}

/**
 * Repairs invalid roles/anchors/lookbacks, migrates the removed consolidation pass to
 * local prompt-tail assembly, and migrates the single pipelineMode + shared step list
 * into the two independent pipelines (expansion steps + refinement passes).
 */
function normalizeSettings(settings) {
    let changed = false;

    // v2: the mutually exclusive pipelineMode split into two independent pipelines.
    // The old shared step list always belonged to the active mode, so it migrates
    // into the matching list; the other list gets its own defaults back. The old
    // `pipelineMode` key marks a pre-v2 config (deepMerge has already filled the
    // new lists with defaults, so its presence is the upgrade signal).
    if (settings.pipelinesVersion !== 2) {
        if (settings.pipelineMode !== undefined) {
            if (settings.pipelineMode !== 'expansion') {
                // The old list held refinement passes: move them to their own list and
                // give expansion its default preset back.
                if (Array.isArray(settings.steps) && settings.steps.length) settings.refinementSteps = settings.steps;
                settings.steps = clone(DEFAULT_STEPS);
            }
        }
        if (!Array.isArray(settings.refinementSteps)) settings.refinementSteps = clone(DEFAULT_REFINEMENT_STEPS);
        if (!Array.isArray(settings.steps)) settings.steps = clone(DEFAULT_STEPS);
        settings.refinementEnabled = settings.refinementEnabled !== false;
        settings.expansionEnabled = settings.expansionEnabled !== false;
        delete settings.pipelineMode;
        settings.pipelinesVersion = 2;
        changed = true;
    }
    if (settings.refinementDisplay !== 'veiled' && settings.refinementDisplay !== 'off') {
        settings.refinementDisplay = 'veiled';
        changed = true;
    }
    if (typeof settings.veilAllowPeek !== 'boolean') {
        settings.veilAllowPeek = true;
        changed = true;
    }
    if (typeof settings.replaceDescription !== 'boolean') {
        settings.replaceDescription = true;
        changed = true;
    }
    // Roles formerly selected the role of the generation instructions. They now
    // describe generated output in the reply prompt. Start existing configs as assistant.
    if (settings.outputRolesVersion !== 1) {
        for (const list of [settings.steps, settings.refinementSteps]) {
            for (const step of (Array.isArray(list) ? list : [])) {
                if (isPlainObject(step)) step.role = 'assistant';
            }
        }
        settings.outputRolesVersion = 1;
        changed = true;
    }
    const normalizeStepList = (steps) => {
        for (const step of (Array.isArray(steps) ? steps : [])) {
            if (!isPlainObject(step)) continue;
            if (!STEP_ROLES.includes(step.role)) {
                step.role = 'assistant';
                changed = true;
            }
            const lookback = typeof step.lookback === 'number' && Number.isFinite(step.lookback)
                ? Math.max(0, Math.round(step.lookback))
                : null;
            if (step.lookback !== lookback) {
                step.lookback = lookback;
                changed = true;
            }
        }
    };
    normalizeStepList(settings.steps);
    normalizeStepList(settings.refinementSteps);
    if (!INJECT_ANCHORS.includes(settings.injectAnchor)) {
        settings.injectAnchor = 'prompt-end';
        changed = true;
    }
    if (Object.hasOwn(settings, 'finalStep')) {
        delete settings.finalStep;
        changed = true;
    }
    if (settings.promptTailVersion !== 1) {
        settings.injectAnchor = 'prompt-end';
        settings.promptTailVersion = 1;
        changed = true;
    }
    if (!STEP_ROLES.includes(settings.tailRole)) {
        settings.tailRole = 'assistant';
        changed = true;
    }
    const genRetries = clampInt(settings.genRetries, 0, 5, 2);
    if (settings.genRetries !== genRetries) {
        settings.genRetries = genRetries;
        changed = true;
    }
    const genRetryDelayMs = clampInt(settings.genRetryDelayMs, 0, 30000, 500);
    if (settings.genRetryDelayMs !== genRetryDelayMs) {
        settings.genRetryDelayMs = genRetryDelayMs;
        changed = true;
    }
    if (typeof settings.storyEnabled !== 'boolean') {
        settings.storyEnabled = true;
        changed = true;
    }
    if (typeof settings.storyEnforce !== 'boolean') {
        settings.storyEnforce = true;
        changed = true;
    }
    const storyIdleTurns = clampInt(settings.storyIdleTurns, 1, 20, 3);
    if (settings.storyIdleTurns !== storyIdleTurns) {
        settings.storyIdleTurns = storyIdleTurns;
        changed = true;
    }
    const storyDirectiveMaxWords = clampInt(settings.storyDirectiveMaxWords, 60, 400, 140);
    if (settings.storyDirectiveMaxWords !== storyDirectiveMaxWords) {
        settings.storyDirectiveMaxWords = storyDirectiveMaxWords;
        changed = true;
    }
    if (typeof settings.storyProfileId !== 'string') {
        settings.storyProfileId = '';
        changed = true;
    }
    // Raise persisted token caps (formerly 5000) so long outputs — revised replies,
    // expansion step payloads — are no longer cropped mid-generation.
    if (settings.tokenCapsVersion !== 1) {
        settings.updaterMaxTokens = 100000;
        settings.stepMaxTokens = 100000;
        settings.tokenCapsVersion = 1;
        changed = true;
    }
    if (changed) saveSettings();
}

export function loadSettings() {
    const context = getContext();
    const settings = isPlainObject(context.extensionSettings[SETTINGS_KEY]) ? context.extensionSettings[SETTINGS_KEY] : {};
    context.extensionSettings[SETTINGS_KEY] = settings;
    deepMerge(settings, DEFAULT_SETTINGS);
    normalizeSettings(settings);
    return settings;
}

export function getSettings() {
    const settings = getContext().extensionSettings[SETTINGS_KEY];
    return isPlainObject(settings) ? settings : DEFAULT_SETTINGS;
}

export function saveSettings() {
    getContext().saveSettingsDebounced();
}

// --------------------------------------------------------------------------------------------
// Per-chat profile store (chat metadata). Keyed by character avatar filename.
// --------------------------------------------------------------------------------------------

export function getChatStore() {
    const context = getContext();
    const metadata = context.chatMetadata;
    if (!isPlainObject(metadata)) {
        return { version: STORE_VERSION, profiles: {} };
    }
    let store = metadata[STORE_KEY];
    if (!isPlainObject(store)) {
        store = { version: STORE_VERSION, profiles: {} };
        metadata[STORE_KEY] = store;
    }
    if (!isPlainObject(store.profiles)) {
        store.profiles = {};
    }
    store.version ??= STORE_VERSION;
    return store;
}

export function saveChatStore(immediate = false) {
    const context = getContext();
    if (immediate || typeof context.saveMetadataDebounced !== 'function') {
        context.saveMetadata();
    } else {
        context.saveMetadataDebounced();
    }
}

export function getStoredProfile(key) {
    return getChatStore().profiles[key] ?? null;
}

/** Capture chat ownership before awaiting a model; context objects are live snapshots. */
export function captureChatScope() {
    const { chat, chatMetadata, chatId, characterId, groupId } = getContext();
    return () => {
        const current = getContext();
        return current.chat === chat && current.chatMetadata === chatMetadata
            && current.chatId === chatId && current.characterId === characterId
            && current.groupId === groupId;
    };
}

export function setStoredProfile(key, record) {
    const store = getChatStore();
    store.profiles[key] = record;
    saveChatStore();
    return record;
}

export function deleteStoredProfile(key) {
    const store = getChatStore();
    const existed = Object.hasOwn(store.profiles, key);
    delete store.profiles[key];
    if (existed) saveChatStore();
    return existed;
}

export function clearAllProfiles() {
    const store = getChatStore();
    const count = Object.keys(store.profiles).length;
    store.profiles = {};
    saveChatStore(true);
    return count;
}

export function allStoredProfiles() {
    return Object.entries(getChatStore().profiles);
}

// --------------------------------------------------------------------------------------------
// Story Director store (chat metadata). The whole feature is inert without one.
// Shape: { v:1, bible, chapterIndex, beat, ledger:[], turnsSinceDelivery, seed, createdAt }
// --------------------------------------------------------------------------------------------

export function getStory() {
    return getChatStore().story ?? null;
}

export function setStory(story) {
    getChatStore().story = story;
    saveChatStore();
    return story;
}

/** Mutates the stored story in place through `mutator`, then persists it. */
export function updateStory(mutator) {
    const story = getStory();
    if (!story) return null;
    mutator(story);
    setStory(story);
    return story;
}

export function clearStory() {
    const store = getChatStore();
    const existed = Object.hasOwn(store, 'story');
    delete store.story;
    if (existed) saveChatStore();
    return existed;
}

// --------------------------------------------------------------------------------------------
// Character resolution
// --------------------------------------------------------------------------------------------

export function isGroupChat() {
    return Boolean(getContext().groupId);
}

export function getGroupMembers() {
    const context = getContext();
    if (!context.groupId) return [];
    const group = (context.groups ?? []).find(g => g.id === context.groupId);
    const avatars = Array.isArray(group?.members) ? group.members : [];
    return avatars
        .map(avatar => (context.characters ?? []).find(ch => ch?.avatar === avatar))
        .filter(Boolean);
}

export function getMainCharacter() {
    const context = getContext();
    const id = context.characterId;
    if (id === undefined || id === null || id === '') return null;
    return context.characters?.[id] ?? null;
}

export function findCharacterByName(name) {
    const needle = String(name ?? '').trim().toLowerCase();
    if (!needle) return null;
    return (getContext().characters ?? []).find(ch => String(ch?.name ?? '').trim().toLowerCase() === needle) ?? null;
}

export function findGroupMemberByName(name) {
    const needle = String(name ?? '').trim().toLowerCase();
    if (!needle) return null;
    return getGroupMembers().find(ch => String(ch?.name ?? '').trim().toLowerCase() === needle) ?? null;
}

/**
 * Resolves the character whose profile governs the current generation.
 * Group chats: the drafting member (tracked by the global `name2` at generation time),
 * falling back to the author of the last non-user message, then the first group member.
 * Single chats: the selected character.
 */
export function resolveTargetChar(fallbackChat = null) {
    const context = getContext();
    const chat = Array.isArray(fallbackChat) && fallbackChat.length ? fallbackChat : (context.chat ?? []);

    if (isGroupChat()) {
        const draftName = String(context.name2 ?? '').trim();
        if (draftName) {
            const member = findGroupMemberByName(draftName);
            if (member) return member;
        }
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (!message || message.is_user || message.is_system) continue;
            const member = findGroupMemberByName(message.name);
            if (member) return member;
        }
        return getGroupMembers()[0] ?? null;
    }

    const main = getMainCharacter();
    if (main) return main;
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_user || message.is_system) continue;
        const char = findCharacterByName(message.name);
        if (char) return char;
    }
    return null;
}

/** Resolves a chat participant (group member in groups, any character otherwise) by message author name. */
export function resolveMemberByMessageName(name) {
    const needle = String(name ?? '').trim().toLowerCase();
    if (!needle) return null;
    const context = getContext();
    const pool = context.groupId ? getGroupMembers() : (context.characters ?? []);
    return pool.find(ch => String(ch?.name ?? '').trim().toLowerCase() === needle) ?? null;
}

/** Storage key for a character: avatar filename (stable across renames within a chat), name as fallback. */
export function charKey(char) {
    return char?.avatar || char?.name || 'unknown';
}

/** Flattens a character card into labeled plain text for LLM consumption. */
export function cardText(char) {
    if (!char) return '';
    const parts = [];
    if (char.name) parts.push(`Name: ${char.name}`);
    if (char.description) parts.push(`Description: ${char.description}`);
    if (char.personality) parts.push(`Personality: ${char.personality}`);
    if (char.scenario) parts.push(`Scenario: ${char.scenario}`);
    if (char.first_mes) parts.push(`First message:\n${char.first_mes}`);
    return parts.join('\n\n');
}

/** Last N usable messages as "Name: text" blocks, most recent last. */
export function chatExcerpt(messages, lookback, { capPerMessage = MAX_EXCERPT_MESSAGE_CHARS } = {}) {
    const context = getContext();
    const list = [];
    for (let i = (messages?.length ?? 0) - 1; i >= 0 && list.length < lookback; i--) {
        const message = messages[i];
        if (!message || message.is_system || message.is_hidden) continue;
        const raw = String(message.mes ?? '').trim();
        if (!raw) continue;
        const name = message.is_user ? (context.name1 ?? 'User') : (message.name ?? 'Assistant');
        const text = raw.length > capPerMessage ? raw.slice(0, capPerMessage) + '…' : raw;
        list.unshift(`${name}: ${text}`);
    }
    return list.join('\n\n');
}

// --------------------------------------------------------------------------------------------
// Small helpers
// --------------------------------------------------------------------------------------------

export function clampInt(value, min, max, fallback) {
    const num = Number(value);
    if (!Number.isFinite(num)) return fallback;
    return Math.min(max, Math.max(min, Math.round(num)));
}

/**
 * Runs ST macro substitution over text, degrading to the input on failure.
 * `env` mirrors baseChatReplace's substitution environment (e.g. a per-member
 * `name2Override` for group-chat card joins).
 */
export function substituteParamsSafe(text, env = undefined) {
    try {
        return getContext().substituteParams(String(text ?? ''), env);
    } catch {
        return text;
    }
}

export function log(message, ...args) {
    console.log(`${LOG_PREFIX} ${message}`, ...args);
}

export function warn(message, ...args) {
    console.warn(`${LOG_PREFIX} ${message}`, ...args);
}
