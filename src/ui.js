// SmartTavern — extension settings drawer (thin shell): enable toggle, "Open panel" button,
// status line, slash commands and the debug dump. The floating panel itself lives in panel.js.
import { getContext } from '../../../../extensions.js';
import { getSettings, saveSettings, getChatStore, allStoredProfiles, log } from './state.js';
import {
    initPanel, openPanel, togglePanel, refreshStatus, refreshProfileSelects,
    showProfilePopup, showRunResults, runUpdateCommand, runRebuildCommand, runResetCommand,
} from './panel.js';

export function initUI() {
    $('#extensions_settings2').append(buildDrawerHtml());
    wireDrawer();
    initPanel();
    registerSlashCommands();
    registerDebugDump();
    refreshStatus();
    applyDrawerFloatingVisibility();

    $(document).on('smarttavern:floating-changed', applyDrawerFloatingVisibility);

    // Pick up newly created connection profiles without re-rendering everything.
    $(document).on('mousedown focus', '.smarttavern_profile_select', () => refreshProfileSelects());

    log('UI initialized');
}

// --------------------------------------------------------------------------------------------
// Drawer
// --------------------------------------------------------------------------------------------

function buildDrawerHtml() {
    const settings = getSettings();
    return `
    <div id="smarttavern_settings" class="extension_settings">
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header">
                <b>SmartTavern</b>
                <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
            </div>
            <div class="inline-drawer-content">
                <div class="smarttavern_hint">
                    Living per-chat character profiles plus a chained multi-pass reasoning pipeline.
                    Right-click a character's avatar in chat (long-press on touch devices), use the
                    wand menu, or press the button below to summon the floating panel.
                </div>

                <label class="checkbox">
                    <input id="smarttavern_enabled" type="checkbox" ${settings.enabled ? 'checked' : ''}>
                    <i class="fa-solid fa-check"></i>
                    <span>Enable SmartTavern (pipeline injection)</span>
                </label>

                <a id="smarttavern_open_panel" class="menu_button">
                    <i class="fa-solid fa-up-right-from-square"></i><span>Open SmartTavern panel</span>
                </a>

                <div class="smarttavern_hint" id="smarttavern_status"></div>
            </div>
        </div>
    </div>`;
}

function wireDrawer() {
    const enabledEl = /** @type {HTMLInputElement} */ ($('#smarttavern_enabled').get(0));
    if (enabledEl) {
        enabledEl.addEventListener('change', () => {
            getSettings().enabled = enabledEl.checked;
            saveSettings();
            refreshStatus();
            // Mirror the state into the floating panel's copy (if it is currently attached).
            $('#smarttavern_panel #smarttavern_enabled').prop('checked', enabledEl.checked);
        });
    }
    $('#smarttavern_open_panel').get(0)?.addEventListener('click', () => openPanel());
}

function applyDrawerFloatingVisibility() {
    $('#smarttavern_open_panel').toggle(!Boolean(getSettings().disableFloatingUI));
}

// --------------------------------------------------------------------------------------------
// Slash commands
// --------------------------------------------------------------------------------------------

function registerSlashCommands() {
    const context = getContext();
    const { SlashCommandParser, SlashCommand, SlashCommandArgument, ARGUMENT_TYPE } = context;

    const commands = [
        { name: 'smarttavern-profile', help: 'Show the stored living profile for a character (defaults to the current target)', run: (arg) => showProfilePopup(arg) },
        { name: 'smarttavern-update', help: 'Run a profile update for a character right now', run: (arg) => runUpdateCommand(arg) },
        { name: 'smarttavern-rebuild', help: 'Fully rewrite the profile from the character card', run: (arg) => runRebuildCommand(arg) },
        { name: 'smarttavern-reset', help: 'Delete the stored profile for a character', run: (arg) => runResetCommand(arg) },
        { name: 'smarttavern-run', help: 'Run the reasoning pipeline (dry run) and show raw step outputs', run: (_arg) => showRunResults() },
        { name: 'smarttavern-hud', help: 'Toggle the SmartTavern floating panel', run: (_arg) => togglePanel() },
    ];

    for (const { name, help, run } of commands) {
        SlashCommandParser.addCommandObject(SlashCommand.fromProps({
            name,
            aliases: [name.replace('smarttavern-', 'st-')],
            callback: async (_namedArgs, unnamedArgs) => {
                await run(unnamedArgs);
                return '';
            },
            helpString: help,
            unnamedArgumentList: [
                SlashCommandArgument.fromProps({
                    description: 'Character name (optional; defaults to the current chat target)',
                    typeList: [ARGUMENT_TYPE.STRING],
                    isRequired: false,
                }),
            ],
        }));
    }
}

// --------------------------------------------------------------------------------------------
// Debug
// --------------------------------------------------------------------------------------------

function registerDebugDump() {
    const context = getContext();
    if (typeof context.registerDebugFunction !== 'function') return;
    context.registerDebugFunction(
        'smarttavern_dump',
        'SmartTavern state dump',
        'Dumps SmartTavern settings and the current chat profile store to the console.',
        () => {
            console.log('[SmartTavern] settings:', getSettings());
            console.log('[SmartTavern] chat store:', getChatStore());
            console.log('[SmartTavern] stored profiles:', allStoredProfiles());
        },
    );
}
