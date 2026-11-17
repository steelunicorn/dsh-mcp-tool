/**
 * The three model-facing tools.
 *
 * `mcp_servers` describes what this folder may use, `mcp_load` starts one
 * server on demand, and `mcp_release` ends the agent's need for it. All three
 * are registered with a `when` predicate, so a folder without any allowed
 * server never shows them to the model.
 *
 * @module dsh-mcp-tool/tools
 */
const text = (value) => [{ type: 'text', text: value }];
const serverOf = (args) => {
    const server = args?.server;
    if (typeof server !== 'string' || server.trim() === '')
        throw new Error('the "server" argument is required');
    return server.trim();
};
const agentOf = (exec) => {
    if (exec.agent === undefined)
        throw new Error('this tool requires an owning agent session');
    return exec.agent;
};
/** The host-facing spec of one stored server. */
export function specOf(record) {
    const spec = {
        name: record.name,
        transport: record.transport,
    };
    if (record.description !== undefined)
        spec.description = record.description;
    if (record.transport === 'stdio') {
        spec.command = record.command ?? '';
        spec.args = [...(record.args ?? [])];
        spec.env = { ...(record.env ?? {}) };
        if (record.cwd !== undefined)
            spec.cwd = record.cwd;
    }
    else {
        spec.url = record.url ?? '';
        spec.headers = { ...(record.headers ?? {}) };
    }
    if (record.toolCallTimeoutMs !== undefined)
        spec.toolCallTimeoutMs = record.toolCallTimeoutMs;
    if (record.startupTimeoutMs !== undefined)
        spec.startupTimeoutMs = record.startupTimeoutMs;
    return spec;
}
/** Tool descriptions are model-facing English; the interface is localized (ru/en). */
export function registerTools(deps) {
    const { store, runtime } = deps;
    /** Allowed and known servers of one agent's folder, in registration order. */
    const allowedOf = (agentId, cwd) => {
        const resolution = deps.policyFor(agentId, cwd);
        const seen = new Set();
        const out = [];
        for (const name of resolution.servers) {
            if (seen.has(name))
                continue;
            seen.add(name);
            const record = store.server(name);
            if (record !== undefined)
                out.push(record);
        }
        return out;
    };
    const visible = (agentId, cwd) => allowedOf(agentId, cwd).length > 0;
    const disposers = [
        deps.register({
            name: 'mcp_servers',
            description: 'List the MCP servers the preset of this folder allows, with the live status of each. '
                + 'A server is idle until mcp_load starts it; tools of a loaded server then appear '
                + 'as mcp__<server>__<tool> in your tool list.',
            parameters: {},
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['cwd', 'source', 'preset', 'servers'],
                    properties: {
                        cwd: { type: 'string' },
                        source: { type: 'string', enum: ['folder', 'default'] },
                        preset: { type: 'string' },
                        servers: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['name', 'transport', 'status', 'live', 'holders', 'toolCount'],
                                properties: {
                                    name: { type: 'string' },
                                    description: { type: 'string' },
                                    transport: { type: 'string', enum: ['stdio', 'http'] },
                                    loadMode: { type: 'string', enum: ['lazy', 'eager'] },
                                    status: { type: 'string' },
                                    live: { type: 'boolean' },
                                    holders: { type: 'integer' },
                                    toolCount: { type: 'integer' },
                                },
                            },
                        },
                    },
                },
                render: (_args, value) => {
                    const report = value;
                    if (report.servers.length === 0) {
                        return text(`No MCP server is switched on in ${report.cwd} (preset: ${report.preset}).`);
                    }
                    const lines = report.servers.map(entry => `- ${entry.name} [${entry.status}]${entry.live ? ` live, ${entry.toolCount} tools` : ' not loaded'}`);
                    return text([
                        `MCP servers switched on in ${report.cwd} (preset: ${report.preset}, source: ${report.source}):`,
                        ...lines,
                    ].join('\n'));
                },
            },
            when: context => visible(context.agent.id, cwdOf(context.agent.id)),
            async execute(_args, exec) {
                const agent = agentOf(exec);
                const cwd = cwdOf(agent.id);
                const resolution = deps.policyFor(agent.id, cwd);
                const snapshot = new Map(runtime.snapshot().map(entry => [entry.name, entry]));
                const servers = allowedOf(agent.id, cwd).map(record => {
                    const live = snapshot.get(record.name);
                    const row = {
                        name: record.name,
                        transport: record.transport,
                        loadMode: record.loadMode ?? 'lazy',
                        status: live?.status ?? 'inactive',
                        live: live !== undefined,
                        holders: live?.holders.length ?? 0,
                        toolCount: live?.toolCount ?? 0,
                    };
                    if (record.description !== undefined)
                        row.description = record.description;
                    return row;
                });
                return { cwd, source: resolution.source, preset: resolution.preset, servers };
            },
        }),
        deps.register({
            name: 'mcp_load',
            description: 'Start one MCP server this folder allows and return its tools with their input schemas. '
                + 'Idempotent: calling it again keeps the same process. The returned tools become callable '
                + 'as mcp__<server>__<tool> on your next step. Call mcp_release when you no longer need the server.',
            parameters: {
                server: { type: 'string', required: true, description: 'Server name from mcp_servers.' },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['server', 'status', 'tools'],
                    properties: {
                        server: { type: 'string' },
                        status: { type: 'string' },
                        tools: {
                            type: 'array',
                            items: {
                                type: 'object',
                                additionalProperties: false,
                                required: ['name', 'parameters'],
                                properties: {
                                    name: { type: 'string' },
                                    description: { type: 'string' },
                                    parameters: {},
                                },
                            },
                        },
                    },
                },
                render: (_args, value) => {
                    const report = value;
                    const lines = report.tools.map(tool => `- ${tool.name}${tool.description === undefined ? '' : `: ${tool.description}`}`);
                    return text([`${report.server} is ready with ${report.tools.length} tool(s):`, ...lines].join('\n'));
                },
            },
            when: context => visible(context.agent.id, cwdOf(context.agent.id)),
            async execute(args, exec) {
                const agent = agentOf(exec);
                const name = serverOf(args);
                const cwd = cwdOf(agent.id);
                const allowed = allowedOf(agent.id, cwd);
                const record = allowed.find(entry => entry.name === name);
                if (record === undefined) {
                    throw new Error(`server "${name}" is not allowed in ${cwd}; call mcp_servers to list the allowed servers`);
                }
                const loaded = await runtime.load(specOf(record), agent.id, allowed.map(entry => entry.name));
                return { server: loaded.name, status: loaded.status, tools: loaded.tools };
            },
        }),
        deps.register({
            name: 'mcp_release',
            description: 'Release one MCP server you loaded. The server process stops as soon as no other agent holds it, '
                + 'and its tools disappear from your tool list. Call it once you no longer need the server.',
            parameters: {
                server: { type: 'string', required: true, description: 'Server name you loaded before.' },
            },
            output: {
                schema: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['server', 'released', 'stopped'],
                    properties: {
                        server: { type: 'string' },
                        released: { type: 'boolean' },
                        stopped: { type: 'boolean' },
                    },
                },
                render: (_args, value) => {
                    const report = value;
                    if (!report.released)
                        return text(`${report.server} was not loaded by this agent.`);
                    return text(report.stopped
                        ? `${report.server} was released and its process stopped.`
                        : `${report.server} was released; another agent still holds it, so the process stays up.`);
                },
            },
            when: context => visible(context.agent.id, cwdOf(context.agent.id)),
            async execute(args, exec) {
                const agent = agentOf(exec);
                const name = serverOf(args);
                const released = runtime.holders(name).includes(agent.id);
                const { stopped } = runtime.release(name, agent.id);
                return { server: name, released, stopped };
            },
        }),
    ];
    return () => {
        for (const dispose of disposers)
            dispose();
    };
    function cwdOf(agentId) {
        return deps.cwdOf(agentId);
    }
}
