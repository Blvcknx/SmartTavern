// SmartTavern — floating entry points: right-click (or long-press on touch) any character
// avatar in the chat to summon a quick context menu, plus a button in the extensions
// (wand) menu. Both respect the master "Disable floating UI" switch.
import { getContext } from '../../../../extensions.js';
import { getSettings, charKey, resolveTargetChar, resolveMemberByMessageName, log, warn } from './state.js';
import { updateProfile } from './profiles.js';
import { openPanel, promptForGuide } from './panel.js';

const LONG_PRESS_MS = 550;
const LONG_PRESS_SLOP_PX = 10;

export function initHud() {
    addWandButton();
    bindAvatarContextMenu();
    bindLongPress();
    bindDismissal();
    bindAvatarBadges();
    $(document).on('smarttavern:floating-changed', () => {
        applyFloatingMode();
    });
    applyFloatingMode();
    log('floating entry points registered');
}

function floatingDisabled() {
    return Boolean(getSettings().disableFloatingUI);
}

function applyFloatingMode() {
    $('#smarttavern_wand_button').toggle(!floatingDisabled());
    hideMenu();
}

// --------------------------------------------------------------------------------------------
// Wand menu button
// --------------------------------------------------------------------------------------------

function addWandButton() {
    const $menu = $('#extensionsMenu');
    if (!$menu.length) {
        warn('extensions menu not found; wand button skipped');
        return;
    }
    const item = $(`
        <div id="smarttavern_wand_button" class="list-group-item flex-container flexGap5" title="Open the SmartTavern panel">
            <div class="fa-solid fa-brain extensionsMenuExtensionButton"></div>
            <span>SmartTavern</span>
        </div>`);
    item.on('click', () => openPanel());
    $menu.append(item);
}

// --------------------------------------------------------------------------------------------
// Avatar context menu (RMB / long-press)
// --------------------------------------------------------------------------------------------

let $ctxMenu = null;
let ctxChar = null;
let menuShownAt = 0;

function messageFromEvent(event) {
    const mesid = Number($(event.target).closest('.mes').attr('mesid'));
    if (!Number.isInteger(mesid) || mesid < 0) return null;
    const chat = getContext().chat ?? [];
    return chat[mesid] ?? null;
}

/** Resolves the character a message avatar belongs to; null for user/system messages. */
function charFromMessageEvent(event) {
    const message = messageFromEvent(event);
    if (!message || message.is_user || message.is_system) return null;
    return resolveMemberByMessageName(message.name) ?? resolveTargetChar() ?? null;
}

function bindAvatarContextMenu() {
    // RMB on an avatar is unused by SillyTavern, so it is safe to intercept.
    $('#chat').on('contextmenu', '.mes .avatar', (event) => {
        if (floatingDisabled()) return; // let the native menu through
        const char = charFromMessageEvent(event);
        if (!char) return;
        event.preventDefault();
        event.stopPropagation();
        showMenu(event.clientX, event.clientY, char);
    });
}

function bindLongPress() {
    let timer = null;
    let fired = false;
    let startX = 0;
    let startY = 0;

    const clear = () => {
        if (timer) {
            clearTimeout(timer);
            timer = null;
        }
        $(window).off('pointerup.smarttavern_lp pointercancel.smarttavern_lp pointermove.smarttavern_lp');
    };

    $('#chat').on('pointerdown', '.mes .avatar', (event) => {
        if (event.pointerType !== 'touch' || floatingDisabled()) return;
        const char = charFromMessageEvent(event);
        if (!char) return;
        // Capture now — jQuery clears currentTarget once dispatch finishes, so reading it
        // inside the timer callback would return undefined.
        const targetEl = event.currentTarget;
        const origin = /** @type {PointerEvent} */ (event.originalEvent ?? event);
        startX = origin.clientX;
        startY = origin.clientY;
        clear();
        $(window).on('pointerup.smarttavern_lp pointercancel.smarttavern_lp', clear);
        $(window).on('pointermove.smarttavern_lp', (moveEvent) => {
            const move = /** @type {PointerEvent} */ (moveEvent.originalEvent ?? moveEvent);
            if (Math.hypot(move.clientX - startX, move.clientY - startY) > LONG_PRESS_SLOP_PX) clear();
        });
        timer = setTimeout(() => {
            timer = null;
            fired = true;
            const rect = targetEl.getBoundingClientRect();
            showMenu(rect.left + rect.width / 2, rect.bottom + 6, char);
            try { navigator.vibrate?.(10); } catch { /* ignore */ }
        }, LONG_PRESS_MS);
    });

    // The long-press must not ALSO open the avatar zoom view right after the menu.
    document.addEventListener('click', (event) => {
        if (!fired) return;
        if ($(event.target).closest('.mes .avatar').length) {
            event.stopPropagation();
            event.preventDefault();
        }
        fired = false;
    }, true);
}

