// Pure helpers behind the bundled wiki MCP server (servers/wiki.js): URL building, markup
// stripping, section extraction and a tiny cached client with an injectable `fetch`, so
// every behaviour is unit-testable without network access.
//
// Works against any MediaWiki Action API: Wikipedia (TextExtracts available) and Fandom
// wikis (no TextExtracts; the page is read as wikitext and flattened to plain text).

export const USER_AGENT = 'SmartTavern-MCP/1.0 (read-only wiki lookup for roleplay canon facts)';
export const REQUEST_TIMEOUT_MS = 10000;
export const CACHE_TTL_MS = 15 * 60 * 1000;
export const CACHE_MAX_ENTRIES = 100;
export const SEARCH_LIMIT_MAX = 5;
export const PAGE_CHARS_DEFAULT = 3000;
export const PAGE_CHARS_MAX = 6000;

const LANG_RE = /^[a-z]{2,3}(?:-[a-z0-9]{2,8})?$/i;
const SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,60}[a-z0-9])?$/i;
// Hosts whose API serves TextExtracts (plain-text page extracts).
const EXTRACTS_HOST_RE = /\.(?:wikipedia|wikimedia|wiktionary|wikivoyage|wikibooks|wikiquote)\.org$/i;

const clampInt = (value, min, max, fallback) => {
    const number = Math.round(Number(value));
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
};

/** True for hosts a model must never be able to point the server at (SSRF guard). */
export function isForbiddenHost(hostname) {
    const host = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '');
    return !host || host === 'localhost' || /\.(?:local|localhost|internal|lan|home)$/.test(host)
        || /^[\d.]+$/.test(host) || host.includes(':'); // IPv4 / IPv6 literals
}

/**
 * Resolves the `wiki` argument to a MediaWiki api.php endpoint.
 *  - 'wikipedia' (default)     -> https://<lang>.wikipedia.org/w/api.php
 *  - a fandom subdomain        -> https://<sub>.fandom.com[/<lang>]/api.php
 *  - a full https …/api.php URL (public hosts only)
 * @returns {{ok: true, endpoint: string, extracts: boolean, label: string}|{ok: false, error: string}}
 */
export function resolveWiki(wiki, lang, defaults = {}) {
    const language = String(lang || defaults.lang || 'en').trim().toLowerCase();
    if (!LANG_RE.test(language)) return { ok: false, error: `invalid language code "${lang}"` };
    const target = String(wiki || defaults.wiki || 'wikipedia').trim();
    if (/^https?:\/\//i.test(target)) {
        let url;
        try { url = new URL(target); } catch { return { ok: false, error: `invalid wiki URL "${target}"` }; }
        if (url.protocol !== 'https:') return { ok: false, error: 'wiki URLs must use https' };
        if (isForbiddenHost(url.hostname)) return { ok: false, error: `host "${url.hostname}" is not allowed` };
        if (!/\/api\.php$/i.test(url.pathname)) return { ok: false, error: 'a full wiki URL must end in /api.php' };
        return { ok: true, endpoint: `${url.origin}${url.pathname}`, extracts: EXTRACTS_HOST_RE.test(url.hostname), label: url.hostname };
    }
    if (target.toLowerCase() === 'wikipedia') {
        return { ok: true, endpoint: `https://${language}.wikipedia.org/w/api.php`, extracts: true, label: `${language}.wikipedia.org` };
    }
    // `starwars` or `starwars.fandom.com`
    const sub = target.toLowerCase().replace(/\.fandom\.com$/, '');
    if (!SUBDOMAIN_RE.test(sub)) return { ok: false, error: `unknown wiki "${target}" (use 'wikipedia', a Fandom subdomain or a full api.php URL)` };
    const path = language === 'en' ? '' : `/${language}`;
    return { ok: true, endpoint: `https://${sub}.fandom.com${path}/api.php`, extracts: false, label: `${sub}.fandom.com` };
}

