import { getContext } from '../../../../extensions.js';
import { getSettings, resolveTargetChar, getStoredProfile, charKey, captureChatScope, warn } from './state.js';
import { previewStoryDirective } from './story.js';
import { createGenerationControl, isAbortError, throwIfAborted } from './gen.js';
import { generateAgentText, sharedAgentContext } from './planner.js';
import { activityStart, activityEntry, activityEnd } from './progress.js';

const NARRATION_SYSTEM = `Write an immediate playable scene for an interactive-fiction chat following the user's scene request. Output only finished narration, no planning, tags, tools, or commentary. Honor continuity and the established narrative voice. For a time skip, establish when and where the new scene opens. Introduce an actionable situation or conflict when appropriate, leaving room for the player to respond. Never decide the player's actions, dialogue, feelings, or choices. Do not reveal hidden secrets. The current story directive is background context; the user's scene request controls the requested transition.`;

let busy = false;
let dialogOpen = false;

export async function writeQuickNarration(request, { signal } = {}) {
    if (busy) throw new Error('A scene request is already running.');
    if (!String(request ?? '').trim()) throw new Error('Enter a scene request.');
    const settings = getSettings();
    if (!settings.enabled) throw new Error('Enable SmartTavern before writing a scene.');
    const context = getContext();
    const char = resolveTargetChar(context.chat);
    if (!char || !context.chat) throw new Error('Open a character chat first.');
    const isCurrent = captureChatScope();
    const snapshot = context.chat.map(message => [message, message.mes, message.swipe_id, message.is_hidden]);
    const unchanged = () => isCurrent() && context.chat.length === snapshot.length
        && snapshot.every(([message, text, swipe, hidden], index) => context.chat[index] === message
            && message.mes === text && message.swipe_id === swipe && message.is_hidden === hidden);
    const control = createGenerationControl();
    const events = context.event_types ?? context.eventTypes ?? {};
    const cancel = () => control.cancel();
    // A foreground reply starting before the scene lands owns the conversation now.
    if (events.GENERATION_STARTED) context.eventSource?.on(events.GENERATION_STARTED, cancel);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) cancel();
    busy = true;
    activityStart({ status: 'Writing scene' });
    try {
        const directive = settings.storyEnabled !== false ? previewStoryDirective() : null;
        const fixed = `${sharedAgentContext({ char, profile: getStoredProfile(charKey(char)), settings, directive })}\n\n[SCENE REQUEST]\n${String(request).trim()}`;
        const result = await generateAgentText({ systemPrompt: NARRATION_SYSTEM, fixed,
            chat: context.chat, profileId: settings.agentProfileId || '', maxTokens: settings.agentAuxMaxTokens,
            signal: control.signal, onNotice: text => activityEntry({ title: 'Scene context', text, tone: 'info' }) });
        throwIfAborted(control.signal);
        if (!unchanged()) throw new Error('Scene discarded because the conversation changed. Retry with the current conversation.');
        const message = {
            name: 'Narrator', is_user: false, is_system: false, mes: result.text,
            send_date: new Date().toISOString(), swipe_id: 0, swipes: [result.text],
            extra: { smarttavernNarration: true, smarttavernRefined: true },
        };
        const messageId = context.chat.length;
        context.chat.push(message);
        try {
            await context.saveChat();
        } catch (error) {
            if (context.chat[messageId] === message) context.chat.splice(messageId, 1);
            throw error;
        }
        if (isCurrent()) {
            try {
                context.addOneMessage(message);
                if (events.MESSAGE_RECEIVED) await context.eventSource.emit(events.MESSAGE_RECEIVED, messageId, 'smarttavern_narration');
                if (isCurrent() && events.CHARACTER_MESSAGE_RENDERED) await context.eventSource.emit(events.CHARACTER_MESSAGE_RENDERED, messageId, 'smarttavern_narration');
            } catch (error) {
                // The message is committed. A failing third-party listener must not offer a duplicate retry.
                warn('Scene saved, but its display or message notification failed', error);
                activityEntry({ title: 'Scene saved; refresh the chat if it is not visible', tone: 'info' });
            }
        }
        activityEnd({ ok: true, summary: 'Scene added' });
        return message;
    } catch (error) {
        activityEnd({ ok: false, summary: isAbortError(error) ? 'Scene cancelled' : String(error.message ?? error) });
        throw error;
    } finally {
        busy = false;
        signal?.removeEventListener('abort', cancel);
        if (events.GENERATION_STARTED) context.eventSource?.removeListener(events.GENERATION_STARTED, cancel);
        control.dispose();
    }
}

/** Keep the request in the dialog on failure, and allow cancellation during generation. */
export async function openNarrationDialog() {
    if (dialogOpen) return;
    dialogOpen = true;
    const context = getContext();
    const isCurrent = captureChatScope();
    const controller = new AbortController();
    const content = document.createElement('div');
    const heading = document.createElement('h3');
    heading.textContent = 'Introduce a scene';
    const input = document.createElement('textarea');
    input.className = 'text_pole';
    input.rows = 5;
    input.placeholder = 'Skip a few days and open with an unexpected visitor…';
    input.setAttribute('aria-label', 'Scene request');
    const status = document.createElement('p');
    status.setAttribute('role', 'status');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'menu_button';
    button.textContent = 'Write scene';
    content.append(heading, input, status, button);
    const popup = new context.Popup(content, context.POPUP_TYPE.TEXT, '', {
        okButton: false, cancelButton: 'Cancel',
        onClosing: () => { controller.abort(); return true; },
    });
    const events = context.event_types ?? context.eventTypes ?? {};
    const close = () => { controller.abort(); void popup.complete(context.POPUP_RESULT.CANCELLED); };
    context.eventSource?.on(events.CHAT_CHANGED, close);
    button.addEventListener('click', async () => {
        if (button.disabled || !isCurrent() || controller.signal.aborted) return;
        button.disabled = true;
        input.disabled = true;
        status.textContent = 'Writing scene… You can cancel while it runs.';
        try {
            await writeQuickNarration(input.value, { signal: controller.signal });
            await popup.complete(context.POPUP_RESULT.AFFIRMATIVE);
        } catch (error) {
            if (!controller.signal.aborted) status.textContent = isAbortError(error) ? 'Scene cancelled. You can retry.' : String(error.message ?? error);
        } finally {
            button.disabled = false;
            input.disabled = false;
        }
    });
    try { await popup.show(); } finally {
        controller.abort();
        context.eventSource?.removeListener(events.CHAT_CHANGED, close);
        dialogOpen = false;
    }
}
