// SmartTavern — shared step-tracker chips. One markup/state convention reused by the
// refinement veil overlay, the activity HUD and the Results tab replay, so pass progress
// reads identically everywhere. States: pending → running → done | failed.

const htmlEscapes = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, ch => htmlEscapes[ch]);
}

export function chipIcon(state) {
    if (state === 'running') return 'fa-solid fa-circle-notch fa-spin';
    if (state === 'done') return 'fa-solid fa-check';
    if (state === 'failed') return 'fa-solid fa-xmark';
    if (state === 'skipped') return 'fa-solid fa-minus';
    // SillyTavern ships only the solid FA font (no fa-regular face), so a
    // `fa-regular fa-circle` silently renders as a solid dot. The pending state
    // uses a CSS-drawn hollow ring instead (see .smarttavern_chip_ring).
    return 'smarttavern_chip_ring';
}

/** Renders a chip row for `names`; `states` may be shorter (remaining chips are pending). */
export function chipsHtml(names, states = []) {
    return names.map((name, index) => {
        const state = states[index] ?? 'pending';
        const stateClass = ['running', 'done', 'failed', 'skipped'].includes(state) ? ` is-${state}` : '';
        return `<span class="smarttavern_chip${stateClass}" title="${escapeHtml(name)}">`
            + `<i class="${chipIcon(state)}"></i><span class="smarttavern_chip_name">${escapeHtml(name)}</span></span>`;
    }).join('');
}

/** Flips one chip's state inside a container that was filled with `chipsHtml`. */
export function setChipState($container, index, state) {
    if (!$container?.length) return;
    const $chip = $container.find('.smarttavern_chip').eq(index);
    if (!$chip.length) return;
    const stateClass = ['running', 'done', 'failed', 'skipped'].includes(state) ? `is-${state}` : '';
    $chip.attr('class', `smarttavern_chip${stateClass ? ` ${stateClass}` : ''}`);
    $chip.find('i').attr('class', chipIcon(state));
}
