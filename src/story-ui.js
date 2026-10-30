// SmartTavern — Story Director panel tab: seed + craft controls, status line, the
// editable bible/beat fields (autosaving through updateStory, like the Profile tab)
// and the read-only directive preview. Also hosts the story slash-command runners.
//
// The tab is a thin view over story.js; every action funnels through craftStory /
// advanceStory, every edit autosaves through the story store setter.
import { getContext } from '../../../../extensions.js';
import { getSettings, getStory, updateStory, clearStory } from './state.js';
import { craftStory, advanceStory, previewStoryDirective, lastStoryAssessment, isStoryBusy } from './story.js';
import { chapterIndexAt, wordCount } from './story-core.js';

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

async function confirmPopup(header, text) {
    const context = getContext();
    const result = await context.Popup.show.confirm(header, text);
    return result === context.POPUP_RESULT.AFFIRMATIVE;
}

let wired = false;
let selectedChapter = 0;

function $storyRoot() {
    return $('#smarttavern_panel #smarttavern_story_root');
}

// --------------------------------------------------------------------------------------------
// Rendering
// --------------------------------------------------------------------------------------------

function statusLine(story) {
    if (!story?.bible) return 'No story yet — craft one from a seed below.';
    const settings = getSettings();
    const chapters = story.bible.chapters ?? [];
    const index = chapterIndexAt(story);
    const idle = settings.storyIdleTurns ?? 3;
    const parts = [`Chapter ${index + 1}/${chapters.length}: ${chapters[index]?.title ?? 'Untitled'}`];
    if (!story.beat) parts.push('no beat yet — use Next beat');
    else if (story.beat.status === 'pending') parts.push('beat pending');
    else parts.push(`beat delivered${story.beat.deliveredAtMsg != null ? ` (msg ${story.beat.deliveredAtMsg})` : ''} · idle ${story.turnsSinceDelivery ?? 0}/${idle}`);
    const assessment = lastStoryAssessment();
    if (assessment?.chapterDone) parts.push('exit looks met — consider Next chapter');
    return parts.join(' · ');
}

function setByPath(story, path, value) {
    const segments = String(path ?? '').split('.');
    let node = story;
    for (let i = 0; i < segments.length - 1; i++) {
        const key = segments[i];
        const nextKey = segments[i + 1];
        const nextIndex = /^\d+$/.test(nextKey) ? Number(nextKey) : nextKey;
        if (Array.isArray(node)) node = node[Number(key)] ??= [];
        else node = node[key] ??= (typeof nextIndex === 'number' ? [] : {});
    }
    const last = segments[segments.length - 1];
    if (Array.isArray(node)) node[Number(last)] = value;
    else node[last] = value;
}

function textField({ path, value, label, rows = 0, placeholder = '', title = '' }) {
    const escapedValue = escapeHtml(value);
    const labelHtml = label ? `<label title="${escapeHtml(title)}">${escapeHtml(label)}</label>` : '';
    if (rows > 0) {
        return `<div class="smarttavern_bio_field">${labelHtml}<textarea class="smarttavern_story_textarea smarttavern_story_field"
            data-path="${escapeHtml(path)}" rows="${rows}" placeholder="${escapeHtml(placeholder)}">${escapedValue}</textarea></div>`;
    }
    return `<div class="smarttavern_bio_field">${labelHtml}<input class="text_margin_input smarttavern_story_field"
        data-path="${escapeHtml(path)}" type="text" value="${escapedValue}" placeholder="${escapeHtml(placeholder)}"></div>`;
}

