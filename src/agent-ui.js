// SmartTavern — Thinking Agent panel tab: mode, connection profiles, per-tool toggles,
// budgets, the arm button, the last compiled brief + transcript, and the agent memory
// undo log. A thin view over agent.js / agent-tools.js; every control writes straight
// into settings (autosaved) or the agent module state.
//
// The tab is re-rendered on every open/switch (renderAgentTab) while the wiring is
// delegated ONCE on the panel root — the panel is built DETACHED from the DOM (see
// panel.js buildPanel), so a document-level query at wire time would bind nothing.
import { getSettings, saveSettings, getChatStore, charKey, isGroupChat, getGroupMembers, resolveTargetChar } from './state.js';
import { isAgentArmed, armAgent, isAgentBusy, getLastBrief, getLastTranscript, getSurfacedRulings } from './agent.js';
import {
    TOOL_REGISTRY, toolEnabled, memoryLog, undoMemoryLogEntry, listAgentOwnedEntries, getSceneState,
} from './agent-tools.js';
import {
    listRulings, updateRuling, deleteRuling, setPinned, undoRulingLogEntry, rulingLog,
    consultOracleManual, isRulingBusy,
} from './rulings.js';
import { profileOptionsHtml } from './panel.js';
import { openNarrationDialog } from './narration.js';

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

/** Like coerceNumber but keeps floats (ruling thresholds live between 0.3 and 0.95). */
function coerceFloat(el, current) {
    const num = Number(el.value);
    if (!Number.isFinite(num)) return current;
    const min = el.min !== '' && Number.isFinite(Number(el.min)) ? Number(el.min) : -Infinity;
    const max = el.max !== '' && Number.isFinite(Number(el.max)) ? Number(el.max) : Infinity;
    return Math.min(max, Math.max(min, num));
}

const TOOL_LABELS = {
    roll_dice: 'Dice (roll_dice) — binding rolls when outcomes are uncertain',
    consult_character: 'Character consult (consult_character) — inner voice: feel / react / backstory',
    consult_expert: 'Expert consult (consult_expert) — a custom question to a second LLM',
    scene: 'Scene state (update_scene) — established positions, injuries, inventory and time',
    ask_user: 'Ask the user (ask_user) — one popup when a decision is truly theirs',
    introduce_npc: 'Introduce NPC (introduce_npc) — invent + persist a recurring side character',
    memory: 'Memory (search / create / update / delete) — durable facts in the chat lorebook',
    ruling: 'Character ruling (character_ruling) — ask the oracle for a reusable behavioral ruling',
};

let wired = false;

// Rulings section state — survives the per-open re-renders of the tab.
let rulingTabCharKey = null;   // null = follow the chat's target character
let rulingTabFilter = 'all';
let rulingEditTimer = null;
let pendingRulingEdit = null;

function $agentRoot() {
    return $('#smarttavern_panel #smarttavern_agent_root');
}

// --------------------------------------------------------------------------------------------
// Rulings section helpers
// --------------------------------------------------------------------------------------------

function rulingSubject() {
    if (rulingTabCharKey) return rulingTabCharKey;
    const target = resolveTargetChar();
    return target ? charKey(target) : '';
}

function rulingSubjectOptions() {
    if (!isGroupChat()) return '';
    const members = getGroupMembers();
    const selected = rulingSubject();
    const options = members.map(member => {
        const key = charKey(member);
        return `<option value="${escapeHtml(key)}"${key === selected ? ' selected' : ''}>${escapeHtml(member?.name ?? key)}</option>`;
    }).join('');
    return `<label title="Group chat — each character keeps its own rulings">Character
        <select id="smarttavern_ruling_char">${options}</select>
    </label>`;
}

