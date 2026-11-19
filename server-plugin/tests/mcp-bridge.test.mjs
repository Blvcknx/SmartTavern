// Run: node --test server-plugin/tests
// The config / flattening tests are pure. The end-to-end tests spawn a stdio MCP fixture and
// need the SDK (`npm install` in server-plugin/); they SKIP cleanly without it, so a plain
// checkout has no failing tests and no network access is ever needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createBridge, flattenResult, normalizeConfig, init, exit, info, MAX_RESULT_CHARS } from '../index.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = path.join(here, 'fixtures', 'echo-server.mjs');
const sdkInstalled = await import('@modelcontextprotocol/sdk/client/index.js').then(() => true, () => false);

function writeConfig(servers) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'st-mcp-'));
    const file = path.join(dir, 'mcp-servers.json');
    fs.writeFileSync(file, JSON.stringify({ servers }));
    return file;
}
const echoServer = extra => ({ name: 'echo', transport: 'stdio', command: process.execPath, args: [fixture], timeoutMs: 15000, ...extra });

test('plugin info follows the ST loader contract', () => {
    assert.equal(info.id, 'smarttavern-mcp');
    assert.match(info.id, /^[a-z0-9_-]+$/);
    assert.equal(typeof info.name, 'string');
    assert.equal(typeof info.description, 'string');
    assert.equal(typeof init, 'function');
    assert.equal(typeof exit, 'function');
});

test('normalizeConfig validates entries and drops bad ones with a reason', () => {
    const { servers, errors } = normalizeConfig({ servers: [
        { name: 'a', transport: 'stdio', command: 'node', args: ['x', 1], env: { K: 'v', bad: {} }, timeoutMs: 5 },
        { name: 'a', command: 'dup' },
        { name: 'h', transport: 'http', url: 'https://example.com/mcp', headers: { A: 'b' }, write: true, allowTools: ['t', 5] },
        { name: 'bad-url', transport: 'http', url: 'ftp://x' },
        { name: 'nocmd', transport: 'stdio' },
        { transport: 'stdio', command: 'x' },
        { name: 'weird', transport: 'carrier-pigeon' },
        'nope',
    ] }, '/base');
    assert.deepEqual(servers.map(server => server.name), ['a', 'h']);
    assert.equal(servers[0].timeoutMs, 1000); // clamped
    assert.deepEqual(servers[0].args, ['x', '1']);
    assert.deepEqual(servers[0].env, { K: 'v' });
    assert.equal(servers[0].write, false);
    assert.equal(servers[0].allowTools, null);
    assert.equal(servers[1].write, true);
    assert.deepEqual(servers[1].allowTools, ['t']);
    assert.equal(errors.length, 6);
    assert.equal(normalizeConfig({}).errors.length, 1);
});

test('flattenResult joins text, summarizes media/resources and caps the length', () => {
    const text = flattenResult({ content: [
        { type: 'text', text: 'one' }, { type: 'image', data: 'x' }, { type: 'resource', resource: { uri: 'file:///a' } },
        { type: 'resource', resource: { uri: 'file:///b', text: 'inline' } }, { type: 'resource_link', uri: 'file:///c' }, { type: 'text', text: 'two' },
    ] });
    assert.equal(text, 'one\n[image]\n[resource file:///a]\ninline\n[resource file:///c]\ntwo');
    assert.equal(flattenResult({ content: [], structuredContent: { a: 1 } }), '{"a":1}');
    const long = flattenResult({ content: [{ type: 'text', text: 'y'.repeat(MAX_RESULT_CHARS + 50) }] });
    assert.ok(long.length < MAX_RESULT_CHARS + 60);
    assert.match(long, /truncated 50 characters/);
});

test('without the SDK every route answers with a clear error and nothing crashes', async () => {
    const bridge = createBridge({ configPath: writeConfig([echoServer()]), loadSdk: async () => { throw new Error('the MCP SDK is not installed'); } });
    const tools = await bridge.tools();
    assert.deepEqual(tools.tools, []);
    assert.match(tools.errors[0].error, /not installed/);
    assert.equal(bridge.status().sdk.ok, false);
    const called = await bridge.call({ server: 'echo', tool: 'echo', args: { text: 'x' } });
    assert.equal(called.body.ok, false);
    await bridge.close();
});

