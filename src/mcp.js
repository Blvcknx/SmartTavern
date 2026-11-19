// SmartTavern — MCP bridge client (ST-bound half; pure rules live in mcp-core.js).
//
// Talks to the optional `smarttavern-mcp` SERVER plugin (server-plugin/ in this repo),
// which owns the MCP connections. This module probes it, caches its tool list, registers
// the tools into the GM's tool registry and runs calls. Everything fails open: no plugin,
// a plugin error or a dead server simply means "no MCP tools this tick".
import { getContext } from '../../../../extensions.js';
import { getSettings, warn } from './state.js';
import { setExtraTools } from './agent-tools.js';
import { buildMcpTools } from './mcp-core.js';

export const MCP_BASE = '/api/plugins/smarttavern-mcp';
const PROBE_TIMEOUT_MS = 8000;
const TOOLS_TIMEOUT_MS = 60000;   // the first /tools call may have to start stdio servers
const CALL_TIMEOUT_MARGIN_MS = 5000;

// state: 'idle' (never probed) | 'loading' | 'ok' | 'absent' (plugin not installed) | 'error'
let snapshot = emptySnapshot('idle');
let refreshing = null;

function emptySnapshot(state, message = '') {
    return { state, message, status: null, tools: [], errors: [], checkedAt: 0 };
}

export const getMcpSnapshot = () => snapshot;

function notify() {
    try {
        document.dispatchEvent(new CustomEvent('smarttavern:mcp-updated', { detail: {} }));
    } catch { /* UI is optional */ }
}

function headers(extra = {}) {
    let base = {};
    try {
        base = getContext().getRequestHeaders?.() ?? {};
    } catch { /* fall through with no ST headers */ }
    return { ...base, ...extra };
}

/** JSON request to the plugin. Throws {status} errors; a 404 means the plugin is not installed. */
async function request(path, { method = 'GET', body, signal = null, timeoutMs = PROBE_TIMEOUT_MS } = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new DOMException('MCP bridge timeout', 'TimeoutError')), timeoutMs);
    const onAbort = () => controller.abort(signal.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    try {
        const response = await fetch(`${MCP_BASE}${path}`, {
            method,
            headers: headers(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: controller.signal,
        });
        let json = null;
        try { json = await response.json(); } catch { /* not JSON (HTML 404 page, proxy error) */ }
        if (!response.ok && !json) throw Object.assign(new Error(`HTTP ${response.status}`), { status: response.status });
        if (!response.ok) throw Object.assign(new Error(String(json?.error ?? `HTTP ${response.status}`)), { status: response.status });
        return json;
    } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
    }
}

/**
 * Probes the plugin, loads its tools and (re)registers them with the GM tool registry.
 * Never throws. `reload` re-reads mcp-servers.json first (reconnects every server).
 */
export function refreshMcp({ reload = false } = {}) {
    if (refreshing) return refreshing;
    snapshot = { ...snapshot, state: 'loading' };
    notify();
    refreshing = (async () => {
        try {
            if (reload) await request('/reload', { method: 'POST', body: {} });
            const status = await request('/status');
            const listed = await request('/tools', { timeoutMs: TOOLS_TIMEOUT_MS });
            const tools = Array.isArray(listed?.tools) ? listed.tools.filter(tool => tool && typeof tool.name === 'string' && typeof tool.server === 'string') : [];
            setExtraTools(buildMcpTools(tools, { call: callMcp }));
            snapshot = { state: 'ok', message: '', status, tools, errors: Array.isArray(listed?.errors) ? listed.errors : [], checkedAt: Date.now() };
        } catch (error) {
            setExtraTools([]);
            // 404 / network failure = the plugin is not there; anything else is a plugin problem.
            const absent = error?.status === 404 || error?.name === 'TypeError';
            snapshot = { ...emptySnapshot(absent ? 'absent' : 'error', String(error?.message ?? error)), checkedAt: Date.now() };
            if (!absent) warn('MCP bridge unavailable', error);
        } finally {
            refreshing = null;
            notify();
        }
        return snapshot;
    })();
    return refreshing;
}

/** One tool call through the plugin: { ok, content, isError } or { ok: false, error }. */
export async function callMcp(server, tool, args, signal = null) {
    const timeoutMs = Math.max(1000, (snapshot.status?.servers?.find(item => item.name === server)?.timeoutMs ?? 30000) + CALL_TIMEOUT_MARGIN_MS);
    try {
        const body = await request('/call', { method: 'POST', body: { server, tool, args }, signal, timeoutMs });
        return { ok: body?.ok === true, content: String(body?.content ?? ''), isError: body?.isError === true, error: body?.error };
    } catch (error) {
        if (signal?.aborted) throw error;
        return { ok: false, error: String(error?.message ?? error) };
    }
}

/** Startup: probe in the background only when the user switched MCP on. */
export function initMcp() {
    try {
        if (getSettings().mcpEnabled === true) void refreshMcp();
    } catch (error) {
        warn('MCP bridge init failed', error);
    }
}
