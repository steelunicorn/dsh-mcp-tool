// Minimal stdio MCP server used as a test fixture and as a stand-in for a real
// MCP server during manual acceptance. NDJSON over stdio, exactly the transport
// the shipped DSH MCP client expects.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { z } from 'zod'

const server = new McpServer(
	{ name: 'dsh-mcp-tool-fixture', version: '1.0.0' },
	{
		instructions:
			'Fixture MCP server for dsh-mcp-tool tests. Use `echo` to verify a call round-trip, `pid` to read the process id, `slow` to hold a call open.',
	},
)

server.registerTool(
	'echo',
	{
		title: 'Echo',
		description: 'Echoes the provided text back.',
		inputSchema: { text: z.string().describe('Text to echo') },
	},
	async ({ text }) => ({ content: [{ type: 'text', text: `echo:${text}` }] }),
)

server.registerTool(
	'pid',
	{
		title: 'Process id',
		description: 'Returns the pid of the fixture process.',
		inputSchema: {},
	},
	async () => ({ content: [{ type: 'text', text: String(process.pid) }] }),
)

server.registerTool(
	'slow',
	{
		title: 'Slow call',
		description: 'Holds the call open for the given number of milliseconds, then answers.',
		inputSchema: { ms: z.number().int().min(0).max(30000).default(1000) },
	},
	async ({ ms }) => {
		await new Promise((resolve) => setTimeout(resolve, ms))
		return { content: [{ type: 'text', text: `slept:${ms}` }] }
	},
)

server.registerTool(
	'fail',
	{
		title: 'Failing call',
		description: 'Always answers with an error result.',
		inputSchema: { message: z.string().default('fixture failure') },
	},
	async ({ message }) => ({ content: [{ type: 'text', text: message }], isError: true }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
