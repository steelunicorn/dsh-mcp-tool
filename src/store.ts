/**
 * Durable registry: MCP servers, presets, folder assignments and global settings.
 *
 * State lives in one human-readable JSON document owned by DSH's storage
 * domain facility (`$DSH_HOME/storages/mcp_tool.json`), which gives atomic
 * writes, schema validation on open, and in-memory reads.
 *
 * The model mirrors how the GUI is organised:
 * - a **server** is registered globally and carries a load mode (`eager` keeps
 *   it running, `lazy` starts it on demand);
 * - a **preset** decides which servers are on, off, or inherited from the
 *   `default` preset;
 * - a **folder assignment** points one folder (or a subtree) at a preset.
 *
 * @module dsh-mcp-tool/store
 */

import { z } from 'zod'
import { DEFAULT_PRESET, canonicalPath, resolveAllowed, type FolderRecord, type PresetRecord, type Resolution } from './policy.js'

/** Server names double as the MCP tool namespace, so the host's pattern applies. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/

/** How a server is brought up. */
export type LoadMode = 'lazy' | 'eager'

/** Position of one server inside a preset. */
export type PresetState = 'on' | 'off' | 'inherit'

/** Who owns a server definition. */
export type ServerOrigin = 'manual' | 'profile'

/** One tool as the last successful scan saw it. */
export interface CatalogTool {
	name: string
	description?: string
	parameters?: unknown
}

/**
 * The last known tool list of one server.
 *
 * Scanning needs a running connection, so the result is cached with the
 * server record: the agent can still discover what a stopped server offers,
 * and a restart of the host does not lose the catalog.
 */
export interface ServerCatalog {
	tools: CatalogTool[]
	updatedAt: number
}

/** One globally registered MCP server. */
export interface ServerRecord {
	name: string
	description?: string
	transport: 'stdio' | 'http'
	command?: string
	args?: string[]
	env?: Record<string, string>
	cwd?: string
	url?: string
	headers?: Record<string, string>
	toolCallTimeoutMs?: number
	startupTimeoutMs?: number
	/** `eager` keeps the process alive; `lazy` (default) starts it on demand. */
	loadMode?: LoadMode
	/**
	 * `manual` servers are started by this plugin. `profile` servers are
	 * mirrored from the DSH MCP settings: the DSH manager starts them, and the
	 * plugin only decides where their tools are visible.
	 */
	origin?: ServerOrigin
	/**
	 * The `enabled` flag the DSH MCP settings carry for a mirrored server. A
	 * server that is off there is never started by the manager, so this plugin
	 * may switch it on for the duration of one folder's work and off again.
	 */
	profileEnabled?: boolean
	/** Tool list cached by the last successful scan. */
	catalog?: ServerCatalog
}

/** One server as the DSH MCP settings describe it. */
export interface ProfileServer {
	name: string
	transport: 'stdio' | 'http'
	command?: string
	args?: string[]
	env?: Record<string, string>
	cwd?: string
	url?: string
	headers?: Record<string, string>
	toolCallTimeoutMs?: number
	startupTimeoutMs?: number
	/** Whether the DSH MCP settings run this server from the start. */
	enabled?: boolean
}

/**
 * Who owns the lifetime of a server that comes from the DSH MCP settings.
 *
 * `flip` switches the manager entry on and off through the config editor, so
 * the manager keeps owning the process. `mount` starts a private instance of
 * the official client inside an own scope instead: the manager entry is
 * switched off while the plugin holds the process. `auto` picks per server:
 * `mount` for an entry that is already enabled (its name is taken in the root
 * scope, so it cannot be registered twice) and `flip` for a disabled one.
 */
export type ProfileLifecycle = 'auto' | 'flip' | 'mount'

/** Global plugin settings. */
export interface SettingsRecord {
	/** Whether the composer chip is offered at all. */
	showChip: boolean
	/** How mirrored servers are started and stopped. */
	profileLifecycle: ProfileLifecycle
}

export type { FolderRecord, PresetRecord, Resolution }

const stringMap = z.record(z.string(), z.string())

const catalogToolSchema = z.object({
	name: z.string().min(1),
	description: z.string().optional(),
	parameters: z.unknown().optional(),
}).strict()

const catalogSchema = z.object({
	tools: z.array(catalogToolSchema),
	updatedAt: z.number(),
}).strict()