function rulingRowHtml(record, surfacedIds) {
    const id = Number(record.id);
    const pinned = record.pinned === true;
    return `
    <div class="smarttavern_ruling_row" data-id="${id}">
        <div class="smarttavern_ruling_meta">
            <span class="smarttavern_ruling_id">#${id}</span>
            <span class="smarttavern_ruling_status smarttavern_ruling_status_${escapeHtml(record.status ?? 'active')}">${escapeHtml(record.status ?? 'active')}</span>
            <span class="smarttavern_ruling_conf smarttavern_ruling_conf_${escapeHtml(record.confidence ?? 'medium')}" title="Oracle confidence">${escapeHtml(record.confidence ?? 'medium')}</span>
            ${record.source === 'manual' ? '<span class="smarttavern_ruling_source" title="Edited by the user">manual</span>' : ''}
            <span class="smarttavern_ruling_uses" title="Times surfaced or reused">×${Math.max(0, Math.round(Number(record.uses ?? 0)))}</span>
            ${surfacedIds.has(id) ? '<span class="smarttavern_ruling_surfaced" title="Surfaced in the last brief">★ last brief</span>' : ''}
            <span class="smarttavern_ruling_spacer"></span>
            <a class="menu_button menu_button_icon smarttavern_ruling_pin${pinned ? ' is-pinned' : ''}" data-id="${id}" data-pinned="${pinned ? '1' : ''}" title="${pinned ? 'Unpin — allow superseding and pruning again' : 'Pin — never superseded, expired or evicted'}"><i class="fa-solid fa-thumbtack"></i></a>
            <a class="menu_button menu_button_icon smarttavern_ruling_delete" data-id="${id}" title="Delete this ruling"><i class="fa-solid fa-trash"></i></a>
        </div>
        ${String(record.question ?? '').trim() ? `<div class="smarttavern_ruling_question" title="${escapeHtml(record.question)}">Q: ${escapeHtml(record.question)}</div>` : ''}
        <textarea class="smarttavern_ruling_text text_pole" rows="2" data-id="${id}" title="Edit the ruling — autosaves; an edit marks it manual and active">${escapeHtml(record.ruling ?? '')}</textarea>
    </div>`;
}

