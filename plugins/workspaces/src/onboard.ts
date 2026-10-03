/**
 * Onboarding one project: the spec's steps 1 to 5, each reported through `progress` before it starts.
 *
 * 1. **installation:** the App's installation on the owner, for the repo (`GET /repos/{o}/{r}/installation`, JWT); the
 *    repo joins its owner's read token (`setRepositories` with the service's map plus this repo), and the token file is
 *    made (`ensureFileToken`).
 * 2. **clone:** `cloneOrAdopt` (clone.ts).
 * 3. **configure:** the App's bot identity (`GET /app`, then `GET /users/<slug>[bot]` without a credential: the endpoint
 *    is public, so an installation that hasn't accepted Pull requests read, which dish's in-memory API token needs,
 *    still onboards), then `configureClone`.
 * 4. **setup:** outside the sandbox only in a clone dish has just made (its own fresh clone of GitHub's default branch).
 *    An adopted clone (adopting, or Retry) is skipped with the command to run: an existing checkout's ignored files
 *    can't be trusted (the spec's "Fresh checkouts only"). So is a fresh clone at a path where a dsh workspace other
 *    than the project's own points (`otherWorkspaceAt`): chats in that workspace could write in the clone while setup
 *    runs. The project's own (a Retry after its clone was deleted by hand) doesn't stop setup, and neither does one
 *    dish can't place. A setup that fails says how to run it again: Retry adopts the clone and skips setup.
 * 5. **workspace:** registered with dsh's workspace registry, titled with the project's name, and recorded; without a
 *    registry (a profile other than `web`), skipped, to be registered when one appears. The signal is checked first, so
 *    a project removed while it onboarded never gets a workspace.
 *
 * What it learns goes to the clone state (`clone.json`) as it goes. A failure is an `OnboardError` naming its step,
 * with a masked message; an abort (the signal) is an error named `AbortError`, which dish-projects records nothing for.
 * The caller (the service) runs it under the project's lock, so nothing else works in the clone meanwhile.
 *
 * @module dish-workspaces/onboard
 */

import { lstat } from 'node:fs/promises'
import type { Project } from 'dish-projects/registry'
import { OnboardError, abortError, cloneOrAdopt, configureClone } from './clone.ts'
import type { CloneDeps, OnboardStep } from './clone.ts'
import { GitHubError, botIdentity } from './github.ts'
import type { GitHubApp } from './github.ts'
import { cloneStateFile, clonePath, setupLogFile } from './paths.ts'
import { registerWorkspace } from './registry.ts'
import type { WorkspaceRegistryLike } from './registry.ts'
import { runSetup, skipReason } from './setup.ts'
import type { SetupOutcome } from './setup.ts'
import { readCloneState, writeCloneState } from './state.ts'
import type { CloneState } from './state.ts'
import type { OwnerRepos, TokenManager } from './tokens.ts'

export { OnboardError } from './clone.ts'
export type { OnboardStep } from './clone.ts'

/** Why the workspace step was skipped in a profile without dsh's workspace registry. */
export const NO_REGISTRY = 'no workspace registry in this profile'
/** Why setup doesn't run in an adopted clone. */
export const EXISTING_CHECKOUT = 'it is an existing checkout'
/** Why setup doesn't run in a fresh clone that a dsh workspace other than the project's own points at. */
export const WORKSPACE_THERE = 'a dsh workspace already points at this path'
/** What to do about setup's failure: Retry adopts the clone and skips setup. */
const AFTER_FAILURE = "Retry won't run setup again in this clone: remove the clone and press Retry, or run it yourself in"
/** How many lines of setup's log a failure's message carries. */
const FAILURE_LINES = 20
/** The longest a failure's message is: dish-projects shows a status's first 1000 characters, and masks it again. */
const FAILURE_CHARS = 900
/** What a message about the App adds: the project waits as failed until Retry. */
const THEN_RETRY = 'then press Retry on Settings → Projects'

export interface OnboardResult {
  clone: string
  adopted: boolean
  setup: SetupOutcome
  workspace: { id: string } | { skipped: string }
}

export interface OnboardDeps extends CloneDeps {
  app: Pick<GitHubApp, 'installationFor' | 'app' | 'botUser'>
  /** No API token: the bot is looked up without one, so an installation without Pull requests read still onboards. */
  tokens: Pick<TokenManager, 'ensureFileToken' | 'setRepositories'>
  /** The service's current map, so a new project's repo joins its owner's token. */
  repositories(): ReadonlyMap<string, OwnerRepos>
  /** dsh's workspace registry, when this profile has one. */
  registry(): WorkspaceRegistryLike | undefined
  /** The bot identity, when the caller caches it (once per service life); else `appIdentity(app)` each time. */
  identity?: () => Promise<{ name: string, email: string }>
}

