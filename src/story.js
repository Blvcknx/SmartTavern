// SmartTavern — Story Director runtime: chat-metadata storage, the two Director LLM
// calls (craft the bible, compile the next beat/chapter) and the generation hooks
// (directive preparation, delivery marking, the idle clock).
//
// The bible, the cast's secrets and the future chapters are Director-only: they appear
// exclusively in the architect/director prompts below. The reply model only ever sees
// the compiled directive (see story-core.compileDirective).
import { getContext } from '../../../../extensions.js';
import {
    log, warn, getSettings, captureChatScope, cardText, chatExcerpt, charKey,
    getStory, setStory, updateStory, clearStory, isPlainObject,
    resolveTargetChar, getStoredProfile, substituteParamsSafe,
} from './state.js';
import { serializeProfile, extractJson } from './profiles.js';
import { generateWithRetry, withInternalGeneration, createGenerationControl, isAbortError, throwIfAborted } from './gen.js';
import { activityStart, activityStatus, activityEntry, activityFail, activityEnd, activitySteps } from './progress.js';
import { agentTurnRequirements } from './agent.js';
import {
    normalizeBible, normalizeChapter, validateBeat, compileDirective, selectRung,
    pushFact, chapterIndexAt, storyCastNames, wordCount, rearmPending,
} from './story-core.js';

// --------------------------------------------------------------------------------------------
// Generation-scoped bookkeeping
// --------------------------------------------------------------------------------------------

let storyBusy = false;
// The directive recorded for the CURRENT generation (reset at every interceptor start):
// `must` drives the built-in enforcement pass, `text` feeds the {{story}} macro.
let lastDirective = null;
// True once a directive was actually injected into this generation's prompt.
let directiveInjected = false;
// Last Director assessment (chapter_done + one line), surfaced in the Story tab.
let lastAssessment = null;

export function hasStory() {
    return Boolean(getStory()?.bible);
}

export function isStoryBusy() {
    return storyBusy;
}

export function recordDirectiveInjection(record) {
    lastDirective = record ?? null;
    directiveInjected = true;
}

export function resetStoryGenerationState() {
    lastDirective = null;
    directiveInjected = false;
}

export function wasDirectiveInjected() {
    return directiveInjected;
}

export function recordedDirective() {
    return lastDirective;
}

export function lastStoryAssessment() {
    return lastAssessment;
}

// --------------------------------------------------------------------------------------------
// Directive compilation (no LLM) and macro context
// --------------------------------------------------------------------------------------------

/** Compiles the directive for the live story with the current settings and names. */
export function compileStoryDirective(story = getStory(), settings = getSettings()) {
    if (!story) return null;
    const context = getContext();
    return compileDirective(story, {
        char: context.name2 || '',
        user: context.name1 || '',
        idleTurns: settings.storyIdleTurns,
        maxWords: settings.storyDirectiveMaxWords,
    });
}

/** Fresh preview for the Story tab / {{story}} when no generation recorded one yet. */
export function previewStoryDirective() {
    const story = getStory();
    return story ? compileStoryDirective(story) : null;
}

/**
 * Story values for SmartTavern macros. `directive` (the record the pipeline just
 * compiled) wins; otherwise the last recorded one; otherwise a fresh preview. NEVER
 * includes secrets, cast secrets or future chapters — {{story}} is the compiled
 * directive text and {{chapter}} the current chapter only.
 */
export function storyMacroContext(directive = null) {
    const story = getStory();
    if (!story?.bible) return null;
    const record = directive ?? lastDirective ?? previewStoryDirective();
    const chapters = story.bible.chapters ?? [];
    const index = chapterIndexAt(story);
    const chapter = index === -1 ? null : chapters[index];
    return {
        text: record?.text ?? '',
        must: record?.must ?? '',
        beat: story.beat?.text ?? '',
        chapter: chapter ? `Chapter ${index + 1}/${chapters.length}: ${chapter.title}${chapter.situation ? ` — ${chapter.situation}` : ''}` : '',
        ledger: (story.ledger ?? []).map(fact => `- ${fact}`).join('\n'),
    };
}

/**
 * Pipeline entry: returns the directive to inject for this generation (or null when
 * the story is inactive). For swipe/regenerate it first re-arms the beat that was
 * delivered in the message being regenerated, so it is injected as PENDING again and
 * delivery is re-confirmed afterwards. Fails open: any error means no directive.
 */