function renderStoryTab() {
    const $root = $storyRoot();
    if (!$root.length) return;
    const story = getStory();
    const settings = getSettings();

    let html = `
        <div class="smarttavern_hint">
            The Director keeps the story moving without you being the GM. Craft a scenario once,
            then <b>Next beat</b> compiles one concrete event the reply MUST show. The bible, the
            cast's secrets and future chapters stay Director-only — the reply model only ever sees
            the compiled directive below.
        </div>
        <div class="smarttavern_story_status" id="smarttavern_story_status">${escapeHtml(statusLine(story))}</div>`;

    if (story?.bible) {
        const chapters = story.bible.chapters ?? [];
        const index = chapterIndexAt(story);
        selectedChapter = Math.min(Math.max(0, selectedChapter), chapters.length - 1);
        const chapter = chapters[selectedChapter];

        html += `
        <div class="smarttavern_row_actions">
            <a id="smarttavern_story_beat" class="menu_button smarttavern_busy_guard" title="Compile the next concrete event (one Director call, sees the live chat)"><i class="fa-solid fa-forward"></i><span>Next beat</span></a>
            <a id="smarttavern_story_chapter" class="menu_button smarttavern_busy_guard" title="Close the current chapter and write the opening beat of the next"><i class="fa-solid fa-flag-checkered"></i><span>Next chapter</span></a>
            <a id="smarttavern_story_reset" class="menu_button smarttavern_busy_guard" title="Delete the story for this chat"><i class="fa-solid fa-trash"></i><span>Reset</span></a>
        </div>
        <div class="smarttavern_bio_field">
            <label title="Free-text steering for the next beat — the Director respects it">Steering note for the next beat (optional)</label>
            <input id="smarttavern_story_note" class="text_margin_input" type="text" placeholder="e.g. bring in the estranged sister, keep it quiet">
        </div>

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-bullseye"></i><span>Beat — the event the reply must show</span></div>
        ${textField({ path: 'beat.text', value: story.beat?.text ?? '', label: 'Beat text (your strongest steering tool)', rows: 2, placeholder: 'One concrete observable event…' })}
        ${textField({ path: 'beat.escalations.0', value: story.beat?.escalations?.[0] ?? '', label: 'Escalation 1 (after the first idle stretch)' })}
        ${textField({ path: 'beat.escalations.1', value: story.beat?.escalations?.[1] ?? '', label: 'Escalation 2 (harder fallback)' })}
        ${textField({ path: 'beat.fact', value: story.beat?.fact ?? '', label: 'Fact once delivered (≤15 words, past tense)' })}

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-book"></i><span>Bible</span></div>
        ${textField({ path: 'bible.premise', value: story.bible.premise ?? '', label: 'Premise', rows: 2 })}
        ${textField({ path: 'bible.setting', value: story.bible.setting ?? '', label: 'Setting', rows: 2 })}
        ${textField({ path: 'bible.tone', value: story.bible.tone ?? '', label: 'Tone' })}
        ${textField({ path: 'bible.conflict', value: story.bible.conflict ?? '', label: 'Conflict', rows: 2 })}
        ${textField({ path: 'bible.secrets', value: story.bible.secrets ?? '', label: 'Secrets (Director-only — never sent to the reply model)', rows: 3 })}

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-list-ol"></i><span>Chapters</span></div>
        <select id="smarttavern_story_chapter_pick" class="text_margin_input" title="Pick a chapter to edit">
            ${chapters.map((ch, i) => `<option value="${i}"${i === selectedChapter ? ' selected' : ''}>${i + 1}/${chapters.length}: ${escapeHtml(ch.title || 'Untitled')}${i === index ? ' · current' : ''}</option>`).join('')}
        </select>
        ${chapter ? `
        ${textField({ path: `bible.chapters.${selectedChapter}.title`, value: chapter.title ?? '', label: 'Title' })}
        ${textField({ path: `bible.chapters.${selectedChapter}.situation`, value: chapter.situation ?? '', label: 'Situation (one concrete sentence)', rows: 2 })}
        ${textField({ path: `bible.chapters.${selectedChapter}.goal`, value: chapter.goal ?? '', label: 'Goal', rows: 2 })}
        ${textField({ path: `bible.chapters.${selectedChapter}.exit`, value: chapter.exit ?? '', label: 'Exit (observable event)', rows: 2 })}
        ${textField({ path: `bible.chapters.${selectedChapter}.clues`, value: chapter.clues ?? '', label: 'Clues', rows: 2 })}` : ''}

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-users"></i><span>Cast</span></div>
        <div id="smarttavern_story_cast">
        ${(story.bible.cast ?? []).map((member, i) => `
            <div class="smarttavern_story_cast_row">
                ${textField({ path: `bible.cast.${i}.name`, value: member.name ?? '', label: i === 0 ? 'Name' : '' })}
                ${textField({ path: `bible.cast.${i}.role`, value: member.role ?? '', label: i === 0 ? 'Role' : '' })}
                ${textField({ path: `bible.cast.${i}.wants`, value: member.wants ?? '', label: i === 0 ? 'Wants' : '' })}
                ${textField({ path: `bible.cast.${i}.secret`, value: member.secret ?? '', label: i === 0 ? 'Secret (Director-only)' : '' })}
            </div>`).join('') || '<div class="smarttavern_hint">No cast members.</div>'}
        </div>`;
    }

    html += `
        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-wand-magic-sparkles"></i><span>${story?.bible ? 'Re-craft' : 'Craft'} the story</span></div>
        <div class="smarttavern_bio_field">
            <label title="What kind of story you want — genre, role, flavor">Story seed</label>
            <textarea id="smarttavern_story_seed" class="smarttavern_story_textarea" rows="2"
                placeholder="slow-burn thriller, I'm the new hire at the archive…">${escapeHtml(story?.seed ?? '')}</textarea>
        </div>
        <div class="smarttavern_bio_field">
            <label title="How many chapters the architect writes (3-12)">Chapters</label>
            <input id="smarttavern_story_chapter_count" class="text_margin_input" type="number" min="3" max="12" step="1" value="${chaptersCountFor(story)}">
        </div>
        <div class="smarttavern_row_actions">
            <a id="smarttavern_story_craft" class="menu_button smarttavern_busy_guard" title="One architect call: character + seed + recent chat → a fresh bible"><i class="fa-solid fa-wand-magic-sparkles"></i><span>Craft story</span></a>
        </div>

        <div class="smarttavern_steps_section_title"><i class="fa-solid fa-eye"></i><span>Directive preview — what the reply model will receive next</span></div>
        <pre id="smarttavern_story_preview" class="smarttavern_story_directive"></pre>`;

    $root.html(html);
    refreshStoryPreview();
    autoGrowStoryTextareas();
}

