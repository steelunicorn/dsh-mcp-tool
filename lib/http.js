/**
 * HTTP routes the settings page and the composer chip talk to.
 *
 * Plugin routes bypass the web server's cookie gate, so every handler treats
 * its input as untrusted: JSON only, bounded body, validated names.
 *
 * @module dsh-mcp-tool/http
 */
import { DEFAULT_PRESET } from './policy.js';
/** Route prefix owned by this plugin. */
export const ROUTE_PREFIX = '/dsh-mcp-tool';
const json = (res, code, payload) => {
    const body = JSON.stringify(payload);
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(body);
};
const MAX_BODY = 256 * 1024;
/**
 * Header the GUI must add to every mutating request. Plugin routes are reachable
 * without the cookie gate, so a cross-site form POST (a "simple" request that
 * skips CORS preflight) must not be able to register a server or a folder rule:
 * a custom header forces a preflight the route never answers.
 */
const CSRF_HEADER = 'x-dsh-mcp-tool';
function authorized(req) {
    const headers = req.headers;
    const token = headers[CSRF_HEADER];
    const contentType = headers['content-type'] ?? '';
    const type = Array.isArray(contentType) ? contentType.join(';') : contentType;
    const sameOrigin = Array.isArray(token) ? token.includes('1') : token === '1';
    return sameOrigin && type !== undefined && type.toLowerCase().startsWith('application/json');
}
async function readJson(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        const buffer = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
        size += buffer.length;
        if (size > MAX_BODY)
            throw new Error('request body is too large');
        chunks.push(buffer);
    }
    if (size === 0)
        return {};
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        throw new Error('expected a JSON object');
    return parsed;
}
function requireString(body, field) {
    const value = body[field];
    if (typeof value !== 'string' || value.trim() === '')
        throw new Error(`"${field}" must be a non-empty string`);
    return value.trim();
}
function optionalString(body, field) {
    const value = body[field];
    if (value === undefined || value === null)
        return undefined;
    if (typeof value !== 'string')
        throw new Error(`"${field}" must be a string`);
    return value;
}
function stringList(body, field) {
    const value = body[field];
    if (!Array.isArray(value) || value.some(entry => typeof entry !== 'string')) {
        throw new Error(`"${field}" must be an array of strings`);
    }
    return [...new Set(value)];
}
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function stringValues(value) {
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string')
            out[key] = entry;
    }
    return out;
}
/** Reads the `on`/`off`/`inherit` rows of a preset. */
function presetRows(body) {
    const value = body.rows;
    if (!isRecord(value))
        throw new Error('"rows" must be an object of server switches');
    const rows = {};
    for (const [server, state] of Object.entries(value)) {
        if (state !== 'on' && state !== 'off' && state !== 'inherit') {
            throw new Error(`"rows.${server}" must be "on", "off", or "inherit"`);
        }
        rows[server] = state;
    }
    return rows;
}
/** Reads one server record from a request body. */
function serverFromBody(body) {
    const name = requireString(body, 'name');
    const transport = body.transport === 'http' ? 'http' : 'stdio';
    const record = { name, transport };
    const description = optionalString(body, 'description');
    if (description !== undefined)
        record.description = description;
    const loadMode = body.loadMode === 'eager' ? 'eager' : 'lazy';
    record.loadMode = loadMode;
    if (transport === 'stdio') {
        record.command = requireString(body, 'command');
        record.args = Array.isArray(body.args) ? stringList(body, 'args') : [];
        record.env = isRecord(body.env) ? stringValues(body.env) : {};
        const cwd = optionalString(body, 'cwd');
        if (cwd !== undefined && cwd !== '')
            record.cwd = cwd;
    }
    else {
        record.url = requireString(body, 'url');
        record.headers = isRecord(body.headers) ? stringValues(body.headers) : {};
    }
    const timeout = body.toolCallTimeoutMs;
    if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0)
        record.toolCallTimeoutMs = timeout;
    const startup = body.startupTimeoutMs;
    if (typeof startup === 'number' && Number.isFinite(startup) && startup > 0)
        record.startupTimeoutMs = startup;
    return record;
}
/** Refuses an edit of a server the DSH MCP settings own. */
function refuseProfile(store, name) {
    if (store.server(name)?.origin !== 'profile')
        return;
    throw new Error(`server "${name}" is configured in the DSH MCP settings; edit it there`);
}
/**
 * Registers the plugin routes.
 * @returns the disposer removing them.
 */
