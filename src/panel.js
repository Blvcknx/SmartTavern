// SmartTavern — the floating panel: a compact, draggable window summoned over the chat
// with one-click access to the living bio (Profile), pipeline steps, schema fields,
// the latest pipeline run (Results) and every remaining setting (Settings).
//
// The panel is built once at init and kept detached from the DOM while closed, so it has
// zero footprint until summoned. All lookups therefore go through $panel().find(...) —
// document.getElementById would fail on detached nodes.
import { getContext } from '../../../../extensions.js';
import {
    DEFAULT_FIELDS, DEFAULT_STEPS, DEFAULT_REFINEMENT_STEPS, PIPELINE_MODES, STEP_ROLES,
    getSettings, saveSettings, getChatStore, allStoredProfiles, clearAllProfiles,
    resolveTargetChar, getGroupMembers, getMainCharacter, charKey,
    getStoredProfile, setStoredProfile, log,
} from './state.js';
import { listConnectionProfiles } from './gen.js';
import { runPipeline, getLastRunResult } from './pipeline.js';
import { rebuildProfile, updateProfile, resetProfile, serializeProfile } from './profiles.js';

const TABS = ['profile', 'steps', 'schema', 'results', 'settings'];

// --------------------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------------------

export function escapeHtml(text) {
    return $('<div>').text(String(text ?? '')).html();
}

export function coerceNumber(el, current) {
    const num = Number(el.value);
    if (!Number.isFinite(num)) return current;
    const min = Number.isFinite(Number(el.min)) ? Number(el.min) : -Infinity;
    const max = Number.isFinite(Number(el.max)) ? Number(el.max) : Infinity;
    return Math.min(max, Math.max(min, Math.round(num)));
}

export async function confirmPopup(header, text) {
    const context = getContext();
    const result = await context.Popup.show.confirm(header, text);
    return result === context.POPUP_RESULT.AFFIRMATIVE;
}

export function appendSection(container, title, text) {
    const titleEl = document.createElement('div');
    titleEl.className = 'smarttavern_popup_section_title';
    titleEl.textContent = String(title ?? '');
    const pre = document.createElement('pre');
    pre.className = 'smarttavern_popup_pre';
    pre.textContent = String(text ?? '');
    container.append(titleEl, pre);
}

