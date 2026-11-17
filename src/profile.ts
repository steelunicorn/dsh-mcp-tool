import {
	ActivationError,
	type CatalogPort,
	type ManagerPort,
	type ServerStatus,
} from './runtime.js'

export interface MountedTool {
	name: string
	description?: string
	parameters?: unknown
	/** The tool definition to project into an agent's tool list. */
	definition?: unknown
}

/**
 * Who owns the lifetime of a server that comes from the DSH MCP settings.
 *
 * Two backends implement it: `managerProfile` flips the settings entry and
 * lets the official manager own the process, `mountProfile` starts a private
 * instance of the official client in its own scope. Callers see one interface.
 */
export interface ProfileRuntime {
	/** Starts one mirrored server and waits until its tools are published. */
	start(server: string, startupTimeoutMs: number): Promise<void>
	/** Stops a server this runtime started; a no-op for the others. */
	stop(server: string): Promise<void>
	status(server: string): ServerStatus
	/** Whether this runtime, rather than the settings, keeps the server up. */
	started(server: string): boolean
	/** Stops everything this runtime started. */
	dispose(): Promise<void>
	/** True when this runtime starts its own client instead of flipping the entry. */
	mounts?: boolean
	/** Tools published by a private mount; empty for the other runtimes. */
	tools?(server: string): MountedTool[]
}

/** Switches one entry of the DSH MCP settings on or off. */
export interface ProfileControl {
	setEnabled(server: string, enabled: boolean): Promise<void>
	/** Whether the settings currently keep the entry on; unknown counts as on. */
	current?(server: string): boolean | undefined
}

const defaultSleep = (ms: number): Promise<void> =>
	new Promise(resolve => {
		setTimeout(resolve, ms)
	})

const STOP_TIMEOUT_MS = 10_000

/**
 * The manager-backed profile runtime.
 *
 * The manager reconciles its entries asynchronously after the settings change,
 * so every transition is a poll on `manager.status`. Operations on one server
 * are serialised: two flips racing each other would leave the entry in an
 * unpredictable state.
 */
export function managerProfile(
	control: ProfileControl,
	manager: ManagerPort,
	catalog: CatalogPort,
	sleep = defaultSleep,
): ProfileRuntime {
	const owned = new Set<string>()
	const tails = new Map<string, Promise<void>>()

	const serial = (server: string, run: () => Promise<void>): Promise<void> => {
		const previous = tails.get(server) ?? Promise.resolve()
		const next = previous.then(run, run)
		tails.set(server, next.then(() => undefined, () => undefined))
		return next
	}

	const waitFor = async (server: string, want: 'ready' | 'stopped', timeoutMs: number): Promise<void> => {
		const deadline = Date.now() + timeoutMs
		for (;;) {
			const status = manager.status(server)
			if (want === 'ready') {
				if (status === 'ready') return
				if (status === 'failed') {
					throw new ActivationError(
						manager.detail?.(server) ?? `MCP server "${server}" failed to start`,
						server,
						'failed',
					)
				}
			} else if (status === 'stopped' || status === 'inactive' || status === 'failed') {
				return
			}
			if (Date.now() >= deadline) {
				throw new ActivationError(
					want === 'ready'
						? `MCP server "${server}" did not start within ${timeoutMs} ms`
						: `MCP server "${server}" did not stop within ${timeoutMs} ms`,
					server,
					'timeout',
				)
			}
			await sleep(50)
		}
	}

	return {
		mounts: false,
		start(server: string, startupTimeoutMs: number): Promise<void> {
			return serial(server, async () => {
				if (manager.status(server) === 'ready') return
				await control.setEnabled(server, true)
				owned.add(server)
				try {
					await waitFor(server, 'ready', startupTimeoutMs)
					await catalog.ready?.(server, startupTimeoutMs)
				} catch (error) {
					owned.delete(server)
					await control.setEnabled(server, false).catch(() => undefined)
					throw error
				}
			})
		},
		stop(server: string): Promise<void> {
			return serial(server, async () => {
				if (!owned.has(server)) return
				owned.delete(server)
				await control.setEnabled(server, false)
				await waitFor(server, 'stopped', STOP_TIMEOUT_MS).catch(() => undefined)
			})
		},
		status(server: string): ServerStatus {
			return manager.status(server)
		},
		started(server: string): boolean {
			return owned.has(server)
		},
		async dispose(): Promise<void> {
			const names = [...owned]
			owned.clear()
			for (const name of names) {
				await control.setEnabled(name, false).catch(() => undefined)
			}
		},
	}
}


/** A live client mounted inside a private scope. */
export interface MountSession {
	/** Tools the client publishes right now; empty while it is still starting. */
	tools(): MountedTool[]
	/** Shuts the client down and disposes its scope. */
	dispose(): Promise<void>
}

/** Creates a private client instance for one mirrored server. */
export interface MountOpener {
	open(server: string, signal?: AbortSignal): Promise<MountSession>
}

