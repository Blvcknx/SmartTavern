// SmartTavern — Scene panel tab: the shared scene facts as editable rows (value, pin,
// lock, delete), an "Add fact" row, Track now / Clear scene buttons and an undo log of
// the user's own edits. Also hosts the /smarttavern-scene and /smarttavern-track runners.
//
// A thin view over scene.js: every edit funnels through userSetFacts (anchored to the
// last chat message, so it is rewind-safe like tracker and agent facts).
import { getContext } from '../../../../extensions.js';
import { getSettings } from './state.js';
import { isKeyInList, sortSceneEntries, renderScene } from './scene-core.js';
import {
    getSceneStore, getSceneEntries, sceneLog, userSetFacts, userRemoveFact, clearScene,
    undoSceneLogEntry, setScenePinned, setSceneLocked, trackSceneNow, isSceneBusy,
} from './scene.js';

const htmlEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => htmlEscapes[ch]);
}

let wired = false;

function $sceneRoot() {
    return $('#smarttavern_panel #smarttavern_scene_root');
}

const BADGES = { tracker: 'tracker', agent: 'agent', user: 'user' };

function statusLine() {
    const settings = getSettings();
    const parts = [settings.sceneTrackerEnabled
        ? `Tracker on · every ${settings.sceneTrackerEvery} character repl${settings.sceneTrackerEvery === 1 ? 'y' : 'ies'}`
        : 'Tracker off (enable it in Settings → Scene state)'];
    parts.push(`${getSceneEntries().length}/${settings.sceneMaxFacts} fact(s) active`);
    return parts.join(' · ');
}

function rowHtml(entry, store) {
    const key = escapeHtml(entry.key);
    const pinned = isKeyInList(entry.key, store.pinned);
    const locked = isKeyInList(entry.key, store.locked);
    return `
    <div class="smarttavern_ruling_row smarttavern_scene_row">
        <div class="smarttavern_ruling_meta">
            <span class="smarttavern_scene_key" title="${escapeHtml(entry.evidence || '')}">${key}</span>
            <span class="smarttavern_agent_memory_action smarttavern_agent_action_${escapeHtml(entry.by)}" title="Who set this fact last">${escapeHtml(BADGES[entry.by] ?? entry.by)}</span>
            <span class="smarttavern_ruling_spacer"></span>
            <a class="menu_button menu_button_icon smarttavern_scene_pin${pinned ? ' is-pinned' : ''}" data-key="${key}" data-on="${pinned ? '1' : ''}" title="${pinned ? 'Unpin — allow eviction by the fact cap again' : 'Pin — never evicted by the fact cap'}"><i class="fa-solid fa-thumbtack"></i></a>
            <a class="menu_button menu_button_icon smarttavern_scene_lock${locked ? ' is-pinned' : ''}" data-key="${key}" data-on="${locked ? '1' : ''}" title="${locked ? 'Unlock — let the tracker and the agent change it' : 'Lock — the tracker and the agent can no longer set or remove it'}"><i class="fa-solid fa-${locked ? 'lock' : 'lock-open'}"></i></a>
            <a class="menu_button menu_button_icon smarttavern_scene_delete" data-key="${key}" title="Remove this fact (undo below)"><i class="fa-solid fa-trash"></i></a>
        </div>
        <textarea class="smarttavern_scene_value smarttavern_ruling_text text_pole" rows="1" data-key="${key}" title="Edit the value — saved when you leave the field">${escapeHtml(entry.value)}</textarea>
    </div>`;
}

