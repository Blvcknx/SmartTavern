// SmartTavern — living description override: swaps the character card's description text
// for the stored living profile inside the assembled generation prompt. The card itself
// is never modified — the swap happens only on the per-generation prompt copy (the chat
// completion messages / the text completion combined prompt), the same principle the
// prompt tail uses.
//
// The description reaches the prompt through several channels: the Prompt Manager's
// "Char Description" entry (chat completion marker prompt), the instruct Context
// Template story string (text completion) and the {{description}} macro in custom
// prompts. All of them end up containing the same description text ST computed in
// Generate() (baseChatReplace: macro substitution, optional newline collapse, CR
// stripping), so a post-assembly swap of that text covers every path and both
// completion modes. Without a stored profile the original description is used.
import { getContext } from '../../../../extensions.js';
import {
    getSettings, log, warn, charKey, getStoredProfile,
    getMainCharacter, getGroupMembers, substituteParamsSafe,
} from './state.js';
import { serializeProfile } from './profiles.js';
import { isInternalGeneration } from './gen.js';

// A needle shorter than this is too likely to match unrelated prompt text ("A cat.")
// and corrupt it — tiny descriptions are left as the card wrote them.
const MIN_NEEDLE_CHARS = 12;

export function initDescriptionOverride() {
    const context = getContext();
    const events = context.event_types ?? context.eventTypes;
    const onLast = context.eventSource.makeLast?.bind(context.eventSource)
        ?? context.eventSource.on.bind(context.eventSource);
    onLast(events.CHAT_COMPLETION_PROMPT_READY, onChatCompletionPrompt);
    onLast(events.GENERATE_AFTER_COMBINE_PROMPTS, onCombinedPrompt);
    log('living description override registered');
}

/** True when this generation's prompt should receive the living description swap. */
function overrideActive(event) {
    // Dry runs (prompt inspectors) and our own internal calls keep the card description.
    if (event?.dryRun || isInternalGeneration(event)) return false;
    const settings = getSettings();
    return Boolean(settings.enabled && settings.replaceDescription);
}

/**
 * [{ needle, text }] for every participant with a stored profile: single chats target
 * the main character, group chats every member (merged group cards join each member's
 * description, so each member's needle matches inside the joined block).
 */
function replacementTargets() {
    const settings = getSettings();
    const fields = Array.isArray(settings.fields) ? settings.fields : [];
    const context = getContext();
    const chars = context.groupId ? getGroupMembers() : [getMainCharacter()];
    const targets = [];
    for (const char of chars) {
        if (!char) continue;
        const text = serializeProfile(getStoredProfile(charKey(char)), fields);
        if (!text) continue; // no profile stored → keep the card description
        for (const needle of descriptionNeedles(char)) targets.push({ needle, text });
    }
    // Longest first: when variants overlap, the most specific needle must win.
    targets.sort((a, b) => b.needle.length - a.needle.length);
    return targets;
}

/** The description text in every form ST may have put into the prompt. */
function descriptionNeedles(char) {
    const raw = String(char?.description ?? '').trim();
    if (!raw) return [];
    const variants = [];
    const seen = new Set();
    const add = (value) => {
        const text = String(value ?? '').replace(/\r/g, '');
        if (text.length >= MIN_NEEDLE_CHARS && !seen.has(text)) {
            seen.add(text);
            variants.push(text);
        }
    };
    add(raw);
    // baseChatReplace resolves non-card macros inside the description...
    add(substituteParamsSafe(raw));
    // Group chats join member cards with a PER-MEMBER {{char}} substitution
    // (baseChatReplace(value, null, memberName) after <FIELDNAME> expansion — see
    // getGroupCharacterCardsLazy), which the global pass above cannot reproduce — it
    // substitutes the group name. Add the member-name variant so the needle matches
    // the joined block. Non-APPEND group modes keep member descriptions out of the
    // prompt entirely; there the override has nothing to swap and stays inactive.
    if (getContext().groupId) {
        const memberText = raw.replace(/<FIELDNAME>/gi, 'Description');
        add(substituteParamsSafe(memberText, { name2Override: char.name, replaceCharacterCard: false }));
    }
    // ...and collapses newlines when the user enables that power-user setting.
    for (const value of [...variants]) add(value.replace(/\n+/g, '\n'));
    return variants;
}

/** Replaces every needle occurrence; returns the swapped text (or the input unchanged). */
function applyTargets(text, targets) {
    let out = text;
    for (const target of targets) {
        if (out.includes(target.needle)) out = out.split(target.needle).join(target.text);
    }
    return out;
}

// Chat Completion: the final assembled messages. The description is the content of the
// "Char Description" system message (and of any custom prompt that used {{description}}).
function onChatCompletionPrompt(event) {
    try {
        if (!overrideActive(event) || !Array.isArray(event.chat)) return;
        const targets = replacementTargets();
        if (!targets.length) return;
        let swapped = 0;
        for (const message of event.chat) {
            if (typeof message.content === 'string') {
                const next = applyTargets(message.content, targets);
                if (next !== message.content) {
                    message.content = next;
                    swapped++;
                }
            } else if (Array.isArray(message.content)) {
                for (const part of message.content) {
                    if (part && typeof part.text === 'string') {
                        const next = applyTargets(part.text, targets);
                        if (next !== part.text) {
                            part.text = next;
                            swapped++;
                        }
                    }
                }
            }
        }
        if (swapped) log(`living description swapped into ${swapped} chat completion message(s)`);
    } catch (error) {
        // Fail open: the generation proceeds with the card description.
        warn('description override failed; using the card description as-is', error);
    }
}

// Text Completion: the combined prompt after the story string was rendered.
function onCombinedPrompt(event) {
    try {
        if (!overrideActive(event) || typeof event.prompt !== 'string') return;
        const targets = replacementTargets();
        if (!targets.length) return;
        const next = applyTargets(event.prompt, targets);
        if (next !== event.prompt) {
            event.prompt = next;
            log('living description swapped into the combined prompt');
        }
    } catch (error) {
        warn('description override failed; using the card description as-is', error);
    }
}
