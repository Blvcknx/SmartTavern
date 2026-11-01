// SmartTavern — Thinking Agent panel tab: mode, connection profiles, per-tool toggles,
// budgets, the arm button, the last compiled brief + transcript, and the agent memory
// undo log. A thin view over agent.js / agent-tools.js; every control writes straight
// into settings (autosaved) or the agent module state.
//
// The tab is re-rendered on every open/switch (renderAgentTab) while the wiring is
// delegated ONCE on the panel root — the panel is built DETACHED from the DOM (see
// panel.js buildPanel), so a document-level query at wire time would bind nothing.
import { getSettings, saveSettings } from './state.js';
import { isAgentArmed, armAgent, isAgentBusy, getLastBrief, getLastTranscript } from './agent.js';
import {
    TOOL_REGISTRY, toolEnabled, memoryLog, undoMemoryLogEntry, listAgentOwnedEntries, getSceneState,
} from './agent-tools.js';
import { profileOptionsHtml } from './panel.js';

const htmlEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => htmlEscapes[ch]);
}

function coerceNumber(el, current) {
    const num = Number(el.value);
    if (!Number.isFinite(num)) return current;
    const min = el.min !== '' && Number.isFinite(Number(el.min)) ? Number(el.min) : -Infinity;
    const max = el.max !== '' && Number.isFinite(Number(el.max)) ? Number(el.max) : Infinity;
    return Math.min(max, Math.max(min, Math.round(num)));
}

const TOOL_LABELS = {
    roll_dice: 'Dice (roll_dice) — binding rolls when outcomes are uncertain',
    consult_character: 'Character consult (consult_character) — inner voice: feel / react / backstory',
    consult_expert: 'Expert consult (consult_expert) — a custom question to a second LLM',
    scene: 'Scene state (update_scene) — established positions, injuries, inventory and time',
    ask_user: 'Ask the user (ask_user) — one popup when a decision is truly theirs',
    introduce_npc: 'Introduce NPC (introduce_npc) — invent + persist a recurring side character',
    memory: 'Memory (search / create / update / delete) — durable facts in the chat lorebook',
};

let wired = false;

function $agentRoot() {
    return $('#smarttavern_panel #smarttavern_agent_root');
}

// --------------------------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------------------------

