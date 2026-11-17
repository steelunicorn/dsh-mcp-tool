/**
 * Structural bindings to the host services this plugin uses.
 *
 * The plugin carries no compile-time dependency on `@deepseek-ai/*` packages:
 * the Host supplies those services at runtime and only the members mirrored
 * here are touched. Every mirror is taken from the shipped contracts of DSH
 * 0.2.2-rc.3 (`dsh-mcp-manager`, `dsh-tools`, `dsh-agent`).
 *
 * @module dsh-mcp-tool/host
 */

import type { CatalogPort, ManagerPort, ServerSpec, ServerStatus, ToolInfo } from './runtime.js'

/** A registration disposer, as Cordis effects return them. */
export type Disposer = () => void

/** One MCP server entry accepted by `ctx.mcpManager.register()`. */
export interface McpServerEntry {
	transport: 'stdio' | 'streamable-http'
	command?: string
	args?: string[]
	env?: Record<string, string>
	cwd?: string
	url?: string
	headers?: Record<string, string>
	toolCallTimeoutMs?: number
	startupTimeoutMs?: number
}

/** Status of one managed MCP server, as the manager publishes it. */
export interface McpManagedStatus {
	state: string
	reason?: string
	lastError?: string
	toolCount?: number
	result?: { closeConfirmed: boolean; cleanupError?: string }
}

/** One row of `ctx.mcpManager.list()`. */
export interface McpServerView {
	name: string
	configured: boolean
	status: McpManagedStatus
}

/** The slice of `ctx.mcpManager` this plugin uses. */
export interface McpManagerLike {
	register(name: string, entry: McpServerEntry): Disposer
	list(): McpServerView[]
}

/** A tool definition as `ctx.tools.definitions()` returns it. */
export interface ToolDefinitionLike {
	readonly name: string
	readonly description?: string
	readonly parameters?: unknown
}

/** A visibility filter for `ctx.tools.restrict()`. */
export interface ToolRestrictionLike {
	allow?: readonly string[]
	deny?: readonly string[]
}

/** The slice of `ctx.tools` this plugin uses. */
export interface ToolsLike {
	definitions(scope?: unknown): readonly ToolDefinitionLike[]
	register(definition: never | object, options?: { when?: (context: ActivationContext) => boolean | Promise<boolean> }): Disposer
	restrict(filter: ToolRestrictionLike): Disposer
}

/** What a `when` predicate receives. */
export interface ActivationContext {
	readonly agent: AgentLike
}

/** A live agent, reduced to the members the policy needs. */
export interface AgentLike {
	readonly id: string
	readonly ctx: AgentContextLike
	readonly session: {
		readonly id?: string
		readonly header: { readonly cwd?: string }
	}
}

/** The scoped context an agent owns. */
export interface AgentContextLike {
	readonly tools: ToolsLike
}

/** The agent registry this plugin subscribes to. */
export interface AgentRegistryLike {
	list(): AgentLike[]
	get(id: string): AgentLike | undefined
}

/** The working-directory service. */
export interface WorkingDirectoryLike {
	get(session: AgentLike['session']): string
}

/** One execution as the `tools/pre-execute` waterfall receives it. */
export interface ToolExecutionLike {
	readonly name: string
	readonly agent?: AgentLike
}

/** The Host context, reduced to the services this plugin injects. */
export interface HostContext {
	mcpManager: McpManagerLike
	tools: ToolsLike
	agents: AgentRegistryLike
	workingDirectory: WorkingDirectoryLike
	effect(callback: () => Disposer | void, label?: string): Disposer
	on(event: string, listener: (...args: never[]) => unknown): Disposer
}

/** Prefix MCP clients use for the tools of one server. */
export function toolPrefix(server: string): string {
	return `mcp__${server}__`
}

/** The server owning a tool name, or undefined for any other tool. */
export function serverOfTool(name: string): string | undefined {
	if (!name.startsWith('mcp__')) return undefined
	const end = name.indexOf('__', 5)
	return end === -1 ? undefined : name.slice(5, end)
}

