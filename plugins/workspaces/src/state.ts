/**
 * A project's clone state: `<state>/workspaces/<owner>/<repo>/clone.json`, what dish knows about the clone it made or
 * adopted (the installation, the workspace it registered, the last fetch and the last setup).
 *
 * The file is dish's own (agents can't write under dish's state directory), written whole or not at all
 * (`writeFileAtomic`, 0600). It never holds a credential: the messages and reasons it keeps are masked again on the
 * way in, whatever the caller did.
 *
 * @module dish-workspaces/state
 */

import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { maskSecrets } from 'dish-kit'
import { maskUrlPasswords } from './git.ts'
import { writeFileAtomic } from './paths.ts'

export interface CloneState {
  /** The clone's path: absolute, and canonical once the clone is there. */
  clone: string
  /** Whether dish found the clone there (adopted it) rather than making it. */
  adopted: boolean
  /** The GitHub App installation that reads the repo, once found. */
  installation: number | null
  /** The dsh workspace dish registered for the clone. */
  workspace: { id: string, registeredAt: number } | null
  lastFetch: { at: number, ok: boolean, message?: string } | null
  setup: { at: number, ran: boolean, exitCode: number | null, timedOut: boolean, reason?: string } | null
}

/** The most characters a kept message or reason has. */
const MAX_TEXT = 2000

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isTime(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** `text` masked and cut: what the file may keep. */
function kept(text: string): string {
  const masked = maskSecrets(maskUrlPasswords(text))
  return masked.length > MAX_TEXT ? `${masked.slice(0, MAX_TEXT - 1)}…` : masked
}

/** One nullable part: absent counts as null (an older file), a wrong shape makes the whole file corrupt. */
function part<T>(value: unknown, parse: (value: Record<string, unknown>) => T | undefined): T | null | undefined {
  if (value === undefined || value === null) return null
  return isRecord(value) ? parse(value) : undefined
}

/** A parsed `clone.json`, or `undefined` when it isn't one. Unknown fields are dropped. */
export function parseCloneState(text: string): CloneState | undefined {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return undefined
  }
  if (!isRecord(json) || typeof json.clone !== 'string' || !isAbsolute(json.clone) || typeof json.adopted !== 'boolean') return undefined
  const installation = json.installation === undefined || json.installation === null
    ? null
    : Number.isSafeInteger(json.installation) && (json.installation as number) > 0 ? json.installation as number : undefined
  const workspace = part(json.workspace, value =>
    typeof value.id === 'string' && value.id !== '' && isTime(value.registeredAt) ? { id: value.id, registeredAt: value.registeredAt } : undefined)
  const lastFetch = part(json.lastFetch, value => {
    if (!isTime(value.at) || typeof value.ok !== 'boolean') return undefined
    if (value.message !== undefined && typeof value.message !== 'string') return undefined
    return { at: value.at, ok: value.ok, ...value.message === undefined ? {} : { message: value.message } }
  })
  const setup = part(json.setup, value => {
    if (!isTime(value.at) || typeof value.ran !== 'boolean' || typeof value.timedOut !== 'boolean') return undefined
    if (!(value.exitCode === null || Number.isSafeInteger(value.exitCode))) return undefined
    if (value.reason !== undefined && typeof value.reason !== 'string') return undefined
    return {
      at: value.at, ran: value.ran, exitCode: value.exitCode as number | null, timedOut: value.timedOut,
      ...value.reason === undefined ? {} : { reason: value.reason },
    }
  })
  if (installation === undefined || workspace === undefined || lastFetch === undefined || setup === undefined) return undefined
  return { clone: json.clone, adopted: json.adopted, installation, workspace, lastFetch, setup }
}

/** The clone state in `file`; `undefined` when there is none, or it is corrupt (the caller logs that). */
export async function readCloneState(file: string): Promise<CloneState | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return undefined
  }
  return parseCloneState(text)
}

/** Write `state` to `file` atomically (0600, directories 0700), its messages and reasons masked. */
export async function writeCloneState(file: string, state: CloneState): Promise<void> {
  const clean: CloneState = {
    clone: state.clone,
    adopted: state.adopted,
    installation: state.installation,
    workspace: state.workspace === null ? null : { id: state.workspace.id, registeredAt: state.workspace.registeredAt },
    lastFetch: state.lastFetch === null ? null : {
      at: state.lastFetch.at,
      ok: state.lastFetch.ok,
      ...state.lastFetch.message === undefined ? {} : { message: kept(state.lastFetch.message) },
    },
    setup: state.setup === null ? null : {
      at: state.setup.at,
      ran: state.setup.ran,
      exitCode: state.setup.exitCode,
      timedOut: state.setup.timedOut,
      ...state.setup.reason === undefined ? {} : { reason: kept(state.setup.reason) },
    },
  }
  await writeFileAtomic(file, `${JSON.stringify(clean, null, 2)}\n`)
}
