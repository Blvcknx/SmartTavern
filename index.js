// SmartTavern — extension entry point.
// Loads settings, registers the manifest-referenced generation interceptor,
// wires lifecycle events and builds the settings UI.
import { getContext } from '../../../extensions.js';
import { loadSettings, log, warn } from './src/state.js';
import { smarttavernInterceptor, sweepEphemeral, resetBootstrapFailures } from './src/pipeline.js';
import { maybeAutoUpdate } from './src/profiles.js';
import { initUI } from './src/ui.js';
import { initHud } from './src/hud.js';

async function initSmartTavern() {
    const context = getContext();
    loadSettings();

    // manifest.json points at this global function name (generate_interceptor);
    // it must exist before the next generation starts.
    globalThis.smarttavernInterceptor = smarttavernInterceptor;

    // Defensive sweeps — the pipeline injects into the per-generation core chat copy,
    // so the real chat history should never contain ephemeral messages.
    context.eventSource.on(context.event_types.GENERATION_ENDED, () => sweepEphemeral());
    context.eventSource.on(context.event_types.MESSAGE_DELETED, () => sweepEphemeral());
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        sweepEphemeral();
        resetBootstrapFailures();
    });

    // Background profile maintenance after each character reply.
    context.eventSource.on(context.event_types.MESSAGE_RECEIVED, onMessageReceived);

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
        maybeAutoUpdate(message);
    } catch (error) {
        warn('MESSAGE_RECEIVED handler failed', error);
    }
}

jQuery(async () => {
    try {
        await initSmartTavern();
    } catch (error) {
        console.error('[SmartTavern] init failed', error);
    }
});