export function prepareStoryDirective({ type = 'normal', mutate = true } = {}) {
    try {
        const settings = getSettings();
        if (settings.enabled === false || settings.storyEnabled === false) return null;
        const story = getStory();
        if (!story?.bible) return null;
        if (mutate && (type === 'swipe' || type === 'regenerate')) {
            const chat = getContext().chat ?? [];
            if (chat.length && rearmPending(story, chat.length - 1)) setStory(story);
        }
        return compileStoryDirective(story, settings);
    } catch (error) {
        warn('story directive compilation failed; continuing without it', error);
        return null;
    }
}

// --------------------------------------------------------------------------------------------
// Enforcement gate + delivery + idle clock
// --------------------------------------------------------------------------------------------
// NOTE: the enforcement gate lives in pipeline.js (turnEnforcementActive) — the
// required-events list spans the story beat AND the thinking agent's musts/rolls.

/**
 * Marks the pending beat delivered: deliveredAtMsg pinned to the reply that carries it,
 * the fact joins the ledger (capped) and the idle clock resets. No-op (false) when the
 * beat is already delivered — escalation rungs never re-push their fact.
 */
export function markStoryBeatDelivered(messageId) {
    const story = getStory();
    if (!story?.beat || story.beat.status !== 'pending') return false;
    story.beat.status = 'delivered';
    story.beat.deliveredAtMsg = Number.isInteger(messageId) ? messageId : null;
    story.beat.rung = 0;
    story.turnsSinceDelivery = 0;
    pushFact(story.ledger, story.beat.fact);
    setStory(story);
    log('story beat delivered');
    return true;
}

/**
 * MESSAGE_RECEIVED hook, next to maybeAutoUpdate. Runs once per completed character
 * reply for which a directive was injected:
 *  - pending beat: deliver optimistically when the built-in enforcement pass will NOT
 *    decide it (refinement or enforcement off); otherwise the pass delivers.
 *  - delivered beat: advance the deterministic idle clock (the rung is derived from it).
 */
export function onStoryCharacterReply(messageId) {
    try {
        const settings = getSettings();
        if (settings.enabled === false || settings.storyEnabled === false) return;
        if (!directiveInjected) return;
        directiveInjected = false; // one delivery decision per injected generation
        const story = getStory();
        if (!story?.beat) return;
        if (story.beat.status === 'pending') {
            // The built-in enforcement pass decides delivery when it will run: it may be
            // triggered by this beat OR by the thinking agent's musts/dice (see
            // pipeline.turnEnforcementActive).
            const agent = agentTurnRequirements();
            const enforceWillRun = settings.refinementEnabled !== false && settings.turnEnforce !== false
                && (Boolean(lastDirective?.must) || agent.must.length > 0 || agent.rolls.length > 0);
            if (!enforceWillRun) markStoryBeatDelivered(messageId);
            return;
        }
        story.turnsSinceDelivery = (Number(story.turnsSinceDelivery) || 0) + 1;
        story.beat.rung = selectRung(story.turnsSinceDelivery, settings.storyIdleTurns);
        setStory(story);
    } catch (error) {
        warn('story reply hook failed', error);
    }
}

// --------------------------------------------------------------------------------------------
// Director prompts
// --------------------------------------------------------------------------------------------

const ARCHITECT_SYSTEM = [
    'You are a story architect for an interactive fiction platform.',
    'You design a compact, high-level story bible: premise, tone, secrets, a small cast with private agendas, and a chapter arc.',
    'Everything must be concrete and observable, never abstract.',
    'Output ONLY the JSON object.',
].join(' ');

const DIRECTOR_SYSTEM = [
    'You are the story director for an interactive fiction platform.',
    'You compile the NEXT CONCRETE STORY EVENT from the story bible and the live conversation.',
    'You are the only one who sees the secrets; you never state them — you plant observable clues instead.',
    'You never decide the player\'s actions, words or feelings.',
    'Output ONLY the JSON object.',
].join(' ');

const CHAPTER_SHAPE = {
    type: 'object',
    properties: {
        title: { type: 'string' },
        situation: { type: 'string' },
        goal: { type: 'string' },
        exit: { type: 'string' },
        clues: { type: 'string' },
    },
    required: ['title', 'situation', 'goal', 'exit'],
    additionalProperties: false,
};

