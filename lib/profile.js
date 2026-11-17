import { ActivationError, } from './runtime.js';
const defaultSleep = (ms) => new Promise(resolve => {
    setTimeout(resolve, ms);
});
const STOP_TIMEOUT_MS = 10_000;
/**
 * The manager-backed profile runtime.
 *
 * The manager reconciles its entries asynchronously after the settings change,
 * so every transition is a poll on `manager.status`. Operations on one server
 * are serialised: two flips racing each other would leave the entry in an
 * unpredictable state.
 */
export function managerProfile(control, manager, catalog, sleep = defaultSleep) {
    const owned = new Set();
    const tails = new Map();
    const serial = (server, run) => {
        const previous = tails.get(server) ?? Promise.resolve();
        const next = previous.then(run, run);
        tails.set(server, next.then(() => undefined, () => undefined));
        return next;
    };
    const waitFor = async (server, want, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            const status = manager.status(server);
            if (want === 'ready') {
                if (status === 'ready')
                    return;
                if (status === 'failed') {
                    throw new ActivationError(manager.detail?.(server) ?? `MCP server "${server}" failed to start`, server, 'failed');
                }
            }
            else if (status === 'stopped' || status === 'inactive' || status === 'failed') {
                return;
            }
            if (Date.now() >= deadline) {
                throw new ActivationError(want === 'ready'
                    ? `MCP server "${server}" did not start within ${timeoutMs} ms`
                    : `MCP server "${server}" did not stop within ${timeoutMs} ms`, server, 'timeout');
            }
            await sleep(50);
        }
    };
    return {
        mounts: false,
        start(server, startupTimeoutMs) {
            return serial(server, async () => {
                if (manager.status(server) === 'ready')
                    return;
                await control.setEnabled(server, true);
                owned.add(server);
                try {
                    await waitFor(server, 'ready', startupTimeoutMs);
                    await catalog.ready?.(server, startupTimeoutMs);
                }
                catch (error) {
                    owned.delete(server);
                    await control.setEnabled(server, false).catch(() => undefined);
                    throw error;
                }
            });
        },
        stop(server) {
            return serial(server, async () => {
                if (!owned.has(server))
                    return;
                owned.delete(server);
                await control.setEnabled(server, false);
                await waitFor(server, 'stopped', STOP_TIMEOUT_MS).catch(() => undefined);
            });
        },
        status(server) {
            return manager.status(server);
        },
        started(server) {
            return owned.has(server);
        },
        async dispose() {
            const names = [...owned];
            owned.clear();
            for (const name of names) {
                await control.setEnabled(name, false).catch(() => undefined);
            }
        },
    };
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
export function mountProfile(opener, control, sleep = defaultSleep) {
    const mounts = new Map();
    const failures = new Map();
    const tails = new Map();
    const serial = (server, run) => {
        const previous = tails.get(server) ?? Promise.resolve();
        const next = previous.then(run, run);
        tails.set(server, next.then(() => undefined, () => undefined));
        return next;
    };
    const waitForTools = async (server, session, timeoutMs) => {
        const deadline = Date.now() + timeoutMs;
        for (;;) {
            if (session.tools().length > 0)
                return;
            if (Date.now() >= deadline) {
                throw new ActivationError(`MCP server "${server}" did not publish tools within ${timeoutMs} ms`, server, 'timeout');
            }
            await sleep(50);
        }
    };
    return {
        mounts: true,
        tools(server) {
            return mounts.get(server)?.session.tools() ?? [];
        },
        start(server, startupTimeoutMs) {
            return serial(server, async () => {
                const existing = mounts.get(server);
                if (existing !== undefined) {
                    await waitForTools(server, existing.session, startupTimeoutMs);
                    return;
                }
                failures.delete(server);
                // An entry that is already off stays off, so a failed mount does not
                // switch the user's setting on behind their back.
                const before = control.current?.(server) ?? true;
                let flipped = false;
                try {
                    if (before !== false) {
                        await control.setEnabled(server, false);
                        flipped = true;
                    }
                }
                catch (error) {
                    // An entry that cannot be switched off is still worth trying:
                    // the mount may fail on the name clash, and that error says why.
                    if (error instanceof ActivationError)
                        throw error;
                }
                let session;
                try {
                    session = await opener.open(server);
                    mounts.set(server, { session, flipped });
                    await waitForTools(server, session, startupTimeoutMs);
                }
                catch (error) {
                    mounts.delete(server);
                    await session?.dispose().catch(() => undefined);
                    if (flipped)
                        await control.setEnabled(server, true).catch(() => undefined);
                    failures.set(server, error instanceof Error ? error.message : String(error));
                    throw error;
                }
            });
        },
        stop(server) {
            return serial(server, async () => {
                const mount = mounts.get(server);
                if (mount === undefined)
                    return;
                mounts.delete(server);
                await mount.session.dispose().catch(() => undefined);
                if (mount.flipped)
                    await control.setEnabled(server, true).catch(() => undefined);
            });
        },
        status(server) {
            const mount = mounts.get(server);
            if (mount === undefined)
                return failures.has(server) ? 'failed' : 'stopped';
            return mount.session.tools().length > 0 ? 'ready' : 'starting';
        },
        started(server) {
            return mounts.has(server);
        },
        async dispose() {
            const names = [...mounts.keys()];
            for (const name of names) {
                await this.stop(name).catch(() => undefined);
            }
        },
    };
}
/**
 * The `auto` lifecycle: per server, mount what the settings keep enabled
 * (its name is taken in the root scope) and flip what they keep disabled.
 */
export function hybridProfile(flip, mount, useMount) {
    // Whoever actually holds the server decides: a flipped entry is enabled in
    // the settings, so the settings alone no longer say who owns it.
    const pick = (server) => {
        if (flip.started(server))
            return flip;
        if (mount.started(server))
            return mount;
        return useMount(server) ? mount : flip;
    };
    return {
        mounts: true,
        tools(server) {
            return useMount(server) ? mount.tools(server) : [];
        },
        start(server, startupTimeoutMs) {
            return pick(server).start(server, startupTimeoutMs);
        },
        stop(server) {
            return pick(server).stop(server);
        },
        status(server) {
            return pick(server).status(server);
        },
        started(server) {
            return pick(server).started(server);
        },
        async dispose() {
            await mount.dispose().catch(() => undefined);
            await flip.dispose().catch(() => undefined);
        },
    };
}
