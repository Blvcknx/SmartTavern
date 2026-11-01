// SmartTavern — generation activity HUD: a small floating chip that tracks everything the
// extension does with LLM calls (pipeline steps, final pass, profile bootstrap/update).
// Folded it shows the current phase on a status chip; unfolded it reveals a log of every
// call with its output content as it arrives. Internal calls are not token-streamed, so
// content appears per completed call; a spinner row marks the call in flight.
import { getContext } from '../../../../extensions.js';
import { getSettings } from './state.js';
import { chipsHtml, setChipState } from './chips.js';

const IDLE_HIDE_MS = 15000;
const TICK_MS = 500;

let $root = null;
let $chipIcon = null;
let $chipText = null;
let $caretIcon = null;
let $current = null;
let $steps = null;
let $log = null;

let expanded = false;
let runCount = 0;
let statusText = '';
let runStartedAt = 0;
let errorPending = false;
let idleTimer = null;
let ticker = null;

const htmlEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => htmlEscapes[ch]);
}

function floatingAllowed() {
    return !Boolean(getSettings().disableFloatingUI);
}

function build() {
    if ($root) return;
    $root = $(`
        <div id="smarttavern_activity">
            <div id="smarttavern_activity_chip" title="SmartTavern activity — click to unfold">
                <i class="fa-solid fa-circle-notch fa-spin smarttavern_act_icon"></i>
                <span class="smarttavern_act_chip_text"></span>
                <i class="fa-solid fa-chevron-up smarttavern_act_caret"></i>
            </div>
            <div id="smarttavern_activity_body">
                <div class="smarttavern_act_head">
                    <i class="fa-solid fa-brain"></i>
                    <span>SmartTavern — generation activity</span>
                    <button type="button" class="smarttavern_act_clear" title="Clear retained activity entries">Clear log</button>
                    <button type="button" class="smarttavern_act_close" title="Collapse activity" aria-label="Collapse activity"><i class="fa-solid fa-xmark"></i></button>
                </div>
                <div class="smarttavern_act_steps"></div>
                <div class="smarttavern_act_refinement_controls" hidden></div>
                <div class="smarttavern_act_agent_controls" hidden></div>
                <div class="smarttavern_act_current"></div>
                <div class="smarttavern_act_log"></div>
            </div>
        </div>`);
    $chipIcon = $root.find('.smarttavern_act_icon');
    $chipText = $root.find('.smarttavern_act_chip_text');
    $caretIcon = $root.find('.smarttavern_act_caret');
    $current = $root.find('.smarttavern_act_current');
    $steps = $root.find('.smarttavern_act_steps');
    $log = $root.find('.smarttavern_act_log');
    $root.on('click', '#smarttavern_activity_chip', () => setExpanded(!expanded));
    $root.on('click', '.smarttavern_act_close', () => setExpanded(false));
    $root.on('click', '.smarttavern_act_clear', () => {
        $log.empty();
        errorPending = false;
        render();
    });
    $root.on('click', '.smarttavern_act_read', function () {
        const entry = $(this).closest('.smarttavern_act_entry');
        void readEntry(entry.find('.smarttavern_act_entry_title').text(), entry.find('.smarttavern_act_text').text());
    });
    $(document.body).append($root);
    render();
}

function show() {
    if (!$root || !floatingAllowed()) return;
    $root.addClass('show');
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    ensureTicker();
}

function hide() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    stopTicker();
    if ($root) {
        $root.removeClass('show');
    }
    expanded = false;
    render();
    emitState();
}

/** Retained entries keep the chip available for reopening until explicitly cleared. */
function scheduleIdleHide() {
    if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
    }
    if (runCount > 0 || expanded || errorPending || $log?.children().length || !$root?.hasClass('show')) return;
    idleTimer = setTimeout(hide, IDLE_HIDE_MS);
}

function ensureTicker() {
    if (ticker || runCount === 0) return;
    ticker = setInterval(() => {
        if (runCount > 0) renderStatus();
        else stopTicker();
    }, TICK_MS);
}

function stopTicker() {
    if (ticker) {
        clearInterval(ticker);
        ticker = null;
    }
}

function setExpanded(value) {
    expanded = Boolean(value);
    render();
}

/** Shows/hides the in-flight call row (spinner + current status). */
function setCurrent(text) {
    if (!$current) return;
    if (text) {
        $current.html('<i class="fa-solid fa-circle-notch fa-spin"></i><span></span>');
        $current.find('span').text(text);
        $current.addClass('is-active');
    } else {
        $current.removeClass('is-active').empty();
    }
}

function render() {
    if (!$root) return;
    $root.toggleClass('expanded', expanded);
    $caretIcon.toggleClass('rotated', expanded);
    $root.toggleClass('has-error', !runCount && errorPending);
    const running = runCount > 0;
    const icon = running ? 'fa-circle-notch fa-spin' : (errorPending ? 'fa-triangle-exclamation' : 'fa-check');
    $chipIcon.attr('class', `fa-solid smarttavern_act_icon ${icon}`);
    renderStatus();
    scheduleIdleHide();
}