export function registerRoutes(backend, webServer) {
    return webServer.register({
        kind: 'prefix',
        path: ROUTE_PREFIX,
        async handler(req, res) {
            try {
                const url = new URL(req.url ?? '/', 'http://dsh');
                const route = url.pathname.slice(ROUTE_PREFIX.length) || '/';
                if (req.method !== 'GET' && !authorized(req)) {
                    json(res, 403, { ok: false, error: `a mutation requires a JSON body and the ${CSRF_HEADER}: 1 header` });
                    return;
                }
                const store = backend.store();
                if (store === undefined) {
                    const detail = backend.storeError?.();
                    json(res, 503, {
                        ok: false,
                        error: detail === undefined
                            ? 'the MCP tool registry is still starting'
                            : `the MCP tool registry failed to open: ${detail}`,
                    });
                    return;
                }
                if (req.method === 'GET' && route === '/state') {
                    const sessionId = url.searchParams.get('sessionId') ?? undefined;
                    const cwdHint = url.searchParams.get('cwd') ?? undefined;
                    // Opening the page mirrors the DSH MCP settings, so a server
                    // added or removed in the profile shows up without a restart.
                    await backend.syncProfile?.();
                    await backend.syncCatalog?.();
                    json(res, 200, state(backend, store, sessionId, cwdHint));
                    return;
                }
                if (req.method === 'GET' && route === '/workspaces') {
                    json(res, 200, {
                        ok: true,
                        workspaces: backend.workspaces?.() ?? [],
                        folders: store.folders().map(folder => ({ path: folder.path, preset: folder.preset })),
                    });
                    return;
                }
                if (req.method === 'POST' && route === '/server') {
                    const record = serverFromBody(await readJson(req));
                    refuseProfile(store, record.name);
                    await store.putServer(record);
                    backend.changed?.();
                    json(res, 200, { ok: true });
                    return;
                }
                if (req.method === 'POST' && route === '/server/delete') {
                    const body = await readJson(req);
                    const name = requireString(body, 'name');
                    refuseProfile(store, name);
                    await store.deleteServer(name);
                    backend.changed?.();
                    json(res, 200, { ok: true });
                    return;
                }
                if (req.method === 'POST' && route === '/preset') {
                    const body = await readJson(req);
                    await store.putPreset({
                        name: requireString(body, 'name'),
                        rows: presetRows(body),
                        updatedAt: Date.now(),
                    });
                    backend.changed?.();
                    json(res, 200, { ok: true });
                    return;
                }
                if (req.method === 'POST' && route === '/preset/delete') {
                    const body = await readJson(req);
                    json(res, 200, { ok: true, removed: await store.deletePreset(requireString(body, 'name')) });
                    backend.changed?.();
                    return;
                }
                if (req.method === 'POST' && route === '/folder') {
                    const body = await readJson(req);
                    await store.putFolder(requireString(body, 'path'), optionalString(body, 'preset') ?? DEFAULT_PRESET);
                    backend.changed?.();
                    json(res, 200, { ok: true });
                    return;
                }
                if (req.method === 'POST' && route === '/folder/delete') {
                    const body = await readJson(req);
                    json(res, 200, { ok: true, removed: await store.deleteFolder(requireString(body, 'path')) });
                    backend.changed?.();
                    return;
                }
                if (req.method === 'POST' && route === '/settings') {
                    const body = await readJson(req);
                    const current = store.settings();
                    const next = { ...current };
                    if (body.showChip !== undefined) {
                        if (typeof body.showChip !== 'boolean')
                            throw new Error('"showChip" must be a boolean');
                        next.showChip = body.showChip;
                    }
                    if (body.profileLifecycle !== undefined) {
                        const value = body.profileLifecycle;
                        if (value !== 'auto' && value !== 'flip' && value !== 'mount') {
                            throw new Error('"profileLifecycle" must be "auto", "flip" or "mount"');
                        }
                        next.profileLifecycle = value;
                    }
                    await store.setSettings(next);
                    backend.changed?.();
                    json(res, 200, { ok: true });
                    return;
                }
                if (req.method === 'POST' && route === '/activate') {
                    const body = await readJson(req);
                    const sessionId = requireString(body, 'sessionId');
                    const server = requireString(body, 'server');
                    if (body.action === 'release') {
                        json(res, 200, { ok: true, ...backend.release(sessionId, server) });
                        return;
                    }
                    const loaded = await backend.load(sessionId, server, optionalString(body, 'cwd'));
                    json(res, 200, { ok: true, server: loaded.name, tools: loaded.tools.map(tool => tool.name) });
                    return;
                }
                if (req.method === 'POST' && (route === '/profile/enabled' || route === '/debug/profile-enabled')) {
                    const setter = backend.setProfileEnabled;
                    if (setter === undefined) {
                        json(res, 404, { ok: false, error: `unknown route ${route}` });
                        return;
                    }
                    const body = await readJson(req);
                    const server = requireString(body, 'server');
                    if (typeof body.enabled !== 'boolean')
                        throw new Error('enabled must be a boolean');
                    await setter(server, body.enabled);
                    json(res, 200, { ok: true, server, enabled: body.enabled });
                    return;
                }
                if (req.method === 'GET' && route === '/folder-exists') {
                    const path = url.searchParams.get('path') ?? '';
                    json(res, 200, { ok: true, exists: path !== '' && await backend.exists(path) });
                    return;
                }
                json(res, 404, { ok: false, error: `unknown route ${route}` });
            }
            catch (error) {
                json(res, 400, { ok: false, error: error instanceof Error ? error.message : String(error) });
            }
        },
    });
}
/**
 * Builds the GUI state document.
 *
 * The folder comes from the live agent; when the session has none (between two
 * turns, or a session this plugin never saw) the GUI's own `cwd` hint is used,
 * so the chip still describes the folder the user is looking at.
 */
