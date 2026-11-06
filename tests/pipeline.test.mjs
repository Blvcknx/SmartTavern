// Run: node --experimental-vm-modules --test tests/pipeline.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SourceTextModule, createContext } from 'node:vm';

async function harness(settings = {}, respond = async () => ({ content: 'GENERATED ASSESSMENT' }), { veiled = false, onPopup = () => 0, realAgent = false, realStory = false, directive = null, clock = null, planner = false } = {}) {
    const requests = [];
    const savedChat = [{ is_user: true, name: 'User', mes: 'Hello' }];
    const listeners = new Map();
    const context = {
        POPUP_TYPE: { CONFIRM: 1, TEXT: 2, INPUT: 3 }, POPUP_RESULT: { AFFIRMATIVE: 1, CANCELLED: 0, CUSTOM1: 1001 },
        Popup: class {
            constructor(content, _type, _input, options) { this.content = content; this.options = options; }
            show() { return new Promise(resolve => { this.resolve = resolve; Promise.resolve(onPopup(this)).then(result => { if (result !== undefined) this.complete(result); }); }); }
            complete(result) { this.result = result; this.resolve?.(this.value ?? result); }
        },
        event_types: { GENERATION_STOPPED: 'stop', CHAT_CHANGED: 'chat', MESSAGE_RECEIVED: 'received', CHARACTER_MESSAGE_RENDERED: 'rendered' },
        eventSource: {
            on(type, fn) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(fn); },
            removeListener(type, fn) { listeners.get(type)?.delete(fn); },
            emit(type, ...args) { for (const fn of [...(listeners.get(type) ?? [])]) fn(...args); },
        },
        extensionSettings: { smarttavern: { agentEngine: planner ? 'planner' : 'legacy', genRetries: 0, bootstrapOnFirstMessage: false, promptTailVersion: 1, injectAnchor: 'before-last-user', ...settings }, connectionManager: { profiles: [{ id: 'model', mode: 'cc' }] } },
        chat: savedChat, chatMetadata: {}, characterId: 0, chatId: 'test-chat', activityEntries: [], activityEnds: [], activityStatuses: [], veilStatuses: [],
        characters: [{ name: 'Alice', avatar: 'alice.png' }], name1: 'User', name2: 'Alice',
        saveSettingsDebounced() {}, substituteParams: text => text,
        saveMetadata() {}, saveMetadataDebounced() {}, saveChat: async () => {}, updateMessageBlock() {}, addOneMessage(message) { context.renderedMessage = message; },
        mainApi: 'openai', chatCompletionSettings: { chat_completion_source: 'openai' }, getChatCompletionModel: () => 'active-model',
        ChatCompletionService: { async processRequest(payload, options, extract, signal) {
            return { content: await context.generateRaw({ prompt: payload.messages, responseLength: payload.max_tokens, signal }) };
        } },
        ConnectionManagerRequestService: { async sendRequest(id, messages, _maxTokens, custom, overrides) {
            requests.push({ id, messages, maxTokens: _maxTokens, signal: custom?.signal, custom, overrides });
            return respond(messages, requests.length);
        } },
        generateRaw: async options => { requests.push(options); return 'ACTIVE OUTPUT'; },
    };
    const sandbox = createContext({ context, AbortController, DOMException, setTimeout, clearTimeout, structuredClone, crypto: globalThis.crypto, console: { log() {}, warn() {} }, toastr: { warning() {}, info() {}, success() {} },
        ...(clock ? { Date: class extends Date { static now() { return clock.now; } } } : {}),
        document: { dispatchEvent() {}, createElement(tagName) { return {
            tagName, children: [], handlers: {}, attributes: {},
            append(...children) { this.children.push(...children); },
            setAttribute(name, value) { this.attributes[name] = value; },
            addEventListener(type, handler) { this.handlers[type] = handler; },
        }; } }, CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
    });
    const modules = new Map();
    const sources = {
        extensions: 'export const getContext = () => context;',
        'system-messages': "export const system_message_types = { NARRATOR: 'narrator' };",
        'instruct-mode': `export const formatInstructModeChat = (name, text, user, system) => '<' + (system ? 'system' : user ? 'user' : 'assistant') + '>' + text + '</turn>\\n'; export const formatInstructModePrompt = () => '<assistant>';`,
        progress: 'export const activityStart = () => {}; export const activityStatus = status => { context.activityStatuses.push(status); }; export const activityEntry = entry => { context.activityEntries.push(entry); }; export const activityFail = () => {}; export const activityEnd = options => { context.activityEnds.push(options); }; export const activitySteps = () => {}; export const activityStepState = () => {}; export const activityRefinementControls = () => {};',
        veil: `export const applyVeil = () => ${veiled}; export const setVeilStep = () => {}; export const setVeilStatus = (_id, status) => { context.veilStatuses.push(status); }; export const revealVeil = () => {}; export const dismissVeil = () => {}; export const dismissAllVeils = () => {}; export const armPreVeil = () => {};`,
        // Story Director stub: no chat in these tests carries a story, so the whole
        // feature must stay inert. The no-ops mirror story.js's no-story behavior.
        story: `export const previewStoryDirective = () => (${JSON.stringify(directive)}); export const prepareStoryDirective = () => (${JSON.stringify(directive)}); export const storyMacroContext = value => value; export const recordedDirective = () => null; export const compileStoryDirective = () => null; export const hasStory = () => false; export const markStoryBeatDelivered = () => false; export const recordDirectiveInjection = () => {}; export const resetStoryGenerationState = () => {};`,
        // Thinking agent stub: these tests exercise the non-agent path (the default
        // agentMode is 'always', so the stub gate must stay closed explicitly).
        agent: 'export const consumeAgentArm = () => {}; export const getTurnBrief = () => ""; export const agentActiveForTurn = () => false; export const runAgentLoop = async () => null; export const resetAgentTurn = () => {}; export const agentTurnRequirements = () => ({ must: [], rolls: [] }); export const armAgent = () => {}; export const clearAgentSession = () => {};',
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
        for (const name of ['agent', 'agent-tools', 'rulings', 'ruling-core']) sources[name] = await readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8');
    }
    for (const name of ['pipeline', 'state', 'gen', 'tail', 'profiles', 'refinement-checks', 'refinement-edits', 'agent-core', 'planner', 'planner-core', 'user-context', 'narration', ...(realStory ? ['story', 'story-core'] : [])]) {
        sources[name] = await readFile(new URL(`../src/${name}.js`, import.meta.url), 'utf8');
    }
    for (const [name, source] of Object.entries(sources)) {
        modules.set(name, new SourceTextModule(source, { context: sandbox }));
    }
    const pipeline = modules.get('pipeline');
    await pipeline.link(specifier => modules.get(specifier.split('/').at(-1).replace('.js', '')));
    await pipeline.evaluate();
    const narration = modules.get('narration');
    await narration.link(specifier => modules.get(specifier.split('/').at(-1).replace('.js', '')));
    await narration.evaluate();
    const state = modules.get('state').namespace;
    state.loadSettings();
    return { narration: narration.namespace, planner: modules.get('planner').namespace, story: modules.get('story').namespace, pipeline: pipeline.namespace, agent: modules.get('agent').namespace, tools: modules.get('agent-tools')?.namespace, world: modules.get('world-info')?.namespace, rulings: modules.get('rulings')?.namespace, checks: modules.get('refinement-checks').namespace, edits: modules.get('refinement-edits').namespace, profiles: modules.get('profiles').namespace, tail: modules.get('tail').namespace, gen: modules.get('gen').namespace, state, context, requests, savedChat };
}