function chaptersCountFor(story) {
    if (story?.bible?.chapters?.length) return story.bible.chapters.length;
    return 5;
}

function refreshStoryPreview() {
    const $preview = $storyRoot().find('#smarttavern_story_preview');
    if (!$preview.length) return;
    const record = previewStoryDirective();
    $preview.text(record?.text || '(no active directive — craft a story and write a beat)');
}

function autoGrowStoryTextareas() {
    $storyRoot().find('.smarttavern_story_textarea').each(function () {
        this.style.height = 'auto';
        this.style.height = `${this.scrollHeight}px`;
    });
}

function refreshStoryStatus() {
    const $status = $storyRoot().find('#smarttavern_story_status');
    if ($status.length) $status.text(statusLine(getStory()));
}

// --------------------------------------------------------------------------------------------
// Wiring (delegated once on the panel root)
// --------------------------------------------------------------------------------------------

export function wireStoryTab($root) {
    if (wired) return;
    wired = true;
    // The panel is built DETACHED from the DOM (see panel.js buildPanel); a document
    // query like $('#smarttavern_panel') matches nothing at that point and would bind
    // no handlers. The caller must pass the panel root it just built.
    const $panel = $root ?? $('#smarttavern_panel');
    if (!$panel.length) {
        wired = false;
        console.warn('[SmartTavern] story tab wiring skipped — panel root not found');
        return;
    }

    $panel.on('input', '.smarttavern_story_field', function () {
        const path = String($(this).data('path') ?? '');
        if (!path) return;
        updateStory(story => setByPath(story, path, String(this.value)));
        refreshStoryPreview();
        refreshStoryStatus();
    });

    $panel.on('input', '.smarttavern_story_textarea', function () {
        this.style.height = 'auto';
        this.style.height = `${this.scrollHeight}px`;
    });

    $panel.on('change', '#smarttavern_story_chapter_pick', function () {
        selectedChapter = Number($(this).val() ?? 0) || 0;
        renderStoryTab();
    });

    $panel.on('click', '#smarttavern_story_craft', async () => {
        const story = getStory();
        if (story) {
            const confirmed = await confirmPopup(
                'Re-craft the story?',
                'This replaces the bible, the current beat and the ledger for this chat.',
            );
            if (!confirmed) return;
        }
        const seed = String($storyRoot().find('#smarttavern_story_seed').val() ?? '').trim();
        const chapterEl = $storyRoot().find('#smarttavern_story_chapter_count').get(0);
        const chapters = chapterEl ? coerceNumber(chapterEl, 5) : 5;
        try {
            await craftStory({ seed, chapters });
        } catch (error) {
            console.error('[SmartTavern] craft story failed', error);
            toastr.error(`Craft story failed — ${error?.message ?? error}`, 'SmartTavern');
        }
        renderStoryTab();
    });

    $panel.on('click', '#smarttavern_story_beat', async () => {
        const note = String($storyRoot().find('#smarttavern_story_note').val() ?? '').trim();
        try {
            const beat = await advanceStory('beat', note);
            if (beat) $storyRoot().find('#smarttavern_story_note').val('');
        } catch (error) {
            console.error('[SmartTavern] next beat failed', error);
            toastr.error(`Next beat failed — ${error?.message ?? error}`, 'SmartTavern');
        }
        renderStoryTab();
    });

    $panel.on('click', '#smarttavern_story_chapter', async () => {
        try {
            await advanceStory('chapter', '');
        } catch (error) {
            console.error('[SmartTavern] next chapter failed', error);
            toastr.error(`Next chapter failed — ${error?.message ?? error}`, 'SmartTavern');
        }
        renderStoryTab();
    });

    $panel.on('click', '#smarttavern_story_reset', async () => {
        const confirmed = await confirmPopup(
            'Reset the story?',
            'The bible, beat and ledger stored in this chat will be deleted.',
        );
        if (!confirmed) return;
        clearStory();
        toastr.info('SmartTavern: story reset.', 'SmartTavern');
        renderStoryTab();
    });
}

