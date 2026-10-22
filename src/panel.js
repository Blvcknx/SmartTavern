// SmartTavern — the floating panel: a compact, draggable window summoned over the chat
// with one-click access to the living bio (Profile), pipeline steps, schema fields,
// the latest pipeline run (Results) and every remaining setting (Settings).
//
// The panel is built once at init and kept detached from the DOM while closed, so it has
// zero footprint until summoned. All lookups therefore go through $panel().find(...) —
// document.getElementById would fail on detached nodes.
import { getContext } from '../../../../extensions.js';
import {
    DEFAULT_FIELDS, DEFAULT_STEPS, DEFAULT_REFINEMENT_STEPS, STEP_ROLES,
    getSettings, saveSettings, getChatStore, allStoredProfiles, clearAllProfiles,
    resolveTargetChar, getGroupMembers, getMainCharacter, charKey,
    getStoredProfile, setStoredProfile, log,
} from './state.js';
import { listConnectionProfiles } from './gen.js';
import { runPipeline, runRefinementDryRun, getLastRunResults } from './pipeline.js';
import { rebuildProfile, updateProfile, resetProfile, serializeProfile } from './profiles.js';
import { chipsHtml } from './chips.js';

const TABS = ['profile', 'steps', 'schema', 'results', 'settings'];

// --------------------------------------------------------------------------------------------
// Helpers
// --------------------------------------------------------------------------------------------