const step = (name, prompt, role = 'assistant') => ({ name, prompt, role, profileId: 'model', enabled: true });

test('reasoning retries rejected maximum on the same profile and remembers high per model', async () => {
    const h = await harness({}, async () => {
        if (h.requests.at(-1).overrides.reasoning_effort === 'max') {
            throw new Error('API request failed', { cause: new Error('Invalid reasoning_effort max; supported values: low, medium, high') });
        }
        return { content: 'Edited' };
    });
    const options = { profileId: 'model', prompt: 'Edit', sampling: {}, reasoning: true };
    await h.gen.generateVia(options);
    await h.gen.generateVia(options);
    assert.deepEqual(h.requests.map(request => request.overrides.reasoning_effort), ['max', 'high', 'high']);
    assert.ok(h.requests.every(request => request.id === 'model' && request.overrides.include_reasoning === true));
    h.context.extensionSettings.connectionManager.profiles[0].model = 'different-model';
    await h.gen.generateVia(options);
    assert.deepEqual(h.requests.slice(-2).map(request => request.overrides.reasoning_effort), ['max', 'high']);
});

test('reasoning switch is independent per pipeline and defaults to off', async () => {
    const h = await harness({ steps: [{ ...step('Assess', 'TASK'), reasoning: true }], refinementSteps: [step('Edit', '{{draft}}')] },
        async () => ({ content: '<audit>PASS</audit>' }));
    await h.pipeline.runPipeline({ inject: false });
    h.savedChat.push({ name: 'Alice', mes: 'Draft' });
    h.pipeline.markFreshGeneration();
    await h.pipeline.runRefinementPipeline(1);
    assert.equal(h.requests[0].overrides.reasoning_effort, 'max');
    assert.equal(h.requests[1].overrides.reasoning_effort, 'none');
});

test('reasoning maximum is not retried for auth errors or cancellation', async () => {
    for (const error of [new Error('Unauthorized API key'), new DOMException('Stopped', 'AbortError')]) {
        const h = await harness({}, async () => { throw error; });
        h.context.ChatCompletionService.processRequest = async () => { throw error; };
        await assert.rejects(h.gen.generateVia({ profileId: 'model', prompt: 'Edit', sampling: {}, reasoning: true }));
        assert.equal(h.requests.length, 1);
    }
});

test('rejected reasoning off stays off and surfaces without fallback or generation retries', async () => {
    const h = await harness({ genRetries: 3 }, async () => { throw new Error('reasoning_effort none is not supported by this model'); });
    h.context.ChatCompletionService.processRequest = async () => { throw new Error('Unexpected fallback'); };
    await assert.rejects(h.gen.generateWithRetry({ profileId: 'model', prompt: 'Edit', sampling: {}, reasoning: false }), /Reasoning Off was rejected/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.requests[0].overrides.reasoning_effort, 'none');
});

test('provider adapters receive actual disable commands, not only hidden-thought flags', async () => {
    for (const [source, model, expected] of [ ['openai', 'gpt-5.4', 'none'], ['openrouter', 'vendor/model', 'none'],
        ['claude', 'claude-sonnet-4-5', 'auto'], ['makersuite', 'gemini-2.5-flash', 'min'] ]) {
        const h = await harness();
        h.context.CONNECT_API_MAP = { provider: { source } };
        Object.assign(h.context.extensionSettings.connectionManager.profiles[0], { api: 'provider', model });
        await h.gen.generateVia({ profileId: 'model', prompt: 'Edit', sampling: {}, reasoning: false });
        assert.equal(h.requests[0].overrides.reasoning_effort, expected);
        assert.equal(h.requests[0].overrides.include_reasoning, false);
    }
});

test('custom active connections explicitly forward effort and retain it on max-to-high retry', async () => {
    const h = await harness();
    h.context.chatCompletionSettings.chat_completion_source = 'custom';
    const payloads = [];
    h.context.ChatCompletionService.processRequest = async payload => {
        payloads.push(payload);
        assert.equal(JSON.parse(payload.custom_include_body).reasoning_effort, payload.reasoning_effort);
        if (payload.reasoning_effort === 'max') throw new Error('Invalid reasoning_effort; max is unsupported');
        return { content: 'Edited' };
    };
    await h.gen.generateVia({ prompt: 'Edit', sampling: {}, reasoning: true });
    assert.deepEqual(payloads.map(payload => payload.reasoning_effort), ['max', 'high']);
    await h.gen.generateVia({ prompt: 'Edit', sampling: {}, reasoning: false });
    assert.equal(payloads.at(-1).reasoning_effort, 'none');
});

test('known adapters that cannot turn reasoning off fail explicitly rather than substituting low', async () => {
    for (const [source, model] of [['makersuite', 'gemini-2.5-pro'], ['claude', 'claude-opus-4-6'], ['openai', 'gpt-6.1-sol']]) {
        const h = await harness();
        h.context.CONNECT_API_MAP = { provider: { source } };
        Object.assign(h.context.extensionSettings.connectionManager.profiles[0], { api: 'provider', model });
        await assert.rejects(h.gen.generateVia({ profileId: 'model', sampling: {}, reasoning: false }), error => error.reasoningControl === true);
        assert.equal(h.requests.length, 0);
    }
});

test('expansion and refinement send independent sampling without importing profile presets or instruct settings', async () => {
    const expansion = { ...step('Assess', 'TASK'), sampling: { temperature: 0.25, repetition_penalty: 1.15, presence_penalty: -0.3, frequency_penalty: 0.4 } };
    const refinement = { ...step('Edit', '{{draft}}'), sampling: { temperature: 0.1 } };
    const h = await harness({ steps: [expansion], refinementSteps: [refinement] }, async () => ({ content: '<audit>PASS</audit>' }));
    await h.pipeline.runPipeline({ inject: false });
    h.savedChat.push({ name: 'Alice', mes: 'The draft.' });
    h.pipeline.markFreshGeneration();
    await h.pipeline.runRefinementPipeline(1);
    assert.equal(h.requests.length, 2);
    for (const request of h.requests) {
        assert.equal(request.custom.includePreset, false);
        assert.equal(request.custom.includeInstruct, false);
    }
    assert.deepEqual({ ...h.requests[0].overrides }, { ...expansion.sampling, include_reasoning: false, reasoning_effort: 'none' });
    assert.deepEqual({ ...h.requests[1].overrides }, { temperature: 0.1, repetition_penalty: 1, presence_penalty: 0, frequency_penalty: 0, include_reasoning: false, reasoning_effort: 'none' });
    // Non-step calls preserve their existing preset behavior.
    await h.gen.generateVia({ profileId: 'model', prompt: 'Maintenance' });
    assert.equal(h.requests[2].custom.includePreset, true);
});

test('isolated fallback copies only active routing and keeps the step sampling', async () => {
    const h = await harness({}, async () => { throw new Error('Pinned connection offline'); });
    h.context.chatCompletionSettings = { chat_completion_source: 'openai', custom_url: 'https://example.invalid',
        temperature: 1.9, top_p: 0.01, reasoning_effort: 'high', assistant_prefill: 'Unwanted prefill', prompts: ['Unwanted instructions'] };
    let payload;
    h.context.ChatCompletionService.processRequest = async (data, options) => {
        payload = data;
        assert.deepEqual(Object.keys(options), []);
        return { content: 'Edited' };
    };
    const result = await h.gen.generateVia({ profileId: 'model', systemPrompt: 'Editor', prompt: 'Draft', sampling: { temperature: 0.2 } });
    assert.equal(result.content, 'Edited');
    assert.equal(payload.model, 'active-model');
    assert.equal(payload.custom_url, 'https://example.invalid');
    assert.equal(payload.temperature, 0.2);
    for (const key of ['top_p', 'reasoning_effort', 'assistant_prefill', 'prompts', 'repetition_penalty']) assert.equal(key in payload, false);
    assert.deepEqual(Array.from(payload.messages, message => ({ ...message })), [{ role: 'system', content: 'Editor' }, { role: 'user', content: 'Draft' }]);
});

