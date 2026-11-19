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
import { maybeTrackScene } from './src/scene.js';
import { onStoryCharacterReply, resetStoryGenerationState } from './src/story.js';
import { clearAgentSession } from './src/agent.js';
import { maybeRunGmTick, clearGmSession } from './src/gm.js';
import { initMcp } from './src/mcp.js';
import { initUI } from './src/ui.js';
import { initHud } from './src/hud.js';
import { initPromptTail } from './src/tail.js';
import { initDescriptionOverride } from './src/description.js';
import { dismissAllVeils, dismissVeil, disarmPreVeil } from './src/veil.js';

async function initSmartTavern() {
    const context = getContext();
    loadSettings();
    // ST exposes eventTypes; older builds/extensions may use event_types.
    const events = context.event_types ?? context.eventTypes;
    initPromptTail();
    // Optional MCP bridge: probes the server plugin in the background when switched on (fails open).
    initMcp();
    // Living description: swap the card's description for the stored profile in the
    // assembled prompt (chat completion messages / combined prompt). Registered after
    // the tail so both makeLast hooks keep their relative order.
    initDescriptionOverride();

    // manifest.json points at this global function name (generate_interceptor);
    // it must exist before the next generation starts.
    globalThis.smarttavernInterceptor = smarttavernInterceptor;

    // Defensive sweeps — the pipeline injects into the per-generation core chat copy,
    // so the real chat history should never contain ephemeral messages.
    context.eventSource.on(events.GENERATION_ENDED, () => {
        sweepEphemeral();
        // An armed pre-veil observer must never outlive its generation (ST awaits render
        // listeners before this event, so the reply node already exists by now).
        disarmPreVeil();
    });
    context.eventSource.on(events.MESSAGE_DELETED, () => sweepEphemeral());
    context.eventSource.on(events.CHAT_CHANGED, () => {
        cancelFreshReply();
        sweepEphemeral();
        resetBootstrapFailures();
        resetStoryGenerationState();
        // Thinking agent: drop the armed flag, the last turn state and the cached
        // ask-user answers — they belong to the previous chat.
        clearAgentSession();
        // GM engine: a running tick belongs to the previous chat — cancel it.
        clearGmSession();
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
    context.eventSource.on(refineEvent, (messageId, type) => {
        // ST awaits render listeners before emitting GENERATION_ENDED. Active
        // connection calls wait for that event, so returning the refinement promise
        // here would stall both sides until gen.js's 60-second safety cap.
        // The async handler catches errors and keeps profile maintenance ordered.
        void onCharacterMessageRendered(messageId, type);
    });

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
        if (message.is_user || message.is_system || message.smarttavern_ephemeral || message.extra?.smarttavernNarration) return;
        // Story Director: optimistic beat delivery (refinement off) or the idle clock tick.
        onStoryCharacterReply(Number.isInteger(messageId) ? messageId : arr.length - 1);
        const settings = getSettings();
        // When refinement is active the auto-update runs after refinement completes
        // (see onCharacterMessageRendered) so it reads the refined reply.
        if (settings.enabled && settings.refinementEnabled) return;
        maybeAutoUpdate(message);
        // Scene tracker: same moment and order as the profile auto-update. Both are
        // fire-and-forget background calls; neither waits for the other. The GM tick
        // (opt-in engine) starts after the tracker so it reads the updated scene.
        void maybeRunGmTick(message, { after: maybeTrackScene(message) });
    } catch (error) {
        warn('MESSAGE_RECEIVED handler failed', error);
    }
}

async function onCharacterMessageRendered(messageId, type) {
    try {
        const context = getContext();
        const settings = getSettings();
        // Every early exit also drops a pre-veil (armPreVeil) so a blurred
        // "Drafting reply…" message can never stay stuck.
        if (!settings.enabled || !settings.refinementEnabled) { dismissVeil(messageId); return; }
        if (context.chat?.[messageId]?.extra?.smarttavernNarration) { dismissVeil(messageId); return; }
        // Only freshly GENERATED replies are refined — never a character greeting
        // ('first_message' fires when a new chat starts or a card is re-created) and
        // never messages that are merely re-rendered (chat loads, scrollback).
        // `hasFreshReply` is true only after the interceptor marked a real generation.
        if (type === 'first_message' || !hasFreshReply()) { dismissVeil(messageId); return; }
        await runRefinementPipeline(messageId);
        // Auto-update always follows the refinement attempt: a null result (busy,
        // cancelled or skipped refinement) must not skip the character's profile
        // maintenance, and the updater reads whatever draft survived.
        maybeAutoUpdate(context.chat?.[messageId]);
        const reply = context.chat?.[messageId];
        void maybeRunGmTick(reply, { after: maybeTrackScene(reply) });
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
