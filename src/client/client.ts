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

declare const require: (spec: string) => any

const React: any = require('react')
const ReactDOM: any = require('react-dom')

const h = React.createElement

// The factory's `require` hands back untyped values; these declarations give the
// hooks their React typing so `useState<T>()` stays legal.
const useState: <T>(initial: T | (() => T)) => [T, (value: T | ((previous: T) => T)) => void] = React.useState
const useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => void = React.useEffect
const useCallback: <T extends (...args: any[]) => any>(callback: T, deps: readonly unknown[]) => T = React.useCallback
const useMemo: <T>(factory: () => T, deps: readonly unknown[]) => T = React.useMemo
const useRef: <T>(initial: T) => { current: T } = React.useRef

const NS = 'mcp-tool'
const ROUTE = '/dsh-mcp-tool'
const SECTION_ID = 'mcp-tool'
const DEFAULT_PRESET = 'default'

/** Namespaces and slot ids announced to the shell. */
export const inject = ['slots', 'locale']

// ---------------------------------------------------------------------------
// Host documents
// ---------------------------------------------------------------------------

type PresetState = 'on' | 'off' | 'inherit'

interface ServerView {
	name: string
	description: string
	transport: 'stdio' | 'http'
	loadMode: 'lazy' | 'eager'
	command: string
	args: string[]
	env: Record<string, string>
	cwd: string
	url: string
	headers: Record<string, string>
	toolCallTimeoutMs: number
	startupTimeoutMs: number
	status: string
	live: boolean
	holders: string[]
	toolCount: number
	allowed: boolean
}

interface PresetView {
	name: string
	rows: Record<string, PresetState>
	updatedAt: number
}

interface FolderView {
	path: string
	preset: string
}

interface WorkspaceView {
	path: string
	title?: string
}

interface StateDoc {
	ok: true
	/** Session the document was resolved for (the host picks the active one when the GUI has no session id). */
	sessionId?: string
	cwd: string
	source: 'folder' | 'default'
	preset: string
	folderPath: string | null
	settings: { showChip: boolean }
	servers: ServerView[]
	presets: PresetView[]
	folders: FolderView[]
	workspaces: WorkspaceView[]
}

interface Draft {
	name: string
	description: string
	transport: 'stdio' | 'http'
	loadMode: 'lazy' | 'eager'
	command: string
	args: string
	env: string
	cwd: string
	url: string
	headers: string
	toolCallTimeoutMs: string
	startupTimeoutMs: string
	editing: boolean
}

// ---------------------------------------------------------------------------
// Host calls
// ---------------------------------------------------------------------------

async function request(path: string, body?: unknown): Promise<any> {
	const response = body === undefined
		? await fetch(`${ROUTE}${path}`, { headers: { accept: 'application/json' } })
		: await fetch(`${ROUTE}${path}`, {
			method: 'POST',
			headers: { 'content-type': 'application/json', 'x-dsh-mcp-tool': '1' },
			body: JSON.stringify(body),
		})
	const doc: any = await response.json().catch(() => undefined)
	if (doc === undefined || doc === null || doc.ok !== true) {
		throw new Error(typeof doc?.error === 'string' ? doc.error : `request failed with ${response.status}`)
	}
	return doc
}

/**
 * Reads `/state` now and every few seconds while the surface is mounted.
 *
 * The folder hint travels with the request: the plugin resolves it from the
 * session's agent when one is alive, otherwise the hint is what the GUI sees.
 */
function useStateDoc(sessionId: string | undefined, tick: number, cwd?: string): {
	doc: StateDoc | undefined
	error: string | undefined
	reload: () => void
} {
	const [doc, setDoc] = useState<StateDoc | undefined>(undefined)
	const [error, setError] = useState<string | undefined>(undefined)
	const [local, setLocal] = useState(0)
	const reload = useCallback(() => setLocal((value: number) => value + 1), [])

	useEffect(() => {
		let mounted = true
		const params: string[] = []
		if (sessionId !== undefined) params.push(`sessionId=${encodeURIComponent(sessionId)}`)
		if (cwd !== undefined && cwd !== '') params.push(`cwd=${encodeURIComponent(cwd)}`)
		const query = params.length === 0 ? '' : `?${params.join('&')}`
		const load = (): void => {
			request(`/state${query}`).then(
				(next: StateDoc) => {
					if (!mounted) return
					setDoc(next)
					setError(undefined)
				},
				(cause: unknown) => {
					if (!mounted) return
					setError(messageOf(cause))
				},
			)
		}
		load()
		const handle = setInterval(load, 3000)
		return () => {
			mounted = false
			clearInterval(handle)
		}
	}, [sessionId, cwd, tick, local])

	return { doc, error, reload }
}