/** The App's bot identity: `GET /app`'s slug (JWT), then the bot's id from `GET /users/<slug>[bot]`, asked without a credential. */
export async function appIdentity(app: Pick<GitHubApp, 'app' | 'botUser'>): Promise<{ name: string, email: string }> {
  const { slug } = await app.app()
  const bot = await app.botUser(slug)
  return botIdentity(slug, bot.id)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What a failed GitHub call means for the step: the App not set at all points at its card. */
function githubFailure(step: OnboardStep, what: string, error: unknown): OnboardError {
  if (error instanceof GitHubError && error.kind === 'no-credentials') return new OnboardError(step, `set the GitHub App on Settings → GitHub App, ${THEN_RETRY}`)
  return new OnboardError(step, `${what}: ${messageOf(error)}`)
}

/** `error` as the step's: an OnboardError or an abort as it is, anything else an OnboardError of `step`. */
function asStepError(step: OnboardStep, error: unknown): Error {
  if (error instanceof OnboardError || (error as Error | undefined)?.name === 'AbortError') return error as Error
  return new OnboardError(step, messageOf(error))
}

/**
 * The last `count` lines of `text`, as many of them as fit in `max` characters (whole lines, from the end; a last line
 * longer than that keeps its end).
 */
function lastLines(text: string, count: number, max: number): string {
  const lines = text.replace(/\n$/, '').split('\n').slice(-count)
  const kept: string[] = []
  let size = 0
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]!
    if (size + line.length + 1 > max) {
      if (kept.length === 0) kept.unshift(`…${line.slice(line.length - Math.max(0, max - 1))}`)
      break
    }
    kept.unshift(line)
    size += line.length + 1
  }
  return kept.join('\n')
}

/** Steps 1–5, reporting each step through `progress` before it starts. Errors are OnboardError with a masked message. */
export async function onboardProject(
  project: Project,
  deps: OnboardDeps,
  options: { signal?: AbortSignal, progress?: (step: OnboardStep) => void } = {},
): Promise<OnboardResult> {
  const { signal } = options
  const file = cloneStateFile(deps.state, project.owner, project.repo)
  const begin = (step: OnboardStep): void => {
    if (signal?.aborted) throw abortError(`onboarding ${project.name}`)
    try {
      options.progress?.(step)
    } catch {
      // A listener's trouble isn't the project's.
    }
  }

  // What dish knew of the clone before; a corrupt file starts over.
  let state: CloneState | undefined = await readCloneState(file)
  // What dish recorded before this onboarding (its workspace among it), for step 4.
  const before = state
  if (state === undefined && await present(file)) deps.logger.warn('the clone state of %s was unreadable; it starts over', project.name)
  const save = async (next: CloneState): Promise<void> => {
    state = next
    await writeCloneState(file, next)
  }

  // 1. installation
  begin('installation')
  const installation = await deps.app.installationFor(project.owner, project.repo).catch((error: unknown) => {
    throw githubFailure('installation', `looking up the dish App's installation on ${project.name} failed`, error)
  })
  if (installation === undefined) throw new OnboardError('installation', `install the dish App on ${project.owner} and give it ${project.repo}, ${THEN_RETRY}`)
  try {
    await save({
      clone: state?.clone ?? clonePath(deps.workRoot, project.owner, project.repo),
      adopted: state?.adopted ?? false,
      installation: installation.id,
      workspace: state?.workspace ?? null,
      lastFetch: state?.lastFetch ?? null,
      setup: state?.setup ?? null,
    })
    await deps.tokens.setRepositories(withRepo(deps.repositories(), project, installation.id))
    const { dropped } = await deps.tokens.ensureFileToken(project.owner)
    if (dropped.some(repo => repo.toLowerCase() === project.repo.toLowerCase())) {
      throw new OnboardError('installation', `install the dish App on ${project.owner} and give it ${project.repo}, ${THEN_RETRY}`)
    }
  } catch (error) {
    throw asStepError('installation', error)
  }

  // 2. clone
  begin('clone')
  let clone: string
  let adopted: boolean
  try {
    ({ clone, adopted } = await cloneOrAdopt(project, deps, signal))
    await save({ ...state!, clone, adopted })
  } catch (error) {
    throw asStepError('clone', error)
  }

  // 3. configure
  begin('configure')
  try {
    const identity = deps.identity !== undefined
      ? await deps.identity()
      : await appIdentity(deps.app).catch((error: unknown) => { throw githubFailure('configure', "looking up the dish App's bot identity failed", error) })
    await configureClone(clone, project, identity, deps)
  } catch (error) {
    if (error instanceof GitHubError) throw githubFailure('configure', "looking up the dish App's bot identity failed", error)
    throw asStepError('configure', error)
  }

  // 4. setup
  begin('setup')
  let setup: SetupOutcome
  if (project.setup === undefined) {
    setup = { ran: false, reason: 'no setup' }
  } else if (adopted || await otherWorkspaceAt(deps.registry(), clone, before)) {
    setup = { ran: false, reason: skipReason(adopted ? EXISTING_CHECKOUT : WORKSPACE_THERE, clone, project.setup) }
    await save({ ...state!, setup: { at: Date.now(), ran: false, exitCode: null, timedOut: false, reason: setup.reason } }).catch((error: unknown) => {
      throw asStepError('setup', error)
    })
  } else {
    const result = await runSetup({ command: project.setup, cwd: clone, timeoutMs: project.setupTimeoutMs, log: setupLogFile(deps.state, project.owner, project.repo), signal })
      .catch((error: unknown) => { throw asStepError('setup', error) })
    if (result.aborted || signal?.aborted) throw abortError(`onboarding ${project.name}`)
    try {
      await save({ ...state!, setup: { at: Date.now(), ran: true, exitCode: result.exitCode, timedOut: result.timedOut } })
    } catch (error) {
      throw asStepError('setup', error)
    }
    if (result.timedOut || result.exitCode !== 0) {
      const how = result.timedOut
        ? `setup timed out after ${project.setupTimeout}`
        : result.exitCode !== null ? `setup exited ${result.exitCode}` : result.signal !== null ? `setup was ended by ${result.signal}` : "setup couldn't start"
      const after = `${AFTER_FAILURE} ${clone}`
      const tail = lastLines(result.tail, FAILURE_LINES, FAILURE_CHARS - how.length - after.length - 20)
      throw new OnboardError('setup', `${how}; last lines:${tail === '' ? ' (none)' : `\n${tail}`}\n${after}`)
    }
    setup = { ran: true, ...result }
  }

  // 5. workspace: never for a project removed meanwhile (begin checks the signal).
  begin('workspace')
  const registry = deps.registry()
  if (registry === undefined) return { clone, adopted, setup, workspace: { skipped: NO_REGISTRY } }
  try {
    const workspace = await registerWorkspace(registry, clone, project.name)
    await save({ ...state!, workspace: { id: workspace.id, registeredAt: Date.now() } })
    deps.logger.info('%s is registered as workspace %s', project.name, workspace.id)
    return { clone, adopted, setup, workspace: { id: workspace.id } }
  } catch (error) {
    throw asStepError('workspace', error)
  }
}