/** The mount-backed runtime, with access to the tools it publishes. */
export interface MountedProfileRuntime extends ProfileRuntime {
	tools(server: string): MountedTool[]
}

/**
 * The scope-backed profile runtime.
 *
 * The plugin starts its own instance of the official client in a private
 * scope, so the process belongs to the plugin and the entry in the DSH
 * settings stays off while the plugin holds it. Starting therefore flips the
 * entry off first: an enabled entry already took the server name in the root
 * scope, and the client refuses to be mounted twice under one name.
 */
export function mountProfile(
	opener: MountOpener,
	control: ProfileControl,
	sleep = defaultSleep,
): MountedProfileRuntime {
	const mounts = new Map<string, { session: MountSession; flipped: boolean }>()
	const failures = new Map<string, string>()
	const tails = new Map<string, Promise<void>>()

	const serial = (server: string, run: () => Promise<void>): Promise<void> => {
		const previous = tails.get(server) ?? Promise.resolve()
		const next = previous.then(run, run)
		tails.set(server, next.then(() => undefined, () => undefined))
		return next
	}

	const waitForTools = async (server: string, session: MountSession, timeoutMs: number): Promise<void> => {
		const deadline = Date.now() + timeoutMs
		for (;;) {
			if (session.tools().length > 0) return
			if (Date.now() >= deadline) {
				throw new ActivationError(
					`MCP server "${server}" did not publish tools within ${timeoutMs} ms`,
					server,
					'timeout',
				)
			}
			await sleep(50)
		}
	}

	return {
		mounts: true,
		tools(server: string): MountedTool[] {
			return mounts.get(server)?.session.tools() ?? []
		},
		start(server: string, startupTimeoutMs: number): Promise<void> {
			return serial(server, async () => {
				const existing = mounts.get(server)
				if (existing !== undefined) {
					await waitForTools(server, existing.session, startupTimeoutMs)
					return
				}
				failures.delete(server)
				// An entry that is already off stays off, so a failed mount does not
				// switch the user's setting on behind their back.
				const before = control.current?.(server) ?? true
				let flipped = false
				try {
					if (before !== false) {
						await control.setEnabled(server, false)
						flipped = true
					}
				} catch (error) {
					// An entry that cannot be switched off is still worth trying:
					// the mount may fail on the name clash, and that error says why.
					if (error instanceof ActivationError) throw error
				}
				let session: MountSession | undefined
				try {
					session = await opener.open(server)
					mounts.set(server, { session, flipped })
					await waitForTools(server, session, startupTimeoutMs)
				} catch (error) {
					mounts.delete(server)
					await session?.dispose().catch(() => undefined)
					if (flipped) await control.setEnabled(server, true).catch(() => undefined)
					failures.set(server, error instanceof Error ? error.message : String(error))
					throw error
				}
			})
		},
		stop(server: string): Promise<void> {
			return serial(server, async () => {
				const mount = mounts.get(server)
				if (mount === undefined) return
				mounts.delete(server)
				await mount.session.dispose().catch(() => undefined)
				if (mount.flipped) await control.setEnabled(server, true).catch(() => undefined)
			})
		},
		status(server: string): ServerStatus {
			const mount = mounts.get(server)
			if (mount === undefined) return failures.has(server) ? 'failed' : 'stopped'
			return mount.session.tools().length > 0 ? 'ready' : 'starting'
		},
		started(server: string): boolean {
			return mounts.has(server)
		},
		async dispose(): Promise<void> {
			const names = [...mounts.keys()]
			for (const name of names) {
				await this.stop(name).catch(() => undefined)
			}
		},
	}
}

/**
 * The `auto` lifecycle: per server, mount what the settings keep enabled
 * (its name is taken in the root scope) and flip what they keep disabled.
 */
export function hybridProfile(
	flip: ProfileRuntime,
	mount: MountedProfileRuntime,
	useMount: (server: string) => boolean,
): MountedProfileRuntime {
	// Whoever actually holds the server decides: a flipped entry is enabled in
	// the settings, so the settings alone no longer say who owns it.
	const pick = (server: string): ProfileRuntime => {
		if (flip.started(server)) return flip
		if (mount.started(server)) return mount
		return useMount(server) ? mount : flip
	}
	return {
		mounts: true,
		tools(server: string): MountedTool[] {
			return useMount(server) ? mount.tools(server) : []
		},
		start(server: string, startupTimeoutMs: number): Promise<void> {
			return pick(server).start(server, startupTimeoutMs)
		},
		stop(server: string): Promise<void> {
			return pick(server).stop(server)
		},
		status(server: string): ServerStatus {
			return pick(server).status(server)
		},
		started(server: string): boolean {
			return pick(server).started(server)
		},
		async dispose(): Promise<void> {
			await mount.dispose().catch(() => undefined)
			await flip.dispose().catch(() => undefined)
		},
	}
}
