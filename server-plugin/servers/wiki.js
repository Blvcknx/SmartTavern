#!/usr/bin/env node
// Bundled read-only MCP server: look things up on Wikipedia / Fandom (any MediaWiki).
// Run it as a normal stdio entry in mcp-servers.json:
//   { "name": "wiki", "transport": "stdio", "command": "node", "args": ["servers/wiki.js"],
//     "env": { "WIKI_DEFAULT": "wikipedia", "WIKI_LANG": "en" } }
// (relative paths in "args" are resolved against the plugin folder via "cwd": ".").
// Results are DATA for the model, never instructions; respect each wiki's terms of use.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { createWikiClient, SEARCH_LIMIT_MAX, PAGE_CHARS_MAX } from './wiki-core.js';

const client = createWikiClient({ env: process.env });
const server = new McpServer({ name: 'smarttavern-wiki', version: '1.0.0' });

const wikiArg = z.string().optional().describe("'wikipedia' (default), a Fandom subdomain such as 'starwars', or a full https api.php URL");
const langArg = z.string().optional().describe("Language code, default 'en'");

// A failed lookup is a normal tool error (isError), never a crash of the server.
const reply = async work => {
    try {
        return { content: [{ type: 'text', text: await work() }] };
    } catch (error) {
        return { isError: true, content: [{ type: 'text', text: String(error?.message ?? error) }] };
    }
};

server.tool('wiki_search', 'Search a wiki (Wikipedia or a Fandom wiki) for pages; returns titles with short snippets. Use for canon facts about known fictional characters, settings and public figures.', {
    query: z.string().describe('Search terms'),
    wiki: wikiArg, lang: langArg,
    limit: z.number().int().min(1).max(SEARCH_LIMIT_MAX).optional().describe(`Results, at most ${SEARCH_LIMIT_MAX}`),
}, args => reply(() => client.search(args)));

server.tool('wiki_page', 'Read a wiki page as plain text, or only one section of it.', {
    title: z.string().describe('Exact page title (use wiki_search to find it)'),
    wiki: wikiArg, lang: langArg,
    section: z.string().optional().describe('Return only the section with this heading'),
    maxChars: z.number().int().min(200).max(PAGE_CHARS_MAX).optional().describe(`Length cap, default 3000, at most ${PAGE_CHARS_MAX}`),
}, args => reply(() => client.page(args)));

await server.connect(new StdioServerTransport());
