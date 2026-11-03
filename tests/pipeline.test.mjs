// Run: node --experimental-vm-modules --test tests/pipeline.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SourceTextModule, createContext } from 'node:vm';

async function harness(settings = {}, respond = async () => ({ content: 'GENERATED ASSESSMENT' }), { veiled = false, onPopup = () => 0, realAgent = false, realStory = false, directive = null, clock = null } = {}) {
    const requests = [];
    const savedChat = [{ is_user: true, name: 'User', mes: 'Hello' }];
    const listeners = new Map();
    const context = {
        POPUP_TYPE: { CONFIRM: 1 }, POPUP_RESULT: { AFFIRMATIVE: 1, CANCELLED: 0, CUSTOM1: 1001 },
        Popup: class {
            constructor(content, _type, _input, options) { this.content = content; this.options = options; }
            show() { return new Promise(resolve => { this.resolve = resolve; Promise.resolve(onPopup(this)).then(result => { if (result !== undefined) this.complete(result); }); }); }
            complete(result) { this.result = result; this.resolve?.(result); }
        },
        event_types: { GENERATION_STOPPED: 'stop', CHAT_CHANGED: 'chat', MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
        eventSource: {
            on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
            removeListener(type, fn) { listeners.get(type)?.delete(fn); },
            emit(type, ...args) { for (const fn of [...(listeners.get(type) ?? [])]) fn(...args); },
        },
        extensionSettings: { smarttavern: { genRetries: 0, bootstrapOnFirstMessage: false, promptTailVersion: 1, injectAnchor: 'before-last-user', ...settings }, connectionManager: { profiles: [{ id: 'model', mode: 'cc' }] } },
        chat: savedChat, chatMetadata: {}, characterId: 0, chatId: 'test-chat', activityEntries: [], activityEnds: [],
        characters: [{ name: 'Alice', avatar: 'alice.png' }], name1: 'User', name2: 'Alice',
        saveSettingsDebounced() {}, substituteParams: text => text,
        saveMetadata() {}, saveMetadataDebounced() {}, saveChat: async () => {}, updateMessageBlock() {}, addOneMessage(message) { context.renderedMessage = message; },
        ConnectionManagerRequestService: { async sendRequest(id, messages, _maxTokens, custom) {
            requests.push({ id, messages, signal: custom?.signal });
            return respond(messages, requests.length);
        } },
        generateRaw: async options => { requests.push(options); return 'ACTIVE OUTPUT'; },
    };
    const sandbox = createContext({ context, AbortController, DOMException, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, console: { log() {}, warn() {} }, toastr: { warning() {}, info() {}, success() {} },
        ...(clock ? { Date: class extends Date { static now() { return clock.now; } } } : {}),
        document: { dispatchEvent() {}, createElement() { return { children: [], append(...children) { this.children.push(...children); } }; } }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    });
    const modules = new Map();
    const sources = {
        extensions: 'export const getContext = () => context;',
        'system-messages': "export const system_message_types = { NARRATOR: 'narrator' };",
        'instruct-mode': `export const formatInstructModeChat = (name, text, user, system) => '<' + (system ? 'system' : user ? 'user' : 'assistant') + '>' + text + '</turn>\\n'; export const formatInstructModePrompt = () => '<assistant>';`,
        progress: 'export const activityStart = () => {}; export const activityStatus = () => {}; export const activityEntry = entry => { context.activityEntries.push(entry); }; export const activityFail = () => {}; export const activityEnd = options => { context.activityEnds.push(options); }; export const activitySteps = () => {}; export const activityStepState = () => {}; export const activityRefinementControls = () => {};',
        veil: `export const applyVeil = () => ${veiled}; export const setVeilStep = () => {}; export const setVeilStatus = () => {}; export const revealVeil = () => {}; export const dismissVeil = () => {}; export const dismissAllVeils = () => {}; export const armPreVeil = () => {};`,
        // Story Director stub: no chat in these tests carries a story, so the whole
        // feature must stay inert. The no-ops mirror story.js's no-story behavior.
        story: `export const prepareStoryDirective = () => (${JSON.stringify(directive)}); export const storyMacroContext = value => value; export const recordedDirective = () => null; export const compileStoryDirective = () => null; export const hasStory = () => false; export const markStoryBeatDelivered = () => false; export const recordDirectiveInjection = () => {}; export const resetStoryGenerationState = () => {};`,
        // Thinking agent stub: these tests exercise the non-agent path (the default
        // agentMode is 'always', so the stub gate must stay closed explicitly).
        agent: 'export const agentActiveForTurn = () => false; export const runAgentLoop = async () => null; export const resetAgentTurn = () => {}; export const agentTurnRequirements = () => ({ must: [], rolls: [] }); export const armAgent = () => {}; export const clearAgentSession = () => {};',
    };
    if (realAgent) {
        sources.progress += ' export const activityAgentControls = (controls = {}) => { context.agentControls = controls; };';
        sources['world-info'] = `
            export const world_names = ['Existing'];
            export const selected_world_info = [];
            export const world_info = {};
            export const METADATA_KEY = 'world_info';
            export const books = { Existing: { entries: { 0: { uid: 0, comment: 'User memory', key: ['Alice'], content: 'A user fact.' } } } };
            export const loadWorldInfo = async name => structuredClone(books[name] ?? null);
            export const saveWorldInfo = async (name, data) => { books[name] = structuredClone(data); };
            export const createNewWorldInfo = async name => { world_names.push(name); books[name] = { entries: {} }; return true; };
            export const createWorldInfoEntry = (_name, data) => {
                let uid = 0; while (data.entries[uid]) uid++;
                return data.entries[uid] = { uid, key: [], comment: '', content: '', order: 100, smarttavern: false };
            };
            export const deleteWorldInfoEntry = async (data, uid) => { delete data.entries[uid]; return true; };
        `;
        for (const name of ['agent', 'agent-tools']) sources[name] = await readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8');
    }
    for (const name of ['pipeline', 'state', 'gen', 'tail', 'profiles', 'refinement-checks', 'refinement-edits', 'agent-core', ...(realStory ? ['story', 'story-core'] : [])]) {
        sources[name] = await readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8');
    }
    for (const [name, source] of Object.entries(sources)) {
        modules.set(name, new SourceTextModule(source, { context: sandbox }));
    }
    const pipeline = modules.get('pipeline');
    await pipeline.link(specifier => modules.get(specifier.split('/').at(-1).replace('.js', '')));
    await pipeline.evaluate();
    const state = modules.get('state').namespace;
    state.loadSettings();
    return { story: modules.get('story').namespace, pipeline: pipeline.namespace, agent: modules.get('agent').namespace, tools: modules.get('agent-tools')?.namespace, world: modules.get('world-info')?.namespace, checks: modules.get('refinement-checks').namespace, edits: modules.get('refinement-edits').namespace, profiles: modules.get('profiles').namespace, tail: modules.get('tail').namespace, gen: modules.get('gen').namespace, state, context, requests, savedChat };
}

const step = (name, prompt, role = 'assistant') => ({ name, prompt, role, profileId: 'model', enabled: true });

const agentSettings = { expansionEnabled: false, agentProfileId: 'model', agentMode: 'always' };
const agentOptions = h => ({ chat: [...h.savedChat], char: h.context.characters[0], settings: h.state.getSettings() });
const lockDifficulty = 'The lock is difficult for Alice; interpret the roll against her limited experience.';
const lockRoll = `<tool name="roll_dice">${JSON.stringify({ reason: 'Pick the lock', difficulty: lockDifficulty })}</tool>`;

test('agent rolls preserve agent-defined difficulty and assign only extreme outcomes', async () => {
    const h = await harness(agentSettings, undefined, { realAgent: true });
    const ctx = { ...agentOptions(h), toolState: {}, turn: { rolls: [] } };
    const call = args => h.tools.executeToolCall({ name: 'roll_dice', args }, ctx);
    assert.equal((await call({ reason: 'Pick the lock' })).ok, false);
    assert.equal(ctx.turn.rolls.length, 0);
    const result = await call({ reason: 'Pick the lock', difficulty: lockDifficulty });
    assert.equal(result.ok, true);
    const record = ctx.turn.rolls[0];
    assert.equal(record.difficulty, lockDifficulty);
    assert.equal(record.outcome, record.total === 1 ? 'complete failure' : record.total === 20 ? 'critical success' : '');
    assert.equal(record.outcomes, undefined);
    assert.ok(result.result.includes(lockDifficulty));
    assert.ok(result.result.includes(record.text));
});

test('binding dice consequences survive Skip and reach enforcement requirements', async () => {
    const pending = deferred();
    const h = await harness(agentSettings, async (_messages, index) => {
        if (index === 1) return { content: lockRoll };
        pending.resolve();
        return new Promise(() => {});
    }, { realAgent: true });
    const run = h.agent.runAgentLoop(agentOptions(h));
    await pending.promise;
    h.context.agentControls.onSkip();
    const result = await run;
    const outcome = result.turn.rolls[0].outcome;
    assert.ok(result.brief.includes(lockDifficulty));
    assert.ok(result.brief.includes(result.turn.rolls[0].text));
    assert.ok(h.pipeline.turnMustList().some(item => item.includes(outcome || lockDifficulty)));
});

test('expert consultation uses its chosen profile, receives context and returns advisory data only', async () => {
    const answer = { assessment: 'Possible with a delay.', reasons: ['The window is near.'], uncertainties: ['The guard may already be moving.'], alternatives: ['Stay behind cover.'] };
    const h = await harness({ ...agentSettings, expertProfileId: 'expert' }, async () => ({ content: JSON.stringify(answer) }), { realAgent: true });
    h.context.extensionSettings.connectionManager.profiles.push({ id: 'expert', mode: 'cc' });
    const ctx = { ...agentOptions(h), stepOutputs: { Assessment: 'Alice has an injured shoulder.' }, toolState: {}, turn: {} };
    const call = { name: 'consult_expert', args: { question: 'Could Alice reach the window?', context: 'The window is two metres away.', assumptions: 'The guard starts at the door.' } };
    const result = await h.tools.executeToolCall(call, ctx);
    assert.equal(result.ok, true);
    assert.match(result.result, /EXPERT ADVICE \(not established fact\)/);
    assert.equal(h.requests[0].id, 'expert');
    const prompt = h.requests[0].messages.map(message => message.content).join('\n');
    for (const text of [call.args.question, call.args.context, call.args.assumptions, ctx.stepOutputs.Assessment]) assert.ok(prompt.includes(text));
    assert.equal(JSON.stringify(ctx.turn), '{}');
    assert.equal(JSON.stringify(h.tools.getSceneState()), '{}');
    assert.equal((await h.tools.executeToolCall(call, ctx)).ok, false);
    assert.equal(h.requests.length, 1);
    assert.equal(h.tools.toolEnabled('consult_expert', { agentToolsEnabled: { consult_expert: false } }), false);
});

test('expert advice is retained in the next iteration without becoming a binding event', async () => {
    const advice = 'Consider the distance and the guard movement. '.repeat(40) + 'ADVICE END';
    const h = await harness(agentSettings, async (_messages, index) => ({ content: index === 1
        ? '<tool name="consult_expert">{"question":"Can Alice escape?","context":"There is a window nearby."}</tool>'
        : index === 2 ? JSON.stringify({ assessment: advice, reasons: [], uncertainties: [], alternatives: [] })
            : '<brief><must>Alice looks toward the window.</must></brief>' }), { realAgent: true });
    const result = await h.agent.runAgentLoop(agentOptions(h));
    assert.ok(h.requests[2].messages.some(message => message.content.includes(advice)));
    assert.ok(!result.brief.includes(advice));
    assert.equal(h.requests[1].id, 'model');
});

test('scene state persists established facts, supports removal and restores older facts on rewind', async () => {
    const h = await harness(agentSettings, undefined, { realAgent: true });
    h.savedChat[0].mes = 'Alice stands beside the door.';
    const ctx = { ...agentOptions(h), chat: h.savedChat, toolState: {}, turn: {} };
    const update = args => h.tools.executeToolCall({ name: 'update_scene', args }, ctx);
    assert.equal((await update({ key: 'Alice.position', value: 'beside the door', evidence: h.savedChat[0].mes })).ok, true);
    h.savedChat.push({ is_user: false, mes: 'Alice moves to the window.' });
    assert.equal((await update({ key: 'Alice.position', value: 'beside the window', evidence: h.savedChat[1].mes })).ok, true);
    assert.equal(h.tools.getSceneState()['Alice.position'], 'beside the window');
    // Metadata survives serialization; source edits/swipes make that revision inapplicable.
    h.context.chatMetadata = JSON.parse(JSON.stringify(h.context.chatMetadata));
    ctx.isCurrentChat = h.state.captureChatScope();
    h.savedChat[1].mes = 'Alice stays beside the door.';
    assert.equal(h.tools.getSceneState()['Alice.position'], 'beside the door');
    h.savedChat[1].mes = 'Alice moves to the window.';
    assert.equal(h.tools.getSceneState()['Alice.position'], 'beside the window');
    h.savedChat.push({ is_user: true, mes: 'Alice leaves the room.' });
    assert.equal((await update({ key: 'Alice.position', remove: true, evidence: h.savedChat[2].mes })).ok, true);
    assert.equal(h.tools.getSceneState()['Alice.position'], undefined);
    h.savedChat.splice(1);
    assert.equal(h.tools.getSceneState()['Alice.position'], 'beside the door');
    h.context.chatMetadata = {};
    assert.equal(JSON.stringify(h.tools.getSceneState()), '{}');
});

test('scene updates accept paraphrased or omitted evidence and retain revision tracking', async () => {
    const h = await harness(agentSettings, undefined, { realAgent: true });
    h.savedChat[0].mes = 'Alice stands beside the door.';
    const ctx = { ...agentOptions(h), chat: h.savedChat, toolState: {}, turn: {} };
    const update = args => h.tools.executeToolCall({ name: 'update_scene', args }, ctx);
    assert.equal((await update({ key: 'Alice.position', value: 'beside the door', evidence: 'Alice is by the entrance.' })).ok, true);
    h.savedChat.push({ is_user: false, mes: 'Alice moves to the window.' });
    assert.equal((await update({ key: 'Alice.position', value: 'beside the window' })).ok, true);
    assert.equal(h.tools.getSceneState()['Alice.position'], 'beside the window');
    h.savedChat.splice(1);
    assert.equal(h.tools.getSceneState()['Alice.position'], 'beside the door');
    assert.equal((await update({ key: 'Alice.position', remove: true })).ok, true);
    assert.equal(h.tools.getSceneState()['Alice.position'], undefined);
});

test('scene updates cannot persist in dry runs or disabled tools', async () => {
    const h = await harness(agentSettings, undefined, { realAgent: true });
    const ctx = { ...agentOptions(h), toolState: {}, turn: {} };
    const call = { name: 'update_scene', args: { key: 'location', value: 'courtyard' } };
    assert.equal((await h.tools.executeToolCall(call, { ...ctx, dryRun: true })).ok, false);
    h.state.getSettings().agentToolsEnabled.scene = false;
    assert.equal((await h.tools.executeToolCall(call, ctx)).ok, false);
    assert.equal(JSON.stringify(h.tools.getSceneState()), '{}');
});

test('new scene facts appear in the next planning prompt and persist across agent runs', async () => {
    const h = await harness(agentSettings, async (_messages, index) => ({ content: index === 1
        ? '<tool name="update_scene">{"key":"Alice.position","value":"beside the door","evidence":"Alice stands beside the door."}</tool>'
        : '<brief><must>Alice watches the door.</must></brief>' }), { realAgent: true });
    h.savedChat[0].mes = 'Alice stands beside the door.';
    await h.agent.runAgentLoop(agentOptions(h));
    assert.ok(h.requests[1].messages.some(message => message.content.includes('"Alice.position":"beside the door"')));
    await h.agent.runAgentLoop(agentOptions(h));
    assert.ok(h.requests[2].messages.some(message => message.content.includes('"Alice.position":"beside the door"')));
});

test('agent preserves full expansion context and reasoning in the display and following iteration', async () => {
    const expansion = 'Detailed assessment of the scene. '.repeat(100) + 'EXPANSION END: the key is under the rug.';
    const native = 'Considering the position of the key and the locked door. '.repeat(30) + 'NATIVE END';
    const taggedThought = 'Alice needs to check the rug before trying the lock. '.repeat(30) + 'THOUGHT END';
    const h = await harness({ ...agentSettings, expansionEnabled: true, steps: [step('Assessment', 'Assess this scene')] },
        async (_messages, index) => index === 1 ? { content: expansion } : index === 2
            ? { reasoning: native, content: `<think>${taggedThought}</think>${lockRoll}` }
            : { content: '<brief><must>Alice looks under the rug.</must></brief>' }, { realAgent: true });
    const result = await h.pipeline.runPipeline({ chat: [...h.savedChat] });
    for (const request of h.requests.slice(1)) {
        const prompt = request.messages.map(message => message.content).join('\n');
        assert.ok(prompt.includes('[EXPANSION'));
        assert.ok(prompt.includes(expansion));
    }
    const fullThought = `${native}\n\n${taggedThought}`;
    assert.ok(h.requests[2].messages.some(message => message.content.includes(fullThought)));
    assert.equal(result.agentTranscript.find(entry => entry.title === 'Agent thought · iteration 1').text, fullThought);
    assert.equal(h.context.activityEntries.find(entry => entry.title === 'Agent thought · iteration 1').text, fullThought);
});

test('agent displays native reasoning when no think tag is returned', async () => {
    const h = await harness(agentSettings, async () => ({ reasoning: 'The door is open, so Alice can enter.', content: '<brief><must>Alice enters.</must></brief>' }), { realAgent: true });
    const result = await h.agent.runAgentLoop(agentOptions(h));
    assert.equal(result.transcript[0].text, 'The door is open, so Alice can enter.');
});

test('agent waits beyond the old default deadline and can finish another iteration', async () => {
    const clock = { now: 1000 };
    const h = await harness(agentSettings, async (_messages, index) => {
        clock.now += 120000;
        return { content: index === 1 ? '<think>The key may be hidden under the rug.</think>' : '<brief><must>Alice checks the rug.</must></brief>' };
    }, { realAgent: true, clock });
    assert.equal(h.state.getSettings().agentTimeoutMs, 0);
    const result = await h.agent.runAgentLoop(agentOptions(h));
    assert.equal(h.requests.length, 2);
    assert.match(result.brief, /Alice checks the rug/);
    assert.ok(result.transcript.every(entry => !entry.title.includes('timeout')));
});

test('agent migrates the old default deadline once and preserves custom timeouts', async () => {
    for (const [saved, expected] of [[90000, 0], [45000, 45000], [0, 0]]) {
        const h = await harness({ ...agentSettings, agentTimeoutMs: saved });
        assert.equal(h.state.getSettings().agentTimeoutMs, expected);
        h.state.getSettings().agentTimeoutMs = 90000;
        h.state.loadSettings();
        assert.equal(h.state.getSettings().agentTimeoutMs, 90000);
    }
});

test('a configured agent deadline still cancels a pending response', async () => {
    const clock = { now: 1000 };
    const opened = deferred();
    const h = await harness({ ...agentSettings, agentTimeoutMs: 5000 }, async () => {
        clock.now += 6000;
        opened.resolve();
        return new Promise(() => {});
    }, { realAgent: true, clock });
    const run = h.agent.runAgentLoop(agentOptions(h));
    await opened.promise;
    const result = await run;
    assert.ok(h.requests[0].signal.aborted);
    assert.ok(result.transcript.some(entry => entry.title.includes('Agent timeout')));
    assert.equal(h.agent.isAgentBusy(), false);
});

test('real agent runs without expansion and injects only the brief into the chat copy', async () => {
    const h = await harness(agentSettings, async () => ({ content: '<think>PRIVATE THOUGHT</think><brief><must>Alice opens the door.</must></brief>' }), { realAgent: true });
    const core = [...h.savedChat];
    const result = await h.pipeline.runPipeline({ chat: core });
    assert.equal(result.agentRan, true);
    assert.match(result.brief, /Alice opens the door/);
    assert.ok(core.some(message => message.mes.includes('TURN BRIEF')));
    assert.ok(core.every(message => !message.mes.includes('PRIVATE THOUGHT')));
    assert.equal(h.savedChat.length, 1);
    assert.equal(h.pipeline.turnEnforcementActive(), true);
    assert.equal(h.pipeline.turnMustList().length, 1);
    assert.equal(h.context.eventSource.emit('stop'), undefined);
});

test('real agent enforces the total tool budget within one response', async () => {
    const calls = Array.from({ length: 3 }, () => lockRoll).join('\n');
    const h = await harness({ ...agentSettings, agentMaxToolCalls: 1 }, async (_messages, index) => ({ content: index === 1 ? calls : '<brief><must>Alice checks the lock.</must></brief>' }), { realAgent: true });
    const result = await h.agent.runAgentLoop(agentOptions(h));
    assert.equal(result.turn.toolCalls, 1);
    assert.equal(result.turn.rolls.length, 1);
    assert.match(result.brief, /d20 = \d+/);
});

test('real agent reuses an answer on continue without another tool call or popup', async () => {
    let popups = 0;
    const h = await harness(agentSettings, async (_messages, index) => ({ content: index === 1 ? '<tool name="ask_user">{"question":"Which door?","options":["Left","Right"]}</tool>' : '<brief><must>Alice waits beside the door.</must></brief>' }),
        { realAgent: true, onPopup(popup) { popups++; return popup.options.customButtons[0].result; } });
    const first = await h.agent.runAgentLoop(agentOptions(h));
    assert.equal(first.turn.answer.answer, 'Left');
    h.savedChat.push({ is_user: false, mes: 'Alice waits.' });
    const replay = await h.agent.runAgentLoop({ ...agentOptions(h), type: 'continue' });
    assert.match(replay.brief, /answered a question: "Left"/);
    assert.equal(popups, 1);
});

test('real agent filters refusal thoughts and retries once without leaking them', async () => {
    const h = await harness(agentSettings, async (_messages, index) => ({ content: index === 1 ? '<think>REFUSAL SECRET</think>I cannot assist with that.' : '<brief><must>Alice opens the door.</must></brief>' }), { realAgent: true });
    const result = await h.agent.runAgentLoop(agentOptions(h));
    assert.equal(h.requests.length, 2);
    assert.ok(!JSON.stringify(h.requests[1]).includes('REFUSAL SECRET'));
    assert.ok(!JSON.stringify(result).includes('REFUSAL SECRET'));
});

test('real agent dry run cannot write memory or consume its armed flag', async () => {
    const h = await harness({ ...agentSettings, agentMode: 'armed' }, async (_messages, index) => ({ content: index === 1 ? '<tool name="memory_create">{"title":"Promise","keys":["Alice"],"content":"Alice promised to return at dawn."}</tool>' : '<brief><must>Alice remembers the promise.</must></brief>' }), { realAgent: true });
    h.agent.armAgent();
    await h.agent.runAgentLoop({ ...agentOptions(h), dryRun: true });
    assert.equal(h.agent.isAgentArmed(), true);
    assert.equal(h.context.chatMetadata.world_info, undefined);
    assert.equal(h.world.world_names.length, 1);
});

test('memory preserves existing bindings, ownership, and complete deletion snapshots on undo', async () => {
    const h = await harness(agentSettings, undefined, { realAgent: true });
    h.context.chatMetadata.world_info = 'Existing';
    const ctx = { settings: h.state.getSettings(), turn: { memoryWrites: 0 }, toolState: {} };
    assert.equal((await h.tools.executeToolCall({ name: 'memory_delete', args: { id: '0' } }, ctx)).ok, false);
    const created = await h.tools.executeToolCall({ name: 'memory_create', args: { title: 'Promise', keys: ['Alice'], content: 'Alice promised to return at dawn.' } }, ctx);
    assert.equal(created.ok, true);
    h.world.books.Existing.entries[1].order = 432;
    const deleted = await h.tools.executeToolCall({ name: 'memory_delete', args: { id: '1' } }, ctx);
    assert.equal(deleted.ok, true);
    assert.equal(await h.tools.undoMemoryLogEntry(1), true);
    assert.equal(h.world.books.Existing.entries[1].order, 432);
    assert.equal(h.world.books.Existing.entries[1].smarttavern, true);
    assert.equal(h.context.chatMetadata.world_info, 'Existing');
    assert.equal(await h.tools.undoMemoryLogEntry(0), false);
    assert.ok(h.world.books.Existing.entries[1]);
    assert.equal(h.tools.memoryLog().length, 1);
});

test('chat-book creation chooses a unique name and never replaces a missing binding', async () => {
    const h = await harness(agentSettings, undefined, { realAgent: true });
    h.world.world_names.push('Chat Book test-chat');
    assert.equal(await h.tools.ensureChatBook(), 'Chat Book test-chat (1)');
    h.context.chatMetadata.world_info = 'Missing user book';
    assert.equal(await h.tools.ensureChatBook(), 'Missing user book');
    assert.equal(h.context.chatMetadata.world_info, 'Missing user book');
});

test('memory confirmation closes on stop and cannot commit afterward', async () => {
    const opened = deferred();
    const h = await harness({ ...agentSettings, agentMemoryMode: 'confirm' }, async () => ({ content: '<tool name="memory_create">{"title":"Promise","keys":["Alice"],"content":"Alice promised to return at dawn."}</tool>' }),
        { realAgent: true, onPopup() { opened.resolve(); return undefined; } });
    h.context.chatMetadata.world_info = 'Existing';
    const run = h.agent.runAgentLoop(agentOptions(h));
    await opened.promise;
    h.context.eventSource.emit('stop');
    assert.equal(await run, null);
    assert.equal(Object.keys(h.world.books.Existing.entries).length, 1);
});

test('skip thinking preserves completed binding rolls while discarding the pending model output', async () => {
    const opened = deferred(), late = deferred();
    const h = await harness(agentSettings, async (_messages, index) => {
        if (index === 1) return { content: lockRoll };
        opened.resolve();
        return late.promise;
    }, { realAgent: true });
    const run = h.agent.runAgentLoop(agentOptions(h));
    await opened.promise;
    h.context.agentControls.onSkip();
    const result = await run;
    assert.equal(result.turn.rolls.length, 1);
    assert.match(result.brief, /Dice \(binding, already rolled\): d20 =/);
    assert.equal(h.agent.isAgentBusy(), false);
    late.resolve({ content: '<brief><must>STALE RESULT</must></brief>' });
    assert.ok(!h.agent.getLastBrief().includes('STALE RESULT'));
});

test('tool-and-brief output is retained as fallback when the final iteration cannot finish', async () => {
    const h = await harness({ ...agentSettings, agentMaxIterations: 2 }, async (_messages, index) => ({ content: index === 1
        ? `${lockRoll}<brief><must>Alice checks the lock.</must></brief>`
        : 'no protocol' }), { realAgent: true });
    const result = await h.agent.runAgentLoop(agentOptions(h));
    assert.match(result.brief, /Alice checks the lock/);
    assert.match(result.brief, /d20 =/);
});

test('ask-user toggle is enforced by the registry', async () => {
    const h = await harness({ ...agentSettings, agentToolsEnabled: { ask_user: false } }, undefined, { realAgent: true });
    assert.equal(h.tools.toolEnabled('ask_user'), false);
    assert.ok(!h.tools.toolCatalog().includes('- ask_user('));
});

test('tail templates cannot place a story directive ahead of the agent brief', async () => {
    const directive = { text: '[SCENE DIRECTIVE] Alice must find the key.', must: 'Alice finds the key.' };
    const h = await harness({ ...agentSettings, expansionEnabled: true, injectAnchor: 'prompt-end', steps: [step('Assessment', 'Assess this scene')], tailPrompt: '{{story}}\n{{brief}}\n{{steps}}\nTEMPLATE FOOTER' },
        async (_messages, index) => ({ content: index === 1 ? 'Assessment output' : '<brief><must>Alice checks the lock.</must></brief>' }), { realAgent: true, directive });
    const result = await h.pipeline.runPipeline({ chat: [...h.savedChat] });
    assert.ok(result.injectionText.endsWith(`${result.brief}\n\n${directive.text}`));
    assert.equal(result.injectionText.split(directive.text).length, 2);
    assert.ok(result.injectionText.indexOf('Assessment output') < result.injectionText.indexOf(result.brief));
});

// The refinement contract (see the pass editor placeholder and the default presets):
// a revision arrives wrapped in <revised_reply>…</revised_reply>, or the pass answers
// <audit>PASS</audit> to keep the draft. Bare prose is a skip — the pipeline never
// adopts untagged output as the reply — so revision fixtures are wrapped.
const tagged = text => `<revised_reply>${text}</revised_reply>`;

// Surgical passes (editMode 'surgical'): the draft is sent as numbered paragraphs
// and the model returns only the paragraphs it changes, as <edit>/<delete>/<insert>.
const surgicalStep = (name, prompt) => ({ ...step(name, prompt), editMode: 'surgical' });

const multiDraft = [
    'Alice stood beside the open window, listening to the rain.',
    'She turned toward the door and quietly asked whether he would stay for dinner.',
    'The room smelled of fresh bread and wood smoke, and a small lamp glowed on the table.',
].join('\n\n');

test('paragraph splitting keeps fenced blocks atomic, trims, and falls back to lines', async () => {
    const { edits } = await harness();
    // JSON round-trips: the vm realm builds the arrays, deepEqual compares prototypes.
    const split = JSON.stringify(edits.splitParagraphs('A\n\nB\n\nC'));
    assert.equal(split, JSON.stringify({ paragraphs: ['A', 'B', 'C'], separators: ['\n\n', '\n\n'] }));
    assert.equal(JSON.stringify(edits.splitParagraphs('one\ntwo\nthree')), JSON.stringify({ paragraphs: ['one', 'two', 'three'], separators: ['\n', '\n'] }));
    assert.equal(JSON.stringify(edits.splitParagraphs('A\n\n\n\nB').separators), JSON.stringify(['\n\n']));
    assert.equal(JSON.stringify(edits.splitParagraphs('single paragraph')), JSON.stringify({ paragraphs: ['single paragraph'], separators: [] }));
    const fenced = edits.splitParagraphs('Intro\n\n```js\n\nconst x = 1;\n\n```\n\nOutro');
    assert.equal(JSON.stringify(fenced), JSON.stringify({ paragraphs: ['Intro', '```js\n\nconst x = 1;\n\n```', 'Outro'], separators: ['\n\n', '\n\n'] }));
    assert.equal(edits.numberedDraft('A\n\nB'), '<p id="1">A</p>\n\n<p id="2">B</p>');
});

test('edits, deletes and inserts apply with separators and breaks preserved', async () => {
    const { edits } = await harness();
    const blocks = edits.paragraphBlocks('A\n\nB\n\nC');
    const patch = edits.parseDraftEdits('<edit id="2">B2</edit>');
    assert.equal(edits.editIssues(patch, blocks).length, 0);
    assert.equal(edits.applyDraftEdits(patch, blocks), 'A\n\nB2\n\nC');
    const all = edits.parseDraftEdits('<edit id="1">A2</edit><delete id="2"/><insert after="3">D</insert>');
    assert.equal(edits.applyDraftEdits(all, blocks), 'A2\n\nC\n\nD');
    const front = edits.parseDraftEdits('<insert before="1">Start</insert>');
    assert.equal(edits.applyDraftEdits(front, blocks), 'Start\n\nA\n\nB\n\nC');
    const tail = edits.parseDraftEdits('<insert after="end">End</insert>');
    assert.equal(edits.applyDraftEdits(tail, blocks), 'A\n\nB\n\nC\n\nEnd');
    const junction = edits.parseDraftEdits('<delete id="1"/>');
    assert.equal(edits.applyDraftEdits(junction, blocks), 'B\n\nC');
    const lined = edits.paragraphBlocks('one\ntwo');
    const linePatch = edits.parseDraftEdits('<edit id="2">deux</edit>');
    assert.equal(edits.applyDraftEdits(linePatch, lined), 'one\ndeux');
});

test('the patch parser tolerates quoting, prose, fences and unclosed tags', async () => {
    const { edits } = await harness();
    const blocks = edits.paragraphBlocks('A\n\nB\n\nC');
    const quoted = edits.parseDraftEdits("prose preamble\n<edit id=1>\nX\n</edit>\ntail prose");
    assert.equal(edits.applyDraftEdits(quoted, blocks), 'X\n\nB\n\nC');
    const unclosed = edits.parseDraftEdits('<audit>reasoning</audit><edit id="3">C2</edit>');
    assert.equal(edits.applyDraftEdits(unclosed, blocks), 'A\n\nB\n\nC2');
    const fenced = edits.parseDraftEdits('```xml\n<delete id="1"></delete>\n```');
    assert.equal(edits.applyDraftEdits(fenced, blocks), 'B\n\nC');
    const thinking = edits.parseDraftEdits('<think>internal reasoning about ids</think><edit id="2">B2</edit>');
    assert.equal(edits.applyDraftEdits(thinking, blocks), 'A\n\nB2\n\nC');
});

test('echoed numbered drafts are repaired into edits in every shape', async () => {
    const { edits } = await harness();
    const blocks = edits.paragraphBlocks('A\n\nB\n\nC');
    const echoed = edits.parseDraftEdits('<p id="1">A</p>\n\n<p id="2">B!</p>\n\n<p id="3">C</p>');
    assert.equal(echoed.kind, 'ops');
    assert.equal(edits.applyDraftEdits(echoed, blocks), 'A\n\nB!\n\nC');
    const nested = edits.parseDraftEdits('<edit id="1"><p id="2">B2</p><p id="3">C2</p></edit>');
    assert.equal(edits.applyDraftEdits(nested, blocks), 'A\n\nB2\n\nC2');
    const wrapped = edits.parseDraftEdits('<revised_reply><p id="1">A</p><p id="2">B2</p><p id="3">C</p></revised_reply>');
    assert.equal(edits.applyDraftEdits(wrapped, blocks), 'A\n\nB2\n\nC');
    assert.equal(edits.parseDraftEdits('<audit>PASS</audit>').kind, 'pass');
});

test('invalid patches are rejected with actionable issues', async () => {
    const { edits } = await harness();
    const blocks = edits.paragraphBlocks('A\n\nB\n\nC');
    for (const [raw, fragment] of [
        ['<edit id="9">X</edit>', '9 is out of range'],
        ['<edit id="0">X</edit>', '0 is out of range'],
        ['<edit id="1">X</edit><delete id="1"/>', 'more than once'],
        ['<insert after="12">X</insert>', 'out of range'],
        ['<edit id="1"></edit>', /empty/i],
    ]) {
        const patch = edits.parseDraftEdits(raw);
        const issues = edits.editIssues(patch, blocks);
        assert.ok(issues.length, raw);
        if (typeof fragment === 'string') assert.ok(issues.join(' ').includes(fragment), `${raw} → ${issues}`);
        else assert.match(issues.join(' '), fragment);
    }
});

test('surgical passes send a numbered draft and apply only paragraph edits', async () => {
    const h = await harness({ savePassesAsSwipes: true, refinementSteps: [surgicalStep('Edit', 'Refine: {{draft}}')] },
        async () => ({ content: '<audit>check</audit>\n<edit id="2">She turned toward the door and softly asked whether he would stay for dinner.</edit>' }));
    const message = { name: 'Alice', mes: multiDraft, swipes: [multiDraft], swipe_id: 0 };
    h.savedChat.push(message);
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    const prompt = h.requests[0].messages.at(-1).content;
    assert.ok(prompt.includes('<p id="1">Alice stood beside the open window'));
    assert.ok(prompt.includes('<p id="3">The room smelled'));
    assert.equal(h.requests[0].messages[0].role, 'system');
    assert.match(h.requests[0].messages[0].content, /surgical prose editor/);
    assert.equal(result.changed, 1);
    assert.equal(message.mes, multiDraft.replace('quietly', 'softly'));
    assert.equal(message.swipes.length, 2);
    assert.equal(message.swipes[1], message.mes);
});

test('a surgical pass that changes nothing keeps the draft and records a skip', async () => {
    const h = await harness({ refinementSteps: [surgicalStep('Check', '{{draft}}')] }, async () => ({ content: '<audit>PASS</audit>' }));
    const message = { name: 'Alice', mes: multiDraft };
    h.savedChat.push(message);
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    assert.equal(result.changed, 0);
    assert.equal(message.mes, multiDraft);
    assert.equal(result.stepStats[0].skipped, true);
});

test('text replacements preserve surrounding prose and use original offsets in either order', async () => {
    const { edits } = await harness();
    const draft = 'Keep *this*. She stood.  He waited.\n\nUntouched.';
    const blocks = edits.paragraphBlocks(draft);
    for (const ops of [
        '<replace id="1"><find>She stood.</find><with>She sat.</with></replace><replace id="1"><find>He waited.</find><with>She stood.</with></replace>',
        '<replace id="1"><find>He waited.</find><with>She stood.</with></replace><replace id="1"><find>She stood.</find><with>She sat.</with></replace>',
    ]) {
        const patch = edits.parseDraftEdits(ops);
        assert.equal(edits.editIssues(patch, blocks).length, 0);
        assert.equal(edits.applyDraftEdits(patch, blocks), 'Keep *this*. She sat.  She stood.\n\nUntouched.');
    }
    const deletion = edits.parseDraftEdits('<replace id="1"><find>  He waited.</find><with></with></replace>');
    assert.equal(edits.applyDraftEdits(deletion, blocks), 'Keep *this*. She stood.\n\nUntouched.');
    const literal = edits.parseDraftEdits('<replace id="1"><find>*this*</find><with> $& <em>that</em> </with></replace>');
    assert.equal(edits.applyDraftEdits(literal, blocks), 'Keep  $& <em>that</em> . She stood.  He waited.\n\nUntouched.');
});

test('unsafe text replacements are rejected atomically', async () => {
    const { edits } = await harness();
    const blocks = edits.paragraphBlocks('One. One. Two.');
    const replace = (find, body = 'Changed.') => `<replace id="1"><find>${find}</find><with>${body}</with></replace>`;
    for (const [raw, issue] of [
        [replace('Absent.'), /not found/],
        [replace('One.'), /ambiguous/],
        [replace(''), /non-empty/],
        ['<replace id="1"><find>Two.</find></replace>', /<with>/],
        ['<replace><find>Two.</find><with>Three.</with></replace>', /out of range/],
        [replace('Two.') + replace('Two.'), /overlap/],
        [replace('One. One.') + replace('One. Two.'), /overlap/],
        [replace('Two.') + '<edit id="1">Rewritten.</edit>', /more than once/],
        ['<delete id="1"/>' + replace('Two.'), /mixes/],
    ]) {
        const patch = edits.parseDraftEdits(raw);
        assert.match(edits.editIssues(patch, blocks).join(' '), issue, raw);
        assert.equal(edits.applyDraftEdits(patch, blocks), null, raw);
    }
});

test('surgical pipeline saves exact text replacements and passes the updated draft onward', async () => {
    const h = await harness({ savePassesAsSwipes: true, refinementSteps: [surgicalStep('Edit', '{{draft}}'), surgicalStep('Check', '{{draft}}')] },
        async (_messages, index) => ({ content: index === 1
            ? '<replace id="2"><find>quietly</find><with>softly</with></replace>'
            : '<audit>PASS</audit>' }));
    const message = { name: 'Alice', mes: multiDraft, swipes: [multiDraft], swipe_id: 0 };
    h.savedChat.push(message);
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    assert.match(h.requests[0].messages[0].content, /<replace id="N">/);
    assert.ok(h.requests[1].messages.at(-1).content.includes('softly'));
    assert.equal(result.changed, 1);
    assert.equal(message.mes, multiDraft.replace('quietly', 'softly'));
    assert.equal(message.swipes[1], message.mes);
});

test('surgical passes accept a full revised_reply as an escape hatch', async () => {
    const h = await harness({ refinementSteps: [surgicalStep('Edit', '{{draft}}')] },
        async () => ({ content: tagged(multiDraft.replace('open window', 'half-open window')) }));
    const message = { name: 'Alice', mes: multiDraft };
    h.savedChat.push(message);
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    assert.equal(result.changed, 1);
    assert.ok(message.mes.includes('half-open window'));
    assert.ok(!message.mes.includes('<p id='));
});

test('an out-of-range surgical patch is rejected, reviewed and can recover', async () => {
    let popups = 0;
    const h = await harness({ refinementSteps: [surgicalStep('Edit', '{{draft}}')] },
        async (_messages, index) => ({ content: index === 1 ? '<edit id="9">Text.</edit>' : '<edit id="1">Fixed.</edit>' }),
        { onPopup(popup) {
            popups++;
            assert.ok(popup.content.children[1].textContent.includes('9'));
            return 1;
        } });
    const message = { name: 'Alice', mes: 'One paragraph only.' };
    h.savedChat.push(message);
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    assert.equal(popups, 1);
    assert.equal(result.stepStats[0].attempts, 2);
    assert.equal(message.mes, 'Fixed.');
});

test('later passes build on the patched draft and full passes see plain text', async () => {
    const h = await harness({ refinementSteps: [surgicalStep('S', '{{draft}}'), step('F', '{{draft}}')] },
        async (_messages, index) => ({ content: index === 1
            ? '<insert after="end">A new final line.</insert>'
            : tagged('FULL REWRITE OF THE PATCHED DRAFT') }));
    const message = { name: 'Alice', mes: 'First.\n\nSecond.' };
    h.savedChat.push(message);
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    assert.ok(h.requests[0].messages.at(-1).content.includes('<p id="1">First.'));
    const secondPrompt = h.requests[1].messages.at(-1).content;
    assert.ok(secondPrompt.includes('A new final line.'));
    assert.ok(!secondPrompt.includes('<p id='));
    assert.equal(result.workingDraft, 'FULL REWRITE OF THE PATCHED DRAFT');
});

test('legacy default refinement prompts migrate to surgical; custom prompts stay full', async () => {
    const custom = { name: 'My Custom Pass', enabled: true, role: 'assistant', profileId: '', lookback: null, prompt: 'My own contract for {{draft}}.' };
    const probe = await harness();
    const legacySteps = probe.state.LEGACY_REFINEMENT_STEPS.map(s => ({ ...s, enabled: true, role: 'assistant', profileId: '', lookback: null }));
    const h = await harness({ refinementSteps: [...legacySteps, custom] });
    const steps = h.state.getSettings().refinementSteps;
    for (const migrated of steps.slice(0, 3)) {
        assert.equal(migrated.editMode, 'surgical');
        assert.ok(migrated.prompt.includes('<edit id='));
    }
    assert.equal(steps[3].editMode, 'full');
    assert.equal(steps[3].prompt, custom.prompt);
    assert.equal(h.state.getSettings().refinementContractVersion, 2);
});

test('saved paragraph presets upgrade to text replacements while custom prompts and routing survive', async () => {
    const probe = await harness();
    const saved = probe.state.LEGACY_SURGICAL_REFINEMENT_STEPS.map(s => ({ ...s, profileId: 'editor', lookback: 2 }));
    const custom = { ...saved[0], prompt: saved[0].prompt + '\nMy custom rule.' };
    const h = await harness({ refinementContractVersion: 2, refinementSteps: [...saved, custom] });
    const settings = h.state.getSettings();
    for (const step of settings.refinementSteps.slice(0, 3)) {
        assert.ok(step.prompt.includes('<replace id="N">'));
        assert.ok(!step.prompt.includes('First reason briefly'));
        assert.equal(step.profileId, 'editor');
        assert.equal(step.lookback, 2);
    }
    assert.equal(settings.refinementSteps[3].prompt, custom.prompt);
    assert.equal(settings.refinementTextEditsVersion, 1);
});

test('dry run surgical passes validate patches without mutating chat', async () => {
    const h = await harness({ refinementSteps: [surgicalStep('Edit', '{{draft}}')] },
        async () => ({ content: '<edit id="1">Revised.</edit>' }));
    const message = { name: 'Alice', mes: 'Original one.\n\nOriginal two.' };
    h.savedChat.push(message);
    const result = await h.pipeline.runRefinementPipeline(1, { dryRun: true });
    assert.equal(result.workingDraft, 'Revised.\n\nOriginal two.');
    assert.equal(message.mes, 'Original one.\n\nOriginal two.');
    assert.equal(message.extra, undefined);
});

const proseDraft = 'Alice stood beside the open window, listening to the rain. She turned toward the door and quietly asked whether he would stay for dinner. The room smelled of fresh bread and wood smoke, and a small lamp glowed on the table.';

test('refinement checks only require non-empty output or an explicit audit PASS', async () => {
    const { checks } = await harness();
    for (const raw of ['', '   ', '<revised_reply> </revised_reply>', '<final_reply></final_reply>', '<audit>FAIL</audit>']) {
        assert.ok(checks.refinementIssues(raw).length, raw);
    }
    for (const raw of ['...', '[unchanged]', '<revised_reply>Missing closing tag', proseDraft.slice(0, 20), proseDraft.repeat(3), 'Completely different scene.', '<audit>PASS</audit>']) {
        assert.equal(checks.refinementIssues(raw).length, 0, raw);
    }
});

test('a rejected refinement retries the same pass without changing the draft or its swipes', async () => {
    let popups = 0;
    const revised = proseDraft.replace('quietly', 'softly');
    const h = await harness({ savePassesAsSwipes: true, refinementSteps: [step('Edit', '{{draft}}')] },
        async (_messages, index) => ({ content: index === 1 ? '<revised_reply></revised_reply>' : tagged(revised) }),
        { onPopup(popup) {
            popups++;
            assert.equal(message.mes, proseDraft);
            assert.deepEqual(message.swipes, [proseDraft]);
            assert.equal(popup.options.okButton, 'Retry pass');
            assert.ok(popup.content.children[1].textContent.includes('empty'));
            return 1;
        } });
    const message = { name: 'Alice', mes: proseDraft, swipes: [proseDraft], swipe_id: 0 };
    h.savedChat.push(message);
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    assert.equal(popups, 1);
    assert.equal(h.requests.length, 2);
    assert.deepEqual(h.requests[0].messages, h.requests[1].messages);
    assert.equal(message.mes, revised);
    assert.equal(message.swipes.length, 2);
    assert.equal(result.stepStats[0].attempts, 2);
});

test('declining retry skips the rejected pass and the next pass receives the accepted draft', async () => {
    const h = await harness({ refinementSteps: [step('Bad', '{{draft}}'), step('Next', '{{draft}} {{step:Bad}}')] },
        async (_messages, index) => ({ content: index === 1 ? '<revised_reply></revised_reply>' : '<audit>PASS</audit>' }));
    h.savedChat.push({ name: 'Alice', mes: proseDraft });
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    assert.equal(result.workingDraft, proseDraft);
    assert.equal(result.stepStats[0].skipped, true);
    assert.equal(result.stepOutputs.Bad, undefined);
    assert.equal(h.requests[1].messages.at(-1).content.trim(), proseDraft);
});

for (const decision of ['accept', 'retry', 'skip']) {
    test(`reviewing a failed pass supports ${decision} without applying it prematurely`, async () => {
        const failed = '<audit>FAIL: <img src=x onerror=alert(1)></audit>';
        const revised = proseDraft.replace('quietly', 'softly');
        let popups = 0;
        const h = await harness({ savePassesAsSwipes: true, refinementSteps: [step('Edit', '{{draft}}')] },
            async (_messages, index) => ({ content: index === 1 ? failed : tagged(revised) }),
            { onPopup(popup) {
                popups++;
                assert.equal(message.mes, proseDraft);
                assert.deepEqual(message.swipes, [proseDraft]);
                if (popups === 1) {
                    assert.equal(popup.options.customButtons[0].text, 'Review');
                    return 1001;
                }
                assert.equal(popup.options.okButton, 'Accept');
                assert.equal(popup.options.cancelButton, 'Skip Pass');
                assert.equal(popup.options.customButtons[0].text, 'Retry');
                assert.equal(popup.content.children[2].textContent, failed);
                return { accept: 1, retry: 1001, skip: 0 }[decision];
            } });
        const message = { name: 'Alice', mes: proseDraft, swipes: [proseDraft], swipe_id: 0 };
        h.savedChat.push(message);
        h.pipeline.markFreshGeneration();
        const result = await h.pipeline.runRefinementPipeline(1);
        assert.equal(popups, 2);
        assert.equal(h.requests.length, decision === 'retry' ? 2 : 1);
        assert.equal(message.mes, decision === 'retry' ? revised : proseDraft);
        if (decision === 'skip') assert.equal(result.stepStats[0].skipped, true);
        else if (decision === 'retry') assert.equal(result.stepOutputs.Edit, tagged(revised));
        // Accept keeps the last accepted draft; the audit-only failure carries no
        // revised payload, so the pass records as skipped with empty output.
        else assert.equal(result.stepOutputs.Edit, '');
    });
}

for (const action of ['stop', 'chat', 'skip', 'enough']) {
    test(`a pending review window is dismissed by ${action}`, async () => {
        const opened = deferred();
        let popups = 0;
        const h = await harness({ refinementSteps: [step('Bad', '{{draft}}')] },
            async () => ({ content: '<revised_reply></revised_reply>' }),
            { onPopup() {
                if (++popups === 1) return 1001;
                opened.resolve();
                return undefined;
            } });
        h.savedChat.push({ name: 'Alice', mes: proseDraft });
        h.pipeline.markFreshGeneration();
        const run = h.pipeline.runRefinementPipeline(1);
        await opened.promise;
        if (action === 'skip') h.pipeline.skipRefinementStep();
        else if (action === 'enough') h.pipeline.stopRefinement();
        else h.context.eventSource.emit(action);
        const result = await run;
        assert.equal(h.savedChat[1].mes, proseDraft);
        assert.equal(h.pipeline.isRefinementBusy(), false);
        if (action === 'skip') assert.equal(result.stepStats[0].skipped, true);
        else if (action === 'enough') assert.equal(result.stopped, true);
        else assert.equal(result, null);
    });
}

test('empty provider output is reviewed without automatic fallback or retries', async () => {
    let popups = 0;
    const h = await harness({ genRetries: 2, refinementSteps: [step('Edit', '{{draft}}')] },
        async () => ({ content: '' }), { onPopup(popup) {
            if (++popups === 1) return 1001;
            assert.equal(popup.content.children[2].textContent, '(No output returned)');
            return 1;
        } });
    h.savedChat.push({ name: 'Alice', mes: proseDraft });
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    assert.equal(h.requests.length, 1);
    assert.equal(popups, 2);
    assert.equal(result.workingDraft, proseDraft);
});

test('refinement accepts repeated non-empty output without generic degeneration filters', async () => {
    const output = '!'.repeat(500);
    const h = await harness({ refinementSteps: [step('Edit', '{{draft}}')] }, async () => ({ content: tagged(output) }),
        { onPopup() { assert.fail('Non-empty output must not be rejected'); } });
    h.savedChat.push({ name: 'Alice', mes: proseDraft });
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    assert.equal(result.workingDraft, output);
    assert.equal(h.requests.length, 1);
});

test('a retried pass waits for the full streamed reply before checking partial output', async () => {
    const streaming = deferred(), finish = deferred();
    const revised = proseDraft.replace('quietly', 'softly');
    let popups = 0;
    const h = await harness({ refinementSteps: [step('Edit', '{{draft}}')] },
        async (_messages, index) => {
            if (index === 1) return { content: '<revised_reply></revised_reply>' };
            return async function* () {
                yield { text: '<revised_reply>', state: { reasoning: 'Checking the scene.' } };
                streaming.resolve();
                await finish.promise;
                yield { text: `<revised_reply>${revised}</revised_reply>` };
            };
        }, { onPopup() { popups++; return 1; } });
    const message = { name: 'Alice', mes: proseDraft };
    h.savedChat.push(message);
    h.pipeline.markFreshGeneration();
    let completed = false;
    const run = h.pipeline.runRefinementPipeline(1).then(result => { completed = true; return result; });
    await streaming.promise;
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(completed, false);
    assert.equal(popups, 1);
    assert.equal(h.requests.length, 2);
    assert.equal(message.mes, proseDraft);
    finish.resolve();
    const result = await run;
    assert.equal(popups, 1);
    assert.equal(message.mes, revised);
    assert.equal(result.stepStats[0].attempts, 2);
});

test('a streamed profiled request can be cancelled while waiting for more tokens', async () => {
    const streaming = deferred(), finish = deferred();
    const h = await harness({}, async () => (async function* () {
        yield { text: 'Partial' };
        streaming.resolve();
        await finish.promise;
        yield { text: 'Completed response' };
    })());
    const controller = new AbortController();
    const run = h.gen.generateWithRetry({ profileId: 'model', signal: controller.signal });
    await streaming.promise;
    controller.abort(new DOMException('Stopped', 'AbortError'));
    await assert.rejects(run, { name: 'AbortError' });
    finish.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(h.requests.length, 1);
});

test('exhausted generation errors offer a manual retry of the same refinement pass', async () => {
    let popups = 0;
    const h = await harness({ refinementSteps: [step('Edit', '{{draft}}')] }, async (_messages, index) => {
        if (index === 1) throw new Error('Provider unavailable');
        return { content: '<audit>PASS</audit>' };
    }, { onPopup(popup) {
        popups++;
        assert.ok(popup.content.children[1].textContent.includes('Generation failed'));
        return 1;
    } });
    h.context.generateRaw = async () => { throw new Error('Fallback unavailable'); };
    h.savedChat.push({ name: 'Alice', mes: proseDraft });
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    assert.equal(popups, 1);
    assert.equal(result.workingDraft, proseDraft);
    assert.equal(result.stepStats[0].attempts, 2);
});

test('dry runs validate replies without mutating chat, and multilingual punctuation edits pass', async () => {
    const h = await harness({ refinementSteps: [step('Edit', '{{draft}}')] }, async () => ({ content: '<revised_reply></revised_reply>' }));
    const message = { name: 'Alice', mes: proseDraft };
    h.savedChat.push(message);
    const result = await h.pipeline.runRefinementPipeline(1, { dryRun: true });
    assert.equal(result.stepStats[0].skipped, true);
    assert.equal(message.mes, proseDraft);
    assert.equal(message.extra, undefined);
    const chinese = '她站在窗边听着细雨，转过头来轻声问他是否愿意留下来一起吃晚饭。房间里飘着面包的香气，桌上的小灯散发着温柔的光芒。'.repeat(4);
    const edited = chinese.replaceAll('，', '。');
    assert.equal(h.checks.refinementIssues(edited, edited, chinese, chinese).length, 0);
    const cased = proseDraft.toUpperCase().replaceAll(' ', '\n\n');
    assert.equal(h.checks.refinementIssues(cased, cased, proseDraft, proseDraft).length, 0);
});

for (const veiled of [true, false]) {
    test(`skipping an in-flight pass continues and discards late output (veiled: ${veiled})`, async () => {
        const started = deferred(), response = deferred();
        const h = await harness({ refinementSteps: [step('Slow', '{{draft}}'), step('Next', '{{draft}}')] },
            async (_messages, index) => { if (index === 1) { started.resolve(); return response.promise; } return { content: '<audit>PASS</audit>' }; }, { veiled });
        const message = { name: 'Alice', mes: proseDraft };
        h.savedChat.push(message);
        h.pipeline.markFreshGeneration();
        const run = h.pipeline.runRefinementPipeline(1);
        await started.promise;
        assert.equal(h.pipeline.skipRefinementStep(), true);
        const result = await run;
        assert.equal(result.stepStats[0].skipped, true);
        assert.equal(result.stopped, false);
        assert.equal(h.requests.length, 2);
        assert.equal(h.requests[0].signal.aborted, true);
        response.resolve({ content: 'Late garbage' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(message.mes, proseDraft);
        assert.equal(h.pipeline.skipRefinementStep(), false);
    });
}

for (const action of ['stop', 'chat', 'skip', 'enough']) {
    test(`a pending rejection popup is dismissed by ${action}`, async () => {
        const opened = deferred();
        const h = await harness({ refinementSteps: [step('Bad', '{{draft}}')] }, async () => ({ content: '<revised_reply></revised_reply>' }),
            { onPopup() { opened.resolve(); return undefined; } });
        h.savedChat.push({ name: 'Alice', mes: proseDraft });
        h.pipeline.markFreshGeneration();
        const run = h.pipeline.runRefinementPipeline(1);
        await opened.promise;
        if (action === 'skip') h.pipeline.skipRefinementStep();
        else if (action === 'enough') h.pipeline.stopRefinement();
        else h.context.eventSource.emit(action);
        const result = await run;
        assert.equal(h.savedChat[1].mes, proseDraft);
        assert.equal(h.pipeline.isRefinementBusy(), false);
        if (action === 'skip') assert.equal(result.stepStats[0].skipped, true);
        else if (action === 'enough') assert.equal(result.stopped, true);
        else assert.equal(result, null);
    });
}

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('internal model calls cannot mark a reply fresh or clear refinement metadata', async () => {
    const h = await harness();
    const message = { name: 'Alice', mes: 'Reply', extra: { smarttavernRefined: true } };
    h.savedChat.push(message);
    await h.gen.withInternalGeneration(() => h.pipeline.smarttavernInterceptor(h.savedChat));
    assert.equal(h.pipeline.hasFreshReply(), false);
    assert.equal(message.extra.smarttavernRefined, true);
    assert.equal(h.requests.length, 0);
});

test('cancelled generations and invalid render events do not refine old messages', async () => {
    const h = await harness({ refinementSteps: [step('Edit', '{{draft}}')] });
    h.savedChat.push({ name: 'Alice', mes: 'Draft' });
    h.pipeline.markFreshGeneration();
    assert.equal(await h.pipeline.runRefinementPipeline(0), null);
    assert.equal(h.pipeline.hasFreshReply(), true);
    h.pipeline.cancelFreshReply();
    assert.equal(await h.pipeline.runRefinementPipeline(1), null);
    assert.equal(h.requests.length, 0);
});

for (const change of ['chat', 'edit', 'swipe', 'delete', 'stop', 'disable']) {
    test(`refinement discards an in-flight result after ${change}`, async () => {
        const started = deferred();
        const response = deferred();
        const h = await harness({ refinementSteps: [step('Edit', '{{draft}}')] }, () => {
            started.resolve();
            return response.promise;
        });
        const message = { name: 'Alice', mes: 'Draft', swipe_id: 0, swipes: ['Draft', 'Other'] };
        h.savedChat.push(message);
        let saves = 0;
        h.context.saveChat = async () => { saves++; };
        h.pipeline.markFreshGeneration();
        const run = h.pipeline.runRefinementPipeline(1);
        await started.promise;
        if (change === 'chat') { h.context.chat = []; h.context.chatMetadata = {}; }
        if (change === 'edit') message.mes = 'Manual edit';
        if (change === 'swipe') message.swipe_id = 1;
        if (change === 'delete') h.savedChat.splice(1, 1);
        if (change === 'stop') h.pipeline.cancelFreshReply();
        if (change === 'disable') h.state.getSettings().enabled = false;
        response.resolve({ content: 'Stale revision' });
        assert.equal(await run, null);
        assert.equal(message.mes, change === 'edit' ? 'Manual edit' : 'Draft');
        assert.equal(saves, 0);
        assert.equal(h.pipeline.isRefinementBusy(), false);
    });
}

test('refinement persists edits in the selected swipe without adding revisions', async () => {
    const h = await harness({ savePassesAsSwipes: false, refinementSteps: [step('Edit', '{{draft}}')] }, async () => ({ content: tagged('Revised') }));
    const message = { name: 'Alice', mes: 'Draft', swipe_id: 1, swipes: ['Earlier', 'Draft'] };
    h.savedChat.push(message);
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    assert.equal(result.changed, 1);
    assert.equal(message.mes, 'Revised');
    assert.deepEqual(message.swipes, ['Earlier', 'Revised']);
});

for (const veiled of [true, false]) {
    test(`refinement preserves existing swipes and aligns metadata (veiled: ${veiled})`, async () => {
        const h = await harness({ savePassesAsSwipes: true, refinementSteps: [step('A', '{{draft}}'), step('B', '{{draft}}')] },
            async (_messages, index) => ({ content: tagged(`Revision ${index}`) }), { veiled });
        const message = { name: 'Alice', mes: 'Draft', swipe_id: 0, swipes: ['Draft', 'Alternative'],
            swipe_info: [{ extra: { marker: 'first' } }, { extra: { marker: 'second' } }] };
        h.savedChat.push(message);
        h.pipeline.markFreshGeneration();
        await h.pipeline.runRefinementPipeline(1);
        assert.equal(message.mes, 'Revision 2');
        assert.equal(message.swipes[message.swipe_id], 'Revision 2');
        assert.deepEqual(message.swipes.slice(0, 2), ['Draft', 'Alternative']);
        assert.equal(message.swipes.length, veiled ? 3 : 4);
        assert.equal(message.swipe_info.length, message.swipes.length);
        assert.equal(message.swipe_info[1].extra.marker, 'second');
    });
}

test('valid profile writes still persist and a later update merges missing fields', async () => {
    const h = await harness({ fields: [{ name: 'Summary' }, { name: 'Values' }], profileUpdateProfileId: 'model' },
        async (_messages, index) => ({ content: index === 1 ? '{"Summary":"Original","Values":"Stable"}' : '{"Summary":"Updated"}' }));
    await h.profiles.bootstrapProfile(h.context.characters[0], { notify: false });
    const record = await h.profiles.updateProfile(h.context.characters[0], { notify: false });
    assert.equal(record.fields.Summary, 'Updated');
    assert.equal(record.fields.Values, 'Stable');
    assert.equal(h.state.getStoredProfile('alice.png'), record);
});

for (const operation of ['bootstrap', 'update']) {
    for (const change of ['chat', 'edit', 'reset']) {
        test(`${operation} discards a stale profile after ${change}`, async () => {
            const started = deferred();
            const response = deferred();
            const h = await harness({ fields: [{ name: 'Summary' }], profileUpdateProfileId: 'model' }, () => {
                started.resolve();
                return response.promise;
            });
            const record = { fields: { Summary: 'Original' }, updatedAt: 0 };
            h.state.setStoredProfile('alice.png', record);
            const run = operation === 'bootstrap'
                ? h.profiles.bootstrapProfile(h.context.characters[0], { notify: false })
                : h.profiles.updateProfile(h.context.characters[0], { notify: false });
            await started.promise;
            if (change === 'chat') { h.context.chat = []; h.context.chatMetadata = {}; }
            if (change === 'edit') record.fields.Summary = 'Manual';
            if (change === 'reset') h.profiles.resetProfile('alice.png');
            response.resolve({ content: '{"Summary":"Stale"}' });
            assert.equal(await run, null);
            assert.equal(h.state.getStoredProfile('alice.png'), change === 'edit' ? record : null);
            assert.equal(record.fields.Summary, change === 'edit' ? 'Manual' : 'Original');
        });
    }
}

test('expansion cannot stage a prompt tail for a chat opened while steps were running', async () => {
    const started = deferred();
    const response = deferred();
    const h = await harness({ injectAnchor: 'prompt-end', steps: [step('A', 'TASK')] }, () => {
        started.resolve();
        return response.promise;
    });
    const coreChat = [...h.savedChat];
    const run = h.pipeline.runPipeline({ chat: coreChat });
    await started.promise;
    h.context.chat = [];
    h.context.chatMetadata = {};
    response.resolve({ content: 'Old chat notes' });
    assert.equal(await run, null);
    assert.equal(coreChat.length, 1);
});

test('injects generated output as assistant, keeps prompts and saved chat untouched', async () => {
    const h = await harness({ steps: [step('Body', 'PRIVATE TASK INSTRUCTIONS')] });
    const coreChat = [...h.savedChat];
    await h.pipeline.runPipeline({ chat: coreChat });
    const injected = coreChat.filter(message => message.smarttavern_ephemeral);
    assert.equal(injected.length, 1);
    assert.equal(injected[0].is_user, false);
    assert.equal(injected[0].is_system, false);
    assert.equal(injected[0].name, 'Alice');
    assert.match(injected[0].mes, /GENERATED ASSESSMENT/);
    assert.doesNotMatch(injected[0].mes, /PRIVATE TASK INSTRUCTIONS/);
    assert.equal(h.requests[0].messages.at(-1).role, 'user');
    assert.equal(h.savedChat.length, 1);
});

test('migrates old prompt roles once, then respects output roles in pipeline order', async () => {
    const h = await harness({ steps: [step('A', 'TASK A', 'system'), step('B', 'TASK B', 'user')] });
    assert.deepEqual(Array.from(h.state.getSettings().steps, item => item.role), ['assistant', 'assistant']);
    h.state.getSettings().steps[0].role = 'system';
    h.state.getSettings().steps[1].role = 'user';
    h.state.loadSettings();
    const coreChat = [...h.savedChat];
    await h.pipeline.runPipeline({ chat: coreChat });
    assert.equal(coreChat[0].extra.type, 'narrator');
    assert.equal(coreChat[1].is_user, true);
    assert.match(coreChat[0].mes, /\[A\]/);
    assert.match(coreChat[1].mes, /\[B\]/);
    assert.ok(h.requests.every(request => request.messages.at(-1).role === 'user'));
});

test('independent calls overlap, macro dependencies wait and use completed output', async () => {
    let running = 0;
    let maximum = 0;
    let finishFirst;
    let startedSecond;
    const secondStarted = new Promise(resolve => { startedSecond = resolve; });
    const firstGate = new Promise(resolve => { finishFirst = resolve; });
    const h = await harness({ steps: [step('A', 'TASK A'), step('B', 'TASK B'), step('C', '{{step:A}} / {{steps}}')] }, async (messages, index) => {
        maximum = Math.max(maximum, ++running);
        if (index === 1) await firstGate;
        if (index === 2) { startedSecond(); finishFirst(); }
        running--;
        return { content: `OUTPUT ${index}` };
    });
    const run = h.pipeline.runPipeline({ inject: false });
    await secondStarted;
    const result = await run;
    assert.equal(maximum, 2);
    assert.match(h.requests[2].messages.at(-1).content, /OUTPUT 1/);
    assert.match(h.requests[2].messages.at(-1).content, /OUTPUT 2/);
    assert.equal(result.stepOutputs.C, 'OUTPUT 3');
});

test('forward references remain empty and sequential mode is available', async () => {
    const h = await harness({ stepExecution: 'sequential', steps: [step('A', 'TASK {{step:B}}'), step('B', 'TASK B')] });
    await h.pipeline.runPipeline({ inject: false });
    assert.equal(h.requests[0].messages.at(-1).content, 'TASK ');
    assert.equal(h.requests[1].messages.at(-1).content, 'TASK B');
});

test('removes legacy final-pass config and never makes a consolidation call', async () => {
    const h = await harness({ steps: [step('A', 'PRIVATE TASK')], finalStep: { enabled: true, profileId: 'model', prompt: 'CONSOLIDATE {{steps}}', mode: 'replace' } });
    const result = await h.pipeline.runPipeline({ inject: false });
    assert.equal(h.requests.length, 1);
    assert.equal(Object.hasOwn(h.state.getSettings(), 'finalStep'), false);
    assert.equal(Object.hasOwn(result, 'finalOutput'), false);
    assert.match(result.injectionText, /GENERATED ASSESSMENT/);
});

test('empty results inject nothing, and subsequent runs sweep earlier ephemeral blocks', async () => {
    const h = await harness({ steps: [step('A', 'TASK')] }, async () => ({ content: '' }));
    h.context.generateRaw = async () => '';
    const coreChat = [...h.savedChat];
    await h.pipeline.runPipeline({ chat: coreChat });
    assert.equal(coreChat.length, 1);
    coreChat.unshift({ smarttavern_ephemeral: true, mes: 'OLD OUTPUT' });
    await h.pipeline.runPipeline({ chat: coreChat });
    assert.equal(coreChat.length, 1);
});

test('failed calls release the internal guard and a later run can recover', async () => {
    const h = await harness({ steps: [step('A', 'TASK')] }, async () => { throw new Error('Provider unavailable'); });
    h.context.generateRaw = async () => { throw new Error('Fallback unavailable'); };
    const first = await h.pipeline.runPipeline({ inject: false });
    assert.equal(first.stepOutputs.A, '');
    h.context.generateRaw = async () => 'RECOVERED OUTPUT';
    const next = await h.pipeline.runPipeline({ inject: false });
    assert.equal(next.stepOutputs.A, 'RECOVERED OUTPUT');
});

test('active fallback requests serialize shared generateRaw state', async () => {
    const h = await harness({ steps: [step('A', 'A'), step('B', 'B')] });
    for (const item of h.state.getSettings().steps) item.profileId = '';
    let running = 0;
    let maximum = 0;
    h.context.generateRaw = async () => {
        maximum = Math.max(maximum, ++running);
        await Promise.resolve();
        running--;
        return 'ACTIVE OUTPUT';
    };
    await h.pipeline.runPipeline({ inject: false });
    assert.equal(maximum, 1);
    assert.equal(h.requests.length, 0);
});

test('migrates to prompt-end once and preserves subsequent placement choices', async () => {
    const h = await harness({ promptTailVersion: undefined, injectAnchor: 'depth' });
    assert.equal(h.state.getSettings().injectAnchor, 'prompt-end');
    h.state.getSettings().injectAnchor = 'top-of-history';
    h.state.loadSettings();
    assert.equal(h.state.getSettings().injectAnchor, 'top-of-history');
});

for (const role of ['assistant', 'user', 'system']) {
    test(`assembles a budgeted tail, then sends it last as ${role}`, async () => {
        const h = await harness({ injectAnchor: 'prompt-end', tailRole: role, tailPrompt: 'NOTES {{char}}\n{{steps}}\nUse these notes for the upcoming reply.', steps: [step('A', 'PRIVATE TASK')] });
        const coreChat = [...h.savedChat];
        const result = await h.pipeline.runPipeline({ chat: coreChat });
        const reserved = coreChat.find(message => message.smarttavern_ephemeral);
        assert.equal(coreChat.at(-1), h.savedChat.at(-1));
        assert.match(reserved.mes, /SMARTTAVERN-TAIL/);
        assert.match(reserved.mes, /GENERATED ASSESSMENT/);
        const event = { chat: [
            { role: 'user', content: 'Hello' },
            { role, content: reserved.mes },
            { role: 'system', content: 'Preset instructions added after history' },
        ] };
        h.tail.appendChatTail(event);
        assert.equal(event.chat.at(-1).role, role);
        assert.equal(event.chat.at(-1).content, result.injectionText);
        assert.doesNotMatch(JSON.stringify(event), /SMARTTAVERN-TAIL|PRIVATE TASK/);
        assert.equal(event.chat[1].content, 'Preset instructions added after history');
        assert.equal(event.chat.length, 3);
        h.tail.appendChatTail(event);
        assert.equal(event.chat.length, 3);
        assert.equal(h.savedChat.length, 1);
        assert.equal(h.requests.length, 1);
    });

    test(`text-completion tail uses ${role} and leaves an assistant cue`, async () => {
        const h = await harness({ tailRole: role });
        const name = role === 'user' ? 'User' : 'Alice';
        const reservation = h.tail.stagePromptTail('WORKING NOTES', role);
        const event = { prompt: `HISTORY\n${role === 'system' ? '' : `${name}: `}${reservation}\nPRESET\nAlice:` };
        h.tail.appendTextTail(event);
        assert.equal(event.prompt, `HISTORY\nPRESET\n\n${role === 'system' ? '' : `${name}: `}WORKING NOTES\nAlice:`);
        assert.doesNotMatch(event.prompt, /SMARTTAVERN-TAIL/);
    });
}

test('instruct text formatting relocates the complete reserved turn', async () => {
    const h = await harness();
    h.context.powerUserSettings = { instruct: { enabled: true } };
    const reservation = h.tail.stagePromptTail('WORKING NOTES', 'system');
    const event = { prompt: `HISTORY\n<system>${reservation}</turn>\nPRESET\n<assistant>` };
    h.tail.appendTextTail(event);
    assert.equal(event.prompt, 'HISTORY\nPRESET\n\n<system>WORKING NOTES</turn>\n<assistant>');
});

test('unrelated, preview and internal prompts cannot consume the pending tail', async () => {
    const h = await harness();
    const reservation = h.tail.stagePromptTail('WORKING NOTES', 'assistant');
    const unrelated = { chat: [{ role: 'user', content: 'OTHER CALL' }] };
    h.tail.appendChatTail(unrelated);
    assert.equal(unrelated.chat.length, 1);
    const event = { chat: [{ role: 'assistant', content: reservation }, { role: 'system', content: 'PRESET' }], dryRun: true };
    h.tail.appendChatTail(event);
    assert.match(event.chat[0].content, /SMARTTAVERN-TAIL/);
    event.dryRun = false;
    await h.gen.withInternalGeneration(async () => h.tail.appendChatTail(event));
    assert.match(event.chat[0].content, /SMARTTAVERN-TAIL/);
    h.tail.appendChatTail(event);
    assert.equal(event.chat.at(-1).content, 'WORKING NOTES');
});

test('preserves merged system instructions and multipart content while relocating', async () => {
    const h = await harness();
    const reservation = h.tail.stagePromptTail('WORKING NOTES', 'system');
    const event = { chat: [{ role: 'system', content: [
        { type: 'text', text: `PRESET\n${reservation}\nOTHER INSTRUCTIONS` },
        { type: 'image_url', image_url: { url: 'test-image' } },
    ] }] };
    h.tail.appendChatTail(event);
    assert.match(event.chat[0].content[0].text, /PRESET/);
    assert.match(event.chat[0].content[0].text, /OTHER INSTRUCTIONS/);
    assert.equal(event.chat[0].content[1].image_url.url, 'test-image');
    assert.equal(event.chat.at(-1).content, 'WORKING NOTES');
});

test('disabling mid-assembly strips the reservation and omits its tail', async () => {
    const h = await harness();
    const reservation = h.tail.stagePromptTail('WORKING NOTES', 'assistant');
    h.state.getSettings().enabled = false;
    const event = { chat: [{ role: 'assistant', content: reservation }] };
    h.tail.appendChatTail(event);
    assert.equal(event.chat.length, 0);
});

test('lifecycle cancellation and chat changes cannot leak stale reservations', async () => {
    const h = await harness();
    delete h.context.event_types;
    const listeners = new Map();
    h.context.eventTypes = Object.fromEntries([
        'GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED',
        'CHAT_COMPLETION_PROMPT_READY', 'GENERATE_AFTER_COMBINE_PROMPTS',
    ].map(name => [name, name]));
    h.context.eventSource = {
        on: (name, listener) => listeners.set(name, listener),
        makeLast: (name, listener) => listeners.set(name, listener),
    };
    h.tail.initPromptTail();
    for (const name of ['GENERATION_STARTED', 'GENERATION_ENDED', 'GENERATION_STOPPED', 'CHAT_CHANGED']) {
        const reservation = h.tail.stagePromptTail('STALE NOTES', 'assistant');
        listeners.get(name)();
        const event = { chat: [{ role: 'assistant', content: reservation }, { role: 'user', content: 'NEW REQUEST' }] };
        listeners.get('CHAT_COMPLETION_PROMPT_READY')(event);
        assert.equal(event.chat.length, 1);
        assert.equal(event.chat[0].content, 'NEW REQUEST');
    }
});

test('a custom text formatter keeps assessment in place without leaking markers', async () => {
    const h = await harness();
    const reservation = h.tail.stagePromptTail('WORKING NOTES', 'assistant');
    const event = { prompt: `CUSTOM-BEGIN${reservation}CUSTOM-END\nPRESET` };
    h.tail.appendTextTail(event);
    assert.equal(event.prompt, 'CUSTOM-BEGINWORKING NOTESCUSTOM-END\nPRESET');
});

test('a background profile request does not suppress foreground expansion or refinement tracking', async () => {
    const started = deferred();
    const response = deferred();
    const h = await harness({ fields: [{ name: 'Summary' }], profileUpdateProfileId: 'model', steps: [step('A', 'ASSESS')] },
        async (_messages, index) => { if (index === 1) { started.resolve(); return response.promise; } return { content: 'Assessment' }; });
    h.state.setStoredProfile('alice.png', { fields: { Summary: 'Original' } });
    const update = h.profiles.updateProfile(h.context.characters[0], { notify: false });
    await started.promise;
    const core = [...h.savedChat];
    await h.pipeline.smarttavernInterceptor(core, 10000, () => {}, 'normal');
    assert.equal(h.pipeline.hasFreshReply(), true);
    assert.equal(core.filter(m => m.smarttavern_ephemeral).length, 1);
    response.resolve({ content: '{"Summary":"Updated"}' });
    await update;
});

test('each group member gets a bootstrap attempt after another member fails', async () => {
    const h = await harness({ bootstrapOnFirstMessage: true, fields: [{ name: 'Summary' }], profileUpdateProfileId: 'model', steps: [step('A', 'ASSESS')] },
        async () => ({ content: 'invalid profile' }));
    h.context.groupId = 'group';
    h.context.chatId = 'chat';
    h.context.characters.push({ name: 'Bob', avatar: 'bob.png' });
    h.context.groups = [{ id: 'group', members: ['alice.png', 'bob.png'] }];
    await h.pipeline.runPipeline({ chat: [...h.savedChat] });
    h.context.name2 = 'Bob';
    await h.pipeline.runPipeline({ chat: [...h.savedChat] });
    assert.equal(h.requests.filter(r => r.messages[0].content.includes('profile compiler')).length, 2);
});

test('a dependent step starts as soon as its prerequisite finishes', async () => {
    const a = deferred(), b = deferred(), bothStarted = deferred(), cStarted = deferred();
    let count = 0;
    const h = await harness({ steps: [step('A', 'A'), step('B', 'B'), step('C', 'C {{step:A}}')] }, async messages => {
        const prompt = messages.at(-1).content;
        if (++count === 2) bothStarted.resolve();
        if (prompt === 'A') return a.promise;
        if (prompt === 'B') return b.promise;
        cStarted.resolve();
        return { content: 'C output' };
    });
    const run = h.pipeline.runPipeline({ inject: false });
    await bothStarted.promise;
    a.resolve({ content: 'A output' });
    await cStarted.promise;
    assert.equal(h.requests[2].messages.at(-1).content, 'C A output');
    b.resolve({ content: 'B output' });
    await run;
});

test('wrapped abort errors never fall back or retry', async () => {
    const h = await harness({ genRetries: 2 }, async () => { throw new Error('API request failed', { cause: new DOMException('Stopped', 'AbortError') }); });
    let active = 0;
    h.context.generateRaw = async () => { active++; return 'Unexpected fallback'; };
    await assert.rejects(h.gen.generateWithRetry({ profileId: 'model', prompt: 'test' }));
    assert.equal(h.requests.length, 1);
    assert.equal(active, 0);
});

test('Stop cancels expansion, queued active requests and dependent steps', async () => {
    const started = deferred(), response = deferred();
    const h = await harness({ genRetries: 2, steps: [step('A', 'A'), step('B', 'B'), step('C', '{{step:A}}')] });
    h.state.getSettings().steps.forEach(s => { s.profileId = ''; });
    let calls = 0;
    h.context.generateRaw = async () => { calls++; started.resolve(); return response.promise; };
    const core = [...h.savedChat];
    const run = h.pipeline.runPipeline({ chat: core });
    await started.promise;
    h.context.eventSource.emit('stop');
    assert.equal(await run, null);
    response.resolve('Late output');
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls, 1);
    assert.equal(core.length, 1);
});

for (const savePassesAsSwipes of [true, false]) {
    test(`That's enough accepts the completed veiled pass immediately (save swipes: ${savePassesAsSwipes})`, async () => {
        const started = deferred(), response = deferred();
        const h = await harness({ genRetries: 2, savePassesAsSwipes, refinementSteps: [step('A', '{{draft}}'), step('B', '{{draft}}'), step('C', '{{draft}}')] },
            async (_messages, index) => { if (index === 1) return { content: tagged('First revision') }; started.resolve(); return response.promise; }, { veiled: true });
        const message = { name: 'Alice', mes: 'Original', swipes: ['Original', 'Alternative'], swipe_id: 0 };
        h.savedChat.push(message);
        h.pipeline.markFreshGeneration();
        const run = h.pipeline.runRefinementPipeline(1);
        await started.promise;
        assert.equal(message.swipes[message.swipe_id], 'First revision');
        assert.equal(h.pipeline.stopRefinement(), true);
        const result = await run;
        assert.equal(result.stopped, true);
        assert.equal(result.workingDraft, 'First revision');
        assert.equal(message.mes, 'First revision');
        assert.equal(message.swipes[message.swipe_id], message.mes);
        assert.equal(h.requests[1].signal.aborted, true);
        assert.equal(h.pipeline.isRefinementBusy(), false);
        assert.equal(h.context.activityEnds.at(-1).dismiss, true);
        response.resolve({ content: 'Discarded late output' });
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(message.mes, 'First revision');
        assert.equal(h.requests.length, 2);
        if (savePassesAsSwipes) assert.deepEqual(message.swipes, ['Original', 'Alternative', 'First revision']);
        else assert.deepEqual(message.swipes, ['First revision', 'Alternative']);
    });
}

test("That's enough during the first pass keeps the original draft", async () => {
    const started = deferred(), response = deferred();
    const h = await harness({ refinementSteps: [step('A', '{{draft}}')] }, () => { started.resolve(); return response.promise; }, { veiled: true });
    const message = { name: 'Alice', mes: 'Original', swipes: ['Original'], swipe_id: 0 };
    h.savedChat.push(message);
    h.pipeline.markFreshGeneration();
    const run = h.pipeline.runRefinementPipeline(1);
    await started.promise;
    h.pipeline.stopRefinement();
    assert.equal((await run).workingDraft, 'Original');
    assert.equal(message.mes, 'Original');
    assert.deepEqual(message.swipes, ['Original']);
    assert.equal(h.context.activityEnds.at(-1).dismiss, true);
    response.resolve({ content: 'Discarded' });
});

test('global Stop preserves swipe consistency after a completed veiled pass', async () => {
    const started = deferred(), response = deferred();
    const h = await harness({ savePassesAsSwipes: true, refinementSteps: [step('A', '{{draft}}'), step('B', '{{draft}}')] },
        async (_messages, index) => { if (index === 1) return { content: tagged('First revision') }; started.resolve(); return response.promise; }, { veiled: true });
    const message = { name: 'Alice', mes: 'Original', swipes: ['Original'], swipe_id: 0 };
    h.savedChat.push(message);
    h.pipeline.markFreshGeneration();
    const run = h.pipeline.runRefinementPipeline(1);
    await started.promise;
    h.pipeline.cancelFreshReply();
    h.context.eventSource.emit('stop');
    assert.equal(await run, null);
    assert.equal(message.mes, 'First revision');
    assert.equal(message.swipes[message.swipe_id], message.mes);
    response.resolve({ content: 'Discarded' });
});

test('internal active prompt hooks are identified per request and remove their marker', async () => {
    const h = await harness();
    const reservation = h.tail.stagePromptTail('FOREGROUND NOTES', 'assistant');
    h.context.generateRaw = async ({ systemPrompt }) => {
        await Promise.resolve(); // hooks can run after the synchronous guard is released
        const event = { chat: [{ role: 'system', content: systemPrompt }, { role: 'user', content: 'Internal prompt' }] };
        h.tail.appendChatTail(event);
        assert.equal(h.gen.isInternalGeneration(event), true);
        assert.doesNotMatch(JSON.stringify(event), /SMARTTAVERN-INTERNAL|FOREGROUND NOTES/);
        return 'Internal result';
    };
    await h.gen.generateVia({ prompt: 'Internal prompt', systemPrompt: 'Internal system' });
    const foreground = { chat: [{ role: 'assistant', content: reservation }] };
    h.tail.appendChatTail(foreground);
    assert.equal(foreground.chat.at(-1).content, 'FOREGROUND NOTES');
});

test('chip state updates retain the base class and keep targeting the same step indices', async () => {
    const module = new SourceTextModule(await readFile(new URL('../src/chips.js', import.meta.url), 'utf8'));
    await module.link(() => {});
    await module.evaluate();
    const chips = Array.from({ length: 3 }, () => ({ className: 'smarttavern_chip', icon: '' }));
    const wrap = chip => ({
        length: chip ? 1 : 0,
        attr(_name, value) { chip.className = value; },
        find() { return { attr(_name, value) { chip.icon = value; } }; },
    });
    const container = { length: 1, find() { return { eq(index) {
        return wrap(chips.filter(chip => chip.className.split(/\s+/).includes('smarttavern_chip'))[index]);
    } }; } };
    chips.forEach((_chip, index) => {
        module.namespace.setChipState(container, index, 'running');
        module.namespace.setChipState(container, index, 'done');
    });
    assert.ok(chips.every(chip => chip.className === 'smarttavern_chip is-done'));
    assert.ok(chips.every(chip => chip.icon === 'fa-solid fa-check'));
});

test('cancellation interrupts retry backoff without another provider request', async () => {
    const h = await harness({ genRetries: 2, genRetryDelayMs: 30000 }, async () => ({ content: 'Unusable profile' }));
    const controller = new AbortController();
    const run = h.gen.generateWithRetry({ profileId: 'model', prompt: 'test', signal: controller.signal, validate: () => false });
    await new Promise(resolve => setImmediate(resolve));
    controller.abort(new DOMException('Stopped', 'AbortError'));
    await assert.rejects(run, { name: 'AbortError' });
    assert.equal(h.requests.length, 1);
});


const directorPayload = {
    beat: { text: 'Alice finds a sealed letter on the desk.', escalations: ['Alice opens the letter.', 'Alice reads the letter aloud.'], fact: 'Alice found a letter.' },
    chapter_done: true, assessment: 'A new situation is ready.', closing_fact: 'The archive closed.',
    opening: '*At dawn, a sealed letter waits on the desk. Alice turns toward you.* "Who sent this?"',
};
function testStory() {
    const chapter = { title: 'Archive', situation: 'Alice works at the archive.', goal: 'Find a letter.', exit: 'The archive closes.', clues: '' };
    return { v: 1, bible: { title: 'Letters', premise: 'A mystery.', setting: 'Archive', tone: 'Quiet', conflict: 'Missing letters', secrets: 'Hidden author', cast: [{ name: 'Alice', role: 'Archivist', wants: 'Answers', secret: 'She knows the author.' }], chapters: [chapter, { ...chapter, title: 'Dawn' }] }, chapterIndex: 0, ledger: [], turnsSinceDelivery: 0 };
}

test('Chapter End posts and persists a delivered opening; Next chapter only prepares a beat', async () => {
    for (const mode of ['chapter-end', 'chapter']) {
        const h = await harness({ storyProfileId: 'model' }, async () => ({ content: JSON.stringify(directorPayload) }), { realStory: true });
        h.state.setStory(testStory());
        let saves = 0;
        h.context.saveChat = async () => { saves++; };
        const events = [];
        h.context.eventSource.on('received', id => events.push(['received', id]));
        h.context.eventSource.on('rendered', (id, type) => events.push([type, id]));
        const beat = await h.story.advanceStory(mode, 'Set the scene at dawn.');
        assert.equal(h.state.getStory().chapterIndex, 1);
        if (mode === 'chapter-end') {
            assert.equal(h.savedChat.length, 2);
            assert.equal(h.savedChat[1].mes, directorPayload.opening);
            assert.equal(h.savedChat[1].is_system, false);
            assert.equal(h.savedChat[1].name, 'Alice');
            assert.equal(h.savedChat[1].extra.smarttavernRefined, true);
            assert.equal(h.context.renderedMessage, h.savedChat[1]);
            assert.equal(beat.status, 'delivered');
            assert.equal(beat.deliveredAtMsg, 1);
            assert.equal(saves, 1);
            assert.deepEqual(events, [['received', 1], ['first_message', 1]]);
            assert.ok(h.state.getStory().ledger.includes(directorPayload.beat.fact));
            assert.ok(h.requests[0].messages.some(m => m.content.includes('complete player-facing opening')));
        } else {
            assert.equal(h.savedChat.length, 1);
            assert.equal(beat.status, 'pending');
            assert.equal(saves, 0);
        }
    }
});

test('Chapter End appends a sequel arc after the last chapter', async () => {
    const fixture = testStory();
    fixture.chapterIndex = 1;
    const sequel = Array.from({ length: 3 }, (_, i) => ({ ...fixture.bible.chapters[0], title: `Sequel ${i + 1}` }));
    const h = await harness({ storyProfileId: 'model' }, async () => ({ content: JSON.stringify({ ...directorPayload, new_chapters: sequel }) }), { realStory: true });
    h.state.setStory(fixture);
    await h.story.advanceStory('chapter-end');
    assert.equal(h.state.getStory().chapterIndex, 2);
    assert.equal(h.state.getStory().bible.chapters.length, 5);
    assert.equal(h.savedChat[1].mes, directorPayload.opening);
});

test('Chapter End rejects a missing opening without changing the story or chat', async () => {
    const h = await harness({ storyProfileId: 'model' }, async () => ({ content: JSON.stringify({ ...directorPayload, opening: '' }) }), { realStory: true });
    h.state.setStory(testStory());
    await assert.rejects(h.story.advanceStory('chapter-end'));
    assert.equal(h.state.getStory().chapterIndex, 0);
    assert.equal(h.savedChat.length, 1);
});

test('Chapter End discards a result if the chat changes during generation', async () => {
    const waiting = deferred();
    const done = deferred();
    const h = await harness({ storyProfileId: 'model' }, async () => { waiting.resolve(); return done.promise; }, { realStory: true });
    h.state.setStory(testStory());
    const run = h.story.advanceStory('chapter-end');
    await waiting.promise;
    h.context.chatId = 'another-chat';
    done.resolve({ content: JSON.stringify(directorPayload) });
    assert.equal(await run, null);
    assert.equal(h.savedChat.length, 1);
    assert.equal(h.state.getStory().chapterIndex, 0);
});

test('agent prompt includes the editable task and user-authored chat lore', async () => {
    const h = await harness({ ...agentSettings, agentTask: 'Focus on the archive mystery.' }, async () => ({ content: '<brief><guidance>Alice checks the records.</guidance></brief>' }), { realAgent: true });
    h.context.chatMetadata.world_info = 'Existing';
    await h.agent.runAgentLoop(agentOptions(h));
    const prompt = h.requests[0].messages.map(m => m.content).join('\n');
    assert.ok(prompt.includes('Focus on the archive mystery.'));
    assert.ok(prompt.includes('Existing'));
    assert.ok(prompt.includes('A user fact.'));
    assert.ok(prompt.includes('1 -- complete failure'));
});

test('agent rolls reject modifiers and custom dice', async () => {
    const h = await harness(agentSettings, undefined, { realAgent: true });
    for (const dice of ['d20+2', 'd4', '2d20']) {
        const ctx = { ...agentOptions(h), toolState: {}, turn: { rolls: [] } };
        const result = await h.tools.executeToolCall({ name: 'roll_dice', args: { dice, reason: 'Pick the lock', difficulty: lockDifficulty } }, ctx);
        assert.equal(result.ok, false);
        assert.equal(ctx.turn.rolls.length, 0);
    }
});