function rulingSectionHtml(settings) {
    if (settings.agentRulingsEnabled === false) {
        return `
        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-scale-balanced"></i><span>Rulings</span></div>
        <div class="smarttavern_hint">The rulings ledger is disabled. Enable it to let the agent ask the character oracle for reusable behavioral rulings.</div>
        <label class="checkbox">
            <input id="smarttavern_agentRulingsEnabled" type="checkbox">
            <span>Enable the rulings ledger</span>
        </label>`;
    }
    const subject = rulingSubject();
    const store = getChatStore();
    const hasLedger = Array.isArray(store.rulings);
    const all = hasLedger ? listRulings(subject) : [];
    const filtered = rulingTabFilter === 'all' ? all : all.filter(record => record.status === rulingTabFilter);
    const surfacedIds = new Set(getSurfacedRulings().map(record => Number(record.id)).filter(id => id > 0));
    const rows = filtered.length
        ? filtered.map(record => rulingRowHtml(record, surfacedIds)).join('')
        : `<div class="smarttavern_hint">${hasLedger ? 'No rulings for this character yet.' : 'No ledger in this chat yet — the first ruling creates it.'} Ask an open behavioral question below or let the agent call character_ruling.</div>`;
    const filterOptions = ['all', 'active', 'tentative', 'superseded']
        .map(value => `<option value="${value}"${rulingTabFilter === value ? ' selected' : ''}>${value}</option>`)
        .join('');
    const logRows = rulingLog().length
        ? rulingLog().map((row, index) => `
            <div class="smarttavern_agent_memory_row">
                <span class="smarttavern_agent_memory_action smarttavern_agent_action_${escapeHtml(row.action)}">${escapeHtml(row.action)}</span>
                <span class="smarttavern_agent_memory_title" title="${escapeHtml(`ruling #${row.id}`)}">ruling #${escapeHtml(String(row.id ?? ''))}${row.before?.question ? ` — ${escapeHtml(String(row.before.question).slice(0, 60))}` : ''}</span>
                <a class="menu_button menu_button_icon smarttavern_ruling_undo" data-index="${index}" title="Undo this ruling change"><i class="fa-solid fa-rotate-left"></i></a>
            </div>`).reverse().join('')
        : '<div class="smarttavern_hint">No ruling changes in this chat yet.</div>';
    return `
    <div class="smarttavern_steps_section_title"><i class="fa-solid fa-scale-balanced"></i><span>Rulings</span></div>
    <div class="smarttavern_hint">Durable character behavior, saved per chat: the agent asks the oracle once, later turns surface matching rulings as "Established behavior". Editing, pinning, deleting and undoing happen here.</div>
    <label class="checkbox">
        <input id="smarttavern_agentRulingsEnabled" type="checkbox" checked>
        <span>Enable the rulings ledger</span>
    </label>
    <label title="Connection profile for the character oracle; empty uses the agent profile">Oracle connection profile
        <select id="smarttavern_rulingProfileId" class="smarttavern_profile_select">${profileOptionsHtml(settings.rulingProfileId ?? '')}</select>
        <span class="smarttavern_missing_profile" id="smarttavern_ruling_missing_profile" title="The pinned connection profile no longer exists — requests fall back to the agent profile"><i class="fa-solid fa-triangle-exclamation"></i><span>missing</span></span>
    </label>
    ${rulingSubjectOptions()}
    <label>Consult now
        <div class="smarttavern_row_actions">
            <input id="smarttavern_ruling_question" type="text" class="text_pole" placeholder="How does she behave when someone flatters her?" maxlength="300">
            <a id="smarttavern_ruling_consult" class="menu_button smarttavern_busy_guard" title="Ask the character oracle and save the ruling"><i class="fa-solid fa-wand-magic-sparkles"></i><span>${isRulingBusy() ? 'Consulting…' : 'Ask'}</span></a>
        </div>
        <small>Saves the answer into this chat's ledger. Existing matching rulings are reused without a new oracle call.</small>
    </label>
    <label>Show
        <select id="smarttavern_ruling_filter">${filterOptions}</select>
    </label>
    <div id="smarttavern_ruling_list">${rows}</div>
    <div class="smarttavern_steps_section_title"><i class="fa-solid fa-clock-rotate-left"></i><span>Ruling changes (undo)</span></div>
    <div id="smarttavern_ruling_log">${logRows}</div>`;
}

// --------------------------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------------------------

export function renderAgentTab() {
    const $root = $agentRoot();
    if (!$root.length) return;
    const settings = getSettings();
    const engineHtml = `<label>Agent engine
        <select id="smarttavern_agentEngine">
            <option value="planner"${settings.agentEngine !== 'legacy' ? ' selected' : ''}>Planner — add useful expansion context</option>
            <option value="legacy"${settings.agentEngine === 'legacy' ? ' selected' : ''}>Legacy — tools and Turn Brief</option>
        </select></label>`;
    if (settings.agentEngine !== 'legacy') {
        $root.html(`${engineHtml}
            <div class="smarttavern_hint">Before expansion, the planner reads the existing prompts and up to 24 recent messages. It adds temporary blocks only when important context is missing. At most five expansion blocks run in total; your saved prompts stay unchanged. Independent blocks can run in parallel. See Results for accepted prompts and notices.</div>
            <div class="smarttavern_story_status" id="smarttavern_agent_status">${escapeHtml(agentStatusLine(settings))}</div>
            <label>Activation<select id="smarttavern_agentMode">
                <option value="always"${settings.agentMode === 'always' ? ' selected' : ''}>Always — plan before expansion</option>
                <option value="armed"${settings.agentMode === 'armed' ? ' selected' : ''}>Armed — only when triggered</option>
                <option value="off"${settings.agentMode === 'off' ? ' selected' : ''}>Off</option>
            </select></label>
            <div class="smarttavern_row_actions">
                <a id="smarttavern_agent_arm" class="menu_button smarttavern_busy_guard">Plan next reply</a>
                <a id="smarttavern_introduce_scene" class="menu_button smarttavern_busy_guard">Introduce scene…</a>
            </div>
            <label>Planner task<textarea id="smarttavern_plannerTask" class="text_pole" rows="4">${escapeHtml(settings.plannerTask)}</textarea></label>
            <label>Agent connection profile<select id="smarttavern_agentProfileId" class="smarttavern_profile_select">${profileOptionsHtml(settings.agentProfileId ?? '')}</select></label>
            <label>Planner / scene max output tokens<input id="smarttavern_agentAuxMaxTokens" type="number" min="1" max="100000" value="${settings.agentAuxMaxTokens}"></label>
            <div class="smarttavern_hint">Expansion must be enabled for planning. The scene action writes narration immediately, without expansion or refinement, and does not advance Story Director.</div>`);
        return;
    }
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

    $root.html(`${engineHtml}
        <div class="smarttavern_hint">
            Before every reply a thinking agent plans the turn: cheap LLM iterations with local
            tools (dice, consultations, scene state, ask-user, NPC intro, chat-lorebook memory), finished
            by a short <b>Turn Brief</b> injected into the reply prompt. The reply model never
            sees the agent's reasoning — only the brief.
        </div>

        <div class="smarttavern_story_status" id="smarttavern_agent_status">${escapeHtml(agentStatusLine(settings))}</div>

        <div class="smarttavern_row_actions">
            <a id="smarttavern_introduce_scene" class="menu_button smarttavern_busy_guard">Introduce scene…</a>
            <a id="smarttavern_agent_arm" class="menu_button smarttavern_busy_guard" title="Run the thinking agent once on the next reply, then disarm"><i class="fa-solid fa-bolt"></i><span>Think next reply</span></a>
            <a class="menu_button smarttavern_busy_guard smarttavern_chapter_end" title="Ask the Story Director to end the chapter and post a new playable situation"><i class="fa-solid fa-book-open"></i><span>Chapter End</span></a>
        </div>

        <label>Mode
            <select id="smarttavern_agentMode" title="Always = every reply; Armed = only after 'Think next reply'; Off = never">
                <option value="always"${settings.agentMode !== 'off' && settings.agentMode !== 'armed' ? ' selected' : ''}>Always — think before every reply</option>
                <option value="armed"${settings.agentMode === 'armed' ? ' selected' : ''}>Armed — only when triggered</option>
                <option value="off"${settings.agentMode === 'off' ? ' selected' : ''}>Off</option>
            </select>
        </label>

        <label>Agent task (editable prompt section)
            <textarea id="smarttavern_agentTask" class="text_pole" rows="4" placeholder="What should the agent focus on before each reply?">${escapeHtml(settings.agentTask ?? '')}</textarea>
            <small>Saved for future turns. The agent keeps its tool protocol and prepares a brief for the reply model.</small>
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
            <label title="Output token budget for consult_character and NPC generation">Auxiliary max tokens
                <input id="smarttavern_agentAuxMaxTokens" class="text_margin_input" type="number" min="1" max="100000" step="100" value="${settings.agentAuxMaxTokens}">
            </label>
            <label title="ask_user calls per turn (0 disables)">Asks per turn
                <input id="smarttavern_agentAskPerTurn" class="text_margin_input" type="number" min="0" max="3" step="1" value="${settings.agentAskPerTurn}">
            </label>
            <label title="Shared by memory create/update/delete and NPC persistence">Memory writes per turn
                <input id="smarttavern_agentMemoryWritesPerTurn" class="text_margin_input" type="number" min="0" max="10" step="1" value="${settings.agentMemoryWritesPerTurn}">
            </label>
            <label title="character_ruling calls per turn (0 disables)">Rulings per turn
                <input id="smarttavern_agentConsultPerTurn" class="text_margin_input" type="number" min="0" max="4" step="1" value="${settings.agentConsultPerTurn}">
            </label>
            <label title="Maximum saved rulings per chat; superseded and tentative ones are pruned first">Ledger cap
                <input id="smarttavern_agentRulingsMax" class="text_margin_input" type="number" min="5" max="300" step="5" value="${settings.agentRulingsMax}">
            </label>
            <label title="Rulings auto-surfaced into one Turn Brief">Surfaced per brief
                <input id="smarttavern_agentRulingsSurfaceMax" class="text_margin_input" type="number" min="0" max="4" step="1" value="${settings.agentRulingsSurfaceMax}">
            </label>
            <label title="Reuse an existing ruling when the question matches at/above this similarity">Reuse threshold
                <input id="smarttavern_agentRulingReuseThreshold" class="text_margin_input" type="number" min="0.3" max="0.95" step="0.05" value="${settings.agentRulingReuseThreshold}">
            </label>
            <label title="Surface a ruling into the brief when its keys match the chat at/above this score">Surface threshold
                <input id="smarttavern_agentRulingSurfaceThreshold" class="text_margin_input" type="number" min="0.3" max="0.95" step="0.05" value="${settings.agentRulingSurfaceThreshold}">
            </label>
        </div>

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-file-lines"></i><span>Last Turn Brief</span></div>
        <pre id="smarttavern_agent_brief" class="smarttavern_story_directive">${escapeHtml(brief || '(no brief compiled yet — send a message)')}</pre>
        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-map-pin"></i><span>Scene state</span></div>
        <pre class="smarttavern_story_directive">${escapeHtml(JSON.stringify(getSceneState(), null, 2))}</pre>

        ${rulingSectionHtml(settings)}

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
    const parts = [`engine: ${settings.agentEngine}`, `mode: ${settings.agentMode}`];
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

    $panel.on('change', '#smarttavern_agentEngine', function () {
        getSettings().agentEngine = this.value === 'legacy' ? 'legacy' : 'planner';
        saveSettings();
        renderAgentTab();
    });
    $panel.on('input', '#smarttavern_plannerTask', function () {
        getSettings().plannerTask = String(this.value ?? '');
        saveSettings();
    });
    $panel.on('click', '#smarttavern_introduce_scene', () => openNarrationDialog());

    $panel.on('input', '#smarttavern_agentTask', function () {
        getSettings().agentTask = String(this.value ?? '');
        saveSettings();
    });

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

    $panel.on('change', '#smarttavern_rulingProfileId', function () {
        getSettings().rulingProfileId = String(this.value ?? '');
        saveSettings();
    });

    $panel.on('change', '#smarttavern_agentRulingsEnabled', function () {
        getSettings().agentRulingsEnabled = this.checked;
        saveSettings();
        renderAgentTab();
    });

    $panel.on('change', '#smarttavern_ruling_char', function () {
        rulingTabCharKey = String(this.value ?? '') || null;
        renderAgentTab();
    });

    $panel.on('change', '#smarttavern_ruling_filter', function () {
        rulingTabFilter = ['all', 'active', 'tentative', 'superseded'].includes(this.value) ? this.value : 'all';
        renderAgentTab();
    });

    // Ruling edits autosave (debounced); the value is captured so re-renders never
    // clobber the in-flight edit, and the list is NOT re-rendered on keystrokes.
    $panel.on('input', '.smarttavern_ruling_text', function () {
        const id = Number($(this).data('id') ?? 0);
        const value = String(this.value ?? '');
        pendingRulingEdit = { id, value };
        if (rulingEditTimer) clearTimeout(rulingEditTimer);
        rulingEditTimer = setTimeout(() => {
            rulingEditTimer = null;
            const edit = pendingRulingEdit;
            pendingRulingEdit = null;
            if (!edit || !Number.isInteger(edit.id) || edit.id <= 0) return;
            const current = listRulings(rulingSubject()).find(record => record.id === edit.id);
            if (!current || String(current.ruling ?? '') === edit.value.trim()) return;
            if (updateRuling(edit.id, { ruling: edit.value })) {
                toastr.success(`SmartTavern: ruling #${edit.id} updated.`, 'SmartTavern');
            } else {
                toastr.warning(`SmartTavern: ruling #${edit.id} could not be updated.`, 'SmartTavern');
            }
        }, 500);
    });

    $panel.on('click', '.smarttavern_ruling_pin', function () {
        const id = Number($(this).data('id') ?? 0);
        const pinned = $(this).data('pinned') !== '1';
        setPinned(id, pinned);
        renderAgentTab();
    });

    $panel.on('click', '.smarttavern_ruling_delete', function () {
        const id = Number($(this).data('id') ?? 0);
        if (deleteRuling(id)) toastr.info(`SmartTavern: ruling #${id} deleted (undo below).`, 'SmartTavern');
        renderAgentTab();
    });

    $panel.on('click', '.smarttavern_ruling_undo', function () {
        const index = Number($(this).data('index') ?? -1);
        if (!Number.isInteger(index) || index < 0) return;
        const undone = undoRulingLogEntry(index);
        if (undone) toastr.success('SmartTavern: ruling change undone.', 'SmartTavern');
        else toastr.warning('SmartTavern: the ruling changed since — undo skipped.', 'SmartTavern');
        renderAgentTab();
    });

    $panel.on('click', '#smarttavern_ruling_consult', async function () {
        const $input = $panel.find('#smarttavern_ruling_question');
        const question = String($input.val() ?? '').trim();
        if (question.length < 4) {
            toastr.warning('SmartTavern: ask a behavioral question first (at least 4 characters).', 'SmartTavern');
            return;
        }
        // Group chats: consult the character selected in the tab, not the chat default.
        const char = rulingTabCharKey
            ? (getGroupMembers().find(member => charKey(member) === rulingTabCharKey) ?? null)
            : null;
        const outcome = await consultOracleManual({ question, char });
        if (outcome?.error) toastr.warning(`SmartTavern: ${outcome.error}`, 'SmartTavern');
        else if (outcome) toastr.success(outcome.text, 'SmartTavern', { timeOut: 8000 });
        renderAgentTab();
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
        smarttavern_agentAuxMaxTokens: 'agentAuxMaxTokens',
        smarttavern_agentAskPerTurn: 'agentAskPerTurn',
        smarttavern_agentMemoryWritesPerTurn: 'agentMemoryWritesPerTurn',
        smarttavern_agentConsultPerTurn: 'agentConsultPerTurn',
        smarttavern_agentRulingsMax: 'agentRulingsMax',
        smarttavern_agentRulingsSurfaceMax: 'agentRulingsSurfaceMax',
    };
    const FLOAT_FIELDS = {
        smarttavern_agentRulingReuseThreshold: 'agentRulingReuseThreshold',
        smarttavern_agentRulingSurfaceThreshold: 'agentRulingSurfaceThreshold',
    };
    for (const [id, key] of Object.entries(FLOAT_FIELDS)) {
        $panel.on('input', `#${id}`, function () {
            getSettings()[key] = coerceFloat(this, Number(getSettings()[key]));
            saveSettings();
        });
    }
    for (const [id, key] of Object.entries(NUMBER_FIELDS)) {
        $panel.on('input', `#${id}`, function () {
            getSettings()[key] = coerceNumber(this, Number(getSettings()[key]));
            saveSettings();
        });
    }

    $panel.on('click', '#smarttavern_agent_arm', () => {
        armAgent();
        toastr.info('SmartTavern will run the selected agent before the next reply.', 'SmartTavern');
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
