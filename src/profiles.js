// SmartTavern — living profile lifecycle: bootstrap (full rewrite), update (low-drift),
// rebuild and reset, plus the background auto-update trigger.
import { getContext } from '../../../../extensions.js';
import {
    log, warn, getSettings, isPlainObject,
    cardText, chatExcerpt, charKey, setStoredProfile, deleteStoredProfile,
    getStoredProfile, getMainCharacter, resolveMemberByMessageName, substituteParamsSafe,
} from './state.js';
import { generateVia, withInternalGeneration } from './gen.js';
import { activityStart, activityEntry, activityFail, activityEnd, activitySteps } from './progress.js';

const busyKeys = new Set();

export function isProfileBusy(key) {
    return busyKeys.has(key);
}

const BOOTSTRAP_SYSTEM = [
    'You are a character profile compiler for an interactive fiction platform.',
    'You receive a character card and a recent excerpt of an ongoing conversation.',
    'Produce a complete living profile of the character as a single JSON object with EXACTLY the requested fields.',
    'Ground everything in the card; where the recent conversation contradicts or extends the card, prefer the conversation.',
    'Write vivid, specific, complete prose (no bullet lists, no meta commentary).',
    'Output ONLY the JSON object.',
].join(' ');

const UPDATE_SYSTEM = [
    'You are the keeper of a living character profile that evolves with an ongoing roleplay conversation.',
    'You receive the CURRENT profile and a RECENT EXCERPT of the conversation.',
    'Apply only changes that are clearly supported by the excerpt:',
    '- Brief Summary, Appearance and Background may be updated freely (expand rather than shrink; never remove existing detail gratuitously).',
    '- Personality, Values, Aspirations and Fears must stay essentially unchanged (little to no personality drift) unless the excerpt makes a change unavoidable.',
    'Return the COMPLETE updated profile as a single JSON object with EXACTLY the requested fields.',
    'Output ONLY the JSON object.',
].join(' ');

// --------------------------------------------------------------------------------------------
// Schema / parsing
// --------------------------------------------------------------------------------------------

/** Builds the structured-output schema dynamically from the user's field list. */
export function buildJsonSchema(fields) {
    const properties = {};
    const required = [];
    for (const field of fields) {
        const name = String(field?.name ?? '').trim();
        if (!name) continue;
        properties[name] = { type: 'string', description: String(field?.description ?? '') };
        required.push(name);
    }
    return {
        name: 'character_profile',
        description: 'Living character profile',
        strict: false,
        value: {
            type: 'object',
            properties,
            required,
            additionalProperties: false,
        },
    };
}

/** Renders a stored profile as "## Field" text blocks (UI display and prompts). */
export function serializeProfile(profile, fields) {
    if (!profile || !isPlainObject(profile.fields)) return '';
    const blocks = [];
    for (const field of fields) {
        const value = profile.fields[field?.name];
        if (typeof value === 'string' && value.trim()) {
            blocks.push(`## ${field.name}\n${value.trim()}`);
        }
    }
    return blocks.join('\n\n');
}

/** Field-level diff between two field maps: only changed or newly added fields. */
export function diffFields(previous, next) {
    const out = Object.create(null);
    if (!isPlainObject(previous) || !isPlainObject(next)) return out;
    for (const [name, value] of Object.entries(next)) {
        const before = typeof previous[name] === 'string' ? previous[name].trim() : '';
        const after = typeof value === 'string' ? value.trim() : '';
        if (before !== after) out[name] = { from: previous[name] ?? '', to: value ?? '' };
    }
    return out;
}

/** Lenient JSON extraction: strips code fences, slices the first '{' … last '}'. */
export function extractJson(raw) {
    if (raw === null || raw === undefined) return null;
    let text = String(raw).trim();
    if (!text) return null;
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    if (fenced) text = fenced[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
        return JSON.parse(text.slice(start, end + 1));
    } catch {
        return null;
    }
}

/**
 * Validates a parsed profile object: keeps only known field keys (case-insensitive match),
 * drops non-string/empty values and fills gaps from the existing profile.
 * Returns null when nothing usable was produced.
 */
