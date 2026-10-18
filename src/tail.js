// Reserve the tail as a normal core-chat message, then relocate it after prompt
// assembly. ST budgets its tokens normally; the markers also prevent unrelated
// raw/internal requests from accidentally consuming a pending tail.
import { getContext } from '../../../../extensions.js';
import { formatInstructModeChat, formatInstructModePrompt } from '../../../../instruct-mode.js';
import { getSettings, warn } from './state.js';
import { isInternalGeneration } from './gen.js';

let pending = null;
let sequence = 0;

export function clearPromptTail() {
    pending = null;
}

export function stagePromptTail(text, role) {
    const context = getContext();
    const id = `${Date.now()}-${++sequence}`;
    const start = `[SMARTTAVERN-TAIL-${id}-BEGIN]`;
    const end = `[SMARTTAVERN-TAIL-${id}-END]`;
    const reservation = `${start}\n${text}\n${end}`;
    pending = {
        start, end, reservation, role,
        chatId: context.chatId,
        name: role === 'user' ? context.name1 : context.name2,
        name1: context.name1, name2: context.name2,
    };
    // Run after listeners that were registered since extension initialization.
    const events = context.event_types ?? context.eventTypes;
    context.eventSource?.makeLast?.(events.CHAT_COMPLETION_PROMPT_READY, appendChatTail);
    context.eventSource?.makeLast?.(events.GENERATE_AFTER_COMBINE_PROMPTS, appendTextTail);
    return reservation;
}

function currentTail(event) {
    if (isInternalGeneration() || !pending || event?.dryRun) return null;
    if (getContext().chatId !== pending.chatId) {
        clearPromptTail();
        return null;
    }
    // A pending reservation must still be stripped if the user disables the
    // extension while assembly is in progress, but its content is then omitted.
    return { ...pending, enabled: getSettings().enabled };
}

function extract(text, tail) {
    const start = text.indexOf(tail.start);
    const end = text.indexOf(tail.end, start + tail.start.length);
    if (start < 0 || end < 0) return null;
    return {
        content: text.slice(start + tail.start.length, end).trim(),
        remaining: text.slice(0, start) + text.slice(end + tail.end.length),
    };
}

function removeStaleReservation(text) {
    return text.replace(/\[SMARTTAVERN-TAIL-(\d+-\d+)-BEGIN\][\s\S]*?\[SMARTTAVERN-TAIL-\1-END\]/g, '');
}

function cleanStaleChat(chat) {
    if (isInternalGeneration()) return;
    for (let index = chat.length - 1; index >= 0; index--) {
        const message = chat[index];
        if (typeof message.content !== 'string') continue;
        const clean = removeStaleReservation(message.content);
        if (clean === message.content) continue;
        if (!clean.trim() && !message.tool_calls && message.role !== 'tool') chat.splice(index, 1);
        else message.content = clean;
    }
}

export function appendChatTail(event) {
    const tail = currentTail(event);
    if (!Array.isArray(event.chat)) return;
    if (!tail) {
        if (!event.dryRun) cleanStaleChat(event.chat);
        return;
    }
    let content = null;
    for (let index = event.chat.length - 1; index >= 0; index--) {
        const message = event.chat[index];
        const parts = typeof message.content === 'string'
            ? [{ type: 'text', text: message.content }]
            : (Array.isArray(message.content) ? message.content : []);
        let found = false;
        const cleaned = parts.flatMap(part => {
            if (typeof part.text !== 'string') return [part];
            const result = extract(part.text, tail);
            if (!result) return [part];
            found = true;
            content = result.content;
            // ST may prepend a character name before the reservation.
            const rest = result.remaining.trim();
            return !rest || rest === `${tail.name}:` ? [] : [{ ...part, text: result.remaining }];
        });
        if (!found) continue;
        if (!cleaned.length && !message.tool_calls && message.role !== 'tool') {
            event.chat.splice(index, 1);
        } else {
            message.content = typeof message.content === 'string'
                ? cleaned.map(part => part.text ?? '').join('') : cleaned;
        }
    }
    if (content === null) return; // Not this generation, or ST trimmed the reservation.
    clearPromptTail();
    if (tail.enabled && content) event.chat.push({ role: tail.role, content });
}

export function appendTextTail(event) {
    const tail = currentTail(event);
    if (typeof event.prompt !== 'string') return;
    if (!tail) {
        if (!event.dryRun && !isInternalGeneration()) event.prompt = removeStaleReservation(event.prompt);
        return;
    }
    const result = extract(event.prompt, tail);
    if (!result) return;
    clearPromptTail();
    const context = getContext();
    const instruct = Boolean(context.powerUserSettings?.instruct?.enabled);
    const format = (text, force = false) => instruct
        ? formatInstructModeChat(tail.name, text, tail.role === 'user', tail.role === 'system', undefined, tail.name1, tail.name2, force)
        : `${tail.role === 'system' ? '' : `${tail.name}: `}${text}\n`;
    const wrapped = event.prompt.slice(event.prompt.indexOf(tail.start), event.prompt.indexOf(tail.end) + tail.end.length);
    const candidates = [false, 1, 2].map(force => format(wrapped, force)).sort((a, b) => b.length - a.length);
    const reserved = candidates.find(candidate => event.prompt.includes(candidate));
    if (!reserved) {
        // A custom formatter changed the surrounding delimiters. Keep its valid
        // structure and the assessment at the budgeted position; never leak markers.
        event.prompt = event.prompt.replace(wrapped, tail.enabled ? result.content : '');
        warn('Could not relocate the prompt tail with this text formatter; keeping its budgeted history position.');
        return;
    }
    let prompt = event.prompt.replace(reserved, '');
    if (tail.enabled && result.content) {
        const cue = instruct
            ? formatInstructModePrompt(tail.name2, false, '', tail.name1, tail.name2, false, false)
            : `${tail.name2}:`;
        // Move the existing assistant cue after the new tail when it is recognizable.
        if (cue && prompt.endsWith(cue)) prompt = prompt.slice(0, -cue.length);
        event.prompt = `${prompt}\n${format(result.content)}${cue}`;
    } else event.prompt = prompt;
}

export function initPromptTail() {
    const context = getContext();
    const events = context.event_types ?? context.eventTypes;
    const reset = () => { if (!isInternalGeneration()) clearPromptTail(); };
    context.eventSource.on(events.GENERATION_STARTED, reset);
    context.eventSource.on(events.GENERATION_ENDED, reset);
    context.eventSource.on(events.GENERATION_STOPPED, reset);
    context.eventSource.on(events.CHAT_CHANGED, clearPromptTail);
    const onLast = context.eventSource.makeLast?.bind(context.eventSource) ?? context.eventSource.on.bind(context.eventSource);
    onLast(events.CHAT_COMPLETION_PROMPT_READY, appendChatTail);
    onLast(events.GENERATE_AFTER_COMBINE_PROMPTS, appendTextTail);
}
