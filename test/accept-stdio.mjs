/**
 * Manual acceptance against a real stdio MCP server.
 *
 * Not part of `npm test`: it spawns an actual server from this machine. It plays
 * the role of the mcp-manager transport (stdio) and checks the pieces the
 * plugin depends on:
 *
 *   1. the command/args shape stored in the registry starts a working server;
 *   2. `initialize` / `tools/list` work;
 *   3. optionally, one real tool call succeeds;
 *   4. closing the client ends the process — the pool relies on that.
 *
 * The server is copied into a throwaway directory first, so a server that drops
 * state files next to its own executable does not litter the checkout.
 *
 * Environment:
 *   MCPTOOL_ACCEPT_COMMAND     executable to launch (required)
 *   MCPTOOL_ACCEPT_ARGS        space separated arguments (default: --mcp)
 *   MCPTOOL_ACCEPT_COPY        extra files to copy next to it, separated by ";"
 *   MCPTOOL_ACCEPT_EXPECT_TOOLS  expected number of tools (optional)
 *   MCPTOOL_ACCEPT_TOOL        tool to call (optional)
 *   MCPTOOL_ACCEPT_TOOL_ARGS   JSON object with that tool's arguments (optional)
 *
 * Example:
 *   MCPTOOL_ACCEPT_COMMAND=C:\tools\server.exe MCPTOOL_ACCEPT_ARGS="--mcp" \
 *     node test/accept-stdio.mjs
 */

import { copyFileSync, existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join } from 'node:path'

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const command = process.env.MCPTOOL_ACCEPT_COMMAND
if (command === undefined || command === '') {
	console.error('MCPTOOL_ACCEPT_COMMAND is not set')
	process.exit(2)
}
if (! existsSync(command)) {
	console.error(`server not found: ${command}`)
	process.exit(2)
}

const args = (process.env.MCPTOOL_ACCEPT_ARGS ?? '--mcp').split(' ').filter(part => part !== '')
const extra = (process.env.MCPTOOL_ACCEPT_COPY ?? '').split(';').filter(part => part !== '')
const expected = process.env.MCPTOOL_ACCEPT_EXPECT_TOOLS === undefined
	? undefined
	: Number(process.env.MCPTOOL_ACCEPT_EXPECT_TOOLS)
const toolName = process.env.MCPTOOL_ACCEPT_TOOL
const toolArgs = process.env.MCPTOOL_ACCEPT_TOOL_ARGS === undefined
	? {}
	: JSON.parse(process.env.MCPTOOL_ACCEPT_TOOL_ARGS)

// Keep the machine's checkout clean: the server runs from a copy.
const sandbox = mkdtempSync(join(tmpdir(), 'mcp-tool-accept-'))
const copy = join(sandbox, basename(command))
copyFileSync(command, copy)
for (const file of extra) {
	const source = isAbsolute(file) ? file : join(dirname(command), file)
	if (existsSync(source)) copyFileSync(source, join(sandbox, basename(source)))
}

const report = { command, sandbox, steps: [] }
const step = (name, value) => {
	report.steps.push({ name, ...value })
	console.log(`${name}: ${JSON.stringify(value)}`)
}

const client = new Client({ name: 'dsh-mcp-tool-acceptance', version: '0.0.0' })
const transport = new StdioClientTransport({
	command: copy,
	args,
	cwd: sandbox,
	stderr: 'pipe',
})

let failure = 0
let pid = null
try {
	await client.connect(transport)
	// The transport drops its child reference on close, so remember the pid now.
	// It is a private field of the SDK transport; this is a diagnostic script, and
	// the only public evidence that the process is gone is the pid itself.
	pid = transport._process?.pid ?? null
	step('connected', { server: client.getServerVersion?.() ?? null, pid })

	const listed = await client.listTools()
	step('tools/list', { count: listed.tools.length, names: listed.tools.map(tool => tool.name) })
	if (expected !== undefined && listed.tools.length !== expected) {
		failure = 1
		console.error(`expected ${expected} tools, got ${listed.tools.length}`)
	}

	if (toolName !== undefined && toolName !== '') {
		const called = await client.callTool({ name: toolName, arguments: toolArgs })
		step(`call ${toolName}`, {
			isError: called.isError === true,
			blocks: called.content?.length ?? 0,
		})
		if (called.isError === true) failure = 1
	}

	step('sandbox artifacts', { files: readdirSync(sandbox) })
} catch (error) {
	failure = 1
	console.error(`acceptance failed: ${String(error?.message ?? error)}`)
} finally {
	await client.close().catch(() => {})
}

// Closing the client must end the child process: the pool relies on the
// manager's disposer doing the same thing.
const alive = pid === null
	? false
	: (() => {
		try {
			process.kill(pid, 0)
			return true
		} catch {
			return false
		}
	})()
const deadline = Date.now() + 5000
let running = alive
while (running && Date.now() < deadline) {
	await new Promise(resolve => setTimeout(resolve, 100))
	try {
		process.kill(pid, 0)
	} catch {
		running = false
	}
}
step('process stopped after close', { pid, stopped: ! running })
if (running) failure = 1

rmSync(sandbox, { recursive: true, force: true })
process.exit(failure)
