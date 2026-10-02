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
 *    can't be trusted (the spec's "Fresh checkouts only").
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
/** How many lines of setup's log a failure's message carries. */
const FAILURE_LINES = 20

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
  if (error instanceof GitHubError && error.kind === 'no-credentials') return new OnboardError(step, 'set the GitHub App on Settings → GitHub App')
  return new OnboardError(step, `${what}: ${messageOf(error)}`)
}

/** `error` as the step's: an OnboardError or an abort as it is, anything else an OnboardError of `step`. */
function asStepError(step: OnboardStep, error: unknown): Error {
  if (error instanceof OnboardError || (error as Error | undefined)?.name === 'AbortError') return error as Error
  return new OnboardError(step, messageOf(error))
}

/** The last `count` lines of `text`. */
function lastLines(text: string, count: number): string {
  return text.replace(/\n$/, '').split('\n').slice(-count).join('\n')
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
  if (installation === undefined) throw new OnboardError('installation', `install the dish App on ${project.owner} and give it ${project.repo}`)
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
      throw new OnboardError('installation', `install the dish App on ${project.owner} and give it ${project.repo}`)
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
  } else if (adopted) {
    setup = { ran: false, reason: skipReason(EXISTING_CHECKOUT, clone, project.setup) }
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
      const tail = lastLines(result.tail, FAILURE_LINES)
      throw new OnboardError('setup', `${how}; last lines:${tail === '' ? ' (none)' : `\n${tail}`}`)
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