test('input validation never reaches a server', async () => {
    const bridge = createBridge({ configPath: writeConfig([echoServer({ allowTools: ['echo'] })]), loadSdk: async () => { throw new Error('must not be needed'); } });
    assert.equal((await bridge.call({})).status, 400);
    assert.equal((await bridge.call({ server: 'echo', tool: 'echo', args: 'x' })).status, 400);
    assert.equal((await bridge.call({ server: 'nope', tool: 'echo' })).status, 404);
    assert.equal((await bridge.call({ server: 'echo', tool: 'secret' })).status, 403);
    // Missing config file: an empty, healthy bridge.
    const empty = createBridge({ configPath: path.join(os.tmpdir(), 'does-not-exist.json') });
    assert.equal(empty.status().configFound, false);
    assert.deepEqual(empty.status().servers, []);
});

test('routes are registered by init and answer JSON', async () => {
    const routes = {};
    const router = { get: (route, fn) => { routes[`GET ${route}`] = fn; }, post: (route, fn) => { routes[`POST ${route}`] = fn; } };
    await init(router, { configPath: writeConfig([]) });
    assert.deepEqual(Object.keys(routes).sort(), ['GET /status', 'GET /tools', 'POST /call', 'POST /reload']);
    const reply = async (key, request = {}) => {
        const out = { code: 200, headersSent: false, status(code) { out.code = code; return out; }, json(body) { out.body = body; return out; } };
        await routes[key](request, out);
        return out;
    };
    assert.equal((await reply('GET /status')).body.ok, true);
    assert.deepEqual((await reply('GET /tools')).body.tools, []);
    assert.equal((await reply('POST /call', { body: {} })).code, 400);
    assert.equal((await reply('POST /reload')).body.ok, true);
    await exit();
});

test('end to end over stdio: list, call, allow list, tool errors, truncation, reload', { skip: !sdkInstalled && 'MCP SDK not installed (run npm install in server-plugin/)' }, async () => {
    const configPath = writeConfig([echoServer({ allowTools: ['echo', 'fail', 'big'], write: true })]);
    const bridge = createBridge({ configPath });
    try {
        assert.equal(bridge.status().servers[0].connected, false); // lazy
        const listed = await bridge.tools();
        assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['big', 'echo', 'fail']); // `secret` filtered
        const echo = listed.tools.find(tool => tool.name === 'echo');
        assert.equal(echo.server, 'echo');
        assert.equal(echo.write, true);
        assert.equal(echo.inputSchema.type, 'object');
        assert.ok(echo.inputSchema.properties.text);
        assert.equal(bridge.status().servers[0].connected, true);

        const ok = await bridge.call({ server: 'echo', tool: 'echo', args: { text: 'hi' } });
        assert.deepEqual(ok.body, { ok: true, content: 'echo: hi', isError: false });
        const failed = await bridge.call({ server: 'echo', tool: 'fail' });
        assert.equal(failed.body.ok, true);
        assert.equal(failed.body.isError, true);
        assert.equal(failed.body.content, 'boom');
        assert.equal((await bridge.call({ server: 'echo', tool: 'secret' })).status, 403);
        const big = await bridge.call({ server: 'echo', tool: 'big' });
        assert.ok(big.body.content.length < 8100);
        // Bad arguments surface as an error result, not a crash.
        const bad = await bridge.call({ server: 'echo', tool: 'echo', args: { text: 5 } });
        assert.ok(bad.body.ok === false || bad.body.isError === true);

        bridge.reload();
        assert.equal(bridge.status().servers[0].connected, false);
        assert.equal((await bridge.call({ server: 'echo', tool: 'echo', args: { text: 'again' } })).body.content, 'echo: again');
    } finally {
        await bridge.close();
    }
});

test('a server that cannot start reports an error and the others keep working', { skip: !sdkInstalled && 'MCP SDK not installed' }, async () => {
    const bridge = createBridge({ configPath: writeConfig([
        { name: 'dead', transport: 'stdio', command: '/definitely/not/a/binary', timeoutMs: 5000 }, echoServer(),
    ]) });
    try {
        const listed = await bridge.tools();
        assert.ok(listed.tools.every(tool => tool.server === 'echo'));
        assert.equal(listed.errors.length, 1);
        assert.equal(listed.errors[0].server, 'dead');
        assert.equal(bridge.status().servers.find(server => server.name === 'dead').connected, false);
    } finally {
        await bridge.close();
    }
});
