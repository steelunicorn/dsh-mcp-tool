import { test } from 'node:test'
import assert from 'node:assert/strict'
import { canonicalPath, isAncestorOrSelf, resolveAllowed, resolveFolderPreset, DEFAULT_PRESET } from '../lib/policy.js'

const win = process.platform === 'win32'

test('canonicalPath normalizes separators, trailing slash and Windows case', () => {
	const base = canonicalPath('D:/Projects/Foo/')
	assert.equal(base, win ? 'd:/projects/foo' : 'D:/Projects/Foo')
	assert.equal(canonicalPath('D:\\Projects\\Foo'), base)
	assert.equal(canonicalPath('D:/Projects/Foo/Bar/..'), base)
})

test('isAncestorOrSelf respects path segment boundaries', () => {
	const root = canonicalPath('D:/Projects/Foo')
	assert.equal(isAncestorOrSelf(root, canonicalPath('D:/Projects/Foo')), true)
	assert.equal(isAncestorOrSelf(root, canonicalPath('D:/Projects/Foo/Bar')), true)
	assert.equal(isAncestorOrSelf(root, canonicalPath('D:/Projects/Foobar')), false)
})

test('resolveFolderPreset picks the longest matching assignment', () => {
	const folders = [
		{ path: 'D:/Projects/Foo', preset: 'outer' },
		{ path: 'D:/Projects/Foo/Bar', preset: 'inner' },
	]
	assert.deepEqual(resolveFolderPreset('D:/Projects/Foo/Bar/Baz', folders), {
		path: canonicalPath('D:/Projects/Foo/Bar'),
		preset: 'inner',
	})
	assert.deepEqual(resolveFolderPreset('D:/Projects/Other', folders), { path: null, preset: DEFAULT_PRESET })
	assert.equal(resolveFolderPreset('D:/Projects/Foobar/x', folders).preset, DEFAULT_PRESET)
})

test('resolveAllowed applies on, off and inherit against the default preset', () => {
	const presets = [
		{ name: 'default', rows: { alpha: 'off', beta: 'on' } },
		{ name: 'work', rows: { alpha: 'on', beta: 'inherit', gamma: 'off' } },
	]
	const folders = [{ path: 'D:/Work', preset: 'work' }]

	assert.deepEqual(resolveAllowed('D:/Work/a', folders, presets, ['alpha', 'beta', 'gamma']), {
		source: 'folder',
		path: canonicalPath('D:/Work'),
		preset: 'work',
		servers: ['alpha', 'beta'],
	})
	// alpha is off in the default preset; beta is on and gamma has no row, which means on.
	assert.deepEqual(resolveAllowed('D:/Else', folders, presets, ['alpha', 'beta', 'gamma']).servers, ['beta', 'gamma'])
	assert.equal(resolveAllowed('D:/Else', folders, presets, []).source, 'default')
})

test('a missing row means inherit, and in the default preset it means on', () => {
	const presets = [{ name: 'default', rows: {} }, { name: 'empty', rows: {} }]
	const folders = [{ path: 'D:/Work', preset: 'empty' }]
	assert.deepEqual(resolveAllowed('D:/Work', folders, presets, ['alpha']).servers, ['alpha'])
	assert.deepEqual(resolveAllowed('', folders, presets, ['alpha']), {
		source: 'default',
		path: null,
		preset: 'default',
		servers: ['alpha'],
	})
})

test('an unknown preset name falls back to the default preset switches', () => {
	const presets = [{ name: 'default', rows: { alpha: 'off' } }]
	const folders = [{ path: 'D:/Work', preset: 'gone' }]
	assert.deepEqual(resolveAllowed('D:/Work', folders, presets, ['alpha', 'beta']).servers, ['beta'])
})