const BIBLE_SCHEMA = {
    name: 'story_bible',
    description: 'High-level story bible for the Story Director',
    strict: false,
    value: {
        type: 'object',
        properties: {
            title: { type: 'string' },
            premise: { type: 'string' },
            setting: { type: 'string' },
            tone: { type: 'string' },
            conflict: { type: 'string' },
            secrets: { type: 'string' },
            cast: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        role: { type: 'string' },
                        wants: { type: 'string' },
                        secret: { type: 'string' },
                    },
                    required: ['name', 'role', 'wants', 'secret'],
                    additionalProperties: false,
                },
            },
            chapters: { type: 'array', items: CHAPTER_SHAPE },
        },
        required: ['title', 'premise', 'setting', 'tone', 'conflict', 'secrets', 'cast', 'chapters'],
        additionalProperties: false,
    },
};

function beatJsonSchema({ withNewChapters = false, withOpening = false } = {}) {
    const properties = {
        beat: {
            type: 'object',
            properties: {
                text: { type: 'string' },
                escalations: { type: 'array', items: { type: 'string' } },
                fact: { type: 'string' },
            },
            required: ['text', 'escalations', 'fact'],
            additionalProperties: false,
        },
        chapter_done: { type: 'boolean' },
        assessment: { type: 'string' },
        closing_fact: { type: 'string' },
    };
    const required = ['beat', 'chapter_done', 'assessment'];
    if (withOpening) {
        properties.opening = { type: 'string' };
        required.push('opening', 'closing_fact');
    }
    if (withNewChapters) {
        properties.new_chapters = { type: 'array', items: CHAPTER_SHAPE };
        required.push('new_chapters');
    }
    return {
        name: 'story_beat',
        description: 'The next story beat compiled by the Story Director',
        strict: false,
        value: { type: 'object', properties, required, additionalProperties: false },
    };
}

function biblePromptText({ char, seed, chapterCount, definitions, excerpt }) {
    return substituteParamsSafe([
        'Character card:',
        cardText(char) || '(empty)',
        '',
        'Living profile of the character (root the secrets, stakes and levers in the Background, Fears, Aspirations and Values):',
        definitions || '(none stored)',
        '',
        'Recent conversation excerpt:',
        excerpt || '(none yet)',
        '',
        'Player\'s seed for the story:',
        String(seed ?? '').trim() || '(no seed given — invent something that fits the character)',
        '',
        `Write the story bible for an interactive story starring this character opposite {{user}}. Requirements:`,
        '- title, premise (2-3 sentences), setting, tone, conflict: concise and vivid.',
        '- secrets: the story-level secrets the player must never be told directly — they leak only through clues.',
        '- cast: 2-5 named characters ({name, role, wants, secret}) with their own agendas; nobody who merely serves exposition.',
        `- chapters: exactly ${chapterCount} chapters that vary in type — escalation, reversal, quiet/intimate, revelation, climax — in a sensible order ending in a climax.`,
        '  Each chapter: title; situation (ONE concrete sentence of what is happening on stage); goal (what the chapter is about for the characters); exit (an OBSERVABLE event that ends it — an arrival, an object changing hands, a line said — never a feeling); clues (observable clues that can plant this chapter\'s secrets).',
        '- Root the secrets, stakes and levers in the character\'s Background, Fears, Aspirations and Values above.',
        '- Never write actions, words or feelings for {{user}}.',
        'Return a single JSON object with exactly these keys: title, premise, setting, tone, conflict, secrets, cast, chapters.',
    ].join('\n'));
}

