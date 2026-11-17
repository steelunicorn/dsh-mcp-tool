/**
 * Host plugin entry point.
 *
 * Wires the durable registry, the runtime pool, the three model-facing tools,
 * the prompt section and the GUI routes to the DSH services.
 *
 * @module dsh-mcp-tool
 */
import { appendFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { catalogPort, managerPort, serverOfTool, workingDirectoryOf, } from './host.js';
import { registerRoutes } from './http.js';
import { promptText, SECTION_NAME, SECTION_ORDER } from './prompt.js';
import { McpRuntime } from './runtime.js';
import { Store } from './store.js';
import { registerTools, specOf } from './tools.js';
export const name = 'dsh-mcp-tool';
export const inject = ['mcpManager', 'tools', 'agents', 'workingDirectory', 'storageDomain', 'webServer', 'systemPrompt'];
/** Idle window after which a forgotten lazy server is stopped. */
const IDLE_MS = 10 * 60 * 1000;
/** Upper bound of concurrent lazy MCP processes kept alive from this plugin. */
const MAX_LIVE = 3;
/** How often the pool looks for forgotten servers. */
const SWEEP_MS = 30 * 1000;
const debug = (message) => {
    if (process.env.MCPTOOL_DEBUG !== '1' && process.env.MCPTOOL_DEBUG !== 'true')
        return;
    console.error(`[dsh-mcp-tool] ${message}`);
    const logPath = process.env.MCPTOOL_LOG;
    if (logPath !== undefined && logPath !== '') {
        try {
            appendFileSync(logPath, `${new Date().toISOString()} ${message}\n`);
        }
        catch {
            // Diagnostics must never break the plugin.
        }
    }
};
export function apply(ctx) {
    let store;
    let storeError;
    /** The workspace registry is optional: the folder list only needs it when present.
     *
     * Read through `ctx.get()` on purpose: a plain property access throws for a
     * service that is not declared in `inject`, and declaring it would stall the
     * plugin in profiles that have no web application at all.
     */
    const workspaces = () => {
        let registry;
        try {
            const host = ctx;
            const viaGet = typeof host.get === 'function' ? host.get('workspaceRegistry') : undefined;
            // The property is the fallback for hosts without `get()` (test doubles);
            // on a real host it throws when the service is absent and gets caught.
            registry = (viaGet ?? host.workspaceRegistry);
        }
        catch (error) {
            debug(`workspace registry is not available: ${String(error)}`);
            registry = undefined;
        }
        if (registry === undefined)
            return [];
        try {
            return registry.list().map(workspace => ({
                path: workspace.path,
                ...(workspace.title === undefined ? {} : { title: workspace.title }),
            }));
        }
        catch (error) {
            debug(`workspace list failed: ${String(error)}`);
            return [];
        }
    };
    const runtime = new McpRuntime({
        manager: managerPort(ctx.mcpManager),
        catalog: catalogPort(ctx),
        idleMs: IDLE_MS,
        maxLive: MAX_LIVE,
        // Tools of an eager server are visible without loading it first.
        visibleTo: (agentId, server) => {
            const opened = store;
            if (opened === undefined)
                return false;
            const agent = agentOf(agentId);
            if (agent === undefined)
                return false;
            return opened.resolve(workingDirectoryOf(ctx, agent)).servers.includes(server);
        },
        log: debug,
    });
    const cwdOf = (agentId) => {
        const agent = ctx.agents.get(agentId);
        if (agent === undefined)
            return '';
        // Tracking is idempotent; a session created before the plugin loaded
        // starts being tracked on its first tool step.
        runtime.trackAgent(agent.id);
        return workingDirectoryOf(ctx, agent);
    };
    const policyFor = (_agentId, cwd) => {
        const opened = store;
        if (opened !== undefined)
            return opened.resolve(cwd);
        return { source: 'default', path: null, preset: 'default', servers: [] };
    };
    const allowedNames = (cwd) => policyFor('', cwd).servers;
    /**
     * Finds the agent owning a session.
     *
     * `agents.get` is the fast path; the scan covers a session whose agent id and
     * session id disagree, which the GUI (it only knows the session id) cannot
     * tell apart.
     */
    function agentOf(sessionId) {
        const direct = ctx.agents.get(sessionId);
        if (direct !== undefined)
            return direct;
        try {
            return ctx.agents.list().find(agent => agent.id === sessionId || agent.session?.id === sessionId);
        }
        catch {
            return undefined;
        }
    }
    /**
     * Keeps eager servers running wherever they are switched on, and unpins a
     * server whose load mode was switched back to lazy.
     */
    const syncEager = async () => {
        const opened = store;
        if (opened === undefined)
            return;
        const records = opened.servers().filter(record => record.loadMode === 'eager');
        for (const record of opened.servers()) {
            if (record.loadMode !== 'eager' && runtime.isEager(record.name)) {
                debug(`unpinning ${record.name}`);
                runtime.unpinEager(record.name);
            }
        }
        if (records.length === 0) {
            runtime.refreshVisibility();
            return;
        }
        let agents = [];
        try {
            agents = ctx.agents.list();
        }
        catch (error) {
            debug(`agent list failed: ${String(error)}`);
        }
        for (const agent of agents) {
            const cwd = workingDirectoryOf(ctx, agent);
            const allowed = new Set(opened.resolve(cwd).servers);
            for (const record of records) {
                if (!allowed.has(record.name) || runtime.isEager(record.name))
                    continue;
                debug(`eager start ${record.name} for ${agent.id} (${cwd})`);
                try {
                    await runtime.loadEager(specOf(record));
                }
                catch (error) {
                    debug(`eager start ${record.name} failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            }
        }
        runtime.refreshVisibility();
    };
    const track = (agent) => {
        runtime.trackAgent(agent.id);
        void syncEager();
    };
    const disposers = [];
    ctx.effect?.(() => {
        const offCreated = ctx.on('agent/created', (payload) => {
            if (payload?.agent !== undefined)
                track(payload.agent);
        });
        disposers.push(offCreated);
        return () => {
            for (const dispose of disposers.splice(0))
                dispose();
        };
    }, 'mcp-tool: agent tracking');
    // Sessions that already exist when the plugin is mounted.
    void Promise.resolve().then(() => {
        try {
            for (const agent of ctx.agents.list()) {
                runtime.trackAgent(agent.id);
            }
        }
        catch (error) {
            debug(`initial agent scan failed: ${String(error)}`);
        }
    });
    ctx.on('agent/disposed', (payload) => {
        if (payload?.agent !== undefined)
            runtime.untrackAgent(payload.agent.id);
    });
    // Real tool usage resets the idle window and must not be stopped mid-call.
    ctx.on('tools/pre-execute', async (exec, next) => {
        const server = serverOfTool(exec.name);
        if (server === undefined)
            return next();
        runtime.beginCall(server);
        try {
            return await next();
        }
        finally {
            runtime.endCall(server);
        }
    });
    const timer = setInterval(() => {
        const stopped = runtime.sweep();
        if (stopped.length > 0)
            debug(`idle sweep stopped: ${stopped.join(', ')}`);
    }, SWEEP_MS);
    timer.unref?.();
    const backend = {
        store: () => store,
        storeError: () => storeError,
        live: () => runtime.snapshot(),
        policyForSession: (_sessionId, cwd) => policyFor('', cwd),
        cwdOfSession: (sessionId) => {
            if (sessionId === undefined || sessionId === '')
                return undefined;
            const agent = agentOf(sessionId);
            if (agent === undefined) {
                debug(`no live agent for session ${sessionId}`);
                return undefined;
            }
            return workingDirectoryOf(ctx, agent);
        },
        activeSessionId: () => {
            try {
                const agents = ctx.agents.list().filter(agent => {
                    const cwd = agent.session?.header?.cwd;
                    return typeof cwd === 'string' && cwd !== '';
                });
                // The page opens outside a chat; the newest live agent is the
                // closest thing to "the folder the user is looking at".
                const chosen = agents[agents.length - 1];
                debug(`active session fallback: ${chosen?.id ?? 'none'}`);
                return chosen?.id;
            }
            catch {
                return undefined;
            }
        },
        workspaces,
        changed: () => {
            void syncEager();
        },
        async load(sessionId, server, cwdHint) {
            const agent = agentOf(sessionId);
            const cwd = agent === undefined ? cwdHint ?? '' : workingDirectoryOf(ctx, agent);
            // The holder is the session: it exists even between two agent turns,
            // so a server started from the GUI is not released by accident.
            const holder = agent?.id ?? sessionId;
            runtime.trackAgent(holder);
            const allowed = allowedNames(cwd);
            debug(`load ${server} for ${holder} cwd=${cwd} allowed=[${allowed.join(',')}]`);
            const record = store?.server(server);
            if (record === undefined)
                throw new Error(`unknown MCP server "${server}"`);
            return runtime.load(specOf(record), holder, allowed);
        },
        release(sessionId, server) {
            const released = runtime.holders(server).includes(sessionId);
            const { stopped } = runtime.release(server, sessionId);
            return { released, stopped };
        },
        async exists(path) {
            try {
                return (await stat(path)).isDirectory();
            }
            catch {
                return false;
            }
        },
    };
    const routes = registerRoutes(backend, ctx.webServer);
    disposers.push(routes);
    ctx.effect(() => {
        let disposed = false;
        let toolsDispose;
        let promptDispose;
        void (async () => {
            try {
                const opened = await Store.open(ctx.storageDomain);
                if (disposed) {
                    await opened.close();
                    return;
                }
                store = opened;
                debug('registry opened');
                toolsDispose = registerTools({
                    store: opened,
                    runtime,
                    policyFor,
                    cwdOf,
                    register: (definition) => ctx.tools.register(definition, definition.when === undefined ? {} : { when: definition.when }),
                });
                promptDispose = ctx.systemPrompt.section({
                    name: SECTION_NAME,
                    order: SECTION_ORDER,
                    text: ({ agent }) => {
                        if (agent === undefined)
                            return '';
                        const cwd = cwdOf(agent.id);
                        if (cwd === '')
                            return '';
                        const resolution = policyFor(agent.id, cwd);
                        const servers = resolution.servers
                            .map(serverName => store?.server(serverName))
                            .filter((record) => record !== undefined);
                        return promptText(cwd, resolution, servers);
                    },
                });
                await syncEager();
            }
            catch (error) {
                storeError = error instanceof Error ? error.message : String(error);
                debug(`registry failed to open: ${storeError}`);
            }
        })();
        return () => {
            disposed = true;
            toolsDispose?.();
            toolsDispose = undefined;
            promptDispose?.();
            promptDispose = undefined;
            const opened = store;
            store = undefined;
            void opened?.close();
            clearInterval(timer);
            runtime.dispose();
        };
    }, 'mcp-tool: runtime');
}