export function renderSceneTab() {
    const $root = $sceneRoot();
    if (!$root.length) return;
    const store = getSceneStore({ create: false });
    const entries = sortSceneEntries(getSceneEntries());
    const rows = entries.length
        ? entries.map(entry => rowHtml(entry, store)).join('')
        : '<div class="smarttavern_hint">No scene facts yet. The tracker fills this in after each character reply, the legacy agent can add facts, and you can add your own below.</div>';
    const log = sceneLog();
    const logRows = log.length
        ? log.map((record, index) => `
            <div class="smarttavern_agent_memory_row">
                <span class="smarttavern_agent_memory_action smarttavern_agent_action_${escapeHtml(record.action)}">${escapeHtml(record.action)}</span>
                <span class="smarttavern_agent_memory_title" title="${escapeHtml((record.changes ?? []).map(change => change.key).join(', '))}">${escapeHtml((record.changes ?? []).map(change => change.key).join(', ').slice(0, 80))}</span>
                <a class="menu_button menu_button_icon smarttavern_scene_undo" data-index="${index}" title="Undo this change"><i class="fa-solid fa-rotate-left"></i></a>
            </div>`).reverse().join('')
        : '<div class="smarttavern_hint">No manual scene changes in this chat yet.</div>';
    $root.html(`
        <div class="smarttavern_hint">
            Shared scene state — established, observable facts (location, time, <i>Name</i>.position,
            .clothing, .injuries, .inventory, .knows, .mood). Facts belong to the chat message they were
            recorded at, so swipes, edits and rewinds restore earlier values. Use <b>{{scene}}</b> in any
            prompt to insert them. <b>Pin</b> keeps a fact when the cap is reached; <b>Lock</b> stops the
            tracker and the agent from changing it.
        </div>
        <div class="smarttavern_story_status" id="smarttavern_scene_status">${escapeHtml(statusLine())}</div>
        <div class="smarttavern_row_actions">
            <a id="smarttavern_scene_track" class="menu_button smarttavern_busy_guard" title="Run the scene tracker on the latest character reply now"><i class="fa-solid fa-crosshairs"></i><span>${isSceneBusy() ? 'Tracking…' : 'Track now'}</span></a>
            <a id="smarttavern_scene_clear" class="menu_button smarttavern_busy_guard" title="Remove every unpinned fact (one undoable step; rewinding restores earlier scenes)"><i class="fa-solid fa-broom"></i><span>Clear scene</span></a>
        </div>
        <div id="smarttavern_scene_list">${rows}</div>
        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-plus"></i><span>Add fact</span></div>
        <div class="smarttavern_row_actions">
            <input id="smarttavern_scene_new_key" type="text" class="text_pole" placeholder="Alice.position" maxlength="100">
            <input id="smarttavern_scene_new_value" type="text" class="text_pole" placeholder="kneeling by the fire" maxlength="400">
            <a id="smarttavern_scene_add" class="menu_button" title="Add or overwrite this fact"><i class="fa-solid fa-plus"></i><span>Add</span></a>
        </div>
        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-clock-rotate-left"></i><span>Your scene changes (undo)</span></div>
        <div id="smarttavern_scene_log">${logRows}</div>
    `);
    $root.find('.smarttavern_scene_value').each(function () {
        this.style.height = 'auto';
        this.style.height = `${this.scrollHeight}px`;
    });
}

export function renderSceneTabSafe() {
    try {
        renderSceneTab();
    } catch (error) {
        console.error('[SmartTavern] scene tab render failed', error);
    }
}

async function confirmPopup(header, text) {
    const context = getContext();
    return (await context.Popup.show.confirm(header, text)) === context.POPUP_RESULT.AFFIRMATIVE;
}

/** Shared by the button and /smarttavern-track. */
export async function runTrackCommand() {
    if (isSceneBusy()) {
        toastr.info('The scene tracker is already running.', 'SmartTavern');
        return;
    }
    try {
        const outcome = await trackSceneNow();
        if (outcome?.error) toastr.warning(outcome.error, 'SmartTavern');
        else if (outcome) toastr.success(outcome.applied ? `Scene: ${outcome.applied} update(s).` : 'Scene: no changes.', 'SmartTavern');
    } catch (error) {
        toastr.error(`Scene tracking failed — ${error?.message ?? error}`, 'SmartTavern');
    }
    renderSceneTabSafe();
}