test('text-completion steps map penalties and normalize malformed sampling without importing presets', async () => {
    const h = await harness();
    h.context.extensionSettings.connectionManager.profiles[0].mode = 'tc';
    await h.gen.generateVia({ profileId: 'model', prompt: 'Task', sampling: { temperature: NaN, repetition_penalty: 1.2, presence_penalty: -99, frequency_penalty: 'bad' } });
    const request = h.requests[0];
    assert.equal(request.custom.includePreset, false);
    assert.deepEqual({ ...request.overrides }, { temperature: 0.7, repetition_penalty: 1.2, presence_penalty: -2, frequency_penalty: 0, rep_pen: 1.2, repeat_penalty: 1.2 });
});

test('active text completion uses connection routing and step sampling without global settings', async () => {
    const h = await harness();
    h.context.mainApi = 'textgenerationwebui';
    h.context.textCompletionSettings = { type: 'ooba', server_urls: { ooba: 'http://localhost:5000' }, temp: 1.8, top_k: 12, grammar_string: 'unwanted' };
    h.context.getTextGenModel = () => 'text-model';
    h.context.TextCompletionService = { async processRequest(payload, options) {
        assert.deepEqual(Object.keys(options), []);
        assert.equal(payload.api_type, 'ooba');
        assert.equal(payload.api_server, 'http://localhost:5000');
        assert.equal(payload.model, 'text-model');
        assert.equal(payload.temperature, 0.4);
        assert.equal(payload.prompt, 'Editor\n\nDraft');
        assert.equal('grammar_string' in payload, false);
        assert.equal('top_k' in payload, false);
        return { content: 'Revised' };
    } };
    const result = await h.gen.generateVia({ systemPrompt: 'Editor', prompt: 'Draft', sampling: { temperature: 0.4 } });
    assert.equal(result.content, 'Revised');
});

const agentSettings = { expansionEnabled: false, agentProfileId: 'model', agentMode: 'always' };
const agentOptions = h => ({ chat: [...h.savedChat], char: h.context.characters[0], settings: h.state.getSettings() });
const lockDifficulty = 'The lock is difficult for Alice; interpret the roll against her limited experience.';
const lockRoll = `<tool name="roll_dice">${JSON.stringify({ reason: 'Pick the lock', difficulty: lockDifficulty })}</tool>`;

test('planner user blocks save answers, feed dependent assessments, survive reload, and stay chat-local', async () => {
    let popups = 0;
    const h = await harness({ agentProfileId: 'model', steps: [], injectAnchor: 'prompt-end' }, async (messages, index) => {
        if (index === 1) return { content: '## User: Destination\nWhere do you want to go?\n## Expansion: Route\nPlan travel using {{step:Destination}}.' };
        assert.match(messages.map(message => message.content).join('\n'), /Answer: The harbor/);
        return { content: 'Use the harbor road.' };
    }, { planner: true, realAgent: true, onPopup: popup => {
        popups++;
        assert.equal(popup.options.okButton, 'Submit');
        assert.equal(popup.options.cancelButton, 'Skip');
        popup.value = ' The harbor ';
        return 1;
    } });
    const result = await h.pipeline.runPipeline({ chat: [...h.savedChat] });
    assert.equal(popups, 1);
    assert.equal(h.requests.length, 2); // The question never calls a model.
    assert.match(result.stepOutputs.Destination, /Question: Where do you want to go\?\nAnswer: The harbor/);
    assert.match(result.injectionText, /USER CONTEXT/);
    assert.match(result.injectionText, /The harbor/);
    const reloaded = await harness({ agentProfileId: 'model', steps: [], injectAnchor: 'before-last-user' }, async messages => {
        assert.match(messages.map(message => message.content).join('\n'), /Answer: The harbor/);
        return { content: '## User: Reused destination\nWhere do you want to go?' };
    }, { planner: true, realAgent: true, onPopup: () => { throw new Error('Must reuse saved answer'); } });
    reloaded.context.chatMetadata = JSON.parse(JSON.stringify(h.context.chatMetadata));
    const history = [...reloaded.savedChat];
    const reused = await reloaded.pipeline.runPipeline({ chat: history });
    assert.match(reused.stepOutputs['Reused destination'], /The harbor/);
    assert.match(history.map(message => message.mes).join('\n'), /USER CONTEXT/);
    reloaded.context.chatMetadata = {};
    assert.equal(reloaded.state.getChatStore().userAnswers, undefined);
});

test('skipped user questions do not save answers and dependent blocks still run', async () => {
    const h = await harness({ agentProfileId: 'model', steps: [] }, async (_messages, index) => ({ content: index === 1
        ? '## User: Choice\nWhich way?\n## Expansion: Options\nAssess options. {{step:Choice}}' : 'Keep options open.' }),
    { planner: true, realAgent: true, onPopup: () => 0 });
    const result = await h.pipeline.runPipeline({ chat: [...h.savedChat] });
    assert.equal(result.stepOutputs.Choice, '');
    assert.equal(result.stepOutputs.Options, 'Keep options open.');
    assert.equal(h.state.getChatStore().userAnswers, undefined);
});

for (const type of ['dry', 'swipe', 'regenerate', 'continue']) {
    test(`planner user questions never open or persist during ${type}`, async () => {
        const h = await harness({ agentProfileId: 'model', steps: [] }, async () => ({ content: '## User: Choice\nWhich way?' }),
            { planner: true, realAgent: true, onPopup: () => { throw new Error('Unexpected question'); } });
        const result = await h.pipeline.runPipeline({ chat: [...h.savedChat], inject: type !== 'dry', type });
        assert.equal(result.stepOutputs.Choice, '');
        assert.equal(h.state.getChatStore().userAnswers, undefined);
    });
}

for (const event of ['stop', 'chat']) {
    test(`planner closes pending questions on ${event} without saving`, async () => {
        let opened;
        const ready = new Promise(resolve => { opened = resolve; });
        let popup;
        const h = await harness({ agentProfileId: 'model', steps: [] }, async () => ({ content: '## User: Choice\nWhich way?' }),
            { planner: true, realAgent: true, onPopup: instance => { popup = instance; opened(); } });
        const pending = h.pipeline.runPipeline({ chat: [...h.savedChat] });
        await ready;
        h.context.eventSource.emit(event);
        assert.equal(await pending, null);
        assert.equal(popup.result, 0);
        assert.equal(h.state.getChatStore().userAnswers, undefined);
    });
}

