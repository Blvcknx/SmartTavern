import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { SourceTextModule, createContext } from 'node:vm';

test('render listeners release ST to end generation before active refinement, then update the profile', async () => {
    const listeners = new Map();
    const order = [];
    let finish;
    const completed = new Promise(resolve => { finish = resolve; });
    const context = {
        event_types: { GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop',
            CHARACTER_MESSAGE_RENDERED: 'render', MESSAGE_RECEIVED: 'received', CHAT_CHANGED: 'chat', MESSAGE_DELETED: 'deleted' },
        eventSource: {
            on(type, fn) {
                if (!listeners.has(type)) listeners.set(type, []);
                listeners.get(type).push(fn);
            },
            async emit(type, ...args) {
                for (const fn of listeners.get(type) ?? []) await fn(...args);
            },
        },
        chat: [{ mes: 'Fresh draft' }],
        generateRaw: async () => { order.push('request'); return 'Refined draft'; },
    };
    let startup;
    const sandbox = createContext({ context, order, finish, setTimeout, clearTimeout, DOMException,
        jQuery: fn => { startup = fn(); }, console });
    const sources = {
        index: await readFile(new URL('../index.js', import.meta.url), 'utf8'),
        gen: await readFile(new URL('../src/gen.js', import.meta.url), 'utf8'),
        extensions: 'export const getContext = () => context;',
        state: `export const loadSettings = () => {}; export const getSettings = () => ({ enabled: true, refinementEnabled: true });
            export const normalizeStepSampling = value => value;
            export const clampInt = () => 0; export const log = () => {}; export const warn = (...args) => { throw new Error(args.join(' ')); };`,
        progress: 'export const activityEntry = () => {};',
        pipeline: `import { generateVia } from './gen.js';
            export const runRefinementPipeline = async () => { await generateVia({ prompt: 'Edit draft' }); order.push('refined'); };
            export const smarttavernInterceptor = () => {}; export const sweepEphemeral = () => {};
            export const resetBootstrapFailures = () => {}; export const hasFreshReply = () => true; export const cancelFreshReply = () => {};`,
        profiles: 'export const maybeAutoUpdate = () => { order.push("updated"); finish(); };',
        story: 'export const onStoryCharacterReply = () => {}; export const resetStoryGenerationState = () => {};',
        agent: 'export const clearAgentSession = () => {};',
        ui: 'export const initUI = () => {};',
        hud: 'export const initHud = () => {};',
        tail: 'export const initPromptTail = () => {};',
        description: 'export const initDescriptionOverride = () => {};',
        veil: 'export const dismissAllVeils = () => {};',
    };
    const modules = new Map(Object.entries(sources).map(([name, source]) => [name, new SourceTextModule(source, { context: sandbox })]));
    await modules.get('index').link(specifier => modules.get(specifier.split('/').at(-1).replace('.js', '')));
    await modules.get('index').evaluate();
    await startup;
    // Prime the lazy foreground tracker, as an earlier expansion call would.
    await modules.get('gen').namespace.generateVia({ prompt: 'Earlier task' });
    order.length = 0;
    await context.eventSource.emit('start');
    const rendered = context.eventSource.emit('render', 0, 'normal');
    let timer;
    const released = await Promise.race([
        rendered.then(() => true),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), 100); }),
    ]);
    clearTimeout(timer);
    // Always release the foreground wait, even if the regression returns.
    assert.deepEqual(order, []);
    await context.eventSource.emit('end');
    await completed;
    assert.equal(released, true, 'ST must not await refinement before it can emit generation ended');
    assert.deepEqual(order, ['request', 'refined', 'updated']);
});
