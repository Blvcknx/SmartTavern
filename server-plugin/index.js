// SmartTavern MCP bridge — a SillyTavern SERVER plugin.
//
// It lets the SmartTavern extension (a browser-side, static extension) use Model Context
// Protocol servers: browsers cannot spawn stdio MCP servers, so this plugin does it on the
// ST server and exposes four small JSON routes under /api/plugins/smarttavern-mcp/:
//
//   GET  /status   connection state of every configured server (never connects)
//   GET  /tools    tools of all reachable servers (connects lazily, retries failed servers)
//   POST /call     { server, tool, args } -> { ok, content, isError }
//   POST /reload   re-read mcp-servers.json, drop every connection
//
// Security model: only servers named in mcp-servers.json can be reached, only tools those
// servers actually list (and `allowTools` permits) can be called, and ST's own CSRF / auth
// middleware guards /api. MCP servers run with the permissions of the ST process: only
// configure servers you trust.
//
// Loader contract (SillyTavern src/plugin-loader.js): `info`, `init(router)`, `exit()`.
// The SDK is imported lazily so the plugin always loads; without `npm install` every route
// answers with a clear error instead of crashing ST.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const info = {
    id: 'smarttavern-mcp',
    name: 'SmartTavern MCP bridge',
    description: 'Exposes configured MCP servers (stdio / HTTP) to the SmartTavern extension as callable tools.',
};

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_CONFIG_PATH = path.join(HERE, 'mcp-servers.json');

export const DEFAULT_TIMEOUT_MS = 30000;
export const MIN_TIMEOUT_MS = 1000;
export const MAX_TIMEOUT_MS = 300000;
export const MAX_RESULT_CHARS = 8000;

const isPlainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const messageOf = error => String(error?.message ?? error);

// --------------------------------------------------------------------------------------------
// Config
// --------------------------------------------------------------------------------------------

function stringMap(value) {
    const out = {};
    if (!isPlainObject(value)) return out;
    for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean') out[key] = String(item);
    }
    return out;
}

/**
 * Validates a parsed mcp-servers.json. Never throws: unusable entries are dropped and
 * explained in `errors`, so one typo does not take the other servers down.
 * @returns {{servers: object[], errors: string[]}}
 */
export function normalizeConfig(raw, baseDir = HERE) {
    const errors = [];
    const servers = [];
    const list = Array.isArray(raw?.servers) ? raw.servers : [];
    if (raw !== undefined && !Array.isArray(raw?.servers)) errors.push('config needs a "servers" array');
    const seen = new Set();
    list.forEach((entry, index) => {
        const label = `servers[${index}]`;
        if (!isPlainObject(entry)) { errors.push(`${label}: must be an object`); return; }
        const name = typeof entry.name === 'string' ? entry.name.trim() : '';
        if (!name) { errors.push(`${label}: "name" is required`); return; }
        if (seen.has(name)) { errors.push(`${label}: duplicate server name "${name}"`); return; }
        const transport = entry.transport ?? (entry.url ? 'http' : 'stdio');
        const common = {
            name,
            write: entry.write === true,
            timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(Number(entry.timeoutMs)) || DEFAULT_TIMEOUT_MS)),
            // null = every tool the server lists; an array restricts to exactly those names.
            allowTools: Array.isArray(entry.allowTools) ? entry.allowTools.filter(item => typeof item === 'string' && item) : null,
        };
        if (transport === 'stdio') {
            if (typeof entry.command !== 'string' || !entry.command.trim()) { errors.push(`${label} (${name}): stdio needs "command"`); return; }
            servers.push({
                ...common, transport,
                command: entry.command.trim(),
                args: Array.isArray(entry.args) ? entry.args.map(String) : [],
                env: stringMap(entry.env),
                cwd: typeof entry.cwd === 'string' && entry.cwd.trim() ? path.resolve(baseDir, entry.cwd.trim()) : undefined,
            });
        } else if (transport === 'http') {
            let url = null;
            try {
                url = new URL(String(entry.url ?? ''));
            } catch { /* reported below */ }
            if (!url || !/^https?:$/.test(url.protocol)) { errors.push(`${label} (${name}): http needs a valid http(s) "url"`); return; }
            servers.push({ ...common, transport, url: url.href, headers: stringMap(entry.headers) });
        } else {
            errors.push(`${label} (${name}): unknown transport "${transport}" (use "stdio" or "http")`);
            return;
        }
        seen.add(name);
    });
    return { servers, errors };
}

