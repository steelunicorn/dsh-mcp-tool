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
/** Prefix MCP clients use for the tools of one server. */
export function toolPrefix(server) {
    return `mcp__${server}__`;
}
/** The server owning a tool name, or undefined for any other tool. */
export function serverOfTool(name) {
    if (!name.startsWith('mcp__'))
        return undefined;
    const end = name.indexOf('__', 5);
    return end === -1 ? undefined : name.slice(5, end);
}
/** Projects one registration spec onto a manager entry with only the fields its transport accepts. */
export function toEntry(spec) {
    const entry = spec.transport === 'stdio'
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
        };
    if (spec.toolCallTimeoutMs !== undefined)
        entry.toolCallTimeoutMs = spec.toolCallTimeoutMs;
    if (spec.startupTimeoutMs !== undefined)
        entry.startupTimeoutMs = spec.startupTimeoutMs;
    return entry;
}
/** Maps a manager status onto the pool's coarse lifecycle state. */
export function toServerStatus(status) {
    if (status === undefined)
        return 'starting';
    switch (status.state) {
        case 'connected': return 'ready';
        case 'connecting':
        case 'reconnecting': return 'starting';
        case 'failed':
        case 'waiting-credentials': return 'failed';
        case 'closed':
        case 'disabled': return 'stopped';
        default: return 'starting';
    }
}
/** Human-readable reason for a non-ready status. */
export function statusDetail(status) {
    if (status === undefined)
        return undefined;
    if (status.lastError !== undefined && status.lastError !== '')
        return status.lastError;
    if (status.state === 'failed' && status.reason !== undefined)
        return `connection failed (${status.reason})`;
    if (status.state === 'waiting-credentials')
        return 'the server is waiting for credentials';
    if (status.state === 'closed' && status.result?.cleanupError !== undefined)
        return status.result.cleanupError;
    return undefined;
}
/** The manager port backed by `ctx.mcpManager`. */
export function managerPort(manager) {
    return {
        register(spec) {
            return manager.register(spec.name, toEntry(spec));
        },
        status(server) {
            return toServerStatus(manager.list().find(view => view.name === server)?.status);
        },
        detail(server) {
            return statusDetail(manager.list().find(view => view.name === server)?.status);
        },
    };
}
/** Reads one server's currently registered tools from the global catalog. */
export function toolsOf(tools, server) {
    const prefix = toolPrefix(server);
    return tools
        .definitions()
        .filter(definition => definition.name.startsWith(prefix))
        .map(definition => {
        const info = { name: definition.name };
        if (definition.description !== undefined)
            info.description = definition.description;
        if (definition.parameters !== undefined)
            info.parameters = definition.parameters;
        return info;
    })
        .sort((left, right) => left.name.localeCompare(right.name));
}
/** The catalog port backed by `ctx.tools` and `ctx.agents`. */
export function catalogPort(ctx, sleep = defaultSleep) {
    return {
        toolNames(server) {
            return toolsOf(ctx.tools, server).map(info => info.name);
        },
        toolSchemas(server) {
            return toolsOf(ctx.tools, server);
        },
        async ready(server, timeoutMs) {
            const deadline = Date.now() + timeoutMs;
            while (toolsOf(ctx.tools, server).length === 0 && Date.now() < deadline)
                await sleep(50);
        },
        hide(agentId, names) {
            const agent = ctx.agents.get(agentId);
            // An agent that already went away needs no restriction; the pool drops it.
            if (agent === undefined || names.length === 0)
                return () => { };
            return agent.ctx.tools.restrict({ deny: [...names] });
        },
    };
}
/** The working directory of an agent, falling back to the Session header. */
export function workingDirectoryOf(ctx, agent) {
    const effective = ctx.workingDirectory.get(agent.session);
    return effective === undefined || effective === '' ? agent.session.header.cwd ?? '' : effective;
}
function defaultSleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}