/** Projects one registration spec onto a manager entry with only the fields its transport accepts. */
export function toEntry(spec: ServerSpec): McpServerEntry {
	const entry: McpServerEntry =
		spec.transport === 'stdio'
			? {
				transport: 'stdio',
				command: spec.command ?? '',
				args: spec.args ?? [],
				env: spec.env ?? {},
				cwd: spec.cwd ?? '',
			}
			: {
				transport: 'streamable-http',
				url: spec.url ?? '',
				headers: spec.headers ?? {},
			}
	if (spec.toolCallTimeoutMs !== undefined) entry.toolCallTimeoutMs = spec.toolCallTimeoutMs
	if (spec.startupTimeoutMs !== undefined) entry.startupTimeoutMs = spec.startupTimeoutMs
	return entry
}

/** Maps a manager status onto the pool's coarse lifecycle state. */
export function toServerStatus(status: McpManagedStatus | undefined): ServerStatus {
	if (status === undefined) return 'starting'
	switch (status.state) {
		case 'connected': return 'ready'
		case 'connecting':
		case 'reconnecting': return 'starting'
		case 'failed':
		case 'waiting-credentials': return 'failed'
		case 'closed':
		case 'disabled': return 'stopped'
		default: return 'starting'
	}
}

/** Human-readable reason for a non-ready status. */
export function statusDetail(status: McpManagedStatus | undefined): string | undefined {
	if (status === undefined) return undefined
	if (status.lastError !== undefined && status.lastError !== '') return status.lastError
	if (status.state === 'failed' && status.reason !== undefined) return `connection failed (${status.reason})`
	if (status.state === 'waiting-credentials') return 'the server is waiting for credentials'
	if (status.state === 'closed' && status.result?.cleanupError !== undefined) return status.result.cleanupError
	return undefined
}

/** The manager port backed by `ctx.mcpManager`. */
export function managerPort(manager: McpManagerLike): ManagerPort {
	return {
		register(spec: ServerSpec): Disposer {
			return manager.register(spec.name, toEntry(spec))
		},
		status(server: string): ServerStatus {
			return toServerStatus(manager.list().find(view => view.name === server)?.status)
		},
		detail(server: string): string | undefined {
			return statusDetail(manager.list().find(view => view.name === server)?.status)
		},
	}
}

/** Reads one server's currently registered tools from the global catalog. */
export function toolsOf(tools: ToolsLike, server: string): ToolInfo[] {
	const prefix = toolPrefix(server)
	return tools
		.definitions()
		.filter(definition => definition.name.startsWith(prefix))
		.map(definition => {
			const info: ToolInfo = { name: definition.name }
			if (definition.description !== undefined) info.description = definition.description
			if (definition.parameters !== undefined) info.parameters = definition.parameters
			return info
		})
		.sort((left, right) => left.name.localeCompare(right.name))
}

/** The catalog port backed by `ctx.tools` and `ctx.agents`. */
export function catalogPort(ctx: HostContext, sleep = defaultSleep): CatalogPort {
	return {
		toolNames(server: string): string[] {
			return toolsOf(ctx.tools, server).map(info => info.name)
		},
		toolSchemas(server: string): ToolInfo[] {
			return toolsOf(ctx.tools, server)
		},
		async ready(server: string, timeoutMs: number): Promise<void> {
			const deadline = Date.now() + timeoutMs
			while (toolsOf(ctx.tools, server).length === 0 && Date.now() < deadline) await sleep(50)
		},
		hide(agentId: string, names: readonly string[]): Disposer {
			const agent = ctx.agents.get(agentId)
			// An agent that already went away needs no restriction; the pool drops it.
			if (agent === undefined || names.length === 0) return () => {}
			return agent.ctx.tools.restrict({ deny: [...names] })
		},
	}
}

/** The working directory of an agent, falling back to the Session header. */
export function workingDirectoryOf(ctx: HostContext, agent: AgentLike): string {
	const effective = ctx.workingDirectory.get(agent.session)
	return effective === undefined || effective === '' ? agent.session.header.cwd ?? '' : effective
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise(resolve => setTimeout(resolve, ms))
}