function directorPromptText(story, { mode, note, isLast, excerpt, withOpening = false }) {
    const chapters = story.bible.chapters;
    const index = chapterIndexAt(story);
    const chapter = chapters[index];
    const cast = story.bible.cast.map(member => `- ${member.name} (${member.role || '?'}): wants ${member.wants || '?'}; secret: ${member.secret || '(none)'}`).join('\n') || '(no cast)';
    const ledger = (story.ledger ?? []).map(fact => `- ${fact}`).join('\n') || '(empty)';
    const lines = [
        'Story bible (DIRECTOR-ONLY — the player and the reply model never see it; never quote secrets in the beat):',
        `title: ${story.bible.title}`,
        `premise: ${story.bible.premise}`,
        `setting: ${story.bible.setting}`,
        `tone: ${story.bible.tone}`,
        `conflict: ${story.bible.conflict}`,
        `secrets: ${story.bible.secrets || '(none)'}`,
        '',
        'Cast:',
        cast,
        '',
        `Current chapter ${index + 1}/${chapters.length} — ${chapter?.title ?? 'Untitled'}:`,
        `situation: ${chapter?.situation ?? ''}`,
        `goal: ${chapter?.goal ?? ''}`,
        `exit condition (observable event): ${chapter?.exit ?? ''}`,
        `clues available: ${chapter?.clues ?? ''}`,
        `Upcoming chapters: ${JSON.stringify(chapters.slice(index + 1))}`,
        '',
        'Ledger of established facts:',
        ledger,
        '',
        'Recent conversation:',
        excerpt || '(none yet)',
    ];
    if (String(note ?? '').trim()) {
        lines.push('', `Steering note from the player (respect it): ${String(note).trim()}`);
    }
    lines.push(
        '',
        'Return one JSON object with a nested "beat": {"text": string, "escalations": [string, string], "fact": string}, plus top-level "chapter_done" (boolean) and "assessment" (string).',
        `The beat text must explicitly name at least one cast member: ${story.bible.cast.map(member => member.name).join(', ') || '(no cast-name requirement)'}.`,
        '- "beat.text": ONE concrete observable event involving a named cast member — an arrival, an object, a line of dialogue, a discovery. 1-2 sentences, at most 45 words. No abstractions ("tension rises" is invalid). It must not state any secret (plant a clue instead). It must never decide {{user}}\'s actions or feelings.',
        '- "beat.escalations": exactly two strings — harder fallback versions of the same event for when the player idles.',
        '- "beat.fact": at most 15 words, past tense, what will be true once the beat has happened.',
        '- "chapter_done": true only if the chapter\'s exit condition is observably met in the conversation above.',
        '- "assessment": one line on where the story stands.',
    );
    if (mode === 'chapter') {
        lines.push(
            '',
            'You are also CLOSING the current chapter:',
            '- "closing_fact": at most 15 words, past tense, the established outcome of the current chapter.',
            '- Then compile the opening beat of the NEXT chapter as "beat".',
        );
        if (withOpening) {
            lines.push(
                'CHAPTER END: also return "opening", a complete player-facing opening message for the NEXT chapter, like a character greeting (roughly 150-300 words).',
                'Set a fresh playable situation: establish where and when, the tone, what has happened or is happening, and an immediate invitation or problem the player can respond to. Use narration and character dialogue consistent with the recent chat. Show the opening beat in this message.',
                'Bridge from established events without deciding the player\'s actions, words, feelings or choices. Do not reveal private secrets, future plans, JSON, or Director commentary. Do not claim unplayed player decisions occurred during a time skip.',
            );
        }
        if (isLast) {
            lines.push(
                '',
                'This is the LAST chapter: do not dead-end. Also return "new_chapters": exactly 3 new chapters (a sequel arc grounded in the ledger and the bible\'s conflict), same shape as bible chapters.',
            );
        }
    }
    return substituteParamsSafe(lines.join('\n'));
}

/**
 * Normalize a Director response and explain every validation failure for repair.
 */
function parseDirectorPayload(raw, { wantsChapters = false, castNames = [], withOpening = false } = {}) {
    const obj = extractJson(raw);
    if (!isPlainObject(obj)) return { payload: null, issues: ['Response must contain a valid JSON object.'] };
    if (!isPlainObject(obj.beat)) return { payload: null, issues: ['beat must be a nested object containing text, escalations and fact.'] };
    const beat = {
        text: String(obj.beat.text ?? '').trim(),
        escalations: (Array.isArray(obj.beat.escalations) ? obj.beat.escalations : [])
            .map(e => String(e ?? '').trim()).filter(Boolean),
        fact: String(obj.beat.fact ?? '').trim(),
    };
    const issues = validateBeat(beat, { castNames }).map(issue => `beat: ${issue}`);
    const payload = {
        beat,
        chapter_done: obj.chapter_done === true,
        assessment: String(obj.assessment ?? '').trim(),
        closing_fact: String(obj.closing_fact ?? '').trim(),
        opening: typeof obj.opening === 'string' ? obj.opening.trim() : '',
    };
    if (typeof obj.chapter_done !== 'boolean') issues.push('chapter_done must be a boolean.');
    if (!payload.assessment) issues.push('assessment must be a non-empty string.');
    if (withOpening && !payload.opening) issues.push('opening must be a non-empty player-facing opening message.');
    if (withOpening && !payload.closing_fact) issues.push('closing_fact must be a non-empty established outcome.');
    if (wantsChapters) {
        const chapters = (Array.isArray(obj.new_chapters) ? obj.new_chapters : [])
            .map(normalizeChapter).filter(Boolean);
        if (!chapters.length) issues.push('new_chapters must contain usable sequel chapters.');
        payload.new_chapters = chapters;
    }
    return { payload: issues.length ? null : payload, issues };
}