export function renderAgentTab() {
    const $root = $agentRoot();
    if (!$root.length) return;
    const settings = getSettings();
    const brief = getLastBrief();
    const transcript = getLastTranscript();

    const transcriptHtml = (Array.isArray(transcript) && transcript.length)
        ? transcript.map(entry => `
            <div class="smarttavern_agent_step smarttavern_agent_${escapeHtml(entry.tone ?? 'ok')}">
                <div class="smarttavern_agent_step_title">${escapeHtml(entry.title ?? '')}</div>
                ${entry.text ? `<pre class="smarttavern_agent_step_text">${escapeHtml(entry.text)}</pre>` : ''}
            </div>`).join('')
        : '<div class="smarttavern_hint">No thinking run recorded yet this chat. Send a message and the loop appears here iteration by iteration.</div>';

    const log = memoryLog();
    const logHtml = log.length
        ? log.map((record, index) => `
            <div class="smarttavern_agent_memory_row">
                <span class="smarttavern_agent_memory_action smarttavern_agent_action_${escapeHtml(record.action)}">${escapeHtml(record.action)}</span>
                <span class="smarttavern_agent_memory_title" title="${escapeHtml(`${record.book} #${record.uid}`)}">${escapeHtml(record.title ?? '')}</span>
                <a class="menu_button menu_button_icon smarttavern_agent_memory_undo" data-index="${index}" title="Undo this memory change"><i class="fa-solid fa-rotate-left"></i></a>
            </div>`).reverse().join('')
        : '<div class="smarttavern_hint">No agent memory changes in this chat yet.</div>';

    $root.html(`
        <div class="smarttavern_hint">
            Before every reply a thinking agent plans the turn: cheap LLM iterations with local
            tools (dice, consultations, scene state, ask-user, NPC intro, chat-lorebook memory), finished
            by a short <b>Turn Brief</b> injected into the reply prompt. The reply model never
            sees the agent's reasoning — only the brief.
        </div>

        <div class="smarttavern_story_status" id="smarttavern_agent_status">${escapeHtml(agentStatusLine(settings))}</div>

        <div class="smarttavern_row_actions">
            <a id="smarttavern_agent_arm" class="menu_button smarttavern_busy_guard" title="Run the thinking agent once on the next reply, then disarm"><i class="fa-solid fa-bolt"></i><span>Think next reply</span></a>
        </div>

        <label>Mode
            <select id="smarttavern_agentMode" title="Always = every reply; Armed = only after 'Think next reply'; Off = never">
                <option value="always"${settings.agentMode !== 'off' && settings.agentMode !== 'armed' ? ' selected' : ''}>Always — think before every reply</option>
                <option value="armed"${settings.agentMode === 'armed' ? ' selected' : ''}>Armed — only when triggered</option>
                <option value="off"${settings.agentMode === 'off' ? ' selected' : ''}>Off</option>
            </select>
        </label>

        <label title="Connection Manager profile for the agent loop; empty uses the active connection">Agent connection profile
            <select id="smarttavern_agentProfileId" class="smarttavern_profile_select">${profileOptionsHtml(settings.agentProfileId ?? '')}</select>
            <span class="smarttavern_missing_profile" id="smarttavern_agent_missing_profile" title="The pinned connection profile no longer exists — requests fall back to the active connection"><i class="fa-solid fa-triangle-exclamation"></i><span>missing</span></span>
        </label>

        <label title="Connection profile for consult_character (the inner voice); empty uses the agent profile">Inner-voice connection profile
            <select id="smarttavern_innerVoiceProfileId" class="smarttavern_profile_select">${profileOptionsHtml(settings.innerVoiceProfileId ?? '')}</select>
            <span class="smarttavern_missing_profile" id="smarttavern_voice_missing_profile" title="The pinned connection profile no longer exists — requests fall back to the active connection"><i class="fa-solid fa-triangle-exclamation"></i><span>missing</span></span>
        </label>

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-toolbox"></i><span>Tools</span></div>
        <label title="Connection profile for consult_expert; empty uses the agent profile">Expert connection profile
            <select id="smarttavern_expertProfileId" class="smarttavern_profile_select">${profileOptionsHtml(settings.expertProfileId ?? '')}</select>
        </label>
        ${Object.entries(TOOL_LABELS).map(([key, label]) => `
        <label class="checkbox" title="${escapeHtml(label)}">
            <input class="smarttavern_agent_tool" data-tool="${escapeHtml(key)}" type="checkbox" ${settings.agentToolsEnabled?.[key] !== false ? 'checked' : ''}>
            <span>${escapeHtml(label)}</span>
        </label>`).join('')}
        <label>Memory writes
            <select id="smarttavern_agentMemoryMode" title="Auto writes directly; Confirm asks per write; Off disables all memory tools">
                <option value="auto"${settings.agentMemoryMode !== 'confirm' && settings.agentMemoryMode !== 'off' ? ' selected' : ''}>Auto — the agent writes directly</option>
                <option value="confirm"${settings.agentMemoryMode === 'confirm' ? ' selected' : ''}>Confirm each write</option>
                <option value="off"${settings.agentMemoryMode === 'off' ? ' selected' : ''}>Off — memory tools disabled</option>
            </select>
        </label>

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-gauge-high"></i><span>Budgets</span></div>
        <div class="smarttavern_grid">
            <label title="LLM iterations of the loop; the last one always disables tools">Max iterations
                <input id="smarttavern_agentMaxIterations" class="text_margin_input" type="number" min="1" max="8" step="1" value="${settings.agentMaxIterations}">
            </label>
            <label title="Total tool calls allowed per turn">Max tool calls
                <input id="smarttavern_agentMaxToolCalls" class="text_margin_input" type="number" min="1" max="24" step="1" value="${settings.agentMaxToolCalls}">
            </label>
            <label title="0 disables the deadline. A positive budget pauses while an ask-user popup is open.">Timeout (ms; 0 = unlimited)
                <input id="smarttavern_agentTimeoutMs" class="text_margin_input" type="number" min="0" max="600000" step="5000" value="${settings.agentTimeoutMs}">
            </label>
            <label title="Chat messages the agent sees as context">Chat lookback
                <input id="smarttavern_agentLookback" class="text_margin_input" type="number" min="0" max="100" step="1" value="${settings.agentLookback}">
            </label>
            <label title="Hard word cap of the compiled brief (guidance trims first)">Brief word cap
                <input id="smarttavern_agentBriefMaxWords" class="text_margin_input" type="number" min="40" max="400" step="10" value="${settings.agentBriefMaxWords}">
            </label>
            <label title="ask_user calls per turn (0 disables)">Asks per turn
                <input id="smarttavern_agentAskPerTurn" class="text_margin_input" type="number" min="0" max="3" step="1" value="${settings.agentAskPerTurn}">
            </label>
            <label title="Shared by memory create/update/delete and NPC persistence">Memory writes per turn
                <input id="smarttavern_agentMemoryWritesPerTurn" class="text_margin_input" type="number" min="0" max="10" step="1" value="${settings.agentMemoryWritesPerTurn}">
            </label>
        </div>

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-file-lines"></i><span>Last Turn Brief</span></div>
        <pre id="smarttavern_agent_brief" class="smarttavern_story_directive">${escapeHtml(brief || '(no brief compiled yet — send a message)')}</pre>
        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-map-pin"></i><span>Scene state</span></div>
        <pre class="smarttavern_story_directive">${escapeHtml(JSON.stringify(getSceneState(), null, 2))}</pre>

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-list"></i><span>Last thinking transcript</span></div>
        <div id="smarttavern_agent_transcript">${transcriptHtml}</div>

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-clock-rotate-left"></i><span>Agent memory changes (undo)</span></div>
        <div id="smarttavern_agent_memory_log">${logHtml}</div>
        <div class="smarttavern_row_actions">
            <a id="smarttavern_agent_memory_list" class="menu_button" title="List every agent-owned entry in this chat's lorebooks"><i class="fa-solid fa-eye"></i><span>Agent memory</span></a>
        </div>
    `);
}

function agentStatusLine(settings) {
    const parts = [`mode: ${settings.agentMode}`];
    if (settings.agentMode === 'armed') parts.push(isAgentArmed() ? 'armed — the next reply will think' : 'idle — arm below or /smarttavern-think');
    if (isAgentBusy()) parts.push('thinking right now…');
    const tools = TOOL_REGISTRY.filter(tool => toolEnabled(tool.name, settings)).length;
    parts.push(`${tools}/${TOOL_REGISTRY.length} tools on`);
    return parts.join(' · ');
}

// --------------------------------------------------------------------------------------------
// Wiring (delegated once on the panel root)
// --------------------------------------------------------------------------------------------

export function wireAgentTab($rootPanel) {
    if (wired) return;
    const $panel = $rootPanel ?? $('#smarttavern_panel');
    if (!$panel?.length) {
        console.warn('[SmartTavern] agent tab wiring skipped — panel root not found');
        return;
    }
    wired = true;

    $panel.on('change', '#smarttavern_agentMode', function () {
        getSettings().agentMode = ['always', 'armed', 'off'].includes(this.value) ? this.value : 'always';
        saveSettings();
        renderAgentTab();
    });

    $panel.on('change', '#smarttavern_agentMemoryMode', function () {
        getSettings().agentMemoryMode = ['auto', 'confirm', 'off'].includes(this.value) ? this.value : 'auto';
        saveSettings();
    });

    $panel.on('change', '#smarttavern_agentProfileId', function () {
        getSettings().agentProfileId = String(this.value ?? '');
        saveSettings();
    });

    $panel.on('change', '#smarttavern_innerVoiceProfileId', function () {
        getSettings().innerVoiceProfileId = String(this.value ?? '');
        saveSettings();
    });

    $panel.on('change', '#smarttavern_expertProfileId', function () {
        getSettings().expertProfileId = String(this.value ?? '');
        saveSettings();
    });

    $panel.on('change', '.smarttavern_agent_tool', function () {
        const settings = getSettings();
        const tool = String($(this).data('tool') ?? '');
        settings.agentToolsEnabled[tool] = this.checked;
        saveSettings();
        refreshAgentStatus();
    });

    const NUMBER_FIELDS = {
        smarttavern_agentMaxIterations: 'agentMaxIterations',
        smarttavern_agentMaxToolCalls: 'agentMaxToolCalls',
        smarttavern_agentTimeoutMs: 'agentTimeoutMs',
        smarttavern_agentLookback: 'agentLookback',
        smarttavern_agentBriefMaxWords: 'agentBriefMaxWords',
        smarttavern_agentAskPerTurn: 'agentAskPerTurn',
        smarttavern_agentMemoryWritesPerTurn: 'agentMemoryWritesPerTurn',
    };
    for (const [id, key] of Object.entries(NUMBER_FIELDS)) {
        $panel.on('input', `#${id}`, function () {
            getSettings()[key] = coerceNumber(this, Number(getSettings()[key]));
            saveSettings();
        });
    }

    $panel.on('click', '#smarttavern_agent_arm', () => {
        armAgent();
        toastr.info('SmartTavern will think before the next reply.', 'SmartTavern');
        refreshAgentStatus();
    });

    $panel.on('click', '.smarttavern_agent_memory_undo', async function () {
        const index = Number($(this).data('index') ?? -1);
        if (!Number.isInteger(index) || index < 0) return;
        const undone = await undoMemoryLogEntry(index);
        if (undone) toastr.success('SmartTavern: memory change undone.', 'SmartTavern');
        else toastr.warning('SmartTavern: the entry changed since — undo skipped.', 'SmartTavern');
        renderAgentTab();
    });

    $panel.on('click', '#smarttavern_agent_memory_list', async () => {
        const entries = await listAgentOwnedEntries();
        const container = document.createElement('div');
        if (!entries.length) {
            const empty = document.createElement('p');
            empty.textContent = 'No agent-owned lorebook entries in this chat yet.';
            container.append(empty);
        }
        for (const entry of entries) {
            const section = document.createElement('div');
            const title = document.createElement('b');
            title.textContent = `${entry.title} — ${entry.book} #${entry.uid} (keys: ${entry.keys.join(', ') || 'none'})`;
            const pre = document.createElement('pre');
            pre.className = 'smarttavern_popup_pre';
            pre.textContent = entry.content;
            section.append(title, pre);
            container.append(section);
        }
        const { showContentPopup } = await import('./panel.js');
        await showContentPopup('SmartTavern — agent memory (this chat)', container);
    });
}

function refreshAgentStatus() {
    const $status = $agentRoot().find('#smarttavern_agent_status');
    if ($status.length) $status.text(agentStatusLine(getSettings()));
}

/** Re-render hook for external callers (chat change, busy-state transitions). */
export function renderAgentTabSafe() {
    try {
        renderAgentTab();
    } catch (error) {
        console.error('[SmartTavern] agent tab render failed', error);
    }
}
