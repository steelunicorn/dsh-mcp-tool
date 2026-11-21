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
	const configured = options.configured ?? {}
	const registered = []
	const activeRestrictions = []
	const guards = []

	const ctx = {
		mcpManager: {
			config: { servers: { get: () => configured } },
			list: () => [
				...[...servers].map(([serverName, entry]) => ({ name: serverName, configured: true, status: entry.status })),
				...Object.keys(configured)
					.filter(serverName => !servers.has(serverName))
					.map(serverName => ({ name: serverName, configured: true, status: { state: 'disabled' } })),
			],
			register(serverName) {
				registered.push(serverName)
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
			restrict(filter) {
				activeRestrictions.push(filter)
				return () => {
					const index = activeRestrictions.indexOf(filter)
					if (index >= 0) activeRestrictions.splice(index, 1)
				}
			},
			guard(fn) {
				guards.push(fn)
				return () => {
					const index = guards.indexOf(fn)
					if (index >= 0) guards.splice(index, 1)
				}
			},
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
	// Servers configured in the DSH MCP settings are already mounted and their
	// tools are already in the catalog; the plugin only mirrors the record.
	// A server the settings keep switched off has no process and no tools.
	const mount = serverName => {
		servers.set(serverName, { status: { state: 'connected', toolCount: 1 } })
		defs.set(`mcp__${serverName}__echo`, { name: `mcp__${serverName}__echo`, description: 'echo', parameters: {} })
	}
	const unmount = serverName => {
		servers.delete(serverName)
		for (const key of [...defs.keys()]) if (key.startsWith(`mcp__${serverName}__`)) defs.delete(key)
	}
	for (const [serverName, entry] of Object.entries(configured)) {
		if (entry.enabled !== false) mount(serverName)
	}
	// The manager entry the plugin flips through the config editor. Enabling a
	// server mounts it, exactly as the real manager's reconcile does.
	ctx.configEditor = {
		entries: () => [{ options: { id: 'mcp-manager', name: '@deepseek-ai/dsh-mcp-manager' } }],
		edit: async (_entry, change) => {
			const patch = change({ servers: configured })
			for (const [serverName, entry] of Object.entries(patch.servers)) {
				configured[serverName] = entry
				if (entry.enabled === false) unmount(serverName)
				else mount(serverName)
			}
		},
	}
	ctx.get = name => (name === 'configEditor'
		? ctx.configEditor
		: name === 'connection' ? options.connection : ctx.workspaceRegistry)
	return { ctx, agents, servers, defs, tools, sections, routes, disposers, cwd, tables, registered, activeRestrictions, guards, configured }
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
	assert.deepEqual(state.json.settings, { showChip: false, profileLifecycle: 'auto' })
})

test('servers configured in the DSH MCP settings are mirrored and switched off', async () => {
	const host = fakeHost({ configured: { p1: { transport: 'stdio', command: 'C:/tools/p1.exe', args: ['--mcp'] } } })
	apply(host.ctx)
	await tick()

	const route = host.routes[0]
	const state = await call(route, 'GET', `${ROUTE_PREFIX}/state?sessionId=a1`)
	const record = state.json.servers.find(server => server.name === 'p1')
	assert.equal(record.origin, 'profile')
	// The host reports the live state of the process it started.
	assert.equal(record.status, 'ready')
	assert.equal(record.loadMode, 'lazy')
	assert.equal(record.command, 'C:/tools/p1.exe')
	// The plugin mirrored the record; it did not start a second process.
	assert.deepEqual(host.registered, [])
	// A new import is switched off in the default preset.
	assert.equal(state.json.presets[0].name, 'default')
	assert.equal(state.json.presets[0].rows.p1, 'off')
	// ... and its tools are withheld from the agent until a preset allows it.
	assert.equal(state.json.servers.find(server => server.name === 'p1').allowed, false)
	assert.ok(host.activeRestrictions.some(filter => filter.deny.includes('mcp__p1__echo')))
})

test('a preset that allows a profile server reveals its tools without a process start', async () => {
	const host = fakeHost({ configured: { p1: { transport: 'stdio', command: 'C:/tools/p1.exe' } } })
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/preset`, { name: 'work', rows: { p1: 'on' } })
	await call(route, 'POST', `${ROUTE_PREFIX}/folder`, { path: 'D:/work', preset: 'work' })
	await waitUntil(() => !host.activeRestrictions.some(filter => filter.deny.includes('mcp__p1__echo')))
	assert.deepEqual(host.registered, [])

	const loaded = await host.tools.get('mcp_load').definition.execute({ server: 'p1' }, { agent: { id: 'a1' } })
	assert.equal(loaded.status, 'external')
	assert.deepEqual(loaded.tools.map(tool => tool.name), ['mcp__p1__echo'])
	assert.deepEqual(host.registered, [])
})

test('a profile server cannot be edited or deleted through the GUI', async () => {
	const host = fakeHost({ configured: { p1: { transport: 'stdio', command: 'C:/tools/p1.exe' } } })
	apply(host.ctx)
	await tick()
	const route = host.routes[0]

	const edited = await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'p1', transport: 'stdio', command: 'other.exe' })
	assert.equal(edited.status, 400)
	assert.match(edited.json.error, /DSH MCP settings/)

	const removed = await call(route, 'POST', `${ROUTE_PREFIX}/server/delete`, { name: 'p1' })
	assert.equal(removed.status, 400)

	// Its process belongs to the settings; loading only reveals live tools.
	const activated = await call(route, 'POST', `${ROUTE_PREFIX}/activate`, { sessionId: 'a1', server: 'p1', action: 'load' })
	assert.equal(activated.status, 200)
	assert.deepEqual(activated.json.tools, ['mcp__p1__echo'])
	assert.deepEqual(host.registered, [])
})

test('a profile server switched off in the settings is started on demand and stopped on release', async () => {
	const host = fakeHost({
		configured: { p1: { transport: 'stdio', command: 'C:/tools/p1.exe', enabled: false } },
	})
	apply(host.ctx)
	await tick()
	const route = host.routes[0]

	const before = await call(route, 'GET', `${ROUTE_PREFIX}/state?sessionId=a1`)
	assert.equal(before.json.servers.find(server => server.name === 'p1').status, 'stopped')

	const loaded = await call(route, 'POST', `${ROUTE_PREFIX}/activate`, { sessionId: 'a1', server: 'p1', action: 'load' })
	assert.equal(loaded.status, 200)
	assert.equal(host.configured.p1.enabled, true)
	assert.deepEqual(loaded.json.tools, ['mcp__p1__echo'])
	const after = await call(route, 'GET', `${ROUTE_PREFIX}/state?sessionId=a1`)
	assert.equal(after.json.servers.find(server => server.name === 'p1').status, 'ready')

	const released = await call(route, 'POST', `${ROUTE_PREFIX}/activate`, { sessionId: 'a1', server: 'p1', action: 'release' })
	assert.equal(released.status, 200)
	await waitUntil(() => host.configured.p1.enabled === false)
	assert.deepEqual(host.registered, [])
})

test('a server dropped from the DSH MCP settings disappears from the registry', async () => {
	const configured = { p1: { transport: 'stdio', command: 'C:/tools/p1.exe' }, p2: { transport: 'stdio', command: 'C:/tools/p2.exe' } }
	const host = fakeHost({ configured })
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	let state = await call(route, 'GET', `${ROUTE_PREFIX}/state?sessionId=a1`)
	assert.equal(state.json.servers.length, 2)

	delete configured.p2
	state = await call(route, 'GET', `${ROUTE_PREFIX}/state?sessionId=a1`)
	assert.deepEqual(state.json.servers.map(server => server.name), ['p1'])
	assert.equal(state.json.presets[0].rows.p2, undefined)
})

test('the execution guard refuses a server the folder preset switched off', async () => {
	const host = fakeHost({ agents: [
		{ id: 'a1', ctx: {}, session: { header: { cwd: 'D:/work' } } },
	] })
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', transport: 'stdio', command: 'node' })
	await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'beta', transport: 'stdio', command: 'node' })
	await call(route, 'POST', `${ROUTE_PREFIX}/preset`, { name: 'quiet', rows: { beta: 'off' } })
	await call(route, 'POST', `${ROUTE_PREFIX}/folder`, { path: 'D:/work', preset: 'quiet' })
	await waitUntil(() => host.guards.length === 1)

	const guard = host.guards[0]
	assert.equal(guard({ name: 'mcp__alpha__echo', agent: { id: 'a1' } }), undefined)
	assert.match(guard({ name: 'mcp__beta__echo', agent: { id: 'a1' } }), /not enabled in this folder/)
	// Tools of other plugins and non-MCP tools are none of our business.
	assert.equal(guard({ name: 'read_file', agent: { id: 'a1' } }), undefined)
	assert.equal(guard({ name: 'mcp__ghost__echo', agent: { id: 'a1' } }), undefined)
})

test('a successful load caches the tool list of the server', async () => {
	const host = fakeHost()
	apply(host.ctx)
	await tick()
	await call(host.routes[0], 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', transport: 'stdio', command: 'node' })
	const agent = host.agents[0]
	await host.tools.get('mcp_load').definition.execute({ server: 'alpha' }, { agent })
	const cached = host.tables.get('servers').get('alpha').catalog
	assert.deepEqual(cached.tools.map(tool => tool.name), ['mcp__alpha__echo'])
	assert.equal(typeof cached.updatedAt, 'number')
	// The page shows the cached size even when the process is not running.
	const state = await call(host.routes[0], 'GET', `${ROUTE_PREFIX}/state`)
	const row = state.json.servers.find(server => server.name === 'alpha')
	assert.equal(row.toolCount, 1)
	await host.tools.get('mcp_release').definition.execute({ server: 'alpha' }, { agent })
	const after = await call(host.routes[0], 'GET', `${ROUTE_PREFIX}/state`)
	assert.equal(after.json.servers.find(server => server.name === 'alpha').toolCount, 1)
})
test('mount mode reports a missing loader instead of pretending to start', async () => {
	const host = fakeHost({
		configured: { p1: { transport: 'stdio', command: 'C:/tools/p1.exe', enabled: false } },
	})
	apply(host.ctx)
	await tick()
	const route = host.routes[0]
	await call(route, 'POST', `${ROUTE_PREFIX}/settings`, { profileLifecycle: 'mount' })
	const loaded = await call(route, 'POST', `${ROUTE_PREFIX}/activate`, { sessionId: 'a1', server: 'p1', action: 'load' })
	assert.equal(loaded.status, 400)
	assert.match(loaded.json.error, /loader service/)
	// The entry was not touched: nothing may be flipped on for a failed mount.
	assert.equal(host.configured.p1.enabled, false)
})

test('the host connection fence guards the routes', async () => {
	const host = fakeHost({ connection: { requestRejection: () => 403 } })
	apply(host.ctx)
	await tick()
	// Every route goes through the fence, not just the mutating ones.
	const state = await call(host.routes[0], 'GET', `${ROUTE_PREFIX}/state`)
	assert.equal(state.status, 403)
	assert.equal(state.json.code, 'FORBIDDEN')
	const write = await call(host.routes[0], 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', transport: 'stdio', command: 'node' })
	assert.equal(write.status, 403)
	assert.equal(host.tables.get('servers').has('alpha'), false)
})