// --------------------------------------------------------------------------------------------
// Director actions (one LLM call each, HUD-wrapped, abortable, chat-scope checked)
// --------------------------------------------------------------------------------------------

/**
 * Craft story: one architect call that turns the character (+ living profile, recent
 * chat, the player's seed) into a fresh bible. Replaces any existing story for this chat.
 */
export async function craftStory({ seed = '', chapters = null } = {}) {
    if (storyBusy) {
        toastr.info('The Story Director is already working.', 'SmartTavern');
        return null;
    }
    const settings = getSettings();
    const context = getContext();
    const chat = context.chat ?? [];
    const char = resolveTargetChar(chat);
    if (!char) throw new Error('No character to build the story from');
    const isCurrentChat = captureChatScope();
    const control = createGenerationControl();
    storyBusy = true;
    try {
        activityStart({ status: `Crafting story · ${char.name}` });
        activitySteps({ names: [] }); // Director runs have no passes — clear stale chips
        const chapterCount = Math.max(3, Math.min(12, Math.round(Number(chapters)) || 5));
        const definitions = serializeProfile(getStoredProfile(charKey(char)), settings.fields ?? []);
        const excerpt = chatExcerpt(chat, settings.profileUpdateLookback);
        const prompt = biblePromptText({ char, seed, chapterCount, definitions, excerpt });
        activityStatus('Story architect · writing the bible');
        const result = await withInternalGeneration(() => generateWithRetry({
            signal: control.signal,
            profileId: settings.storyProfileId || '',
            systemPrompt: ARCHITECT_SYSTEM,
            prompt,
            maxTokens: settings.stepMaxTokens,
            jsonSchema: BIBLE_SCHEMA,
            validate: (res) => normalizeBible(extractJson(String(res?.content ?? ''))) !== null,
        }));
        throwIfAborted(control.signal);
        const raw = String(result?.content ?? '');
        activityEntry({ title: `Bible payload · ${raw.length} chars`, tone: 'info', text: raw });
        const bible = normalizeBible(extractJson(raw));
        if (!bible) throw new Error('The model did not return a usable story bible');
        if (!isCurrentChat()) {
            activityEnd({ ok: true, summary: 'Story result discarded — chat changed' });
            return null;
        }
        setStory({
            v: 1,
            bible,
            chapterIndex: 0,
            beat: null,
            ledger: [],
            turnsSinceDelivery: 0,
            seed: String(seed ?? ''),
            createdAt: Date.now(),
        });
        lastAssessment = null;
        log(`story bible crafted (${bible.chapters.length} chapters, ${bible.cast.length} cast members)`);
        toastr.success(`Story crafted: ${bible.title} — ${bible.chapters.length} chapters. Use "Next beat" to put the first event on the page.`, 'SmartTavern');
        activityEnd({ ok: true, summary: `Story crafted · ${bible.title}` });
        return bible;
    } catch (error) {
        if (isAbortError(error)) {
            activityEnd({ ok: true, summary: 'Story crafting cancelled' });
            return null;
        }
        activityFail(`Craft story failed — ${error?.message ?? error}`);
        activityEnd({ ok: false, summary: 'Story crafting failed' });
        throw error;
    } finally {
        control.dispose();
        storyBusy = false;
    }
}

/**
 * Next beat / Next chapter: one director call that sees the live chat and returns the
 * next concrete event (plus, for chapters, the closing fact and — on the last chapter —
 * a 3-chapter sequel arc instead of a dead end). Both modes reset the idle clock.
 */
