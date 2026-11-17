// The shipped client half is a plain script for the browser loader
// `window.__ModuleLoader__.load({ id, factory(require) })`. This test loads the
// real artifact from lib/client.js with a stub loader, so the registrations we
// depend on (panel, sidebar row, composer chip) are checked as published.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const SOURCE = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

function loadModule() {
	let captured
	const window = {
		__ModuleLoader__: {
			load(definition) {
				captured = definition
			},
		},
	}
	new Function('window', SOURCE)(window)
	assert.ok(captured !== undefined, 'the bundle calls window.__ModuleLoader__.load')
	return captured
}

function fakeReact() {
	const createElement = (type, props, ...children) => ({ type, props, children })
	return {
		createElement,
		useState: initial => [typeof initial === 'function' ? initial() : initial, () => {}],
		useEffect: () => {},
		useCallback: fn => fn,
		useMemo: fn => fn(),
		useRef: value => ({ current: value }),
		Fragment: 'Fragment',
	}
}

const REACT = fakeReact()
const REACT_DOM = { createPortal: node => node }

function fakeContext() {
	const registrations = []
	const locales = []
	const ctx = {
		effect(factory, label) {
			const dispose = factory()
			return () => {
				if (typeof dispose === 'function') dispose()
				void label
			}
		},
		locale: {
			register: (namespace, locale, dictionary) => {
				locales.push({ namespace, locale, size: Object.keys(dictionary).length })
			},
			bind: () => (key, ...args) => `${key}${args.length === 0 ? '' : `:${args.join(',')}`}`,
		},
		slots: {
			inject(slot, factory) {
				const dispose = factory()
				return () => {
					if (typeof dispose === 'function') dispose()
					void slot
				}
			},
			register(config, component) {
				registrations.push({ config, component })
				return () => {}
			},
		},
	}
	return { ctx, registrations, locales }
}

test('the client bundle exports inject and apply', () => {
	const definition = loadModule()
	assert.equal(definition.id, 'dsh-mcp-tool')
	const module = definition.factory(() => ({}))
	assert.deepEqual(module.inject, ['slots', 'locale'])
	assert.equal(typeof module.apply, 'function')
})

test('apply registers the settings page, its icon and the composer chip', () => {
	const definition = loadModule()
	const require = spec => {
		if (spec === 'react') return REACT
		if (spec === 'react-dom') return REACT_DOM
		throw new Error(`unexpected require ${spec}`)
	}
	const module = definition.factory(require)
	assert.deepEqual(module.inject, ['slots', 'locale'])

	const { ctx, registrations, locales } = fakeContext()
	module.apply(ctx)

	const bySlot = new Map(registrations.map(entry => [entry.config.name, entry.config]))
	assert.equal(registrations.length, 3, 'three registrations')
	assert.equal(bySlot.get('settings.section').id, 'mcp-tool')
	assert.equal(bySlot.get('settings.section.icon').id, 'mcp-tool', 'the icon uses the id of its section')
	assert.equal(bySlot.get('conversation.input.right').id, 'mcp-tool')
	assert.equal(typeof bySlot.get('settings.section').label, 'function')

	for (const entry of registrations) {
		assert.equal(typeof entry.component, 'function', `${entry.config.name} has a component`)
	}

	const languages = locales.map(entry => entry.locale).sort()
	assert.deepEqual(languages, ['en', 'ru'])
	assert.ok(locales.every(entry => entry.namespace === 'mcp-tool' && entry.size > 20))
})