function messageOf(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause)
}

/** Working directory of the session whose composer hosts this chip. */
function useSessionCwd(props: any): string {
	const sessionId: string | undefined = props?.sessionId
	const useSessions = props?.useSessions
	const cwd = typeof useSessions === 'function'
		? useSessions((state: any) => (sessionId === undefined ? undefined : state?.byId?.[sessionId]?.cwd))
		: undefined
	return typeof cwd === 'string' ? cwd : ''
}

/**
 * The session the main view currently shows.
 *
 * The settings page receives no `sessionId`, so the shell's own notion of "the
 * open conversation" is used instead: the session retained by the main view.
 */
function mainSession(state: any): any {
	const rows: any[] = Object.values(state?.byId ?? {})
	let best: any
	for (const row of rows) {
		const retained = row?.retainedBy?.mainView ?? 0
		if (retained <= 0) continue
		if (best === undefined || retained > (best?.retainedBy?.mainView ?? 0)) best = row
	}
	return best
}

/** Session and folder the surface should describe: own session, else the open one. */
function usePanelSession(props: any): { sessionId: string | undefined; cwd: string } {
	const own: string | undefined = props?.sessionId
	const useSessions = props?.useSessions
	const pick = (state: any): string | undefined => (own !== undefined && own !== ''
		? own
		: mainSession(state)?.id)
	const foundId = typeof useSessions === 'function' ? useSessions(pick) : undefined
	const foundCwd = typeof useSessions === 'function'
		? useSessions((state: any) => {
			const id = pick(state)
			return id === undefined ? undefined : state?.byId?.[id]?.cwd
		})
		: undefined
	const sessionId = typeof foundId === 'string' && foundId !== '' ? foundId : undefined
	return { sessionId, cwd: typeof foundCwd === 'string' ? foundCwd : '' }
}

/** Every folder that currently hosts a session, for the folder picker. */
function knownFolders(useSessions: any): string[] {
	const state = typeof useSessions === 'function' ? useSessions((value: any) => value) : undefined
	const byId: Record<string, { cwd?: string }> | undefined = state?.byId
	if (byId === undefined) return []
	const seen = new Set<string>()
	for (const key of Object.keys(byId)) {
		const cwd = byId[key]?.cwd
		if (typeof cwd === 'string' && cwd !== '') seen.add(cwd)
	}
	return [...seen].sort()
}

// ---------------------------------------------------------------------------
// Small presentation helpers
// ---------------------------------------------------------------------------

const STATUS_COLOR: Record<string, string> = {
	ready: '#2e9e5b',
	starting: '#d9a441',
	failed: '#d24b4b',
	stopped: '#8a8a8a',
	inactive: '#8a8a8a',
}

// Surface colours come from the shell's own alias tokens (declared on `body`,
// so they also resolve inside portals). Every token keeps a light-theme
// fallback: a missing variable must never paint a white card on a dark panel.
const TEXT = 'var(--dsw-alias-label-primary, #1a1a1a)'
const TEXT_DIM = 'var(--dsw-alias-label-secondary, #555)'
const BORDER = 'var(--dsw-alias-border-l2, #d0d0d0)'
const BORDER_SOFT = 'var(--dsw-alias-border-l1, rgba(0, 0, 0, 0.06))'
const SURFACE_POPOVER = 'var(--dsw-alias-bg-layer-3, #ffffff)'
const ACCENT = 'var(--dsw-alias-brand-primary, #1f1f1f)'
// In dark mode the brand fill is a light pill, so its label must invert too.
const ON_ACCENT = 'var(--dsw-alias-label-primary-inverted, #ffffff)'
const HOVER = 'var(--dsw-alias-button-ghost-active-fill, rgba(0, 0, 0, 0.06))'

