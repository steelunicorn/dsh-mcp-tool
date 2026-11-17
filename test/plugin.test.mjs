/**
 * Plugin wiring test: builds the real `apply()` against a fake host context.
 *
 * This is the seam the unit tests cannot reach — tool registration with `when`,
 * the prompt section, eager activation, the GUI routes and the unload path all
 * run through the actual host service shapes.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply, inject, name } from '../lib/index.js'
import { ROUTE_PREFIX } from '../lib/http.js'

function fakeHost(options = {}) {
	const cwd = options.cwd ?? 'D:/work'
	const agents = options.agents ?? [{ id: 'a1', ctx: {}, session: { header: { cwd } } }]
	const servers = new Map()
	const defs = new Map()
	const tools = new Map()
	const sections = []
	const routes = []
	const disposers = []
	const listeners = new Map()
	const store = { value: { showChip: true } }
	const tables = new Map([['servers', new Map()], ['presets', new Map()], ['workspaces', new Map()]])

	const ctx = {
		mcpManager: {
			list: () => [...servers].map(([serverName, entry]) => ({ name: serverName, configured: false, status: entry.status })),
			register(serverName) {
				servers.set(serverName, { status: { state: 'connected', toolCount: 1 } })
				defs.set(`mcp__${serverName}__echo`, { name: `mcp__${serverName}__echo`, description: 'echo', parameters: {} })
				return () => {
					servers.delete(serverName)
					for (const key of [...defs.keys()]) if (key.startsWith(`mcp__${serverName}__`)) defs.delete(key)
				}
			},
		},
		tools: {
			definitions: () => [...defs.values()],
			register(definition, registerOptions) {
				tools.set(definition.name, { definition, when: registerOptions?.when })
				return () => tools.delete(definition.name)
			},
			restrict: () => () => {},
		},
		agents: { list: () => agents, get: id => agents.find(agent => agent.id === id) },
		workingDirectory: { get: session => session.header.cwd },
		workspaceRegistry: options.workspaceRegistry,
		storageDomain: {
			open: async () => ({
				global: { get: () => store.value, set: async value => { store.value = value } },
				table: table => ({
					get: key => tables.get(table).get(key),
					entries: () => tables.get(table).entries(),
					keys: () => tables.get(table).keys(),
					get size() { return tables.get(table).size },
					put: async (key, value) => { tables.get(table).set(key, value) },
					delete: async key => tables.get(table).delete(key),
				}),
				close: async () => {},
			}),
		},
		systemPrompt: { section: section => { sections.push(section); return () => {} } },
		webServer: { register: route => { routes.push(route); return () => {} } },
		effect(callback) {
			const dispose = callback()
			const off = () => dispose?.()
			disposers.push(off)
			return off
		},
		on(event, listener) {
			const list = listeners.get(event) ?? []
			list.push(listener)
			listeners.set(event, list)
			return () => {}
		},
	}
	// The pool installs a per-agent deny list through the scoped tools service.
	for (const agent of agents) agent.ctx.tools = ctx.tools
	return { ctx, agents, servers, defs, tools, sections, routes, disposers, cwd, tables }
}

async function call(route, method, path, body) {
	const req = {
		method,
		url: path,
		headers: { 'content-type': 'application/json', 'x-dsh-mcp-tool': '1' },
		async *[Symbol.asyncIterator]() {
			if (body !== undefined) yield Buffer.from(JSON.stringify(body))
		},
	}
	const res = {
		status: 0,
		body: '',
		writeHead(status) { this.status = status },
		end(payload) { this.body = payload ?? '' },
	}
	await route.handler(req, res)
	return { status: res.status, json: res.body === '' ? undefined : JSON.parse(res.body) }
}

const tick = () => new Promise(resolve => setTimeout(resolve, 50))

async function waitUntil(check, timeoutMs = 2000) {
	const started = Date.now()
	for (;;) {
		if (check()) return
		if (Date.now() - started > timeoutMs) throw new Error('condition was not met in time')
		await tick()
	}
}

const when = (host, tool, agent) => host.tools.get(tool).when({ agent, signal: undefined, modelSelection: undefined })

test('apply registers the three tools, the prompt section and the routes', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	assert.deepEqual([...host.tools.keys()].sort(), ['mcp_load', 'mcp_release', 'mcp_servers'])
	assert.equal(host.sections.length, 1)
	assert.equal(host.sections[0].name, 'mcp-tool:folder-servers')
	assert.equal(host.sections[0].order, 3110)
	assert.equal(host.routes.length, 1)
	assert.equal(host.routes[0].path, ROUTE_PREFIX)
	assert.deepEqual(inject, ['mcpManager', 'tools', 'agents', 'workingDirectory', 'storageDomain', 'webServer', 'systemPrompt'])
	assert.equal(name, 'dsh-mcp-tool')
})

test('without any server the tools stay hidden and the prompt stays empty', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	const agent = host.agents[0]
	for (const tool of ['mcp_servers', 'mcp_load', 'mcp_release']) assert.equal(await when(host, tool, agent), false)
	assert.equal(host.sections[0].text({ agent }), '')
})

test('an added server is switched on by the default preset everywhere', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	await call(host.routes[0], 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', transport: 'stdio', command: 'node', args: ['a.mjs'] })
	const agent = host.agents[0]
	assert.equal(await when(host, 'mcp_servers', agent), true)
	assert.match(host.sections[0].text({ agent }), /alpha \(stdio\)/)
	assert.match(host.sections[0].text({ agent }), /mcp_load/)
})

test('a named preset switches a server off for the folders assigned to it only', async () => {
	const host = fakeHost({ agents: [
		{ id: 'a1', ctx: {}, session: { header: { cwd: 'D:/work' } } },
		{ id: 'a2', ctx: {}, session: { header: { cwd: 'D:/other' } } },
	] })
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', transport: 'stdio', command: 'node' })
	await call(route, 'POST', `${ROUTE_PREFIX}/preset`, { name: 'quiet', rows: { alpha: 'off' } })
	await call(route, 'POST', `${ROUTE_PREFIX}/folder`, { path: 'D:/work', preset: 'quiet' })

	assert.equal(await when(host, 'mcp_servers', host.agents[0]), false)
	assert.equal(host.sections[0].text({ agent: host.agents[0] }), '')
	assert.equal(await when(host, 'mcp_servers', host.agents[1]), true)
	assert.match(host.sections[0].text({ agent: host.agents[1] }), /alpha/)
})

test('a named preset inherits the switches of the default preset', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', transport: 'stdio', command: 'node' })
	await call(route, 'POST', `${ROUTE_PREFIX}/preset`, { name: 'default', rows: { alpha: 'off' } })
	await call(route, 'POST', `${ROUTE_PREFIX}/preset`, { name: 'loud', rows: { alpha: 'on' } })
	await call(route, 'POST', `${ROUTE_PREFIX}/preset`, { name: 'quiet', rows: {} })

	assert.equal(await when(host, 'mcp_servers', host.agents[0]), false)

	await call(route, 'POST', `${ROUTE_PREFIX}/folder`, { path: 'D:/work', preset: 'loud' })
	assert.equal(await when(host, 'mcp_servers', host.agents[0]), true)

	await call(route, 'POST', `${ROUTE_PREFIX}/folder`, { path: 'D:/work', preset: 'quiet' })
	assert.equal(await when(host, 'mcp_servers', host.agents[0]), false)
})

test('mcp_load starts the server through the manager, mcp_release stops it', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', transport: 'stdio', command: 'node' })

	const agent = host.agents[0]
	const loaded = await host.tools.get('mcp_load').definition.execute({ server: 'alpha' }, { agent })
	assert.equal(loaded.server, 'alpha')
	assert.deepEqual(loaded.tools.map(tool => tool.name), ['mcp__alpha__echo'])
	assert.ok(host.servers.has('alpha'))

	const state = await call(route, 'GET', `${ROUTE_PREFIX}/state?sessionId=a1`)
	assert.equal(state.json.servers[0].status, 'ready')
	assert.equal(state.json.servers[0].live, true)

	const released = await host.tools.get('mcp_release').definition.execute({ server: 'alpha' }, { agent })
	assert.deepEqual(released, { server: 'alpha', released: true, stopped: true })
	assert.equal(host.servers.has('alpha'), false)
})

test('mcp_load refuses a server the folder preset keeps off', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', transport: 'stdio', command: 'node' })
	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'beta', transport: 'stdio', command: 'node' })
	await call(route, 'POST', `${ROUTE_PREFIX}/preset`, { name: 'work', rows: { beta: 'off' } })
	await call(route, 'POST', `${ROUTE_PREFIX}/folder`, { path: 'D:/work', preset: 'work' })
	await assert.rejects(host.tools.get('mcp_load').definition.execute({ server: 'beta' }, { agent: host.agents[0] }), /not allowed/)
})

test('a server set to eager load starts with the plugin and survives mcp_release', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	await call(host.routes[0], 'POST', `${ROUTE_PREFIX}/server`, {
		name: 'always', transport: 'stdio', loadMode: 'eager', command: 'node',
	})
	await waitUntil(() => host.servers.has('always'))

	const released = await host.tools.get('mcp_release').definition.execute({ server: 'always' }, { agent: host.agents[0] })
	assert.equal(released.released, false)
	assert.equal(host.servers.has('always'), true)

	const loaded = await host.tools.get('mcp_load').definition.execute({ server: 'always' }, { agent: host.agents[0] })
	assert.deepEqual(loaded.tools.map(tool => tool.name), ['mcp__always__echo'])
})

test('switching the load mode back to lazy unpins the eager server', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'always', transport: 'stdio', loadMode: 'eager', command: 'node' })
	await waitUntil(() => host.servers.has('always'))

	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'always', transport: 'stdio', loadMode: 'lazy', command: 'node' })
	await waitUntil(() => !host.servers.has('always'))
})

test('unloading the plugin stops live servers and unregisters everything', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', transport: 'stdio', command: 'node' })
	await host.tools.get('mcp_load').definition.execute({ server: 'alpha' }, { agent: host.agents[0] })
	assert.ok(host.servers.has('alpha'))

	for (const dispose of [...host.disposers].reverse()) dispose()
	await tick()
	assert.equal(host.servers.has('alpha'), false)
	assert.equal(host.tools.size, 0)
})

test('the GUI loads a server for the session that asked', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', transport: 'stdio', command: 'node' })
	const loaded = await call(route, 'POST', `${ROUTE_PREFIX}/activate`, { sessionId: 'a1', server: 'alpha', action: 'load' })
	assert.deepEqual(loaded.json.tools, ['mcp__alpha__echo'])
	const released = await call(route, 'POST', `${ROUTE_PREFIX}/activate`, { sessionId: 'a1', server: 'alpha', action: 'release' })
	assert.equal(released.json.stopped, true)
	assert.equal(host.servers.has('alpha'), false)
})

test('a session without a live agent resolves its folder preset through the cwd hint', async () => {
	const host = fakeHost({ agents: [] })
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', transport: 'stdio', command: 'node' })
	await call(route, 'POST', `${ROUTE_PREFIX}/preset`, { name: 'quiet', rows: { alpha: 'off' } })
	await call(route, 'POST', `${ROUTE_PREFIX}/folder`, { path: 'D:/work', preset: 'quiet' })

	const state = await call(route, 'GET', `${ROUTE_PREFIX}/state?sessionId=ghost&cwd=${encodeURIComponent('D:/work')}`)
	assert.equal(state.json.source, 'folder')
	assert.equal(state.json.preset, 'quiet')
	assert.equal(state.json.cwd, 'D:/work')
	assert.equal(state.json.servers[0].allowed, false)

	const loaded = await call(route, 'POST', `${ROUTE_PREFIX}/activate`, {
		sessionId: 'ghost', cwd: 'D:/work', server: 'alpha', action: 'load',
	})
	assert.equal(loaded.status, 400)
	assert.match(loaded.json.error, /not allowed/)
})

test('the settings page without a session id falls back to the live session folder', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', transport: 'stdio', command: 'node' })
	await call(route, 'POST', `${ROUTE_PREFIX}/preset`, { name: 'quiet', rows: { alpha: 'off' } })
	await call(route, 'POST', `${ROUTE_PREFIX}/folder`, { path: 'D:/work', preset: 'quiet' })

	const state = await call(route, 'GET', `${ROUTE_PREFIX}/state`)
	assert.equal(state.json.sessionId, 'a1')
	assert.equal(state.json.cwd, 'D:/work')
	assert.equal(state.json.source, 'folder')
	assert.equal(state.json.preset, 'quiet')
	assert.equal(state.json.servers[0].allowed, false)
})

test('the GUI lists the DSH workspaces next to the assignments', async () => {
	const host = fakeHost({
		workspaceRegistry: { list: () => [{ path: 'D:/work', title: 'Work' }, { path: 'D:/else' }] },
	})
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/preset`, { name: 'quiet', rows: {} })
	await call(route, 'POST', `${ROUTE_PREFIX}/folder`, { path: 'D:/work', preset: 'quiet' })

	const { json } = await call(route, 'GET', `${ROUTE_PREFIX}/workspaces`)
	assert.deepEqual(json.workspaces, [{ path: 'D:/work', title: 'Work' }, { path: 'D:/else' }])
	assert.deepEqual(json.folders, [{ path: 'd:/work', preset: 'quiet' }])
})

test('the chip switch is stored and reported back', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	const off = await call(route, 'POST', `${ROUTE_PREFIX}/settings`, { showChip: false })
	assert.equal(off.status, 200)
	const state = await call(route, 'GET', `${ROUTE_PREFIX}/state?sessionId=a1`)
	assert.deepEqual(state.json.settings, { showChip: false })
})
