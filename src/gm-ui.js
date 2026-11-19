// SmartTavern — GM panel section (rendered inside the Agent tab when the engine is "GM"):
// tick mode and budgets, the prepared brief, progress clocks, NPC agendas, the queued
// question, the last tick transcript and the Think now / Discard buttons. Also hosts the
// /smarttavern-gm popup and the /smarttavern-think arming message.
//
// A thin view over gm.js: every edit funnels through the same store mutators the tick uses
// (clock math lives in gm-core.js), so the panel and the GM always agree.
import { getContext } from '../../../../extensions.js';
import { getSettings, saveSettings } from './state.js';
import { armAgent, isAgentArmed } from './agent.js';
import {
    getGmStore, getGmStatus, runGmTickNow, discardPrepared, addClockManual, advanceClockManual,
    removeClockManual, setAgendaManual, removeAgendaManual, clearPendingQuestion, gmStateText, isGmBusy,
} from './gm.js';
import { formatClock, renderPrepared, CLOCK_MIN_SEGMENTS, CLOCK_MAX_SEGMENTS } from './gm-core.js';
import { profileOptionsHtml } from './panel.js';
import { nativeToolStatus } from './gen.js';
import { getMcpSnapshot, refreshMcp } from './mcp.js';
import { toolKey } from './mcp-core.js';

const htmlEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => htmlEscapes[ch]);
}

function clampNumber(el, current) {
    const num = Number(el.value);
    if (!Number.isFinite(num)) return current;
    const min = el.min !== '' && Number.isFinite(Number(el.min)) ? Number(el.min) : -Infinity;
    const max = el.max !== '' && Number.isFinite(Number(el.max)) ? Number(el.max) : Infinity;
    return Math.min(max, Math.max(min, Math.round(num)));
}

/** The two tools that exist only for the GM engine (labels for the shared tool switches). */
export const GM_TOOL_LABELS = {
    clock: 'Clocks (clock) — progress clocks; a clock that fills makes its consequence a required event',
    npc_intent: 'NPC agendas (npc_intent) — private off-screen motives the GM keeps per chat',
};

let wired = false;

function $gmRoot() {
    return $('#smarttavern_panel #smarttavern_agent_root');
}

// --------------------------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------------------------

function modeText(settings) {
    if (settings.gmTickMode === 'armed') return isAgentArmed() ? 'armed — the next reply will make the GM think' : 'Armed mode — idle until you press "Think next turn"';
    if (settings.gmTickMode === 'everyN') return `every ${settings.gmEveryN}th reply`;
    return 'after every reply';
}

export function gmStatusLine(settings = getSettings()) {
    const status = getGmStatus();
    const parts = ['engine: GM', `ticks: ${modeText(settings)}`];
    if (status.running) parts.push('thinking right now…');
    if (status.last) parts.push(`last tick ${formatClock(status.last.at)} — ${status.last.ok ? '' : 'problem: '}${status.last.text}`);
    if (status.preparedAt) parts.push(`brief prepared ${formatClock(status.preparedAt)}`);
    if (status.fallback) parts.push(`last send used the planner: ${status.fallback.reason}`);
    return parts.join(' · ');
}

/** One line on how the GM's tool transport resolves for the selected connection. */
export function transportStatusLine(settings = getSettings()) {
    const mode = settings.gmToolTransport;
    if (mode !== 'native' && mode !== 'auto') return 'Tags: the GM writes <tool> tags in plain text (works with every connection).';
    const status = nativeToolStatus(settings.gmProfileId || settings.agentProfileId || '');
    if (status.supported) return `Native function calling will be used (source: ${status.source}). Any provider error on the first request reruns the tick on tags.`;
    return `Native function calling is not available here (${status.reason}) — the GM uses tags${mode === 'native' ? ' and says so once per tick' : ''}.`;
}

