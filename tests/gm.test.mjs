// Run: node --experimental-vm-modules --test tests/gm.test.mjs
// GM engine behind the real pipeline: tick after a reply, send-time use, fallbacks, safety.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SourceTextModule, createContext } from 'node:vm';

async function harness(settings = {}, respond = async () => ({ content: '' }), { onPopup = () => 0, realStory = false, chatMetadata = {}, ui = false } = {}) {
    const requests = [];
    const savedChat = [{ is_user: true, name: 'User', mes: 'Hello' }];
    const listeners = new Map();
    const context = {
        POPUP_TYPE: { CONFIRM: 1, TEXT: 2, INPUT: 3 }, POPUP_RESULT: { AFFIRMATIVE: 1, CANCELLED: 0, CUSTOM1: 1001 },
        Popup: class {
            constructor(content, _type, _input, options) { this.content = content; this.options = options; context.popups.push(this); }
            show() { return new Promise(resolve => { this.resolve = resolve; Promise.resolve(onPopup(this)).then(result => { if (result !== undefined) this.complete(result); }); }); }
            complete(result) { this.result = result; this.resolve?.(this.value ?? result); }
        },
        popups: [],
        event_types: { GENERATION_STOPPED: 'stop', CHAT_CHANGED: 'chat', MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
        eventSource: {
            on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
            removeListener(type, fn) { listeners.get(type)?.delete(fn); },
            emit(type, ...args) { for (const fn of [...(listeners.get(type) ?? [])]) fn(...args); },
        },
        extensionSettings: {
            smarttavern: {
                agentEngine: 'gm', agentProfileId: 'model', genRetries: 0, bootstrapOnFirstMessage: false, promptTailVersion: 1,
                injectAnchor: 'before-last-user', expansionEnabled: false, sceneTrackerEnabled: false, steps: [], gmWaitMs: 300,
                ...settings,
            },
            connectionManager: { profiles: [{ id: 'model', mode: 'cc', api: 'openai' }, { id: 'nofunctions', mode: 'cc', api: 'perplexity' }] },
        },
        CONNECT_API_MAP: { openai: { selected: 'openai', source: 'openai' }, claude: { selected: 'openai', source: 'claude' }, perplexity: { selected: 'openai', source: 'perplexity' } },
        chat: savedChat, chatMetadata, characterId: 0, chatId: 'test-chat', activityEntries: [], activityEnds: [], activityStatuses: [],
        characters: [{ name: 'Alice', avatar: 'alice.png', description: 'A guarded innkeeper.' }], name1: 'User', name2: 'Alice',
        saveSettingsDebounced() {}, substituteParams: text => text,
        saveMetadata() {}, saveMetadataDebounced() {}, saveChat: async () => {}, updateMessageBlock() {}, addOneMessage() {},
        mainApi: 'openai', chatCompletionSettings: { chat_completion_source: 'openai' }, getChatCompletionModel: () => 'active-model',
        ChatCompletionService: { async processRequest(payload, options, extract, signal) {
            return { content: await context.generateRaw({ prompt: payload.messages, responseLength: payload.max_tokens, signal }) };
        } },
        ConnectionManagerRequestService: { async sendRequest(id, messages, maxTokens, custom, overrides) {
            requests.push({ id, messages, maxTokens, signal: custom?.signal, custom, overrides, text: messages.map(message => message.content).join('\n') });
            return respond(messages, requests.length, overrides, custom);
        } },
        getRequestHeaders: () => ({ 'X-CSRF-Token': 'token' }),
        fetchImpl: async () => { throw new TypeError('Failed to fetch'); },
        generateRaw: async options => { requests.push(options); return 'ACTIVE OUTPUT'; },
    };
    const sandbox = createContext({ context, AbortController, DOMException, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto,
        console: { log() {}, warn() {} }, fetch: (...args) => context.fetchImpl(...args), toastr: { warning() {}, info() {}, success() {} },
        document: { dispatchEvent() {}, createElement(tagName) { return {
            tagName, children: [], handlers: {}, attributes: {},
            append(...children) { this.children.push(...children); },
            setAttribute(name, value) { this.attributes[name] = value; },
            addEventListener(type, handler) { this.handlers[type] = handler; },
        }; } }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
    const sources = {
        extensions: 'export const getContext = () => context;',
        'system-messages': "export const system_message_types = { NARRATOR: 'narrator' };",
        'instruct-mode': `export const formatInstructModeChat = (name, text) => text; export const formatInstructModePrompt = () => '';`,
        progress: 'export const activityStart = () => {}; export const activityStatus = status => { context.activityStatuses.push(status); }; export const activityEntry = entry => { context.activityEntries.push(entry); }; export const activityFail = () => {}; export const activityEnd = options => { context.activityEnds.push(options); }; export const activitySteps = () => {}; export const activityStepState = () => {}; export const activityRefinementControls = () => {}; export const activityAgentControls = () => {};',
        veil: 'export const applyVeil = () => false; export const setVeilStep = () => {}; export const setVeilStatus = () => {}; export const revealVeil = () => {}; export const dismissVeil = () => {}; export const dismissAllVeils = () => {}; export const disarmPreVeil = () => {}; export const armPreVeil = () => {};',
        'world-info': `
            export const world_names = ['Existing']; export const selected_world_info = []; export const world_info = {}; export const METADATA_KEY = 'world_info';
            export const loadWorldInfo = async () => ({ entries: {} }); export const saveWorldInfo = async () => {};
            export const createNewWorldInfo = async name => { world_names.push(name); return true; };
            export const createWorldInfoEntry = (_name, data) => { let uid = 0; while (data.entries[uid]) uid++; return data.entries[uid] = { uid, key: [], comment: '', content: '' }; };
            export const deleteWorldInfoEntry = async () => true;`,
    };
    if (!realStory) {
        sources.story = 'export const previewStoryDirective = () => null; export const prepareStoryDirective = () => null; export const storyMacroContext = value => value; export const recordedDirective = () => null; export const compileStoryDirective = () => null; export const hasStory = () => false; export const markStoryBeatDelivered = () => false; export const recordDirectiveInjection = () => {}; export const resetStoryGenerationState = () => {};';
    }
    if (ui) sources.panel = 'export const profileOptionsHtml = id => `<option value="${id}"></option>`;';
    const real = [...(ui ? ['gm-ui'] : []), 'mcp', 'mcp-core', 'pipeline', 'state', 'gen', 'native-core', 'tail', 'description', 'profiles', 'refinement-checks', 'refinement-edits', 'agent-core', 'planner', 'planner-core', 'lean-core',
        'user-context', 'narration', 'scene-core', 'scene', 'agent', 'agent-tools', 'rulings', 'ruling-core', 'gm-core', 'gm', ...(realStory ? ['story', 'story-core'] : [])];
    for (const name of real) sources[name] = await readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8');
    const modules = new Map();
    for (const [name, source] of Object.entries(sources)) modules.set(name, new SourceTextModule(source, { context: sandbox }));
    const link = specifier => modules.get(specifier.split('/').at(-1).replace('.js', ''));
    for (const name of ['pipeline', 'narration', 'mcp', ...(ui ? ['gm-ui'] : [])]) { await modules.get(name).link(link); await modules.get(name).evaluate(); }
    const state = modules.get('state').namespace;
    state.loadSettings();
    const ns = name => modules.get(name).namespace;
    return { pipeline: ns('pipeline'), gm: ns('gm'), gmCore: ns('gm-core'), agent: ns('agent'), state, context, requests, savedChat, listeners,
        scene: ns('scene'), tools: ns('agent-tools'), mcp: ns('mcp'), mcpCore: ns('mcp-core'), ui: ui ? ns('gm-ui') : null };
}

const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const reply = (h, text = 'Alice opens the door a crack.') => { const message = { name: 'Alice', mes: text }; h.savedChat.push(message); return message; };
const userSays = (h, text = 'I step inside.') => { const message = { is_user: true, name: 'User', mes: text }; h.savedChat.push(message); return message; };
const BRIEF = 'Voss tightens the net around the inn.';
const GM_OUT = `<brief>${BRIEF}</brief><must>A bell tolls from the harbor</must><branch if="the player flees">Scouts spot the player on the roof</branch><branch if="the player fights">The inn door splinters</branch>`;
const isTick = text => text.includes('[TOOLS AVAILABLE THIS TURN]');
const isFit = text => text.includes('routing checker');
const isPlanner = text => text.includes('expansion prompts');

/** Routes each internal call to a canned answer (functions receive the full prompt text). */
function router({ tick = GM_OUT, fit = '<use>1</use>', planner = 'NO ADDITIONS' } = {}) {
    const calls = { tick: 0, fit: 0, planner: 0, step: 0 };
    const answer = async (messages) => {
        const text = messages.map(message => message.content).join('\n');
        const pick = (value, key) => ({ content: typeof value === 'function' ? value(text, ++calls[key]) : (++calls[key], value) });
        if (isFit(text)) return pick(fit, 'fit');
        if (isTick(text)) return pick(tick, 'tick');
        if (isPlanner(text)) return pick(planner, 'planner');
        return pick('Step output.', 'step');
    };
    answer.calls = calls;
    return answer;
}

const tickAfter = async (h, text) => { const message = reply(h, text); await h.gm.maybeRunGmTick(message); return message; };
// VM-realm objects fail strict deepEqual against test-realm literals: compare plain copies.
const plain = value => JSON.parse(JSON.stringify(value));
const prepared = h => h.gm.getGmStore({ create: false }).prepared;
const sendTurn = (h, options = {}) => h.pipeline.runPipeline({ chat: [...h.savedChat], ...options });

test('a tick after a reply stores an anchored prepared brief and records code-owned fields', async () => {
    const respond = router();
    const h = await harness({}, respond);
    const message = await tickAfter(h);
    const brief = prepared(h);
    assert.equal(respond.calls.tick, 1);
    assert.equal(brief.anchorIndex, 1);
    assert.equal(brief.anchorText, message.mes);
    assert.equal(brief.brief, BRIEF);
    assert.deepEqual(plain(brief.musts), ['A bell tolls from the harbor']);
    assert.deepEqual(plain(brief.branches.map(branch => branch.if)), ['the player flees', 'the player fights']);
    assert.deepEqual(plain(brief.rolls), []);
    assert.equal(brief.fields, null);
    assert.ok(brief.createdAt > 0);
    const store = h.gm.getGmStore({ create: false });
    assert.equal(store.tick, 1);
    assert.ok(store.transcript.length > 0);
    assert.equal(store.status.ok, true);
    assert.equal(h.gm.isGmBusy(), false);
    // The tick prompt carries the card, the contract and the last reply.
    const prompt = h.requests[0].text;
    assert.match(prompt, /A guarded innkeeper/);
    assert.match(prompt, /FINAL OUTPUT FORMAT/);
    assert.match(prompt, /Alice opens the door a crack/);
});

test('send time injects the prepared brief and its musts reach the enforcement list', async () => {
    const h = await harness({}, router({ fit: '<use>1</use>' }));
    await tickAfter(h);
    userSays(h, 'I run for the roof.');
    const before = h.requests.length;
    const result = await sendTurn(h);
    assert.match(result.injectionText, /\[TURN BRIEF/);
    assert.ok(result.injectionText.includes(BRIEF));
    assert.ok(result.injectionText.includes('A bell tolls from the harbor'));
    // Branch 1 was chosen by the (mocked) fit check; branch 2 never reaches the writer.
    assert.ok(result.injectionText.includes('Scouts spot the player on the roof'));
    assert.equal(result.injectionText.includes('The inn door splinters'), false);
    assert.equal(h.requests.length - before, 1); // exactly one extra call: the fit check
    assert.equal(h.agent.getTurnBrief(), result.brief);
    const must = h.pipeline.turnMustList();
    assert.ok(must.includes('A bell tolls from the harbor'));
    assert.ok(must.includes('Scouts spot the player on the roof'));
    assert.equal(result.gm.used, true);
    assert.deepEqual(plain(result.gm.chosen.map(branch => branch.if)), ['the player flees']);
    assert.equal(result.planner.gm, true);
});

test('fit check: none, garbage and failure all fall back to the general brief', async () => {
    for (const fit of ['<use>none</use>', 'whatever it says', () => { throw new Error('fit model offline'); }]) {
        const h = await harness({}, async (messages) => {
            const text = messages.map(message => message.content).join('\n');
            if (isFit(text)) { if (typeof fit === 'function') fit(); return { content: fit }; }
            return { content: GM_OUT };
        });
        await tickAfter(h);
        userSays(h);
        const result = await sendTurn(h);
        assert.ok(result.injectionText.includes(BRIEF), String(fit));
        assert.ok(result.injectionText.includes('A bell tolls from the harbor'));
        assert.equal(result.injectionText.includes('Scouts spot'), false);
        assert.equal(result.injectionText.includes('The inn door splinters'), false);
        assert.equal(result.gm.used, true);
    }
});

test('fit check uses its own profile and a 256 token budget; no branches means no call', async () => {
    const respond = router({ tick: `<brief>${BRIEF}</brief>` });
    const h = await harness({ gmFitProfileId: 'model' }, respond);
    h.context.extensionSettings.connectionManager.profiles.push({ id: 'fit', mode: 'cc' });
    await tickAfter(h);
    userSays(h);
    const before = h.requests.length;
    await sendTurn(h);
    assert.equal(h.requests.length, before);
    const withBranches = await harness({ gmFitProfileId: 'fit' }, router());
    withBranches.context.extensionSettings.connectionManager.profiles.push({ id: 'fit', mode: 'cc' });
    await tickAfter(withBranches);
    userSays(withBranches);
    await sendTurn(withBranches);
    const fit = withBranches.requests.at(-1);
    assert.equal(fit.id, 'fit');
    assert.equal(fit.maxTokens, 256);
});

test('no prepared brief falls back to the planner exactly as for the planner engine', async () => {
    const respond = router({ planner: '## Expansion: Motives\nWhat does Voss want?' });
    const h = await harness({ expansionEnabled: true, steps: [{ name: 'Base', prompt: 'Assess the scene.', role: 'assistant', profileId: 'model', enabled: true }] }, respond);
    userSays(h);
    const result = await sendTurn(h);
    assert.equal(respond.calls.planner, 1);
    assert.equal(result.gm.used, false);
    assert.match(result.gm.reason, /no prepared brief/);
    assert.ok(result.planner.additions.some(block => block.name === 'Motives'));
    assert.equal(result.agentRan, false);
    assert.equal(h.agent.getTurnBrief(), '');
});

test('an edited anchor invalidates the brief and the planner runs', async () => {
    const respond = router();
    const h = await harness({ expansionEnabled: true, steps: [{ name: 'Base', prompt: 'Assess.', role: 'assistant', profileId: 'model', enabled: true }] }, respond);
    const message = await tickAfter(h);
    message.mes = 'Alice opens the door wide.';
    userSays(h);
    const result = await sendTurn(h);
    assert.equal(result.gm.used, false);
    assert.match(result.gm.reason, /no longer matches/);
    assert.equal(respond.calls.planner, 1);
    assert.equal(result.injectionText.includes(BRIEF), false);
    assert.equal(h.pipeline.turnMustList().includes('A bell tolls from the harbor'), false);
});

test('a newer reply supersedes the brief; swipes of the NEXT reply reuse it and re-run the fit check', async () => {
    const respond = router();
    const h = await harness({}, respond);
    await tickAfter(h);
    userSays(h, 'I run.');
    const second = reply(h, 'Voss shouts after you.');
    // Swipe of the next reply: the interceptor's copy lacks it; the brief is reused.
    const interceptorChat = h.savedChat.slice(0, -1);
    const dice = JSON.stringify(prepared(h).rolls);
    const swiped = await h.pipeline.runPipeline({ chat: [...interceptorChat], type: 'swipe' });
    assert.equal(swiped.gm.used, true);
    assert.ok(swiped.injectionText.includes(BRIEF));
    assert.equal(respond.calls.fit, 1);
    const again = await h.pipeline.runPipeline({ chat: [...interceptorChat], type: 'regenerate' });
    assert.equal(again.gm.used, true);
    assert.equal(respond.calls.fit, 2); // the cheap check runs every time; the dice are as rolled
    assert.equal(JSON.stringify(prepared(h).rolls), dice);
    // A NORMAL send after the second reply is a newer turn: the old brief no longer applies.
    userSays(h, 'Next.');
    const next = await sendTurn(h);
    assert.equal(next.gm.used, false);
    assert.equal(second.mes, 'Voss shouts after you.');
});

test('in real use every reply gets its own tick: swipes of the newest reply still find the brief written for it', async () => {
    const respond = router({ tick: (_text, call) => `<brief>${call === 1 ? 'Brief for the turn after A' : 'Brief for the turn after B'}</brief><must>${call === 1 ? 'Must A' : 'Must B'}</must>`, fit: '<use>none</use>' });
    const h = await harness({}, respond);
    await tickAfter(h, 'reply A');
    userSays(h, 'I answer.');
    const first = await sendTurn(h);
    assert.ok(first.injectionText.includes('Brief for the turn after A'));
    await tickAfter(h, 'reply B'); // the background tick for B replaces the stored brief
    assert.equal(prepared(h).brief, 'Brief for the turn after B');
    // Swipe / regenerate of reply B: B is the generation target, so the brief written for A is reused.
    const interceptorChat = h.savedChat.slice(0, -1);
    for (const type of ['swipe', 'regenerate']) {
        const redo = await h.pipeline.runPipeline({ chat: [...interceptorChat], type });
        assert.equal(redo.gm.used, true, type);
        assert.ok(redo.injectionText.includes('Brief for the turn after A'), type);
        assert.equal(redo.injectionText.includes('Brief for the turn after B'), false, type);
    }
    // The swipe finished: a tick for the swiped text must not lose A's brief for further swipes.
    h.savedChat.at(-1).mes = 'reply B, swiped';
    await h.gm.maybeRunGmTick(h.savedChat.at(-1));
    const again = await h.pipeline.runPipeline({ chat: [...interceptorChat], type: 'swipe' });
    assert.ok(again.injectionText.includes('Brief for the turn after A'));
    // The next real turn uses B's (re-ticked) brief.
    userSays(h, 'Onward.');
    const next = await sendTurn(h);
    assert.equal(next.gm.used, true);
    assert.ok(next.injectionText.includes('Brief for the turn after B'));
});

test('a swipe of the anchor itself never uses the brief prepared for what follows it', async () => {
    const h = await harness({}, router());
    await tickAfter(h);
    // Chat ends with the anchor; ST pops it from the interceptor's copy for the swipe.
    const result = await h.pipeline.runPipeline({ chat: h.savedChat.slice(0, -1), type: 'swipe' });
    assert.equal(result?.gm?.used ?? false, false);
});

test('gmWaitMs: send time waits for a running tick and uses its result', async () => {
    const gate = deferred();
    const h = await harness({ gmWaitMs: 5000 }, async (messages) => {
        const text = messages.map(message => message.content).join('\n');
        if (isFit(text)) return { content: '<use>none</use>' };
        await gate.promise;
        return { content: GM_OUT };
    });
    const message = reply(h);
    const tick = h.gm.maybeRunGmTick(message);
    assert.equal(h.gm.isGmBusy(), true);
    userSays(h);
    const sending = sendTurn(h);
    await new Promise(resolve => setTimeout(resolve, 30));
    assert.ok(h.context.activityStatuses.includes('Waiting for the GM…'));
    gate.resolve();
    const result = await sending;
    await tick;
    assert.equal(result.gm.used, true);
    assert.equal(result.gm.waited, true);
    assert.ok(result.injectionText.includes(BRIEF));
});

test('gmWaitMs: a tick that outlasts the wait is cancelled and the planner takes over', async () => {
    const gate = deferred();
    const h = await harness({ gmWaitMs: 40, expansionEnabled: true, steps: [{ name: 'Base', prompt: 'Assess.', role: 'assistant', profileId: 'model', enabled: true }] }, async (messages) => {
        const text = messages.map(message => message.content).join('\n');
        if (isTick(text)) { await gate.promise; return { content: GM_OUT }; }
        return { content: 'NO ADDITIONS' };
    });
    const tick = h.gm.maybeRunGmTick(reply(h));
    userSays(h);
    const result = await sendTurn(h);
    assert.equal(result.gm.used, false);
    assert.match(result.gm.reason, /still thinking/);
    gate.resolve();
    await tick; // late result: discarded, nothing stored
    assert.equal(prepared(h), null);
    assert.equal(h.gm.isGmBusy(), false);
});

test('the pending question is asked once at send time, never on dry runs or swipes', async () => {
    const ask = `<tool name="ask_user">${JSON.stringify({ question: 'Does Mara trust Voss?', options: ['Yes', 'No'] })}</tool>`;
    let popups = 0;
    const respond = router({ tick: (_text, call) => (call === 1 ? ask : GM_OUT), fit: '<use>none</use>' });
    const h = await harness({}, respond, { onPopup: popup => { popups++; popup.value = 'Only a little'; return 1; } });
    await tickAfter(h);
    assert.equal(popups, 0); // a tick never opens a popup
    const store = h.gm.getGmStore({ create: false });
    assert.match(store.pendingQuestion.question, /^Does Mara trust Voss\?/);
    assert.ok(prepared(h));
    userSays(h);
    // Dry run: reported, not asked, not cleared.
    const dry = await sendTurn(h, { inject: false });
    assert.equal(popups, 0);
    assert.match(dry.gm.question, /not asked during a dry run/);
    assert.ok(h.gm.getGmStore({ create: false }).pendingQuestion);
    // Swipe of the next reply: not asked either.
    reply(h, 'Voss answers.');
    await h.pipeline.runPipeline({ chat: h.savedChat.slice(0, -1), type: 'swipe' });
    assert.equal(popups, 0);
    assert.ok(h.gm.getGmStore({ create: false }).pendingQuestion);
    h.savedChat.pop();
    // The real send asks it.
    const real = await sendTurn(h);
    assert.equal(popups, 1);
    assert.match(real.injectionText, /answered a question: "Only a little"/);
    assert.equal(h.gm.getGmStore({ create: false }).pendingQuestion, null);
    assert.equal(prepared(h).qa.answer, 'Only a little');
    // A regenerate reuses the stored answer without asking again.
    reply(h, 'Voss answers.');
    const redo = await h.pipeline.runPipeline({ chat: h.savedChat.slice(0, -1), type: 'regenerate' });
    assert.equal(popups, 1);
    assert.match(redo.injectionText, /answered a question: "Only a little"/);
});

test('clock tool: a clock that fills makes its consequence a required event', async () => {
    const create = `<tool name="clock">${JSON.stringify({ action: 'create', name: 'Guards close in', segments: 3, consequence: 'Guards pound on the door and demand entry.' })}</tool>`;
    const advance = `<tool name="clock">${JSON.stringify({ action: 'advance', name: 'Guards close in', by: 3 })}</tool>`;
    const h = await harness({}, router({ tick: (_text, call) => (call === 1 ? `${create}\n${advance}` : `<brief>${BRIEF}</brief><must>The cook hides</must>`), fit: '<use>none</use>' }));
    await tickAfter(h);
    const store = h.gm.getGmStore({ create: false });
    assert.deepEqual(plain(store.clocks.map(clock => [clock.name, clock.filled, clock.status])), [['Guards close in', 3, 'filled']]);
    assert.deepEqual(plain(prepared(h).musts), ['Guards pound on the door and demand entry.', 'The cook hides']);
    userSays(h);
    const result = await sendTurn(h);
    assert.ok(h.pipeline.turnMustList().includes('Guards pound on the door and demand entry.'));
    assert.ok(result.injectionText.includes('Guards pound on the door and demand entry.'));
    // A clock that did not fill adds nothing, and the clock tool is unavailable outside the GM engine.
    const other = await harness({ agentEngine: 'planner' }, router());
    assert.equal(other.gm.getGmStore({ create: false }).clocks.length, 0);
});

test('npc_intent persists an agenda that the next tick sees; the writer never does', async () => {
    const intent = `<tool name="npc_intent">${JSON.stringify({ name: 'Captain Voss', intent: 'Orders the harbor sealed and sends scouts to the inn.' })}</tool>`;
    const respond = router({ tick: (_text, call) => (call === 1 ? intent : `<brief>${BRIEF}</brief>`), fit: '<use>none</use>' });
    const h = await harness({}, respond);
    await tickAfter(h);
    assert.deepEqual(plain(Object.keys(h.gm.getGmStore({ create: false }).agendas)), ['Captain Voss']);
    userSays(h);
    const result = await sendTurn(h);
    assert.equal(result.injectionText.includes('scouts to the inn'), false);
    reply(h, 'Alice shrugs.');
    await h.gm.maybeRunGmTick(h.savedChat.at(-1));
    const secondPrompt = h.requests.filter(request => isTick(request.text)).at(-1).text;
    assert.match(secondPrompt, /Captain Voss: Orders the harbor sealed/);
});

test('dice are recorded by code, attached to the brief and bound into the enforcement list', async () => {
    const roll = `<tool name="roll_dice">${JSON.stringify({ reason: 'Voss spots the tracks', difficulty: 'Muddy ground, an experienced tracker.' })}</tool>`;
    const lie = `<brief>${BRIEF} (Voss rolled a natural 20)</brief><must>Voss finds the tracks</must>`;
    const h = await harness({}, router({ tick: (_text, call) => (call === 1 ? roll : lie), fit: '<use>none</use>' }));
    await tickAfter(h);
    const rolls = prepared(h).rolls;
    assert.equal(rolls.length, 1);
    assert.match(rolls[0].text, /^d20 = \d+/);
    assert.equal(rolls[0].reason, 'Voss spots the tracks');
    userSays(h);
    const result = await sendTurn(h);
    assert.ok(result.injectionText.includes(`Dice (binding, already rolled): ${rolls[0].text}`));
    assert.ok(h.agent.agentTurnRequirements().rolls.length === 1);
    assert.ok(h.pipeline.turnMustList().some(item => item.includes('dice') || item.includes('Binding dice')));
});

test('secrets: the GM sees the bible; the injected tail and the prompt never carry it', async () => {
    const story = { v: 1, bible: { title: 'The Duke', premise: 'A winter court.', setting: 'Keep', tone: 'noir', conflict: 'Succession.', secrets: 'The duke was poisoned by Marguerite.',
        cast: [{ name: 'Marguerite', role: 'cook', wants: 'the crown', secret: 'She is the poisoner.' }], chapters: [{ title: 'The Feast', situation: 'Guests arrive.', goal: 'Find the heir', exit: 'Dinner', clues: 'A vial' }] },
        chapterIndex: 0, beat: { text: 'A guest collapses at the table.', status: 'pending', escalations: ['x'] }, ledger: [], turnsSinceDelivery: 0 };
    const respond = router({ fit: '<use>none</use>' });
    const h = await harness({ storyEnabled: true, injectAnchor: 'prompt-end' }, respond, { realStory: true, chatMetadata: { smarttavern: { story } } });
    await tickAfter(h);
    const tickPrompt = h.requests.find(request => isTick(request.text)).text;
    assert.match(tickPrompt, /STORY BIBLE — SECRET/);
    assert.match(tickPrompt, /poisoned by Marguerite/);
    assert.match(tickPrompt, /She is the poisoner/);
    userSays(h);
    const chat = [...h.savedChat];
    const result = await h.pipeline.runPipeline({ chat });
    assert.ok(result.injectionText.includes(BRIEF));
    for (const secret of ['poisoned by Marguerite', 'She is the poisoner', 'Marguerite', 'A vial', 'STORY BIBLE']) {
        assert.equal(result.injectionText.includes(secret), false, secret);
        assert.equal(JSON.stringify(chat).includes(secret), false, secret);
    }
    // The story directive is still delivered as before (and is the only story text).
    assert.ok(result.injectionText.includes('A guest collapses at the table.'));
});

test('tick modes: every / everyN / armed, and ineligible replies', async () => {
    const respond = router({ tick: `<brief>${BRIEF}</brief>` });
    const every = await harness({ gmTickMode: 'everyN', gmEveryN: 2 }, respond);
    for (let i = 0; i < 4; i++) await tickAfter(every, `reply ${i}`);
    assert.equal(respond.calls.tick, 2);
    assert.equal(every.gm.getGmStore({ create: false }).tick, 4);

    const armed = await harness({ gmTickMode: 'armed' }, router({ tick: `<brief>${BRIEF}</brief>` }));
    await tickAfter(armed, 'unarmed reply');
    assert.equal(prepared(armed), null);
    armed.agent.armAgent();
    await tickAfter(armed, 'armed reply');
    assert.equal(prepared(armed).anchorText, 'armed reply');
    assert.equal(armed.agent.isAgentArmed(), false); // consumed when the tick started
    await tickAfter(armed, 'next reply');
    assert.equal(prepared(armed).anchorText, 'armed reply'); // not re-armed

    const skip = router({ tick: `<brief>${BRIEF}</brief>` });
    const h = await harness({}, skip);
    for (const message of [{ is_user: true, mes: 'user' }, { is_system: true, mes: 'sys' }, { name: 'N', mes: 'narration', extra: { smarttavernNarration: true } }, { name: 'E', mes: 'x', smarttavern_ephemeral: true }, { name: 'Alice', mes: '   ' }]) {
        h.savedChat.push(message);
        await h.gm.maybeRunGmTick(message);
    }
    assert.equal(skip.calls.tick, 0);
    h.context.extensionSettings.smarttavern.enabled = false;
    await tickAfter(h);
    assert.equal(skip.calls.tick, 0);
    h.context.extensionSettings.smarttavern.enabled = true;
    h.context.extensionSettings.smarttavern.agentEngine = 'planner';
    await tickAfter(h);
    assert.equal(skip.calls.tick, 0);
});

test('the tick waits for the scene tracker promise and reads the updated scene', async () => {
    const respond = router({ tick: `<brief>${BRIEF}</brief>` });
    const h = await harness({}, respond);
    const message = reply(h);
    const tracker = deferred();
    const tick = h.gm.maybeRunGmTick(message, { after: tracker.promise });
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(respond.calls.tick, 0);
    assert.equal(h.gm.isGmBusy(), true);
    h.scene.writeSceneFacts([{ key: 'location', value: 'the cellar' }], { by: 'tracker', sourceIndex: 1 });
    tracker.resolve();
    await tick;
    assert.equal(respond.calls.tick, 1);
    assert.match(h.requests[0].text, /location: the cellar/);
});

test('one tick at a time: a newer reply preempts the running tick', async () => {
    const gate = deferred();
    const seen = [];
    const h = await harness({}, async (messages) => {
        const text = messages.map(message => message.content).join('\n');
        seen.push(text);
        if (seen.length === 1) await gate.promise;
        return { content: `<brief>${text.includes('second reply') ? 'Second brief' : 'First brief'}</brief>` };
    });
    const first = h.gm.maybeRunGmTick(reply(h, 'first reply'));
    userSays(h);
    const second = h.gm.maybeRunGmTick(reply(h, 'second reply'));
    gate.resolve();
    await Promise.all([first, second]);
    assert.equal(prepared(h).brief, 'Second brief');
    assert.equal(prepared(h).anchorText, 'second reply');
    assert.equal(h.gm.isGmBusy(), false);
});

test('cancellation: chat change and disabling discard the result; failures never reject', async () => {
    let gate = deferred();
    const h = await harness({}, async () => { await gate.promise; return { content: GM_OUT }; });
    const tick = h.gm.maybeRunGmTick(reply(h));
    h.context.eventSource.emit('chat');
    gate.resolve();
    assert.equal(await tick, null);
    assert.equal(prepared(h), null);

    gate = deferred();
    const tick2 = h.gm.maybeRunGmTick(reply(h, 'another reply'));
    h.context.extensionSettings.smarttavern.enabled = false;
    gate.resolve();
    assert.equal(await tick2, null);
    assert.equal(prepared(h), null);
    h.context.extensionSettings.smarttavern.enabled = true;

    const broken = await harness({}, async () => { throw new Error('provider down'); });
    const outcome = await broken.gm.maybeRunGmTick(reply(broken));
    assert.ok(outcome === null || outcome.ok === false);
    assert.equal(prepared(broken), null);
    userSays(broken);
    const result = await sendTurn(broken); // fails open: nothing injected, generation proceeds
    assert.ok(result === null || result.gm?.used === false);
});

test('think now: manual tick ignores the mode, refuses when busy or disabled', async () => {
    const gate = deferred();
    const h = await harness({ gmTickMode: 'armed' }, async () => { await gate.promise; return { content: `<brief>${BRIEF}</brief>` }; });
    assert.match(h.gm.runGmTickNow().error, /no character reply/);
    reply(h);
    const started = h.gm.runGmTickNow();
    assert.equal(typeof started.then, 'function');
    assert.match(h.gm.runGmTickNow().error, /already thinking/);
    gate.resolve();
    const outcome = await started;
    assert.equal(outcome.ok, true);
    assert.equal(prepared(h).brief, BRIEF);
    assert.equal(h.gm.discardPrepared(), true);
    assert.equal(prepared(h), null);
    h.context.extensionSettings.smarttavern.agentEngine = 'legacy';
    assert.match(h.gm.runGmTickNow().error, /Switch the agent engine/);
});

test('skips and fields from the prepared brief shape the lean reply context; the planner is not called', async () => {
    const respond = router({ tick: `<brief>${BRIEF}</brief><fields>Mood</fields><skip>Tactics</skip>`, planner: '## Expansion: Extra\nShould never run.' });
    const fields = [{ name: 'Mood', description: 'm', inject: 'relevant' }, { name: 'Goals', description: 'g', inject: 'relevant' }, { name: 'Voice', description: 'v', inject: 'always' }];
    const steps = [
        { name: 'Tactics', prompt: 'Assess tactics.', role: 'assistant', profileId: 'model', enabled: true, activation: 'planner' },
        { name: 'Always', prompt: 'Assess always.', role: 'assistant', profileId: 'model', enabled: true },
    ];
    const h = await harness({ expansionEnabled: true, steps, fields }, respond);
    await tickAfter(h);
    assert.match(h.requests[0].text, /RELEVANT-MODE FIELDS/);
    assert.match(h.requests[0].text, /PLANNER-ACTIVATED EXPANSION BLOCKS[\s\S]*- Tactics/);
    userSays(h);
    const before = h.requests.length;
    const result = await sendTurn(h);
    assert.equal(respond.calls.planner, 0);
    assert.deepEqual(plain(result.activation.skipped.map(skip => skip.name)), ['Tactics']);
    assert.deepEqual(plain(result.effectiveSteps.map(step => step.name)), ['Always']);
    assert.deepEqual(plain(result.planner.fields), ['Mood']);
    assert.equal(h.requests.length - before, 1); // only the 'Always' block ran
});

test('migration: existing installs keep their engine; invalid values are repaired; gmVersion is set once', async () => {
    for (const engine of ['legacy', 'planner']) {
        const h = await harness({ agentEngine: engine });
        const settings = h.state.getSettings();
        assert.equal(settings.agentEngine, engine);
        assert.equal(settings.gmVersion, 1);
        assert.equal(settings.gmTickMode, 'every');
        assert.equal(settings.gmEveryN, 3);
        assert.equal(settings.gmWaitMs, 300);
        assert.equal(settings.agentToolsEnabled.clock, true);
        assert.equal(settings.agentToolsEnabled.npc_intent, true);
        assert.equal(settings.gmProfileId, '');
    }
    const repaired = await harness({ agentEngine: 'nonsense', gmTickMode: 'weird', gmEveryN: 99, gmWaitMs: -5, gmTask: 7, gmProfileId: 3 });
    const settings = repaired.state.getSettings();
    assert.equal(settings.agentEngine, 'planner');
    assert.equal(settings.gmTickMode, 'every');
    assert.equal(settings.gmEveryN, 20);
    assert.equal(settings.gmWaitMs, 0);
    assert.equal(typeof settings.gmTask, 'string');
    assert.equal(settings.gmProfileId, '');
    assert.equal(repaired.state.DEFAULT_SETTINGS.agentEngine, 'planner'); // the GM is opt-in
    const gm = await harness({ agentEngine: 'gm' });
    assert.equal(gm.state.getSettings().agentEngine, 'gm'); // 'gm' is a valid engine and survives normalization
});

test('clock and npc_intent exist only for the GM engine and honor their switches', async () => {
    const h = await harness({ agentEngine: 'planner' });
    const settings = h.state.getSettings();
    for (const [engine, expected] of [['planner', false], ['legacy', false], ['gm', true]]) {
        settings.agentEngine = engine;
        assert.equal(h.tools.toolEnabled('clock', settings), expected, engine);
        assert.equal(h.tools.toolEnabled('npc_intent', settings), expected, engine);
        assert.equal(h.tools.availableTools(settings).some(tool => tool.name === 'clock'), expected, engine);
    }
    settings.agentToolsEnabled.clock = false;
    assert.equal(h.tools.toolEnabled('clock', settings), false);
    assert.equal(h.tools.toolEnabled('npc_intent', settings), true);
    // Outside a tick (no ctx.gm) the tools refuse instead of touching any store.
    settings.agentToolsEnabled.clock = true;
    const record = await h.tools.executeToolCall({ name: 'clock', args: { action: 'create', name: 'X', consequence: 'Y' } },
        { settings, toolState: {}, turn: { rolls: [], consults: [] }, signal: null, isCurrentChat: () => true });
    assert.equal(record.ok, false);
    assert.match(record.result, /only available to the GM/);
});

test('the GM panel section renders the prepared brief, clocks, agendas and escapes user text', async () => {
    const create = `<tool name="clock">${JSON.stringify({ action: 'create', name: '<b>Doom</b>', segments: 4, consequence: 'The "city" burns & falls.' })}</tool>`;
    const intent = `<tool name="npc_intent">${JSON.stringify({ name: 'Voss', intent: 'Seals the <harbor>.' })}</tool>`;
    const ask = `<tool name="ask_user">${JSON.stringify({ question: 'Trust Voss?' })}</tool>`;
    const h = await harness({}, router({ tick: (_text, call) => (call === 1 ? `${create}\n${intent}\n${ask}` : GM_OUT) }), { ui: true });
    await tickAfter(h);
    const html = h.ui.gmTabHtml(h.state.getSettings());
    assert.ok(html.includes(BRIEF));
    assert.ok(html.includes('&lt;b&gt;Doom&lt;/b&gt;'));
    assert.equal(html.includes('<b>Doom</b>'), false);
    assert.ok(html.includes('&lt;harbor&gt;'));
    assert.ok(html.includes('Trust Voss?'));
    assert.match(html, /smarttavern_gm_clock_advance/);
    assert.match(html, /Think now/);
    assert.match(h.ui.gmStatusLine(h.state.getSettings()), /after every reply · last tick \d\d:\d\d — Prepared after message #1/);
    assert.match(h.gm.gmStateText(), /CLOCKS[\s\S]*Doom/);
    // Panel edits go through the same store: advancing to full adds the consequence to the prepared brief.
    assert.equal(h.gm.advanceClockManual(1, 3).justFilled, false);
    assert.equal(h.gm.advanceClockManual(1, 1).justFilled, true);
    assert.ok(plain(prepared(h).musts).includes('The "city" burns & falls.'));
    assert.equal(h.gm.removeClockManual(1).ok, true);
    assert.equal(h.gm.addClockManual({ name: 'Mine', segments: 3, consequence: 'x' }).ok, true);
    assert.equal(h.gm.setAgendaManual('Voss', 'Waits.').ok, true);
    assert.equal(h.gm.removeAgendaManual('voss'), true);
    assert.equal(h.gm.clearPendingQuestion(), true);
});

// --------------------------------------------------------------------------------------------
// Native function calling (gmToolTransport 'native' | 'auto')
// --------------------------------------------------------------------------------------------

const callsOf = (...calls) => ({ choices: [{ index: 0, message: { content: '', tool_calls: calls.map(([id, name, args]) => ({ id, type: 'function', function: { name, arguments: JSON.stringify(args) } })) } }] });
const SUBMIT = { brief: BRIEF, musts: ['A bell tolls from the harbor'], branches: [{ if: 'the player flees', then: 'Scouts spot the player on the roof' }], skips: [], fields: ['Mood'] };
const toolNames = overrides => plain((overrides?.tools ?? []).map(tool => tool.function.name));

/** A scripted native model: `script(n, messages, overrides)` returns a raw response for each tools request; tag requests use the router. */
function nativeModel(script, tagReply = router()) {
    const seen = [];
    const respond = async (messages, count, overrides, custom) => {
        if (overrides?.tools) {
            assert.equal(custom.extractData, false); // the raw body is needed to read tool calls
            assert.equal(custom.stream, false);
            seen.push({ messages: structuredClone(messages), overrides });
            return script(seen.length, messages, overrides);
        }
        return tagReply(messages, count);
    };
    respond.seen = seen;
    respond.tags = tagReply;
    return respond;
}

test('native tick: a tool call, its result as a role:tool message, then submit_brief ends the tick', async () => {
    const model = nativeModel(n => (n === 1
        ? callsOf(['call_1', 'roll_dice', { reason: 'pick the lock', difficulty: 'A rusty lock, hard for the untrained.' }])
        : callsOf(['call_2', 'submit_brief', SUBMIT])));
    const h = await harness({ gmToolTransport: 'native' }, model);
    await tickAfter(h);
    assert.equal(model.seen.length, 2);
    // Request 1: OpenAI-format tools incl. the final tool, JSON-schema parameters, no tag protocol in the prompt.
    const names = toolNames(model.seen[0].overrides);
    assert.ok(names.includes('roll_dice') && names.includes('clock') && names.at(-1) === 'submit_brief');
    assert.equal(model.seen[0].overrides.tool_choice, 'auto');
    for (const tool of model.seen[0].overrides.tools) {
        assert.equal(tool.type, 'function');
        assert.equal(tool.function.parameters.type, 'object');
    }
    const first = model.seen[0].messages.map(message => message.content).join('\n');
    assert.match(first, /submit_brief exactly once/);
    assert.doesNotMatch(first, /FINAL OUTPUT FORMAT/);
    // Request 2 replays the assistant turn with its tool_calls and answers with a tool message.
    const second = model.seen[1].messages;
    const assistant = second.find(message => message.role === 'assistant');
    assert.equal(assistant.tool_calls[0].id, 'call_1');
    assert.equal(assistant.tool_calls[0].function.name, 'roll_dice');
    assert.equal(typeof assistant.tool_calls[0].function.arguments, 'string');
    const toolMessage = second.find(message => message.role === 'tool');
    assert.equal(toolMessage.tool_call_id, 'call_1');
    assert.match(toolMessage.content, /d20|Rolled|roll/i);
    // The brief is normalized exactly like the tag output; the dice come from code.
    const brief = prepared(h);
    assert.equal(brief.brief, BRIEF);
    assert.deepEqual(plain(brief.musts), ['A bell tolls from the harbor']);
    assert.deepEqual(plain(brief.branches), [{ if: 'the player flees', then: 'Scouts spot the player on the roof' }]);
    assert.deepEqual(plain(brief.fields), ['Mood']);
    assert.equal(brief.rolls.length, 1);
    // The transcript records the same entries as a tags tick.
    const titles = h.gm.getGmStore({ create: false }).transcript.map(entry => entry.title);
    assert.ok(titles.includes('Calling roll_dice') && titles.includes('roll_dice · ok') && titles.includes('submit_brief'));
    assert.equal(model.tags.calls.tick, 0);
});

test('native tick: unknown tools and bad arguments come back as error results; a rejected submit lets the model retry', async () => {
    const model = nativeModel(n => (n === 1
        ? callsOf(['a', 'no_such_tool', {}], ['b', 'roll_dice', {}])
        : n === 2 ? callsOf(['c', 'submit_brief', { brief: '' }]) : callsOf(['d', 'submit_brief', SUBMIT])), router());
    const h = await harness({ gmToolTransport: 'native', agentMaxIterations: 4 }, model);
    await tickAfter(h);
    const answers = model.seen[1].messages.filter(message => message.role === 'tool').map(message => message.content);
    assert.match(answers[0], /unknown tool/);
    assert.match(answers[1], /Missing required field/);
    assert.match(model.seen[2].messages.filter(message => message.role === 'tool').at(-1).content, /empty or refused/);
    assert.equal(prepared(h).brief, BRIEF);
});

test('native tick: a failure of the FIRST request reruns the whole tick on tags with one note', async () => {
    const model = nativeModel(() => { throw new Error('tools are not supported by this model'); });
    const h = await harness({ gmToolTransport: 'native' }, model);
    await tickAfter(h);
    assert.equal(model.tags.calls.tick, 1);
    assert.equal(prepared(h).brief, BRIEF);
    const notes = h.context.activityEntries.filter(entry => /Native tool calling unavailable/.test(entry.title));
    assert.equal(notes.length, 1);
    assert.match(notes[0].text, /not supported/);
    // The tags request carries no tools.
    assert.equal(h.requests.at(-1).overrides?.tools, undefined);
});

test('native tick: a failure after tools ran keeps what exists instead of restarting', async () => {
    const model = nativeModel(n => { if (n === 1) return callsOf(['a', 'roll_dice', { reason: 'a risky climb', difficulty: 'Slippery stone, hard.' }]); throw new Error('provider fell over'); });
    const h = await harness({ gmToolTransport: 'native' }, model);
    await tickAfter(h);
    assert.equal(model.tags.calls.tick, 0);
    assert.equal(prepared(h).rolls.length, 1); // the binding roll still produces a brief
});

test("transport 'auto' falls back to tags quietly; 'native' says why once; tags is untouched", async () => {
    const tagsOnly = nativeModel(() => { throw new Error('must not be called'); });
    const textProfile = await harness({ gmToolTransport: 'auto', agentProfileId: 'nofunctions' }, tagsOnly);
    await tickAfter(textProfile);
    assert.equal(tagsOnly.tags.calls.tick, 1);
    assert.equal(textProfile.context.activityEntries.some(entry => /Native tool calling/.test(entry.title)), false);

    const loud = nativeModel(() => { throw new Error('must not be called'); });
    const explicit = await harness({ gmToolTransport: 'native', agentProfileId: 'nofunctions' }, loud);
    await tickAfter(explicit);
    assert.equal(explicit.context.activityEntries.filter(entry => /Native tool calling unavailable/.test(entry.title)).length, 1);
    assert.equal(loud.tags.calls.tick, 1);

    // No profile at all (active connection): not supported in v1.
    const activeModel = nativeModel(() => { throw new Error('must not be called'); });
    const active = await harness({ gmToolTransport: 'auto', agentProfileId: '' }, activeModel);
    await tickAfter(active);
    assert.equal(activeModel.seen.length, 0);
    assert.equal(active.context.activityEntries.some(entry => /Native tool calling/.test(entry.title)), false);

    const defaults = await harness({}, router());
    assert.equal(defaults.state.getSettings().gmToolTransport, 'tags');
    assert.equal(defaults.state.getSettings().mcpEnabled, false);
});

test('native tick: when iterations run out the model is asked once more with ONLY submit_brief, forced', async () => {
    const model = nativeModel((n, _messages, overrides) => (n < 2
        ? callsOf([`c${n}`, 'roll_dice', { reason: `risk number ${n}`, difficulty: 'Hard enough to matter here.' }])
        : (assert.deepEqual(toolNames(overrides), ['submit_brief']), assert.equal(overrides.tool_choice, 'required'), callsOf(['z', 'submit_brief', SUBMIT]))));
    const h = await harness({ gmToolTransport: 'native', agentMaxIterations: 2 }, model);
    await tickAfter(h);
    assert.equal(model.seen.length, 2);
    assert.match(model.seen[1].messages.at(-1).content, /submit_brief now/);
    assert.equal(prepared(h).brief, BRIEF);
});

test('native tick: no submit_brief even after the forced request falls back to one tags-format final request', async () => {
    const model = nativeModel(n => (n === 1 ? callsOf(['a', 'roll_dice', { reason: 'a risky climb', difficulty: 'Slippery stone, hard.' }]) : { choices: [{ index: 0, message: { content: 'I am done thinking.' } }] }));
    const h = await harness({ gmToolTransport: 'native', agentMaxIterations: 2 }, model);
    await tickAfter(h);
    assert.equal(model.seen.length, 2);
    assert.equal(model.tags.calls.tick, 1);
    // The tags request sees the tool history the native loop produced.
    assert.match(h.requests.at(-1).text, /TOOL HISTORY/);
    assert.match(h.requests.at(-1).text, /roll_dice/);
    assert.equal(prepared(h).brief, BRIEF);
});

test('native tick: a model that answers with tag text instead of calling functions is still understood', async () => {
    const model = nativeModel(() => ({ choices: [{ index: 0, message: { content: GM_OUT } }] }));
    const h = await harness({ gmToolTransport: 'native' }, model);
    await tickAfter(h);
    assert.equal(model.seen.length, 1);
    assert.equal(prepared(h).brief, BRIEF);
});

test('native tick: Claude and Gemini raw shapes drive the same loop', async () => {
    const claude = nativeModel(n => (n === 1
        ? { content: [{ type: 'thinking', thinking: 'Plan.' }, { type: 'tool_use', id: 'toolu_1', name: 'roll_dice', input: { reason: 'a risky climb', difficulty: 'Slippery stone, hard.' } }] }
        : { content: [{ type: 'tool_use', id: 'toolu_2', name: 'submit_brief', input: SUBMIT }] }));
    const h = await harness({ gmToolTransport: 'native', agentProfileId: 'claude-profile' }, claude);
    h.context.extensionSettings.connectionManager.profiles.push({ id: 'claude-profile', mode: 'cc', api: 'claude' });
    await tickAfter(h);
    assert.equal(claude.seen.length, 2);
    assert.equal(prepared(h).brief, BRIEF);
    assert.ok(h.gm.getGmStore({ create: false }).transcript.some(entry => entry.text === 'Plan.'));
    const gemini = nativeModel(() => ({ choices: [{ message: { content: '' } }], responseContent: { parts: [{ functionCall: { name: 'submit_brief', args: SUBMIT } }] } }));
    const g = await harness({ gmToolTransport: 'native' }, gemini);
    await tickAfter(g);
    assert.equal(prepared(g).brief, BRIEF);
});

// --------------------------------------------------------------------------------------------
// Tool definitions for native calling
// --------------------------------------------------------------------------------------------

test('listToolDefinitions: same availability rules as the catalog, valid schemas, submit_brief last, no functions', async () => {
    const { definitionProblems, toOpenAiTools } = await import('../src/native-core.js');
    const h = await harness({});
    const settings = h.state.getSettings();
    const defs = h.tools.listToolDefinitions(settings, { toolState: {}, turn: {} });
    const names = plain(defs.map(def => def.name));
    assert.equal(names.at(-1), 'submit_brief');
    assert.deepEqual(names.slice(0, -1), plain(h.tools.availableTools(settings, { toolState: {}, turn: {} }).map(tool => tool.name)));
    for (const tool of toOpenAiTools(plain(defs))) {
        const problems = definitionProblems({ name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters });
        assert.deepEqual(problems, [], tool.function.name);
        assert.equal(typeof JSON.parse(JSON.stringify(tool.function.parameters)), 'object'); // plain JSON, no functions
    }
    // Disabled tools disappear; the final request offers submit_brief alone; other engines get no submit_brief.
    settings.agentToolsEnabled.clock = false;
    assert.ok(!plain(h.tools.listToolDefinitions(settings, {}).map(def => def.name)).includes('clock'));
    assert.deepEqual(plain(h.tools.listToolDefinitions(settings, { toolsOn: false }).map(def => def.name)), ['submit_brief']);
    settings.agentEngine = 'planner';
    assert.ok(!plain(h.tools.listToolDefinitions(settings, {}).map(def => def.name)).includes('submit_brief'));
});

// --------------------------------------------------------------------------------------------
// MCP bridge client
// --------------------------------------------------------------------------------------------

const MCP_TOOLS = [
    { server: 'echo', name: 'echo', description: 'Echo the text back', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] }, write: false },
    { server: 'echo', name: 'lookup', description: 'Look something up', inputSchema: { type: 'object', properties: { q: { type: 'string' } } }, write: false },
    { server: 'notes', name: 'save note!', description: 'Writes a note', inputSchema: { type: 'object', properties: { body: { type: 'string' } } }, write: true },
];

/** Installs a fake plugin behind fetch; `calls` records every request. */
function fakePlugin(h, { tools = MCP_TOOLS, callResult = body => ({ ok: true, content: `echo: ${body.args?.text ?? body.args?.q ?? ''}`, isError: false }) } = {}) {
    const calls = [];
    h.context.fetchImpl = async (url, init = {}) => {
        const path = url.replace('/api/plugins/smarttavern-mcp', '');
        const body = init.body ? JSON.parse(init.body) : undefined;
        calls.push({ path, method: init.method, headers: init.headers, body });
        const reply = (json, status = 200) => ({ ok: status < 400, status, json: async () => json });
        if (path === '/status') return reply({ ok: true, servers: [{ name: 'echo', connected: true, write: false, timeoutMs: 30000 }, { name: 'notes', connected: true, write: true }] });
        if (path === '/tools') return reply({ ok: true, tools, errors: [] });
        if (path === '/reload') return reply({ ok: true });
        if (path === '/call') return reply(callResult(body));
        return reply({ ok: false }, 404);
    };
    return calls;
}
const mcpNames = (h, options = {}) => plain(h.tools.availableTools(h.state.getSettings(), { toolState: {}, turn: {}, ...options }).map(tool => tool.name).filter(name => name.startsWith('mcp__')));

test('MCP: without the plugin nothing is registered and the GM tick is unaffected', async () => {
    const h = await harness({ mcpEnabled: true }, router());
    const snapshot = await h.mcp.refreshMcp(); // fetch throws like an unreachable server
    assert.equal(snapshot.state, 'absent');
    assert.deepEqual(mcpNames(h), []);
    h.context.fetchImpl = async () => ({ ok: false, status: 404, json: async () => { throw new Error('html'); } });
    assert.equal((await h.mcp.refreshMcp()).state, 'absent');
    h.context.fetchImpl = async () => ({ ok: false, status: 500, json: async () => ({ ok: false, error: 'plugin exploded' }) });
    const broken = await h.mcp.refreshMcp();
    assert.equal(broken.state, 'error');
    assert.match(broken.message, /plugin exploded/);
    await tickAfter(h);
    assert.equal(prepared(h).brief, BRIEF);
});

test('MCP: tools register as mcp__server__tool and are gated by engine, switch, per-tool box and budget', async () => {
    const h = await harness({ mcpEnabled: true, mcpCallsPerTurn: 2 }, router());
    const calls = fakePlugin(h);
    const snapshot = await h.mcp.refreshMcp();
    assert.equal(snapshot.state, 'ok');
    assert.equal(snapshot.tools.length, 3);
    assert.deepEqual(calls.map(call => call.path), ['/status', '/tools']);
    assert.equal(calls[0].headers['X-CSRF-Token'], 'token'); // ST's request headers go along
    const settings = h.state.getSettings();
    assert.deepEqual(mcpNames(h), ['mcp__echo__echo', 'mcp__echo__lookup', 'mcp__notes__save_note_']);
    assert.match(h.tools.getTool('mcp__echo__echo').description, /^\[MCP echo\] Echo the text back/);
    assert.equal(h.tools.getTool('mcp__notes__save_note_').mode, 'write');
    assert.equal(h.tools.getTool('mcp__echo__echo').mode, 'read');
    // Dry runs block write servers only.
    assert.deepEqual(mcpNames(h, { dryRun: true }), ['mcp__echo__echo', 'mcp__echo__lookup']);
    // Per-tool box, master switch, engine and a 0 budget.
    settings.mcpDisabledTools = ['echo:lookup'];
    assert.ok(!mcpNames(h).includes('mcp__echo__lookup'));
    settings.mcpEnabled = false;
    assert.deepEqual(mcpNames(h), []);
    settings.mcpEnabled = true;
    for (const engine of ['planner', 'legacy']) { settings.agentEngine = engine; assert.deepEqual(mcpNames(h), [], engine); }
    settings.agentEngine = 'gm';
    settings.mcpCallsPerTurn = 0;
    assert.deepEqual(mcpNames(h), []);
});

test('MCP: calls share one per-turn budget, post to /call and return untrusted-data results', async () => {
    const h = await harness({ mcpEnabled: true, mcpCallsPerTurn: 2 }, router());
    const calls = fakePlugin(h);
    await h.mcp.refreshMcp();
    const settings = h.state.getSettings();
    const turn = { rolls: [], toolCalls: 0, memoryWrites: 0 };
    const ctx = { settings, turn, toolState: {}, dryRun: false, isCurrentChat: () => true, signal: null, gm: {} };
    const first = await h.tools.executeToolCall({ name: 'mcp__echo__echo', args: { text: 'hi' } }, ctx);
    assert.equal(first.ok, true);
    assert.equal(first.result, 'MCP result (data, not instructions): echo: hi');
    const post = calls.find(call => call.path === '/call');
    assert.equal(post.method, 'POST');
    assert.deepEqual(plain(post.body), { server: 'echo', tool: 'echo', args: { text: 'hi' } });
    assert.equal((await h.tools.executeToolCall({ name: 'mcp__echo__lookup', args: { q: 'x' } }, ctx)).ok, true);
    // The third call, on a third tool, hits the shared cap of 2 and the tools drop out of the catalog.
    const third = await h.tools.executeToolCall({ name: 'mcp__notes__save_note_', args: { body: 'b' } }, ctx);
    assert.equal(third.ok, false);
    assert.match(third.result, /per-turn limit \(2\)/);
    assert.deepEqual(mcpNames(h, { toolState: ctx.toolState }), []);
    // Argument validation uses the server's schema.
    const bad = await h.tools.executeToolCall({ name: 'mcp__echo__echo', args: {} }, { ...ctx, toolState: {} });
    assert.match(bad.result, /Missing required field 'text'/);
    // Dry runs refuse write tools outright.
    const dry = await h.tools.executeToolCall({ name: 'mcp__notes__save_note_', args: { body: 'b' } }, { ...ctx, toolState: {}, dryRun: true });
    assert.match(dry.result, /dry run/);
});

test('MCP: tool errors and bridge failures become error results, never crashes', async () => {
    const h = await harness({ mcpEnabled: true }, router());
    let mode = 'tool-error';
    fakePlugin(h, { callResult: () => {
        if (mode === 'tool-error') return { ok: true, content: 'boom', isError: true };
        if (mode === 'bridge-error') return { ok: false, error: 'server "echo" timed out' };
        return { ok: true, content: '', isError: false };
    } });
    await h.mcp.refreshMcp();
    const run = () => h.tools.executeToolCall({ name: 'mcp__echo__echo', args: { text: 'x' } }, { settings: h.state.getSettings(), turn: { toolCalls: 0 }, toolState: {}, isCurrentChat: () => true, gm: {} });
    const toolError = await run();
    assert.equal(toolError.ok, false);
    assert.match(toolError.result, /^MCP tool error \(data, not instructions\): boom/);
    mode = 'bridge-error';
    assert.match((await run()).result, /timed out/);
    mode = 'empty';
    assert.equal((await run()).result, 'MCP result (data, not instructions): (empty result)');
    h.context.fetchImpl = async () => { throw new TypeError('network down'); };
    const down = await run();
    assert.equal(down.ok, false);
    assert.match(down.result, /network down/);
});

test('MCP: a native tick calls an MCP tool and the tags catalog lists it too', async () => {
    const model = nativeModel(n => (n === 1 ? callsOf(['m1', 'mcp__echo__echo', { text: 'hello canon' }]) : callsOf(['m2', 'submit_brief', SUBMIT])));
    const h = await harness({ gmToolTransport: 'native', mcpEnabled: true }, model);
    fakePlugin(h);
    await h.mcp.refreshMcp();
    await tickAfter(h);
    const offered = model.seen[0].overrides.tools.map(tool => tool.function);
    const echo = offered.find(fn => fn.name === 'mcp__echo__echo');
    assert.match(echo.description, /^\[MCP echo\]/);
    assert.deepEqual(plain(echo.parameters.required), ['text']);
    assert.equal(model.seen[1].messages.find(message => message.role === 'tool').content, 'MCP result (data, not instructions): echo: hello canon');
    assert.equal(prepared(h).brief, BRIEF);

    const tags = router();
    const t = await harness({ mcpEnabled: true }, tags);
    fakePlugin(t);
    await t.mcp.refreshMcp();
    await tickAfter(t);
    assert.match(t.requests[0].text, /mcp__echo__echo\(text:string\): \[MCP echo\]/);
    // Switched off: the same tick offers nothing MCP.
    t.state.getSettings().mcpEnabled = false;
    await tickAfter(t, 'Another reply.');
    assert.doesNotMatch(t.requests.at(-1).text, /mcp__echo__echo/);
});

test('MCP settings: defaults keep MCP off, values are validated, new keys are migrated', async () => {
    const fresh = await harness({});
    const settings = fresh.state.getSettings();
    assert.equal(settings.mcpEnabled, false);
    assert.equal(settings.mcpCallsPerTurn, 3);
    assert.deepEqual(plain(settings.mcpDisabledTools), []);
    assert.equal(settings.gmToolTransport, 'tags');
    assert.equal(settings.toolTransportVersion, 1);
    const repaired = await harness({ gmToolTransport: 'carrier-pigeon', mcpEnabled: 'yes', mcpCallsPerTurn: 99, mcpDisabledTools: ['a:b', 5] });
    const fixed = repaired.state.getSettings();
    assert.equal(fixed.gmToolTransport, 'tags');
    assert.equal(fixed.mcpEnabled, false);
    assert.equal(fixed.mcpCallsPerTurn, 10);
    assert.deepEqual(plain(fixed.mcpDisabledTools), ['a:b']);
    assert.equal((await harness({ mcpDisabledTools: 'nope' })).state.getSettings().mcpDisabledTools.length, 0);
});
