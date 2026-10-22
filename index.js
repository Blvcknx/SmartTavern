// SmartTavern — extension entry point.
// Loads settings, registers the manifest-referenced generation interceptor,
// wires lifecycle events and builds the settings UI.
import { getContext } from '../../../extensions.js';
import { loadSettings, getSettings, log, warn } from './src/state.js';
import {
    smarttavernInterceptor, sweepEphemeral, resetBootstrapFailures,
    runRefinementPipeline, hasFreshReply, cancelFreshReply,
} from './src/pipeline.js';
import { maybeAutoUpdate } from './src/profiles.js';
import { initUI } from './src/ui.js';
import { initHud } from './src/hud.js';
import { initPromptTail } from './src/tail.js';
import { initDescriptionOverride } from './src/description.js';
import { dismissAllVeils } from './src/veil.js';

async function initSmartTavern() {
    const context = getContext();
    loadSettings();
    // ST exposes eventTypes; older builds/extensions may use event_types.
    const events = context.event_types ?? context.eventTypes;
    initPromptTail();
    // Living description: swap the card's description for the stored profile in the
    // assembled prompt (chat completion messages / combined prompt). Registered after
    // the tail so both makeLast hooks keep their relative order.
    initDescriptionOverride();

    // manifest.json points at this global function name (generate_interceptor);
    // it must exist before the next generation starts.
    globalThis.smarttavernInterceptor = smarttavernInterceptor;

    // Defensive sweeps — the pipeline injects into the per-generation core chat copy,
    // so the real chat history should never contain ephemeral messages.
    context.eventSource.on(events.GENERATION_ENDED, () => sweepEphemeral());
    context.eventSource.on(events.MESSAGE_DELETED, () => sweepEphemeral());
    context.eventSource.on(events.CHAT_CHANGED, () => {
        cancelFreshReply();
        sweepEphemeral();
        resetBootstrapFailures();
        // An in-flight refinement may still be veiling a message from the previous chat;
        // its DOM is gone, so this only clears bookkeeping and any stray overlay.
        dismissAllVeils();
    });
    context.eventSource.on(events.GENERATION_STOPPED, () => {
        cancelFreshReply();
        dismissAllVeils();
    });

    // Background profile maintenance after each character reply.
    context.eventSource.on(events.MESSAGE_RECEIVED, onMessageReceived);

    // Refinement pipeline: refine the fresh reply once it is rendered, then run the
    // profile auto-update so it reads the refined message (never in parallel).
    const refineEvent = events.CHARACTER_MESSAGE_RENDERED ?? events.MESSAGE_RECEIVED;
    context.eventSource.on(refineEvent, onCharacterMessageRendered);

    try {
        initUI();
    } catch (error) {
        console.error('[SmartTavern] UI init failed', error);
    }

    try {
        initHud();
    } catch (error) {
        console.error('[SmartTavern] floating UI init failed', error);
    }

    log('initialized');
}

function onMessageReceived(messageId) {
    try {
        const context = getContext();
        const arr = context.chat ?? [];
        const message = Number.isInteger(messageId) ? arr[messageId] : arr[arr.length - 1];
        if (!message) return;
        if (message.is_user || message.is_system || message.smarttavern_ephemeral) return;
        const settings = getSettings();
        // When refinement is active the auto-update runs after refinement completes
        // (see onCharacterMessageRendered) so it reads the refined reply.
        if (settings.enabled && settings.refinementEnabled) return;
        maybeAutoUpdate(message);
    } catch (error) {
        warn('MESSAGE_RECEIVED handler failed', error);
    }
}

async function onCharacterMessageRendered(messageId, type) {
    try {
        const context = getContext();
        const settings = getSettings();
        if (!settings.enabled || !settings.refinementEnabled) return;
        // Only freshly GENERATED replies are refined — never a character greeting
        // ('first_message' fires when a new chat starts or a card is re-created) and
        // never messages that are merely re-rendered (chat loads, scrollback).
        // `hasFreshReply` is true only after the interceptor marked a real generation.
        if (type === 'first_message' || !hasFreshReply()) return;
        const result = await runRefinementPipeline(messageId);
        // Auto-update only after refinement finishes, so the updater reads the refined reply.
        if (result) maybeAutoUpdate(context.chat?.[messageId]);
    } catch (error) {
        warn('refinement hook failed', error);
    }
}

jQuery(async () => {
    try {
        await initSmartTavern();
    } catch (error) {
        console.error('[SmartTavern] init failed', error);
    }
});