const styles: Record<string, any> = {
	// The page is a column: a fixed header and one scrolling region. Giving the
	// scroll its own box keeps the scrollbar away from the chip switch instead of
	// letting the list scroll underneath it.
	page: { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0, font: 'inherit', color: 'inherit' },
	header: { flex: 'none', padding: '0 0 8px' },
	scroll: { flex: 1, minHeight: 0, overflowY: 'auto', paddingRight: '4px', paddingBottom: '16px' },
	title: { fontSize: '15px', fontWeight: 600, margin: 0 },
	hint: { fontSize: '12px', color: TEXT_DIM, margin: 0 },
	tabs: { display: 'flex', flexWrap: 'wrap', gap: '3px', margin: '0 0 8px' },
	// Small, almost square segmented tabs: the pill shape was too loud next to
	// the settings' own controls. The label is centred in a fixed-height box, so a
	// smaller font reads as extra breathing room instead of cramped text.
	tab: (active: boolean): any => ({
		display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
		boxSizing: 'border-box', minHeight: '20px', padding: '0 9px',
		borderRadius: '5px', cursor: 'pointer', fontSize: '10px', lineHeight: '14px',
		border: `1px solid ${active ? BORDER : BORDER_SOFT}`,
		background: active ? HOVER : 'transparent', color: active ? TEXT : TEXT_DIM,
		font: 'inherit',
	}),
	// Rows keep the window's own background: no raised card surface, only a hairline.
	card: {
		border: `1px solid ${BORDER_SOFT}`, borderRadius: '8px', padding: '7px 10px',
		marginBottom: '5px', background: 'transparent',
	},
	row: { display: 'flex', alignItems: 'center', gap: '8px' },
	grow: { flex: 1, minWidth: 0 },
	dot: (status: string): any => ({
		width: '7px', height: '7px', borderRadius: '50%', flex: 'none',
		background: STATUS_COLOR[status] ?? '#8a8a8a',
	}),
	name: { fontWeight: 600, fontSize: '12.5px', color: TEXT },
	// Long hints must wrap instead of being cut with an ellipsis.
	meta: { fontSize: '11px', color: TEXT_DIM, overflowWrap: 'anywhere' },
	button: {
		font: 'inherit', fontSize: '11px', padding: '3px 8px', borderRadius: '6px', cursor: 'pointer',
		border: `1px solid ${BORDER}`, background: 'transparent', color: TEXT,
	},
	primary: {
		font: 'inherit', fontSize: '11px', padding: '4px 10px', borderRadius: '6px', cursor: 'pointer',
		border: '1px solid transparent', background: ACCENT, color: ON_ACCENT, fontWeight: 500,
	},
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
	segment: (active: boolean): any => ({
		font: 'inherit', fontSize: '10.5px', padding: '1px 7px', cursor: 'pointer',
		border: `1px solid ${active ? BORDER : BORDER_SOFT}`, borderRadius: '6px',
		background: active ? HOVER : 'transparent', color: active ? TEXT : TEXT_DIM,
	}),
	// The composer sits at the bottom of the window: a card anchored to its top
	// edge would fall off-screen. Measure the viewport and flip upwards instead.
	popover: (rect: DOMRect | null): any => {
		const width = 320
		const viewportWidth = window.innerWidth || 800
		const viewportHeight = window.innerHeight || 600
		const left = Math.max(8, Math.min(rect?.left ?? 8, viewportWidth - width - 12))
		const spaceBelow = rect === null ? 0 : viewportHeight - rect.bottom
		const spaceAbove = rect === null ? 0 : rect.top
		const placeAbove = spaceBelow < 340 && spaceAbove > spaceBelow
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
		}
	},
	// One preset tile: a full-width row, the same width for every preset. It keeps
	// the window background; only the border tells the expanded tile apart.
	tile: (open: boolean): any => ({
		display: 'flex', alignItems: 'center', gap: '8px', width: '100%', boxSizing: 'border-box',
		font: 'inherit', fontSize: '12px', textAlign: 'left', cursor: 'pointer', color: TEXT,
		padding: '6px 10px', borderRadius: '8px',
		border: `1px solid ${open ? BORDER : BORDER_SOFT}`,
		background: 'transparent',
	}),
	// A pill switch: the same geometry as the app's own toggles.
	switch: (on: boolean): any => ({
		width: '30px', height: '18px', flex: 'none', padding: '2px', borderRadius: '999px',
		cursor: 'pointer', border: 'none', display: 'flex', alignItems: 'center',
		justifyContent: on ? 'flex-end' : 'flex-start',
		backgroundColor: on ? ACCENT : HOVER,
		transition: 'background-color 120ms ease',
	}),
	knob: { width: '14px', height: '14px', borderRadius: '50%', background: ON_ACCENT, boxShadow: '0 1px 2px rgba(0, 0, 0, 0.3)' },
}

function dot(status: string): any {
	return h('span', { style: styles.dot(status) })
}