export function normalizeProfileJson(obj, fields, existing = null) {
    if (!isPlainObject(obj)) return null;
    const lookup = new Map(fields.map(f => [String(f?.name ?? '').trim().toLowerCase(), String(f?.name ?? '').trim()]));
    const out = {};
    let matched = 0;
    for (const [rawKey, rawValue] of Object.entries(obj)) {
        const canonical = lookup.get(String(rawKey).trim().toLowerCase());
        if (!canonical || typeof rawValue !== 'string' || !rawValue.trim()) continue;
        out[canonical] = rawValue.trim();
        matched++;
    }
    if (!matched) return null;
    const previous = existing && isPlainObject(existing.fields) ? existing.fields : {};
    for (const field of fields) {
        const name = String(field?.name ?? '').trim();
        if (!name || name in out) continue;
        const value = previous[name];
        if (typeof value === 'string' && value.trim()) out[name] = value;
    }
    return { fields: out };
}

// --------------------------------------------------------------------------------------------
// Prompts
// --------------------------------------------------------------------------------------------

function fieldSpecList(fields) {
    return fields
        .filter(f => String(f?.name ?? '').trim())
        .map(f => `- "${f.name}": ${f?.description ?? ''}`)
        .join('\n');
}

export function buildBootstrapPrompt(char, fields, excerpt) {
    return substituteParamsSafe([
        'Character card:',
        cardText(char) || '(empty)',
        '',
        'Recent conversation excerpt:',
        excerpt || '(none yet)',
        '',
        'Return a single JSON object with exactly these fields:',
        fieldSpecList(fields),
    ].join('\n'));
}

export function buildUpdatePrompt(char, profile, fields, excerpt) {
    return substituteParamsSafe([
        `Current profile of ${char.name}:`,
        serializeProfile(profile, fields) || '(empty)',
        '',
        'Recent conversation excerpt:',
        excerpt || '(none yet)',
        '',
        'Return the complete updated profile as a single JSON object with exactly these fields:',
        fieldSpecList(fields),
    ].join('\n'));
}

// --------------------------------------------------------------------------------------------
// Lifecycle
// --------------------------------------------------------------------------------------------

/**
 * Full rewrite: compiles the character card (+ recent excerpt) into a fresh profile.
 * Used for the first generation of a character (bootstrap) and for explicit rebuilds.
 */
export async function bootstrapProfile(char, { source = 'bootstrap', notify = true } = {}) {
    if (!char) throw new Error('No character provided');
    const settings = getSettings();
    const key = charKey(char);
    if (busyKeys.has(key)) return null;
    busyKeys.add(key);
    try {
        activityStart({ status: `${source === 'rebuild' ? 'Rebuilding' : 'Compiling'} profile · ${char.name}` });
        activitySteps({ names: [] }); // profile runs have no passes — clear any stale chip row
        const context = getContext();
        const fields = Array.isArray(settings.fields) ? settings.fields : [];
        const schema = buildJsonSchema(fields);
        const excerpt = chatExcerpt(context.chat, settings.profileUpdateLookback);
        const result = await withInternalGeneration(() => generateVia({
            profileId: settings.profileUpdateProfileId,
            systemPrompt: BOOTSTRAP_SYSTEM,
            prompt: buildBootstrapPrompt(char, fields, excerpt),
            maxTokens: settings.updaterMaxTokens,
            jsonSchema: schema,
        }));
        const rawContent = String(result?.content ?? '');
        activityEntry({ title: `Profile payload · ${rawContent.length} chars`, tone: 'info', text: rawContent });
        const parsed = normalizeProfileJson(extractJson(rawContent), fields, null);
        if (!parsed) throw new Error('The model did not return a usable profile object');
        const now = (context.chat ?? []).length;
        const record = { fields: parsed.fields, createdAt: now, updatedAt: now, source };
        setStoredProfile(key, record);
        log(`profile ${source} written for "${key}"`);
        notifyProfileUpdated({ key, silent: !notify, changedFields: Object.keys(parsed.fields) });
        if (notify) toastr.success(`Profile for ${char.name} ${source === 'rebuild' ? 'rebuilt' : 'created'}.`, 'SmartTavern');
        activityEnd({ ok: true, summary: `${source === 'rebuild' ? 'Profile rebuilt' : 'Profile created'} · ${char.name}` });
        return record;
    } catch (error) {
        activityFail(`Profile ${source} failed — ${error?.message ?? error}`);
        activityEnd({ ok: false, summary: 'Profile update failed' });
        throw error;
    } finally {
        busyKeys.delete(key);
    }
}

