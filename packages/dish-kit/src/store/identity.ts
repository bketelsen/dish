import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { gitEnv } from './git.ts'
import type { GitIdentity } from './git.ts'

/** The identity commits made by an agent, and by a store itself, carry unless a plugin's settings say otherwise. */
export const AGENT_IDENTITY: Readonly<GitIdentity> = Object.freeze({ name: 'dish agent', email: 'agent@dish.local' })

const FALLBACK_NAME = 'dish'
const FALLBACK_EMAIL = 'dish@localhost'

const execFileAsync = promisify(execFile)

/** A string setting as it will be used: trimmed, and `undefined` when nothing is left (use the default). */
function text(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

/** One value of git's global config, read as the store reads everything (scrubbed environment, no prompts), or `undefined` if there is none. */
async function gitGlobal(key: 'user.name' | 'user.email'): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync('git', ['config', '--global', '--includes', '--get', key], { env: gitEnv(), timeout: 10_000, encoding: 'utf8' })
    return text(stdout)
  } catch {
    // Not set (exit 1), or no git at all: the store will find its own way to report the latter.
    return undefined
  }
}

/**
 * The identity for commits made by a person: a plugin's `userName` and `userEmail` settings, then git's global
 * config, then `dish`. Each half is taken on its own: a blank setting (or one of only spaces) counts as unset.
 */
export async function personIdentity(config: { userName?: string, userEmail?: string }): Promise<GitIdentity> {
  const userName = text(config.userName)
  const userEmail = text(config.userEmail)
  const [gitName, gitEmail] = await Promise.all([
    userName === undefined ? gitGlobal('user.name') : undefined,
    userEmail === undefined ? gitGlobal('user.email') : undefined,
  ])
  return { name: userName ?? gitName ?? FALLBACK_NAME, email: userEmail ?? gitEmail ?? FALLBACK_EMAIL }
}
