// Tiny stdio MCP server used by the bridge tests: an `echo` tool, a `fail` tool and a hidden `secret` tool.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const server = new McpServer({ name: 'echo-fixture', version: '1.0.0' });
server.tool('echo', 'Echo the text back', { text: z.string() }, async ({ text }) => ({ content: [{ type: 'text', text: `echo: ${text}` }] }));
server.tool('fail', 'Always reports a tool error', {}, async () => ({ isError: true, content: [{ type: 'text', text: 'boom' }] }));
server.tool('secret', 'Not on the allow list in tests', {}, async () => ({ content: [{ type: 'text', text: 'hidden' }] }));
server.tool('big', 'Returns a very long text', {}, async () => ({ content: [{ type: 'text', text: 'x'.repeat(20000) }, { type: 'image', data: 'AA==', mimeType: 'image/png' }] }));
await server.connect(new StdioServerTransport());
