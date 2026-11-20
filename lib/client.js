window.__ModuleLoader__.load({
	id: 'dsh-mcp-tool',
	factory(require) {
		/**
		 * Browser half of dsh-mcp-tool.
		 *
		 * A settings page (registry, presets, folder assignments) and one composer chip
		 * that switches the preset of the open folder. Everything it knows comes from
		 * the plugin's own `/dsh-mcp-tool` routes; components never see Cordis `ctx`.
		 *
		 * The file has no value imports on purpose: the compiled body is wrapped into a
		 * `factory(require)` by `scripts/wrap-client.mjs`, so React and friends are
		 * reached through that factory's `require`.
		 *
		 * @module dsh-mcp-tool/client
		 */
		const React = require('react');
		const ReactDOM = require('react-dom');
		const h = React.createElement;
		// The factory's `require` hands back untyped values; these declarations give the
		// hooks their React typing so `useState<T>()` stays legal.
		const useState = React.useState;
		const useEffect = React.useEffect;
		const useCallback = React.useCallback;
		const useMemo = React.useMemo;
		const useRef = React.useRef;
		const NS = 'mcp-tool';
		const ROUTE = '/dsh-mcp-tool';
		const SECTION_ID = 'mcp-tool';
		const DEFAULT_PRESET = 'default';
		// Inline styles cannot express `:hover`, but the shell's own buttons paint the
		// `interactive-bg-hover` fill on hover. One small stylesheet scoped to our own
		// containers restores that feedback (and the focus ring) for free.
		const CSS = [
		    '[data-mcptool] button { -webkit-font-smoothing: antialiased; text-autospace: normal; }',
		    '[data-mcptool] button:not([data-chip]):not([data-fill]):hover { background: var(--dsw-alias-interactive-bg-hover, #ffffff14); }',
		    '[data-mcptool] button:not([data-chip]):not([data-fill]):active { background: var(--dsw-alias-interactive-bg-active, #ffffff24); }',
		    '[data-mcptool] button[data-fill]:hover { filter: brightness(1.14); }',
		    '[data-mcptool] button[data-fill]:active { filter: brightness(1.28); }',
		    '[data-mcptool] button:focus-visible { outline: 2px solid var(--dsw-alias-border-selected, #adb2b8); outline-offset: 1px; }',
		].join('\n');
		/** Namespaces and slot ids announced to the shell. */
		const inject = ['slots', 'locale'];
		// ---------------------------------------------------------------------------
		// Host calls
		// ---------------------------------------------------------------------------
		async function request(path, body) {
		    const response = body === undefined
		        ? await fetch(`${ROUTE}${path}`, { headers: { accept: 'application/json' } })
		        : await fetch(`${ROUTE}${path}`, {
		            method: 'POST',
		            headers: { 'content-type': 'application/json', 'x-dsh-mcp-tool': '1' },
		            body: JSON.stringify(body),
		        });
		    const doc = await response.json().catch(() => undefined);
		    if (doc === undefined || doc === null || doc.ok !== true) {
		        throw new Error(typeof doc?.error === 'string' ? doc.error : `request failed with ${response.status}`);
		    }
		    return doc;
		}
		/**
		 * Reads `/state` now and every few seconds while the surface is mounted.
		 *
		 * The folder hint travels with the request: the plugin resolves it from the
		 * session's agent when one is alive, otherwise the hint is what the GUI sees.
		 */
		function useStateDoc(sessionId, tick, cwd) {
		    const [doc, setDoc] = useState(undefined);
		    const [error, setError] = useState(undefined);
		    const [local, setLocal] = useState(0);
		    const reload = useCallback(() => setLocal((value) => value + 1), []);
		    useEffect(() => {
		        let mounted = true;
		        const params = [];
		        if (sessionId !== undefined)
		            params.push(`sessionId=${encodeURIComponent(sessionId)}`);
		        if (cwd !== undefined && cwd !== '')
		            params.push(`cwd=${encodeURIComponent(cwd)}`);
		        const query = params.length === 0 ? '' : `?${params.join('&')}`;
		        const load = () => {
		            request(`/state${query}`).then((next) => {
		                if (!mounted)
		                    return;
		                setDoc(next);
		                setError(undefined);
		            }, (cause) => {
		                if (!mounted)
		                    return;
		                setError(messageOf(cause));
		            });
		        };
		        load();
		        const handle = setInterval(load, 3000);
		        return () => {
		            mounted = false;
		            clearInterval(handle);
		        };
		    }, [sessionId, cwd, tick, local]);
		    return { doc, error, reload };
		}
		function messageOf(cause) {
		    return cause instanceof Error ? cause.message : String(cause);
		}
		/** Working directory of the session whose composer hosts this chip. */
		function useSessionCwd(props) {
		    const sessionId = props?.sessionId;
		    const useSessions = props?.useSessions;
		    const cwd = typeof useSessions === 'function'
		        ? useSessions((state) => (sessionId === undefined ? undefined : state?.byId?.[sessionId]?.cwd))
		        : undefined;
		    return typeof cwd === 'string' ? cwd : '';
		}
		/**
		 * The session the main view currently shows.
		 *
		 * The settings page receives no `sessionId`, so the shell's own notion of "the
		 * open conversation" is used instead: the session retained by the main view.
		 */
		function mainSession(state) {
		    const rows = Object.values(state?.byId ?? {});
		    let best;
		    for (const row of rows) {
		        const retained = row?.retainedBy?.mainView ?? 0;
		        if (retained <= 0)
		            continue;
		        if (best === undefined || retained > (best?.retainedBy?.mainView ?? 0))
		            best = row;
		    }
		    return best;
		}
		/** Session and folder the surface should describe: own session, else the open one. */
		function usePanelSession(props) {
		    const own = props?.sessionId;
		    const useSessions = props?.useSessions;
		    const pick = (state) => (own !== undefined && own !== ''
		        ? own
		        : mainSession(state)?.id);
		    const foundId = typeof useSessions === 'function' ? useSessions(pick) : undefined;
		    const foundCwd = typeof useSessions === 'function'
		        ? useSessions((state) => {
		            const id = pick(state);
		            return id === undefined ? undefined : state?.byId?.[id]?.cwd;
		        })
		        : undefined;
		    const sessionId = typeof foundId === 'string' && foundId !== '' ? foundId : undefined;
		    return { sessionId, cwd: typeof foundCwd === 'string' ? foundCwd : '' };
		}
		/** Every folder that currently hosts a session, for the folder picker. */
		function knownFolders(useSessions) {
		    const state = typeof useSessions === 'function' ? useSessions((value) => value) : undefined;
		    const byId = state?.byId;
		    if (byId === undefined)
		        return [];
		    const seen = new Set();
		    for (const key of Object.keys(byId)) {
		        const cwd = byId[key]?.cwd;
		        if (typeof cwd === 'string' && cwd !== '')
		            seen.add(cwd);
		    }
		    return [...seen].sort();
		}
		// ---------------------------------------------------------------------------
		// Small presentation helpers
		// ---------------------------------------------------------------------------
		const STATUS_COLOR = {
		    ready: '#2e9e5b',
		    starting: '#d9a441',
		    failed: '#d24b4b',
		    stopped: '#8a8a8a',
		    inactive: '#8a8a8a',
		};
		// Surface colours come from the shell's own alias tokens (declared on `body`,
		// so they also resolve inside portals). Every token keeps a light-theme
		// fallback: a missing variable must never paint a white card on a dark panel.
		const TEXT = 'var(--dsw-alias-label-primary, #1a1a1a)';
		const TEXT_DIM = 'var(--dsw-alias-label-secondary, #555)';
		const BORDER = 'var(--dsw-alias-border-l2, #d0d0d0)';
		const BORDER_SOFT = 'var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06))';
		const SURFACE_POPOVER = 'var(--dsw-alias-bg-layer-3, #ffffff)';
		const ACCENT = 'var(--dsw-alias-brand-primary, #1f1f1f)';
		// In dark mode the brand fill is a light pill, so its label must invert too.
		const ON_ACCENT = 'var(--dsw-alias-label-primary-inverted, #ffffff)';
		const HOVER = 'var(--dsw-alias-button-ghost-active-fill, rgba(0, 0, 0, 0.06))';
		// Shared metrics for every button-like control: one height keeps rows of
		// different widgets aligned, one font size keeps the labels comparable.
		// Mirrors the app's own small outline button (`_button _outline _sm`): height
		// 28, 12/18 type, 10px padding, hairline inset outline, transparent fill. Using
		// the same numbers keeps plugin controls identical to the surrounding UI.
		const CONTROL = {
		    display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: '4px',
		    boxSizing: 'border-box', height: '28px', padding: '0 10px',
		    borderRadius: 'var(--dsw-radius-sm, 8px)', fontSize: '12px', lineHeight: '18px',
		    fontFamily: 'inherit', cursor: 'pointer', whiteSpace: 'nowrap',
		    color: TEXT, background: 'transparent',
		    border: '0.5px solid transparent',
		    // Squircle corners: the shell sets `corner-shape: superellipse(1.5)` on its
		    // own buttons, which is what makes them look softer than a plain radius.
		    cornerShape: 'var(--dsw-corner-shape, superellipse(1.5))',
		    boxShadow: 'inset 0 0 0 var(--dsh-hairline-width, 1px) var(--dsh-button-outline-color, var(--dsw-alias-border-l3, rgba(255, 255, 255, 0.16)))',
		};
		// The active state of a segmented control: the app's hover fill, no border.
		const CONTROL_ACTIVE = {
		    background: 'var(--dsw-alias-interactive-bg-hover, #ffffff14)',
		    color: TEXT,
		};
		// The utility rows put two fixed-width buttons on the right. Fixing their widths
		// lets the profile start button span exactly the same block (76 + 8 + 68).
		const ACTION_EDIT_WIDTH = 76;
		const ACTION_DELETE_WIDTH = 68;
		const ACTION_GAP = 8;
		const ACTION_SPAN = `${ACTION_EDIT_WIDTH + ACTION_GAP + ACTION_DELETE_WIDTH}px`;
		const styles = {
		    // The page is a column: a fixed header and one scrolling region. Giving the
		    // scroll its own box keeps the scrollbar away from the chip switch instead of
		    // letting the list scroll underneath it.
		    page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, font: 'inherit', color: 'inherit' },
		    header: { flex: 'none', padding: '0 0 8px' },
		    scroll: { flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: '4px', paddingBottom: '16px' },
		    title: { fontSize: '15px', fontWeight: 600, margin: 0 },
		    hint: { fontSize: '12px', color: TEXT_DIM, margin: 0 },
		    tabs: { display: 'flex', flexWrap: 'wrap', gap: '3px', margin: '0 0 8px' },
		    // Every clickable control on the page shares one box (height, padding,
		    // radius, font size), so tabs, action buttons and switches line up.
		    tab: (active) => ({ ...CONTROL, ...(active ? CONTROL_ACTIVE : { color: TEXT_DIM }) }),
		    // Rows keep the window's own background: no raised card surface, only a hairline.
		    card: {
		        border: `1px solid ${BORDER_SOFT}`, borderRadius: '8px', padding: '7px 10px',
		        marginBottom: '5px', background: 'transparent',
		    },
		    row: { display: 'flex', alignItems: 'center', gap: '8px' },
		    // The body an expanded server card grows by.
		    formBody: { paddingTop: '8px', marginTop: '8px', borderTop: `1px solid ${BORDER_SOFT}` },
		    grow: { flex: '1 1 auto', minWidth: 0 },
		    dot: (status) => ({
		        width: '7px', height: '7px', borderRadius: '50%', flex: 'none',
		        background: STATUS_COLOR[status] ?? '#8a8a8a',
		    }),
		    name: { fontWeight: 600, fontSize: '12.5px', color: TEXT },
		    // Marks a server mirrored from the DSH MCP settings.
		    badge: {
		        marginLeft: '6px', fontSize: '10px', fontWeight: 400, color: TEXT_DIM,
		        border: `1px solid ${BORDER_SOFT}`, borderRadius: '4px', padding: '0 4px',
		    },
		    // Long hints must wrap instead of being cut with an ellipsis.
		    meta: { fontSize: '11px', color: TEXT_DIM, overflowWrap: 'anywhere' },
		    // The "managed in Settings" note sits under the profile action button.
		    profileHint: { fontSize: '11px', fontWeight: 600, color: TEXT_DIM, textAlign: 'center', marginTop: '4px', overflowWrap: 'anywhere' },
		    button: { ...CONTROL },
		    // Fixed-width row actions: the pair and the wide single button share one span.
		    actionEdit: { ...CONTROL, width: `${ACTION_EDIT_WIDTH}px`, padding: '0 6px' },
		    actionDelete: { ...CONTROL, width: `${ACTION_DELETE_WIDTH}px`, padding: '0 6px' },
		    // Same box, but the long label wraps to two lines instead of being clipped.
		    wideAction: {
		        ...CONTROL, width: ACTION_SPAN, height: 'auto', minHeight: '28px',
		        padding: '4px 6px', whiteSpace: 'normal', lineHeight: '14px', textAlign: 'center',
		    },
		    actionColumn: { display: 'flex', flexDirection: 'column', gap: '4px', flex: 'none', alignItems: 'stretch', width: ACTION_SPAN },
		    // Filled variants keep the same box; only the fill and label colour differ.
		    filled: { ...CONTROL, background: 'var(--dsw-alias-button-ghost-active-hover, rgba(127, 127, 127, 0.32))' },
		    field: { display: 'block', marginBottom: '6px', fontSize: '12px' },
		    label: { display: 'block', fontSize: '11px', color: TEXT_DIM, marginBottom: '2px' },
		    input: {
		        width: '100%', boxSizing: 'border-box', font: 'inherit', fontSize: '12px', padding: '4px 7px',
		        borderRadius: '6px', color: TEXT, background: 'transparent', border: `1px solid ${BORDER}`,
		    },
		    textarea: {
		        width: '100%', boxSizing: 'border-box', font: 'inherit', fontSize: '12px', padding: '4px 7px',
		        borderRadius: '6px', color: TEXT, background: 'transparent', resize: 'vertical',
		        border: `1px solid ${BORDER}`,
		    },
		    error: { fontSize: '12px', color: 'var(--dsw-alias-state-error-primary, #c0392b)', margin: '6px 0' },
		    empty: { fontSize: '12px', color: TEXT_DIM, padding: '8px 0' },
		    // The chip sits next to the model selector and matches its height. Unlike the
		    // settings rows it keeps a filled background: in the composer a bare outline
		    // would read as a disabled control.
		    chip: {
		        display: 'flex', alignItems: 'center', gap: '6px', font: 'inherit', fontSize: '12px',
		        padding: '4px 10px', borderRadius: '8px', cursor: 'pointer', color: TEXT,
		        border: `1px solid ${BORDER_SOFT}`, background: 'var(--dsw-alias-bg-layer-2, rgba(0, 0, 0, 0.04))',
		        lineHeight: '18px',
		    },
		    // Three-state control (on / off / inherit) used by the preset rows.
		    segments: { display: 'flex', gap: '4px', flexWrap: 'wrap', flex: 'none' },
		    segment: (active) => ({ ...CONTROL, ...(active ? CONTROL_ACTIVE : { color: TEXT_DIM }) }),
		    // The composer sits at the bottom of the window: a card anchored to its top
		    // edge would fall off-screen. Measure the viewport and flip upwards instead.
		    popover: (rect) => {
		        const width = 320;
		        const viewportWidth = window.innerWidth || 800;
		        const viewportHeight = window.innerHeight || 600;
		        const left = Math.max(8, Math.min(rect?.left ?? 8, viewportWidth - width - 12));
		        const spaceBelow = rect === null ? 0 : viewportHeight - rect.bottom;
		        const spaceAbove = rect === null ? 0 : rect.top;
		        const placeAbove = spaceBelow < 340 && spaceAbove > spaceBelow;
		        return {
		            position: 'fixed', left: `${left}px`, width: `${width}px`, zIndex: 60,
		            padding: '10px', borderRadius: '10px', fontSize: '12px', overflowY: 'auto',
		            background: SURFACE_POPOVER, color: TEXT, border: `1px solid ${BORDER}`,
		            boxShadow: '0 8px 28px rgba(0, 0, 0, 0.28)',
		            ...(placeAbove
		                ? {
		                    bottom: `${Math.max(8, viewportHeight - (rect?.top ?? viewportHeight) + 6)}px`,
		                    maxHeight: `${Math.max(160, spaceAbove - 16)}px`,
		                }
		                : {
		                    top: `${(rect?.bottom ?? 40) + 6}px`,
		                    maxHeight: `${Math.max(160, spaceBelow - 16)}px`,
		                }),
		        };
		    },
		    // One preset tile: a full-width row, the same width for every preset. It keeps
		    // the window background; only the border tells the expanded tile apart.
		    tile: (open) => ({
		        display: 'flex', alignItems: 'center', gap: '8px', width: '100%', boxSizing: 'border-box',
		        font: 'inherit', fontSize: '12px', textAlign: 'left', cursor: 'pointer', color: TEXT,
		        padding: '6px 10px', borderRadius: '8px',
		        border: `1px solid ${open ? BORDER : BORDER_SOFT}`,
		        background: 'transparent',
		    }),
		    // A pill switch: the same geometry as the app's own toggles.
		    switch: (on) => ({
		        width: '30px', height: '18px', flex: 'none', padding: '2px', borderRadius: '999px',
		        cursor: 'pointer', border: 'none', display: 'flex', alignItems: 'center',
		        justifyContent: on ? 'flex-end' : 'flex-start',
		        backgroundColor: on ? ACCENT : HOVER,
		        transition: 'background-color 120ms ease',
		    }),
		    knob: { width: '14px', height: '14px', borderRadius: '50%', background: ON_ACCENT, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.3)' },
		};
		function dot(status) {
		    return h('span', { style: styles.dot(status) });
		}
		/** Pill switch, the shape the shell uses for its own boolean settings. */
		function toggleSwitch(on, onChange, key, disabled = false) {
		    return h('button', {
		        key,
		        type: 'button',
		        role: 'switch',
		        'aria-checked': on,
		        title: on ? 'on' : 'off',
		        disabled,
		        style: { ...styles.switch(on), opacity: disabled ? 0.5 : 1 },
		        onClick: () => onChange(!on),
		    }, h('span', { style: styles.knob }));
		}
		/** One-line summary of the record, used under the server name. */
		function serverSummary(server) {
		    if (server.transport === 'http')
		        return `http ${server.url}`;
		    const args = server.args.length === 0 ? '' : ` ${server.args.join(' ')}`;
		    return `stdio ${server.command}${args}`;
		}
		function statusLabel(status, t) {
		    return t(`status.${status}`);
		}
		/** Plug icon, shared by the settings section and the chip. */
		function PlugIcon(props) {
		    const size = typeof props?.size === 'number' ? props.size : 16;
		    return h('svg', {
		        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
		        stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
		    }, h('path', { d: 'M6 1.5v3M10 1.5v3' }), h('path', { d: 'M4 4.5h8v2.2a4 4 0 0 1-8 0z' }), h('path', { d: 'M8 10.7v3.8' }));
		}
		// ---------------------------------------------------------------------------
		// Server form
		// ---------------------------------------------------------------------------
		const EMPTY_DRAFT = {
		    name: '', description: '', transport: 'stdio', loadMode: 'lazy', command: '', args: '', env: '',
		    cwd: '', url: '', headers: '', toolCallTimeoutMs: '', startupTimeoutMs: '', editing: false,
		};
		function draftOf(server) {
		    return {
		        name: server.name,
		        description: server.description,
		        transport: server.transport,
		        loadMode: server.loadMode,
		        command: server.command,
		        args: server.args.join('\n'),
		        env: pairsToText(server.env),
		        cwd: server.cwd,
		        url: server.url,
		        headers: pairsToText(server.headers),
		        toolCallTimeoutMs: server.toolCallTimeoutMs === 0 ? '' : String(server.toolCallTimeoutMs),
		        startupTimeoutMs: server.startupTimeoutMs === 0 ? '' : String(server.startupTimeoutMs),
		        editing: true,
		    };
		}
		function pairsToText(pairs) {
		    return Object.entries(pairs).map(([key, value]) => `${key}=${value}`).join('\n');
		}
		function textToPairs(text) {
		    const out = {};
		    for (const line of text.split('\n')) {
		        const trimmed = line.trim();
		        if (trimmed === '')
		            continue;
		        const at = trimmed.indexOf('=');
		        if (at <= 0)
		            continue;
		        out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim();
		    }
		    return out;
		}
		function lines(text) {
		    return text.split('\n').map(line => line.trim()).filter(line => line !== '');
		}
		function numberOf(text) {
		    const value = Number(text.trim());
		    return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : undefined;
		}
		/** Inline form for one server: no overlay, it simply replaces the list header.
		 *
		 * An overlay portal painted an empty screen inside the settings dialog, and an
		 * inline form is also how the shell's own settings pages add records.
		 */
		function ServerForm(props) {
		    const t = props.t;
		    const [draft, setDraft] = useState(props.initial);
		    const busy = props.busy === true;
		    // An existing server is edited in place, inside its own card: the card grows
		    // instead of pushing a detached form to the top of the page.
		    const embedded = props.embedded === true;
		    const field = (key, labelKey, placeholder, multiline = false) => h('label', { style: styles.field, key: key }, h('span', { style: styles.label }, t(labelKey)), h(multiline ? 'textarea' : 'input', {
		        style: multiline ? styles.textarea : styles.input,
		        rows: multiline ? 3 : undefined,
		        value: String(draft[key] ?? ''),
		        placeholder,
		        onChange: (event) => setDraft({ ...draft, [key]: event.target.value }),
		    }));
		    return h('div', { style: embedded ? styles.formBody : { ...styles.card, padding: '10px', marginBottom: '8px' } }, embedded
		        ? null
		        : h('div', { style: styles.row }, h('div', { style: { ...styles.name, ...styles.grow } }, draft.editing ? t('servers.edit') : t('servers.add')), h('button', { style: styles.button, onClick: props.onClose }, '×')), field('name', 'servers.name', 'my-server'), field('description', 'servers.description', t('servers.descriptionHint')), h('label', { style: styles.field }, h('span', { style: styles.label }, t('servers.transport')), h('select', {
		        style: styles.input,
		        value: draft.transport,
		        onChange: (event) => setDraft({ ...draft, transport: event.target.value === 'http' ? 'http' : 'stdio' }),
		    }, h('option', { value: 'stdio' }, 'stdio'), h('option', { value: 'http' }, 'streamable-http'))), h('label', { style: styles.field }, h('span', { style: styles.label }, t('servers.loadMode')), h('select', {
		        style: styles.input,
		        value: draft.loadMode,
		        onChange: (event) => setDraft({ ...draft, loadMode: event.target.value === 'eager' ? 'eager' : 'lazy' }),
		    }, h('option', { value: 'lazy' }, t('loadMode.lazy')), h('option', { value: 'eager' }, t('loadMode.eager'))), h('span', { style: styles.meta }, t('servers.loadModeHint'))), draft.transport === 'stdio' ? [
		        field('command', 'servers.command', 'D:\\tools\\server.exe', false),
		        field('args', 'servers.args', '--mcp', true),
		        field('env', 'servers.env', 'NAME=value', true),
		        field('cwd', 'servers.cwd', '', false),
		    ] : [
		        field('url', 'servers.url', 'https://host/mcp', false),
		        field('headers', 'servers.headers', 'authorization=${credential:TOKEN}', true),
		    ], field('toolCallTimeoutMs', 'servers.toolCallTimeoutMs', '60000'), field('startupTimeoutMs', 'servers.startupTimeoutMs', '30000'), h('div', { style: { ...styles.row, marginTop: '10px' } }, h('button', {
		        style: styles.filled,
		        'data-fill': '',
		        disabled: busy || draft.name.trim() === '',
		        onClick: () => props.onSave(draft),
		    }, t('servers.save')), h('button', { style: styles.button, disabled: busy, onClick: props.onClose }, t('servers.cancel'))));
		}
		// ---------------------------------------------------------------------------
		// Settings: MCP servers
		// ---------------------------------------------------------------------------
		function ServersTab(props) {
		    const t = props.t;
		    const doc = props.doc;
		    const { reload, busy, run } = props;
		    const [open, setOpen] = useState(undefined);
		    const [adding, setAdding] = useState(false);
		    const servers = doc.servers;
		    const close = () => {
		        setOpen(undefined);
		        setAdding(false);
		    };
		    const save = (draft) => {
		        run(async () => {
		            await request('/server', {
		                name: draft.name.trim(),
		                description: draft.description.trim(),
		                transport: draft.transport,
		                loadMode: draft.loadMode,
		                command: draft.command.trim(),
		                args: lines(draft.args),
		                env: textToPairs(draft.env),
		                cwd: draft.cwd.trim(),
		                url: draft.url.trim(),
		                headers: textToPairs(draft.headers),
		                toolCallTimeoutMs: numberOf(draft.toolCallTimeoutMs),
		                startupTimeoutMs: numberOf(draft.startupTimeoutMs),
		            });
		            close();
		            reload();
		        });
		    };
		    const remove = (name) => {
		        run(async () => {
		            await request('/server/delete', { name });
		            close();
		            reload();
		        });
		    };
		    const activate = (name, action) => {
		        run(async () => {
		            await request('/activate', { sessionId: doc.sessionId ?? '', server: name, action, cwd: doc.cwd });
		            reload();
		        });
		    };
		    const list = servers.length === 0
		        ? h('p', { style: styles.empty, key: 'empty' }, t('servers.empty'))
		        : servers.map(server => {
		            const expanded = open === server.name;
		            // A server the settings keep switched off can be started here for as
		            // long as the agent needs it; a server we started can be stopped again.
		            // The hint sits under the button, in the same block as Edit + Delete.
		            const actions = server.origin === 'profile'
		                ? h('div', { key: 'actions', style: styles.actionColumn }, server.owned
		                    ? h('button', {
		                        key: 'stop',
		                        style: styles.wideAction,
		                        disabled: busy || !server.live,
		                        onClick: () => activate(server.name, 'release'),
		                    }, t('servers.stopProfile'))
		                    : server.profileEnabled === false
		                        ? h('button', {
		                            key: 'start',
		                            style: styles.wideAction,
		                            disabled: busy,
		                            onClick: () => activate(server.name, 'load'),
		                        }, t('servers.startProfile'))
		                        : null)
		                : [
		                    h('button', {
		                        key: 'edit',
		                        style: styles.actionEdit,
		                        disabled: busy,
		                        onClick: () => {
		                            setAdding(false);
		                            setOpen(expanded ? undefined : server.name);
		                        },
		                    }, expanded ? t('servers.cancel') : t('servers.edit')),
		                    h('button', { key: 'delete', style: styles.actionDelete, onClick: () => remove(server.name) }, t('servers.delete')),
		                ];
		            return h('div', { style: styles.card, key: server.name }, h('div', { style: styles.row }, dot(server.status), h('div', { style: styles.grow }, h('div', { style: styles.name }, server.name, server.origin === 'profile'
		                ? h('span', { style: styles.badge }, t('servers.profile'))
		                : null), h('div', { style: styles.meta }, serverSummary(server)), h('div', { style: styles.meta }, `${statusLabel(server.status, t)}${server.live && server.origin !== 'profile' ? ` · ${t('servers.live')} ${server.toolCount}` : server.origin !== 'profile' && server.toolCount > 0 ? ` · ${t('servers.cached')} ${server.toolCount}` : ''}`
		                + (server.origin === 'profile' ? '' : ` · ${t(server.loadMode === 'eager' ? 'loadMode.eager' : 'loadMode.lazy')}`))), actions), 
		            // The note about the DSH settings lines up with the button above.
		            server.origin === 'profile'
		                ? h('div', { key: 'profile', style: styles.profileHint }, t('servers.profileHint'))
		                : null, 
		            // The card itself grows: the form belongs to this server.
		            expanded
		                ? h(ServerForm, {
		                    key: 'form',
		                    embedded: true,
		                    t,
		                    initial: draftOf(server),
		                    busy,
		                    onSave: save,
		                    onClose: close,
		                })
		                : null);
		        });
		    return h('div', null, h('p', { style: styles.hint }, t('servers.hint')), h('div', { style: { ...styles.row, margin: '6px 0' } }, h('div', { style: { ...styles.name, ...styles.grow } }, t('servers.title')), adding
		        ? null
		        : h('button', {
		            style: styles.filled,
		            'data-fill': '',
		            onClick: () => {
		                setOpen(undefined);
		                setAdding(true);
		            },
		        }, t('servers.add'))), adding
		        ? h(ServerForm, {
		            key: 'add',
		            t,
		            initial: { ...EMPTY_DRAFT },
		            busy,
		            onSave: save,
		            onClose: close,
		        })
		        : null, list);
		}
		// ---------------------------------------------------------------------------
		// Settings: presets
		// ---------------------------------------------------------------------------
		/** One row of a preset: the server and its three-state switch. */
		function presetRow(t, preset, server, busy, onChange) {
		    // Inside `default` a missing row means "on", so the switch must show that too.
		    const current = preset.rows[server.name]
		        ?? (preset.name === DEFAULT_PRESET ? 'on' : 'inherit');
		    const segment = (state, label) => h('button', {
		        key: state,
		        style: styles.segment(current === state),
		        disabled: busy,
		        onClick: () => onChange(state),
		    }, label);
		    const states = preset.name === DEFAULT_PRESET
		        ? [segment('on', t('state.on')), segment('off', t('state.off'))]
		        : [segment('on', t('state.on')), segment('off', t('state.off')), segment('inherit', t('state.inherit'))];
		    return h('div', { style: { ...styles.row, padding: '4px 0' }, key: server.name }, h('div', { style: styles.grow }, h('div', { style: styles.name }, server.name), h('div', { style: styles.meta }, server.description === '' ? serverSummary(server) : server.description)), h('div', { style: { display: 'flex', gap: '4px' } }, states));
		}
		function PresetsTab(props) {
		    const t = props.t;
		    const doc = props.doc;
		    const { reload, busy, run } = props;
		    // One expanded tile at a time: the list stays readable with many presets.
		    const [expanded, setExpanded] = useState(DEFAULT_PRESET);
		    const [name, setName] = useState('');
		    const setRow = (preset, server, state) => {
		        run(async () => {
		            const rows = { ...preset.rows };
		            if (state === 'inherit')
		                delete rows[server.name];
		            else
		                rows[server.name] = state;
		            await request('/preset', { name: preset.name, rows });
		            reload();
		        });
		    };
		    const create = () => {
		        const target = name.trim();
		        run(async () => {
		            await request('/preset', { name: target, rows: {} });
		            setName('');
		            setExpanded(target);
		            reload();
		        });
		    };
		    const remove = (preset) => {
		        run(async () => {
		            await request('/preset/delete', { name: preset.name });
		            setExpanded(DEFAULT_PRESET);
		            reload();
		        });
		    };
		    /** What the switch shows for a server that has no row in this preset. */
		    const stateOf = (preset, server) => preset.rows[server.name] ?? (preset.name === DEFAULT_PRESET ? 'on' : 'inherit');
		    const tile = (preset) => {
		        const open = preset.name === expanded;
		        const on = doc.servers.filter(server => stateOf(preset, server) === 'on').length;
		        return h('div', { key: preset.name, style: { marginBottom: '5px' } }, h('button', {
		            style: styles.tile(open),
		            onClick: () => setExpanded(open ? '' : preset.name),
		            'aria-expanded': open,
		        }, h('span', { style: { ...styles.grow, minWidth: 0 } }, h('div', { style: styles.name }, preset.name), h('div', { style: styles.meta }, `${on} / ${doc.servers.length}`)), h('span', { style: styles.meta }, open ? '▾' : '▸')), open
		            ? h('div', { style: { ...styles.card, marginTop: '6px', marginBottom: 0 } }, preset.name === DEFAULT_PRESET
		                ? h('div', { style: styles.meta }, t('presets.defaultHint'))
		                : h('div', { style: styles.meta }, t('presets.customHint')), doc.servers.length === 0
		                ? h('p', { style: styles.empty }, t('servers.empty'))
		                : doc.servers.map(server => presetRow(t, preset, server, busy, (state) => setRow(preset, server, state))), preset.name === DEFAULT_PRESET
		                ? null
		                : h('div', { style: { ...styles.row, marginTop: '8px' } }, h('button', { style: styles.button, disabled: busy, onClick: () => remove(preset) }, t('presets.delete'))))
		            : null);
		    };
		    return h('div', null, h('p', { style: styles.hint }, t('presets.hint')), doc.presets.map(tile), h('div', { style: { ...styles.row, marginTop: '10px' } }, h('input', {
		        style: { ...styles.input, flex: 1 },
		        value: name,
		        placeholder: t('presets.namePlaceholder'),
		        onChange: (event) => setName(event.target.value),
		    }), h('button', {
		        style: styles.filled,
		        'data-fill': '',
		        disabled: busy || name.trim() === '',
		        onClick: create,
		    }, t('presets.create'))));
		}
		// ---------------------------------------------------------------------------
		// Settings: folder assignments
		// ---------------------------------------------------------------------------
		/**
		 * The same key the host stores folder assignments under: see canonicalPath() in
		 * src/policy.ts. The client cannot import that module (it is host-side), so the
		 * rule is repeated here: backslashes become forward slashes, no trailing slash,
		 * and Windows paths (a drive letter or a UNC share) are lower-cased, which is
		 * what the host does on win32. Both implementations must yield the same string.
		 */
		function canonicalKey(input) {
		    const windows = /^[A-Za-z]:[\\/]/.test(input) || input.startsWith('\\\\');
		    let value = input.split('\\').join('/');
		    if (value.length > 1)
		        while (value.endsWith('/'))
		            value = value.slice(0, -1);
		    if (value === '' || value === '/')
		        return value;
		    return windows ? value.toLowerCase() : value;
		}
		/** One row per folder: the workspace record wins, its preset comes by key. */
		function folderRows(doc) {
		    const rows = [];
		    const seen = new Set();
		    for (const workspace of doc.workspaces) {
		        const key = canonicalKey(workspace.path);
		        if (seen.has(key))
		            continue;
		        seen.add(key);
		        rows.push({ path: workspace.path, title: workspace.title, key });
		    }
		    for (const folder of doc.folders) {
		        const key = canonicalKey(folder.path);
		        if (seen.has(key))
		            continue;
		        seen.add(key);
		        rows.push({ path: folder.path, key });
		    }
		    rows.sort((left, right) => left.path.localeCompare(right.path));
		    return rows;
		}
		function FoldersTab(props) {
		    const t = props.t;
		    const doc = props.doc;
		    const { reload, busy, run } = props;
		    const assigned = new Map(doc.folders.map(folder => [canonicalKey(folder.path), folder.preset]));
		    const rows = folderRows(doc);
		    const assign = (target, next) => {
		        run(async () => {
		            if (next === DEFAULT_PRESET)
		                await request('/folder/delete', { path: target });
		            else
		                await request('/folder', { path: target, preset: next });
		            reload();
		        });
		    };
		    const select = (row) => h('select', {
		        style: { ...styles.input, width: 'auto' },
		        value: assigned.get(row.key) ?? DEFAULT_PRESET,
		        disabled: busy,
		        onChange: (event) => assign(row.path, event.target.value),
		    }, h('option', { value: DEFAULT_PRESET }, t('folders.defaultOption')), doc.presets.filter(entry => entry.name !== DEFAULT_PRESET)
		        .map(entry => h('option', { value: entry.name, key: entry.name }, entry.name)));
		    const list = rows.length === 0
		        ? h('p', { style: styles.empty }, t('folders.empty'))
		        : rows.map(row => h('div', { style: styles.card, key: row.key }, h('div', { style: styles.row }, h('div', { style: styles.grow }, h('div', { style: styles.name }, row.title === undefined || row.title === '' ? row.path : row.title), h('div', { style: styles.meta }, row.path), doc.cwd !== '' && canonicalKey(doc.cwd) === row.key
		            ? h('div', { style: styles.meta }, t('folders.active'))
		            : null), select(row))));
		    return h('div', null, h('p', { style: styles.hint }, t('folders.hint')), list);
		}
		// ---------------------------------------------------------------------------
		// Settings page
		// ---------------------------------------------------------------------------
		function SettingsPage(props) {
		    const t = props.t;
		    const [tab, setTab] = useState('servers');
		    const [busy, setBusy] = useState(false);
		    const [error, setError] = useState(undefined);
		    const [showChip, setShowChip] = useState(undefined);
		    const [lifecycle, setLifecycle] = useState(undefined);
		    const { sessionId, cwd } = usePanelSession(props);
		    const { doc, error: loadError, reload } = useStateDoc(sessionId, 0, cwd);
		    const run = useCallback((task) => {
		        setBusy(true);
		        task().then(() => setError(undefined), (cause) => setError(messageOf(cause))).finally(() => setBusy(false));
		    }, []);
		    const chip = showChip ?? doc?.settings.showChip ?? true;
		    const mode = lifecycle ?? doc?.settings.profileLifecycle ?? 'auto';
		    const toggleChip = (next) => {
		        setShowChip(next);
		        run(async () => {
		            await request('/settings', { showChip: next });
		            reload();
		        });
		    };
		    const changeLifecycle = (next) => {
		        setLifecycle(next);
		        run(async () => {
		            await request('/settings', { profileLifecycle: next });
		            reload();
		        });
		    };
		    const body = doc === undefined
		        ? h('p', { style: styles.empty }, t('loading'))
		        : tab === 'servers'
		            ? h(ServersTab, { t, doc, reload, busy, run })
		            : tab === 'presets'
		                ? h(PresetsTab, { t, doc, reload, busy, run })
		                : h(FoldersTab, { t, doc, reload, busy, run });
		    const lifecycleButton = (id, label) => h('button', {
		        key: id,
		        style: styles.segment(mode === id),
		        disabled: busy,
		        onClick: () => changeLifecycle(id),
		    }, label);
		    const tabButton = (id, label) => h('button', { key: id, style: styles.tab(tab === id), onClick: () => setTab(id) }, label);
		    return h('div', { style: styles.page, 'data-mcptool': '' }, h('div', { style: styles.header }, h('p', { style: styles.hint }, t('panel.subtitle')), h('div', { style: { ...styles.row, margin: '8px 0' } }, h('div', { style: styles.grow }, h('div', { style: styles.name }, t('settings.showChip')), h('div', { style: styles.meta }, t('settings.showChipHint'))), toggleSwitch(chip, toggleChip, 'show-chip', busy)), h('div', { style: { margin: '0 0 8px' } }, h('div', { style: { ...styles.row, flexWrap: 'wrap', alignItems: 'center' } }, h('div', { style: styles.grow }, h('div', { style: styles.name }, t('settings.profileLifecycle'))), h('div', { style: styles.segments }, lifecycleButton('auto', t('profileLifecycle.auto')), lifecycleButton('flip', t('profileLifecycle.flip')), lifecycleButton('mount', t('profileLifecycle.mount')))), h('div', { style: { ...styles.meta, marginTop: '4px' } }, t('profileLifecycle.hint.' + mode))), h('div', { style: { ...styles.tabs, margin: 0 } }, tabButton('servers', t('tabs.servers')), tabButton('presets', t('tabs.presets')), tabButton('folders', t('tabs.folders'))), loadError === undefined ? null : h('p', { style: styles.error }, loadError), error === undefined ? null : h('p', { style: styles.error }, error)), h('div', { style: styles.scroll }, body));
		}
		// ---------------------------------------------------------------------------
		// Composer chip
		// ---------------------------------------------------------------------------
		/** Preset picker for the folder of the current chat. */
		function ChipPopup(props) {
		    const t = props.t;
		    const rect = props.rect;
		    const doc = props.doc;
		    const { error, reload, busy, run, sessionId, cwd } = props;
		    const assign = (preset) => {
		        run(async () => {
		            if (preset === DEFAULT_PRESET)
		                await request('/folder/delete', { path: cwd });
		            else
		                await request('/folder', { path: cwd, preset });
		            reload();
		        });
		    };
		    const current = doc?.preset ?? DEFAULT_PRESET;
		    const rows = (doc?.presets ?? []).map(preset => h('button', {
		        key: preset.name,
		        style: {
		            ...styles.row,
		            width: '100%', textAlign: 'left', font: 'inherit', fontSize: '12px', cursor: 'pointer',
		            padding: '6px 8px', borderRadius: '8px', marginBottom: '2px', color: TEXT,
		            border: `1px solid ${preset.name === current ? BORDER : 'transparent'}`,
		            background: preset.name === current ? HOVER : 'transparent',
		        },
		        disabled: busy || cwd === '',
		        onClick: () => assign(preset.name),
		    }, h('span', { style: { ...styles.grow, ...styles.name } }, preset.name === DEFAULT_PRESET ? t('chip.defaultPreset') : preset.name), preset.name === current ? h('span', { style: styles.meta }, t('chip.current')) : null));
		    return ReactDOM.createPortal(h('div', { style: styles.popover(rect), 'data-mcptool': '' }, h('div', { style: { ...styles.row, marginBottom: '6px' } }, h('div', { style: { ...styles.name, ...styles.grow } }, t('chip.title')), h('button', { style: styles.button, onClick: props.onClose }, '×')), h('div', { style: styles.meta }, cwd === '' ? t('chip.noFolder') : cwd), doc === undefined ? h('p', { style: styles.empty }, t('loading')) : rows, error === undefined ? null : h('p', { style: styles.error }, error)), document.body);
		}
		function Chip(props) {
		    const t = props.t;
		    const sessionId = props.sessionId;
		    const cwd = useSessionCwd(props);
		    const [open, setOpen] = useState(false);
		    const [busy, setBusy] = useState(false);
		    const [error, setError] = useState(undefined);
		    const [rect, setRect] = useState(null);
		    const button = useRef(null);
		    const { doc, reload } = useStateDoc(sessionId, 0, cwd);
		    const run = useCallback((task) => {
		        setBusy(true);
		        task().then(() => setError(undefined), (cause) => setError(messageOf(cause))).finally(() => setBusy(false));
		    }, []);
		    // The switch lives in the plugin settings; when it is off the chip is gone.
		    if (doc !== undefined && doc.settings.showChip === false)
		        return null;
		    if (doc === undefined)
		        return null;
		    // `mcp` alone when the folder runs the default preset, the preset name otherwise.
		    const label = doc.preset === DEFAULT_PRESET ? 'MCP' : `MCP · ${doc.preset}`;
		    const live = doc.servers.filter(server => server.allowed && server.live).length;
		    const toggle = () => {
		        const box = button.current?.getBoundingClientRect?.();
		        setRect(box ?? null);
		        setOpen(!open);
		    };
		    return h('div', { style: { position: 'relative', display: 'inline-flex' }, 'data-mcptool': '' }, h('button', {
		        ref: button,
		        style: styles.chip,
		        'data-chip': '',
		        title: t('chip.hint'),
		        onClick: toggle,
		    }, h('span', { style: styles.dot(live > 0 ? 'ready' : 'inactive') }), label), open
		        ? h(ChipPopup, { t, rect, doc, error, reload, busy, run, sessionId, cwd, onClose: () => setOpen(false) })
		        : null);
		}
		// ---------------------------------------------------------------------------
		// Dictionaries
		// ---------------------------------------------------------------------------
		const EN = {
		    'panel.meta.title': 'MCP Tool',
		    'panel.meta.description': 'MCP servers are registered globally; presets decide which of them may run, and every folder can pick a preset.',
		    'panel.subtitle': 'Servers are registered globally. A preset decides which of them may run, and every folder can use its own preset.',
		    'loading': 'Loading…',
		    'settings.showChip': 'Show the chip in the chat',
		    'settings.showChipHint': 'A small preset switch next to the composer, so a folder preset can be changed without opening settings.',
		    'settings.profileLifecycle': 'Servers from the DSH MCP settings',
		    'profileLifecycle.hint.auto': 'Picks per server: mount what the settings keep enabled, flip what they keep disabled.',
		    'profileLifecycle.hint.flip': 'Toggles the enabled switch of the DSH MCP settings; the manager starts and stops the process.',
		    'profileLifecycle.hint.mount': 'The plugin runs its own client in a private scope; the settings entry stays off while it is mounted.',
		    'profileLifecycle.auto': 'Auto',
		    'profileLifecycle.flip': 'Toggle',
		    'profileLifecycle.mount': 'Own process',
		    'tabs.servers': 'MCP',
		    'tabs.presets': 'Presets',
		    'tabs.folders': 'Working folders',
		    'servers.hint': 'A server may load lazily on demand, or stay running whenever its preset switches it on.',
		    'servers.add': 'Add server',
		    'servers.title': 'Servers',
		    'servers.edit': 'Edit',
		    'servers.save': 'Save',
		    'servers.cancel': 'Cancel',
		    'servers.delete': 'Delete',
		    'servers.name': 'Name',
		    'servers.description': 'Description shown to the agent',
		    'servers.descriptionHint': 'What this server is for',
		    'servers.transport': 'Transport',
		    'servers.loadMode': 'Load mode',
		    'servers.loadModeHint': 'Eager servers start with the plugin and are never stopped by the idle timer.',
		    'servers.command': 'Command',
		    'servers.args': 'Arguments (one per line)',
		    'servers.env': 'Environment (NAME=value per line)',
		    'servers.cwd': 'Working directory of the process (optional)',
		    'servers.url': 'URL',
		    'servers.headers': 'Headers (NAME=value per line)',
		    'servers.toolCallTimeoutMs': 'Tool call timeout (ms, optional)',
		    'servers.startupTimeoutMs': 'Startup timeout (ms, optional)',
		    'servers.empty': 'No server is registered yet.',
		    'servers.live': 'tools:',
		    'servers.cached': 'cached tools:',
		    'loadMode.lazy': 'Loads on demand',
		    'loadMode.eager': 'Always running',
		    'state.on': 'On',
		    'state.off': 'Off',
		    'state.inherit': 'Inherit',
		    'presets.hint': 'The default preset applies to every folder without its own preset. Named presets inherit from it unless a row says otherwise.',
		    'presets.defaultHint': 'Applies to folders without their own preset.',
		    'presets.customHint': 'Rows left on “inherit” follow the default preset.',
		    'presets.create': 'Create preset',
		    'presets.namePlaceholder': 'Preset name',
		    'presets.delete': 'Delete preset',
		    'folders.hint': 'Pick a preset for a folder; folders without one use the default preset.',
		    'folders.empty': 'No working folder yet.',
		    'folders.defaultOption': 'Default preset',
		    'folders.active': 'the folder of the current chat',
		    'chip.hint': 'MCP preset of this folder',
		    'chip.title': 'Preset for this folder',
		    'chip.defaultPreset': 'default',
		    'chip.current': 'current',
		    'chip.noFolder': 'unknown folder',
		    'status.ready': 'running',
		    'status.starting': 'starting',
		    'status.failed': 'failed',
		    'status.stopped': 'stopped',
		    'status.inactive': 'not started',
		    'status.external': 'started by DSH',
		    'servers.profile': 'from settings',
		    'servers.profileHint': 'managed in Settings → MCP',
		    'servers.startProfile': 'Start on demand',
		    'servers.stopProfile': 'Stop',
		};
		const RU = {
		    'panel.meta.title': 'MCP Tool',
		    'panel.meta.description': 'MCP-серверы заводятся глобально; пресеты решают, каким из них можно работать, а каждая папка может выбрать свой пресет.',
		    'panel.subtitle': 'Серверы заводятся глобально. Пресет решает, какие из них работают, а каждая папка может использовать свой пресет.',
		    'loading': 'Загрузка…',
		    'settings.showChip': 'Показывать чип в диалоге',
		    'settings.showChipHint': 'Небольшой переключатель пресета рядом с полем ввода — папку можно переключить, не открывая настройки.',
		    'settings.profileLifecycle': 'Серверы из настроек DSH',
		    'profileLifecycle.hint.auto': 'Выбирает по серверу: включённые в настройках монтируются своим соединением, выключенные переключаются.',
		    'profileLifecycle.hint.flip': 'Переключает enabled в настройках DSH: процесс запускает и останавливает менеджер.',
		    'profileLifecycle.hint.mount': 'Плагин запускает собственный клиент в изолированном scope; запись в настройках остаётся выключенной.',
		    'profileLifecycle.auto': 'Авто',
		    'profileLifecycle.flip': 'Тумблер',
		    'profileLifecycle.mount': 'Свой процесс',
		    'tabs.servers': 'MCP',
		    'tabs.presets': 'Пресеты',
		    'tabs.folders': 'Рабочие папки',
		    'servers.hint': 'Сервер может загружаться лениво по требованию или работать постоянно, пока пресет его включает.',
		    'servers.add': 'Добавить сервер',
		    'servers.title': 'Серверы',
		    'servers.edit': 'Изменить',
		    'servers.save': 'Сохранить',
		    'servers.cancel': 'Отмена',
		    'servers.delete': 'Удалить',
		    'servers.name': 'Имя',
		    'servers.description': 'Описание для агента',
		    'servers.descriptionHint': 'Для чего этот сервер',
		    'servers.transport': 'Транспорт',
		    'servers.loadMode': 'Способ загрузки',
		    'servers.loadModeHint': 'Постоянный сервер запускается вместе с плагином и не выгружается по простою.',
		    'servers.command': 'Команда',
		    'servers.args': 'Аргументы (по одному в строке)',
		    'servers.env': 'Окружение (NAME=value в строке)',
		    'servers.cwd': 'Рабочий каталог процесса (необязательно)',
		    'servers.url': 'URL',
		    'servers.headers': 'Заголовки (NAME=value в строке)',
		    'servers.toolCallTimeoutMs': 'Таймаут вызова инструмента (мс, необязательно)',
		    'servers.startupTimeoutMs': 'Таймаут запуска (мс, необязательно)',
		    'servers.empty': 'Пока ни одного сервера.',
		    'servers.live': 'инструментов:',
		    'servers.cached': 'в кэше инструментов:',
		    'loadMode.lazy': 'Ленивая загрузка',
		    'loadMode.eager': 'Всегда запущен',
		    'state.on': 'Вкл',
		    'state.off': 'Выкл',
		    'state.inherit': 'Наследовать',
		    'presets.hint': 'Пресет «default» действует во всех папках без своего пресета. Именованные пресеты наследуют его значения, если строка не задана.',
		    'presets.defaultHint': 'Действует в папках без своего пресета.',
		    'presets.customHint': 'Строки «Наследовать» берут значение из пресета по умолчанию.',
		    'presets.create': 'Создать пресет',
		    'presets.namePlaceholder': 'Имя пресета',
		    'presets.delete': 'Удалить пресет',
		    'folders.hint': 'Назначьте пресет папке; папки без пресета используют пресет по умолчанию.',
		    'folders.empty': 'Рабочих папок пока нет.',
		    'folders.defaultOption': 'Пресет по умолчанию',
		    'folders.active': 'папка текущего диалога',
		    'chip.hint': 'Пресет MCP для этой папки',
		    'chip.title': 'Пресет для этой папки',
		    'chip.defaultPreset': 'по умолчанию',
		    'chip.current': 'текущий',
		    'chip.noFolder': 'папка неизвестна',
		    'status.ready': 'работает',
		    'status.starting': 'запускается',
		    'status.failed': 'ошибка',
		    'status.stopped': 'остановлен',
		    'status.inactive': 'не запущен',
		    'status.external': 'запущен DSH',
		    'servers.profile': 'из настроек',
		    'servers.profileHint': 'управляется в Настройках → MCP',
		    'servers.startProfile': 'Запустить по требованию',
		    'servers.stopProfile': 'Остановить',
		};
		/** Injects the small rule set that inline styles cannot express. */
		function mountCss() {
		    // The bundle is also loaded by a DOM-less harness (node --test), so the
		    // stylesheet is optional rather than assumed.
		    if (typeof document === 'undefined')
		        return () => { };
		    const style = document.createElement('style');
		    style.setAttribute('data-plugin-css', 'dsh-mcp-tool');
		    style.textContent = CSS;
		    document.head.appendChild(style);
		    return () => { style.remove(); };
		}
		/** Mounts the settings page and the composer chip. */
		function apply(ctx) {
		    ctx.effect(mountCss, 'mcp-tool: styles');
		    ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'mcp-tool: en dictionary');
		    ctx.effect(() => ctx.locale.register(NS, 'ru', RU), 'mcp-tool: ru dictionary');
		    const t = ctx.locale.bind(NS);
		    ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
		        name: 'settings.section',
		        id: SECTION_ID,
		        order: 420,
		        label: () => t('panel.meta.title'),
		        locale: NS,
		    }, SettingsPage)), 'mcp-tool: settings page');
		    ctx.effect(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
		        name: 'settings.section.icon',
		        id: SECTION_ID,
		        order: 420,
		        label: () => t('panel.meta.title'),
		        locale: NS,
		    }, PlugIcon)), 'mcp-tool: settings icon');
		    ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
		        name: 'conversation.input.right',
		        id: SECTION_ID,
		        order: 60,
		        label: () => t('chip.hint'),
		        locale: NS,
		    }, Chip)), 'mcp-tool: composer chip');
		}

		return { inject, apply }
	},
})
