import { test } from 'node:test'
import assert from 'node:assert/strict'
import { McpRuntime, ActivationError } from '../lib/runtime.js'

function spec(name) {
	return { name, transport: 'stdio', command: 'x', args: [] }
}

function makeHost() {
	const started = []
	const stopped = []
	const hides = new Map()
	let status = 'ready'
	let failStart = null
	const manager = {
		register(entry) {
			if (failStart !== null) throw new Error(failStart)
			started.push(entry.name)
			return () => {
				stopped.push(entry.name)
			}
		},
		status: () => status,
	}
	const catalog = {
		toolNames: (server) => (started.includes(server) && !stopped.includes(server) ? [`mcp__${server}__echo`] : []),
		toolSchemas: (server) => [{ name: `mcp__${server}__echo`, description: 'echo', parameters: {} }],
		hide(agentId, names) {
			hides.set(agentId, names)
			return () => hides.delete(agentId)
		},
	}
	return {
		manager,
		catalog,
		started,
		stopped,
		hides,
		setStatus(value) {
			status = value
		},
		failOnStart(message) {
			failStart = message
		},
	}
}

test('load starts one process shared by holders and release stops it at zero', async () => {
	const host = makeHost()
	const runtime = new McpRuntime({ manager: host.manager, catalog: host.catalog, startupTimeoutMs: 200 })
	const first = await runtime.load(spec('alpha'), 'agent-1', ['alpha'])
	assert.deepEqual(first.tools.map((tool) => tool.name), ['mcp__alpha__echo'])
	await runtime.load(spec('alpha'), 'agent-2', ['alpha'])
	assert.deepEqual(host.started, ['alpha'])
	assert.deepEqual(runtime.holders('alpha').sort(), ['agent-1', 'agent-2'])
	assert.equal(runtime.release('alpha', 'agent-1').stopped, false)
	assert.equal(runtime.isLive('alpha'), true)
	assert.equal(runtime.release('alpha', 'agent-2').stopped, true)
	assert.equal(runtime.isLive('alpha'), false)
	assert.deepEqual(host.stopped, ['alpha'])
})

test('load refuses a server outside the allowlist', async () => {
	const host = makeHost()
	const runtime = new McpRuntime({ manager: host.manager, catalog: host.catalog })
	await assert.rejects(runtime.load(spec('alpha'), 'agent-1', ['beta']), (error) => {
		assert.ok(error instanceof ActivationError)
		assert.equal(error.reason, 'not-allowed')
		return true
	})
	assert.deepEqual(host.started, [])
})

test('load reports a failed start without leaking a live entry', async () => {
	const host = makeHost()
	const runtime = new McpRuntime({ manager: host.manager, catalog: host.catalog })
	host.failOnStart('spawn ENOENT')
	await assert.rejects(runtime.load(spec('alpha'), 'agent-1', ['alpha']), (error) => {
		assert.ok(error instanceof ActivationError)
		assert.equal(error.reason, 'failed')
		assert.match(error.message, /spawn ENOENT/)
		return true
	})
	assert.equal(runtime.isLive('alpha'), false)
})

test('load times out when the host never reports ready', async () => {
	const host = makeHost()
	host.setStatus('starting')
	const runtime = new McpRuntime({ manager: host.manager, catalog: host.catalog, startupTimeoutMs: 5 })
	await assert.rejects(runtime.load(spec('alpha'), 'agent-1', ['alpha']), (error) => {
		assert.ok(error instanceof ActivationError)
		assert.equal(error.reason, 'timeout')
		return true
	})
	assert.equal(runtime.holders('alpha').length, 0)
})

test('sweep stops a server left loaded longer than the idle window', async () => {
	let clock = 1_000
	const host = makeHost()
	const runtime = new McpRuntime({
		manager: host.manager,
		catalog: host.catalog,
		idleMs: 100,
		now: () => clock,
	})
	await runtime.load(spec('alpha'), 'agent-1', ['alpha'])
	assert.deepEqual(runtime.sweep(), [])
	clock += 101
	assert.deepEqual(runtime.sweep(), ['alpha'])
	assert.equal(runtime.isLive('alpha'), false)
	assert.equal(runtime.holders('alpha').length, 0)
})

