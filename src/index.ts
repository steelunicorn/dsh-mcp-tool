/**
 * Host plugin entry point.
 *
 * Wires the durable registry, the runtime pool, the three model-facing tools,
 * the prompt section and the GUI routes to the DSH services.
 *
 * @module dsh-mcp-tool
 */

import { appendFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import {
	catalogPort,
	configuredServers,
	managerPort,
	serverOfTool,
	toolPrefix,
	toolsOf,
	workingDirectoryOf,
	type AgentLike,
	type ConfigEditorLike,
	type ConnectionLike,
	type Disposer,
	type HostContext,
	type LoaderLike,
	type ToolSchemaLike,
} from './host.js'
import { registerRoutes, type GuiBackend, type WorkspaceInfo } from './http.js'
import type { Resolution } from './policy.js'
import {
	hybridProfile,
	managerProfile,
	mountProfile,
	type MountedProfileRuntime,
	type MountedTool,
	type MountOpener,
	type MountSession,
	type ProfileRuntime,
} from './profile.js'
import { ActivationError } from './runtime.js'
import { promptText, SECTION_NAME, SECTION_ORDER } from './prompt.js'
import { McpRuntime } from './runtime.js'
import { Store, type ProfileServer, type ServerRecord, type StorageDomainLike } from './store.js'
import { registerTools, specOf, type ToolDefinition } from './tools.js'

/** The prompt service slice this plugin uses. */
interface PromptServiceLike {
	section(section: {
		name: string
		order: number
		text: (context: { agent?: AgentLike }) => string
	}): Disposer
}

/** The web server slice this plugin uses. */
interface WebServerLike {
	register(route: {
		kind: 'prefix'
		path: string
		handler: (req: never, res: never) => void | Promise<void>
	}): Disposer
}

/** The workspace registry slice this plugin uses. */
interface WorkspaceRegistryLike {
	list(): Array<{ path: string; title?: string }>
}

/** The host context plus the services this plugin adds to the mirror. */
export interface PluginContext extends HostContext {
	/** One host service by name, without waiting for it to appear. */
	get?(name: string): unknown
	storageDomain: StorageDomainLike
	systemPrompt: PromptServiceLike
	webServer: WebServerLike
	on(event: string, listener: (...args: any[]) => unknown): Disposer
}

export const name = 'dsh-mcp-tool'

export const inject = ['mcpManager', 'tools', 'agents', 'workingDirectory', 'storageDomain', 'webServer', 'systemPrompt']

/** Idle window after which a forgotten lazy server is stopped. */
const IDLE_MS = 10 * 60 * 1000

/** Upper bound of concurrent lazy MCP processes kept alive from this plugin. */
const MAX_LIVE = 3

/** How often the pool looks for forgotten servers. */
const SWEEP_MS = 30 * 1000

/** Whether diagnostics are on (`MCPTOOL_DEBUG=1`), which also exposes the
 * takeover experiment route. */
const debugEnabled = process.env.MCPTOOL_DEBUG === '1' || process.env.MCPTOOL_DEBUG === 'true'

const debug = (message: string): void => {
	if (!debugEnabled) return
	console.error(`[dsh-mcp-tool] ${message}`)
	const logPath = process.env.MCPTOOL_LOG
	if (logPath !== undefined && logPath !== '') {
		try {
			appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`)
		} catch {
			// Diagnostics must never break the plugin.
		}
	}
}

export function apply(ctx: PluginContext): void {
	let store: Store | undefined
	let storeError: string | undefined

	/** The workspace registry is optional: the folder list only needs it when present.
	 *
	 * Read through `ctx.get()` on purpose: a plain property access throws for a
	 * service that is not declared in `inject`, and declaring it would stall the
	 * plugin in profiles that have no web application at all.
	 */
	const workspaces = (): WorkspaceInfo[] => {
		let registry: WorkspaceRegistryLike | undefined
		try {
			const host = ctx as unknown as {
				get?: (name: string) => unknown
				workspaceRegistry?: WorkspaceRegistryLike
			}
			const viaGet = typeof host.get === 'function' ? host.get('workspaceRegistry') : undefined
			// The property is the fallback for hosts without `get()` (test doubles);
			// on a real host it throws when the service is absent and gets caught.
			registry = (viaGet ?? host.workspaceRegistry) as WorkspaceRegistryLike | undefined
		} catch (error) {
			debug(`workspace registry is not available: ${String(error)}`)
			registry = undefined
		}
		if (registry === undefined) return []
		try {
			return registry.list().map(workspace => ({
				path: workspace.path,
				...(workspace.title === undefined ? {} : { title: workspace.title }),
			}))
		} catch (error) {
			debug(`workspace list failed: ${String(error)}`)
			return []
		}
	}

	const catalog = catalogPort(ctx)

	const runtime = new McpRuntime({
		manager: managerPort(ctx.mcpManager),
		catalog,
		idleMs: IDLE_MS,
		maxLive: MAX_LIVE,
		// Tools of an eager server are visible without loading it first.
		visibleTo: (agentId, server) => {
			const opened = store
			if (opened === undefined) return false
			const agent = agentOf(agentId)
			if (agent === undefined) return false
			return opened.resolve(workingDirectoryOf(ctx, agent)).servers.includes(server)
		},
		log: debug,
	})

	const cwdOf = (agentId: string): string => {
		const agent = ctx.agents.get(agentId)
		if (agent === undefined) return ''
		// Tracking is idempotent; a session created before the plugin loaded
		// starts being tracked on its first tool step.
		runtime.trackAgent(agent.id)
		return workingDirectoryOf(ctx, agent)
	}

	const policyFor = (_agentId: string, cwd: string): Resolution => {
		const opened = store
		if (opened !== undefined) return opened.resolve(cwd)
		return { source: 'default', path: null, preset: 'default', servers: [] }
	}

	const allowedNames = (cwd: string): string[] => policyFor('', cwd).servers

	/**
	 * Finds the agent owning a session.
	 *
	 * `agents.get` is the fast path; the scan covers a session whose agent id and
	 * session id disagree, which the GUI (it only knows the session id) cannot
	 * tell apart.
	 */
	function agentOf(sessionId: string): AgentLike | undefined {
		const direct = ctx.agents.get(sessionId)
		if (direct !== undefined) return direct
		try {
			return ctx.agents.list().find(agent => agent.id === sessionId || agent.session?.id === sessionId)
		} catch {
			return undefined
		}
	}

	/**
	 * Mirrors the servers configured in the DSH MCP settings.
	 *
	 * The mirror is one-way: the plugin never writes the profile. A configured
	 * server is started by the DSH manager, so the plugin only tracks which
	 * folder preset may see its tools; a server dropped from the settings is
	 * dropped here too.
	 */
	const syncProfile = async (): Promise<void> => {
		const opened = store
		if (opened === undefined) return
		const configured = configuredServers(ctx.mcpManager)
		if (configured === undefined) return
		const entries: ProfileServer[] = configured.map(({ name, entry }) => {
			const record: ProfileServer = { name, transport: entry.transport === 'stdio' ? 'stdio' : 'http' }
			if (record.transport === 'stdio') {
				if (entry.command !== undefined && entry.command !== '') record.command = entry.command
				if (entry.args !== undefined) record.args = [...entry.args]
				if (entry.env !== undefined) record.env = { ...entry.env }
				if (entry.cwd !== undefined && entry.cwd !== '') record.cwd = entry.cwd
			} else {
				if (entry.url !== undefined && entry.url !== '') record.url = entry.url
				if (entry.headers !== undefined) record.headers = { ...entry.headers }
			}
			if (entry.toolCallTimeoutMs !== undefined) record.toolCallTimeoutMs = entry.toolCallTimeoutMs
			if (entry.startupTimeoutMs !== undefined) record.startupTimeoutMs = entry.startupTimeoutMs
			// The settings own the process: a switched-off entry has none, and
			// only such a server may be started by the plugin on demand.
			record.enabled = entry.enabled !== false
			return record
		})
		try {
			const result = await opened.importProfile(entries)
			runtime.setAdopted(opened.servers().filter(record => record.origin === 'profile').map(record => record.name))
			if (result.added.length > 0 || result.removed.length > 0) {
				debug(`profile sync: added [${result.added.join(',')}] removed [${result.removed.join(',')}]`)
			}
		} catch (error) {
			debug(`profile sync failed: ${error instanceof Error ? error.message : String(error)}`)
		}
		await syncEager()
	}

	/**
	 * Keeps eager servers running wherever they are switched on, and unpins a
	 * server whose load mode was switched back to lazy.
	 */
	const syncEager = async (): Promise<void> => {
		const opened = store
		if (opened === undefined) return
		const records = opened.servers().filter(record => record.loadMode === 'eager' && record.origin !== 'profile')
		for (const record of opened.servers()) {
			if (record.loadMode !== 'eager' && runtime.isEager(record.name)) {
				debug(`unpinning ${record.name}`)
				runtime.unpinEager(record.name)
			}
		}
		if (records.length === 0) {
			runtime.refreshVisibility()
			return
		}
		let agents: AgentLike[] = []
		try {
			agents = ctx.agents.list()
		} catch (error) {
			debug(`agent list failed: ${String(error)}`)
		}
		for (const agent of agents) {
			const cwd = workingDirectoryOf(ctx, agent)
			const allowed = new Set(opened.resolve(cwd).servers)
			for (const record of records) {
				if (!allowed.has(record.name) || runtime.isEager(record.name)) continue
				debug(`eager start ${record.name} for ${agent.id} (${cwd})`)
				try {
					await runtime.loadEager(specOf(record))
				} catch (error) {
					debug(`eager start ${record.name} failed: ${error instanceof Error ? error.message : String(error)}`)
				}
			}
		}
		runtime.refreshVisibility()
	}

	const track = (agent: AgentLike): void => {
		runtime.trackAgent(agent.id)
		void syncEager()
	}

	/**
	 * Refreshes the cached tool list of every server.
	 *
	 * A scan needs a live registration, so this only records what is already
	 * known: servers this plugin runs and servers the DSH manager runs. The
	 * cache is what lets a stopped server still be described, and what makes
	 * discovery survive a release or a host restart.
	 */
	const syncCatalog = async (): Promise<void> => {
		const opened = store
		if (opened === undefined) return
		for (const record of opened.servers()) {
			// A profile server's tools are published by the official client in the
			// global catalog, so they are read there; our pool owns the rest.
			const tools = record.origin === 'profile'
				? toolsOf(ctx.tools, record.name)
				: runtime.catalogTools(record.name)
			if (tools.length === 0) continue
			try {
				if (await opened.putCatalog(record.name, tools)) debug(`catalog of ${record.name}: ${tools.length} tool(s)`)
			} catch (error) {
				debug(`catalog of ${record.name} failed: ${error instanceof Error ? error.message : String(error)}`)
			}
		}
	}

	const disposers: Disposer[] = []

	ctx.effect?.(() => {
		const offCreated = ctx.on('agent/created', (payload: { agent?: AgentLike }) => {
			if (payload?.agent !== undefined) track(payload.agent)
		})
		disposers.push(offCreated)
		return () => {
			for (const dispose of disposers.splice(0)) dispose()
		}
	}, 'mcp-tool: agent tracking')

	// Sessions that already exist when the plugin is mounted.
	void Promise.resolve().then(() => {
		try {
			for (const agent of ctx.agents.list()) {
				runtime.trackAgent(agent.id)
			}
		} catch (error) {
			debug(`initial agent scan failed: ${String(error)}`)
		}
	})

	ctx.on('agent/disposed', (payload: { agent?: AgentLike }) => {
		if (payload?.agent !== undefined) runtime.untrackAgent(payload.agent.id)
	})

	// Real tool usage resets the idle window and must not be stopped mid-call.
	ctx.on('tools/pre-execute', async (exec: { name: string }, next: () => Promise<unknown>) => {
		const server = serverOfTool(exec.name)
		if (server === undefined) return next()
		runtime.beginCall(server)
		if (profileRuntime?.started(server) === true) profileTouched.set(server, Date.now())
		try {
			return await next()
		} finally {
			runtime.endCall(server)
		}
	})

	// A second line of defence: a tool that is already in the model's tool list
	// but whose server was switched off in this folder must still be refused.
	// `restrict({ deny })` only shapes the list, it does not stop a call.
	ctx.effect(() => {
		if (typeof ctx.tools.guard !== 'function') {
			debug('tools.guard is not available on this host')
			return
		}
		return ctx.tools.guard((execution) => {
			const server = serverOfTool(execution.name)
			if (server === undefined) return undefined
			const opened = store
			const agentId = execution.agent?.id
			if (opened === undefined || agentId === undefined) return undefined
			const record = opened.server(server)
			// Unknown servers belong to other plugins: leave them alone.
			if (record === undefined) return undefined
			const allowed = opened.resolve(cwdOf(agentId)).servers
			if (allowed.includes(server)) return undefined
			return `server "${server}" is not enabled in this folder; switch it on in Settings > MCP Tool before calling its tools`
		})
	}, 'mcp-tool: execution guard')

	const timer = setInterval(() => {
		const stopped = runtime.sweep()
		if (stopped.length > 0) debug(`idle sweep stopped: ${stopped.join(', ')}`)
		stopIdleProfiles()
	}, SWEEP_MS)
	// The timer must not keep the process alive on its own.
	;(timer as unknown as { unref?: () => void }).unref?.()

	/** The config editor, read through `ctx.get()` for the same reason as the
	 * workspace registry: direct access to an undeclared service throws. */
	const configEditor = (): ConfigEditorLike | undefined => {
		try {
			const host = ctx as unknown as { get?: (name: string) => unknown }
			return (typeof host.get === 'function' ? host.get('configEditor') : undefined) as ConfigEditorLike | undefined
		} catch (error) {
			debug(`config editor is not available: ${String(error)}`)
			return undefined
		}
	}

	/** The host's connection service, the authority behind the route fence. */
	const connectionOf = (): ConnectionLike | undefined => {
		try {
			const host = ctx as unknown as { get?: (name: string) => unknown }
			return (typeof host.get === 'function' ? host.get('connection') : undefined) as ConnectionLike | undefined
		} catch (error) {
			debug(`connection service is not available: ${String(error)}`)
			return undefined
		}
	}

	/**
	 * Flips `enabled` on one server of the DSH MCP settings.
	 *
	 * This is the sanctioned path for the takeover experiment: the write goes
	 * through the host's config editor (schema validation, the right layer,
	 * a formatted patch) instead of editing `cordis.patch.yml` by hand, and
	 * `servers` is a volatile field of the manager, so the manager applies the
	 * change without restarting its own fiber.
	 */
	const setProfileEnabled = async (server: string, enabled: boolean): Promise<void> => {
		const editor = configEditor()
		if (editor === undefined) throw new Error('the config editor is not available in this host')
		const entry = editor.entries().find(row => row.options.id === 'mcp-manager' || row.options.name === '@deepseek-ai/dsh-mcp-manager')
		if (entry === undefined) throw new Error('the DSH MCP manager is not part of this profile')
		await editor.edit(entry, (raw) => {
			const servers = raw['servers']
			const table = typeof servers === 'object' && servers !== null && !Array.isArray(servers)
				? servers as Record<string, Record<string, unknown>>
				: {}
			const current = table[server]
			if (current === undefined) throw new Error(`server "${server}" is not configured in the DSH MCP settings`)
			return { ...raw, servers: { ...table, [server]: { ...current, enabled } } }
		})
		debug(`profile server ${server}: enabled=${String(enabled)}`)
	}

	/**
	 * Lifetime owner of the mirrored servers, created on first use because it
	 * needs the opened store. `flip` lets the DSH manager own the process,
	 * `mount` starts a private client instance, `auto` picks per server.
	 */
	let profileRuntime: MountedProfileRuntime | undefined
	/** Last time a tool of a profile server the plugin started was called. */
	const profileTouched = new Map<string, number>()
	/** Tools projected from a private mount into each live agent's tool list. */
	const projections = new Map<string, Map<string, Disposer>>()

	/** The loader service, when the host offers one. */
	const loaderOf = (): LoaderLike | undefined => {
		try {
			const loader = ctx.get?.('loader')
			if (loader === undefined || loader === null) return undefined
			return loader as LoaderLike
		} catch {
			return undefined
		}
	}

	/** The module shape `@deepseek-ai/dsh-scope` exposes to a plugin. */
	interface ScopeModule {
		createScope(context: unknown, key: unknown): {
			ctx: { plugin(module: unknown, config?: unknown): unknown }
			dispose(): Promise<void>
		}
	}

	/** The module shape `@deepseek-ai/dsh-mcp-client` exposes to a plugin. */
	interface McpClientModule {
		apply: unknown
		inject: unknown
		name: string
		Config?: unknown
	}

	const mountOpener: MountOpener = {
		async open(server: string): Promise<MountSession> {
			const opened = store
			const record = opened?.server(server)
			if (record === undefined) throw new ActivationError(`unknown MCP server "${server}"`, server, 'unknown')
			const loader = loaderOf()
			if (loader === undefined) {
				throw new ActivationError('the loader service is not available in this host', server, 'failed')
			}
			const scopeModule = (await loader.import('@deepseek-ai/dsh-scope')) as ScopeModule
			const client = (await loader.import('@deepseek-ai/dsh-mcp-client')) as McpClientModule
			const scopeKey: Record<string, unknown> = { dshMcpToolMount: true, server }
			const scoped = scopeModule.createScope(ctx, scopeKey)
			const config: Record<string, unknown> = {
				serverName: server,
				transport: record.transport === 'http' ? 'streamable-http' : 'stdio',
			}
			if (record.transport === 'http') {
				config.url = record.url ?? ''
				config.headers = record.headers ?? {}
			} else {
				config.command = record.command ?? ''
				config.args = record.args ?? []
				config.env = record.env ?? {}
				if (record.cwd !== undefined) config.cwd = record.cwd
			}
			if (record.toolCallTimeoutMs !== undefined) config.toolCallTimeoutMs = record.toolCallTimeoutMs
			scoped.ctx.plugin(
				{ apply: client.apply, inject: client.inject, name: client.name, Config: client.Config },
				config,
			)
			debug(`mounted private client for ${server}`)
			const tools = (): MountedTool[] => {
				try {
					const schemas: readonly ToolSchemaLike[] = ctx.tools.schemas?.(scopeKey) ?? []
					return schemas
						.filter(schema => schema.name.startsWith(toolPrefix(server)))
						.map(schema => ({
							name: schema.name,
							...(schema.description === undefined ? {} : { description: schema.description }),
							...(schema.parameters === undefined ? {} : { parameters: schema.parameters }),
							...(ctx.tools.get?.(schema.name, scopeKey) === undefined
								? {}
								: { definition: ctx.tools.get?.(schema.name, scopeKey) }),
						}))
				} catch (error) {
					debug(`scoped tool list of ${server} failed: ${error instanceof Error ? error.message : String(error)}`)
					return []
				}
			}
			return {
				tools,
				async dispose(): Promise<void> {
					await scoped.dispose()
					debug(`disposed private client for ${server}`)
				},
			}
		},
	}

	const profileOf = (): MountedProfileRuntime | undefined => {
		if (profileRuntime !== undefined) return profileRuntime
		const opened = store
		if (opened === undefined) return undefined
		const control = {
			setEnabled: setProfileEnabled,
			current: (server: string) => opened.server(server)?.profileEnabled,
		}
		const flip = managerProfile(control, managerPort(ctx.mcpManager), catalog)
		const mount = mountProfile(mountOpener, control)
		const lifecycle = opened.settings().profileLifecycle
		const empty: MountedProfileRuntime = { ...flip, tools: () => [] }
		if (lifecycle === 'flip') {
			profileRuntime = empty
		} else if (lifecycle === 'mount') {
			profileRuntime = mount
		} else {
			// An entry the settings keep enabled already took the name in the
			// root scope, so it can only be used through a private mount.
			profileRuntime = hybridProfile(flip, mount, server => opened.server(server)?.profileEnabled !== false)
		}
		return profileRuntime
	}

	/**
	 * Projects the tools of privately mounted servers into the live agents.
	 *
	 * A mounted client publishes its tools inside its own scope; agents do not
	 * inherit that scope, so the tools are registered into each agent's tool
	 * list, and only for folders whose preset allows the server.
	 */
	const projectMounted = (): void => {
		const profile = profileRuntime
		const opened = store
		if (profile === undefined || opened === undefined) return
		let agents: AgentLike[] = []
		try {
			agents = ctx.agents.list()
		} catch {
			return
		}
		const live = new Set(agents.map(agent => agent.id))
		for (const id of [...projections.keys()]) {
			if (!live.has(id)) projections.delete(id)
		}
		for (const agent of agents) {
			const allowed = new Set(opened.resolve(workingDirectoryOf(ctx, agent)).servers)
			const want = new Map<string, unknown>()
			for (const record of opened.servers()) {
				if (record.origin !== 'profile' || !allowed.has(record.name)) continue
				if (!profile.started(record.name)) continue
				for (const tool of profile.tools(record.name)) {
					if (tool.definition !== undefined) want.set(tool.name, tool.definition)
				}
			}
			const have = projections.get(agent.id) ?? new Map<string, Disposer>()
			for (const [name, dispose] of [...have]) {
				if (want.has(name)) continue
				dispose()
				have.delete(name)
			}
			for (const [name, definition] of want) {
				if (have.has(name)) continue
				try {
					have.set(name, agent.ctx.tools.register(definition as never))
				} catch (error) {
					debug(`projection of ${name} into ${agent.id} failed: ${error instanceof Error ? error.message : String(error)}`)
				}
			}
			projections.set(agent.id, have)
		}
	}

	/** Stops the mirrored servers this plugin started and nobody touched for a while. */
	const stopIdleProfiles = (): void => {
		const profile = profileRuntime
		const opened = store
		if (profile === undefined || opened === undefined) return
		const now = Date.now()
		for (const record of opened.servers()) {
			if (record.origin !== 'profile' || !profile.started(record.name)) continue
			const seen = profileTouched.get(record.name)
			if (seen === undefined) {
				// First sweep after the start: begin the idle window from now.
				profileTouched.set(record.name, now)
				continue
			}
			if (now - seen < IDLE_MS) continue
			profileTouched.delete(record.name)
			debug(`idle stop of profile server ${record.name}`)
			void profile.stop(record.name)
		}
	}

	const backend: GuiBackend = {
		store: () => store,
		storeError: () => storeError,
		requestRejection: (req: { headers: Record<string, string | string[] | undefined> }) => connectionOf()?.requestRejection?.(req),
		live: () => {
			const rows = runtime.snapshot()
			const opened = store
			if (opened === undefined) return rows
			const seen = new Set(rows.map(row => row.name))
			const manager = managerPort(ctx.mcpManager)
			for (const record of opened.servers()) {
				if (record.origin !== 'profile' || seen.has(record.name)) continue
				// An entry the plugin mounted itself is owned by our runtime; the
				// rest are started and stopped by the DSH manager.
				const mounted = (profileRuntime?.tools(record.name).length ?? 0) > 0
				rows.push({
					name: record.name,
					status: mounted ? 'ready' : manager.status(record.name),
					holders: [],
					inFlight: 0,
					lastUsed: 0,
					toolCount: runtime.catalogTools(record.name).length,
					...(manager.detail?.(record.name) === undefined ? {} : { error: manager.detail?.(record.name) as string }),
				})
			}
			return rows
		},
		policyForSession: (_sessionId: string | undefined, cwd: string) => policyFor('', cwd),
		cwdOfSession: (sessionId: string | undefined) => {
			if (sessionId === undefined || sessionId === '') return undefined
			const agent = agentOf(sessionId)
			if (agent === undefined) {
				debug(`no live agent for session ${sessionId}`)
				return undefined
			}
			return workingDirectoryOf(ctx, agent)
		},
		activeSessionId: () => {
			try {
				const agents = ctx.agents.list().filter(agent => {
					const cwd = agent.session?.header?.cwd
					return typeof cwd === 'string' && cwd !== ''
				})
				// The page opens outside a chat; the newest live agent is the
				// closest thing to "the folder the user is looking at".
				const chosen = agents[agents.length - 1]
				debug(`active session fallback: ${chosen?.id ?? 'none'}`)
				return chosen?.id
			} catch {
				return undefined
			}
		},
		workspaces,
		changed: () => {
			// A new mode owns the servers differently, so the old runtime lets go.
			const previous = profileRuntime
			profileRuntime = undefined
			void previous?.dispose()
			void syncProfile().then(() => {
				syncCatalog()
				projectMounted()
			})
		},
		syncProfile: async () => {
			await syncProfile()
			await syncCatalog()
			projectMounted()
		},
		syncCatalog: () => syncCatalog(),
		setProfileEnabled,
		profileOwned: (server: string) => profileRuntime?.started(server) === true,
		async load(sessionId: string, server: string, cwdHint?: string) {
			const agent = agentOf(sessionId)
			const cwd = agent === undefined ? cwdHint ?? '' : workingDirectoryOf(ctx, agent)
			// The holder is the session: it exists even between two agent turns,
			// so a server started from the GUI is not released by accident.
			const holder = agent?.id ?? sessionId
			runtime.trackAgent(holder)
			const allowed = allowedNames(cwd)
			debug(`load ${server} for ${holder} cwd=${cwd} allowed=[${allowed.join(',')}]`)
			const record = store?.server(server)
			if (record === undefined) throw new Error(`unknown MCP server "${server}"`)
			if (record.origin === 'profile') {
				const live = runtime.catalogTools(server)
				if (live.length > 0) return { name: server, tools: live }
				const profile = profileOf()
				// A private mount can use a server the settings keep enabled too:
				// the mount does not touch that entry. Only the manager-backed
				// runtime needs the entry switched off to take the name.
				const mounted = profile !== undefined && profile.tools(server).length > 0
				if (profile === undefined || (record.profileEnabled !== false && !mounted)) {
					throw new Error(`server "${server}" is configured in the DSH MCP settings; edit it there`)
				}
				await profile.start(server, record.startupTimeoutMs ?? 30_000)
				profileTouched.set(server, Date.now())
				projectMounted()
				const tools = profile.tools(server)
				return { name: server, tools: tools.length > 0 ? tools : runtime.catalogTools(server) }
			}
			return runtime.load(specOf(record), holder, allowed)
		},
		release(sessionId: string, server: string) {
			const record = store?.server(server)
			if (record?.origin === 'profile') {
				const profile = profileOf()
				if (profile?.started(server) !== true) return { released: false, stopped: false }
				profileTouched.delete(server)
				void profile.stop(server).then(() => projectMounted(), () => projectMounted())
				return { released: true, stopped: true }
			}
			const released = runtime.holders(server).includes(sessionId)
			const { stopped } = runtime.release(server, sessionId)
			return { released, stopped }
		},
		async exists(path: string) {
			try {
				return (await stat(path)).isDirectory()
			} catch {
				return false
			}
		},
	}

	const routes = registerRoutes(backend, ctx.webServer as never)
	disposers.push(routes)

	ctx.effect(() => {
		let disposed = false
		let toolsDispose: Disposer | undefined
		let promptDispose: Disposer | undefined

		void (async () => {
			try {
				const opened = await Store.open(ctx.storageDomain)
				if (disposed) {
					await opened.close()
					return
				}
				store = opened
				debug('registry opened')
				toolsDispose = registerTools({
					store: opened,
					runtime,
					profile: profileOf(),
					policyFor,
					cwdOf,
					register: (definition: ToolDefinition) => ctx.tools.register(
						definition as never,
						definition.when === undefined ? {} : { when: definition.when as never },
					),
				})
				promptDispose = ctx.systemPrompt.section({
					name: SECTION_NAME,
					order: SECTION_ORDER,
					text: ({ agent }) => {
						if (agent === undefined) return ''
						const cwd = cwdOf(agent.id)
						if (cwd === '') return ''
						const resolution = policyFor(agent.id, cwd)
						const servers = resolution.servers
							.map(serverName => store?.server(serverName))
							.filter((record): record is ServerRecord => record !== undefined)
						return promptText(cwd, resolution, servers)
					},
				})
				await syncProfile()
			} catch (error) {
				storeError = error instanceof Error ? error.message : String(error)
				debug(`registry failed to open: ${storeError}`)
			}
		})()

		return () => {
			disposed = true
			toolsDispose?.()
			toolsDispose = undefined
			promptDispose?.()
			promptDispose = undefined
			const opened = store
			store = undefined
			void opened?.close()
			clearInterval(timer)
			for (const tools of projections.values()) {
				for (const dispose of tools.values()) dispose()
			}
			projections.clear()
			void profileRuntime?.dispose()
			profileRuntime = undefined
			runtime.dispose()
		}
	}, 'mcp-tool: runtime')
}