function ensureMenu() {
    if ($ctxMenu) return $ctxMenu;
    $ctxMenu = $(`
        <div id="smarttavern_ctx_menu">
            <div class="smarttavern_ctx_title"></div>
            <div class="smarttavern_ctx_item" data-action="bio"><div class="fa-solid fa-user-pen extensionsMenuExtensionButton"></div><span>Edit living bio</span></div>
            <div class="smarttavern_ctx_item" data-action="steps"><div class="fa-solid fa-diagram-project extensionsMenuExtensionButton"></div><span>Edit pipeline</span></div>
            <div class="smarttavern_ctx_item" data-action="update"><div class="fa-solid fa-arrows-rotate extensionsMenuExtensionButton"></div><span>Update bio now</span></div>
            <div class="smarttavern_ctx_item" data-action="guided-update"><div class="fa-solid fa-compass extensionsMenuExtensionButton"></div><span>Guided update…</span></div>
            <div class="smarttavern_ctx_item" data-action="results"><div class="fa-solid fa-square-poll-horizontal extensionsMenuExtensionButton"></div><span>Last result</span></div>
        </div>`);
    $ctxMenu.on('click', '.smarttavern_ctx_item', (event) => {
        const action = String($(event.currentTarget).data('action') ?? '');
        const char = ctxChar;
        hideMenu();
        handleMenuAction(action, char);
    });
    $(document.body).append($ctxMenu);
    return $ctxMenu;
}

function showMenu(x, y, char) {
    const menu = ensureMenu();
    ctxChar = char;
    menu.find('.smarttavern_ctx_title').text(char.name ?? 'Character');
    // Reset the position before measuring, so clamping is correct near the right/bottom edge.
    menu.removeClass('show').css({ left: '0px', top: '0px' });
    menu.addClass('show');
    menuShownAt = Date.now();
    const left = Math.max(8, Math.min(x, window.innerWidth - menu.outerWidth() - 8));
    const top = Math.max(8, Math.min(y, window.innerHeight - menu.outerHeight() - 8));
    menu.css({ left: `${left}px`, top: `${top}px` });
}

function hideMenu() {
    if ($ctxMenu) $ctxMenu.removeClass('show');
    ctxChar = null;
}

function handleMenuAction(action, char) {
    if (!char) return;
    switch (action) {
        case 'bio':
            openPanel('profile', { charKey: charKey(char) });
            break;
        case 'steps':
            openPanel('steps');
            break;
        case 'results':
            openPanel('results');
            break;
        case 'update':
            updateProfile(char, { notify: true })
                .then((result) => {
                    if (!result) toastr.info('Update already in progress for this character.', 'SmartTavern');
                })
                .catch((error) => {
                    console.error('[SmartTavern] quick profile update failed', error);
                    toastr.error(`Profile update failed — ${error?.message ?? error}`, 'SmartTavern');
                });
            break;
        case 'guided-update':
            (async () => {
                const guide = await promptForGuide(
                    `Guided update — ${char.name}`,
                    'Optional extra direction for this update. It refines the generation without overriding the schema, the character card, or established facts. Leave empty for a plain update.',
                );
                if (guide === null) return; // popup cancelled
                try {
                    const result = await updateProfile(char, { notify: true, guide });
                    if (!result) toastr.info('Update already in progress for this character.', 'SmartTavern');
                } catch (error) {
                    console.error('[SmartTavern] guided profile update failed', error);
                    toastr.error(`Profile update failed — ${error?.message ?? error}`, 'SmartTavern');
                }
            })();
            break;
    }
}

function bindDismissal() {
    $(document).on('mousedown contextmenu', (event) => {
        if (!$ctxMenu || !$ctxMenu.hasClass('show')) return;
        // Ignore the synthetic mousedown that follows a long-press release.
        if (Date.now() - menuShownAt < 350) return;
        // Never hide between mousedown and mouseup of a menu item click.
        if ($(event.target).closest('#smarttavern_ctx_menu').length) return;
        hideMenu();
    });
    $('#chat').on('scroll', hideMenu);
    $(window).on('blur resize scroll', hideMenu);
    document.addEventListener('keydown', (event) => {
        if (event.key === 'Escape' && $ctxMenu?.hasClass('show')) {
            event.stopPropagation();
            hideMenu();
        }
    }, true);
}

// --------------------------------------------------------------------------------------------
// Avatar change badges — silent background profile updates leave a dot on the character's
// avatars in chat; clicking it opens the profile (and shows the field diff).
// --------------------------------------------------------------------------------------------

function bindAvatarBadges() {
    $(document).on('smarttavern:profile-updated', (event) => {
        const detail = event.originalEvent?.detail;
        if (!detail?.silent || !Array.isArray(detail.changedFields) || !detail.changedFields.length) return;
        badgeAvatars(String(detail.key ?? ''));
    });

    $(document).on('click', '.smarttavern_avatar_dot', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const key = String($(event.currentTarget).data('key') ?? '');
        if (!key) return;
        // Viewing the profile dismisses every dot of that character.
        $('.smarttavern_avatar_dot').each(function () {
            if (String($(this).data('key') ?? '') === key) $(this).remove();
        });
        openPanel('profile', { charKey: key });
    });
}

function badgeAvatars(key) {
    if (!key || floatingDisabled()) return;
    // charKey is the avatar filename; chat avatars render via /thumbnail?...&file=<encoded>.
    const needle = encodeURIComponent(key);
    const attrKey = String(key).replace(/"/g, '&quot;');
    $('#chat .mes .avatar img').each(function () {
        const src = this.getAttribute('src') ?? '';
        if (!src.includes(needle)) return;
        const $avatar = $(this).closest('.avatar');
        if ($avatar.find('.smarttavern_avatar_dot').length) return;
        $avatar.css('position', 'relative');
        $avatar.append(`<span class="smarttavern_avatar_dot" data-key="${attrKey}" title="Living profile changed in the background — click to view"><i class="fa-solid fa-arrows-rotate"></i></span>`);
    });
}
