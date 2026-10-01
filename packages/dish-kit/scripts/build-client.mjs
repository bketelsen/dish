// Bundle a plugin's src/client into lib/client.js in the shape dsh's client
// module loader expects: one CommonJS factory registered with
// window.__ModuleLoader__, with the shell's platform modules left as require()
// calls it satisfies. Run from the plugin directory:
//   node <dish-kit>/scripts/build-client.mjs [--watch]
// The package name comes from <cwd>/package.json; the entry is
// <cwd>/src/client/index.tsx and the output <cwd>/lib/client.js.
// `--watch` rebuilds on change; the running dsh hot-swaps the bundle.
import { context } from 'esbuild'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const cwd = process.cwd()
const { name } = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf8'))
const watch = process.argv.includes('--watch')

const ctx = await context({
  entryPoints: [join(cwd, 'src/client/index.tsx')],
  outfile: join(cwd, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: 'linked',
  logLevel: 'info',
  // The shell's PLATFORM_MODULES table; everything else is bundled.
  external: [
    'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-store', '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-dockkit',
  ],
  define: { 'process.env.NODE_ENV': '"production"' },
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(name)}, factory: (require) => { var module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
})

if (watch) {
  await ctx.watch()
} else {
  await ctx.rebuild()
  await ctx.dispose()
}
