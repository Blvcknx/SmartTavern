// SmartTavern — extension entry point.
// Loads settings, registers the manifest-referenced generation interceptor,
// wires lifecycle events and builds the settings UI.
import { getContext } from '../../../extensions.js';
import { loadSettings, getSettings, log, warn } from './src/state.js';
import { smarttavernInterceptor, sweepEphemeral, resetBootstrapFailures, runRefinementPipeline } from './src/pipeline.js';
import { maybeAutoUpdate } from './src/profiles.js';
import { initUI } from './src/ui.js';
import { initHud } from './src/hud.js';
import { initPromptTail } from './src/tail.js';
import { dismissAllVeils } from './src/veil.js';

async function initSmartTavern() {
    const context = getContext();
    loadSettings();
    // ST exposes eventTypes; older builds/extensions may use event_types.
    const events = context.event_types ?? context.eventTypes;
    initPromptTail();

    // manifest.json points at this global function name (generate_interceptor);
    // it must exist before the next generation starts.
    globalThis.smarttavernInterceptor = smarttavernInterceptor;

    // Defensive sweeps — the pipeline injects into the per-generation core chat copy,
    // so the real chat history should never contain ephemeral messages.
    context.eventSource.on(events.GENERATION_ENDED, () => sweepEphemeral());
    context.eventSource.on(events.MESSAGE_DELETED, () => sweepEphemeral());
    context.eventSource.on(events.CHAT_CHANGED, () => {
        sweepEphemeral();
        resetBootstrapFailures();
        // An in-flight refinement may still be veiling a message from the previous chat;
        // its DOM is gone, so this only clears bookkeeping and any stray overlay.
        dismissAllVeils();
    });

    // Background profile maintenance after each character reply.
    context.eventSource.on(events.MESSAGE_RECEIVED, onMessageReceived);

    // Refinement mode: refine the fresh reply once it is rendered, then run the
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
        // In refinement mode the auto-update runs after refinement completes
        // (see onCharacterMessageRendered) so it reads the refined reply.
        if (settings.enabled && settings.pipelineMode === 'refinement') return;
        maybeAutoUpdate(message);
    } catch (error) {
        warn('MESSAGE_RECEIVED handler failed', error);
    }
}

async function onCharacterMessageRendered(messageId) {
    try {
        const context = getContext();
        const settings = getSettings();
        if (!settings.enabled || settings.pipelineMode !== 'refinement') return;
        await runRefinementPipeline(messageId);
        // Auto-update only after refinement finishes, so the updater reads the refined reply.
        maybeAutoUpdate(context.chat?.[messageId]);
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