const serverSchema = z.object({
	name: z.string().regex(SERVER_NAME),
	description: z.string().optional(),
	transport: z.enum(['stdio', 'http']),
	command: z.string().optional(),
	args: z.array(z.string()).optional(),
	env: stringMap.optional(),
	cwd: z.string().optional(),
	url: z.string().optional(),
	headers: stringMap.optional(),
	toolCallTimeoutMs: z.number().optional(),
	startupTimeoutMs: z.number().optional(),
	loadMode: z.enum(['lazy', 'eager']).optional(),
	origin: z.enum(['manual', 'profile']).optional(),
	profileEnabled: z.boolean().optional(),
	catalog: catalogSchema.optional(),
}).strict()

const presetSchema = z.object({
	name: z.string().min(1),
	rows: z.record(z.string(), z.enum(['on', 'off', 'inherit'])),
	updatedAt: z.number().optional(),
}).strict()

/**
 * Folder assignments.
 *
 * Records written by the first release carried `servers` instead of `preset`.
 * They are accepted by the schema and purged on open, which is the agreed
 * reset: every folder keeps the `default` preset until it is assigned one.
 */
const folderSchema = z.object({
	path: z.string().min(1),
	preset: z.string().optional(),
	servers: z.array(z.string()).optional(),
	title: z.string().optional(),
	updatedAt: z.number().optional(),
}).strict()

const globalSchema = z.object({
	showChip: z.boolean().optional(),
	profileLifecycle: z.enum(['auto', 'flip', 'mount', 'manager', 'own']).optional(),
	/** Left over from the first release; ignored and rewritten on save. */
	defaultServers: z.array(z.string()).optional(),
}).strict()

/**
 * Reads a stored lifecycle value.
 *
 * Earlier builds shipped `manager` and `own`; they are mapped onto the current
 * names so an upgrade keeps the user's choice instead of resetting it.
 */
function parseLifecycle(value: unknown): ProfileLifecycle {
	if (value === 'auto' || value === 'flip' || value === 'mount') return value
	if (value === 'manager') return 'flip'
	if (value === 'own') return 'mount'
	return 'auto'
}

/** The domain declaration handed to `ctx.storageDomain.open()`.
 *
 * The domain name doubles as the backend unit name and must match
 * `UNIT_NAME_RE` (safe both as a file name and as a SQL identifier segment),
 * which rejects the hyphen of the plugin id.
 */
export const domainSpec = {
	name: 'mcp_tool',
	version: 1,
	layout: 'single',
	global: { schema: globalSchema, initial: { showChip: true, profileLifecycle: 'auto' } },
	tables: {
		servers: { valueSchema: serverSchema },
		presets: { valueSchema: presetSchema },
		workspaces: { valueSchema: folderSchema },
	},
} as const

/** Minimal structural view of one storage-domain table. */
export interface KvTableLike<V> {
	get(key: string): V | undefined
	entries(): IterableIterator<[string, V]>
	keys(): IterableIterator<string>
	readonly size: number
	put(key: string, value: V): Promise<void>
	delete(key: string): Promise<boolean>
}

/** Minimal structural view of an opened domain. */
export interface DomainLike {
	global: { get(): unknown; set(value: unknown): Promise<void> }
	table(name: string): KvTableLike<never>
	close(): Promise<void>
}

/** Minimal structural view of `ctx.storageDomain`. */
export interface StorageDomainLike {
	open(spec: unknown): Promise<DomainLike>
}

/** Validates one record before it is written. */
export function parseServer(value: unknown): ServerRecord {
	return serverSchema.parse(value) as ServerRecord
}

/** Validates one preset before it is written. */
export function parsePreset(value: unknown): PresetRecord {
	return presetSchema.parse(value) as PresetRecord
}

/** Validates one folder assignment before it is written. */
export function parseFolder(value: unknown): FolderRecord {
	return folderSchema.parse(value) as FolderRecord
}

/** Registry facade over the opened domain. */
export class Store {
	private readonly serverTable: KvTableLike<ServerRecord>
	private readonly presetTable: KvTableLike<PresetRecord>
	private readonly folderTable: KvTableLike<FolderRecord>

	constructor(private readonly domain: DomainLike) {
		this.serverTable = domain.table('servers') as unknown as KvTableLike<ServerRecord>
		this.presetTable = domain.table('presets') as unknown as KvTableLike<PresetRecord>
		this.folderTable = domain.table('workspaces') as unknown as KvTableLike<FolderRecord>
	}