/** Builds the api.php URL for one request. Parameters are always URL-encoded. */
export function buildApiUrl(endpoint, params) {
    const url = new URL(endpoint);
    url.searchParams.set('format', 'json');
    url.searchParams.set('formatversion', '2');
    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null && value !== false) url.searchParams.set(key, value === true ? '1' : String(value));
    }
    return url.href;
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Strips HTML tags and decodes the common entities. */
export function stripHtml(html) {
    return String(html ?? '')
        .replace(/<(?:script|style)\b[\s\S]*?<\/(?:script|style)>/gi, ' ')
        .replace(/<br\s*\/?>|<\/(?:p|div|li|tr|h\d)>/gi, '\n')
        .replace(/<[^>]*>/g, '')
        .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, entity) => {
            if (entity[0] === '#') {
                const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
                return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
            }
            return ENTITIES[entity.toLowerCase()] ?? whole;
        })
        .replace(/[ \t]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

/** Removes `{{ … }}` templates (nested) and `{| … |}` tables from wikitext. */
function dropBlocks(text, open, close) {
    let depth = 0;
    let out = '';
    for (let i = 0; i < text.length;) {
        if (text.startsWith(open, i)) { depth++; i += open.length; continue; }
        if (depth > 0 && text.startsWith(close, i)) { depth--; i += close.length; continue; }
        if (depth === 0) out += text[i];
        i++;
    }
    return out;
}

/** Wikitext -> readable plain text (headings stay as `== Title ==` lines until the caller decides). */
export function wikitextToPlain(wikitext) {
    let text = String(wikitext ?? '');
    text = text.replace(/<!--[\s\S]*?-->/g, '').replace(/<ref\b[^>]*\/>/gi, '').replace(/<ref\b[\s\S]*?<\/ref>/gi, '');
    text = dropBlocks(dropBlocks(text, '{{', '}}'), '{|', '|}');
    text = text
        .replace(/\[\[(?:File|Image|Category|Datei|Fichier):[^\]]*(?:\[\[[^\]]*\]\][^\]]*)*\]\]/gi, '')
        .replace(/\[\[(?:[^\]|]*\|)?([^\]]*)\]\]/g, '$1')
        .replace(/\[https?:\/\/\S+\s+([^\]]+)\]/g, '$1').replace(/\[https?:\/\/\S+\]/g, '')
        .replace(/'{2,5}/g, '')
        .replace(/^[*#:;]+\s*/gm, '- ')
        .replace(/__[A-Z]+__/g, '');
    return stripHtml(text).replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Returns the body of the section whose heading matches `section` (case-insensitive;
 * includes its sub-sections), or null. Headings are `== Title ==` lines (any level).
 */
export function extractSection(text, section) {
    const wanted = String(section ?? '').trim().toLowerCase();
    if (!wanted) return null;
    const lines = String(text ?? '').split('\n');
    const heading = line => /^(={2,6})\s*(.*?)\s*\1\s*$/.exec(line.trim());
    let start = -1;
    let level = 0;
    for (let i = 0; i < lines.length; i++) {
        const match = heading(lines[i]);
        if (!match) continue;
        if (start < 0) {
            if (match[2].toLowerCase() === wanted) { start = i; level = match[1].length; }
        } else if (match[1].length <= level) {
            return lines.slice(start + 1, i).join('\n').trim();
        }
    }
    return start < 0 ? null : lines.slice(start + 1).join('\n').trim();
}

/** Turns `== Title ==` markers into plain `Title` lines. */
export const flattenHeadings = text => String(text ?? '').replace(/^(={2,6})\s*(.*?)\s*\1\s*$/gm, '$2');

function cap(text, chars) {
    return text.length > chars ? `${text.slice(0, chars).trimEnd()}\n…[truncated; ask for a section or raise maxChars]` : text;
}

/**
 * The wiki client. `fetchImpl(url, {headers, signal})` must return a fetch-like Response.
 * Results are cached in memory for 15 minutes per URL.
 */
export function createWikiClient({ fetchImpl = globalThis.fetch, env = {}, now = () => Date.now() } = {}) {
    const defaults = { wiki: env.WIKI_DEFAULT, lang: env.WIKI_LANG };
    const cache = new Map();

    async function getJson(url) {
        const hit = cache.get(url);
        if (hit && now() - hit.at < CACHE_TTL_MS) return hit.json;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
        try {
            const response = await fetchImpl(url, { headers: { 'User-Agent': USER_AGENT, 'Api-User-Agent': USER_AGENT, Accept: 'application/json' }, signal: controller.signal });
            if (!response.ok) throw new Error(`the wiki answered HTTP ${response.status}`);
            const json = await response.json();
            if (json?.error) throw new Error(`the wiki reported: ${json.error.info ?? json.error.code ?? 'an error'}`);
            if (cache.size >= CACHE_MAX_ENTRIES) cache.delete(cache.keys().next().value);
            cache.set(url, { at: now(), json });
            return json;
        } catch (error) {
            if (error?.name === 'AbortError') throw new Error(`the wiki did not answer within ${REQUEST_TIMEOUT_MS / 1000}s`);
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        async search({ query, wiki, lang, limit } = {}) {
            const text = String(query ?? '').trim();
            if (!text) throw new Error('"query" is required');
            const target = resolveWiki(wiki, lang, defaults);
            if (!target.ok) throw new Error(target.error);
            const json = await getJson(buildApiUrl(target.endpoint, {
                action: 'query', list: 'search', srsearch: text, srlimit: clampInt(limit, 1, SEARCH_LIMIT_MAX, SEARCH_LIMIT_MAX), srprop: 'snippet', srinfo: '',
            }));
            const hits = Array.isArray(json?.query?.search) ? json.query.search : [];
            if (!hits.length) return `No results for "${text}" on ${target.label}.`;
            return hits.map((hit, index) => `${index + 1}. ${hit.title} — ${stripHtml(hit.snippet).replace(/\s+/g, ' ')}`).join('\n');
        },

        async page({ title, wiki, lang, section, maxChars } = {}) {
            const name = String(title ?? '').trim();
            if (!name) throw new Error('"title" is required');
            const target = resolveWiki(wiki, lang, defaults);
            if (!target.ok) throw new Error(target.error);
            const limit = clampInt(maxChars, 200, PAGE_CHARS_MAX, PAGE_CHARS_DEFAULT);
            const wanted = String(section ?? '').trim();
            let resolvedTitle = name;
            let text;
            if (target.extracts) {
                // `wiki` section format keeps `== Heading ==` markers so a section can be cut out.
                const json = await getJson(buildApiUrl(target.endpoint, {
                    action: 'query', prop: 'extracts', explaintext: true, exsectionformat: wanted ? 'wiki' : 'plain', redirects: true, titles: name,
                }));
                const page = json?.query?.pages?.[0];
                if (!page || page.missing || typeof page.extract !== 'string') throw new Error(`no page "${name}" on ${target.label}`);
                resolvedTitle = page.title ?? name;
                text = page.extract;
            } else {
                const json = await getJson(buildApiUrl(target.endpoint, { action: 'parse', page: name, prop: 'wikitext', redirects: true }));
                if (typeof json?.parse?.wikitext !== 'string') throw new Error(`no page "${name}" on ${target.label}`);
                resolvedTitle = json.parse.title ?? name;
                text = wikitextToPlain(json.parse.wikitext);
            }
            if (wanted) {
                const body = extractSection(text, wanted);
                if (body === null) {
                    const headings = [...text.matchAll(/^={2,6}\s*(.*?)\s*={2,6}\s*$/gm)].map(match => match[1]).slice(0, 25);
                    throw new Error(`no section "${wanted}" in "${resolvedTitle}"${headings.length ? `; sections: ${headings.join(', ')}` : ''}`);
                }
                text = body;
            }
            return `${resolvedTitle}${wanted ? ` — ${wanted}` : ''} (${target.label})\n${cap(flattenHeadings(text).trim(), limit)}`;
        },
    };
}
