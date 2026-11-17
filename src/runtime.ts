/**
 * Runtime pool for lazily started MCP servers.
 *
 * The pool owns the lifetime rules only; the host binding (DSH `mcpManager`,
 * the tool catalog, per-agent visibility) is injected through narrow ports, so
 * the whole state machine is testable without a running DSH host.
 */

export type ServerTransport = 'stdio' | 'http'

export type ServerStatus = 'inactive' | 'starting' | 'ready' | 'failed' | 'stopped'

/** Everything the host needs to start one MCP server. */
export interface ServerSpec {
	name: string
	description?: string
	transport: ServerTransport
	command?: string
	args?: string[]
	env?: Record<string, string>
	cwd?: string
	url?: string
	headers?: Record<string, string>
	toolCallTimeoutMs?: number
	startupTimeoutMs?: number
	/** `eager` servers are started by the plugin and never stopped while it runs. */
	loadMode?: 'lazy' | 'eager'
}

/**
 * Synthetic holder that keeps an eager server alive: it is never released, so
 * the reference count cannot drop to zero and the idle sweep skips it.
 */
export const EAGER_HOLDER = 'plugin'

/** The subset of `ctx.mcpManager` the pool uses. */
export interface ManagerPort {
	/** Starts a server and returns its stop function. Throws when it cannot start. */
	register(spec: ServerSpec): () => void
	status(server: string): ServerStatus
	/** Host-provided diagnostic for a non-ready status. */
	detail?(server: string): string | undefined
}

/** The subset of the tool catalog the pool uses. */
export interface CatalogPort {
	/** Public names of the server's tools (`mcp__<server>__<tool>`). */
	toolNames(server: string): string[]
	/** Name, description and input schema of each tool of the server. */
	toolSchemas(server: string): ToolInfo[]
	/** Waits until the server's tools are registered, up to `timeoutMs`. */
	ready?(server: string, timeoutMs: number): Promise<void>
	/** Installs the deny list for one agent; the returned function restores visibility. */
	hide(agentId: string, toolNames: string[]): () => void
}

export interface ToolInfo {
	name: string
	description?: string
	parameters?: unknown
}

export interface LoadResult {
	name: string
	status: ServerStatus
	tools: ToolInfo[]
}

export interface LiveInfo {
	name: string
	status: ServerStatus
	holders: string[]
	inFlight: number
	lastUsed: number
	toolCount: number
	error?: string
}

export interface RuntimeOptions {
	manager: ManagerPort
	catalog: CatalogPort
	/** Idle window after which an unheld server is stopped. */
	idleMs?: number
	/** Upper bound of concurrent live lazy processes. */
	maxLive?: number
	/** Startup wait before a server is reported as failed. */
	startupTimeoutMs?: number
	/**
	 * Whether tools of an eager server may be shown to an agent that never
	 * loaded it. The plugin answers from the folder preset.
	 */
	visibleTo?(agentId: string, server: string): boolean
	now?: () => number
	log?: (message: string) => void
}

export class ActivationError extends Error {
	constructor(
		message: string,
		readonly server: string,
		readonly reason: 'unknown' | 'not-allowed' | 'failed' | 'timeout' | 'capacity',
	) {
		super(message)
		this.name = 'ActivationError'
	}
}