/** Pill switch, the shape the shell uses for its own boolean settings. */
function toggleSwitch(on: boolean, onChange: (next: boolean) => void, key?: string, disabled = false): any {
	return h('button', {
		key,
		type: 'button',
		role: 'switch',
		'aria-checked': on,
		title: on ? 'on' : 'off',
		disabled,
		style: { ...styles.switch(on), opacity: disabled ? 0.5 : 1 },
		onClick: () => onChange(!on),
	}, h('span', { style: styles.knob }))
}

/** One-line summary of the record, used under the server name. */
function serverSummary(server: ServerView): string {
	if (server.transport === 'http') return `http ${server.url}`
	const args = server.args.length === 0 ? '' : ` ${server.args.join(' ')}`
	return `stdio ${server.command}${args}`
}

function statusLabel(status: string, t: (key: string) => string): string {
	return t(`status.${status}`)
}

/** Plug icon, shared by the settings section and the chip. */
function PlugIcon(props: any): any {
	const size = typeof props?.size === 'number' ? props.size : 16
	return h('svg', {
		width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
		stroke: 'currentColor', strokeWidth: 1.4, strokeLinecap: 'round', strokeLinejoin: 'round',
	},
		h('path', { d: 'M6 1.5v3M10 1.5v3' }),
		h('path', { d: 'M4 4.5h8v2.2a4 4 0 0 1-8 0z' }),
		h('path', { d: 'M8 10.7v3.8' }),
	)
}

// ---------------------------------------------------------------------------
// Server form
// ---------------------------------------------------------------------------

const EMPTY_DRAFT: Draft = {
	name: '', description: '', transport: 'stdio', loadMode: 'lazy', command: '', args: '', env: '',
	cwd: '', url: '', headers: '', toolCallTimeoutMs: '', startupTimeoutMs: '', editing: false,
}

function draftOf(server: ServerView): Draft {
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
	}
}

function pairsToText(pairs: Record<string, string>): string {
	return Object.entries(pairs).map(([key, value]) => `${key}=${value}`).join('\n')
}

function textToPairs(text: string): Record<string, string> {
	const out: Record<string, string> = {}
	for (const line of text.split('\n')) {
		const trimmed = line.trim()
		if (trimmed === '') continue
		const at = trimmed.indexOf('=')
		if (at <= 0) continue
		out[trimmed.slice(0, at).trim()] = trimmed.slice(at + 1).trim()
	}
	return out
}

function lines(text: string): string[] {
	return text.split('\n').map(line => line.trim()).filter(line => line !== '')
}

function numberOf(text: string): number | undefined {
	const value = Number(text.trim())
	return text.trim() !== '' && Number.isFinite(value) && value > 0 ? value : undefined
}

/** Inline form for one server: no overlay, it simply replaces the list header.
 *
 * An overlay portal painted an empty screen inside the settings dialog, and an
 * inline form is also how the shell's own settings pages add records.
 */
function ServerForm(props: any): any {
	const t = props.t
	const [draft, setDraft] = useState<Draft>(props.initial)
	const busy: boolean = props.busy === true

	const field = (key: keyof Draft, labelKey: string, placeholder?: string, multiline = false): any =>
		h('label', { style: styles.field, key: key },
			h('span', { style: styles.label }, t(labelKey)),
			h(multiline ? 'textarea' : 'input', {
				style: multiline ? styles.textarea : styles.input,
				rows: multiline ? 3 : undefined,
				value: String(draft[key] ?? ''),
				placeholder,
				onChange: (event: any) => setDraft({ ...draft, [key]: event.target.value }),
			}),
		)

	return h('div', { style: { ...styles.card, padding: '10px', marginBottom: '8px' } },
		h('div', { style: styles.row },
			h('div', { style: { ...styles.name, ...styles.grow } }, draft.editing ? t('servers.edit') : t('servers.add')),
			h('button', { style: styles.button, onClick: props.onClose }, '×'),
		),
		field('name', 'servers.name', 'my-server'),
		field('description', 'servers.description', t('servers.descriptionHint')),
		h('label', { style: styles.field },
			h('span', { style: styles.label }, t('servers.transport')),
			h('select', {
				style: styles.input,
				value: draft.transport,
				onChange: (event: any) => setDraft({ ...draft, transport: event.target.value === 'http' ? 'http' : 'stdio' }),
			},
				h('option', { value: 'stdio' }, 'stdio'),
				h('option', { value: 'http' }, 'streamable-http'),
			),
		),
		h('label', { style: styles.field },
			h('span', { style: styles.label }, t('servers.loadMode')),
			h('select', {
				style: styles.input,
				value: draft.loadMode,
				onChange: (event: any) => setDraft({ ...draft, loadMode: event.target.value === 'eager' ? 'eager' : 'lazy' }),
			},
				h('option', { value: 'lazy' }, t('loadMode.lazy')),
				h('option', { value: 'eager' }, t('loadMode.eager')),
			),
			h('span', { style: styles.meta }, t('servers.loadModeHint')),
		),
		draft.transport === 'stdio' ? [
			field('command', 'servers.command', 'D:\\tools\\server.exe', false),
			field('args', 'servers.args', '--mcp', true),
			field('env', 'servers.env', 'NAME=value', true),
			field('cwd', 'servers.cwd', '', false),
		] : [
			field('url', 'servers.url', 'https://host/mcp', false),
			field('headers', 'servers.headers', 'authorization=${credential:TOKEN}', true),
		],
		field('toolCallTimeoutMs', 'servers.toolCallTimeoutMs', '60000'),
		field('startupTimeoutMs', 'servers.startupTimeoutMs', '30000'),
		h('div', { style: { ...styles.row, marginTop: '10px' } },
			h('button', {
				style: styles.primary,
				disabled: busy || draft.name.trim() === '',
				onClick: () => props.onSave(draft),
			}, t('servers.save')),
			h('button', { style: styles.button, disabled: busy, onClick: props.onClose }, t('servers.cancel')),
		),
	)
}