// Popup.show.text() builds its content from the text argument as a string, so DOM elements
// passed there render as "[object HTMLDivElement]". DOM content must go through the Popup
// constructor directly instead.
export async function showContentPopup(header, body) {
    const context = getContext();
    const content = document.createElement('div');
    const titleEl = document.createElement('h3');
    titleEl.textContent = String(header ?? '');
    content.append(titleEl, body);
    return await context.callGenericPopup(content, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
}

// --------------------------------------------------------------------------------------------
// Panel lifecycle
// --------------------------------------------------------------------------------------------

let panelRoot = null;
let activeTab = 'profile';
let profileTabCharKey = null;
let bioSaveTimer = null;

function $panel() {
    if (!panelRoot) buildPanel();
    return panelRoot;
}

export function initPanel() {
    $panel();

    document.addEventListener('keydown', (event) => {
        if (event.key !== 'Escape') return;
        if (!isPanelOpen()) return;
        // A native popup on the top layer owns the Escape key.
        if (document.querySelector('dialog.popup[open]')) return;
        event.stopPropagation();
        closePanel();
    }, true);

    window.addEventListener('resize', clampPanelIntoViewport);

    const context = getContext();
    context.eventSource.on(context.event_types.CHAT_CHANGED, () => {
        profileTabCharKey = null;
        refreshStatus();
        if (isPanelOpen() && activeTab === 'profile') renderProfileTab();
    });

    // Fired after programmatic profile writes (quick update from the avatar menu, panel buttons).
    document.addEventListener('smarttavern:profile-updated', () => {
        if (isPanelOpen() && activeTab === 'profile') renderProfileTab();
    });

    log('floating panel ready');
}

export function isPanelOpen() {
    return Boolean(panelRoot?.get(0)?.isConnected);
}

export function openPanel(tab = null, options = {}) {
    const settings = getSettings();
    if (settings.disableFloatingUI) {
        toastr.info('The SmartTavern floating UI is disabled. Re-enable it in the extension settings drawer.', 'SmartTavern');
        return;
    }
    const panelEl = $panel().get(0);
    if (!panelEl.isConnected) document.body.append(panelEl);
    applySavedPosition();
    clampPanelIntoViewport();
    if (options.charKey) profileTabCharKey = String(options.charKey);
    switchTab(tab ?? settings.ui?.tab ?? 'profile');
    refreshProfileSelects();
    refreshStatus();
}

export function closePanel() {
    if (!isPanelOpen()) return;
    $panel().detach();
}

export function togglePanel() {
    if (isPanelOpen()) closePanel();
    else openPanel();
}

function persistUi(patch) {
    const settings = getSettings();
    if (Object.isFrozen(settings)) return; // never write into the frozen defaults fallback
    settings.ui = { ...(settings.ui ?? {}), ...patch };
    saveSettings();
}

// --------------------------------------------------------------------------------------------
// Positioning & dragging
// --------------------------------------------------------------------------------------------

function applySavedPosition() {
    const panelEl = $panel().get(0);
    const ui = getSettings().ui ?? {};
    const x = Number(ui.x);
    const y = Number(ui.y);
    // Note: Number(null) === 0, so null must be excluded before the isFinite check.
    if (ui.x != null && ui.y != null && Number.isFinite(x) && Number.isFinite(y)) {
        panelEl.style.left = `${x}px`;
        panelEl.style.top = `${y}px`;
    } else {
        applyDefaultPosition();
    }
}

function applyDefaultPosition() {
    const panelEl = $panel().get(0);
    const height = Math.min(panelEl.offsetHeight || 480, window.innerHeight - 16);
    panelEl.style.left = `${Math.max(8, Math.round(window.innerWidth * 0.05))}px`;
    panelEl.style.top = `${Math.max(8, Math.round((window.innerHeight - height) / 2))}px`;
}

function clampPanelIntoViewport() {
    const panelEl = $panel().get(0);
    if (!panelEl?.isConnected) return;
    const left = Math.min(Math.max(8, panelEl.offsetLeft), Math.max(8, window.innerWidth - panelEl.offsetWidth - 8));
    const top = Math.min(Math.max(8, panelEl.offsetTop), Math.max(8, window.innerHeight - Math.min(panelEl.offsetHeight, window.innerHeight - 16) - 8));
    panelEl.style.left = `${left}px`;
    panelEl.style.top = `${top}px`;
}

function initDrag() {
    const header = $panel().find('.smarttavern_panel_header').get(0);
    header.addEventListener('pointerdown', (event) => {
        // Mobile gets a fixed near-fullscreen sheet instead of a draggable window.
        if (window.innerWidth <= 900) return;
        if (event.button !== 0) return;
        if (event.target.closest('.menu_button, .smarttavern_panel_close')) return;
        event.preventDefault();
        const panelEl = $panel().get(0);
        const offsetX = event.clientX - panelEl.offsetLeft;
        const offsetY = event.clientY - panelEl.offsetTop;
        panelEl.classList.add('dragging');
        const onMove = (moveEvent) => {
            panelEl.style.left = `${moveEvent.clientX - offsetX}px`;
            panelEl.style.top = `${moveEvent.clientY - offsetY}px`;
            clampPanelIntoViewport();
        };
        const onUp = () => {
            panelEl.classList.remove('dragging');
            window.removeEventListener('pointermove', onMove);
            persistUi({ x: panelEl.offsetLeft, y: panelEl.offsetTop });
        };
        window.addEventListener('pointermove', onMove);
        window.addEventListener('pointerup', onUp, { once: true });
        window.addEventListener('pointercancel', onUp, { once: true });
    });

    header.addEventListener('dblclick', (event) => {
        if (event.target.closest('.menu_button, .smarttavern_panel_close')) return;
        persistUi({ x: null, y: null });
        applyDefaultPosition();
    });
}

// --------------------------------------------------------------------------------------------
// Tabs
// --------------------------------------------------------------------------------------------

function switchTab(tab) {
    activeTab = TABS.includes(tab) ? tab : 'profile';
    persistUi({ tab: activeTab });
    $panel().find('.smarttavern_tab_button').each(function () {
        $(this).toggleClass('active', String($(this).data('tab')) === activeTab);
    });
    $panel().find('.smarttavern_tab_panel').each(function () {
        $(this).toggleClass('active', String($(this).data('tab')) === activeTab);
    });
    renderActiveTab();
}

function renderActiveTab() {
    if (activeTab === 'profile') renderProfileTab();
    else if (activeTab === 'steps') renderStepEditor();
    else if (activeTab === 'schema') renderFieldEditor();
    else if (activeTab === 'results') renderResultsTab();
    autoGrowAll();
}

function autoGrowAll() {
    $panel().find('.smarttavern_step_prompt, .smarttavern_bio_value').each(function () {
        this.style.height = 'auto';
        this.style.height = `${this.scrollHeight}px`;
    });
}

// --------------------------------------------------------------------------------------------
// Panel markup
// --------------------------------------------------------------------------------------------

function buildPanelHtml() {
    const settings = getSettings();
    return `
    <div id="smarttavern_panel">
        <div class="smarttavern_panel_header">
            <i class="fa-solid fa-brain smarttavern_panel_icon"></i>
            <span class="smarttavern_panel_title">SmartTavern</span>
            <a class="menu_button menu_button_icon smarttavern_panel_close" title="Close (Esc)"><i class="fa-solid fa-xmark"></i></a>
        </div>
        <div class="smarttavern_panel_tabs">
            <a class="smarttavern_tab_button" data-tab="profile" title="Living bio of the current character"><i class="fa-solid fa-user-pen"></i><span>Profile</span></a>
            <a class="smarttavern_tab_button" data-tab="steps" title="Pipeline steps"><i class="fa-solid fa-diagram-project"></i><span>Steps</span></a>
            <a class="smarttavern_tab_button" data-tab="schema" title="Profile schema fields"><i class="fa-solid fa-list-check"></i><span>Schema</span></a>
            <a class="smarttavern_tab_button" data-tab="results" title="Latest pipeline run"><i class="fa-solid fa-square-poll-horizontal"></i><span>Results</span></a>
            <a class="smarttavern_tab_button" data-tab="settings" title="Settings"><i class="fa-solid fa-sliders"></i><span>Settings</span></a>
        </div>
        <div class="smarttavern_panel_body">

            <div class="smarttavern_tab_panel" data-tab="profile">
                <select id="smarttavern_profile_char" title="Character"></select>
                <div class="smarttavern_meta" id="smarttavern_profile_meta"></div>
                <div id="smarttavern_profile_fields"></div>
                <div class="smarttavern_hint" id="smarttavern_profile_hint">
                    No profile stored for this character in this chat yet. It is created automatically on
                    the next generation — or click <b>Rebuild</b> to compile one from the character card now.
                </div>
                <div class="smarttavern_hint">
                    Edit any field above — changes save automatically. Future LLM updates merge around your edits.
                </div>
                <div class="smarttavern_row_actions">
                    <a id="smarttavern_profile_update" class="menu_button" title="Low-drift update from the recent conversation"><i class="fa-solid fa-arrows-rotate"></i><span>Update now</span></a>
                    <a id="smarttavern_profile_rebuild" class="menu_button" title="Full rewrite from the character card"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Rebuild</span></a>
                    <a id="smarttavern_profile_reset" class="menu_button" title="Delete the stored profile"><i class="fa-solid fa-trash"></i><span>Reset</span></a>
                </div>
            </div>

            <div class="smarttavern_tab_panel" data-tab="steps">
                <div class="smarttavern_hint">
                    Each enabled step is an isolated LLM call. Steps can read earlier outputs
                    via {{step:Step Name}} and the profile via {{definitions}} or {{field:Name}}.
                    In refinement mode steps run strictly in order and edit {{draft}} (the current
                    reply revision; pass 1 starts from {{original_draft}}) — wrap the revised reply
                    in &lt;revised_reply&gt;...&lt;/revised_reply&gt; or answer &lt;audit&gt;PASS&lt;/audit&gt; to keep the draft.
                    In expansion mode independent steps can run together; references to earlier
                    outputs preserve their order. Each step may pin its own Connection Manager profile.
                    The lookback number sets this step's chat history for {{chat}} (0 = none, empty =
                    global default); {{chat:N}} requests exactly N messages. Per-block roles apply to
                    history positions; prompt-end mode uses the tail role in Settings. Click a card
                    header to collapse it.
                </div>
                <div id="smarttavern_steps"></div>
                <div class="smarttavern_row_actions">
                    <a id="smarttavern_add_step" class="menu_button"><i class="fa-solid fa-plus"></i><span>Add step</span></a>
                    <a id="smarttavern_restore_refinement_steps" class="menu_button" title="Replace the step list with the default 3-pass refinement preset (Body / Character / Prose)"><i class="fa-solid fa-rotate-left"></i><span>Refinement preset</span></a>
                    <a id="smarttavern_restore_expansion_steps" class="menu_button" title="Replace the step list with the default expansion preset (Physical / Mental Condition)"><i class="fa-solid fa-rotate-left"></i><span>Expansion preset</span></a>
                </div>
            </div>

            <div class="smarttavern_tab_panel" data-tab="schema">
                <div class="smarttavern_hint">
                    The profile JSON schema is built from these fields. They drive the bootstrap,
                    background updates, and the {{definitions}} / {{field:Name}} macros.
                </div>
                <div id="smarttavern_fields"></div>
                <div class="smarttavern_row_actions">
                    <a id="smarttavern_add_field" class="menu_button"><i class="fa-solid fa-plus"></i><span>Add field</span></a>
                    <a id="smarttavern_restore_fields" class="menu_button"><i class="fa-solid fa-rotate-left"></i><span>Restore defaults</span></a>
                </div>
            </div>

            <div class="smarttavern_tab_panel" data-tab="results">
                <div class="smarttavern_row_actions">
                    <a id="smarttavern_run_now" class="menu_button" title="Dry run: executes the steps without changing anything (refinement mode previews the final reply)"><i class="fa-solid fa-play"></i><span>Run pipeline now</span></a>
                </div>
                <div id="smarttavern_results_body"></div>
            </div>

            <div class="smarttavern_tab_panel" data-tab="settings">
                <label>Pipeline mode
                    <select id="smarttavern_pipelineMode" title="Refinement edits the reply after generation; expansion injects step outputs before generation">
                        <option value="refinement"${settings.pipelineMode !== 'expansion' ? ' selected' : ''}>Final refinement (post-reply multi-pass editing)</option>
                        <option value="expansion"${settings.pipelineMode === 'expansion' ? ' selected' : ''}>Context expansion (pre-reply state injection)</option>
                    </select>
                </label>
                <div class="smarttavern_refinement_only">
                    <label class="checkbox" title="Each pass that changes the reply is appended to the message swipes so you can browse the draft and every revision">
                        <input id="smarttavern_savePassesAsSwipes" type="checkbox" ${settings.savePassesAsSwipes ? 'checked' : ''}>
                        <span>Save each refinement pass as a message swipe</span>
                    </label>
                </div>
                <div class="smarttavern_hint" id="smarttavern_mode_hint"></div>
                <label class="checkbox">
                    <input id="smarttavern_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                    <span>Enable SmartTavern (pipeline injection)</span>
                </label>
                <label class="checkbox">
                    <input id="smarttavern_autoUpdate" type="checkbox" ${settings.autoUpdate ? 'checked' : ''}>
                    <span>Auto-update profiles in the background</span>
                </label>
                <label class="checkbox">
                    <input id="smarttavern_bootstrapOnFirstMessage" type="checkbox" ${settings.bootstrapOnFirstMessage ? 'checked' : ''}>
                    <span>Bootstrap profile on first message (full rewrite of the card into the schema)</span>
                </label>
                <label class="checkbox" title="Hides the avatar menu, the wand-menu button and this panel; the settings drawer stays available">
                    <input id="smarttavern_disableFloatingUI" type="checkbox" ${settings.disableFloatingUI ? 'checked' : ''}>
                    <span>Disable floating UI</span>
                </label>

                <div class="smarttavern_grid">
                    <label>Step execution
                        <select id="smarttavern_stepExecution">
                            <option value="dependencies"${settings.stepExecution !== 'sequential' ? ' selected' : ''}>Parallel where independent</option>
                            <option value="sequential"${settings.stepExecution === 'sequential' ? ' selected' : ''}>Sequential</option>
                        </select>
                    </label>
                    <label>Update every N messages
                        <input id="smarttavern_updateInterval" class="text_margin_input" type="number" min="1" max="200" step="1" value="${settings.updateInterval}">
                    </label>
                    <label>Pipeline chat lookback (messages)
                        <input id="smarttavern_chatLookback" class="text_margin_input" type="number" min="1" max="200" step="1" value="${settings.chatLookback}">
                    </label>
                    <label>Updater chat lookback (messages)
                        <input id="smarttavern_profileUpdateLookback" class="text_margin_input" type="number" min="1" max="200" step="1" value="${settings.profileUpdateLookback}">
                    </label>
                    <label>Step max tokens
                        <input id="smarttavern_stepMaxTokens" class="text_margin_input" type="number" min="16" max="8192" step="16" value="${settings.stepMaxTokens}">
                    </label>
                    <label>Updater max tokens
                        <input id="smarttavern_updaterMaxTokens" class="text_margin_input" type="number" min="16" max="8192" step="16" value="${settings.updaterMaxTokens}">
                    </label>
                    <label title="Only applies when the position is set to Custom depth">Injection depth (custom position only)
                        <input id="smarttavern_injectDepth" class="text_margin_input" type="number" min="0" max="50" step="1" value="${settings.injectDepth}">
                    </label>
                </div>

                <div class="smarttavern_expansion_only">
                <label>Injection position
                    <select id="smarttavern_injectAnchor" title="Where generated assessments enter the reply prompt">
                        <option value="prompt-end"${settings.injectAnchor === 'prompt-end' ? ' selected' : ''}>End of assembled reply prompt</option>
                        <option value="before-last-user"${settings.injectAnchor === 'before-last-user' ? ' selected' : ''}>Before the user's latest message</option>
                        <option value="after-last-user"${settings.injectAnchor === 'after-last-user' ? ' selected' : ''}>After the user's latest message</option>
                        <option value="top-of-history"${settings.injectAnchor === 'top-of-history' ? ' selected' : ''}>Top of chat history</option>
                        <option value="depth"${settings.injectAnchor === 'depth' ? ' selected' : ''}>Custom depth (see "Injection depth")</option>
                    </select>
                </label>

                <label>Prompt-tail role
                    <select id="smarttavern_tailRole" title="Role of the complete assembled tail; use this to compare model behavior">
                        <option value="assistant"${settings.tailRole === 'assistant' ? ' selected' : ''}>Assistant</option>
                        <option value="user"${settings.tailRole === 'user' ? ' selected' : ''}>User</option>
                        <option value="system"${settings.tailRole === 'system' ? ' selected' : ''}>System</option>
                    </select>
                </label>
                <label>Reply prompt-tail template
                    <textarea id="smarttavern_tailPrompt" class="smarttavern_textarea" rows="8">${escapeHtml(settings.tailPrompt)}</textarea>
                </label>
                <div class="smarttavern_hint">Prompt-end mode assembles this template locally after block generation. Include {{steps}} for all generated assessments, or {{step:Name}} for individual blocks. No extra LLM call. The tail is context for the upcoming reply. Header/footer and per-block roles below apply only to history positions.</div>
                <label>History injection name (fallback author)
                    <input id="smarttavern_injectName" class="text_margin_input" type="text" value="${escapeHtml(settings.injectName)}">
                </label>
                <label>History header (macros: {{char}}, {{user}}, {{definitions}}, {{chat}})
                    <textarea id="smarttavern_injectionHeader" class="smarttavern_textarea" rows="4">${escapeHtml(settings.injectionHeader)}</textarea>
                </label>
                <label>History footer
                    <textarea id="smarttavern_injectionFooter" class="smarttavern_textarea" rows="2">${escapeHtml(settings.injectionFooter)}</textarea>
                </label>
                </div>

                <label>Profile updater connection profile
                    <select id="smarttavern_profileUpdateProfileId" class="smarttavern_profile_select"></select>
                </label>

                <hr>

                <div class="smarttavern_row_actions">
                    <a id="smarttavern_view_profiles" class="menu_button"><i class="fa-solid fa-eye"></i><span>View profiles</span></a>
                    <a id="smarttavern_update_all" class="menu_button"><i class="fa-solid fa-arrows-rotate"></i><span>Update all</span></a>
                    <a id="smarttavern_reset_all" class="menu_button"><i class="fa-solid fa-trash"></i><span>Reset all</span></a>
                </div>
            </div>

        </div>
    </div>`;
}

function buildPanel() {
    panelRoot = $(buildPanelHtml());

    $panel().on('click', '.smarttavern_tab_button', function () {
        switchTab(String($(this).data('tab') ?? ''));
    });
    $panel().find('.smarttavern_panel_close').on('click', () => closePanel());

    wireGeneralControls();
    applyModeVisibility();
    wireDataButtons();
    wireProfileTab();
    initDrag();

    // Grow textareas with their content (step prompts, hand-edited bio fields).
    $panel().on('input', '.smarttavern_step_prompt, .smarttavern_bio_value', function () {
        this.style.height = 'auto';
        this.style.height = `${this.scrollHeight}px`;
    });
}

// --------------------------------------------------------------------------------------------
// General controls (Settings tab)
// --------------------------------------------------------------------------------------------

const PANEL_CONTROLS = [
    ['smarttavern_enabled', 'enabled', 'checkbox'],
    ['smarttavern_autoUpdate', 'autoUpdate', 'checkbox'],
    ['smarttavern_bootstrapOnFirstMessage', 'bootstrapOnFirstMessage', 'checkbox'],
    ['smarttavern_savePassesAsSwipes', 'savePassesAsSwipes', 'checkbox'],
    ['smarttavern_updateInterval', 'updateInterval', 'number'],
    ['smarttavern_chatLookback', 'chatLookback', 'number'],
    ['smarttavern_profileUpdateLookback', 'profileUpdateLookback', 'number'],
    ['smarttavern_stepMaxTokens', 'stepMaxTokens', 'number'],
    ['smarttavern_updaterMaxTokens', 'updaterMaxTokens', 'number'],
    ['smarttavern_injectDepth', 'injectDepth', 'number'],
    ['smarttavern_injectName', 'injectName', 'text'],
    ['smarttavern_injectionHeader', 'injectionHeader', 'text'],
    ['smarttavern_injectionFooter', 'injectionFooter', 'text'],
    ['smarttavern_tailPrompt', 'tailPrompt', 'text'],
    ['smarttavern_tailRole', 'tailRole', 'text'],
];

function wireGeneralControls() {
    for (const [id, key, type] of PANEL_CONTROLS) {
        const el = $panel().find(`#${id}`).get(0);
        if (!el) continue;
        el.addEventListener(type === 'checkbox' ? 'change' : 'input', () => {
            const settings = getSettings();
            if (type === 'checkbox') settings[key] = el.checked;
            else if (type === 'number') settings[key] = coerceNumber(el, Number(settings[key]));
            else settings[key] = String(el.value);
            saveSettings();
            refreshStatus();
            // The enable toggle exists in both the drawer and this panel — keep them in sync.
            // The global selector resolves to the drawer's checkbox (first in document order).
            if (id === 'smarttavern_enabled') $('#smarttavern_enabled').prop('checked', el.checked);
        });
    }

    const disableEl = $panel().find('#smarttavern_disableFloatingUI').get(0);
    disableEl?.addEventListener('change', () => {
        getSettings().disableFloatingUI = disableEl.checked;
        saveSettings();
        document.dispatchEvent(new CustomEvent('smarttavern:floating-changed'));
    });

    const select = $panel().find('#smarttavern_profileUpdateProfileId').get(0);
    select?.addEventListener('change', () => {
        getSettings().profileUpdateProfileId = String(select.value ?? '');
        saveSettings();
    });

    const anchorEl = $panel().find('#smarttavern_injectAnchor').get(0);
    anchorEl?.addEventListener('change', () => {
        getSettings().injectAnchor = String(anchorEl.value ?? 'prompt-end');
        saveSettings();
    });
    $panel().find('#smarttavern_stepExecution').on('change', function () {
        getSettings().stepExecution = this.value;
        saveSettings();
    });

    const modeEl = $panel().find('#smarttavern_pipelineMode').get(0);
    modeEl?.addEventListener('change', () => {
        getSettings().pipelineMode = PIPELINE_MODES.includes(modeEl.value) ? modeEl.value : 'refinement';
        saveSettings();
        applyModeVisibility();
        refreshStatus();
    });
}

/** Shows only the settings relevant to the active pipeline mode. */
function applyModeVisibility() {
    const refinement = getSettings().pipelineMode !== 'expansion';
    $panel().find('.smarttavern_expansion_only').toggle(!refinement);
    $panel().find('.smarttavern_refinement_only').toggle(refinement);
    $panel().find('#smarttavern_mode_hint').text(refinement
        ? 'Refinement mode: SillyTavern writes the reply, then each enabled step audits and refines it in order (see the Steps tab). No prompt injection happens before the reply.'
        : 'Expansion mode: enabled steps run before generation and their outputs are injected into the reply prompt as context.');
}

export function refreshStatus() {
    const entries = allStoredProfiles();
    const settings = getSettings();
    $('#smarttavern_status').text(`${entries.length} profile(s) stored in this chat · auto-update every ${settings.updateInterval} messages`);
}

// --------------------------------------------------------------------------------------------
// Profile tab — the living bio, editable in place
// --------------------------------------------------------------------------------------------

function profileParticipants() {
    const context = getContext();
    const list = [];
    const seen = new Set();
    const push = (ch) => {
        if (!ch) return;
        const key = charKey(ch);
        if (seen.has(key)) return;
        seen.add(key);
        list.push(ch);
    };
    if (context.groupId) {
        for (const member of getGroupMembers()) push(member);
    } else {
        push(getMainCharacter());
        push(resolveTargetChar());
    }
    return list;
}

function currentProfileChar() {
    return profileParticipants().find(ch => charKey(ch) === profileTabCharKey) ?? null;
}

function renderProfileTab() {
    const settings = getSettings();
    const participants = profileParticipants();
    if (!participants.some(ch => charKey(ch) === profileTabCharKey)) {
        profileTabCharKey = participants[0] ? charKey(participants[0]) : null;
    }

    const $select = $panel().find('#smarttavern_profile_char');
    $select.html(participants.map(ch => {
        const key = charKey(ch);
        return `<option value="${escapeHtml(key)}"${key === profileTabCharKey ? ' selected' : ''}>${escapeHtml(ch.name ?? key)}</option>`;
    }).join(''));
    $select.toggle(participants.length > 0);

    const record = profileTabCharKey ? getStoredProfile(profileTabCharKey) : null;
    const char = currentProfileChar();

    $panel().find('#smarttavern_profile_meta').html(record
        ? `source: ${escapeHtml(record.source ?? 'unknown')} · last updated: message ${escapeHtml(record.updatedAt ?? '?')}`
        : 'No profile stored yet.');

    const $fields = $panel().find('#smarttavern_profile_fields').empty();
    const fields = Array.isArray(settings.fields) ? settings.fields : [];
    for (const field of fields) {
        const name = String(field?.name ?? '').trim();
        if (!name) continue;
        $fields.append(`
            <div class="smarttavern_bio_field">
                <label title="${escapeHtml(field.description ?? '')}">${escapeHtml(name)}</label>
                <textarea class="smarttavern_bio_value" data-field="${escapeHtml(name)}" rows="3"
                    placeholder="${escapeHtml(field.description ?? '')}" ${record ? '' : 'disabled'}>${escapeHtml(record?.fields?.[name] ?? '')}</textarea>
            </div>`);
    }
    if (!fields.length) {
        $fields.append('<div class="smarttavern_hint">No schema fields defined — add some in the Schema tab.</div>');
    }

    $panel().find('#smarttavern_profile_hint').toggle(!record);
    $panel().find('#smarttavern_profile_update, #smarttavern_profile_rebuild').toggleClass('disabled', !char);
}

function scheduleBioSave(key) {
    clearTimeout(bioSaveTimer);
    bioSaveTimer = setTimeout(() => {
        const record = getStoredProfile(key);
        if (record) setStoredProfile(key, record);
    }, 500);
}

function wireProfileTab() {
    $panel().on('change', '#smarttavern_profile_char', function () {
        profileTabCharKey = String($(this).val() ?? '') || null;
        renderProfileTab();
    });

    // Hand edits write straight into the live store record; the debounced save persists it.
    $panel().on('input', '.smarttavern_bio_value', function () {
        const key = profileTabCharKey;
        const record = key ? getStoredProfile(key) : null;
        const name = String($(this).data('field') ?? '');
        if (!record || !name) return;
        record.fields[name] = String(this.value);
        record.source = 'manual';
        scheduleBioSave(key);
    });

    $panel().find('#smarttavern_profile_update').on('click', async () => {
        const char = currentProfileChar();
        if (!char) return;
        try {
            const result = await updateProfile(char, { notify: true });
            if (!result) toastr.info('Update already in progress for this character.', 'SmartTavern');
            else document.dispatchEvent(new CustomEvent('smarttavern:profile-updated', { detail: { key: charKey(char) } }));
        } catch (error) {
            console.error('[SmartTavern] profile update failed', error);
            toastr.error(`Profile update failed — ${error?.message ?? error}`, 'SmartTavern');
        }
    });

    $panel().find('#smarttavern_profile_rebuild').on('click', async () => {
        const char = currentProfileChar();
        if (!char) return;
        const confirmed = await confirmPopup(
            `Rebuild the profile for ${char.name}?`,
            'The stored profile will be fully rewritten from the character card plus the recent conversation.',
        );
        if (!confirmed) return;
        try {
            const result = await rebuildProfile(char, { notify: true });
            if (!result) toastr.info('Rebuild already in progress for this character.', 'SmartTavern');
            else document.dispatchEvent(new CustomEvent('smarttavern:profile-updated', { detail: { key: charKey(char) } }));
        } catch (error) {
            console.error('[SmartTavern] profile rebuild failed', error);
            toastr.error(`Profile rebuild failed — ${error?.message ?? error}`, 'SmartTavern');
        }
    });

    $panel().find('#smarttavern_profile_reset').on('click', async () => {
        const key = profileTabCharKey;
        if (!key) return;
        const confirmed = await confirmPopup(
            'Reset this profile?',
            'The stored profile will be deleted. A new one will be bootstrapped on the next generation.',
        );
        if (!confirmed) return;
        resetProfile(key);
        toastr.info('SmartTavern: profile reset.', 'SmartTavern');
        renderProfileTab();
        refreshStatus();
    });
}

// --------------------------------------------------------------------------------------------
// Field editor (Schema tab)
// --------------------------------------------------------------------------------------------

function renderFieldEditor() {
    const settings = getSettings();
    const $container = $panel().find('#smarttavern_fields').empty();
    settings.fields.forEach((field, index) => {
        const row = $(`
            <div class="smarttavern_field_row">
                <input class="text_margin_input smarttavern_field_name" type="text" value="${escapeHtml(field.name)}" title="Field name (JSON key, {{field:Name}} target)">
                <input class="text_margin_input smarttavern_field_desc" type="text" value="${escapeHtml(field.description ?? '')}" title="Field description (fed to the LLM)">
                <div class="smarttavern_row_actions">
                    <a class="menu_button menu_button_icon smarttavern_field_up" title="Move up"><i class="fa-solid fa-arrow-up"></i></a>
                    <a class="menu_button menu_button_icon smarttavern_field_down" title="Move down"><i class="fa-solid fa-arrow-down"></i></a>
                    <a class="menu_button menu_button_icon smarttavern_field_delete" title="Delete field"><i class="fa-solid fa-trash"></i></a>
                </div>
            </div>`);
        row.find('.smarttavern_field_name').on('input', function () {
            settings.fields[index].name = String(/** @type {HTMLInputElement} */ (this).value);
            saveSettings();
        });
        row.find('.smarttavern_field_desc').on('input', function () {
            settings.fields[index].description = String(/** @type {HTMLInputElement} */ (this).value);
            saveSettings();
        });
        row.find('.smarttavern_field_up').on('click', () => moveArrayItem(settings.fields, index, -1, () => { saveSettings(); renderFieldEditor(); }));
        row.find('.smarttavern_field_down').on('click', () => moveArrayItem(settings.fields, index, +1, () => { saveSettings(); renderFieldEditor(); }));
        row.find('.smarttavern_field_delete').on('click', () => {
            settings.fields.splice(index, 1);
            saveSettings();
            renderFieldEditor();
        });
        $container.append(row);
    });
}

function moveArrayItem(array, index, delta, onFinish) {
    const target = index + delta;
    if (target < 0 || target >= array.length) return;
    const [item] = array.splice(index, 1);
    array.splice(target, 0, item);
    onFinish();
}

// --------------------------------------------------------------------------------------------
// Step editor (Steps tab)
// --------------------------------------------------------------------------------------------

function renderStepEditor() {
    const settings = getSettings();
    const $container = $panel().find('#smarttavern_steps').empty();
    settings.steps.forEach((step, index) => {
        const role = STEP_ROLES.includes(step.role) ? step.role : 'assistant';
        const card = $(`
            <div class="smarttavern_step_card">
                <div class="smarttavern_step_header">
                    <div class="smarttavern_step_chevron fa-solid fa-chevron-down" title="Collapse / expand"></div>
                    <label class="checkbox" title="Include this step in the pipeline">
                        <input class="smarttavern_step_enabled" type="checkbox" ${step.enabled !== false ? 'checked' : ''}>
                        <span>Enabled</span>
                    </label>
                    <input class="text_margin_input smarttavern_step_name" type="text" value="${escapeHtml(step.name)}" title="Step name (target of {{step:Name}})">
                    <select class="smarttavern_step_role" title="Role for history injection; prompt-end mode uses the tail role from Settings">
                        <option value="user"${role === 'user' ? ' selected' : ''}>User</option>
                        <option value="system"${role === 'system' ? ' selected' : ''}>System</option>
                        <option value="assistant"${role === 'assistant' ? ' selected' : ''}>Assistant</option>
                    </select>
                    <input class="text_margin_input smarttavern_step_lookback" type="number" min="0" max="200" step="1"
                        value="${step.lookback ?? ''}" placeholder="Global"
                        title="Messages of chat history for {{chat}} in this step (0 = none, empty = global default)">
                    <select class="smarttavern_step_profile smarttavern_profile_select" title="Connection profile for this step"></select>
                    <div class="smarttavern_row_actions">
                        <a class="menu_button menu_button_icon smarttavern_step_up" title="Move up"><i class="fa-solid fa-arrow-up"></i></a>
                        <a class="menu_button menu_button_icon smarttavern_step_down" title="Move down"><i class="fa-solid fa-arrow-down"></i></a>
                        <a class="menu_button menu_button_icon smarttavern_step_duplicate" title="Duplicate step"><i class="fa-solid fa-copy"></i></a>
                        <a class="menu_button menu_button_icon smarttavern_step_delete" title="Delete step"><i class="fa-solid fa-trash"></i></a>
                    </div>
                </div>
                <textarea class="smarttavern_step_prompt" rows="6" placeholder="Prompt for this step. Macros: {{char}}, {{user}}, {{card}}, {{definitions}}, {{chat}}, {{chat:N}}, {{draft}}, {{original_draft}}, {{field:Name}}, {{step:Name}}. Refinement steps: wrap the revised reply in <revised_reply></revised_reply> or answer <audit>PASS</audit> to keep the draft.">${escapeHtml(step.prompt)}</textarea>
            </div>`);
        // Header click collapses the card; interactive controls are excluded.
        card.find('.smarttavern_step_header').on('click', (event) => {
            if ($(event.target).closest('input, select, label, a, .menu_button').length) return;
            card.toggleClass('collapsed');
        });
        card.find('.smarttavern_step_enabled').on('change', function () {
            settings.steps[index].enabled = /** @type {HTMLInputElement} */ (this).checked;
            saveSettings();
        });
        card.find('.smarttavern_step_name').on('input', function () {
            settings.steps[index].name = String(/** @type {HTMLInputElement} */ (this).value);
            saveSettings();
        });
        card.find('.smarttavern_step_prompt').on('input', function () {
            settings.steps[index].prompt = String(/** @type {HTMLTextAreaElement} */ (this).value);
            saveSettings();
        });
        card.find('.smarttavern_step_profile').on('change', function () {
            settings.steps[index].profileId = String(/** @type {HTMLSelectElement} */ (this).value ?? '');
            saveSettings();
        });
        card.find('.smarttavern_step_role').on('change', function () {
            settings.steps[index].role = String(/** @type {HTMLSelectElement} */ (this).value);
            saveSettings();
        });
        card.find('.smarttavern_step_lookback').on('change', function () {
            const raw = String(/** @type {HTMLInputElement} */ (this).value ?? '').trim();
            settings.steps[index].lookback = raw === '' ? null : coerceNumber(this, null);
            saveSettings();
        });
        card.find('.smarttavern_step_up').on('click', () => moveArrayItem(settings.steps, index, -1, () => { saveSettings(); renderStepEditor(); }));
        card.find('.smarttavern_step_down').on('click', () => moveArrayItem(settings.steps, index, +1, () => { saveSettings(); renderStepEditor(); }));
        card.find('.smarttavern_step_duplicate').on('click', () => {
            const copy = { ...settings.steps[index], name: `${settings.steps[index].name} copy` };
            settings.steps.splice(index + 1, 0, copy);
            saveSettings();
            renderStepEditor();
        });
        card.find('.smarttavern_step_delete').on('click', () => {
            settings.steps.splice(index, 1);
            saveSettings();
            renderStepEditor();
        });
        $container.append(card);
    });
    refreshProfileSelects();
}

function profileOptionsHtml(selectedId = '') {
    const profiles = listConnectionProfiles();
    // A stored id that no longer resolves falls back to the active connection in gen.js;
    // render it that way instead of leaving the select with no selected option.
    if (selectedId && !profiles.some(p => p.id === selectedId)) selectedId = '';
    let html = `<option value=""${!selectedId ? ' selected' : ''}>Active connection</option>`;
    for (const profile of profiles) {
        const label = `${profile.name || profile.id} (${profile.mode ?? 'cc'})`;
        const selected = profile.id === selectedId ? ' selected' : '';
        html += `<option value="${escapeHtml(profile.id ?? '')}"${selected}>${escapeHtml(label)}</option>`;
    }
    return html;
}

/** Signature of the option list shared by every profile select. */
function profileListSignature() {
    return listConnectionProfiles()
        .map(p => `${p.id ?? ''}|${p.name ?? ''}|${p.mode ?? ''}`)
        .join(';');
}

/**
 * Rebuilds the connection-profile options of every profile select. Rewriting a select's
 * options while its native dropdown is open makes Chromium re-create the popup (looks
 * like a second dropdown spawning) and can swallow the pending pick, so the DOM is
 * touched only when the option list or the selection actually changed.
 */
export function refreshProfileSelects() {
    const settings = getSettings();
    const listSignature = profileListSignature();
    const refresh = (select, selectedId) => {
        const signature = `${listSignature}#${selectedId ?? ''}`;
        const $select = $(select);
        if ($select.data('stProfileOptions') === signature) return;
        $select.data('stProfileOptions', signature);
        $select.html(profileOptionsHtml(selectedId ?? ''));
    };
    const updater = $panel().find('#smarttavern_profileUpdateProfileId').get(0);
    if (updater) refresh(updater, settings.profileUpdateProfileId ?? '');
    $panel().find('#smarttavern_steps .smarttavern_step_profile').each(function (index) {
        refresh(this, settings.steps?.[index]?.profileId ?? '');
    });
}

// --------------------------------------------------------------------------------------------
// Data actions
// --------------------------------------------------------------------------------------------

function addField() {
    const settings = getSettings();
    settings.fields.push({ name: `Field ${settings.fields.length + 1}`, description: '' });
    saveSettings();
    renderFieldEditor();
}

async function restoreDefaultFields() {
    const confirmed = await confirmPopup(
        'Restore default fields?',
        'This replaces your field list with the SmartTavern defaults.',
    );
    if (!confirmed) return;
    getSettings().fields = structuredClone(DEFAULT_FIELDS).map(f => ({ name: f.name, description: f.description }));
    saveSettings();
    renderFieldEditor();
}

function addStep() {
    const settings = getSettings();
    settings.steps.push({ name: `Step ${settings.steps.length + 1}`, enabled: true, role: 'assistant', profileId: '', lookback: null, prompt: '' });
    saveSettings();
    renderStepEditor();
}

async function restoreDefaultRefinementSteps() {
    const confirmed = await confirmPopup(
        'Load the default refinement steps?',
        'This replaces your step list with the 3-pass refinement preset: Body & Spatial Awareness, Character & Psychological Authenticity, and Prose & Wording Polish.',
    );
    if (!confirmed) return;
    getSettings().steps = structuredClone(DEFAULT_REFINEMENT_STEPS).map(s => ({ ...s }));
    saveSettings();
    renderStepEditor();
}

async function restoreDefaultExpansionSteps() {
    const confirmed = await confirmPopup(
        'Load the default expansion steps?',
        'This replaces your step list with the Physical/Mental Condition expansion preset.',
    );
    if (!confirmed) return;
    getSettings().steps = structuredClone(DEFAULT_STEPS).map(s => ({ ...s }));
    saveSettings();
    renderStepEditor();
}

function wireDataButtons() {
    $panel().find('#smarttavern_add_field').on('click', addField);
    $panel().find('#smarttavern_restore_fields').on('click', restoreDefaultFields);
    $panel().find('#smarttavern_add_step').on('click', addStep);
    $panel().find('#smarttavern_restore_refinement_steps').on('click', restoreDefaultRefinementSteps);
    $panel().find('#smarttavern_restore_expansion_steps').on('click', restoreDefaultExpansionSteps);
    $panel().find('#smarttavern_run_now').on('click', () => showRunResults());
    $panel().find('#smarttavern_view_profiles').on('click', viewProfiles);
    $panel().find('#smarttavern_update_all').on('click', updateAllProfiles);
    $panel().find('#smarttavern_reset_all').on('click', resetAllProfiles);
}

async function viewProfiles() {
    const entries = allStoredProfiles();
    const container = document.createElement('div');
    if (!entries.length) {
        appendSection(container, 'Nothing stored yet', 'No SmartTavern profiles exist in this chat. They are created on the first generation (bootstrap) or via /smarttavern-rebuild.');
    } else {
        const fields = getSettings().fields ?? [];
        for (const [key, record] of entries) {
            const meta = `source: ${record.source ?? 'unknown'} · updatedAt: message ${record.updatedAt ?? '?'}`;
            appendSection(container, `${key} (${meta})`, serializeProfile(record, fields) || '(empty)');
        }
    }
    await showContentPopup('SmartTavern — stored profiles (this chat)', container);
}

async function updateAllProfiles() {
    const context = getContext();
    const entries = allStoredProfiles();
    if (!entries.length) {
        toastr.info('No stored profiles to update yet.', 'SmartTavern');
        return;
    }
    let updated = 0;
    let failed = 0;
    for (const [key] of entries) {
        const char = (context.characters ?? []).find(ch => charKey(ch) === key);
        if (!char) {
            failed++;
            continue;
        }
        try {
            const result = await updateProfile(char, { notify: false });
            if (result) updated++;
            else failed++;
        } catch (error) {
            failed++;
            console.error('[SmartTavern] update-all failed for', key, error);
        }
    }
    toastr.success(`SmartTavern: ${updated} profile(s) updated${failed ? `, ${failed} failed/skipped` : ''}.`, 'SmartTavern');
    refreshStatus();
}

async function resetAllProfiles() {
    const confirmed = await confirmPopup(
        'Reset all SmartTavern profiles?',
        'This deletes every profile stored in this chat. Character cards are never touched.',
    );
    if (!confirmed) return;
    const count = clearAllProfiles();
    toastr.info(`SmartTavern: removed ${count} profile(s).`, 'SmartTavern');
    refreshStatus();
}

// --------------------------------------------------------------------------------------------
// Results tab
// --------------------------------------------------------------------------------------------

function renderResultsTab() {
    const body = $panel().find('#smarttavern_results_body').empty().get(0);
    const result = getLastRunResult();
    if (!result) {
        const hint = document.createElement('div');
        hint.className = 'smarttavern_hint';
        hint.textContent = 'No pipeline run recorded yet. Use "Run pipeline now" for a dry run — or just chat: each generated reply (refinement mode) or state block (expansion mode) is captured here automatically.';
        body.append(hint);
        return;
    }
    const when = new Date(result.at).toLocaleTimeString();
    appendSection(
        body,
        `Target: ${result.char?.name ?? '?'} · ${result.source} · ${when}`,
        serializeProfile(result.profile, getSettings().fields) || '(no profile stored)',
    );
    const enabledSteps = (getSettings().steps ?? []).filter(s => s?.enabled !== false);
    for (const step of enabledSteps) {
        const output = result.stepOutputs?.[step.name] ?? '';
        appendSection(body, step.name || 'Step', output || '(no output — failed or empty, see browser console)');
    }
    if (result.injectionText) {
        appendSection(
            body,
            result.source === 'refinement' ? 'Final refined reply' : 'Assembled reply context',
            result.injectionText,
        );
    }
}

/** Dry-runs the pipeline and surfaces the outputs (Results tab, or a popup if the floating UI is off). */
export async function showRunResults() {
    const result = await runPipeline({ inject: false, bootstrap: false, type: 'normal' });
    if (!result) {
        toastr.warning('SmartTavern is disabled, or there is no character/chat to run against.', 'SmartTavern');
        return;
    }
    if (getSettings().disableFloatingUI) {
        const container = document.createElement('div');
        appendSection(container, `Target: ${result.char?.name ?? '?'}`, serializeProfile(result.profile, getSettings().fields) || '(no profile stored)');
        for (const step of (getSettings().steps ?? []).filter(s => s?.enabled !== false)) {
            appendSection(container, step.name || 'Step', result.stepOutputs?.[step.name] || '(no output — failed or empty, see browser console)');
        }
        if (result.injectionText) {
            appendSection(
                container,
                result.source === 'refinement' ? 'Final refined reply' : 'Assembled reply context',
                result.injectionText,
            );
        }
        await showContentPopup('SmartTavern — pipeline dry run', container);
        return;
    }
    openPanel('results');
}

// --------------------------------------------------------------------------------------------
// Slash command support
// --------------------------------------------------------------------------------------------

function resolveCharArg(value) {
    const name = String(value ?? '').trim();
    if (!name) return resolveTargetChar();
    const context = getContext();
    const pool = context.groupId ? getGroupMembers() : (context.characters ?? []);
    const needle = name.toLowerCase();
    const hit = pool.find(ch => String(ch?.name ?? '').trim().toLowerCase() === needle)
        ?? pool.find(ch => charKey(ch).toLowerCase() === needle);
    if (!hit) {
        toastr.warning(`SmartTavern: character "${name}" not found among chat participants.`, 'SmartTavern');
    }
    return hit ?? null;
}

export async function showProfilePopup(arg) {
    const char = resolveCharArg(arg);
    if (!char) return;
    const record = getStoredProfile(charKey(char));
    const container = document.createElement('div');
    appendSection(
        container,
        record ? `source: ${record.source ?? 'unknown'} · updatedAt: message ${record.updatedAt ?? '?'}` : char.name,
        record ? (serializeProfile(record, getSettings().fields) || '(empty profile)') : 'No SmartTavern profile stored for this character in this chat yet.',
    );
    await showContentPopup(`SmartTavern — profile: ${char.name}`, container);
}

export async function runUpdateCommand(arg) {
    const char = resolveCharArg(arg);
    if (!char) return;
    try {
        const result = await updateProfile(char, { notify: true });
        if (!result) toastr.info('Update already in progress for this character.', 'SmartTavern');
        else document.dispatchEvent(new CustomEvent('smarttavern:profile-updated', { detail: { key: charKey(char) } }));
    } catch (error) {
        console.error('[SmartTavern] /smarttavern-update failed', error);
        toastr.error(`Profile update failed — ${error?.message ?? error}`, 'SmartTavern');
    }
}

export async function runRebuildCommand(arg) {
    const char = resolveCharArg(arg);
    if (!char) return;
    try {
        const result = await rebuildProfile(char, { notify: true });
        if (!result) toastr.info('Rebuild already in progress for this character.', 'SmartTavern');
        else document.dispatchEvent(new CustomEvent('smarttavern:profile-updated', { detail: { key: charKey(char) } }));
    } catch (error) {
        console.error('[SmartTavern] /smarttavern-rebuild failed', error);
        toastr.error(`Profile rebuild failed — ${error?.message ?? error}`, 'SmartTavern');
    }
}

export async function runResetCommand(arg) {
    const char = resolveCharArg(arg);
    if (!char) return;
    const confirmed = await confirmPopup(
        `Reset profile for ${char.name}?`,
        'The stored profile will be deleted. A new one will be bootstrapped on the next generation.',
    );
    if (!confirmed) return;
    resetProfile(charKey(char));
    toastr.info(`SmartTavern: profile for ${char.name} reset.`, 'SmartTavern');
    refreshStatus();
}