interface LiveServer {
	spec: ServerSpec
	status: ServerStatus
	holders: Set<string>
	stop: (() => void) | undefined
	inFlight: number
	lastUsed: number
	error: string | undefined
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export class McpRuntime {
	private readonly live = new Map<string, LiveServer>()
	private readonly agents = new Set<string>()
	private readonly hides = new Map<string, () => void>()
	private readonly manager: ManagerPort
	private readonly catalog: CatalogPort
	private readonly idleMs: number
	private readonly maxLive: number
	private readonly startupTimeoutMs: number
	private readonly now: () => number
	private readonly log: (message: string) => void
	private readonly visibleTo: (agentId: string, server: string) => boolean
	private lastStartError = ''

	constructor(options: RuntimeOptions) {
		this.manager = options.manager
		this.catalog = options.catalog
		this.idleMs = options.idleMs ?? 10 * 60 * 1000
		this.maxLive = options.maxLive ?? 3
		this.startupTimeoutMs = options.startupTimeoutMs ?? 30_000
		this.now = options.now ?? Date.now
		this.log = options.log ?? (() => {})
		this.visibleTo = options.visibleTo ?? (() => false)
	}

	/** True when the server is pinned by the plugin (eager load mode). */
	isEager(server: string): boolean {
		return this.live.get(server)?.holders.has(EAGER_HOLDER) === true
	}

	/** Registers an agent whose tool visibility the pool has to maintain. */
	trackAgent(agentId: string): void {
		this.agents.add(agentId)
		this.syncVisibility()
	}

	/** Forgets an agent and releases everything it held. */
	untrackAgent(agentId: string): void {
		this.releaseAll(agentId)
		this.agents.delete(agentId)
		const restore = this.hides.get(agentId)
		restore?.()
		this.hides.delete(agentId)
	}

	isLive(server: string): boolean {
		return this.live.has(server)
	}

	/** Recomputes tool visibility for every tracked agent. */
	refreshVisibility(): void {
		this.syncVisibility()
	}

	holders(server: string): string[] {
		return [...(this.live.get(server)?.holders ?? [])]
	}

	/** Starts the server for one holder and waits until the catalog sees it. */
	async load(spec: ServerSpec, holder: string, allowed: readonly string[]): Promise<LoadResult> {
		if (!allowed.includes(spec.name)) {
			throw new ActivationError(
				`server "${spec.name}" is not allowed in this folder`,
				spec.name,
				'not-allowed',
			)
		}
		let entry = this.live.get(spec.name)
		if (entry?.holders.has(EAGER_HOLDER) === true) {
			// Pinned by the plugin: the agent uses the process without holding it.
			return { name: spec.name, status: entry.status, tools: this.catalog.toolSchemas(spec.name) }
		}
		if (entry === undefined) {
			this.makeRoom()
			entry = this.start(spec)
			if (entry === undefined) {
				throw new ActivationError(
					`server "${spec.name}" failed to start: ${this.lastStartError}`,
					spec.name,
					'failed',
				)
			}
		}
		entry.holders.add(holder)
		entry.lastUsed = this.now()
		this.syncVisibility()
		const ready = await this.waitReady(entry)
		if (!ready) {
			const reason = entry.status === 'failed' ? 'failed' : 'timeout'
			const detail = entry.error ?? 'timeout'
			entry.holders.delete(holder)
			// A process that never came up must not linger in the pool.
			if (entry.holders.size === 0 && entry.inFlight === 0) this.stop(spec.name)
			else this.syncVisibility()
			throw new ActivationError(
				`server "${spec.name}" did not become ready: ${detail}`,
				spec.name,
				reason,
			)
		}
		// The host reports the connection before it finishes registering tools.
		await this.catalog.ready?.(spec.name, this.startupTimeoutMs)
		// Tools registered after the first visibility pass must be hidden too.
		this.syncVisibility()
		return { name: spec.name, status: entry.status, tools: this.catalog.toolSchemas(spec.name) }
	}

	/** Starts an eager server and pins it for the plugin's lifetime. */
	async loadEager(spec: ServerSpec): Promise<void> {
		let entry = this.live.get(spec.name)
		if (entry === undefined) {
			this.makeRoom()
			entry = this.start({ ...spec, loadMode: 'eager' })
			if (entry === undefined) {
				throw new ActivationError(
					`server "${spec.name}" failed to start: ${this.lastStartError}`,
					spec.name,
					'failed',
				)
			}
		}
		entry.holders.add(EAGER_HOLDER)
		entry.lastUsed = this.now()
		this.syncVisibility()
		if (!(await this.waitReady(entry))) {
			const detail = entry.error ?? 'timeout'
			entry.holders.delete(EAGER_HOLDER)
			if (entry.holders.size === 0 && entry.inFlight === 0) this.stop(spec.name)
			else this.syncVisibility()
			throw new ActivationError(
				`server "${spec.name}" did not become ready: ${detail}`,
				spec.name,
				entry.status === 'failed' ? 'failed' : 'timeout',
			)
		}
		await this.catalog.ready?.(spec.name, this.startupTimeoutMs)
		this.syncVisibility()
	}

	/** Unpins an eager server after its load mode was switched back to lazy. */
	unpinEager(server: string): void {
		const entry = this.live.get(server)
		if (entry === undefined) return
		if (!entry.holders.delete(EAGER_HOLDER)) return
		if (entry.holders.size === 0 && entry.inFlight === 0) this.stop(server)
		else this.syncVisibility()
	}

	/** Releases one holder; the process stops when nobody holds the server. */
	release(server: string, holder: string): { stopped: boolean } {
		const entry = this.live.get(server)
		if (entry === undefined) return { stopped: false }
		if (entry.holders.has(EAGER_HOLDER)) {
			// Eager servers are pinned; a release cannot stop them.
			return { stopped: false }
		}
		entry.holders.delete(holder)
		entry.lastUsed = this.now()
		const stopped = entry.holders.size === 0 && entry.inFlight === 0 ? this.stop(server) : false
		this.syncVisibility()
		return { stopped }
	}

	/** Releases every server held by one holder. */
	releaseAll(holder: string): void {
		for (const [name, entry] of this.live) {
			if (!entry.holders.has(holder)) continue
			this.release(name, holder)
		}
	}

	/** Marks real tool usage, which resets the idle window. */
	touch(server: string): void {
		const entry = this.live.get(server)
		if (entry !== undefined) entry.lastUsed = this.now()
	}

	beginCall(server: string): void {
		const entry = this.live.get(server)
		if (entry === undefined) return
		entry.inFlight += 1
		entry.lastUsed = this.now()
	}

	endCall(server: string): void {
		const entry = this.live.get(server)
		if (entry === undefined) return
		entry.inFlight = Math.max(0, entry.inFlight - 1)
		entry.lastUsed = this.now()
		if (entry.inFlight === 0 && entry.holders.size === 0) this.stop(server)
	}

	/**
	 * Stops servers that outlived the idle window. Idleness is measured by real
	 * tool usage, so a server an agent loaded and forgot is stopped too.
	 */
	sweep(): string[] {
		const stopped: string[] = []
		const limit = this.now() - this.idleMs
		for (const [name, entry] of this.live) {
			if (entry.inFlight > 0) continue
			if (entry.holders.has(EAGER_HOLDER)) continue
			if (entry.lastUsed <= limit) {
				if (this.stop(name)) stopped.push(name)
			}
		}
		if (stopped.length > 0) this.syncVisibility()
		return stopped
	}

	snapshot(): LiveInfo[] {
		return [...this.live].map(([name, entry]) => ({
			name,
			status: entry.status,
			holders: [...entry.holders],
			inFlight: entry.inFlight,
			lastUsed: entry.lastUsed,
			toolCount: this.catalog.toolNames(name).length,
			...(entry.error === undefined ? {} : { error: entry.error }),
		}))
	}

	/** Stops every live server (plugin unload). */
	dispose(): void {
		for (const name of [...this.live.keys()]) this.stop(name)
		for (const restore of this.hides.values()) restore()
		this.hides.clear()
		this.agents.clear()
	}

	private start(spec: ServerSpec): LiveServer | undefined {
		const entry: LiveServer = {
			spec,
			status: 'starting',
			holders: new Set(),
			stop: undefined,
			inFlight: 0,
			lastUsed: this.now(),
			error: undefined,
		}
		this.live.set(spec.name, entry)
		try {
			entry.stop = this.manager.register(spec)
			entry.status = this.manager.status(spec.name)
			this.log(`started ${spec.name} (${entry.status})`)
		} catch (error) {
			entry.status = 'failed'
			entry.error = error instanceof Error ? error.message : String(error)
			this.lastStartError = entry.error
			this.live.delete(spec.name)
			this.log(`failed to start ${spec.name}: ${entry.error}`)
			return undefined
		}
		return entry
	}

	private stop(server: string): boolean {
		const entry = this.live.get(server)
		if (entry === undefined) return false
		this.live.delete(server)
		try {
			entry.stop?.()
		} catch (error) {
			this.log(`stop ${server} threw: ${error instanceof Error ? error.message : String(error)}`)
		}
		entry.status = 'stopped'
		this.log(`stopped ${server}`)
		this.syncVisibility()
		return true
	}

	private async waitReady(entry: LiveServer): Promise<boolean> {
		const deadline = this.now() + this.startupTimeoutMs
		for (;;) {
			const status = this.manager.status(entry.spec.name)
			entry.status = status
			if (status === 'ready') return true
			if (status === 'failed') {
				entry.error = this.manager.detail?.(entry.spec.name) ?? `host reported ${status}`
				return false
			}
			if (this.now() >= deadline) {
				// Keep the last observed status: the failure is a timeout, not a host error.
				entry.error = 'startup timeout'
				return false
			}
			await sleep(50)
		}
	}

	/**
	 * Frees a slot before a new process starts: an idle server (no call in flight
	 * and nothing but tool usage older than the idle window) is evicted; when
	 * every live server is fresh the load is refused instead of killing one of
	 * them behind the holding agent's back.
	 */
	private makeRoom(): void {
		const windowStart = this.now() - this.idleMs
		for (;;) {
			const liveLazy = [...this.live.values()].filter(entry => !entry.holders.has(EAGER_HOLDER)).length
			if (liveLazy < this.maxLive) return
			const victim = this.idleCandidate(windowStart)
			if (victim === undefined) {
				throw new ActivationError(
					`live server limit ${this.maxLive} reached; release an idle server first`,
					'',
					'capacity',
				)
			}
			this.stop(victim)
		}
	}

	private idleCandidate(windowStart: number): string | undefined {
		let best: { name: string; lastUsed: number } | undefined
		for (const [name, entry] of this.live) {
			if (entry.inFlight > 0 || entry.lastUsed > windowStart) continue
			if (entry.holders.has(EAGER_HOLDER)) continue
			if (best === undefined || entry.lastUsed < best.lastUsed) best = { name, lastUsed: entry.lastUsed }
		}
		return best?.name
	}

	/** Recomputes which live tools each tracked agent must not see. */
	private syncVisibility(): void {
		if (this.agents.size === 0) return
		for (const agent of this.agents) {
			const denied: string[] = []
			for (const [name, entry] of this.live) {
				if (entry.holders.has(agent)) continue
				if (entry.holders.has(EAGER_HOLDER) && this.visibleTo(agent, name)) continue
				denied.push(...this.catalog.toolNames(name))
			}
			const previous = this.hides.get(agent)
			previous?.()
			this.hides.delete(agent)
			if (denied.length > 0) this.hides.set(agent, this.catalog.hide(agent, denied))
		}
	}
}
