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
import { z } from 'zod';
import { DEFAULT_PRESET, canonicalPath, resolveAllowed } from './policy.js';
/** Server names double as the MCP tool namespace, so the host's pattern applies. */
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
const stringMap = z.record(z.string(), z.string());
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
}).strict();
const presetSchema = z.object({
    name: z.string().min(1),
    rows: z.record(z.string(), z.enum(['on', 'off', 'inherit'])),
    updatedAt: z.number().optional(),
}).strict();
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
}).strict();
const globalSchema = z.object({
    showChip: z.boolean().optional(),
    /** Left over from the first release; ignored and rewritten on save. */
    defaultServers: z.array(z.string()).optional(),
}).strict();
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
    global: { schema: globalSchema, initial: { showChip: true } },
    tables: {
        servers: { valueSchema: serverSchema },
        presets: { valueSchema: presetSchema },
        workspaces: { valueSchema: folderSchema },
    },
};
/** Validates one record before it is written. */
export function parseServer(value) {
    return serverSchema.parse(value);
}
/** Validates one preset before it is written. */
export function parsePreset(value) {
    return presetSchema.parse(value);
}
/** Validates one folder assignment before it is written. */
export function parseFolder(value) {
    return folderSchema.parse(value);
}
/** Registry facade over the opened domain. */
export class Store {
    domain;
    serverTable;
    presetTable;
    folderTable;
    constructor(domain) {
        this.domain = domain;
        this.serverTable = domain.table('servers');
        this.presetTable = domain.table('presets');
        this.folderTable = domain.table('workspaces');
    }
    /** Opens the durable domain, dropping records of the pre-preset release. */
    static async open(storageDomain) {
        const store = new Store(await storageDomain.open(domainSpec));
        for (const folder of store.rawFolders()) {
            if (folder.preset === undefined)
                await store.folderTable.delete(folder.path);
        }
        return store;
    }
    // -- servers ------------------------------------------------------------
    /** Every registered server, ordered by name. */
    servers() {
        return [...this.serverTable.entries()]
            .map(([, record]) => record)
            .sort((left, right) => left.name.localeCompare(right.name));
    }
    /** One registered server. */
    server(name) {
        return this.serverTable.get(name);
    }
    /** Creates or replaces one server. */
    async putServer(record) {
        await this.serverTable.put(record.name, parseServer(record));
    }
    /** Removes one server and forgets it in every preset. */
    async deleteServer(name) {
        if (!(await this.serverTable.delete(name)))
            return;
        for (const preset of this.presets()) {
            if (!(name in preset.rows))
                continue;
            const rows = { ...preset.rows };
            delete rows[name];
            await this.putPreset({ ...preset, rows, updatedAt: Date.now() });
        }
    }
    // -- presets ------------------------------------------------------------
    /** Every preset, `default` first, then by name. */
    presets() {
        return [...this.presetTable.entries()]
            .map(([, record]) => record)
            .sort((left, right) => {
            if (left.name === DEFAULT_PRESET)
                return -1;
            if (right.name === DEFAULT_PRESET)
                return 1;
            return left.name.localeCompare(right.name);
        });
    }
    /** One preset by name; the `default` preset always exists. */
    preset(name) {
        const stored = this.presetTable.get(name);
        if (stored !== undefined)
            return stored;
        return name === DEFAULT_PRESET ? { name: DEFAULT_PRESET, rows: {} } : undefined;
    }
    /** The `default` preset, materialised even when never edited. */
    defaultPreset() {
        return this.preset(DEFAULT_PRESET);
    }
    /** Creates or replaces one preset. `inherit` is meaningless in `default`. */
    async putPreset(preset) {
        const rows = {};
        for (const [server, state] of Object.entries(preset.rows)) {
            if (!SERVER_NAME.test(server))
                continue;
            rows[server] = preset.name === DEFAULT_PRESET && state === 'inherit' ? 'on' : state;
        }
        const name = preset.name.trim();
        if (name === '')
            throw new Error('a preset needs a name');
        await this.presetTable.put(name, parsePreset({ name, rows, updatedAt: Date.now() }));
    }
    /** Removes one preset; `default` is not removable and folders fall back. */
    async deletePreset(name) {
        if (name === DEFAULT_PRESET)
            throw new Error('the default preset cannot be removed');
        const removed = await this.presetTable.delete(name);
        if (!removed)
            return false;
        for (const folder of this.folders()) {
            if (folder.preset === name)
                await this.folderTable.delete(folder.path);
        }
        return true;
    }
    // -- folder assignments -------------------------------------------------
    rawFolders() {
        return [...this.folderTable.entries()]
            .map(([, record]) => record)
            .sort((left, right) => left.path.localeCompare(right.path));
    }
    /** Every folder assignment, ordered by path. */
    folders() {
        return this.rawFolders().filter(folder => folder.preset !== undefined);
    }
    /** The assignment stored for exactly this path. */
    folder(path) {
        const found = this.folderTable.get(canonicalPath(path));
        return found?.preset === undefined ? undefined : found;
    }
    /** Assigns a preset to a folder; `default` clears the assignment. */
    async putFolder(path, preset) {
        const key = canonicalPath(path);
        if (preset === DEFAULT_PRESET || preset === '') {
            await this.folderTable.delete(key);
            return;
        }
        await this.folderTable.put(key, parseFolder({ path: key, preset, updatedAt: Date.now() }));
    }
    /** Clears one folder assignment. */
    async deleteFolder(path) {
        return this.folderTable.delete(canonicalPath(path));
    }
    // -- settings -----------------------------------------------------------
    /** Current global settings. */
    settings() {
        const raw = this.domain.global.get();
        return { showChip: typeof raw?.showChip === 'boolean' ? raw.showChip : true };
    }
    /** Replaces global settings. */
    async setSettings(next) {
        await this.domain.global.set({ showChip: next.showChip === true });
    }
    // -- resolution ---------------------------------------------------------
    /**
     * The effective allowlist for a folder: the nearest assigned preset, its
     * `on`/`off`/`inherit` rows resolved against the `default` preset.
     */
    resolve(cwd) {
        return resolveAllowed(cwd, this.folders(), this.presets(), this.servers().map(server => server.name));
    }
    /** Releases the domain handle. */
    async close() {
        await this.domain.close();
    }
}
