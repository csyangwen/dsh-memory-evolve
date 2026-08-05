/**
 * Build the dsh-memory-evolve client bundle.
 *
 * Produces lib/client.js in the exact wire format the DSH web shell expects:
 * a CJS factory handed to window.__ModuleLoader__.load({ id, factory }), with
 * platform modules resolved through the injected require (the loader module
 * table) and everything else inlined. CSS files are imported as text and
 * injected as a <style> tag by the entry's apply().
 *
 * esbuild is resolved from the DSH source checkout (the only place it is
 * installed); the plugin package itself has zero runtime dependencies.
 * Set DSH_SOURCE to the DSH checkout root when it is not the default
 * ~/.dsh/source/current (or wherever $DSH_HOME points).
 */
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { existsSync, readdirSync } from 'node:fs'

/** Loader entry name — must match the `name` in ~/.dsh/config.yaml EXACTLY. */
const PLUGIN_ID = '@dsh-local/dsh-memory-evolve'

/** Platform module table (must stay aligned with packages/client/web/src/platform.ts + the runtime exemption). */
const EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  'cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-web-react',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-schema-form',
  '@deepseek-ai/dsh-client-runtime/client',
]

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
/** DSH source checkout root; override with $DSH_SOURCE when not the default. */
const CHECKOUT = process.env.DSH_SOURCE ?? join(homedir(), '.dsh/source/current')

/** Locate the esbuild package inside a pnpm checkout (store or hoisted). */
function resolveEsbuild(checkout) {
  const store = join(checkout, 'node_modules/.pnpm')
  if (existsSync(store)) {
    const entries = readdirSync(store).filter((name) => name.startsWith('esbuild@')).sort()
    for (let i = entries.length - 1; i >= 0; i -= 1) {
      const candidate = join(store, entries[i], 'node_modules/esbuild/package.json')
      if (existsSync(candidate)) return candidate
    }
  }
  const hoisted = join(checkout, 'node_modules/esbuild/package.json')
  if (existsSync(hoisted)) return hoisted
  throw new Error(`esbuild not found under ${checkout} (set DSH_SOURCE to the DSH checkout root)`)
}

const require = createRequire(resolveEsbuild(CHECKOUT))
const esbuild = require('esbuild')

const banner = [
  `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
  'var module = { exports: {} }; var exports = module.exports;',
].join('\n')
const footer = 'return module.exports; } });'

await esbuild.build({
  entryPoints: [join(ROOT, 'src/client/index.ts')],
  outfile: join(ROOT, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  external: EXTERNALS,
  define: {
    'process.env.NODE_ENV': '"production"',
    'import.meta.env.MODE': '"production"',
    'import.meta.env': '{"MODE":"production"}',
  },
  loader: { '.css': 'text' },
  banner: { js: banner },
  footer: { js: footer },
})

console.log('lib/client.js built')
