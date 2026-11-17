/**
 * Route tests: the GUI contract over a fake backend and a fake HTTP pair.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { registerRoutes, ROUTE_PREFIX } from '../lib/http.js'

function harness(overrides = {}) {
	const calls = {
		putServer: [], deleteServer: [], putPreset: [], deletePreset: [], putFolder: [], deleteFolder: [],
		setSettings: [], load: [], release: [], changed: 0, profileEnabled: [],
	}
	const servers = overrides.servers ?? [
		{ name: 'alpha', description: 'demo', transport: 'stdio', loadMode: 'lazy', command: 'node', args: ['a.mjs'], env: {} },
	]
	const store = {
		servers: () => servers,
		server: name => servers.find(record => record.name === name),
		presets: () => overrides.presets ?? [],
		defaultPreset: () => overrides.defaultPreset ?? { name: 'default', rows: { alpha: 'on' } },
		folders: () => overrides.folders ?? [],
		settings: () => overrides.settings ?? { showChip: true },
		catalog: name => overrides.catalog?.[name] ?? [],
		catalogAt: name => overrides.catalogAt?.[name],
		putServer: async record => { calls.putServer.push(record) },
		deleteServer: async name => { calls.deleteServer.push(name) },
		putPreset: async preset => { calls.putPreset.push(preset) },
		deletePreset: async name => { calls.deletePreset.push(name); return name !== 'default' },
		putFolder: async (path, preset) => { calls.putFolder.push([path, preset]) },
		deleteFolder: async path => { calls.deleteFolder.push(path); return true },
		setSettings: async settings => { calls.setSettings.push(settings) },
	}
	const routes = []
	const backend = {
		store: () => (overrides.pendingStore === true ? undefined : store),
		live: () => overrides.live ?? [],
		policyForSession: (sessionId, cwd) => {
			calls.policy = [sessionId, cwd]
			return overrides.policy ?? { source: 'default', path: null, preset: 'default', servers: ['alpha'] }
		},
		cwdOfSession: sessionId => {
			calls.cwdFor = sessionId
			return ('sessionCwd' in overrides ? overrides.sessionCwd : '/work')
		},
		activeSessionId: () => overrides.activeSessionId,
		workspaces: () => overrides.workspaces ?? [{ path: '/work', title: 'Work' }],
		changed: () => { calls.changed += 1 },
		syncProfile: () => { calls.syncProfile = (calls.syncProfile ?? 0) + 1 },
		load: async (sessionId, server, cwdHint) => {
			calls.load.push([sessionId, server, cwdHint])
			return { name: server, tools: [{ name: `mcp__${server}__echo` }] }
		},
		release: (sessionId, server) => {
			calls.release.push([sessionId, server])
			return { released: true, stopped: true }
		},
		exists: async path => path === '/work',
		profileOwned: server => server === 'owned',
		...(overrides.setProfileEnabled === undefined ? {} : { setProfileEnabled: overrides.setProfileEnabled }),
	}
	registerRoutes(backend, {
		register(route) {
			routes.push(route)
			return () => {}
		},
	})
	assert.equal(routes.length, 1)
	assert.equal(routes[0].kind, 'prefix')
	assert.equal(routes[0].path, ROUTE_PREFIX)
	return { route: routes[0], calls, store }
}

async function call(route, method, path, body, headers = { 'content-type': 'application/json', 'x-dsh-mcp-tool': '1' }) {
	const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
	const req = {
		method,
		url: path,
		headers,
		async *[Symbol.asyncIterator]() { yield* chunks },
	}
	const res = {
		status: 0,
		headers: undefined,
		body: '',
		writeHead(status, headers) { this.status = status; this.headers = headers },
		end(body) { this.body = body ?? '' },
	}
	await route.handler(req, res)
	return { status: res.status, json: res.body === '' ? undefined : JSON.parse(res.body) }
}

test('GET /state reports servers, presets, folders and the switch of the folder', async () => {
	const { route } = harness({
		live: [{ name: 'alpha', status: 'ready', holders: ['s1'], toolCount: 3 }],
		folders: [{ path: '/work', preset: 'work' }],
	})
	const { status, json } = await call(route, 'GET', `${ROUTE_PREFIX}/state?sessionId=s1`)
	assert.equal(status, 200)
	assert.equal(json.cwd, '/work')
	assert.equal(json.source, 'default')
	assert.equal(json.preset, 'default')
	assert.deepEqual(json.settings, { showChip: true })
	assert.deepEqual(json.folders, [{ path: '/work', preset: 'work' }])
	assert.deepEqual(json.workspaces, [{ path: '/work', title: 'Work' }])
	// The `default` preset is synthesized by the store; it must still appear first.
	assert.deepEqual(json.presets, [{ name: 'default', rows: { alpha: 'on' }, updatedAt: 0 }])
	const server = json.servers[0]
	assert.deepEqual(
		{ name: server.name, status: server.status, live: server.live, allowed: server.allowed, toolCount: server.toolCount, loadMode: server.loadMode },
		{ name: 'alpha', status: 'ready', live: true, allowed: true, toolCount: 3, loadMode: 'lazy' },
	)
})

test('GET /state lists the synthesized default preset before named ones', async () => {
	const { route } = harness({ presets: [{ name: 'work', rows: { alpha: 'off' }, updatedAt: 5 }] })
	const { status, json } = await call(route, 'GET', `${ROUTE_PREFIX}/state`)
	assert.equal(status, 200)
	assert.deepEqual(json.presets.map(entry => entry.name), ['default', 'work'])
	assert.deepEqual(json.presets[1].rows, { alpha: 'off' })
})

test('GET /state mirrors the DSH MCP settings before building the document', async () => {
	const { route, calls } = harness()
	await call(route, 'GET', `${ROUTE_PREFIX}/state`)
	assert.equal(calls.syncProfile, 1)
})

test('GET /state reports the origin of a mirrored server', async () => {
	const { route } = harness({
		servers: [{
			name: 'p1', description: '', transport: 'stdio', command: 'p1.exe', args: [], env: {},
			origin: 'profile',
		}],
	})
	const { json } = await call(route, 'GET', `${ROUTE_PREFIX}/state`)
	const server = json.servers[0]
	assert.equal(server.origin, 'profile')
	// The pool has no process for it; the host reports its state separately.
	assert.equal(server.live, false)
})

test('GET /state reports a stopped mirror as not live and a running one as live', async () => {
	const stopped = harness({
		servers: [{ name: 'p1', description: '', transport: 'stdio', command: 'p1.exe', origin: 'profile' }],
		live: [{ name: 'p1', status: 'stopped', holders: [], inFlight: 0, lastUsed: 0, toolCount: 4 }],
	})
	const off = await call(stopped.route, 'GET', `${ROUTE_PREFIX}/state`)
	assert.equal(off.json.servers[0].status, 'stopped')
	assert.equal(off.json.servers[0].live, false)
	assert.equal(off.json.servers[0].toolCount, 4)

	const running = harness({
		servers: [{ name: 'p1', description: '', transport: 'stdio', command: 'p1.exe', origin: 'profile' }],
		live: [{ name: 'p1', status: 'ready', holders: [], inFlight: 0, lastUsed: 0, toolCount: 4 }],
	})
	const on = await call(running.route, 'GET', `${ROUTE_PREFIX}/state`)
	assert.equal(on.json.servers[0].live, true)
})

test('a mirrored server cannot be edited or deleted from the plugin', async () => {
	const { route, calls } = harness({
		servers: [{
			name: 'p1', description: '', transport: 'stdio', command: 'p1.exe', args: [], env: {}, origin: 'profile',
		}],
	})
	const edited = await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'p1', transport: 'stdio', command: 'x.exe' })
	assert.equal(edited.status, 400)
	assert.match(edited.json.error, /DSH MCP settings/)

	const removed = await call(route, 'POST', `${ROUTE_PREFIX}/server/delete`, { name: 'p1' })
	assert.equal(removed.status, 400)

	// Starting it is the backend's call: it may start a server the settings
	// keep switched off. The route must not decide on its own.
	const activated = await call(route, 'POST', `${ROUTE_PREFIX}/activate`, { sessionId: 's1', server: 'p1', action: 'load' })
	assert.equal(activated.status, 200)
	assert.deepEqual(calls.load, [['s1', 'p1', undefined]])

	const released = await call(route, 'POST', `${ROUTE_PREFIX}/activate`, { sessionId: 's1', server: 'p1', action: 'release' })
	assert.equal(released.status, 200)
})

test('routes answer 503 until the registry opened', async () => {
	const { route } = harness({ pendingStore: true })
	const { status, json } = await call(route, 'GET', `${ROUTE_PREFIX}/state`)
	assert.equal(status, 503)
	assert.equal(json.ok, false)
})

test('unknown route answers 404', async () => {
	const { route } = harness()
	const { status } = await call(route, 'GET', `${ROUTE_PREFIX}/nope`)
	assert.equal(status, 404)
})

test('POST /server rejects a body without a usable name', async () => {
	const { route } = harness()
	const { status, json } = await call(route, 'POST', `${ROUTE_PREFIX}/server`, { transport: 'stdio', command: 'node' })
	assert.equal(status, 400)
	assert.equal(json.ok, false)
	assert.match(json.error, /name/)
})

test('POST /server upserts a stdio record with its load mode', async () => {
	const { route, calls } = harness()
	const { status } = await call(route, 'POST', `${ROUTE_PREFIX}/server`, {
		name: 'alpha',
		transport: 'stdio',
		loadMode: 'eager',
		command: 'node',
		args: ['a.mjs'],
		env: { A: '1', B: 2 },
	})
	assert.equal(status, 200)
	assert.deepEqual(calls.putServer, [
		{ name: 'alpha', transport: 'stdio', loadMode: 'eager', command: 'node', args: ['a.mjs'], env: { A: '1' } },
	])
	assert.equal(calls.changed, 1)
})

test('POST /server defaults the load mode to lazy and upserts an http record', async () => {
	const { route, calls } = harness()
	const { status } = await call(route, 'POST', `${ROUTE_PREFIX}/server`, {
		name: 'remote',
		transport: 'http',
		url: 'https://example.test/mcp',
		headers: { authorization: 'x' },
	})
	assert.equal(status, 200)
	assert.deepEqual(calls.putServer, [
		{ name: 'remote', transport: 'http', loadMode: 'lazy', url: 'https://example.test/mcp', headers: { authorization: 'x' } },
	])
})

test('POST /preset stores the rows and a timestamp', async () => {
	const { route, calls } = harness()
	const { status } = await call(route, 'POST', `${ROUTE_PREFIX}/preset`, { name: 'work', rows: { alpha: 'inherit', beta: 'off' } })
	assert.equal(status, 200)
	assert.equal(calls.putPreset.length, 1)
	assert.equal(calls.putPreset[0].name, 'work')
	assert.deepEqual(calls.putPreset[0].rows, { alpha: 'inherit', beta: 'off' })
	assert.equal(typeof calls.putPreset[0].updatedAt, 'number')
})

test('POST /preset rejects a row that is not a switch state', async () => {
	const { route, calls } = harness()
	const { status, json } = await call(route, 'POST', `${ROUTE_PREFIX}/preset`, { name: 'work', rows: { alpha: 'maybe' } })
	assert.equal(status, 400)
	assert.match(json.error, /inherit/)
	assert.deepEqual(calls.putPreset, [])
})

test('POST /preset/delete reports whether the preset existed', async () => {
	const { route } = harness()
	const removed = await call(route, 'POST', `${ROUTE_PREFIX}/preset/delete`, { name: 'work' })
	assert.deepEqual(removed.json, { ok: true, removed: true })
	const kept = await call(route, 'POST', `${ROUTE_PREFIX}/preset/delete`, { name: 'default' })
	assert.deepEqual(kept.json, { ok: true, removed: false })
})

test('POST /folder assigns a preset and /folder/delete removes it', async () => {
	const { route, calls } = harness()
	await call(route, 'POST', `${ROUTE_PREFIX}/folder`, { path: '/work', preset: 'work' })
	assert.deepEqual(calls.putFolder, [['/work', 'work']])
	const removed = await call(route, 'POST', `${ROUTE_PREFIX}/folder/delete`, { path: '/work' })
	assert.equal(removed.json.removed, true)
	assert.deepEqual(calls.deleteFolder, ['/work'])
})

test('POST /folder without a preset falls back to the default preset', async () => {
	const { route, calls } = harness()
	await call(route, 'POST', `${ROUTE_PREFIX}/folder`, { path: '/work' })
	assert.deepEqual(calls.putFolder, [['/work', 'default']])
})

test('POST /settings needs a boolean and stores it', async () => {
	const { route, calls } = harness()
	const bad = await call(route, 'POST', `${ROUTE_PREFIX}/settings`, { showChip: 'yes' })
	assert.equal(bad.status, 400)
	await call(route, 'POST', `${ROUTE_PREFIX}/settings`, { showChip: false })
	assert.deepEqual(calls.setSettings, [{ showChip: false }])
})

test('POST /settings accepts the profile lifecycle mode and rejects an unknown one', async () => {
	const { route, calls } = harness()
	const bad = await call(route, 'POST', `${ROUTE_PREFIX}/settings`, { profileLifecycle: 'mine' })
	assert.equal(bad.status, 400)
	assert.match(bad.json.error, /profileLifecycle/)
	await call(route, 'POST', `${ROUTE_PREFIX}/settings`, { profileLifecycle: 'mount' })
	assert.deepEqual(calls.setSettings, [{ showChip: true, profileLifecycle: 'mount' }])
})

test('POST /profile/enabled flips the DSH settings entry when the host allows it', async () => {
	const { route, calls } = harness({ setProfileEnabled: async (server, enabled) => { calls.profileEnabled.push([server, enabled]) } })
	const { status } = await call(route, 'POST', `${ROUTE_PREFIX}/profile/enabled`, { server: 'p1', enabled: false })
	assert.equal(status, 200)
	assert.deepEqual(calls.profileEnabled, [['p1', false]])

	const missing = await call(route, 'POST', `${ROUTE_PREFIX}/profile/enabled`, { server: 'p1', enabled: 'no' })
	assert.equal(missing.status, 400)
})

test('GET /workspaces merges the workspace registry and the assignments', async () => {
	const { route } = harness({ folders: [{ path: '/work/a', preset: 'work' }] })
	const { status, json } = await call(route, 'GET', `${ROUTE_PREFIX}/workspaces`)
	assert.equal(status, 200)
	assert.deepEqual(json.workspaces, [{ path: '/work', title: 'Work' }])
	assert.deepEqual(json.folders, [{ path: '/work/a', preset: 'work' }])
})

test('POST /activate loads and releases a server for one session', async () => {
	const { route, calls } = harness()
	const loaded = await call(route, 'POST', `${ROUTE_PREFIX}/activate`, { sessionId: 's1', server: 'alpha', action: 'load' })
	assert.equal(loaded.status, 200)
	assert.deepEqual(loaded.json.tools, ['mcp__alpha__echo'])
	const released = await call(route, 'POST', `${ROUTE_PREFIX}/activate`, { sessionId: 's1', server: 'alpha', action: 'release' })
	assert.equal(released.status, 200)
	assert.equal(released.json.stopped, true)
	assert.deepEqual(calls.load, [['s1', 'alpha', undefined]])
	assert.deepEqual(calls.release, [['s1', 'alpha']])
})

test('POST /activate forwards the cwd hint of a session without a live agent', async () => {
	const { route, calls } = harness({ sessionCwd: undefined })
	await call(route, 'POST', `${ROUTE_PREFIX}/activate`, { sessionId: 's1', cwd: '/work/sub', server: 'alpha', action: 'load' })
	assert.deepEqual(calls.load, [['s1', 'alpha', '/work/sub']])
})

test('GET /state falls back to the cwd hint when the session has no live agent', async () => {
	const { route, calls } = harness({ sessionCwd: undefined })
	const { status, json } = await call(route, 'GET', `${ROUTE_PREFIX}/state?sessionId=s1&cwd=${encodeURIComponent('/work/sub')}`)
	assert.equal(status, 200)
	assert.equal(json.cwd, '/work/sub')
	assert.deepEqual(calls.policy, ['s1', '/work/sub'])
})

test('GET /state resolves the active session when the GUI sends none', async () => {
	const { route, calls } = harness({ activeSessionId: 'a9' })
	const { status, json } = await call(route, 'GET', `${ROUTE_PREFIX}/state`)
	assert.equal(status, 200)
	assert.equal(json.sessionId, 'a9')
	assert.equal(calls.cwdFor, 'a9')
	assert.equal(json.cwd, '/work')
})

test('GET /folder-exists reports whether the directory exists', async () => {
	const { route } = harness()
	const found = await call(route, 'GET', `${ROUTE_PREFIX}/folder-exists?path=${encodeURIComponent('/work')}`)
	assert.deepEqual(found.json, { ok: true, exists: true })
	const missing = await call(route, 'GET', `${ROUTE_PREFIX}/folder-exists?path=${encodeURIComponent('/nowhere')}`)
	assert.deepEqual(missing.json, { ok: true, exists: false })
})

test('a body over the limit is refused instead of buffered', async () => {
	const { route } = harness()
	const huge = 'x'.repeat(300 * 1024)
	const { status, json } = await call(route, 'POST', `${ROUTE_PREFIX}/server`, { name: 'alpha', command: huge })
	assert.equal(status, 400)
	assert.match(json.error, /too large/)
})

test('invalid JSON is refused', async () => {
	const { route } = harness()
	const req = {
		method: 'POST',
		url: `${ROUTE_PREFIX}/settings`,
		headers: { 'content-type': 'application/json', 'x-dsh-mcp-tool': '1' },
		async *[Symbol.asyncIterator]() { yield Buffer.from('{not json') },
	}
	const res = { status: 0, writeHead(status) { this.status = status }, end() {} }
	await route.handler(req, res)
	assert.equal(res.status, 400)
})

test('a mutation without the surrogate header is refused', async () => {
	const { route, calls } = harness()
	const req = {
		method: 'POST',
		url: `${ROUTE_PREFIX}/preset`,
		headers: { 'content-type': 'application/json' },
		async *[Symbol.asyncIterator]() { yield Buffer.from(JSON.stringify({ name: 'work', rows: {} })) },
	}
	const res = { status: 0, writeHead(status) { this.status = status }, end() {} }
	await route.handler(req, res)
	assert.equal(res.status, 403)
	assert.deepEqual(calls.putPreset, [])
})

test('a mutation with a non-JSON content type is refused', async () => {
	const { route } = harness()
	const { status } = await call(route, 'POST', `${ROUTE_PREFIX}/settings`, { showChip: true }, { 'content-type': 'text/plain', 'x-dsh-mcp-tool': '1' })
	assert.equal(status, 403)
})