// ---------------------------------------------------------------------------
// Settings: MCP servers
// ---------------------------------------------------------------------------

function ServersTab(props: any): any {
	const t = props.t
	const doc: StateDoc = props.doc
	const { reload, busy, run } = props
	const [editing, setEditing] = useState<Draft | undefined>(undefined)
	const servers: ServerView[] = doc.servers

	const save = (draft: Draft): void => {
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
			})
			setEditing(undefined)
			reload()
		})
	}

	const remove = (name: string): void => {
		run(async () => {
			await request('/server/delete', { name })
			setEditing(undefined)
			reload()
		})
	}

	const list = servers.length === 0
		? h('p', { style: styles.empty, key: 'empty' }, t('servers.empty'))
		: servers.map(server => h('div', { style: styles.card, key: server.name },
			h('div', { style: styles.row },
				dot(server.status),
				h('div', { style: styles.grow },
					h('div', { style: styles.name }, server.name),
					h('div', { style: styles.meta }, serverSummary(server)),
					h('div', { style: styles.meta },
						`${statusLabel(server.status, t)}${server.live ? ` · ${t('servers.live')} ${server.toolCount}` : ''}`
						+ ` · ${t(server.loadMode === 'eager' ? 'loadMode.eager' : 'loadMode.lazy')}`,
					),
				),
				h('button', { style: styles.button, onClick: () => setEditing(draftOf(server)) }, t('servers.edit')),
				h('button', { style: styles.button, onClick: () => remove(server.name) }, t('servers.delete')),
			),
		))

	const form = editing === undefined
		? null
		: h(ServerForm, {
			key: 'form',
			t,
			initial: editing,
			busy,
			onSave: save,
			onClose: () => setEditing(undefined),
		})

	return h('div', null,
		h('p', { style: styles.hint }, t('servers.hint')),
		h('div', { style: { ...styles.row, margin: '6px 0' } },
			h('div', { style: { ...styles.name, ...styles.grow } }, t('servers.title')),
			editing === undefined
				? h('button', { style: styles.primary, onClick: () => setEditing({ ...EMPTY_DRAFT }) }, t('servers.add'))
				: null,
		),
		form,
		list,
	)
}

// ---------------------------------------------------------------------------
// Settings: presets
// ---------------------------------------------------------------------------

/** One row of a preset: the server and its three-state switch. */
function presetRow(t: any, preset: PresetView, server: ServerView, busy: boolean, onChange: (state: PresetState) => void): any {
	// Inside `default` a missing row means "on", so the switch must show that too.
	const current: PresetState = preset.rows[server.name]
		?? (preset.name === DEFAULT_PRESET ? 'on' : 'inherit')
	const segment = (state: PresetState, label: string): any => h('button', {
		key: state,
		style: styles.segment(current === state),
		disabled: busy,
		onClick: () => onChange(state),
	}, label)
	const states = preset.name === DEFAULT_PRESET
		? [segment('on', t('state.on')), segment('off', t('state.off'))]
		: [segment('on', t('state.on')), segment('off', t('state.off')), segment('inherit', t('state.inherit'))]
	return h('div', { style: { ...styles.row, padding: '4px 0' }, key: server.name },
		h('div', { style: styles.grow },
			h('div', { style: styles.name }, server.name),
			h('div', { style: styles.meta }, server.description === '' ? serverSummary(server) : server.description),
		),
		h('div', { style: { display: 'flex', gap: '4px' } }, states),
	)
}

