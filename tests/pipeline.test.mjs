// Run: node --experimental-vm-modules --test tests/pipeline.test.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SourceTextModule, createContext } from 'node:vm';

async function harness(settings = {}, respond = async () => ({ content: 'GENERATED ASSESSMENT' })) {
    const requests = [];
    const savedChat = [{ is_user: true, name: 'User', mes: 'Hello' }];
    const context = {
        extensionSettings: { smarttavern: { bootstrapOnFirstMessage: false, promptTailVersion: 1, injectAnchor: 'before-last-user', ...settings }, connectionManager: { profiles: [{ id: 'model', mode: 'cc' }] } },
        chat: savedChat, chatMetadata: {}, characterId: 0,
        characters: [{ name: 'Alice', avatar: 'alice.png' }], name1: 'User', name2: 'Alice',
        saveSettingsDebounced() {}, substituteParams: text => text,
        ConnectionManagerRequestService: { async sendRequest(id, messages) {
            requests.push({ id, messages });
            return respond(messages, requests.length);
        } },
        generateRaw: async options => { requests.push(options); return 'ACTIVE OUTPUT'; },
    };
    const sandbox = createContext({ context, console: { log() {}, warn() {} }, toastr: { warning() {} } });
    const modules = new Map();
    const sources = {
        extensions: 'export const getContext = () => context;',
        'system-messages': "export const system_message_types = { NARRATOR: 'narrator' };",
        profiles: 'export const serializeProfile = () => "PROFILE"; export const bootstrapProfile = async () => {};',
        'instruct-mode': `export const formatInstructModeChat = (name, text, user, system) => '<' + (system ? 'system' : user ? 'user' : 'assistant') + '>' + text + '</turn>\\n'; export const formatInstructModePrompt = () => '<assistant>';`,
        progress: 'export const activityStart = () => {}; export const activityStatus = () => {}; export const activityEntry = () => {}; export const activityFail = () => {}; export const activityEnd = () => {};',
    };
    for (const name of ['pipeline', 'state', 'gen', 'tail']) {
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
    return { pipeline: pipeline.namespace, tail: modules.get('tail').namespace, gen: modules.get('gen').namespace, state, context, requests, savedChat };
}

const step = (name, prompt, role = 'assistant') => ({ name, prompt, role, profileId: 'model', enabled: true });

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