function renderStatus() {
    if (!$chipText) return;
    let text = statusText;
    if (runCount > 0) {
        const secs = Math.max(0, Math.round((Date.now() - runStartedAt) / 1000));
        text = `${statusText} · ${secs}s`;
    }
    $chipText.text(text);
    if ($current?.hasClass('is-active')) $current.find('span').text(text);
}

function emitState() {
    document.dispatchEvent(new CustomEvent('smarttavern:progress', {
        detail: { active: runCount > 0, expanded, status: statusText },
    }));
}

function applyFloatingState() {
    if (!$root) return;
    if (!floatingAllowed()) hide();
    else if (runCount > 0 || $log.children().length) show();
}

// --------------------------------------------------------------------------------------------
// Public activity API (called from the pipeline and the profile lifecycle)
// --------------------------------------------------------------------------------------------

/** Opens a tracked run (pipeline pass, profile bootstrap/update). Nests safely. */
export function activityStart({ status = 'Working…' } = {}) {
    build();
    if (runCount === 0) errorPending = false;
    runCount++;
    runStartedAt = Date.now();
    if (status) statusText = String(status);
    show();
    render();
    emitState();
}

/** Marks the in-flight phase; the log's spinner row follows the chip text. */
export function activityStatus(status) {
    build();
    if (!status) return;
    statusText = String(status);
    setCurrent(statusText);
    renderStatus();
    emitState();
}

/** Renders the pass-tracker chip row for the current run; empty names clear it. */
export function activitySteps({ names = [], states = [] } = {}) {
    build();
    if (!$steps) return;
    if (!names.length) {
        $steps.empty().removeClass('is-active');
        return;
    }
    $steps.addClass('is-active').html(chipsHtml(names, states));
}

/** Flips one pass chip on the HUD's step row. */
export function activityStepState(index, state) {
    setChipState($steps, index, state);
}

/** Available in both visible and veiled refinement modes. */
export function activityRefinementControls({ onSkip = null, onEnough = null } = {}) {
    build();
    const controls = $root.find('.smarttavern_act_refinement_controls');
    controls.empty().prop('hidden', !onSkip && !onEnough);
    if (onSkip) $('<button type="button" class="menu_button">Skip pass</button>').on('click', onSkip).appendTo(controls);
    if (onEnough) $('<button type="button" class="menu_button">That\'s enough</button>').on('click', onEnough).appendTo(controls);
}

/** Thinking agent: a Skip button while the loop runs; no arguments clear it. */
export function activityAgentControls({ onSkip = null } = {}) {
    build();
    const controls = $root.find('.smarttavern_act_agent_controls');
    controls.empty().prop('hidden', !onSkip);
    if (onSkip) $('<button type="button" class="menu_button">Skip thinking</button>').on('click', onSkip).appendTo(controls);
}

/** Appends a completed entry (call output or informational note) to the log. */
export function activityEntry({ title = '', text = '', tone = 'ok' } = {}) {
    build();
    setCurrent(null);
    show();
    const logEl = $log.get(0);
    const stick = !logEl || (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight) < 48;
    const titleHtml = `<span class="smarttavern_act_entry_title">${escapeHtml(title || 'Activity output')}</span>`;
    const toneClass = ['ok', 'info', 'error'].includes(tone) ? tone : 'info';
    if (text) {
        const preview = String(text).replace(/\s+/g, ' ').trim().slice(0, 160);
        $log.append(`<details class="smarttavern_act_entry smarttavern_act_${toneClass}">
            <summary class="smarttavern_act_entry_head">${titleHtml}<span class="smarttavern_act_preview">${escapeHtml(preview)}</span></summary>
            <div class="smarttavern_act_entry_actions"><button type="button" class="menu_button smarttavern_act_read">Read full output</button></div>
            <pre class="smarttavern_act_text">${escapeHtml(text)}</pre>
        </details>`);
    } else {
        $log.append(`<div class="smarttavern_act_entry smarttavern_act_${toneClass}"><div class="smarttavern_act_entry_head">${titleHtml}</div></div>`);
    }
    if (stick && logEl) logEl.scrollTop = logEl.scrollHeight;
    render();
}

/** Snapshot the selected output so incoming activity never replaces the reader's text. */
async function readEntry(title, text) {
    const context = getContext();
    const content = document.createElement('div');
    content.className = 'smarttavern_act_reader';
    const heading = document.createElement('h3');
    heading.textContent = title;
    const pre = document.createElement('pre');
    pre.textContent = text;
    content.append(heading, pre);
    await context.callGenericPopup(content, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
}

/** Failure entry: alerts, auto-unfolds and keeps the chip visible until dismissed. */
export function activityFail(message) {
    errorPending = true;
    activityEntry({ title: message || 'Failed', tone: 'error' });
    if (!expanded) setExpanded(true);
}

/** Closes a tracked run: spinner stops; the chip shows the summary, then idles away. */
export function activityEnd({ ok = true, summary = '' } = {}) {
    build();
    runCount = Math.max(0, runCount - 1);
    setCurrent(null);
    if (summary) statusText = String(summary);
    if (!ok) errorPending = true;
    if (runCount === 0) stopTicker();
    render();
    emitState();
}

export function initProgress() {
    build();
    $(document).on('smarttavern:floating-changed', applyFloatingState);
}
