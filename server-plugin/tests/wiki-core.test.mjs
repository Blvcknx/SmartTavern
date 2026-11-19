// Run: node --test server-plugin/tests
// Pure tests for the bundled wiki server: URL building, markup stripping, sections and the
// cached client with a mocked fetch. The spawn test needs the SDK and skips without it.
import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
    resolveWiki, buildApiUrl, stripHtml, wikitextToPlain, extractSection, createWikiClient, isForbiddenHost, USER_AGENT, CACHE_TTL_MS,
} from '../servers/wiki-core.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const sdkInstalled = await import('@modelcontextprotocol/sdk/client/index.js').then(() => true, () => false);

test('resolveWiki maps wikipedia, fandom subdomains and full URLs; rejects unsafe targets', () => {
    assert.equal(resolveWiki().endpoint, 'https://en.wikipedia.org/w/api.php');
    assert.equal(resolveWiki('wikipedia', 'de').endpoint, 'https://de.wikipedia.org/w/api.php');
    assert.equal(resolveWiki('starwars').endpoint, 'https://starwars.fandom.com/api.php');
    assert.equal(resolveWiki('StarWars.fandom.com', 'fr').endpoint, 'https://starwars.fandom.com/fr/api.php');
    assert.equal(resolveWiki('starwars').extracts, false);
    assert.equal(resolveWiki('wikipedia').extracts, true);
    assert.equal(resolveWiki('https://en.wikipedia.org/w/api.php').extracts, true);
    assert.equal(resolveWiki('https://wiki.example.org/api.php?x=1').endpoint, 'https://wiki.example.org/api.php');
    assert.equal(resolveWiki(undefined, undefined, { wiki: 'witcher', lang: 'pl' }).endpoint, 'https://witcher.fandom.com/pl/api.php');
    for (const bad of ['http://wiki.example.org/api.php', 'https://localhost/api.php', 'https://127.0.0.1/api.php', 'https://[::1]/api.php',
        'https://wiki.example.org/index.php', 'bad name!', 'a/b']) assert.equal(resolveWiki(bad).ok, false, bad);
    assert.equal(resolveWiki('wikipedia', 'xx yy').ok, false);
    assert.ok(isForbiddenHost('intranet.internal'));
    assert.ok(!isForbiddenHost('en.wikipedia.org'));
});

test('buildApiUrl encodes parameters and skips empty ones', () => {
    const url = new URL(buildApiUrl('https://en.wikipedia.org/w/api.php', { action: 'query', srsearch: 'a&b=c d', skip: undefined, flag: true, off: false }));
    assert.equal(url.searchParams.get('srsearch'), 'a&b=c d');
    assert.equal(url.searchParams.get('format'), 'json');
    assert.equal(url.searchParams.get('flag'), '1');
    assert.equal(url.searchParams.has('skip'), false);
    assert.equal(url.searchParams.has('off'), false);
});

