// Bundle src/client into lib/client.js in the shape dsh's client module loader
// expects: one CommonJS factory registered with window.__ModuleLoader__, with
// the shell's platform modules left as require() calls it satisfies.
// `--watch` rebuilds on change; the running dsh hot-swaps the bundle.
import { context } from 'esbuild'
import { readFileSync } from 'node:fs'

const { name } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const watch = process.argv.includes('--watch')

const ctx = await context({
  entryPoints: [new URL('../src/client/index.tsx', import.meta.url).pathname],
  outfile: new URL('../lib/client.js', import.meta.url).pathname,
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