/** Status line of the MCP bridge (the server plugin). */
export function mcpStatusLine(snapshot = getMcpSnapshot()) {
    switch (snapshot.state) {
        case 'loading': return 'Checking the MCP bridge…';
        case 'absent': return 'The smarttavern-mcp server plugin was not found. Install it as described under "MCP bridge" in the SmartTavern README.';
        case 'error': return `The MCP bridge answered with a problem: ${snapshot.message}`;
        case 'ok': {
            const servers = snapshot.status?.servers ?? [];
            return `MCP bridge found · ${servers.length} server(s) configured · ${snapshot.tools.length} tool(s) available`;
        }
        default: return 'Not checked yet — press Refresh.';
    }
}

function mcpSectionHtml(settings) {
    const snapshot = getMcpSnapshot();
    const disabled = new Set(Array.isArray(settings.mcpDisabledTools) ? settings.mcpDisabledTools : []);
    const servers = snapshot.status?.servers ?? [];
    const errorOf = name => snapshot.errors.find(item => item.server === name)?.error ?? servers.find(server => server.name === name)?.error ?? '';
    const serverRows = servers.map(server => `
        <div class="smarttavern_ruling_meta smarttavern_mcp_server">
            <span class="smarttavern_scene_key" title="${escapeHtml(server.transport)}">${escapeHtml(server.name)}</span>
            <span class="smarttavern_ruling_uses">${server.connected ? 'connected' : (errorOf(server.name) ? 'error' : 'idle')}</span>
            ${server.write ? '<span class="smarttavern_ruling_status" title="Tools of this server may change things: blocked in dry runs">write</span>' : ''}
            ${errorOf(server.name) ? `<span class="smarttavern_ruling_question" title="${escapeHtml(errorOf(server.name))}">${escapeHtml(errorOf(server.name))}</span>` : ''}
        </div>`).join('');
    const configErrors = (snapshot.status?.configErrors ?? []).map(text => `<div class="smarttavern_hint">config: ${escapeHtml(text)}</div>`).join('');
    const toolRows = snapshot.tools.map(tool => {
        const key = toolKey(tool.server, tool.name);
        return `
        <label class="checkbox" title="${escapeHtml(tool.description ?? '')}">
            <input class="smarttavern_mcp_tool" data-key="${escapeHtml(key)}" type="checkbox"${disabled.has(key) ? '' : ' checked'}>
            <span>${escapeHtml(tool.server)} · ${escapeHtml(tool.name)}${tool.write ? ' (write)' : ''}</span>
        </label>`;
    }).join('');
    return `
        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-plug"></i><span>Tools: transport and MCP</span></div>
        <label title="Tags = the GM writes tool tags in text (default, works everywhere). Native = real function calling through a Chat Completion Connection Manager profile. Auto = native when the GM profile's source supports it, else tags.">Tool transport
            <select id="smarttavern_gmToolTransport">
                <option value="tags"${settings.gmToolTransport === 'tags' ? ' selected' : ''}>Tags (default)</option>
                <option value="auto"${settings.gmToolTransport === 'auto' ? ' selected' : ''}>Auto — native when supported</option>
                <option value="native"${settings.gmToolTransport === 'native' ? ' selected' : ''}>Native function calling</option>
            </select>
        </label>
        <div class="smarttavern_hint" id="smarttavern_gm_transport_status">${escapeHtml(transportStatusLine(settings))}</div>
        <label class="checkbox" title="Lets the GM call tools of the MCP servers configured in the smarttavern-mcp server plugin. MCP servers run with your user's permissions — only configure servers you trust.">
            <input id="smarttavern_mcpEnabled" type="checkbox"${settings.mcpEnabled ? ' checked' : ''}>
            <span>MCP tools (GM only)</span>
        </label>
        <div class="smarttavern_story_status" id="smarttavern_mcp_status">${escapeHtml(mcpStatusLine(snapshot))}</div>
        <div class="smarttavern_grid">
            <label title="Shared budget of MCP calls per GM tick (0 switches MCP tools off)">MCP calls per tick
                <input id="smarttavern_mcpCallsPerTurn" class="text_margin_input" type="number" min="0" max="10" step="1" value="${settings.mcpCallsPerTurn}">
            </label>
        </div>
        <div class="smarttavern_row_actions">
            <a id="smarttavern_mcp_refresh" class="menu_button" title="Check the plugin again and reload the tool list"><i class="fa-solid fa-rotate"></i><span>Refresh</span></a>
            <a id="smarttavern_mcp_reload" class="menu_button" title="Re-read mcp-servers.json and reconnect every server"><i class="fa-solid fa-plug-circle-bolt"></i><span>Reload config</span></a>
        </div>
        ${serverRows}${configErrors}
        ${toolRows ? `<div class="smarttavern_hint">Tick the tools the GM may use. MCP output reaches the model as data, never as instructions.</div>${toolRows}` : ''}`;
}