	/** Opens the durable domain, dropping records of the pre-preset release. */
	static async open(storageDomain: StorageDomainLike): Promise<Store> {
		const store = new Store(await storageDomain.open(domainSpec))
		for (const folder of store.rawFolders()) {
			if (folder.preset === undefined) await store.folderTable.delete(folder.path)
		}
		return store
	}

	// -- servers ------------------------------------------------------------

	/** Every registered server, ordered by name. */
	servers(): ServerRecord[] {
		return [...this.serverTable.entries()]
			.map(([, record]) => record)
			.sort((left, right) => left.name.localeCompare(right.name))
	}

	/** One registered server. */
	server(name: string): ServerRecord | undefined {
		return this.serverTable.get(name)
	}

	/** Creates or replaces one server. */
	async putServer(record: ServerRecord): Promise<void> {
		await this.serverTable.put(record.name, parseServer(record))
	}

	/** Removes one server and forgets it in every preset. */
	async deleteServer(name: string): Promise<void> {
		if (!(await this.serverTable.delete(name))) return
		await this.forgetInPresets(name)
	}

	/** Tool list cached by the last scan, or an empty list. */
	catalog(name: string): CatalogTool[] {
		return this.server(name)?.catalog?.tools ?? []
	}

	/** When the cached tool list was last refreshed, if ever. */
	catalogAt(name: string): number | undefined {
		return this.server(name)?.catalog?.updatedAt
	}

	/**
	 * Caches one server's tool list.
	 *
	 * The write is skipped when the list is unchanged, so a scan on every page
	 * load does not rewrite the document. A record that disappeared meanwhile
	 * is ignored: the registry decides which servers exist.
	 */
	async putCatalog(name: string, tools: readonly CatalogTool[], now = Date.now()): Promise<boolean> {
		const record = this.server(name)
		if (record === undefined) return false
		const cleaned = tools.map(tool => {
			const entry: CatalogTool = { name: tool.name }
			if (tool.description !== undefined) entry.description = tool.description
			if (tool.parameters !== undefined) entry.parameters = tool.parameters
			return entry
		})
		if (JSON.stringify(cleaned) === JSON.stringify(record.catalog?.tools ?? [])) return false
		await this.serverTable.put(name, parseServer({ ...record, catalog: { tools: cleaned, updatedAt: now } }))
		return true
	}

	/**
	 * Mirrors the servers configured in the DSH MCP settings into the registry.
	 *
	 * The mirror is one-way and never touches manual entries: a configured
	 * server appears as `origin: 'profile'` with the connection fields the DSH
	 * manager owns, and a server removed from the settings disappears here.
	 * A newly imported server is switched **off** in the `default` preset, so
	 * it stays invisible until the user enables it in a preset.
	 */
	async importProfile(entries: readonly ProfileServer[]): Promise<{
		added: string[]
		updated: string[]
		removed: string[]
	}> {
		const wanted = new Map(entries.map(entry => [entry.name, entry]))
		const removed: string[] = []
		for (const record of this.servers()) {
			if (record.origin !== 'profile' || wanted.has(record.name)) continue
			await this.serverTable.delete(record.name)
			await this.forgetInPresets(record.name)
			removed.push(record.name)
		}
		const added: string[] = []
		const updated: string[] = []
		for (const [name, entry] of wanted) {
			const existing = this.server(name)
			// `enabled` is the settings' own field: it is stored as
			// `profileEnabled` and must not reach the strict record schema.
			const { enabled, ...rest } = entry
			const next: ServerRecord = { ...rest, name, origin: 'profile', profileEnabled: enabled ?? true }
			if (existing?.description !== undefined) next.description = existing.description
			if (existing?.loadMode !== undefined) next.loadMode = existing.loadMode
			if (existing?.catalog !== undefined) next.catalog = existing.catalog
			await this.serverTable.put(name, parseServer(next))
			if (existing === undefined) {
				added.push(name)
				await this.switchOff(name)
			} else {
				updated.push(name)
			}
		}
		return { added, updated, removed }
	}

	/** Drops one server name from every preset. */
	private async forgetInPresets(name: string): Promise<void> {
		for (const preset of this.presets()) {
			if (!(name in preset.rows)) continue
			const rows = { ...preset.rows }
			delete rows[name]
			await this.putPreset({ ...preset, rows, updatedAt: Date.now() })
		}
	}