function state(backend, store, sessionId, cwdHint) {
    const hinted = cwdHint === undefined || cwdHint === '' ? undefined : cwdHint;
    const resolvedSession = sessionId ?? backend.activeSessionId?.();
    const cwd = backend.cwdOfSession(resolvedSession) ?? hinted ?? '';
    const resolution = backend.policyForSession(resolvedSession, cwd);
    const live = new Map(backend.live().map(entry => [entry.name, entry]));
    const servers = store.servers().map(record => {
        const entry = live.get(record.name);
        return {
            name: record.name,
            description: record.description ?? '',
            transport: record.transport,
            loadMode: record.loadMode ?? 'lazy',
            origin: record.origin ?? 'manual',
            command: record.command ?? '',
            args: record.args ?? [],
            env: record.env ?? {},
            cwd: record.cwd ?? '',
            url: record.url ?? '',
            headers: record.headers ?? {},
            toolCallTimeoutMs: record.toolCallTimeoutMs ?? 0,
            startupTimeoutMs: record.startupTimeoutMs ?? 0,
            status: entry?.status ?? 'inactive',
            // A row exists for a profile server even while the DSH manager keeps it
            // stopped, so liveness follows the status instead of the row.
            live: entry !== undefined && (entry.status === 'ready' || entry.status === 'starting'),
            holders: entry?.holders ?? [],
            // Cached from the last scan, so a stopped server still shows its size.
            toolCount: entry?.toolCount || store.catalog(record.name).length,
            catalogAt: store.catalogAt(record.name) ?? 0,
            allowed: resolution.servers.includes(record.name),
            // Whether the settings keep the server switched off, and whether this
            // plugin is the one that started it on demand.
            profileEnabled: record.origin === 'profile' ? record.profileEnabled !== false : false,
            owned: backend.profileOwned?.(record.name) === true,
        };
    });
    return {
        ok: true,
        sessionId: resolvedSession,
        cwd,
        source: resolution.source,
        preset: resolution.preset,
        folderPath: resolution.path,
        settings: store.settings(),
        servers,
        // The `default` preset is synthesized rather than stored, but the page
        // must always show its tab: dropping it would leave the user without a
        // way back from a named preset.
        presets: [store.defaultPreset(), ...store.presets().filter(preset => preset.name !== DEFAULT_PRESET)]
            .map(preset => ({
            name: preset.name,
            rows: preset.rows,
            updatedAt: preset.updatedAt ?? 0,
        })),
        folders: store.folders().map(folder => ({ path: folder.path, preset: folder.preset })),
        workspaces: backend.workspaces?.() ?? [],
    };
}
