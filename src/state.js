// SmartTavern — settings, per-chat profile store, character resolution and shared helpers.
import { getContext } from '../../../../extensions.js';

export const MODULE_NAME = 'SmartTavern';
export const LOG_PREFIX = '[SmartTavern]';
export const SETTINGS_KEY = 'smarttavern';
export const STORE_KEY = 'smarttavern';
export const STORE_VERSION = 1;

// Hard cap for a single message inside chat excerpts, to keep internal prompts bounded.
export const MAX_EXCERPT_MESSAGE_CHARS = 800;

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

// Valid values for per-step and tail `role` and the injection anchor.
export const STEP_ROLES = Object.freeze(['user', 'system', 'assistant']);
export const INJECT_ANCHORS = Object.freeze(['prompt-end', 'before-last-user', 'after-last-user', 'top-of-history', 'depth']);

export const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    autoUpdate: true,
    bootstrapOnFirstMessage: true,
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
    updaterMaxTokens: 5000,
    stepMaxTokens: 5000,
    stepExecution: 'dependencies',
    // Floating UI: the summoned panel, the avatar context menu and the wand-menu button.
    // `ui` stores the last open tab and the panel position (null = default, left-center).
    disableFloatingUI: false,
    ui: { tab: 'profile', x: null, y: null },
    fields: clone(DEFAULT_FIELDS),
    steps: clone(DEFAULT_STEPS),
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
 * Repairs invalid roles/anchors and migrates the removed consolidation pass to
 * local prompt-tail assembly. Existing steps keep their content.
 */
function normalizeSettings(settings) {
    let changed = false;
    // Roles formerly selected the role of the generation instructions. They now
    // describe generated output in the reply prompt. Start existing configs as assistant.
    if (settings.outputRolesVersion !== 1) {
        for (const step of (Array.isArray(settings.steps) ? settings.steps : [])) {
            if (isPlainObject(step)) step.role = 'assistant';
        }
        settings.outputRolesVersion = 1;
        changed = true;
    }
    for (const step of (Array.isArray(settings.steps) ? settings.steps : [])) {
        if (!isPlainObject(step)) continue;
        if (!STEP_ROLES.includes(step.role)) {
            step.role = 'assistant';
            changed = true;
        }
    }
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

/** Runs ST macro substitution over text, degrading to the input on failure. */
export function substituteParamsSafe(text) {
    try {
        return getContext().substituteParams(String(text ?? ''));
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