function clockRowHtml(clock) {
    const percent = Math.round((clock.filled / clock.segments) * 100);
    return `
    <div class="smarttavern_ruling_row smarttavern_gm_clock" data-id="${clock.id}">
        <div class="smarttavern_ruling_meta">
            <span class="smarttavern_scene_key" title="${escapeHtml(clock.name)}">${escapeHtml(clock.name)}</span>
            <span class="smarttavern_ruling_uses" title="Segments filled">${clock.filled}/${clock.segments}</span>
            ${clock.status === 'filled' ? '<span class="smarttavern_ruling_status smarttavern_ruling_status_active" title="Its consequence is a required event of the prepared brief">full</span>' : ''}
            <span class="smarttavern_ruling_spacer"></span>
            <a class="menu_button menu_button_icon smarttavern_gm_clock_advance${clock.status === 'filled' ? ' disabled' : ''}" data-id="${clock.id}" title="Advance by 1 (a full clock adds its consequence to the prepared brief)"><i class="fa-solid fa-plus"></i></a>
            <a class="menu_button menu_button_icon smarttavern_gm_clock_resolve" data-id="${clock.id}" title="Resolve — remove the clock, its story is over"><i class="fa-solid fa-check"></i></a>
            <a class="menu_button menu_button_icon smarttavern_gm_clock_delete" data-id="${clock.id}" title="Delete this clock"><i class="fa-solid fa-trash"></i></a>
        </div>
        <div class="smarttavern_gm_bar" aria-hidden="true"><span style="width:${percent}%"></span></div>
        ${clock.consequence ? `<div class="smarttavern_ruling_question" title="${escapeHtml(clock.consequence)}">When full: ${escapeHtml(clock.consequence)}</div>` : ''}
    </div>`;
}

function agendaRowHtml(name, agenda) {
    return `
    <div class="smarttavern_ruling_row smarttavern_gm_agenda">
        <div class="smarttavern_ruling_meta">
            <span class="smarttavern_scene_key" title="${escapeHtml(name)}">${escapeHtml(name)}</span>
            <span class="smarttavern_ruling_spacer"></span>
            <a class="menu_button menu_button_icon smarttavern_gm_agenda_delete" data-name="${escapeHtml(name)}" title="Forget this agenda"><i class="fa-solid fa-trash"></i></a>
        </div>
        <textarea class="smarttavern_gm_agenda_text smarttavern_ruling_text text_pole" rows="2" data-name="${escapeHtml(name)}" title="Edit the private intent (at most 40 words) — saved when you leave the field">${escapeHtml(agenda.intent)}</textarea>
    </div>`;
}

