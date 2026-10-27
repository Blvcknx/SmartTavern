// SmartTavern — refinement veil: obscures the freshly generated reply in the chat DOM
// while refinement passes run, tracks pass progress on an in-message overlay, then
// reveals the final draft with a short blur-to-sharp animation.
//
// Only the rendered block is touched: the chat data keeps the real draft the whole
// time, so reloads, swipes and edits are always safe. On any failure path the veil is
// dropped instantly — a permanently veiled message must never exist.
import { chipsHtml, setChipState } from './chips.js';

// Must match the transition/animation durations in style.css (.smarttavern_unveiling).
const REVEAL_MS = 500;

// messageId -> { $mes, $overlay, $text, timer }
const activeVeils = new Map();

function findMessageEl(messageId) {
    return $(`#chat .mes[mesid="${Number(messageId)}"]`);
}

/**
 * Blurs the message text and mounts the progress overlay.
 * @param {number|string} messageId
 * @param {{ names?: string[], allowPeek?: boolean, onEnough?: (() => void)|null, onSkip?: (() => void)|null, title?: string }} [options]
 * @returns {boolean} false when the message element is not in the DOM (veil skipped —
 * the pipeline continues unobstructed and simply reveals nothing).
 */
export function applyVeil(messageId, { names = [], allowPeek = true, onEnough = null, onSkip = null, title = 'Refining reply…' } = {}) {
    const id = Number(messageId);
    dismissVeil(id); // never stack a second veil on the same message
    const $mes = findMessageEl(id);
    const $text = $mes.find('.mes_text').first();
    if (!$mes.length || !$text.length) return false;

    const $overlay = $(`
        <div class="smarttavern_veil" role="status">
            <div class="smarttavern_veil_card">
                <div class="smarttavern_veil_head">
                    <i class="fa-solid fa-circle-notch fa-spin"></i>
                    <span class="smarttavern_veil_title">${String(title)}</span>
                </div>
                <div class="smarttavern_veil_chips">${chipsHtml(names)}</div>
                ${allowPeek ? `
                <div class="smarttavern_veil_peek" title="Hold to peek at the current draft">
                    <i class="fa-solid fa-eye"></i><span>Hold to peek</span>
                </div>` : ''}
                ${onSkip || onEnough ? '<div class="smarttavern_veil_controls">' : ''}
                ${onSkip ? `<button type="button" class="smarttavern_veil_skip menu_button"
                    title="Discard this pass and continue with the next pass">Skip pass</button>` : ''}
                ${onEnough ? `<button type="button" class="smarttavern_veil_enough menu_button"
                    title="Discard the unfinished pass and keep the last completed result">That's enough</button>` : ''}
                ${onSkip || onEnough ? '</div>' : ''}
            </div>
        </div>`);

    $text.addClass('smarttavern_veiled');
    $mes.addClass('smarttavern_veil_host');
    $mes.find('.mes_block').first().append($overlay);
    activeVeils.set(id, { $mes, $overlay, $text, timer: null });

    // Momentary peek: partial unblur only while the pointer is held down. Touch pointers
    // are implicitly captured by the button, so pointerup reliably fires on it as well.
    const $peek = $overlay.find('.smarttavern_veil_peek');
    $peek.on('pointerdown', (event) => {
        event.preventDefault();
        $text.addClass('smarttavern_veil_peek');
    });
    $peek.on('pointerup pointercancel pointerleave', () => {
        $text.removeClass('smarttavern_veil_peek');
    });
    $peek.on('contextmenu', (event) => event.preventDefault());
    $overlay.find('.smarttavern_veil_enough').on('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onEnough?.();
    });
    $overlay.find('.smarttavern_veil_skip').on('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        onSkip?.();
    });
    return true;
}

/** Flips one pass chip on the veil overlay (pending → running → done | failed). */
export function setVeilStep(messageId, index, state) {
    const veil = activeVeils.get(Number(messageId));
    if (veil) setChipState(veil.$overlay.find('.smarttavern_veil_chips'), index, state);
}

/** Updates the one-line status text on the overlay (e.g. "Pass 2/3 · Prose polish"). */
export function setVeilStatus(messageId, text) {
    const veil = activeVeils.get(Number(messageId));
    veil?.$overlay.find('.smarttavern_veil_title').text(String(text ?? ''));
}

/**
 * Drops the veil. Normal completion animates blur → sharp and fades the overlay out;
 * any failure path passes `failed: true` for an instant, unconditional reveal.
 */
export function revealVeil(messageId, { failed = false } = {}) {
    const id = Number(messageId);
    const veil = activeVeils.get(id);
    if (!veil) return;
    activeVeils.delete(id);
    if (veil.timer) clearTimeout(veil.timer);

    const teardown = () => {
        veil.$overlay.remove();
        veil.$text.removeClass('smarttavern_unveiling');
        veil.$mes.removeClass('smarttavern_veil_host');
    };
    veil.$text.removeClass('smarttavern_veiled smarttavern_veil_peek');

    if (failed) {
        teardown();
        return;
    }
    veil.$text.addClass('smarttavern_unveiling');
    veil.$overlay.addClass('is-leaving');
    veil.timer = setTimeout(teardown, REVEAL_MS);
}

/** Instant, animation-free cleanup (chat switch, interception, safety net). */
export function dismissVeil(messageId) {
    revealVeil(messageId, { failed: true });
}

export function dismissAllVeils() {
    disarmPreVeil();
    for (const id of [...activeVeils.keys()]) dismissVeil(id);
}

// Pre-veil: CHARACTER_MESSAGE_RENDERED fires only once the reply is complete — a
// streamed draft would be fully readable by then. The observer blurs the reply the
// moment its message node enters the chat DOM (the callback is a microtask, so it
// runs before the browser paints a single token). The refinement pipeline replaces
// this bare veil with the full tracking card once the reply finishes rendering.
let preVeilObserver = null;

/**
 * Arms a one-shot observer that veils the next character-message node inserted into
 * the chat. `isValid` is re-checked at insertion time; when it fails (the fresh-reply
 * mark was consumed or cancelled) nothing is veiled.
 * @param {{ isValid?: () => boolean }} [options]
 */
export function armPreVeil({ isValid = () => true } = {}) {
    disarmPreVeil();
    if (typeof MutationObserver !== 'function') return;
    const chatEl = document.getElementById('chat');
    if (!chatEl) return;
    const observer = new MutationObserver(mutations => {
        for (const mutation of mutations) {
            for (const node of mutation.addedNodes) {
                if (!(node instanceof HTMLElement) || !node.classList.contains('mes')) continue;
                if (node.classList.contains('is_user') || node.classList.contains('is_system')) continue;
                // The first character-message node is the incoming reply draft.
                disarmPreVeil();
                if (!isValid()) return;
                applyVeil(Number(node.getAttribute('mesid')), { names: [], allowPeek: false, title: 'Drafting reply…' });
                return;
            }
        }
    });
    preVeilObserver = observer;
    observer.observe(chatEl, { childList: true });
}

export function disarmPreVeil() {
    preVeilObserver?.disconnect();
    preVeilObserver = null;
}