test('planner runs before expansion, preserves settings, and injects temporary dependent output', async () => {
    const h = await harness({ agentProfileId: 'model', steps: [step('Original', 'Assess the original context.')], injectAnchor: 'prompt-end' }, async (messages, index) => {
        const prompt = messages.map(message => message.content).join('\n');
        if (index === 1) {
            assert.match(prompt, /## Expansion: Original\nAssess the original context\./);
            assert.match(prompt, /User: Hello/);
            return { content: '## Expansion: Missing context\nUse {{step:Original}} to assess a concrete information gap.' };
        }
        if (index === 2) return { content: 'ORIGINAL ASSESSMENT' };
        assert.match(prompt, /ORIGINAL ASSESSMENT/);
        assert.match(prompt, /CHARACTER CARD/);
        return { content: 'TEMPORARY ASSESSMENT' };
    }, { planner: true, realAgent: true });
    const before = JSON.stringify(h.state.getSettings().steps);
    h.state.getChatStore();
    const metadata = JSON.stringify(h.context.chatMetadata);
    const result = await h.pipeline.runPipeline({ chat: [...h.savedChat] });
    assert.equal(h.requests.length, 3);
    assert.match(result.injectionText, /TEMPORARY ASSESSMENT/);
    assert.equal(result.agentRan, false);
    assert.equal(result.brief, '');
    assert.equal(result.planner.additions[0].name, 'Missing context');
    assert.equal(h.pipeline.getLastRunResults().expansion.effectiveSteps.length, 2);
    assert.equal(JSON.stringify(h.state.getSettings().steps), before);
    assert.equal(JSON.stringify(h.context.chatMetadata), metadata);
    assert.equal(h.savedChat.length, 1);
});

test('planner caps configured blocks at five, preserves overflow, and makes no planning call when full', async () => {
    const steps = Array.from({ length: 7 }, (_, index) => step(`Block ${index}`, `Prompt ${index}`));
    const h = await harness({ agentProfileId: 'model', steps }, undefined, { planner: true, realAgent: true });
    const result = await h.pipeline.runPipeline({ inject: false });
    assert.equal(h.requests.length, 5);
    assert.equal(result.stepStats.length, 5);
    assert.equal(result.planner.ran, false);
    assert.match(result.planner.notices[0], /first five/);
    assert.equal(h.state.getSettings().steps.length, 7);
    assert.equal(h.savedChat.length, 1);
});

for (const response of ['NO ADDITIONS', 'This is not a block.', '## Expansion: Original\nA duplicate.']) {
    test(`planner handles ${response.slice(0, 25)} without format-repair calls`, async () => {
        const h = await harness({ agentProfileId: 'model', steps: [step('Original', 'Original prompt')] },
            async (_messages, index) => ({ content: index === 1 ? response : 'EXISTING OUTPUT' }), { planner: true, realAgent: true });
        const result = await h.pipeline.runPipeline({ inject: false });
        assert.equal(h.requests.length, 2);
        assert.equal(result.planner.additions.length, 0);
        assert.match(result.injectionText, /EXISTING OUTPUT/);
    });
}

test('planner dry runs preserve one-shot activation; real runs consume it', async () => {
    const h = await harness({ agentMode: 'armed', agentProfileId: 'model', steps: [] }, async () => ({ content: 'NO ADDITIONS' }), { planner: true, realAgent: true });
    h.agent.armAgent();
    await h.pipeline.runPipeline({ inject: false });
    assert.equal(h.agent.isAgentArmed(), true);
    await h.pipeline.runPipeline({ chat: [...h.savedChat] });
    assert.equal(h.agent.isAgentArmed(), false);
    await h.pipeline.runPipeline({ chat: [...h.savedChat] });
    assert.equal(h.requests.length, 2);
});

test('planner stays inactive when expansion is disabled and Legacy remains selectable after reload', async () => {
    const h = await harness({ expansionEnabled: false, agentProfileId: 'model' }, undefined, { planner: true, realAgent: true });
    assert.equal(await h.pipeline.runPipeline(), null);
    assert.equal(h.requests.length, 0);
    const settings = h.state.getSettings();
    delete settings.agentEngine;
    h.state.loadSettings();
    assert.equal(settings.agentEngine, 'planner');
    settings.agentEngine = 'legacy';
    h.state.loadSettings();
    assert.equal(settings.agentEngine, 'legacy');
});

test('planner exceptions fall back to configured blocks', async () => {
    const h = await harness({ steps: [step('Original', 'Keep this prompt')], agentProfileId: 'model' }, undefined, { planner: true, realAgent: true });
    h.context.ConnectionManagerRequestService.sendRequest = async (_id, messages) => {
        if (messages[0].content.includes('You design optional')) throw new Error('Offline');
        return { content: 'EXISTING OUTPUT' };
    };
    h.context.generateRaw = async () => { throw new Error('Offline'); };
    const result = await h.pipeline.runPipeline({ inject: false });
    assert.match(result.planner.error, /Offline/);
    assert.match(result.injectionText, /EXISTING OUTPUT/);
});

test('agent context budgeting removes oldest messages and context overflow retries only the selected connection', async () => {
    const h = await harness({ agentProfileId: 'model' }, async (_messages, index) => {
        if (index === 1) throw new Error('API request failed', { cause: new Error('maximum context length exceeded') });
        return { content: 'NO ADDITIONS' };
    });
    h.context.extensionSettings.connectionManager.profiles[0].contextSize = 1800;
    const chat = Array.from({ length: 24 }, (_, index) => ({ name: 'Alice', mes: `MESSAGE-${index} ` + 'x'.repeat(200) }));
    const notices = [];
    const result = await h.planner.generateAgentText({ systemPrompt: 'SYSTEM', fixed: 'FIXED', chat, profileId: 'model', maxTokens: 100, onNotice: notice => notices.push(notice) });
    assert.equal(h.requests.length, 2);
    assert.ok(notices.length >= 2);
    const first = h.requests[0].messages.at(-1).content;
    const second = h.requests[1].messages.at(-1).content;
    assert.ok(!first.includes('MESSAGE-0 '));
    assert.ok(second.length < first.length);
    assert.match(second, /MESSAGE-23 /);
    assert.match(second, /FIXED/);
    assert.equal(result.text, 'NO ADDITIONS');
});

test('agent budgeting uses the selected saved preset rather than active connection settings', async () => {
    const h = await harness({}, async () => ({ content: 'NO ADDITIONS' }));
    h.context.extensionSettings.connectionManager.profiles[0].preset = 'Small model';
    h.context.mainApi = 'openai';
    h.context.chatCompletionSettings = { openai_max_context: 100000 };
    h.context.getPresetManager = api => {
        assert.equal(api, 'openai');
        return { getCompletionPresetByName(name) { assert.equal(name, 'Small model'); return { openai_max_context: 1000 }; } };
    };
    const result = await h.planner.generateAgentText({ systemPrompt: 'System', fixed: 'Fixed', profileId: 'model', maxTokens: 100,
        chat: Array.from({ length: 24 }, (_, index) => ({ mes: `MESSAGE-${index} ` + 'x'.repeat(200) })) });
    assert.ok(result.history.length < 24);
    assert.match(result.history.at(-1), /MESSAGE-23/);
});

test('context-limit recovery stops after four attempts without rewriting fixed instructions', async () => {
    const h = await harness({}, async () => { throw new Error('context_length_exceeded'); });
    await assert.rejects(h.planner.generateAgentText({ systemPrompt: 'System', fixed: 'Keep block definitions', profileId: 'model', maxTokens: 100,
        chat: [{ mes: 'x'.repeat(1000) }] }), /context_length_exceeded/);
    assert.equal(h.requests.length, 4);
    for (const request of h.requests) assert.match(request.messages.at(-1).content, /Keep block definitions/);
});

test('scene dialog retains the request after failure and allows retry without duplicate dialogs', async () => {
    let popup;
    const shown = deferred();
    const h = await harness({ agentProfileId: 'model' }, async (_messages, index) => {
        if (index === 1) throw new Error('Offline');
        return { content: 'The visitor waits outside.' };
    }, { onPopup(value) { popup = value; shown.resolve(); return undefined; } });
    h.context.generateRaw = async () => { throw new Error('Offline'); };
    const dialog = h.narration.openNarrationDialog();
    await shown.promise;
    assert.equal(await h.narration.openNarrationDialog(), undefined);
    const [, input, status, button] = popup.content.children;
    input.value = 'Introduce a visitor';
    await button.handlers.click();
    assert.equal(input.value, 'Introduce a visitor');
    assert.match(status.textContent, /Offline/);
    assert.equal(button.disabled, false);
    assert.equal(h.savedChat.length, 1);
    await button.handlers.click();
    await dialog;
    assert.equal(h.savedChat.length, 2);
    assert.equal(h.savedChat[1].mes, 'The visitor waits outside.');
});

test('closing the scene dialog aborts the pending write', async () => {
    let popup;
    const shown = deferred();
    const started = deferred();
    const pending = deferred();
    const h = await harness({ agentProfileId: 'model' }, async () => { started.resolve(); return pending.promise; },
        { onPopup(value) { popup = value; shown.resolve(); return undefined; } });
    const dialog = h.narration.openNarrationDialog();
    await shown.promise;
    const [, input, , button] = popup.content.children;
    input.value = 'Time skip';
    const click = button.handlers.click();
    await started.promise;
    popup.options.onClosing();
    popup.complete(0);
    await dialog;
    pending.resolve({ content: 'Discard this scene.' });
    await click;
    assert.equal(h.savedChat.length, 1);
});

for (const engine of ['planner', 'legacy']) {
    test(`quick narration appends once without refinement or story mutations in ${engine} mode`, async () => {
        const h = await harness({ agentEngine: engine, agentProfileId: 'model' }, async () => ({ content: '<think>private</think>Three days later, a stranger knocks.' }), { realStory: true });
        h.state.setStory(testStory());
        const before = JSON.stringify(h.state.getStory());
        let saves = 0;
        h.context.saveChat = async () => { saves++; };
        h.context.eventSource.on('received', id => h.story.onStoryCharacterReply(id));
        h.pipeline.markFreshGeneration();
        h.context.eventSource.on('rendered', id => { void h.pipeline.runRefinementPipeline(id); });
        const message = await h.narration.writeQuickNarration('Skip a few days');
        assert.equal(h.requests.length, 1);
        assert.equal(saves, 1);
        assert.equal(h.savedChat.length, 2);
        assert.equal(message.mes, 'Three days later, a stranger knocks.');
        assert.equal(message.extra.smarttavernNarration, true);
        assert.equal(await h.pipeline.runRefinementPipeline(1, { dryRun: true }), null);
        assert.equal(JSON.stringify(h.state.getStory()), before);
        assert.ok(!h.savedChat.some(message => message.mes === 'Skip a few days'));
        const prompt = h.requests[0].messages.at(-1).content;
        assert.match(prompt, /Skip a few days/);
        assert.ok(!prompt.includes('Hidden author'));
    });
}

for (const change of ['advance', 'edit', 'chat', 'stop']) {
    test(`quick narration discards pending output after ${change}`, async () => {
        const pending = deferred();
        const started = deferred();
        const h = await harness({ agentProfileId: 'model' }, async () => { started.resolve(); return pending.promise; });
        const run = h.narration.writeQuickNarration('Move the scene forward');
        const rejection = assert.rejects(run, /conversation changed|cancelled/i);
        await started.promise;
        if (change === 'advance') h.savedChat.push({ mes: 'New message', is_user: true });
        if (change === 'edit') h.savedChat[0].mes = 'Edited';
        if (change === 'chat') h.context.eventSource.emit('chat');
        if (change === 'stop') h.context.eventSource.emit('stop');
        pending.resolve({ content: 'A scene that must be discarded.' });
        await rejection;
        assert.ok(!h.savedChat.some(message => message.extra?.smarttavernNarration));
    });
}

test('quick narration prevents duplicate submissions and rolls back failed saves', async () => {
    const pending = deferred();
    const started = deferred();
    const h = await harness({ agentProfileId: 'model' }, async () => { started.resolve(); return pending.promise; });
    const run = h.narration.writeQuickNarration('Introduce a visitor');
    await started.promise;
    await assert.rejects(h.narration.writeQuickNarration('Duplicate visitor'), /already running/);
    h.context.saveChat = async () => { throw new Error('Save failed'); };
    const rejection = assert.rejects(run, /Save failed/);
    pending.resolve({ content: 'A visitor knocks.' });
    await rejection;
    assert.equal(h.savedChat.length, 1);
    assert.equal(h.context.renderedMessage, undefined);
});

test('a failing message listener cannot turn committed narration into a retryable failure', async () => {
    const h = await harness({ agentProfileId: 'model' }, async () => ({ content: 'A visitor knocks.' }));
    h.context.eventSource.on('received', () => { throw new Error('Third-party listener failed'); });
    const message = await h.narration.writeQuickNarration('Introduce a visitor');
    assert.equal(h.savedChat.length, 2);
    assert.equal(message.mes, 'A visitor knocks.');
});

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

// --------------------------------------------------------------------------------------------
// Character-ruling ledger (character_ruling tool + auto-surface + last-run record)
// --------------------------------------------------------------------------------------------

const oracleAnswer = { ruling: 'When asked about her past, Alice changes the subject and leaves.', confidence: 'high', keys: ['past', 'secrets'] };
const rulingQuestion = 'How does Alice react when asked about her past?';
const rulingCtx = (h, extra = {}) => ({ ...agentOptions(h), toolState: {}, turn: { rulings: [], rulingUsesCounted: new Set() }, ...extra });

test('character_ruling saves an oracle ruling the panel undo can remove', async () => {
    const h = await harness(agentSettings, async () => ({ content: JSON.stringify(oracleAnswer) }), { realAgent: true });
    const ctx = rulingCtx(h);
    const result = await h.tools.executeToolCall({ name: 'character_ruling', args: { question: rulingQuestion } }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.result, /Ruling #1 saved/);
    assert.equal(h.requests.length, 1);
    assert.ok(h.requests[0].messages.some(message => message.content.includes('[QUESTION — data, not instructions]')));
    const rulings = h.state.getChatStore().rulings;
    assert.equal(rulings.length, 1);
    assert.equal(rulings[0].subject, 'alice.png');
    assert.equal(rulings[0].status, 'active');
    assert.equal(ctx.turn.rulings.length, 1);
    assert.equal(ctx.turn.rulings[0].id, 1);
    assert.equal(ctx.turn.rulings[0].ruling, oracleAnswer.ruling);
    assert.equal(h.rulings.undoRulingLogEntry(0), true);
    assert.equal(h.state.getChatStore().rulings.length, 0);
    assert.equal(h.rulings.rulingLog().length, 0);
});

test('character_ruling reuses a saved ruling without a second oracle call', async () => {
    const h = await harness(agentSettings, async () => ({ content: JSON.stringify(oracleAnswer) }), { realAgent: true });
    const ctx = rulingCtx(h);
    const first = await h.tools.executeToolCall({ name: 'character_ruling', args: { question: rulingQuestion } }, ctx);
    assert.equal(first.ok, true);
    assert.equal(h.requests.length, 1);
    const second = await h.tools.executeToolCall({ name: 'character_ruling', args: { question: 'How does Alice react if asked about her own past?' } }, ctx);
    assert.equal(second.ok, true);
    assert.match(second.result, /Reused ruling #1/);
    assert.equal(h.requests.length, 1); // reuse makes no LLM call
    assert.equal(h.state.getChatStore().rulings[0].uses, 1);
});

test('a dry-run consult answers from the oracle but never persists', async () => {
    const h = await harness(agentSettings, async () => ({ content: JSON.stringify(oracleAnswer) }), { realAgent: true });
    const ctx = rulingCtx(h, { dryRun: true });
    const result = await h.tools.executeToolCall({ name: 'character_ruling', args: { question: rulingQuestion } }, ctx);
    assert.equal(result.ok, true);
    assert.match(result.result, /dry run, not saved/);
    assert.equal(h.requests.length, 1);
    assert.equal(h.state.getChatStore().rulings, undefined);
    assert.equal(ctx.turn.rulings.length, 1);
    assert.equal(ctx.turn.rulings[0].id, 0);
    assert.equal(ctx.turn.rulings[0].ruling, oracleAnswer.ruling);
});

test('a replayed consult reuses the ruling without recording a use', async () => {
    const h = await harness(agentSettings, async () => ({ content: JSON.stringify(oracleAnswer) }), { realAgent: true });
    await h.tools.executeToolCall({ name: 'character_ruling', args: { question: rulingQuestion } }, rulingCtx(h));
    const calls = h.requests.length;
    const result = await h.tools.executeToolCall({ name: 'character_ruling', args: { question: rulingQuestion } }, rulingCtx(h, { isReplay: true }));
    assert.equal(result.ok, true);
    assert.match(result.result, /Reused ruling #1/);
    assert.equal(h.requests.length, calls);
    assert.equal(h.state.getChatStore().rulings[0].uses, 0);
});

test('surfaced rulings reach the brief, the agent prompt and the last-run record without any tool call', async () => {
    const h = await harness(agentSettings, async () => ({ content: '<brief><must>She answers quietly.</must></brief>' }), { realAgent: true });
    h.savedChat.push({ name: 'Alice', mes: 'Do not dig into the past or its secrets.' }, { is_user: true, name: 'User', mes: 'Tell me about the past.' });
    h.rulings.createRuling({ question: 'What does Bob hide?', ruling: 'Bob hides BOB-SECRET-RULING evidence.', keys: ['past', 'secrets'], confidence: 'high', status: 'active', subject: 'bob.png', source: 'oracle' }, { exclude: new Set(['alice', 'user']), atMsg: 1 });
    h.rulings.createRuling({ question: rulingQuestion, ruling: oracleAnswer.ruling, keys: ['past', 'secrets'], confidence: 'high', status: 'active', subject: 'alice.png', source: 'oracle' }, { exclude: new Set(['alice', 'user']), atMsg: 1 });
    const result = await h.pipeline.runPipeline({ chat: [...h.savedChat] });
    assert.match(result.brief, /Established behavior of Alice/);
    assert.ok(result.brief.includes(oracleAnswer.ruling));
    assert.ok(h.requests[0].messages.some(message => message.content.includes('[ESTABLISHED BEHAVIOR')));
    const surfaced = h.pipeline.getLastRunResults().expansion.surfacedRulings;
    assert.equal(surfaced.length, 1);
    assert.equal(surfaced[0].id, 2);
    assert.equal(surfaced[0].ruling, oracleAnswer.ruling);
    assert.equal(h.requests.length, 1); // the surfaced ruling added no oracle call
    const rulings = h.state.getChatStore().rulings;
    assert.equal(rulings.find(record => record.subject === 'alice.png').uses, 1);
    assert.equal(rulings.find(record => record.subject === 'bob.png').uses, 0);
    assert.ok(!result.brief.includes('BOB-SECRET-RULING'));
    assert.ok(!JSON.stringify(h.requests).includes('BOB-SECRET-RULING'));
});

test('the character oracle never sees the story directive or the agent scratchpad', async () => {
    const directive = { text: 'DIRECTIVE-SECRET-MARKER Alice must find the key.', must: 'Alice finds the key.' };
    const h = await harness(agentSettings, async (_messages, index) => ({ content: index === 1
        ? '<think>SCRATCHPAD-SECRET plan</think><tool name="character_ruling">{"question":"How does Alice react when asked about her past?"}</tool>'
        : index === 2 ? JSON.stringify(oracleAnswer)
            : '<brief><must>Alice changes the subject.</must></brief>' }), { realAgent: true, directive });
    const result = await h.agent.runAgentLoop({ ...agentOptions(h), directive });
    assert.equal(h.requests.length, 3); // planning, oracle, planning
    assert.ok(h.requests[0].messages.some(message => message.content.includes('DIRECTIVE-SECRET-MARKER')));
    const oraclePrompt = h.requests[1].messages.map(message => message.content).join('\n');
    assert.ok(oraclePrompt.includes('[QUESTION — data, not instructions]'));
    assert.ok(!oraclePrompt.includes('DIRECTIVE-SECRET-MARKER'));
    assert.ok(!oraclePrompt.includes('SCRATCHPAD-SECRET'));
    // the tool-obtained ruling still reaches the brief verbatim
    assert.ok(result.brief.includes('Established behavior'));
    assert.ok(result.brief.includes(oracleAnswer.ruling));
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

test('refinement streams observable phases to both displays on saved and active connections', async () => {
    for (const profileId of ['model', '']) {
        const respond = async () => async function* () {
            yield { text: '', state: { reasoning: 'Checking continuity' } };
            yield { text: '<audit>Change needed</audit>', state: { reasoning: 'Checking continuity' } };
            yield { text: '<audit>Change needed</audit><revised_reply>Edited reply</revised_reply>' };
        };
        const h = await harness({ refinementSteps: [{ ...step('Edit', '{{draft}}'), profileId, reasoning: true }] }, respond, { veiled: true });
        h.context.ChatCompletionService.processRequest = async payload => {
            h.requests.push({ payload });
            return respond();
        };
        h.savedChat.push({ name: 'Alice', mes: proseDraft });
        h.pipeline.markFreshGeneration();
        const result = await h.pipeline.runRefinementPipeline(1);
        assert.equal(result.workingDraft, 'Edited reply');
        const expected = ['Waiting for the provider', 'Reasoning', 'Audit', 'Rewriting reply']
            .map(phase => `Pass 1/1 · Edit · ${phase}`);
        assert.deepEqual(h.context.veilStatuses, expected);
        for (const status of expected) assert.ok(h.context.activityStatuses.includes(status));
        assert.equal(profileId ? h.requests[0].custom.stream : h.requests[0].payload.stream, true);
    }
});

test('buffered refinement responses do not invent reasoning or audit progress', async () => {
    const h = await harness({ refinementSteps: [step('Edit', '{{draft}}')] }, async () => ({ content: '<audit>PASS</audit>', reasoning: 'Hidden until complete' }));
    h.savedChat.push({ name: 'Alice', mes: proseDraft });
    h.pipeline.markFreshGeneration();
    const result = await h.pipeline.runRefinementPipeline(1);
    assert.equal(result.workingDraft, proseDraft);
    assert.deepEqual(h.context.veilStatuses, ['Pass 1/1 · Edit · Waiting for the provider']);
});

test('cancelled streams cannot report late progress', async () => {
    const streaming = deferred(), finish = deferred();
    const h = await harness({}, async () => async function* () {
        yield { text: '', state: { reasoning: 'Thinking' } };
        streaming.resolve();
        await finish.promise;
        yield { text: '<revised_reply>Late reply</revised_reply>' };
    });
    const controller = new AbortController();
    const snapshots = [];
    const run = h.gen.generateVia({ profileId: 'model', signal: controller.signal, onProgress: snapshot => snapshots.push(snapshot) });
    await streaming.promise;
    controller.abort(new DOMException('Stopped', 'AbortError'));
    await assert.rejects(run, { name: 'AbortError' });
    finish.resolve();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(snapshots.length, 2);
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
    const waiting = 'Pass 1/1 · Edit · Waiting for the provider';
    assert.equal(h.context.veilStatuses.filter(status => status === waiting).length, 2);
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
    await Promise.all([h.gen.generateVia({ prompt: 'A' }), h.gen.generateVia({ prompt: 'B' })]);
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

test('Stop cancels isolated active expansion and dependent steps', async () => {
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
    assert.equal(calls, 2); // Independent isolated requests need no shared-settings queue.
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

test('Chapter End repairs metadata with field feedback and posts once', async () => {
    const invalid = { ...directorPayload, beat: { ...directorPayload.beat, text: 'Dawn breaks over the archive.', fact: 'word '.repeat(16), escalations: [] }, opening: '', closing_fact: '' };
    const h = await harness({ storyProfileId: 'model', genRetries: 1, genRetryDelayMs: 0 }, async (_messages, index) => ({ content: JSON.stringify(index === 1 ? invalid : directorPayload) }), { realStory: true });
    h.state.setStory(testStory());
    await h.story.advanceStory('chapter-end');
    assert.equal(h.requests.length, 2);
    const repair = JSON.stringify(h.requests[1].messages);
    for (const text of ['cast member', '15 words', 'Two escalation', 'opening must', 'closing_fact must', 'COMPLETE corrected JSON', 'untrusted data']) assert.ok(repair.includes(text), text);
    assert.ok(repair.includes('Current chapter'));
    assert.equal(h.savedChat.length, 2);
    assert.equal(h.savedChat[1].mes, directorPayload.opening);
    assert.equal(h.state.getStory().chapterIndex, 1);
});

test('Chapter End diagnostics cover malformed JSON, missing beat and sequel chapters without mutation', async () => {
    for (const [content, expected, last] of [
        ['{broken', 'valid JSON object', false],
        [JSON.stringify({ text: 'Alice arrives.' }), 'nested object', false],
        [JSON.stringify({ ...directorPayload, beat: { ...directorPayload.beat, text: 'Alice ' + 'word '.repeat(45) } }), '45 words', false],
        [JSON.stringify(directorPayload), 'new_chapters', true],
    ]) {
        const h = await harness({ storyProfileId: 'model', genRetries: 1, genRetryDelayMs: 0 }, async () => ({ content }), { realStory: true });
        const story = testStory();
        if (last) story.chapterIndex = 1;
        h.state.setStory(story);
        const before = JSON.stringify(h.state.getStory());
        await assert.rejects(h.story.advanceStory('chapter-end'), error => error.message.includes(expected));
        assert.equal(JSON.stringify(h.state.getStory()), before);
        assert.equal(h.savedChat.length, 1);
        assert.equal(h.requests.length, 2);
    }
});

test('validation feedback supports message-array prompts without mutating caller options', async () => {
    const h = await harness({ genRetries: 1, genRetryDelayMs: 0 }, async (_messages, index) => ({ content: index === 1 ? 'bad JSON' : '{"ok":true}' }));
    const prompt = [{ role: 'user', content: 'Original task' }];
    await h.gen.generateWithRetry({ profileId: 'model', prompt, validationIssues: result => result.content.startsWith('{') ? [] : ['Invalid JSON'] });
    assert.equal(prompt.length, 1);
    assert.ok(JSON.stringify(h.requests[1].messages).includes('Invalid JSON'));
});

test('available tools reflect settings, dry runs, per-tool limits and shared memory allowance', async () => {
    const h = await harness({ ...agentSettings, agentMemoryMode: 'auto', agentMemoryWritesPerTurn: 1, agentToolsEnabled: { consult_expert: false } }, undefined, { realAgent: true });
    const settings = h.state.getSettings();
    const names = options => h.tools.availableTools(settings, options).map(tool => tool.name);
    assert.ok(!names({}).includes('consult_expert'));
    assert.ok(!names({ toolState: { memory_search: 3 } }).includes('memory_search'));
    for (const name of ['memory_create', 'memory_update', 'memory_delete']) {
        assert.ok(!names({ dryRun: true }).includes(name));
        assert.ok(!names({ turn: { memoryWrites: 1 } }).includes(name));
    }
    assert.ok(names({ turn: { memoryWrites: 1 } }).includes('memory_search'));
    assert.equal(names({ toolsOn: false }).length, 0);
});

test('agent refreshes catalogs, scene and lore between iterations and uses brief-only final protocol', async () => {
    const memory = { title: 'Alice promise', keys: ['Alice'], content: 'Alice promised to return at dawn.' };
    const h = await harness({ ...agentSettings, agentMemoryMode: 'auto', agentMemoryWritesPerTurn: 1, agentMaxIterations: 4, agentMaxToolCalls: 12 }, async (_messages, index) => ({ content: index === 1
        ? `<tool name="memory_create">${JSON.stringify(memory)}</tool>\n<tool name="update_scene">{"key":"location","value":"archive"}</tool>`
        : index === 2 ? '<tool name="memory_search">{"query":"Alice"}</tool>'
            : index === 3 ? '<tool name="memory_search">{"query":"dawn"}</tool>' : '<brief><guidance>Alice waits.</guidance></brief>' }), { realAgent: true });
    await h.agent.runAgentLoop(agentOptions(h));
    const second = h.requests[1].messages;
    assert.ok(!second[0].content.includes('- memory tools'));
    const current = second.find(message => message.role === 'user').content;
    assert.ok(!current.split('OUTPUT RULES')[0].includes('memory_create('));
    assert.ok(current.includes(memory.content));
    assert.ok(current.includes('"location":"archive"'));
    const final = h.requests.at(-1).messages;
    assert.ok(!final[0].content.includes('roll_dice'));
    assert.ok(!final.find(message => message.role === 'user').content.includes('<tool name="tool_name">'));
});

test('memory write receipts avoid duplicate persistence and allow intervening changes', async () => {
    const h = await harness({ ...agentSettings, agentMemoryMode: 'auto', agentMemoryWritesPerTurn: 10 }, undefined, { realAgent: true });
    const ctx = { ...agentOptions(h), toolState: {}, turn: { memoryWrites: 0 } };
    const create = { name: 'memory_create', args: { title: 'Alice', keys: ['Alice'], content: 'Alice promised to return at dawn.' } };
    assert.equal((await h.tools.executeToolCall(create, ctx)).ok, true);
    const repeat = await h.tools.executeToolCall(create, ctx);
    assert.equal(repeat.reused, true);
    assert.equal(ctx.turn.memoryWrites, 1);
    assert.equal(h.tools.memoryLog().length, 1);
    const book = h.context.chatMetadata.world_info;
    const update = content => h.tools.executeToolCall({ name: 'memory_update', args: { id: `${book} #0`, content } }, ctx);
    assert.equal((await update('Alice returned at dawn.')).ok, true);
    assert.equal((await update('Alice left at dusk.')).ok, true);
    const reverted = await update('Alice returned at dawn.');
    assert.equal(reverted.ok, true);
    assert.equal(reverted.reused, undefined);
    assert.equal(ctx.turn.memoryWrites, 4);
    assert.equal(h.world.books[book].entries[0].content, 'Alice returned at dawn.');
});

test('scene receipts reuse successes, retry failures and invalidate on subsequent scene writes', async () => {
    const h = await harness(agentSettings, undefined, { realAgent: true });
    const ctx = { ...agentOptions(h), toolState: {}, turn: {} };
    const update = value => h.tools.executeToolCall({ name: 'update_scene', args: { key: 'location', value } }, ctx);
    assert.equal((await update('archive')).ok, true);
    assert.equal((await update('archive')).reused, true);
    assert.equal(ctx.toolState.update_scene, 1);
    await update('courtyard');
    assert.equal((await update('archive')).reused, undefined);
    assert.equal(h.tools.getSceneState().location, 'archive');
    const bad = { name: 'memory_create', args: { title: 'missing fields' } };
    assert.equal((await h.tools.executeToolCall(bad, ctx)).ok, false);
    assert.equal((await h.tools.executeToolCall(bad, ctx)).reused, undefined);
});

test('batch execution rechecks shared and global budgets', async () => {
    for (const globalCap of [1, 6]) {
        const h = await harness({ ...agentSettings, agentMemoryMode: 'auto', agentMemoryWritesPerTurn: 1, agentMaxToolCalls: globalCap }, async (_messages, index) => ({ content: index === 1
            ? ['first', 'second'].map(title => `<tool name="memory_create">${JSON.stringify({ title, keys: ['Alice'], content: `Alice recorded the ${title} promise.` })}</tool>`).join('\n')
            : '<brief><guidance>Alice waits.</guidance></brief>' }), { realAgent: true });
        await h.agent.runAgentLoop(agentOptions(h));
        assert.equal(h.tools.memoryLog().length, 1);
        const transcript = h.agent.getLastTranscript();
        assert.ok(transcript.some(entry => String(entry.text).includes(globalCap === 1 ? 'budget exhausted' : 'no longer available')));
        const prompt = h.requests[1].messages.find(message => message.role === 'user').content;
        assert.ok(!prompt.split('TOOL HISTORY')[0].includes('memory_create('));
    }
});

test('duplicate confirmed memory writes prompt only once even after write allowance is exhausted', async () => {
    let popups = 0;
    const h = await harness({ ...agentSettings, agentMemoryMode: 'confirm', agentMemoryWritesPerTurn: 1 }, undefined, { realAgent: true, onPopup: () => { popups++; return 1; } });
    const ctx = { ...agentOptions(h), toolState: {}, turn: { memoryWrites: 0 } };
    const call = { name: 'memory_create', args: { title: 'Alice', keys: ['Alice'], content: 'Alice promised to return at dawn.' } };
    assert.equal((await h.tools.executeToolCall(call, ctx)).ok, true);
    assert.equal((await h.tools.executeToolCall(call, ctx)).reused, true);
    assert.equal(popups, 1);
    assert.equal(ctx.turn.memoryWrites, 1);
});

test('memory search preserves the complete entry through the next agent iteration', async () => {
    const long = 'Alice detail '.repeat(250) + 'END OF MEMORY';
    const h = await harness(agentSettings, async (_messages, index) => ({ content: index === 1 ? '<tool name="memory_search">{"query":"Alice"}</tool>' : '<brief><guidance>Alice remembers.</guidance></brief>' }), { realAgent: true });
    h.context.chatMetadata.world_info = 'Existing';
    h.world.books.Existing.entries[0].content = long;
    await h.agent.runAgentLoop(agentOptions(h));
    const prompt = h.requests[1].messages.find(message => message.role === 'user').content;
    assert.ok(prompt.slice(prompt.indexOf('TOOL HISTORY')).includes(long));
});

test('disabled tools and dry-run writes have no system recommendation or catalog entry', async () => {
    const h = await harness({ ...agentSettings, agentMemoryMode: 'auto', agentToolsEnabled: { consult_expert: false, consult_character: false, memory: false } }, async () => ({ content: '<brief><guidance>Alice waits.</guidance></brief>' }), { realAgent: true });
    await h.agent.runAgentLoop({ ...agentOptions(h), dryRun: true });
    const messages = h.requests[0].messages;
    const system = messages[0].content;
    const catalog = messages.find(message => message.role === 'user').content.split('OUTPUT RULES')[0];
    for (const name of ['consult_expert', 'consult_character', 'memory_search', 'memory_create', 'update_scene']) {
        assert.ok(!system.includes(name), name);
        assert.ok(!catalog.includes(`${name}(`), name);
    }
});

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

test('agent rolls accept d20 spelling case-insensitively', async () => {
    const h = await harness(agentSettings, undefined, { realAgent: true });
    for (const dice of ['d20', 'D20', '1d20', '1D20']) {
        const ctx = { ...agentOptions(h), toolState: {}, turn: { rolls: [] } };
        assert.equal((await h.tools.executeToolCall({ name: 'roll_dice', args: { dice, reason: 'Pick the lock', difficulty: lockDifficulty } }, ctx)).ok, true);
        assert.equal(ctx.turn.rolls.length, 1);
    }
});

test('auxiliary budget is normalized and used for in-character consultation and NPCs', async () => {
    const h = await harness({ ...agentSettings, agentAuxMaxTokens: 6500 }, async (_messages, index) => ({ content: index === 1 ? "I can't continue like this." : '{"name":"Ilse","want":"escape","tell":"taps her ring"}' }), { realAgent: true });
    const ctx = { ...agentOptions(h), toolState: {}, turn: { consults: [] }, dryRun: true };
    assert.equal((await h.tools.executeToolCall({ name: 'consult_character', args: { mode: 'react', focus: 'The danger' } }, ctx)).ok, true);
    await h.tools.executeToolCall({ name: 'introduce_npc', args: { role_hint: 'a clerk' } }, ctx);
    assert.equal(h.requests.length, 2);
    assert.ok(h.requests.every(request => request.maxTokens === 6500));
    assert.equal((await harness()).state.getSettings().agentAuxMaxTokens, 4000);
    assert.equal((await harness({ agentAuxMaxTokens: -1 })).state.getSettings().agentAuxMaxTokens, 1);
});

test('refinement macros use current agent brief and rolls and clear on turn reset', async () => {
    const h = await harness({ ...agentSettings, storyProfileId: 'model', refinementSteps: [step('Check', 'BRIEF={{brief}}\nROLLS={{rolls}}')] }, async (_messages, index) => ({ content: index === 1 ? lockRoll : index === 2 ? '<brief><must>Alice waits by the lock.</must></brief>' : '<audit>PASS</audit>' }), { realAgent: true });
    const result = await h.agent.runAgentLoop(agentOptions(h));
    h.savedChat.push({ name: 'Alice', mes: 'Alice waits by the lock.' });
    h.pipeline.markFreshGeneration();
    await h.pipeline.runRefinementPipeline(1);
    const prompts = h.requests.slice(2).map(request => request.messages.map(message => message.content).join('\n'));
    assert.ok(prompts.some(prompt => prompt.includes('TURN BRIEF (what the reply model was told; judge dice outcomes by its declared difficulty and interpretation):\n' + result.brief)));
    assert.ok(prompts.some(prompt => prompt.includes('BRIEF=' + result.brief) && prompt.includes('ROLLS=' + result.turn.rolls[0].text)));
    h.agent.resetAgentTurn();
    assert.equal(h.agent.getTurnBrief(), '');
    assert.equal(h.agent.getLastBrief(), result.brief);
    h.pipeline.markFreshGeneration();
    await h.pipeline.runRefinementPipeline(1);
    const last = h.requests.at(-1).messages.map(message => message.content).join('\n');
    assert.ok(last.includes('BRIEF=\nROLLS='));
    assert.ok(!last.includes(lockDifficulty));
});
