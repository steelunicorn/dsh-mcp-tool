/**
 * Store tests: durable registry semantics over an in-memory domain fake.
 */

import assert from 'node:assert/strict'
import { test } from 'node:test'

import { Store } from '../lib/store.js'

function fakeStorageDomain(seed = {}) {
	const global = { value: seed.global }
	const tables = new Map()
	for (const [name, rows] of Object.entries(seed.tables ?? {})) tables.set(name, new Map(Object.entries(rows)))
	return {
		opened: 0,
		async open(spec) {
			this.opened += 1
			for (const table of Object.keys(spec.tables)) if (!tables.has(table)) tables.set(table, new Map())
			return {
				global: {
					get: () => global.value,
					set: async value => { global.value = value },
				},
				table(name) {
					const rows = tables.get(name)
					if (rows === undefined) throw new Error(`no table ${name}`)
					return {
						get: key => rows.get(key),
						entries: () => rows.entries(),
						keys: () => rows.keys(),
						get size() { return rows.size },
						put: async (key, value) => { rows.set(key, value) },
						delete: async key => rows.delete(key),
					}
				},
				close: async () => {},
			}
		},
	}
}

const stdio = name => ({ name, transport: 'stdio', command: 'node', args: ['server.mjs'], env: {} })

test('putServer stores validated records and lists them by name', async () => {
	const store = await Store.open(fakeStorageDomain())
	await store.putServer(stdio('zeta'))
	await store.putServer(stdio('alpha'))
	assert.deepEqual(store.servers().map(record => record.name), ['alpha', 'zeta'])
	assert.equal(store.server('alpha')?.command, 'node')
})

test('putServer rejects a name the MCP namespace would not accept', async () => {
	const store = await Store.open(fakeStorageDomain())
	await assert.rejects(store.putServer(stdio('bad name')), /name/i)
	assert.equal(store.servers().length, 0)
})

test('putServer rejects unknown fields', async () => {
	const store = await Store.open(fakeStorageDomain())
	await assert.rejects(store.putServer({ ...stdio('alpha'), extra: true }), /unrecognized|invalid/i)
})

test('deleteServer drops the server from every preset', async () => {
	const store = await Store.open(fakeStorageDomain())
	await store.putServer(stdio('alpha'))
	await store.putServer(stdio('beta'))
	await store.putPreset({ name: 'default', rows: { alpha: 'on', beta: 'on' } })
	await store.putPreset({ name: 'work', rows: { alpha: 'off' } })

	await store.deleteServer('alpha')

	assert.deepEqual(store.preset('default')?.rows, { beta: 'on' })
	assert.deepEqual(store.preset('work')?.rows, {})
	assert.deepEqual(store.servers().map(record => record.name), ['beta'])
})

test('the default preset cannot inherit and drops foreign names', async () => {
	const store = await Store.open(fakeStorageDomain())
	await store.putPreset({ name: 'default', rows: { alpha: 'inherit', 'bad name': 'on' } })
	assert.deepEqual(store.preset('default')?.rows, { alpha: 'on' })
})

test('putPreset keeps inherit rows and needs a name', async () => {
	const store = await Store.open(fakeStorageDomain())
	await store.putPreset({ name: 'work', rows: { alpha: 'inherit', beta: 'off' } })
	assert.deepEqual(store.preset('work')?.rows, { alpha: 'inherit', beta: 'off' })
	await assert.rejects(store.putPreset({ name: '   ', rows: {} }), /name/i)
})

test('deletePreset keeps the default and clears folder assignments', async () => {
	const store = await Store.open(fakeStorageDomain())
	await store.putPreset({ name: 'work', rows: {} })
	await store.putFolder('/work/a', 'work')
	assert.equal(await store.deletePreset('work'), true)
	assert.deepEqual(store.folders(), [])
	assert.equal(await store.deletePreset('work'), false)
	await assert.rejects(store.deletePreset('default'), /default/i)
})

test('folders are keyed by canonical path and the default preset clears them', async () => {
	const store = await Store.open(fakeStorageDomain())
	await store.putFolder('/work', 'work')
	assert.equal(store.folders().length, 1)
	assert.equal(store.folder('/work')?.preset, 'work')
	await store.putFolder('/work', 'default')
	assert.deepEqual(store.folders(), [])
	assert.equal(await store.deleteFolder('/work'), false)
})

test('records of the rule-based model are purged on open', async () => {
	const store = await Store.open(fakeStorageDomain({
		tables: {
			workspaces: {
				'c:/work': { path: 'c:/work', servers: ['alpha'], updatedAt: 1 },
			},
		},
	}))
	assert.deepEqual(store.folders(), [])
	assert.equal(store.folder('c:/work'), undefined)
})

test('settings default to the chip being visible and persist a change', async () => {
	const store = await Store.open(fakeStorageDomain())
	assert.equal(store.settings().showChip, true)
	await store.setSettings({ showChip: false })
	assert.equal(store.settings().showChip, false)
})

test('resolve reads the default preset, named presets inherit, folders pick the nearest', async () => {
	const store = await Store.open(fakeStorageDomain())
	await store.putServer(stdio('alpha'))
	await store.putServer(stdio('beta'))
	await store.putServer(stdio('gamma'))
	await store.putPreset({ name: 'default', rows: { alpha: 'off' } })
	await store.putPreset({ name: 'work', rows: { beta: 'on', gamma: 'off' } })
	await store.putFolder('/work', 'work')
	await store.putFolder('/work/deep', 'default')

	// No folder: alpha is off by the default preset, the rest default to on.
	assert.deepEqual(store.resolve('/elsewhere').servers, ['beta', 'gamma'])
	assert.equal(store.resolve('/elsewhere').preset, 'default')

	// The named preset inherits alpha from the default preset and switches gamma off.
	assert.deepEqual(store.resolve('/work/a').servers, ['beta'])
	assert.equal(store.resolve('/work/a').source, 'folder')

	// Assigning the default preset means "no assignment", so the parent assignment still wins.
	assert.deepEqual(store.resolve('/work/deep/a').servers, ['beta'])
	assert.equal(store.resolve('/work/deep/a').preset, 'work')
})