export function readConfigFile(configPath) {
    let text;
    try {
        text = fs.readFileSync(configPath, 'utf8');
    } catch (error) {
        if (error?.code === 'ENOENT') return { found: false, servers: [], errors: [] };
        return { found: true, servers: [], errors: [`cannot read ${path.basename(configPath)}: ${messageOf(error)}`] };
    }
    try {
        return { found: true, ...normalizeConfig(JSON.parse(text), path.dirname(configPath)) };
    } catch (error) {
        return { found: true, servers: [], errors: [`${path.basename(configPath)} is not valid JSON: ${messageOf(error)}`] };
    }
}

// --------------------------------------------------------------------------------------------
// Result flattening
// --------------------------------------------------------------------------------------------

/** Flattens an MCP tools/call result into one capped text block. */
export function flattenResult(result, cap = MAX_RESULT_CHARS) {
    const parts = [];
    for (const part of Array.isArray(result?.content) ? result.content : []) {
        if (!isPlainObject(part)) continue;
        switch (part.type) {
            case 'text': if (typeof part.text === 'string') parts.push(part.text); break;
            case 'image': parts.push('[image]'); break;
            case 'audio': parts.push('[audio]'); break;
            case 'resource': {
                const resource = part.resource ?? {};
                parts.push(typeof resource.text === 'string' && resource.text ? resource.text : `[resource ${resource.uri ?? ''}]`.replace(' ]', ']'));
                break;
            }
            case 'resource_link': parts.push(`[resource ${part.uri ?? ''}]`.replace(' ]', ']')); break;
            default: parts.push(`[${part.type ?? 'content'}]`);
        }
    }
    let text = parts.join('\n').trim();
    if (!text && result?.structuredContent !== undefined) {
        try { text = JSON.stringify(result.structuredContent); } catch { /* ignore */ }
    }
    return text.length > cap ? `${text.slice(0, cap)}\n…[truncated ${text.length - cap} characters]` : text;
}

const withTimeout = (promise, ms, label) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error(`${label} timed out after ${ms} ms`), { timeout: true })), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
});

// --------------------------------------------------------------------------------------------
// Bridge: connections, tool cache, calls
// --------------------------------------------------------------------------------------------

async function loadSdk() {
    try {
        const [client, stdio, streamable, sse] = await Promise.all([
            import('@modelcontextprotocol/sdk/client/index.js'),
            import('@modelcontextprotocol/sdk/client/stdio.js'),
            import('@modelcontextprotocol/sdk/client/streamableHttp.js'),
            import('@modelcontextprotocol/sdk/client/sse.js'),
        ]);
        return {
            Client: client.Client,
            StdioClientTransport: stdio.StdioClientTransport,
            getDefaultEnvironment: stdio.getDefaultEnvironment,
            StreamableHTTPClientTransport: streamable.StreamableHTTPClientTransport,
            SSEClientTransport: sse.SSEClientTransport,
        };
    } catch (error) {
        throw new Error(`the MCP SDK is not installed — run "npm install" in the plugin folder (${messageOf(error)})`);
    }
}

/**
 * @param {{configPath?: string, loadSdk?: () => Promise<object>, log?: (...args: any[]) => void}} options
 *   `loadSdk` is injectable for tests.
 */
