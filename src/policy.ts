/**
 * Folder policy: which preset a working directory uses, and which servers that
 * preset resolves to.
 *
 * The rules are deliberately small and pure so they can be unit-tested without
 * a host: a working folder inherits the assignment of its nearest assigned
 * ancestor, and a preset maps server names to `on`, `off`, or `inherit`. A
 * missing row means `inherit`, which reads the `default` preset; inside the
 * `default` preset a missing row means `on`, so a freshly registered server is
 * available everywhere until it is switched off.
 *
 * @module dsh-mcp-tool/policy
 */

import { resolve } from 'node:path'

/** Name of the preset applied to folders without their own assignment. */
export const DEFAULT_PRESET = 'default'

/** Position of one server inside a preset. */
export type PresetState = 'on' | 'off' | 'inherit'

/** One named set of server switches. */
export interface PresetRecord {
	name: string
	rows: Record<string, PresetState>
	/** Epoch milliseconds of the last edit. */
	updatedAt?: number
}

/** Preset assigned to one folder (or a whole subtree). */
export interface FolderRecord {
	path: string
	preset: string
	/** Epoch milliseconds of the last edit. */
	updatedAt?: number
}

/** Effective allowlist of one working directory. */
export interface Resolution {
	/** `folder` when an assignment applied, `default` otherwise. */
	source: 'folder' | 'default'
	/** Canonical path of the matching assignment, null for the default preset. */
	path: string | null
	/** Preset name that produced the list. */
	preset: string
	/** Servers that are switched on, ordered by name. */
	servers: string[]
}

/**
 * Canonical form used for every comparison and for stored keys: absolute,
 * forward slashes, no trailing separator, lowercase on Windows.
 */
export function canonicalPath(input: string): string {
	let value = resolve(input).replace(/\\/g, '/')
	if (value.length > 1) value = value.replace(/\/+$/, '')
	return process.platform === 'win32' ? value.toLowerCase() : value
}

/** True when `ancestor` is `descendant` itself or one of its parent folders. */
export function isAncestorOrSelf(ancestor: string, descendant: string): boolean {
	if (ancestor === descendant) return true
	return descendant.startsWith(ancestor.endsWith('/') ? ancestor : `${ancestor}/`)
}

/** The nearest assignment covering `cwd`, or the default preset. */
export function resolveFolderPreset(cwd: string, folders: FolderRecord[]): { path: string | null; preset: string } {
	const target = canonicalPath(cwd)
	let best: FolderRecord | undefined
	for (const folder of folders) {
		const candidate = canonicalPath(folder.path)
		if (!isAncestorOrSelf(candidate, target)) continue
		if (best === undefined || candidate.length > canonicalPath(best.path).length) {
			best = { ...folder, path: candidate }
		}
	}
	if (best !== undefined) return { path: best.path, preset: best.preset }
	return { path: null, preset: DEFAULT_PRESET }
}

/** State of one server inside the `default` preset: a missing row means `on`. */
function defaultState(defaultPreset: PresetRecord | undefined, server: string): PresetState {
	const state = defaultPreset?.rows[server]
	return state === 'off' ? 'off' : 'on'
}

/**
 * Resolves the effective allowlist: the assigned preset first, `inherit` rows
 * (and missing rows) read the `default` preset, and only `on` servers survive.
 */
export function resolveAllowed(
	cwd: string,
	folders: FolderRecord[],
	presets: PresetRecord[],
	serverNames: string[],
): Resolution {
	const assigned = cwd === '' ? { path: null, preset: DEFAULT_PRESET } : resolveFolderPreset(cwd, folders)
	const preset = presets.find(entry => entry.name === assigned.preset)
	const defaults = presets.find(entry => entry.name === DEFAULT_PRESET)
	const names = [...new Set(serverNames)].sort((left, right) => left.localeCompare(right))
	const servers: string[] = []
	for (const name of names) {
		const row = preset?.rows[name]
		const state = row === undefined || row === 'inherit' ? defaultState(defaults, name) : row
		if (state === 'on') servers.push(name)
	}
	return {
		source: assigned.path === null ? 'default' : 'folder',
		path: assigned.path,
		preset: assigned.preset,
		servers,
	}
}
