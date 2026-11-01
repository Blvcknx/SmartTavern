import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { SourceTextModule, createContext, runInContext } from 'node:vm';
import assert from 'node:assert/strict';

// Link the complete production graph, including UI modules that the behavioral
// harness replaces. This catches missing named exports before a browser reload.
test('extension entry point and every local UI import link successfully', async () => {
    const root = new URL('../', import.meta.url);
    const sandbox = createContext({ jQuery() {} });
    const modules = new Map();
    const external = new Map();
    const files = ['index.js', ...(await readdir(new URL('src/', root))).filter(name => name.endsWith('.js')).map(name => `src/${name}`)];
    for (const file of files) {
        const url = new URL(file, root);
        const source = await readFile(url, 'utf8');
        modules.set(url.href, new SourceTextModule(source, { context: sandbox, identifier: url.href }));
        for (const match of source.matchAll(/^import\s*\{([\s\S]*?)\}\s*from\s*['"]([^'"]+)['"]/gm)) {
            const dependency = new URL(match[2], url);
            if (dependency.href.startsWith(root.href)) continue;
            const names = external.get(dependency.href) ?? new Set();
            for (const item of match[1].split(',')) {
                const name = item.trim().split(/\s+as\s+/)[0];
                if (name) names.add(name);
            }
            external.set(dependency.href, names);
        }
    }
    for (const [url, names] of external) {
        modules.set(url, new SourceTextModule([...names].map(name => `export const ${name} = undefined;`).join('\n'), { context: sandbox, identifier: url }));
    }
    const entry = modules.get(new URL('index.js', root).href);
    await entry.link((specifier, parent) => {
        const dependency = modules.get(new URL(specifier, parent.identifier).href);
        if (!dependency) throw new Error(`Unresolved import ${specifier} from ${parent.identifier}`);
        return dependency;
    });
    await entry.evaluate(); // Register startup without invoking jQuery's ready callback.
});

test('installed ST save/load functions preserve the ownership flag through JSON persistence', async () => {
    const source = await readFile(new URL('../../../../world-info.js', import.meta.url), 'utf8');
    const definitions = ['saveWorldInfo', 'loadWorldInfo'].map(name => {
        const definition = source.match(new RegExp(`export async function ${name}\\([\\s\\S]*?\\n\\}`, 'm'))?.[0];
        assert.ok(definition, `ST still exports ${name}`);
        return definition.replace('export ', '');
    });
    let disk = '';
    const cache = new Map();
    const sandbox = createContext({
        worldInfoCache: cache,
        _save: async (_name, data) => { disk = JSON.stringify(data); },
        getRequestHeaders: () => ({}),
        fetch: async () => ({ ok: true, json: async () => JSON.parse(disk) }),
    });
    runInContext(definitions.join('\n'), sandbox);
    const entry = { uid: 1, smarttavern: true, comment: '[ST] Alice', content: 'Alice has a key.' };
    await sandbox.saveWorldInfo('Audit', { entries: { 1: entry } }, true);
    assert.equal(cache.get('Audit').entries[1].smarttavern, true);
    cache.clear();
    const loaded = await sandbox.loadWorldInfo('Audit');
    loaded.entries[1].comment = 'Edited title';
    await sandbox.saveWorldInfo('Audit', loaded, true);
    cache.clear();
    assert.equal((await sandbox.loadWorldInfo('Audit')).entries[1].smarttavern, true);
});