/** Re-render hook for panel.js (tab switch, chat change, after Director actions). */
export function renderStoryTabSafe() {
    try {
        renderStoryTab();
    } catch (error) {
        console.error('[SmartTavern] story tab render failed', error);
    }
}

// --------------------------------------------------------------------------------------------
// Slash command runners (/smarttavern-craft, -beat, -chapter, -story)
// --------------------------------------------------------------------------------------------

async function guardBusy() {
    if (isStoryBusy()) {
        toastr.info('The Story Director is already working.', 'SmartTavern');
        return true;
    }
    return false;
}

export async function runStoryCraft(seed = '') {
    if (await guardBusy()) return;
    const story = getStory();
    if (story) {
        const confirmed = await confirmPopup(
            'Re-craft the story?',
            'This replaces the bible, the current beat and the ledger for this chat.',
        );
        if (!confirmed) return;
    }
    try {
        await craftStory({ seed: String(seed ?? '') });
    } catch (error) {
        toastr.error(`Craft story failed — ${error?.message ?? error}`, 'SmartTavern');
    }
    renderStoryTabSafe();
}

export async function runStoryBeat(note = '') {
    if (await guardBusy()) return;
    try {
        await advanceStory('beat', String(note ?? ''));
    } catch (error) {
        toastr.error(`Next beat failed — ${error?.message ?? error}`, 'SmartTavern');
    }
    renderStoryTabSafe();
}

export async function runStoryChapter() {
    if (await guardBusy()) return;
    try {
        await advanceStory('chapter', '');
    } catch (error) {
        toastr.error(`Next chapter failed — ${error?.message ?? error}`, 'SmartTavern');
    }
    renderStoryTabSafe();
}

export async function showStoryDirective() {
    const record = previewStoryDirective();
    const text = record?.text || 'No active story directive — craft a story and write a beat first.';
    const context = getContext();
    const content = document.createElement('div');
    const title = document.createElement('h3');
    title.textContent = `Story directive · ${record?.state ?? 'inactive'}${record?.must ? ' · MUST block active' : ''}`;
    const pre = document.createElement('pre');
    pre.className = 'smarttavern_popup_pre';
    pre.style.maxHeight = '55vh';
    pre.textContent = text;
    content.append(title, pre);
    await context.callGenericPopup(content, context.POPUP_TYPE.TEXT, '', {
        wide: true,
        large: true,
        allowVerticalScrolling: true,
    });
}

export { renderStoryTab };
