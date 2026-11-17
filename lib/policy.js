/**
 * Folder policy: which preset a working directory uses, and which servers that
 * preset resolves to.
 *
 * The rules are deliberately small and pure so they can be unit-tested without
 * a host: a working folder inherits the assignment of its nearest assigned
 * ancestor, and a preset maps server names to `on`, `off`, or `inherit`. A
 * missing row means `inherit`, which reads the `default` preset; inside the
 * `default` preset a missing row means `on`, so a freshly registered server is
 * available everywhere until it is switched off.
 *
 * @module dsh-mcp-tool/policy
 */
import { resolve } from 'node:path';
/** Name of the preset applied to folders without their own assignment. */
export const DEFAULT_PRESET = 'default';
/**
 * Canonical form used for every comparison and for stored keys: absolute,
 * forward slashes, no trailing separator, lowercase on Windows.
 */
export function canonicalPath(input) {
    let value = resolve(input).replace(/\\/g, '/');
    if (value.length > 1)
        value = value.replace(/\/+$/, '');
    return process.platform === 'win32' ? value.toLowerCase() : value;
}
/** True when `ancestor` is `descendant` itself or one of its parent folders. */
export function isAncestorOrSelf(ancestor, descendant) {
    if (ancestor === descendant)
        return true;
    return descendant.startsWith(ancestor.endsWith('/') ? ancestor : `${ancestor}/`);
}
/** The nearest assignment covering `cwd`, or the default preset. */
export function resolveFolderPreset(cwd, folders) {
    const target = canonicalPath(cwd);
    let best;
    for (const folder of folders) {
        const candidate = canonicalPath(folder.path);
        if (!isAncestorOrSelf(candidate, target))
            continue;
        if (best === undefined || candidate.length > canonicalPath(best.path).length) {
            best = { ...folder, path: candidate };
        }
    }
    if (best !== undefined)
        return { path: best.path, preset: best.preset };
    return { path: null, preset: DEFAULT_PRESET };
}
/** State of one server inside the `default` preset: a missing row means `on`. */
function defaultState(defaultPreset, server) {
    const state = defaultPreset?.rows[server];
    return state === 'off' ? 'off' : 'on';
}
/**
 * Resolves the effective allowlist: the assigned preset first, `inherit` rows
 * (and missing rows) read the `default` preset, and only `on` servers survive.
 */
export function resolveAllowed(cwd, folders, presets, serverNames) {
    const assigned = cwd === '' ? { path: null, preset: DEFAULT_PRESET } : resolveFolderPreset(cwd, folders);
    const preset = presets.find(entry => entry.name === assigned.preset);
    const defaults = presets.find(entry => entry.name === DEFAULT_PRESET);
    const names = [...new Set(serverNames)].sort((left, right) => left.localeCompare(right));
    const servers = [];
    for (const name of names) {
        const row = preset?.rows[name];
        const state = row === undefined || row === 'inherit' ? defaultState(defaults, name) : row;
        if (state === 'on')
            servers.push(name);
    }
    return {
        source: assigned.path === null ? 'default' : 'folder',
        path: assigned.path,
        preset: assigned.preset,
        servers,
    };
}
