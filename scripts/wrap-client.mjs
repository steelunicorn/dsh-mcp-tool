import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

// Wraps the compiled ESM client module into the DSH module-factory format.
// The client source deliberately has no value imports: React and friends are
// reached through the `require` the loader hands to the factory, so the emitted
// body only needs its `export` keywords stripped and a return statement added.

const root = dirname(fileURLToPath(import.meta.url))
const source = join(root, '..', 'lib-client', 'client.js')
const target = join(root, '..', 'lib', 'client.js')

const code = await readFile(source, 'utf8')
const body = code
	.replace(/^export\s+/gm, '')
	.split('\n')
	.map((line) => (line.length > 0 ? `\t\t${line}` : line))
	.join('\n')

const wrapped = `window.__ModuleLoader__.load({
\tid: 'dsh-mcp-tool',
\tfactory(require) {
${body}
\t\treturn { inject, apply }
\t},
})
`

await mkdir(dirname(target), { recursive: true })
await writeFile(target, wrapped, 'utf8')
console.log(`wrapped ${source} -> ${target}`)