export function createBridge({ configPath = DEFAULT_CONFIG_PATH, loadSdk: sdkLoader = loadSdk, log = (...args) => console.log('[smarttavern-mcp]', ...args) } = {}) {
    let config = { found: false, servers: [], errors: [] };
    // name -> { client, connecting, error, tools }
    let states = new Map();
    let sdkPromise = null;
    let sdkError = '';

    const getSdk = () => {
        sdkPromise ??= sdkLoader().catch(error => { sdkPromise = null; sdkError = messageOf(error); throw error; });
        return sdkPromise;
    };

    function reload() {
        const old = states;
        states = new Map();
        for (const state of old.values()) void closeState(state);
        config = readConfigFile(configPath);
        for (const server of config.servers) states.set(server.name, { server, client: null, connecting: null, error: '', tools: null });
        return { servers: config.servers.length, errors: config.errors };
    }

    async function closeState(state) {
        const client = state.client;
        state.client = null;
        state.tools = null;
        try { await client?.close(); } catch { /* already gone */ }
    }

    async function openClient(sdk, server) {
        const attempt = async transport => {
            const client = new sdk.Client({ name: 'smarttavern', version: '1.0.0' }, { capabilities: {} });
            try {
                await withTimeout(client.connect(transport), server.timeoutMs, `connecting to "${server.name}"`);
            } catch (error) {
                try { await client.close(); } catch { /* ignore */ }
                throw error;
            }
            return client;
        };
        if (server.transport === 'stdio') {
            return attempt(new sdk.StdioClientTransport({
                command: server.command, args: server.args, cwd: server.cwd,
                env: { ...(sdk.getDefaultEnvironment?.() ?? {}), ...server.env },
            }));
        }
        const url = new URL(server.url);
        const requestInit = { headers: server.headers };
        try {
            return await attempt(new sdk.StreamableHTTPClientTransport(url, { requestInit }));
        } catch (streamableError) {
            // Older servers only speak the legacy HTTP+SSE transport.
            log(`"${server.name}": streamable HTTP failed (${messageOf(streamableError)}); trying SSE`);
            try {
                return await attempt(new sdk.SSEClientTransport(url, {
                    requestInit,
                    eventSourceInit: { fetch: (target, init) => fetch(target, { ...init, headers: { ...(init?.headers ?? {}), ...server.headers } }) },
                }));
            } catch (sseError) {
                throw new Error(`${messageOf(streamableError)} (SSE fallback: ${messageOf(sseError)})`);
            }
        }
    }

    /** Lazy, shared connect: concurrent callers wait on the same attempt. */
    async function connect(state) {
        if (state.client) return state.client;
        state.connecting ??= (async () => {
            try {
                const sdk = await getSdk();
                const client = await openClient(sdk, state.server);
                // A dropped connection (server crashed / exited) is retried on the next use.
                client.onclose = () => { if (state.client === client) { state.client = null; state.tools = null; } };
                state.client = client;
                state.error = '';
                return client;
            } catch (error) {
                state.error = messageOf(error);
                throw error;
            } finally {
                state.connecting = null;
            }
        })();
        return state.connecting;
    }

    async function toolsOf(state) {
        if (state.tools && state.client) return state.tools;
        const client = await connect(state);
        const listed = [];
        let cursor;
        do {
            const page = await withTimeout(client.listTools(cursor ? { cursor } : undefined), state.server.timeoutMs, `listing tools of "${state.server.name}"`);
            listed.push(...(page?.tools ?? []));
            cursor = page?.nextCursor;
        } while (cursor && listed.length < 500);
        const allow = state.server.allowTools;
        state.tools = listed
            .filter(tool => typeof tool?.name === 'string' && tool.name && (!allow || allow.includes(tool.name)))
            .map(tool => ({
                server: state.server.name,
                name: tool.name,
                description: typeof tool.description === 'string' ? tool.description : '',
                inputSchema: isPlainObject(tool.inputSchema) ? tool.inputSchema : { type: 'object', properties: {} },
                write: state.server.write,
            }));
        return state.tools;
    }

    reload();

    return {
        reload,
        get config() { return config; },

        /** Never connects: reports what is known. */
        status() {
            return {
                ok: true,
                configFound: config.found,
                configErrors: config.errors,
                sdk: sdkError ? { ok: false, error: sdkError } : { ok: true },
                servers: [...states.values()].map(state => ({
                    name: state.server.name, transport: state.server.transport, write: state.server.write, timeoutMs: state.server.timeoutMs,
                    connected: Boolean(state.client), error: state.error,
                })),
            };
        },

        async tools() {
            const tools = [];
            await Promise.all([...states.values()].map(async state => {
                try {
                    tools.push(...await toolsOf(state));
                } catch (error) {
                    state.error = messageOf(error);
                }
            }));
            // Config order, not completion order.
            const order = new Map(config.servers.map((server, index) => [server.name, index]));
            tools.sort((a, b) => order.get(a.server) - order.get(b.server));
            return { ok: true, tools, errors: [...states.values()].filter(state => state.error).map(state => ({ server: state.server.name, error: state.error })) };
        },

        /** @returns {Promise<{status: number, body: object}>} */
        async call(body) {
            const server = body?.server;
            const tool = body?.tool;
            const args = body?.args ?? {};
            if (typeof server !== 'string' || typeof tool !== 'string' || !server || !tool) {
                return { status: 400, body: { ok: false, error: '"server" and "tool" must be non-empty strings' } };
            }
            if (!isPlainObject(args)) return { status: 400, body: { ok: false, error: '"args" must be an object' } };
            const state = states.get(server);
            if (!state) return { status: 404, body: { ok: false, error: `unknown server "${server}"` } };
            if (state.server.allowTools && !state.server.allowTools.includes(tool)) {
                return { status: 403, body: { ok: false, error: `tool "${tool}" is not allowed for server "${server}"` } };
            }
            try {
                // The tool must be one the server really lists (and allowTools permits).
                const known = await toolsOf(state);
                if (!known.some(item => item.name === tool)) return { status: 404, body: { ok: false, error: `server "${server}" has no tool "${tool}"` } };
                const run = async () => {
                    const client = await connect(state);
                    return withTimeout(client.callTool({ name: tool, arguments: args }, undefined, { timeout: state.server.timeoutMs }), state.server.timeoutMs, `calling "${tool}"`);
                };
                let result;
                try {
                    result = await run();
                } catch (error) {
                    // A dead connection is replaced once; tool-level errors and timeouts are not retried.
                    if (error?.timeout || state.client) throw error;
                    result = await run();
                }
                return { status: 200, body: { ok: true, content: flattenResult(result), isError: result?.isError === true } };
            } catch (error) {
                if (error?.timeout) await closeState(state); // a hung server is restarted on next use
                return { status: 200, body: { ok: false, error: messageOf(error) } };
            }
        },

        async close() {
            const all = [...states.values()];
            states = new Map();
            await Promise.all(all.map(closeState));
        },
    };
}

// --------------------------------------------------------------------------------------------
// Loader contract
// --------------------------------------------------------------------------------------------

let bridge = null;

function wrap(handler) {
    return async (request, response) => {
        try {
            await handler(request, response);
        } catch (error) {
            if (!response.headersSent) response.status(500).json({ ok: false, error: messageOf(error) });
        }
    };
}

/** @param {import('express').Router} router */
export async function init(router, options = {}) {
    bridge = createBridge(options);
    router.get('/status', wrap((_request, response) => response.json(bridge.status())));
    router.get('/tools', wrap(async (_request, response) => response.json(await bridge.tools())));
    router.post('/call', wrap(async (request, response) => {
        const { status, body } = await bridge.call(request.body);
        response.status(status).json(body);
    }));
    router.post('/reload', wrap(async (_request, response) => {
        const summary = bridge.reload();
        response.json({ ok: true, ...summary });
    }));
    log();
}

function log() {
    const { servers, errors } = bridge.config;
    console.log(`[smarttavern-mcp] ready: ${servers.length} server(s) configured${errors.length ? `, ${errors.length} config problem(s): ${errors.join('; ')}` : ''}`);
}

export async function exit() {
    await bridge?.close();
    bridge = null;
}
