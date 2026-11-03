import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SourceTextModule, createContext } from 'node:vm';

async function progressHarness() {
    const elements = new Map();
    const handlers = new Map();
    const timers = new Map();
    let nextTimer = 0;
    class Element {
        constructor() { this.classes = new Set(); this.count = 0; this.length = 1; }
        find(selector) { return element(selector); }
        on(event, selector, callback) { handlers.set(typeof selector === 'string' ? selector : event, callback ?? selector); return this; }
        addClass(names) { names.split(' ').forEach(name => this.classes.add(name)); return this; }
        removeClass(names) { names.split(' ').forEach(name => this.classes.delete(name)); return this; }
        toggleClass(name, value) { return value ? this.addClass(name) : this.removeClass(name); }
        hasClass(name) { return this.classes.has(name); }
        append() { this.count++; return this; }
        empty() { this.count = 0; return this; }
        children() { return { length: this.count }; }
        get() { return null; }
        html() { return this; }
        text() { return this; }
        attr() { return this; }
        prop() { return this; }
    }
    function element(key) { if (!elements.has(key)) elements.set(key, new Element()); return elements.get(key); }
    function $(key) { return element(typeof key === 'string' && key.includes('id="smarttavern_activity"') ? 'root' : key); }
    const sandbox = createContext({ $, document: { body: {}, dispatchEvent() {} }, CustomEvent: class {},
        setTimeout(fn) { const id = ++nextTimer; timers.set(id, fn); return id; }, clearTimeout(id) { timers.delete(id); },
        setInterval() { return 1; }, clearInterval() {},
    });
    const module = new SourceTextModule(await readFile(new URL('../src/progress.js', import.meta.url), 'utf8'), { context: sandbox });
    await module.link(async specifier => {
        const source = specifier.includes('extensions') ? 'export const getContext = () => ({});'
            : specifier.includes('state') ? 'export const getSettings = () => ({});'
                : 'export const chipsHtml = () => ""; export const setChipState = () => {};';
        return new SourceTextModule(source, { context: sandbox });
    });
    await module.evaluate();
    return { api: module.namespace, elements, handlers, timers };
}

test('refinement completion and skip dismiss the chip while retaining the log', async () => {
    const h = await progressHarness();
    h.api.activityStart();
    h.api.activityEntry({ title: 'A completed pass', text: 'Output' });
    h.handlers.get('#smarttavern_activity_chip')(); // An expanded log must also disappear.
    h.api.activityEnd({ dismiss: true });
    assert.equal(h.elements.get('root').hasClass('show'), false);
    assert.equal(h.elements.get('root').hasClass('expanded'), false);
    assert.equal(h.elements.get('.smarttavern_act_log').children().length, 1);
    h.handlers.get('smarttavern:floating-changed')?.();
    assert.equal(h.elements.get('root').hasClass('show'), false);
    h.api.activityStart();
    assert.equal(h.elements.get('root').hasClass('show'), true);
});

test('retained log entries no longer prevent the idle chip from hiding', async () => {
    const h = await progressHarness();
    h.api.initProgress();
    h.api.activityStart();
    h.api.activityEntry({ title: 'Done' });
    h.api.activityEnd();
    assert.equal(h.timers.size, 1);
    [...h.timers.values()][0]();
    assert.equal(h.elements.get('root').hasClass('show'), false);
    h.handlers.get('smarttavern:floating-changed')();
    assert.equal(h.elements.get('root').hasClass('show'), false);
});

test('ending a nested run keeps the chip visible while another run is active', async () => {
    const h = await progressHarness();
    h.api.activityStart();
    h.api.activityStart();
    h.api.activityEnd({ dismiss: true });
    assert.equal(h.elements.get('root').hasClass('show'), true);
    h.api.activityEnd({ dismiss: true });
    assert.equal(h.elements.get('root').hasClass('show'), false);
});
