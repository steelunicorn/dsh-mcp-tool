/**
 * The model-facing prompt section that explains the folder's MCP servers.
 *
 * The section is declared once and evaluated at every assembly, so a preset
 * switched in the GUI changes the model's picture on the next step without a
 * plugin restart.
 *
 * @module dsh-mcp-tool/prompt
 */

import type { Resolution } from './policy.js'
import type { ServerRecord } from './store.js'

/** Order right after the MCP client's own `MCP_SERVERS` section (3100). */
export const SECTION_ORDER = 3110

/** The section's registration name. */
export const SECTION_NAME = 'mcp-tool:folder-servers'

/** Text for one folder, or an empty string when no server is switched on. */
export function promptText(cwd: string, resolution: Resolution, servers: ServerRecord[]): string {
	if (servers.length === 0) return ''
	const list = servers
		.map(record => {
			const external = record.origin === 'profile'
			const mode = external || record.loadMode === 'eager' ? ', always running' : ''
			return `- ${record.name} (${record.transport}${mode})${record.description === undefined ? '' : `: ${record.description}`}`
		})
		.join('\n')
	const origin = resolution.source === 'folder'
		? `from the preset "${resolution.preset}" assigned to ${resolution.path ?? cwd}`
		: `from the default preset "${resolution.preset}"`
	const lines = [
		`MCP servers available in ${cwd} (${origin}):`,
		list,
		'',
		'Servers marked "always running" are started by the DSH MCP settings: their tools',
		'are already available, and mcp_load only lists them.',
		'The other servers are registered globally but stay stopped until you need them.',
		'Call mcp_load with a server name to start it; its tools become callable as',
		'mcp__<server>__<tool> starting with your next step. Call mcp_release as soon as',
		'you are done with a server, so its process stops. A folder without its own',
		'preset uses the default preset, which may switch every server off.',
	]
	return lines.join('\n')
}