export async function advanceStory(mode = 'beat', note = '') {
    const withOpening = mode === 'chapter-end';
    if (withOpening) mode = 'chapter';
    if (storyBusy) {
        toastr.info('The Story Director is already working.', 'SmartTavern');
        return null;
    }
    const story = getStory();
    if (!story?.bible) {
        toastr.warning('No story for this chat yet — use "Craft story" first.', 'SmartTavern');
        return null;
    }
    const settings = getSettings();
    const context = getContext();
    const isCurrentChat = captureChatScope();
    const control = createGenerationControl();
    const label = withOpening ? 'Chapter End' : mode === 'chapter' ? 'Next chapter' : 'Next beat';
    storyBusy = true;
    try {
        activityStart({ status: `Story Director · ${label}` });
        activitySteps({ names: [] });
        const chapters = story.bible.chapters;
        const index = chapterIndexAt(story);
        const isLast = index >= chapters.length - 1;
        const wantsChapters = mode === 'chapter' && isLast;
        const excerpt = chatExcerpt(context.chat ?? [], settings.chatLookback);
        const prompt = directorPromptText(story, { mode, note, isLast, excerpt, withOpening });
        const castNames = storyCastNames(story);
        activityStatus(`Story director · ${label}`);
        const result = await withInternalGeneration(() => generateWithRetry({
            signal: control.signal,
            profileId: settings.storyProfileId || '',
            systemPrompt: DIRECTOR_SYSTEM,
            prompt,
            maxTokens: settings.stepMaxTokens,
            jsonSchema: beatJsonSchema({ withNewChapters: wantsChapters, withOpening }),
            validationIssues: (res) => parseDirectorPayload(String(res?.content ?? ''), { wantsChapters, castNames, withOpening }).issues,
        }));
        throwIfAborted(control.signal);
        const raw = String(result?.content ?? '');
        const { payload } = parseDirectorPayload(raw, { wantsChapters, castNames, withOpening });
        if (!payload) throw new Error('The model did not return a usable beat');
        if (!isCurrentChat() || getStory() !== story) {
            activityEnd({ ok: true, summary: 'Story result discarded — chat changed' });
            return null;
        }

        if (mode === 'chapter') {
            const closingFact = payload.closing_fact.trim() || `Chapter "${chapters[index].title}" ended.`;
            pushFact(story.ledger, closingFact);
            if (wantsChapters && payload.new_chapters.length) {
                story.bible.chapters.push(...payload.new_chapters);
            }
            story.chapterIndex = Math.min(index + 1, story.bible.chapters.length - 1);
        }
        story.beat = {
            text: payload.beat.text,
            escalations: payload.beat.escalations.slice(0, 2),
            fact: payload.beat.fact,
            status: 'pending',
            rung: 0,
            deliveredAtMsg: null,
        };
        story.turnsSinceDelivery = 0;
        if (withOpening) {
            const message = {
                name: context.name2 || resolveTargetChar(context.chat)?.name || 'Narrator',
                is_user: false,
                is_system: false,
                send_date: new Date().toISOString(),
                mes: payload.opening,
                extra: { smarttavernChapterOpening: true, smarttavernRefined: true },
                swipe_id: 0,
                swipes: [payload.opening],
            };
            const messageId = context.chat.length;
            context.chat.push(message);
            story.beat.status = 'delivered';
            story.beat.deliveredAtMsg = messageId;
            pushFact(story.ledger, story.beat.fact);
            setStory(story);
            resetStoryGenerationState();
            const events = context.event_types ?? context.eventTypes;
            context.addOneMessage(message);
            await context.saveChat();
            if (isCurrentChat()) {
                await context.eventSource.emit(events.MESSAGE_RECEIVED, messageId, 'chapter_opening');
                if (isCurrentChat()) await context.eventSource.emit(events.CHARACTER_MESSAGE_RENDERED, messageId, 'first_message');
            }
        }
        else setStory(story);
        if (!isCurrentChat()) {
            activityEnd({ ok: true, summary: 'Chapter opening saved' });
            return null;
        }
        lastAssessment = { text: payload.assessment, chapterDone: payload.chapter_done, at: Date.now() };
        activityEntry({
            title: `${label} · ${wordCount(payload.beat.text)} words`,
            tone: 'ok',
            text: [payload.beat.text, '', 'escalations:', ...payload.beat.escalations.map(e => `- ${e}`), '', `fact: ${payload.beat.fact}`, payload.assessment].filter(Boolean).join('\n'),
        });
        log(`story ${mode} written (chapter ${chapterIndexAt(story) + 1}/${story.bible.chapters.length})`);
        if (payload.chapter_done) {
            toastr.info('Exit condition looks met — consider "Next chapter".', 'SmartTavern', { timeOut: 12000 });
        } else if (payload.assessment) {
            toastr.info(payload.assessment, 'SmartTavern', { timeOut: 8000 });
        }
        activityEnd({ ok: true, summary: `Story · ${label} ready` });
        return story.beat;
    } catch (error) {
        if (isAbortError(error)) {
            activityEnd({ ok: true, summary: 'Story Director cancelled' });
            return null;
        }
        activityFail(`Story ${label} failed — ${error?.message ?? error}`);
        activityEnd({ ok: false, summary: 'Story Director failed' });
        throw error;
    } finally {
        control.dispose();
        storyBusy = false;
    }
}