test('stripHtml and wikitextToPlain produce readable text', () => {
    assert.equal(stripHtml('a <span class="searchmatch">hit</span> &amp; &quot;more&quot; &#39;x&#x27;'), 'a hit & "more" \'x\'');
    const plain = wikitextToPlain("{{Infobox|a={{nested}}}}\n'''Luke''' is a [[Jedi|Jedi Knight]].<ref>cite</ref> [[File:x.png|thumb|cap]]\n== Early life ==\n* One [https://x.org site]\n{| class=t\n|a\n|}\nDone.");
    assert.ok(!/[{}\[\]|']/.test(plain.replace(/==/g, '')), plain);
    assert.match(plain, /Luke is a Jedi Knight\./);
    assert.match(plain, /- One site/);
    assert.match(plain, /Done\./);
    assert.ok(!plain.includes('cite'));
});

test('extractSection returns a section with its sub-sections only', () => {
    const text = 'Intro\n== Early life ==\nborn\n=== Youth ===\nplayed\n== Career ==\nworked';
    assert.equal(extractSection(text, 'early life'), 'born\n=== Youth ===\nplayed');
    assert.equal(extractSection(text, 'Career'), 'worked');
    assert.equal(extractSection(text, 'Nope'), null);
});

function mockFetch(handler) {
    const calls = [];
    const fetchImpl = async (url, init) => {
        calls.push({ url, init });
        const body = handler(new URL(url));
        return { ok: body !== null, status: body === null ? 503 : 200, json: async () => body };
    };
    fetchImpl.calls = calls;
    return fetchImpl;
}

test('search: Wikipedia request shape, snippet stripping, user agent, limit cap, no results', async () => {
    const fetchImpl = mockFetch(url => url.searchParams.get('srsearch') === 'zzz'
        ? { query: { search: [] } }
        : { query: { search: [{ title: 'Luke Skywalker', snippet: 'a <span class="searchmatch">Jedi</span> &amp; farmboy' }, { title: 'Leia', snippet: 'princess' }] } });
    const client = createWikiClient({ fetchImpl });
    const text = await client.search({ query: 'luke', limit: 99 });
    assert.equal(text, '1. Luke Skywalker — a Jedi & farmboy\n2. Leia — princess');
    const url = new URL(fetchImpl.calls[0].url);
    assert.equal(url.host, 'en.wikipedia.org');
    assert.equal(url.searchParams.get('list'), 'search');
    assert.equal(url.searchParams.get('srlimit'), '5');
    assert.equal(fetchImpl.calls[0].init.headers['User-Agent'], USER_AGENT);
    assert.match(await client.search({ query: 'zzz' }), /No results/);
    await assert.rejects(client.search({ query: '  ' }), /required/);
    await assert.rejects(client.search({ query: 'x', wiki: 'https://localhost/api.php' }), /not allowed/);
});

test('page: Wikipedia extracts, redirect title, section, truncation and missing pages', async () => {
    const extract = 'Intro text.\n== Early life ==\nBorn on Tatooine.\n== Career ==\n' + 'x'.repeat(5000);
    const fetchImpl = mockFetch(url => url.searchParams.get('titles') === 'Missing'
        ? { query: { pages: [{ title: 'Missing', missing: true }] } }
        : { query: { pages: [{ title: 'Luke Skywalker', extract }] } });
    const client = createWikiClient({ fetchImpl });
    const full = await client.page({ title: 'Luke', maxChars: 300 });
    assert.match(full, /^Luke Skywalker \(en\.wikipedia\.org\)\nIntro text\./);
    assert.match(full, /truncated/);
    assert.ok(full.length < 450);
    assert.equal(new URL(fetchImpl.calls[0].url).searchParams.get('explaintext'), '1');
    const section = await client.page({ title: 'Luke', section: 'early life' });
    assert.match(section, /Luke Skywalker — early life[^\n]*\nBorn on Tatooine\.$/);
    await assert.rejects(client.page({ title: 'Luke', section: 'Nope' }), /no section "Nope".*sections: Early life, Career/);
    await assert.rejects(client.page({ title: 'Missing' }), /no page "Missing"/);
});

test('page: Fandom has no TextExtracts, so wikitext is parsed and sectioned', async () => {
    const fetchImpl = mockFetch(() => ({ parse: { title: 'Din Djarin', wikitext: "{{Infobox}}\n'''Din Djarin''' is a [[Mandalorian]].\n== Biography ==\nRaised by the Tribe." } }));
    const client = createWikiClient({ fetchImpl, env: { WIKI_DEFAULT: 'starwars' } });
    const url = () => new URL(fetchImpl.calls.at(-1).url);
    assert.equal(await client.page({ title: 'Din' }), 'Din Djarin (starwars.fandom.com)\nDin Djarin is a Mandalorian.\nBiography\nRaised by the Tribe.');
    assert.equal(url().host, 'starwars.fandom.com');
    assert.equal(url().searchParams.get('action'), 'parse');
    assert.equal(url().searchParams.get('prop'), 'wikitext');
    assert.match(await client.page({ title: 'Din', section: 'Biography' }), /\nRaised by the Tribe\.$/);
});

test('cache: identical requests are served for 15 minutes; HTTP errors and API errors surface', async () => {
    let clock = 1000;
    const fetchImpl = mockFetch(() => ({ query: { search: [{ title: 'A', snippet: 's' }] } }));
    const client = createWikiClient({ fetchImpl, now: () => clock });
    await client.search({ query: 'q' });
    await client.search({ query: 'q' });
    assert.equal(fetchImpl.calls.length, 1);
    clock += CACHE_TTL_MS + 1;
    await client.search({ query: 'q' });
    assert.equal(fetchImpl.calls.length, 2);
    await assert.rejects(createWikiClient({ fetchImpl: mockFetch(() => null) }).search({ query: 'x' }), /HTTP 503/);
    await assert.rejects(createWikiClient({ fetchImpl: mockFetch(() => ({ error: { info: 'bad' } })) }).search({ query: 'x' }), /bad/);
});

test('the wiki server starts over stdio and lists its two read-only tools', { skip: !sdkInstalled && 'MCP SDK not installed' }, async () => {
    const { createBridge } = await import('../index.js');
    const fs = await import('node:fs'); const os = await import('node:os');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'st-wiki-')), 'mcp-servers.json');
    fs.writeFileSync(file, JSON.stringify({ servers: [{ name: 'wiki', transport: 'stdio', command: process.execPath, args: [path.join(here, '..', 'servers', 'wiki.js')], timeoutMs: 15000 }] }));
    const bridge = createBridge({ configPath: file });
    try {
        const listed = await bridge.tools();
        assert.deepEqual(listed.tools.map(tool => tool.name).sort(), ['wiki_page', 'wiki_search']);
        assert.deepEqual(listed.tools.find(tool => tool.name === 'wiki_search').inputSchema.required, ['query']);
        // A bad argument is a tool error, not a crash, and never touches the network.
        const bad = await bridge.call({ server: 'wiki', tool: 'wiki_search', args: { query: 'x', wiki: 'https://localhost/api.php' } });
        assert.equal(bad.body.isError, true);
        assert.match(bad.body.content, /not allowed/);
    } finally {
        await bridge.close();
    }
});
