/**
 * Preloaded into every `pnpm test` process (`node --test --import ./scripts/scratch-home.ts`): the runner and each test
 * file get a HOME of their own in a temp directory, removed when the process exits. Whatever a test reaches, dish's own
 * git, a child process or a default path under `~`, sees that scratch HOME and never the runner's. HISTFILE goes there
 * too, so an interactive shell started with this environment can't write the runner's history.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const home = mkdtempSync(join(tmpdir(), 'dish-test-home-'))
process.env.HOME = home
process.env.HISTFILE = join(home, '.bash_history')
process.on('exit', () => { rmSync(home, { recursive: true, force: true }) })