	/** Switches one server off in the `default` preset. */
	private async switchOff(name: string): Promise<void> {
		const preset = this.defaultPreset()
		if (preset.rows[name] === 'off') return
		await this.putPreset({ ...preset, rows: { ...preset.rows, [name]: 'off' } })
	}

	// -- presets ------------------------------------------------------------

	/** Every preset, `default` first, then by name. */
	presets(): PresetRecord[] {
		return [...this.presetTable.entries()]
			.map(([, record]) => record)
			.sort((left, right) => {
				if (left.name === DEFAULT_PRESET) return -1
				if (right.name === DEFAULT_PRESET) return 1
				return left.name.localeCompare(right.name)
			})
	}

	/** One preset by name; the `default` preset always exists. */
	preset(name: string): PresetRecord | undefined {
		const stored = this.presetTable.get(name)
		if (stored !== undefined) return stored
		return name === DEFAULT_PRESET ? { name: DEFAULT_PRESET, rows: {} } : undefined
	}

	/** The `default` preset, materialised even when never edited. */
	defaultPreset(): PresetRecord {
		return this.preset(DEFAULT_PRESET) as PresetRecord
	}

	/** Creates or replaces one preset. `inherit` is meaningless in `default`. */
	async putPreset(preset: PresetRecord): Promise<void> {
		const rows: Record<string, PresetState> = {}
		for (const [server, state] of Object.entries(preset.rows)) {
			if (!SERVER_NAME.test(server)) continue
			rows[server] = preset.name === DEFAULT_PRESET && state === 'inherit' ? 'on' : state
		}
		const name = preset.name.trim()
		if (name === '') throw new Error('a preset needs a name')
		await this.presetTable.put(name, parsePreset({ name, rows, updatedAt: Date.now() }))
	}

	/** Removes one preset; `default` is not removable and folders fall back. */
	async deletePreset(name: string): Promise<boolean> {
		if (name === DEFAULT_PRESET) throw new Error('the default preset cannot be removed')
		const removed = await this.presetTable.delete(name)
		if (!removed) return false
		for (const folder of this.folders()) {
			if (folder.preset === name) await this.folderTable.delete(folder.path)
		}
		return true
	}

	// -- folder assignments -------------------------------------------------

	private rawFolders(): FolderRecord[] {
		return [...this.folderTable.entries()]
			.map(([, record]) => record)
			.sort((left, right) => left.path.localeCompare(right.path))
	}

	/** Every folder assignment, ordered by path. */
	folders(): FolderRecord[] {
		return this.rawFolders().filter(folder => folder.preset !== undefined)
	}

	/** The assignment stored for exactly this path. */
	folder(path: string): FolderRecord | undefined {
		const found = this.folderTable.get(canonicalPath(path))
		return found?.preset === undefined ? undefined : found
	}

	/** Assigns a preset to a folder; `default` clears the assignment. */
	async putFolder(path: string, preset: string): Promise<void> {
		const key = canonicalPath(path)
		if (preset === DEFAULT_PRESET || preset === '') {
			await this.folderTable.delete(key)
			return
		}
		await this.folderTable.put(key, parseFolder({ path: key, preset, updatedAt: Date.now() }))
	}

	/** Clears one folder assignment. */
	async deleteFolder(path: string): Promise<boolean> {
		return this.folderTable.delete(canonicalPath(path))
	}

	// -- settings -----------------------------------------------------------

	/** Current global settings. */
	settings(): SettingsRecord {
		const raw = this.domain.global.get() as { showChip?: unknown; profileLifecycle?: unknown } | undefined
		return {
			showChip: typeof raw?.showChip === 'boolean' ? raw.showChip : true,
			profileLifecycle: parseLifecycle(raw?.profileLifecycle),
		}
	}

	/** Replaces global settings. */
	async setSettings(next: SettingsRecord): Promise<void> {
		await this.domain.global.set({
			showChip: next.showChip === true,
			profileLifecycle: next.profileLifecycle,
		})
	}

	// -- resolution ---------------------------------------------------------

	/**
	 * The effective allowlist for a folder: the nearest assigned preset, its
	 * `on`/`off`/`inherit` rows resolved against the `default` preset.
	 */
	resolve(cwd: string): Resolution {
		return resolveAllowed(cwd, this.folders(), this.presets(), this.servers().map(server => server.name))
	}

	/** Releases the domain handle. */
	async close(): Promise<void> {
		await this.domain.close()
	}
}