/**
 * Whether a dsh workspace that isn't the project's own points at `clone`, the fresh clone dish just made: the registry
 * (when this profile has one) has a workspace at the path, and dish's record from before this onboarding (`before`, its
 * `clone.json`) names another workspace, or none. dish records every workspace it registers for a project there, and
 * the record outlives the clone, so the project's own workspace (a Retry after the clone was deleted by hand) is told
 * apart from one made by hand or kept by someone else. A project removed and added again keeps its record too: its
 * kept workspace counts as its own.
 *
 * When dish can't tell (no record from before, which may be state that was lost, or a registry that can't be asked),
 * this is false and setup runs: the clone is fresh, and dish made it.
 */
async function otherWorkspaceAt(registry: WorkspaceRegistryLike | undefined, clone: string, before: CloneState | undefined): Promise<boolean> {
  if (registry === undefined || before === undefined) return false
  let found: { id: string } | undefined
  try {
    found = await registry.resolveByPath(clone)
  } catch {
    return false
  }
  return found !== undefined && found.id !== before.workspace?.id
}

/** The service's owner map with `project`'s repo in its owner's set, under `installation`. */
function withRepo(current: ReadonlyMap<string, OwnerRepos>, project: Project, installation: number): Map<string, OwnerRepos> {
  const next = new Map<string, OwnerRepos>()
  for (const [owner, entry] of current) {
    const key = owner.toLowerCase()
    const merged = next.get(key)
    next.set(key, merged === undefined ? { installation: entry.installation, repos: [...entry.repos] } : { installation: merged.installation, repos: [...merged.repos, ...entry.repos] })
  }
  const key = project.owner.toLowerCase()
  const repos = [...(next.get(key)?.repos ?? [])]
  if (!repos.some(repo => repo.toLowerCase() === project.repo.toLowerCase())) repos.push(project.repo)
  // One installation per owner: the one GitHub named just now.
  next.set(key, { installation, repos })
  return next
}

async function present(file: string): Promise<boolean> {
  try {
    await lstat(file)
    return true
  } catch {
    return false
  }
}