export function escapeHtml(text) {
    const escapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
    return String(text ?? '').replace(/[&<>"']/g, ch => escapes[ch]);
}

export function coerceNumber(el, current) {
    const num = Number(el.value);
    if (!Number.isFinite(num)) return current;
    const min = el.min !== '' && Number.isFinite(Number(el.min)) ? Number(el.min) : -Infinity;
    const max = el.max !== '' && Number.isFinite(Number(el.max)) ? Number(el.max) : Infinity;
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
    context.eventSource.on((context.event_types ?? context.eventTypes).CHAT_CHANGED, () => {
        clearTimeout(bioSaveTimer);
        profileTabCharKey = null;
        refreshStatus();
        if (isPanelOpen() && activeTab === 'profile') renderProfileTab();
    });

    // Fired after programmatic profile writes (quick update from the avatar menu, panel buttons).
    document.addEventListener('smarttavern:profile-updated', () => {
        if (isPanelOpen() && activeTab === 'profile') renderProfileTab();
    });

    // Busy-state awareness: the activity HUD mirrors every tracked LLM run; mirror its
    // state onto the panel so generation actions visibly pause while a run is in flight.
    $(document).on('smarttavern:progress', (event) => {
        const active = Boolean(event.originalEvent?.detail?.active);
        $panel().toggleClass('is-busy', active);
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
            window.removeEventListener('pointerup', onUp);
            window.removeEventListener('pointercancel', onUp);
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
        <div id="smarttavern_busy_banner" title="A SmartTavern run is in flight — generation actions resume when it finishes">
            <i class="fa-solid fa-circle-notch fa-spin"></i>
            <span>SmartTavern is running — actions are paused</span>
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
                    <a id="smarttavern_profile_update" class="menu_button smarttavern_busy_guard" title="Low-drift update from the recent conversation"><i class="fa-solid fa-arrows-rotate"></i><span>Update now</span></a>
                    <a id="smarttavern_profile_rebuild" class="menu_button smarttavern_busy_guard" title="Full rewrite from the character card"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Rebuild</span></a>
                    <a id="smarttavern_profile_reset" class="menu_button smarttavern_busy_guard" title="Delete the stored profile"><i class="fa-solid fa-trash"></i><span>Reset</span></a>
                </div>
            </div>

            <div class="smarttavern_tab_panel" data-tab="steps">
                <div class="smarttavern_hint">
                    Two independent pipelines run together: <b>expansion</b> steps generate context
                    that is injected into the reply prompt before generation; <b>refinement</b> passes
                    audit and edit the fresh reply after it. Each enabled entry is an isolated LLM call.
                </div>

                <div class="smarttavern_steps_section_title"><i class="fa-solid fa-diagram-project"></i><span>Expansion steps — pre-reply context</span></div>
                <div class="smarttavern_hint">
                    Macros: {{char}}, {{user}}, {{card}}, {{definitions}}, {{field:Name}}, {{chat}},
                    {{chat:N}}, {{step:Name}} for earlier outputs, {{steps}} for all earlier outputs.
                    Independent steps run together; explicit references preserve order. Each step may pin
                    its own Connection Manager profile; the lookback sets this step's {{chat}} history
                    (0 = none, empty = global default). Per-block roles apply to history injection
                    positions; prompt-end mode uses the tail role in Settings. Click a card header to
                    collapse it.
                </div>
                <div id="smarttavern_steps"></div>
                <div class="smarttavern_row_actions">
                    <a id="smarttavern_add_step" class="menu_button"><i class="fa-solid fa-plus"></i><span>Add expansion step</span></a>
                    <a id="smarttavern_restore_expansion_steps" class="menu_button" title="Replace the expansion list with the default preset (Physical / Mental Condition) — refinement passes are untouched"><i class="fa-solid fa-rotate-left"></i><span>Expansion preset</span></a>
                </div>

                <hr>

                <div class="smarttavern_steps_section_title"><i class="fa-solid fa-user-pen"></i><span>Refinement passes — post-reply editing</span></div>
                <div class="smarttavern_hint">
                    Passes run strictly in order against the fresh reply: each receives the current draft
                    via {{draft}} (pass 1 starts from {{original_draft}}). Wrap the revised reply in
                    &lt;revised_reply&gt;...&lt;/revised_reply&gt; or answer &lt;audit&gt;PASS&lt;/audit&gt; to keep the draft.
                    Same macros as expansion steps, plus {{draft}} / {{original_draft}}. Each pass may pin
                    its own Connection Manager profile and lookback.
                </div>
                <div id="smarttavern_refinement_steps"></div>
                <div class="smarttavern_row_actions">
                    <a id="smarttavern_add_refinement_step" class="menu_button"><i class="fa-solid fa-plus"></i><span>Add refinement pass</span></a>
                    <a id="smarttavern_restore_refinement_steps" class="menu_button" title="Replace the refinement list with the default 3-pass preset (Body / Character / Prose) — expansion steps are untouched"><i class="fa-solid fa-rotate-left"></i><span>Refinement preset</span></a>
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
                    <a id="smarttavern_run_expansion" class="menu_button smarttavern_busy_guard" title="Dry run: execute the expansion steps without injecting anything and show raw outputs"><i class="fa-solid fa-diagram-project"></i><span>Run expansion (dry)</span></a>
                    <a id="smarttavern_run_refinement" class="menu_button smarttavern_busy_guard" title="Dry run: execute the refinement passes against the last character reply without saving anything"><i class="fa-solid fa-user-pen"></i><span>Run refinement (dry)</span></a>
                </div>
                <div id="smarttavern_results_body"></div>
            </div>

            <div class="smarttavern_tab_panel" data-tab="settings">
                <label class="checkbox" title="Refinement runs AFTER generation: each enabled pass audits and edits the fresh reply in order. Only refinement ever veils the reply.">
                    <input id="smarttavern_refinementEnabled" type="checkbox" ${settings.refinementEnabled !== false ? 'checked' : ''}>
                    <span>Enable refinement (post-reply editing)</span>
                </label>
                <label class="checkbox" title="Expansion runs BEFORE generation: enabled steps generate context that is injected into the reply prompt. It never edits the reply itself.">
                    <input id="smarttavern_expansionEnabled" type="checkbox" ${settings.expansionEnabled !== false ? 'checked' : ''}>
                    <span>Enable expansion (pre-reply context injection)</span>
                </label>
                <div class="smarttavern_refinement_only">
                    <label>Refinement display
                        <select id="smarttavern_refinementDisplay" title="Veiled blurs the fresh reply in chat until the final pass is ready; Off shows every pass as it lands">
                            <option value="veiled"${settings.refinementDisplay !== 'off' ? ' selected' : ''}>Veiled — hide the draft until refinement finishes</option>
                            <option value="off"${settings.refinementDisplay === 'off' ? ' selected' : ''}>Off — show each pass as it is written</option>
                        </select>
                    </label>
                    <div class="smarttavern_veil_only">
                        <label class="checkbox" title="While held, the veil partially unblurs so you can check the current draft">
                            <input id="smarttavern_veilAllowPeek" type="checkbox" ${settings.veilAllowPeek !== false ? 'checked' : ''}>
                            <span>Allow hold-to-peek at the draft while refining</span>
                        </label>
                    </div>
                    <label class="checkbox" title="Each pass that changes the reply is appended to the message swipes so you can browse the draft and every revision. Veiled runs keep only draft + final.">
                        <input id="smarttavern_savePassesAsSwipes" type="checkbox" ${settings.savePassesAsSwipes ? 'checked' : ''}>
                        <span>Save refinement passes as message swipes</span>
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
                <label class="checkbox" title="The stored living profile replaces the card's description text in the assembled prompt (Char Description entry, instruct story string, {{description}} macro in custom prompts). The card itself is never modified; without a stored profile the original description is used.">
                    <input id="smarttavern_replaceDescription" type="checkbox" ${settings.replaceDescription ? 'checked' : ''}>
                    <span>Replace the card description with the living profile</span>
                </label>
                <label class="checkbox" title="Hides the avatar menu, the wand-menu button and this panel; the settings drawer stays available">
                    <input id="smarttavern_disableFloatingUI" type="checkbox" ${settings.disableFloatingUI ? 'checked' : ''}>
                    <span>Disable floating UI</span>
                </label>

                <div class="smarttavern_grid">
                    <label title="How independent expansion steps are scheduled; refinement passes are always sequential">Step execution (expansion)
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
                    <label title="Extra attempts when an internal LLM call fails, comes back empty, or collapses into a repetition loop (reasoning corruption). Applies to pipeline steps and profile updates alike.">LLM retries per call
                        <input id="smarttavern_genRetries" class="text_margin_input" type="number" min="0" max="5" step="1" value="${settings.genRetries}">
                    </label>
                    <label title="Base wait before each retry; grows linearly with the attempt number">Retry delay (ms)
                        <input id="smarttavern_genRetryDelayMs" class="text_margin_input" type="number" min="0" max="30000" step="100" value="${settings.genRetryDelayMs}">
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
                    <span class="smarttavern_missing_profile" id="smarttavern_updater_missing_profile" title="The pinned connection profile no longer exists — requests fall back to the active connection"><i class="fa-solid fa-triangle-exclamation"></i><span>missing</span></span>
                </label>

                <hr>

                <div class="smarttavern_row_actions">
                    <a id="smarttavern_view_profiles" class="menu_button"><i class="fa-solid fa-eye"></i><span>View profiles</span></a>
                    <a id="smarttavern_update_all" class="menu_button smarttavern_busy_guard"><i class="fa-solid fa-arrows-rotate"></i><span>Update all</span></a>
                    <a id="smarttavern_reset_all" class="menu_button smarttavern_busy_guard"><i class="fa-solid fa-trash"></i><span>Reset all</span></a>
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
    ['smarttavern_refinementEnabled', 'refinementEnabled', 'checkbox'],
    ['smarttavern_expansionEnabled', 'expansionEnabled', 'checkbox'],
    ['smarttavern_autoUpdate', 'autoUpdate', 'checkbox'],
    ['smarttavern_bootstrapOnFirstMessage', 'bootstrapOnFirstMessage', 'checkbox'],
    ['smarttavern_replaceDescription', 'replaceDescription', 'checkbox'],
    ['smarttavern_savePassesAsSwipes', 'savePassesAsSwipes', 'checkbox'],
    ['smarttavern_veilAllowPeek', 'veilAllowPeek', 'checkbox'],
    ['smarttavern_updateInterval', 'updateInterval', 'number'],
    ['smarttavern_chatLookback', 'chatLookback', 'number'],
    ['smarttavern_profileUpdateLookback', 'profileUpdateLookback', 'number'],
    ['smarttavern_stepMaxTokens', 'stepMaxTokens', 'number'],
    ['smarttavern_updaterMaxTokens', 'updaterMaxTokens', 'number'],
    ['smarttavern_genRetries', 'genRetries', 'number'],
    ['smarttavern_genRetryDelayMs', 'genRetryDelayMs', 'number'],
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
            // Pipeline toggles re-scope the visible settings; the enable toggle exists in
            // both the drawer and this panel — keep them in sync.
            if (id === 'smarttavern_refinementEnabled' || id === 'smarttavern_expansionEnabled') applyModeVisibility();
            if (id === 'smarttavern_enabled') $('#smarttavern_drawer_enabled').prop('checked', el.checked);
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

    const displayEl = $panel().find('#smarttavern_refinementDisplay').get(0);
    displayEl?.addEventListener('change', () => {
        getSettings().refinementDisplay = displayEl.value === 'off' ? 'off' : 'veiled';
        saveSettings();
        applyModeVisibility();
    });
}

/** Shows only the settings relevant to the enabled pipelines. */
function applyModeVisibility() {
    const settings = getSettings();
    const refinement = settings.refinementEnabled !== false;
    const expansion = settings.expansionEnabled !== false;
    const veiled = refinement && settings.refinementDisplay !== 'off';
    $panel().find('.smarttavern_expansion_only').toggle(expansion);
    $panel().find('.smarttavern_refinement_only').toggle(refinement);
    $panel().find('.smarttavern_veil_only').toggle(veiled);
    $panel().find('#smarttavern_mode_hint').text(
        refinement && expansion
            ? 'Both pipelines run together: expansion injects generated context before the reply; refinement edits the fresh reply afterwards.'
            : refinement
                ? 'Refinement only: SillyTavern drafts the reply, then each enabled pass audits and refines it in order (see the Steps tab). No prompt injection happens before the reply.'
                : expansion
                    ? 'Expansion only: enabled steps run before generation and their outputs are injected into the reply prompt as context. The reply itself is never edited.'
                    : 'Both pipelines are disabled — SmartTavern only maintains the living profiles.');
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
    const changedFields = Object.keys(record?.lastDiff?.fields ?? {});

    $panel().find('#smarttavern_profile_meta').html(record
        ? `source: ${escapeHtml(record.source ?? 'unknown')} · last updated: message ${escapeHtml(record.updatedAt ?? '?')}`
            + (changedFields.length
                ? ` · <a id="smarttavern_profile_diff" class="menu_button" title="Show what the last background update changed">${changedFields.length} field change(s) — view</a>`
                : '')
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
    const record = getStoredProfile(key);
    bioSaveTimer = setTimeout(() => {
        if (record && getStoredProfile(key) === record) setStoredProfile(key, record);
    }, 500);
}

function wireProfileTab() {
    $panel().on('change', '#smarttavern_profile_char', function () {
        profileTabCharKey = String($(this).val() ?? '') || null;
        renderProfileTab();
    });

    // Hand edits write straight into the live store record; the debounced save persists it.
    // A manual edit invalidates the recorded background-update diff.
    $panel().on('input', '.smarttavern_bio_value', function () {
        const key = profileTabCharKey;
        const record = key ? getStoredProfile(key) : null;
        const name = String($(this).data('field') ?? '');
        if (!record || !name) return;
        record.fields[name] = String(this.value);
        record.source = 'manual';
        delete record.lastDiff;
        $panel().find('#smarttavern_profile_diff').remove();
        scheduleBioSave(key);
    });

    // Field-level before/after of the last background update.
    $panel().on('click', '#smarttavern_profile_diff', async () => {
        const record = profileTabCharKey ? getStoredProfile(profileTabCharKey) : null;
        const diff = record?.lastDiff?.fields;
        if (!diff || !Object.keys(diff).length) return;
        const container = document.createElement('div');
        for (const [name, change] of Object.entries(diff)) {
            appendSection(container, `${name} — before`, change.from ?? '(empty)');
            appendSection(container, `${name} — after`, change.to ?? '(empty)');
        }
        await showContentPopup(`Profile changes · ${currentProfileChar()?.name ?? profileTabCharKey}`, container);
    });

    $panel().find('#smarttavern_profile_update').on('click', async () => {
        const char = currentProfileChar();
        if (!char) return;
        try {
            const result = await updateProfile(char, { notify: true });
            if (!result) toastr.info('Update already in progress for this character.', 'SmartTavern');
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
    renderStepCards(
        $panel().find('#smarttavern_steps'),
        Array.isArray(settings.steps) ? settings.steps : [],
        { refinement: false },
    );
    renderStepCards(
        $panel().find('#smarttavern_refinement_steps'),
        Array.isArray(settings.refinementSteps) ? settings.refinementSteps : [],
        { refinement: true },
    );
    refreshProfileSelects();
}

/** Renders one pipeline's editable step cards into `container`. */
function renderStepCards($container, steps, { refinement = false } = {}) {
    const placeholder = refinement
        ? 'Prompt for this pass. Macros: {{char}}, {{user}}, {{card}}, {{definitions}}, {{chat}}, {{chat:N}}, {{field:Name}}, {{step:Name}}, {{draft}}, {{original_draft}}. Wrap the revised reply in <revised_reply></revised_reply> or answer <audit>PASS</audit> to keep the draft.'
        : 'Prompt for this step. Macros: {{char}}, {{user}}, {{card}}, {{definitions}}, {{chat}}, {{chat:N}}, {{field:Name}}, {{step:Name}}, {{steps}}.';
    $container.empty();
    steps.forEach((step, index) => {
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
                    ${refinement ? '' : `
                    <select class="smarttavern_step_role" title="Role for history injection; prompt-end mode uses the tail role from Settings">
                        <option value="user"${role === 'user' ? ' selected' : ''}>User</option>
                        <option value="system"${role === 'system' ? ' selected' : ''}>System</option>
                        <option value="assistant"${role === 'assistant' ? ' selected' : ''}>Assistant</option>
                    </select>`}
                    <input class="text_margin_input smarttavern_step_lookback" type="number" min="0" max="200" step="1"
                        value="${step.lookback ?? ''}" placeholder="Global"
                        title="Messages of chat history for {{chat}} in this step (0 = none, empty = global default)">
                    <select class="smarttavern_step_profile smarttavern_profile_select" title="Connection profile for this step"></select>
                    <span class="smarttavern_missing_profile smarttavern_step_profile_badge" title="The pinned connection profile no longer exists — this step falls back to the active connection"><i class="fa-solid fa-triangle-exclamation"></i><span>missing</span></span>
                    <div class="smarttavern_row_actions">
                        <a class="menu_button menu_button_icon smarttavern_step_up" title="Move up"><i class="fa-solid fa-arrow-up"></i></a>
                        <a class="menu_button menu_button_icon smarttavern_step_down" title="Move down"><i class="fa-solid fa-arrow-down"></i></a>
                        <a class="menu_button menu_button_icon smarttavern_step_duplicate" title="Duplicate step"><i class="fa-solid fa-copy"></i></a>
                        <a class="menu_button menu_button_icon smarttavern_step_delete" title="Delete step"><i class="fa-solid fa-trash"></i></a>
                    </div>
                </div>
                <textarea class="smarttavern_step_prompt" rows="6" placeholder="${escapeHtml(placeholder)}">${escapeHtml(step.prompt)}</textarea>
            </div>`);
        // Header click collapses the card; interactive controls are excluded.
        card.find('.smarttavern_step_header').on('click', (event) => {
            if ($(event.target).closest('input, select, label, a, .menu_button').length) return;
            card.toggleClass('collapsed');
        });
        card.find('.smarttavern_step_enabled').on('change', function () {
            steps[index].enabled = /** @type {HTMLInputElement} */ (this).checked;
            saveSettings();
        });
        card.find('.smarttavern_step_name').on('input', function () {
            steps[index].name = String(/** @type {HTMLInputElement} */ (this).value);
            saveSettings();
        });
        card.find('.smarttavern_step_prompt').on('input', function () {
            steps[index].prompt = String(/** @type {HTMLTextAreaElement} */ (this).value);
            saveSettings();
        });
        card.find('.smarttavern_step_profile').data('stStep', step);
        card.find('.smarttavern_step_profile').on('change', function () {
            steps[index].profileId = String(/** @type {HTMLSelectElement} */ (this).value ?? '');
            saveSettings();
        });
        card.find('.smarttavern_step_role').on('change', function () {
            steps[index].role = String(/** @type {HTMLSelectElement} */ (this).value);
            saveSettings();
        });
        card.find('.smarttavern_step_lookback').on('change', function () {
            const raw = String(/** @type {HTMLInputElement} */ (this).value ?? '').trim();
            steps[index].lookback = raw === '' ? null : coerceNumber(this, null);
            saveSettings();
        });
        card.find('.smarttavern_step_up').on('click', () => moveArrayItem(steps, index, -1, () => { saveSettings(); renderStepEditor(); }));
        card.find('.smarttavern_step_down').on('click', () => moveArrayItem(steps, index, +1, () => { saveSettings(); renderStepEditor(); }));
        card.find('.smarttavern_step_duplicate').on('click', () => {
            const copy = { ...steps[index], name: `${steps[index].name} copy` };
            steps.splice(index + 1, 0, copy);
            saveSettings();
            renderStepEditor();
        });
        card.find('.smarttavern_step_delete').on('click', () => {
            steps.splice(index, 1);
            saveSettings();
            renderStepEditor();
        });
        $container.append(card);
    });
}

function profileOptionsHtml(selectedId = '', profiles = listConnectionProfiles()) {
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

/**
 * Rebuilds the connection-profile options of every profile select. Rewriting a select's
 * options while its native dropdown is open makes Chromium re-create the popup (looks
 * like a second dropdown spawning) and can swallow the pending pick, so the DOM is
 * touched only when the option list or the selection actually changed.
 */
export function refreshProfileSelects() {
    const settings = getSettings();
    const profiles = listConnectionProfiles();
    const listSignature = profiles
        .map(p => `${p.id ?? ''}|${p.name ?? ''}|${p.mode ?? ''}`)
        .join(';');
    const isMissing = id => Boolean(id) && !profiles.some(p => p.id === id);
    const updateBadge = ($badge, id) => { if ($badge?.length) $badge.toggleClass('is-visible', isMissing(id)); };
    const refresh = (select, selectedId) => {
        const signature = `${listSignature}#${selectedId ?? ''}`;
        const $select = $(select);
        if ($select.data('stProfileOptions') === signature) return;
        $select.data('stProfileOptions', signature);
        $select.html(profileOptionsHtml(selectedId ?? '', profiles));
    };
    const updater = $panel().find('#smarttavern_profileUpdateProfileId').get(0);
    if (updater) refresh(updater, settings.profileUpdateProfileId ?? '');
    updateBadge($panel().find('#smarttavern_updater_missing_profile'), settings.profileUpdateProfileId ?? '');
    // Both step lists render through the same card builder; each select carries its own
    // step object so index-based lookups cannot cross wires between the two pipelines.
    $panel().find('.smarttavern_step_profile').each(function () {
        const step = $(this).data('stStep');
        refresh(this, step?.profileId ?? '');
        updateBadge($(this).closest('.smarttavern_step_card').find('.smarttavern_step_profile_badge'), step?.profileId ?? '');
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

/** Appends a new step to the given pipeline list ("steps" | "refinementSteps"). */
function addStep(listKey) {
    const settings = getSettings();
    const list = Array.isArray(settings[listKey]) ? settings[listKey] : (settings[listKey] = []);
    list.push({
        name: `${listKey === 'refinementSteps' ? 'Pass' : 'Step'} ${list.length + 1}`,
        enabled: true,
        role: 'assistant',
        profileId: '',
        lookback: null,
        prompt: '',
    });
    saveSettings();
    renderStepEditor();
}

async function restoreDefaultRefinementSteps() {
    const confirmed = await confirmPopup(
        'Load the default refinement passes?',
        'This replaces your refinement pass list with the 3-pass preset: Body & Spatial Awareness, Character & Psychological Authenticity, and Prose & Wording Polish. Expansion steps are not touched.',
    );
    if (!confirmed) return;
    getSettings().refinementSteps = structuredClone(DEFAULT_REFINEMENT_STEPS).map(s => ({ ...s }));
    saveSettings();
    renderStepEditor();
}

async function restoreDefaultExpansionSteps() {
    const confirmed = await confirmPopup(
        'Load the default expansion steps?',
        'This replaces your expansion step list with the Physical/Mental Condition preset. Refinement passes are not touched.',
    );
    if (!confirmed) return;
    getSettings().steps = structuredClone(DEFAULT_STEPS).map(s => ({ ...s }));
    saveSettings();
    renderStepEditor();
}

function wireDataButtons() {
    $panel().find('#smarttavern_add_field').on('click', addField);
    $panel().find('#smarttavern_restore_fields').on('click', restoreDefaultFields);
    $panel().find('#smarttavern_add_step').on('click', () => addStep('steps'));
    $panel().find('#smarttavern_add_refinement_step').on('click', () => addStep('refinementSteps'));
    $panel().find('#smarttavern_restore_refinement_steps').on('click', restoreDefaultRefinementSteps);
    $panel().find('#smarttavern_restore_expansion_steps').on('click', restoreDefaultExpansionSteps);
    $panel().find('#smarttavern_run_expansion').on('click', () => runDryPipeline('expansion'));
    $panel().find('#smarttavern_run_refinement').on('click', () => runDryPipeline('refinement'));
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
    const results = getLastRunResults();
    if (!results.expansion && !results.refinement) {
        const hint = document.createElement('div');
        hint.className = 'smarttavern_hint';
        hint.textContent = 'No pipeline run recorded yet. Use the dry-run buttons above — or just chat: every expansion context block and every refined reply is captured here automatically.';
        body.append(hint);
        return;
    }
    renderRunResult(body, results.expansion, 'expansion');
    renderRunResult(body, results.refinement, 'refinement');
}

/** Renders one pipeline's recorded run as a labeled section group. */
function renderRunResult(body, result, pipeline) {
    if (!result) return;
    const label = pipeline === 'refinement' ? 'Refinement run' : 'Expansion run';
    const when = new Date(result.at).toLocaleTimeString();
    appendSection(
        body,
        `${label} · ${result.source} · ${result.char?.name ?? '?'} · ${when}`,
        serializeProfile(result.profile, getSettings().fields) || '(no profile stored)',
    );
    if ((result.stepStats ?? []).length) {
        const chips = document.createElement('div');
        chips.className = 'smarttavern_results_chips';
        chips.innerHTML = chipsHtml(
            result.stepStats.map(stat => stat.name),
            result.stepStats.map(stat => (stat.cancelled || stat.skipped ? 'skipped' : stat.failed ? 'failed' : 'done')),
        );
        body.append(chips);
    }
    for (const stat of (result.stepStats ?? [])) {
        appendSection(body, stepStatsTitle(stat.name || 'Step', stat), stat.cancelled || stat.skipped
            ? '(skipped — refinement stopped)' : result.stepOutputs?.[stat.name] || '(no output — failed or empty, see browser console)');
    }
    if (result.injectionText) {
        appendSection(
            body,
            pipeline === 'refinement' ? 'Final refined reply' : 'Assembled reply context',
            result.injectionText,
        );
    }
}

/** Section title with the per-step timing/size suffix when stats were recorded. */
function stepStatsTitle(name, stat) {
    if (!stat) return name;
    const secs = (stat.elapsedMs / 1000).toFixed(1);
    return `${name} · ${secs}s · ${stat.chars} chars${stat.failed ? ' · failed' : ''}`;
}

/**
 * Dry-runs one pipeline ('expansion' | 'refinement') and surfaces the outputs
 * (Results tab, or a popup if the floating UI is off).
 */
async function runDryPipeline(pipeline) {
    const settings = getSettings();
    const result = pipeline === 'refinement'
        ? await runRefinementDryRun()
        : await runPipeline({ inject: false, bootstrap: false, type: 'normal' });
    if (!result) {
        toastr.warning(pipeline === 'refinement'
            ? 'Refinement is disabled, already running, or there is no character reply to refine.'
            : 'Expansion is disabled, or there is no character/chat to run against.', 'SmartTavern');
        return null;
    }
    if (settings.disableFloatingUI) {
        const container = document.createElement('div');
        appendSection(container, `Target: ${result.char?.name ?? '?'}`, serializeProfile(result.profile, getSettings().fields) || '(no profile stored)');
        for (const stat of (result.stepStats ?? [])) {
            appendSection(container, stepStatsTitle(stat.name || 'Step', stat), result.stepOutputs?.[stat.name] || '(no output — failed or empty, see browser console)');
        }
        // Expansion assembles an injection; refinement produces a final working draft.
        const finalText = String(/** @type {any} */ (result)[pipeline === 'refinement' ? 'workingDraft' : 'injectionText'] ?? '');
        if (finalText) {
            appendSection(container, pipeline === 'refinement' ? 'Final refined reply' : 'Assembled reply context', finalText);
        }
        await showContentPopup(`SmartTavern — ${pipeline} dry run`, container);
        return result;
    }
    openPanel('results');
    return result;
}

/** Runs every enabled pipeline as a dry run (slash command /smarttavern-run). */
export async function showRunResults() {
    const settings = getSettings();
    const jobs = [];
    if (settings.expansionEnabled !== false) jobs.push('expansion');
    if (settings.refinementEnabled !== false) jobs.push('refinement');
    if (!jobs.length) {
        toastr.warning('Both SmartTavern pipelines are disabled — nothing to run.', 'SmartTavern');
        return;
    }
    for (const job of jobs) await runDryPipeline(job);
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