export function rebuildProfile(char, options = {}) {
    return bootstrapProfile(char, { ...options, source: 'rebuild' });
}

/**
 * Low-drift maintenance: sends the current profile + recent excerpt to the updater and
 * merges the result, filling any missing fields from the existing profile.
 */
export async function updateProfile(char, { notify = true } = {}) {
    if (!char) throw new Error('No character provided');
    const key = charKey(char);
    const existing = getStoredProfile(key);
    if (!existing) return bootstrapProfile(char, { notify });
    const settings = getSettings();
    if (busyKeys.has(key)) return null;
    busyKeys.add(key);
    try {
        activityStart({ status: `Updating profile · ${char.name}` });
        activitySteps({ names: [] }); // profile runs have no passes — clear any stale chip row
        const context = getContext();
        const fields = Array.isArray(settings.fields) ? settings.fields : [];
        const schema = buildJsonSchema(fields);
        const excerpt = chatExcerpt(context.chat, settings.profileUpdateLookback);
        const result = await withInternalGeneration(() => generateVia({
            profileId: settings.profileUpdateProfileId,
            systemPrompt: UPDATE_SYSTEM,
            prompt: buildUpdatePrompt(char, existing, fields, excerpt),
            maxTokens: settings.updaterMaxTokens,
            jsonSchema: schema,
        }));
        const rawContent = String(result?.content ?? '');
        activityEntry({ title: `Profile payload · ${rawContent.length} chars`, tone: 'info', text: rawContent });
        const parsed = normalizeProfileJson(extractJson(rawContent), fields, existing);
        if (!parsed) throw new Error('The model did not return a usable profile object');
        const diff = diffFields(existing?.fields, parsed.fields);
        const record = {
            ...existing,
            fields: parsed.fields,
            updatedAt: (context.chat ?? []).length,
            source: 'update',
            lastDiff: { at: (context.chat ?? []).length, source: 'update', fields: diff },
        };
        setStoredProfile(key, record);
        log(`profile updated for "${key}" (${Object.keys(diff).length} field change(s))`);
        notifyProfileUpdated({ key, silent: !notify, changedFields: Object.keys(diff) });
        if (notify) toastr.success(`Profile for ${char.name} updated.`, 'SmartTavern');
        activityEnd({ ok: true, summary: `Profile updated · ${char.name}` });
        return record;
    } catch (error) {
        activityFail(`Profile update failed — ${error?.message ?? error}`);
        activityEnd({ ok: false, summary: 'Profile update failed' });
        throw error;
    } finally {
        busyKeys.delete(key);
    }
}

export function resetProfile(key) {
    return deleteStoredProfile(key);
}

/**
 * Single source of truth for the profile-updated DOM event. `silent` marks background
 * auto-updates (no toast) — hud.js uses it to badge the character's avatars in chat.
 */
function notifyProfileUpdated({ key, silent, changedFields }) {
    document.dispatchEvent(new CustomEvent('smarttavern:profile-updated', {
        detail: { key, silent, changedFields: Array.isArray(changedFields) ? changedFields : [] },
    }));
}

/**
 * MESSAGE_RECEIVED hook: runs a background profile update for the character who just
 * replied once `updateInterval` new messages have accumulated since their last write.
 */
export function maybeAutoUpdate(message) {
    try {
        const settings = getSettings();
        if (!settings.enabled || !settings.autoUpdate) return;
        if (!message || message.is_user || message.is_system || message.smarttavern_ephemeral) return;
        const context = getContext();
        const char = context.groupId
            ? resolveMemberByMessageName(message.name)
            : getMainCharacter();
        if (!char) return;
        const key = charKey(char);
        const record = getStoredProfile(key);
        if (!record) return; // profiles are bootstrapped at generation time
        if (((context.chat?.length ?? 0) - (record.updatedAt ?? 0)) < settings.updateInterval) return;
        if (isProfileBusy(key)) return;
        log(`auto-updating profile for ${char.name}`);
        updateProfile(char, { notify: false })
            .catch(error => warn(`background profile update failed for ${char.name}`, error));
    } catch (error) {
        warn('auto-update check failed', error);
    }
}