/** The GM section of the Agent tab (the engine select and the shared tool/budget block sit around it). */
export function gmTabHtml(settings = getSettings()) {
    const store = getGmStore({ create: false });
    const prepared = store.prepared;
    const clocks = store.clocks.length
        ? store.clocks.map(clockRowHtml).join('')
        : '<div class="smarttavern_hint">No clocks yet. The GM creates them with its clock tool; you can add your own below.</div>';
    const agendas = Object.entries(store.agendas);
    const agendaRows = agendas.length
        ? agendas.map(([name, agenda]) => agendaRowHtml(name, agenda)).join('')
        : '<div class="smarttavern_hint">No NPC agendas yet. The GM records what important NPCs secretly want with npc_intent.</div>';
    const transcript = store.transcript.length
        ? store.transcript.map(entry => `
            <div class="smarttavern_agent_step smarttavern_agent_${escapeHtml(entry.tone ?? 'ok')}">
                <div class="smarttavern_agent_step_title">${escapeHtml(entry.title ?? '')}</div>
                ${entry.text ? `<pre class="smarttavern_agent_step_text">${escapeHtml(entry.text)}</pre>` : ''}
            </div>`).join('')
        : '<div class="smarttavern_hint">No tick recorded yet in this chat.</div>';
    const missing = id => `<span class="smarttavern_missing_profile" id="${id}" title="The pinned connection profile no longer exists — requests fall back to the active connection"><i class="fa-solid fa-triangle-exclamation"></i><span>missing</span></span>`;
    return `
        <div class="smarttavern_hint">
            The GM thinks <b>between turns</b>: after each character reply a background loop (cheap LLM
            iterations with the same local tools as the legacy agent, plus clocks and NPC agendas) prepares a
            brief, required events and conditional branches for the NEXT reply. When you send, the prepared
            brief is just read — a tiny check picks the branches your message triggered. If nothing valid is
            ready, the expansion planner takes over, so a turn never depends on the GM. The GM may see
            secrets (story bible, clocks, agendas); the reply model sees only the compiled brief.
        </div>
        <div class="smarttavern_story_status" id="smarttavern_gm_status">${escapeHtml(gmStatusLine(settings))}</div>
        <div class="smarttavern_row_actions">
            <a id="smarttavern_gm_think_now" class="menu_button smarttavern_busy_guard" title="Run a GM tick on the last character reply now"><i class="fa-solid fa-brain"></i><span>${isGmBusy() ? 'Thinking…' : 'Think now'}</span></a>
            <a id="smarttavern_gm_arm" class="menu_button smarttavern_busy_guard" title="Armed tick mode: make the GM think after the next reply, then disarm"><i class="fa-solid fa-bolt"></i><span>Think next turn</span></a>
            <a id="smarttavern_gm_discard" class="menu_button smarttavern_busy_guard" title="Forget the prepared brief; the next turn uses the planner"><i class="fa-solid fa-ban"></i><span>Discard prepared brief</span></a>
            <a id="smarttavern_introduce_scene" class="menu_button smarttavern_busy_guard">Introduce scene…</a>
        </div>

        <label title="Every = after each reply; Every Nth = after each Nth reply of this chat; Armed = only after 'Think next turn' or /smarttavern-think">Tick mode
            <select id="smarttavern_gmTickMode">
                <option value="every"${settings.gmTickMode === 'every' ? ' selected' : ''}>Every reply</option>
                <option value="everyN"${settings.gmTickMode === 'everyN' ? ' selected' : ''}>Every Nth reply</option>
                <option value="armed"${settings.gmTickMode === 'armed' ? ' selected' : ''}>Armed — only when triggered</option>
            </select>
        </label>
        <div class="smarttavern_grid">
            <label title="Every Nth mode: tick on every Nth character reply of this chat">N (replies)
                <input id="smarttavern_gmEveryN" class="text_margin_input" type="number" min="2" max="20" step="1" value="${settings.gmEveryN}">
            </label>
            <label title="At send time, wait up to this long for a tick that is still running; then use the planner (0 = never wait)">Wait for the GM (ms)
                <input id="smarttavern_gmWaitMs" class="text_margin_input" type="number" min="0" max="60000" step="1000" value="${settings.gmWaitMs}">
            </label>
        </div>
        <label>GM task (editable prompt section)
            <textarea id="smarttavern_gmTask" class="text_pole" rows="4" placeholder="What should the GM prepare between turns?">${escapeHtml(settings.gmTask ?? '')}</textarea>
            <small>Saved for future ticks. The GM keeps its tool protocol and output tags.</small>
        </label>
        <label title="Connection profile for GM ticks; empty uses the agent profile">GM connection profile
            <select id="smarttavern_gmProfileId" class="smarttavern_profile_select">${profileOptionsHtml(settings.gmProfileId ?? '')}</select>
            ${missing('smarttavern_gm_missing_profile')}
        </label>
        <label title="Connection profile for the small send-time branch check; empty uses the GM profile">Fit-check connection profile
            <select id="smarttavern_gmFitProfileId" class="smarttavern_profile_select">${profileOptionsHtml(settings.gmFitProfileId ?? '')}</select>
            ${missing('smarttavern_gmfit_missing_profile')}
        </label>
        <label title="When no valid prepared brief exists at send time (tick off-cycle, failed, timed out or stale) the expansion planner runs as for the planner engine">Planner fallback
            <select id="smarttavern_agentMode">
                <option value="always"${settings.agentMode !== 'off' && settings.agentMode !== 'armed' ? ' selected' : ''}>Always — plan before expansion</option>
                <option value="armed"${settings.agentMode === 'armed' ? ' selected' : ''}>Armed — only when triggered</option>
                <option value="off"${settings.agentMode === 'off' ? ' selected' : ''}>Off — no planner fallback</option>
            </select>
        </label>
        <label title="Fallback profile for the GM, the planner, tools and the planner fallback; empty uses the active connection">Agent connection profile
            <select id="smarttavern_agentProfileId" class="smarttavern_profile_select">${profileOptionsHtml(settings.agentProfileId ?? '')}</select>
            <span class="smarttavern_missing_profile" id="smarttavern_agent_missing_profile" title="The pinned connection profile no longer exists — requests fall back to the active connection"><i class="fa-solid fa-triangle-exclamation"></i><span>missing</span></span>
        </label>
        <label title="Connection profile for consult_character (the inner voice); empty uses the agent profile">Inner-voice connection profile
            <select id="smarttavern_innerVoiceProfileId" class="smarttavern_profile_select">${profileOptionsHtml(settings.innerVoiceProfileId ?? '')}</select>
            <span class="smarttavern_missing_profile" id="smarttavern_voice_missing_profile" title="The pinned connection profile no longer exists — requests fall back to the active connection"><i class="fa-solid fa-triangle-exclamation"></i><span>missing</span></span>
        </label>

        ${mcpSectionHtml(settings)}

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-file-lines"></i><span>Prepared brief</span></div>
        <pre id="smarttavern_gm_prepared" class="smarttavern_story_directive">${escapeHtml(prepared
        ? `After message #${prepared.anchorIndex} · prepared ${formatClock(prepared.createdAt)}${prepared.model ? ` · ${prepared.model}` : ''}\n\n${renderPrepared(prepared)}`
        : '(nothing prepared yet — the GM prepares a brief after a character reply)')}</pre>

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-hourglass-half"></i><span>Clocks</span></div>
        <div id="smarttavern_gm_clocks">${clocks}</div>
        <div class="smarttavern_row_actions">
            <input id="smarttavern_gm_clock_name" type="text" class="text_pole" placeholder="Guards close in" maxlength="60">
            <input id="smarttavern_gm_clock_segments" type="number" class="text_pole" min="${CLOCK_MIN_SEGMENTS}" max="${CLOCK_MAX_SEGMENTS}" step="1" value="6" title="Segments (${CLOCK_MIN_SEGMENTS}-${CLOCK_MAX_SEGMENTS})">
            <input id="smarttavern_gm_clock_consequence" type="text" class="text_pole" placeholder="What happens when it fills" maxlength="300">
            <a id="smarttavern_gm_clock_add" class="menu_button" title="Add this clock"><i class="fa-solid fa-plus"></i><span>Add clock</span></a>
        </div>

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-user-secret"></i><span>NPC agendas</span></div>
        <div id="smarttavern_gm_agendas">${agendaRows}</div>

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-circle-question"></i><span>Queued question</span></div>
        ${store.pendingQuestion ? `<div class="smarttavern_ruling_row"><div class="smarttavern_ruling_meta">
            <span class="smarttavern_ruling_question">${escapeHtml(store.pendingQuestion.question)}</span>
            <span class="smarttavern_ruling_spacer"></span>
            <a id="smarttavern_gm_question_clear" class="menu_button menu_button_icon" title="Do not ask this question"><i class="fa-solid fa-xmark"></i></a>
        </div></div>` : '<div class="smarttavern_hint">None. If the GM asks the player something it is queued here and asked right before the next reply (never on swipes or dry runs).</div>'}

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-list"></i><span>Last tick transcript</span></div>
        <details id="smarttavern_gm_transcript"><summary>Show the GM's last thinking</summary>${transcript}</details>
    `;
}

// --------------------------------------------------------------------------------------------
// Popup + arming (slash commands)
// --------------------------------------------------------------------------------------------

/** /smarttavern-gm — the prepared brief, clocks, agendas and queued question. */
export async function showGmState() {
    const context = getContext();
    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = 'GM — prepared brief and clocks';
    const pre = document.createElement('pre');
    pre.className = 'smarttavern_popup_pre';
    pre.style.maxHeight = '55vh';
    pre.textContent = gmStateText();
    content.append(title, pre);
    await context.callGenericPopup(content, context.POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
}

/** /smarttavern-think: arms the next tick in GM armed mode; unchanged behaviour for other engines. */
export function armFromCommand() {
    armAgent();
    const settings = getSettings();
    if (settings.agentEngine !== 'gm') {
        toastr.info('SmartTavern will run the selected agent before the next reply.', 'SmartTavern');
    } else if (settings.gmTickMode === 'armed') {
        toastr.info('SmartTavern armed: the GM will think after the next reply.', 'SmartTavern');
    } else {
        toastr.info('The GM already thinks on its own schedule — arming only matters in Armed tick mode.', 'SmartTavern');
    }
}

// --------------------------------------------------------------------------------------------
// Wiring (delegated once on the panel root)
// --------------------------------------------------------------------------------------------

export function wireGmTab($rootPanel, rerender = () => {}) {
    if (wired) return;
    const $panel = $rootPanel ?? $('#smarttavern_panel');
    if (!$panel?.length) return;
    wired = true;
    const idOf = element => Number($(element).attr('data-id') ?? 0);
    const nameOf = element => String($(element).attr('data-name') ?? '');
    const settingsInput = (id, key, normalize) => $panel.on('input change', `#${id}`, function () {
        getSettings()[key] = normalize(this);
        saveSettings();
    });

    $panel.on('change', '#smarttavern_gmTickMode', function () {
        getSettings().gmTickMode = ['every', 'everyN', 'armed'].includes(this.value) ? this.value : 'every';
        saveSettings();
        rerender();
    });
    settingsInput('smarttavern_gmEveryN', 'gmEveryN', el => Math.min(20, Math.max(2, clampNumber(el, getSettings().gmEveryN))));
    settingsInput('smarttavern_gmWaitMs', 'gmWaitMs', el => Math.min(60000, Math.max(0, clampNumber(el, getSettings().gmWaitMs))));
    $panel.on('input', '#smarttavern_gmTask', function () {
        getSettings().gmTask = String(this.value ?? '');
        saveSettings();
    });
    $panel.on('change', '#smarttavern_gmProfileId', function () {
        getSettings().gmProfileId = String(this.value ?? '');
        saveSettings();
    });
    $panel.on('change', '#smarttavern_gmFitProfileId', function () {
        getSettings().gmFitProfileId = String(this.value ?? '');
        saveSettings();
    });

    $panel.on('change', '#smarttavern_gmToolTransport', function () {
        getSettings().gmToolTransport = ['tags', 'native', 'auto'].includes(this.value) ? this.value : 'tags';
        saveSettings();
        rerender();
    });
    $panel.on('change', '#smarttavern_mcpEnabled', function () {
        getSettings().mcpEnabled = this.checked === true;
        saveSettings();
        // Nothing is probed (no server is started) until the user switches MCP on.
        if (this.checked) void refreshMcp();
        rerender();
    });
    settingsInput('smarttavern_mcpCallsPerTurn', 'mcpCallsPerTurn', el => Math.min(10, Math.max(0, clampNumber(el, getSettings().mcpCallsPerTurn))));
    $panel.on('change', '.smarttavern_mcp_tool', function () {
        const key = String($(this).attr('data-key') ?? '');
        const rest = (getSettings().mcpDisabledTools ?? []).filter(item => item !== key);
        getSettings().mcpDisabledTools = this.checked ? rest : [...rest, key];
        saveSettings();
    });
    $panel.on('click', '#smarttavern_mcp_refresh', () => { void refreshMcp(); });
    $panel.on('click', '#smarttavern_mcp_reload', () => { void refreshMcp({ reload: true }); });
    document.addEventListener('smarttavern:mcp-updated', () => {
        const root = $gmRoot().get(0);
        if (!root || !root.querySelector('#smarttavern_mcp_status')) return;
        if (root.contains(document.activeElement) && /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName)) {
            $(root).find('#smarttavern_mcp_status').text(mcpStatusLine());
            return;
        }
        rerender();
    });

    $panel.on('click', '#smarttavern_gm_think_now', async () => {
        const started = runGmTickNow();
        if (started?.error) {
            toastr.warning(`SmartTavern: ${started.error}`, 'SmartTavern');
            return;
        }
        toastr.info('SmartTavern: the GM is thinking…', 'SmartTavern');
        rerender();
        const outcome = await started;
        if (outcome) {
            if (outcome.ok) toastr.success(`SmartTavern GM: ${outcome.text}`, 'SmartTavern');
            else toastr.warning(`SmartTavern GM: ${outcome.text}`, 'SmartTavern');
        }
        rerender();
    });
    $panel.on('click', '#smarttavern_gm_arm', () => {
        armFromCommand();
        rerender();
    });
    $panel.on('click', '#smarttavern_gm_discard', () => {
        toastr.info(discardPrepared() ? 'SmartTavern: prepared brief discarded.' : 'SmartTavern: nothing is prepared.', 'SmartTavern');
        rerender();
    });

    $panel.on('click', '#smarttavern_gm_clock_add', () => {
        const name = String($panel.find('#smarttavern_gm_clock_name').val() ?? '').trim();
        const segments = Number($panel.find('#smarttavern_gm_clock_segments').val() ?? 6);
        const consequence = String($panel.find('#smarttavern_gm_clock_consequence').val() ?? '').trim();
        const made = addClockManual({ name, segments, consequence });
        if (!made.ok) toastr.warning(`SmartTavern: ${made.error}.`, 'SmartTavern');
        rerender();
    });
    $panel.on('click', '.smarttavern_gm_clock_advance:not(.disabled)', function () {
        const moved = advanceClockManual(idOf(this), 1);
        if (!moved.ok) toastr.warning(`SmartTavern: ${moved.error}.`, 'SmartTavern');
        else if (moved.justFilled) toastr.info('SmartTavern: the clock is full — its consequence joined the prepared brief.', 'SmartTavern');
        rerender();
    });
    $panel.on('click', '.smarttavern_gm_clock_resolve, .smarttavern_gm_clock_delete', function () {
        removeClockManual(idOf(this));
        rerender();
    });

    $panel.on('change', '.smarttavern_gm_agenda_text', function () {
        const set = setAgendaManual(nameOf(this), String(this.value ?? ''));
        if (!set.ok) toastr.warning(`SmartTavern: ${set.error}.`, 'SmartTavern');
        rerender();
    });
    $panel.on('click', '.smarttavern_gm_agenda_delete', function () {
        removeAgendaManual(nameOf(this));
        rerender();
    });
    $panel.on('click', '#smarttavern_gm_question_clear', () => {
        clearPendingQuestion();
        rerender();
    });

    // Ticks finish in the background: refresh the visible section unless the user is typing in it.
    document.addEventListener('smarttavern:gm-updated', () => {
        const root = $gmRoot().get(0);
        if (!root || !root.querySelector('#smarttavern_gm_status')) return;
        if (!$(root).closest('.smarttavern_tab_panel').hasClass('active')) return;
        if (root.contains(document.activeElement) && /^(TEXTAREA|INPUT|SELECT)$/.test(document.activeElement.tagName)) {
            $(root).find('#smarttavern_gm_status').text(gmStatusLine());
            return;
        }
        rerender();
    });
}
