// Write a plugin's defaults/previous.json: for each default file, the sha256 of every earlier version
// committed to git, so a seeded document that is still unedited can be replaced by the new default.
//   node <dish-kit>/scripts/previous-defaults.mjs <defaultsDir> <prefix> [--exclude NAME]...
// <prefix> is the store prefix of <defaultsDir> (`prompts/` for plugins/prompts/defaults); a file at
// <defaultsDir>/crew/coder.md is the store path `<prefix>crew/coder.md`. --exclude NAME skips a file by
// base name or by path relative to <defaultsDir> (previous.json itself is always skipped).
// Run it before changing a default and again after: it needs the old text in git history. A shallow clone
// or a directory outside a git repository has none, and the script says so and stops.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { computePrevious } from '../src/defaults.ts'

const USAGE = 'usage: previous-defaults.mjs <defaultsDir> <prefix> [--exclude NAME]...'

function usage(message) {
  console.error(`previous-defaults: ${message}\n${USAGE}`)
  process.exit(2)
}

const positional = []
const exclude = []
const args = process.argv.slice(2)
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--exclude') {
    if (i + 1 >= args.length) usage('--exclude needs a name')
    exclude.push(args[++i])
  } else if (arg.startsWith('--exclude=')) {
    exclude.push(arg.slice('--exclude='.length))
  } else if (arg.startsWith('--')) {
    usage(`unknown option ${arg}`)
  } else {
    positional.push(arg)
  }
}
if (positional.length !== 2) usage('expected a defaults directory and a prefix')
const [directory, prefix] = positional

try {
  const previous = await computePrevious(directory, prefix, exclude)
  const sorted = Object.fromEntries(Object.entries(previous).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
  await writeFile(path.join(directory, 'previous.json'), `${JSON.stringify(sorted, null, 2)}\n`)
} catch (error) {
  const code = error && typeof error === 'object' && 'code' in error ? ` (${error.code})` : ''
  console.error(`previous-defaults: ${error instanceof Error ? error.message : error}${code}`)
  process.exit(1)
}