test('sweep never stops a server with a call in flight', async () => {
	let clock = 1_000
	const host = makeHost()
	const runtime = new McpRuntime({ manager: host.manager, catalog: host.catalog, idleMs: 10, now: () => clock })
	await runtime.load(spec('alpha'), 'agent-1', ['alpha'])
	runtime.beginCall('alpha')
	clock += 5_000
	assert.deepEqual(runtime.sweep(), [])
	assert.equal(runtime.isLive('alpha'), true)
	runtime.endCall('alpha')
	// The completed call itself counts as usage, so the window restarts.
	assert.deepEqual(runtime.sweep(), [])
	clock += 11
	assert.deepEqual(runtime.sweep(), ['alpha'])
})

test('capacity frees a slot by evicting the least recently used idle server', async () => {
	let clock = 1_000
	const host = makeHost()
	const runtime = new McpRuntime({
		manager: host.manager,
		catalog: host.catalog,
		maxLive: 2,
		idleMs: 100,
		now: () => clock,
	})
	await runtime.load(spec('alpha'), 'agent-1', ['alpha', 'beta', 'gamma'])
	await runtime.load(spec('beta'), 'agent-1', ['alpha', 'beta', 'gamma'])
	clock += 101
	await runtime.load(spec('gamma'), 'agent-1', ['alpha', 'beta', 'gamma'])
	assert.deepEqual(
		runtime
			.snapshot()
			.map((entry) => entry.name)
			.sort(),
		['beta', 'gamma'],
	)
	assert.deepEqual(host.stopped, ['alpha'])
})

test('capacity refuses a new server while every live one is fresh', async () => {
	const host = makeHost()
	const runtime = new McpRuntime({ manager: host.manager, catalog: host.catalog, maxLive: 1, idleMs: 60_000 })
	await runtime.load(spec('alpha'), 'agent-1', ['alpha', 'beta'])
	await assert.rejects(runtime.load(spec('beta'), 'agent-1', ['alpha', 'beta']), (error) => {
		assert.ok(error instanceof ActivationError)
		assert.equal(error.reason, 'capacity')
		return true
	})
	assert.equal(runtime.isLive('beta'), false)
	assert.equal(runtime.isLive('alpha'), true)
})

test('a live server is hidden from agents that did not load it', async () => {
	const host = makeHost()
	const runtime = new McpRuntime({ manager: host.manager, catalog: host.catalog })
	runtime.trackAgent('agent-1')
	runtime.trackAgent('agent-2')
	await runtime.load(spec('alpha'), 'agent-1', ['alpha'])
	assert.deepEqual(host.hides.get('agent-2'), ['mcp__alpha__echo'])
	assert.equal(host.hides.has('agent-1'), false)
	runtime.release('alpha', 'agent-1')
	assert.equal(host.hides.has('agent-2'), false)
})

test('untracking an agent releases its servers', async () => {
	const host = makeHost()
	const runtime = new McpRuntime({ manager: host.manager, catalog: host.catalog })
	runtime.trackAgent('agent-1')
	await runtime.load(spec('alpha'), 'agent-1', ['alpha'])
	runtime.untrackAgent('agent-1')
	assert.equal(runtime.isLive('alpha'), false)
	assert.deepEqual(host.stopped, ['alpha'])
})

test('dispose stops everything and restores visibility', async () => {
	const host = makeHost()
	const runtime = new McpRuntime({ manager: host.manager, catalog: host.catalog })
	runtime.trackAgent('agent-1')
	runtime.trackAgent('agent-2')
	await runtime.load(spec('alpha'), 'agent-1', ['alpha'])
	runtime.dispose()
	assert.equal(runtime.isLive('alpha'), false)
	assert.equal(host.hides.has('agent-2'), false)
})