function PresetsTab(props: any): any {
	const t = props.t
	const doc: StateDoc = props.doc
	const { reload, busy, run } = props
	// One expanded tile at a time: the list stays readable with many presets.
	const [expanded, setExpanded] = useState<string>(DEFAULT_PRESET)
	const [name, setName] = useState('')

	const setRow = (preset: PresetView, server: ServerView, state: PresetState): void => {
		run(async () => {
			const rows = { ...preset.rows }
			if (state === 'inherit') delete rows[server.name]
			else rows[server.name] = state
			await request('/preset', { name: preset.name, rows })
			reload()
		})
	}

	const create = (): void => {
		const target = name.trim()
		run(async () => {
			await request('/preset', { name: target, rows: {} })
			setName('')
			setExpanded(target)
			reload()
		})
	}

	const remove = (preset: PresetView): void => {
		run(async () => {
			await request('/preset/delete', { name: preset.name })
			setExpanded(DEFAULT_PRESET)
			reload()
		})
	}

	/** What the switch shows for a server that has no row in this preset. */
	const stateOf = (preset: PresetView, server: ServerView): PresetState =>
		preset.rows[server.name] ?? (preset.name === DEFAULT_PRESET ? 'on' : 'inherit')

	const tile = (preset: PresetView): any => {
		const open = preset.name === expanded
		const on = doc.servers.filter(server => stateOf(preset, server) === 'on').length
		return h('div', { key: preset.name, style: { marginBottom: '5px' } },
			h('button', {
				style: styles.tile(open),
				onClick: () => setExpanded(open ? '' : preset.name),
				'aria-expanded': open,
			},
				h('span', { style: { ...styles.grow, minWidth: 0 } },
					h('div', { style: styles.name }, preset.name),
					h('div', { style: styles.meta }, `${on} / ${doc.servers.length}`),
				),
				h('span', { style: styles.meta }, open ? '▾' : '▸'),
			),
			open
				? h('div', { style: { ...styles.card, marginTop: '6px', marginBottom: 0 } },
					preset.name === DEFAULT_PRESET
						? h('div', { style: styles.meta }, t('presets.defaultHint'))
						: h('div', { style: styles.meta }, t('presets.customHint')),
					doc.servers.length === 0
						? h('p', { style: styles.empty }, t('servers.empty'))
						: doc.servers.map(server => presetRow(t, preset, server, busy, (state: PresetState) => setRow(preset, server, state))),
					preset.name === DEFAULT_PRESET
						? null
						: h('div', { style: { ...styles.row, marginTop: '8px' } },
							h('button', { style: styles.button, disabled: busy, onClick: () => remove(preset) }, t('presets.delete')),
						),
				)
				: null,
		)
	}

	return h('div', null,
		h('p', { style: styles.hint }, t('presets.hint')),
		doc.presets.map(tile),
		h('div', { style: { ...styles.row, marginTop: '10px' } },
			h('input', {
				style: { ...styles.input, flex: 1 },
				value: name,
				placeholder: t('presets.namePlaceholder'),
				onChange: (event: any) => setName(event.target.value),
			}),
			h('button', {
				style: styles.primary,
				disabled: busy || name.trim() === '',
				onClick: create,
			}, t('presets.create')),
		),
	)
}

// ---------------------------------------------------------------------------
// Settings: folder assignments
// ---------------------------------------------------------------------------