export async function showSceneState() {
    const context = getContext();
    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = 'Scene state';
    const pre = document.createElement('pre');
    pre.className = 'smarttavern_popup_pre';
    pre.style.maxHeight = '55vh';
    pre.textContent = renderScene(getSceneEntries());
    content.append(title, pre);
    await context.callGenericPopup(content, context.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}

export function wireSceneTab($root) {
    if (wired) return;
    wired = true;
    // The panel is built DETACHED (see panel.js buildPanel): delegate on the root passed in.
    const $panel = $root ?? $('#smarttavern_panel');
    if (!$panel.length) {
        wired = false;
        return;
    }
    const keyOf = element => String($(element).attr('data-key') ?? '');

    $panel.on('change', '.smarttavern_scene_value', function () {
        const value = String(this.value ?? '').trim();
        const key = keyOf(this);
        if (!userSetFacts([{ key, value }], value ? 'edit' : 'delete')) toastr.info('SmartTavern: nothing to change.', 'SmartTavern');
        renderSceneTabSafe();
    });
    $panel.on('input', '.smarttavern_scene_value', function () {
        this.style.height = 'auto';
        this.style.height = `${this.scrollHeight}px`;
    });
    $panel.on('click', '.smarttavern_scene_pin', function () {
        setScenePinned(keyOf(this), $(this).attr('data-on') !== '1');
        renderSceneTabSafe();
    });
    $panel.on('click', '.smarttavern_scene_lock', function () {
        setSceneLocked(keyOf(this), $(this).attr('data-on') !== '1');
        renderSceneTabSafe();
    });
    $panel.on('click', '.smarttavern_scene_delete', function () {
        if (userRemoveFact(keyOf(this))) toastr.info('SmartTavern: scene fact removed (undo below).', 'SmartTavern');
        renderSceneTabSafe();
    });
    $panel.on('click', '#smarttavern_scene_add', function () {
        const key = String($panel.find('#smarttavern_scene_new_key').val() ?? '').trim();
        const value = String($panel.find('#smarttavern_scene_new_value').val() ?? '').trim();
        if (!key || !value) {
            toastr.warning('SmartTavern: enter both a key and a value.', 'SmartTavern');
            return;
        }
        if (!userSetFacts([{ key, value }], 'add')) toastr.warning('SmartTavern: nothing changed (same value, or no message to attach it to).', 'SmartTavern');
        renderSceneTabSafe();
    });
    $panel.on('click', '.smarttavern_scene_undo', function () {
        const index = Number($(this).attr('data-index') ?? -1);
        if (!Number.isInteger(index) || index < 0) return;
        if (undoSceneLogEntry(index)) toastr.success('SmartTavern: scene change undone.', 'SmartTavern');
        else toastr.warning('SmartTavern: the scene changed since — undo skipped.', 'SmartTavern');
        renderSceneTabSafe();
    });
    $panel.on('click', '#smarttavern_scene_track', async () => {
        await runTrackCommand();
    });
    $panel.on('click', '#smarttavern_scene_clear', async () => {
        if (!await confirmPopup('Clear the scene?', 'Removes every unpinned fact from the current scene. Pinned facts stay; you can undo this below, and rewinding the chat restores earlier scenes.')) return;
        const removed = clearScene();
        toastr.info(removed ? `SmartTavern: ${removed} fact(s) cleared (undo below).` : 'SmartTavern: nothing to clear.', 'SmartTavern');
        renderSceneTabSafe();
    });

    // Tracker / agent writes land while the tab is open: refresh unless the user is typing.
    document.addEventListener('smarttavern:scene-updated', () => {
        const root = $sceneRoot().get(0);
        if (!root || !$(root).closest('.smarttavern_tab_panel').hasClass('active')) return;
        if (root.contains(document.activeElement) && /^(TEXTAREA|INPUT)$/.test(document.activeElement.tagName)) return;
        renderSceneTabSafe();
    });
}