function FoldersTab(props: any): any {
	const t = props.t
	const doc: StateDoc = props.doc
	const { reload, busy, run } = props

	const assigned = new Map<string, string>(doc.folders.map(folder => [folder.path, folder.preset]))
	const rows: Array<{ path: string; title?: string }> = []
	const seen = new Set<string>()
	for (const workspace of doc.workspaces) {
		if (seen.has(workspace.path)) continue
		seen.add(workspace.path)
		rows.push(workspace)
	}
	for (const folder of doc.folders) {
		if (seen.has(folder.path)) continue
		seen.add(folder.path)
		rows.push({ path: folder.path })
	}
	rows.sort((left, right) => left.path.localeCompare(right.path))

	const assign = (target: string, next: string): void => {
		run(async () => {
			if (next === DEFAULT_PRESET) await request('/folder/delete', { path: target })
			else await request('/folder', { path: target, preset: next })
			reload()
		})
	}
	const select = (target: string): any => h('select', {
		style: { ...styles.input, width: 'auto' },
		value: assigned.get(target) ?? DEFAULT_PRESET,
		disabled: busy,
		onChange: (event: any) => assign(target, event.target.value),
	},
		h('option', { value: DEFAULT_PRESET }, t('folders.defaultOption')),
		doc.presets.filter(entry => entry.name !== DEFAULT_PRESET)
			.map(entry => h('option', { value: entry.name, key: entry.name }, entry.name)),
	)

	const list = rows.length === 0
		? h('p', { style: styles.empty }, t('folders.empty'))
		: rows.map(row => h('div', { style: styles.card, key: row.path },
			h('div', { style: styles.row },
				h('div', { style: styles.grow },
					h('div', { style: styles.name }, row.title === undefined || row.title === '' ? row.path : row.title),
					h('div', { style: styles.meta }, row.path),
					doc.cwd !== '' && doc.cwd.toLowerCase() === row.path.toLowerCase()
						? h('div', { style: styles.meta }, t('folders.active'))
						: null,
				),
				select(row.path),
			),
		))

	return h('div', null,
		h('p', { style: styles.hint }, t('folders.hint')),
		list,
	)
}

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

function SettingsPage(props: any): any {
	const t = props.t
	const [tab, setTab] = useState<'servers' | 'presets' | 'folders'>('servers')
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)
	const [showChip, setShowChip] = useState<boolean | undefined>(undefined)
	const { sessionId, cwd } = usePanelSession(props)
	const { doc, error: loadError, reload } = useStateDoc(sessionId, 0, cwd)

	const run = useCallback((task: () => Promise<void>) => {
		setBusy(true)
		task().then(
			() => setError(undefined),
			(cause: unknown) => setError(messageOf(cause)),
		).finally(() => setBusy(false))
	}, [])

	const chip = showChip ?? doc?.settings.showChip ?? true

	const toggleChip = (next: boolean): void => {
		setShowChip(next)
		run(async () => {
			await request('/settings', { showChip: next })
			reload()
		})
	}

	const body = doc === undefined
		? h('p', { style: styles.empty }, t('loading'))
		: tab === 'servers'
			? h(ServersTab, { t, doc, reload, busy, run })
			: tab === 'presets'
				? h(PresetsTab, { t, doc, reload, busy, run })
				: h(FoldersTab, { t, doc, reload, busy, run })

	const tabButton = (id: 'servers' | 'presets' | 'folders', label: string): any =>
		h('button', { key: id, style: styles.tab(tab === id), onClick: () => setTab(id) }, label)

	return h('div', { style: styles.page },
		h('div', { style: styles.header },
			h('p', { style: styles.hint }, t('panel.subtitle')),
			h('div', { style: { ...styles.row, margin: '8px 0' } },
				h('div', { style: styles.grow },
					h('div', { style: styles.name }, t('settings.showChip')),
					h('div', { style: styles.meta }, t('settings.showChipHint')),
				),
				toggleSwitch(chip, toggleChip, 'show-chip', busy),
			),
			h('div', { style: { ...styles.tabs, margin: 0 } },
				tabButton('servers', t('tabs.servers')),
				tabButton('presets', t('tabs.presets')),
				tabButton('folders', t('tabs.folders')),
			),
			loadError === undefined ? null : h('p', { style: styles.error }, loadError),
			error === undefined ? null : h('p', { style: styles.error }, error),
		),
		h('div', { style: styles.scroll }, body),
	)
}

// ---------------------------------------------------------------------------
// Composer chip
// ---------------------------------------------------------------------------

/** Preset picker for the folder of the current chat. */
function ChipPopup(props: any): any {
	const t = props.t
	const rect: DOMRect | null = props.rect
	const doc: StateDoc | undefined = props.doc
	const { error, reload, busy, run, sessionId, cwd } = props

	const assign = (preset: string): void => {
		run(async () => {
			if (preset === DEFAULT_PRESET) await request('/folder/delete', { path: cwd })
			else await request('/folder', { path: cwd, preset })
			reload()
		})
	}

	const current = doc?.preset ?? DEFAULT_PRESET
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
	},
		h('span', { style: { ...styles.grow, ...styles.name } }, preset.name === DEFAULT_PRESET ? t('chip.defaultPreset') : preset.name),
		preset.name === current ? h('span', { style: styles.meta }, t('chip.current')) : null,
	))

	return ReactDOM.createPortal(
		h('div', { style: styles.popover(rect) },
			h('div', { style: { ...styles.row, marginBottom: '6px' } },
				h('div', { style: { ...styles.name, ...styles.grow } }, t('chip.title')),
				h('button', { style: styles.button, onClick: props.onClose }, '×'),
			),
			h('div', { style: styles.meta }, cwd === '' ? t('chip.noFolder') : cwd),
			doc === undefined ? h('p', { style: styles.empty }, t('loading')) : rows,
			error === undefined ? null : h('p', { style: styles.error }, error),
		),
		document.body,
	)
}

function Chip(props: any): any {
	const t = props.t
	const sessionId: string | undefined = props.sessionId
	const cwd = useSessionCwd(props)
	const [open, setOpen] = useState(false)
	const [busy, setBusy] = useState(false)
	const [error, setError] = useState<string | undefined>(undefined)
	const [rect, setRect] = useState<DOMRect | null>(null)
	const button = useRef<any>(null)
	const { doc, reload } = useStateDoc(sessionId, 0, cwd)

	const run = useCallback((task: () => Promise<void>) => {
		setBusy(true)
		task().then(
			() => setError(undefined),
			(cause: unknown) => setError(messageOf(cause)),
		).finally(() => setBusy(false))
	}, [])

	// The switch lives in the plugin settings; when it is off the chip is gone.
	if (doc !== undefined && doc.settings.showChip === false) return null
	if (doc === undefined) return null

	// `mcp` alone when the folder runs the default preset, the preset name otherwise.
	const label = doc.preset === DEFAULT_PRESET ? 'MCP' : `MCP · ${doc.preset}`
	const live = doc.servers.filter(server => server.allowed && server.live).length

	const toggle = (): void => {
		const box = button.current?.getBoundingClientRect?.()
		setRect(box ?? null)
		setOpen(!open)
	}

	return h('div', { style: { position: 'relative', display: 'inline-flex' } },
		h('button', {
			ref: button,
			style: styles.chip,
			title: t('chip.hint'),
			onClick: toggle,
		},
			h('span', { style: styles.dot(live > 0 ? 'ready' : 'inactive') }),
			label,
		),
		open
			? h(ChipPopup, { t, rect, doc, error, reload, busy, run, sessionId, cwd, onClose: () => setOpen(false) })
			: null,
	)
}

// ---------------------------------------------------------------------------
// Dictionaries
// ---------------------------------------------------------------------------

const EN: Record<string, string> = {
	'panel.meta.title': 'MCP Tool',
	'panel.meta.description': 'MCP servers are registered globally; presets decide which of them may run, and every folder can pick a preset.',
	'panel.subtitle': 'Servers are registered globally. A preset decides which of them may run, and every folder can use its own preset.',
	'loading': 'Loading…',
	'settings.showChip': 'Show the chip in the chat',
	'settings.showChipHint': 'A small preset switch next to the composer, so a folder preset can be changed without opening settings.',
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
}

const RU: Record<string, string> = {
	'panel.meta.title': 'MCP Tool',
	'panel.meta.description': 'MCP-серверы заводятся глобально; пресеты решают, каким из них можно работать, а каждая папка может выбрать свой пресет.',
	'panel.subtitle': 'Серверы заводятся глобально. Пресет решает, какие из них работают, а каждая папка может использовать свой пресет.',
	'loading': 'Загрузка…',
	'settings.showChip': 'Показывать чип в диалоге',
	'settings.showChipHint': 'Небольшой переключатель пресета рядом с полем ввода — папку можно переключить, не открывая настройки.',
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
}

/** Mounts the settings page and the composer chip. */
export function apply(ctx: any): void {
	ctx.effect(() => ctx.locale.register(NS, 'en', EN), 'mcp-tool: en dictionary')
	ctx.effect(() => ctx.locale.register(NS, 'ru', RU), 'mcp-tool: ru dictionary')
	const t = ctx.locale.bind(NS)

	ctx.effect(() => ctx.slots.inject('settings.section', () => ctx.slots.register({
		name: 'settings.section',
		id: SECTION_ID,
		order: 420,
		label: () => t('panel.meta.title'),
		locale: NS,
	}, SettingsPage)), 'mcp-tool: settings page')

	ctx.effect(() => ctx.slots.inject('settings.section.icon', () => ctx.slots.register({
		name: 'settings.section.icon',
		id: SECTION_ID,
		order: 420,
		label: () => t('panel.meta.title'),
		locale: NS,
	}, PlugIcon)), 'mcp-tool: settings icon')

	ctx.effect(() => ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
		name: 'conversation.input.right',
		id: SECTION_ID,
		order: 60,
		label: () => t('chip.hint'),
		locale: NS,
	}, Chip)), 'mcp-tool: composer chip')
}
