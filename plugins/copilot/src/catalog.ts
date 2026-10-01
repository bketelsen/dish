/**
 * dish-copilot-catalog — keep the Copilot model list in step with the account.
 *
 * pi-ai ships Copilot's catalog as data frozen at its release, and `llm-pi-ai`
 * can only serve models that catalog describes: a Copilot route mixes three
 * wire protocols, so a model the catalog lacks has no protocol to speak. This
 * plugin refreshes from Copilot's live `/models` listing:
 *
 * - models the catalog lacks are added to pi-ai's in-memory catalog, cloned
 *   from their nearest catalog sibling on the same protocol, with the live
 *   name, limits, and vision support;
 * - the `github-copilot` route's model list is set to exactly what the account
 *   can use, which also drops catalog models it cannot.
 *
 * Additions are cached and re-applied at startup. `llm-pi-ai` reads the catalog
 * when its config changes, not per request, so this bundle makes the
 * `llm-pi-ai` row inject `copilotCatalog`: the adapter mounts only after the
 * cached additions are in place, and a route listing them resolves on boot.
 *
 * The hook depends on pi-ai internals (`GITHUB_COPILOT_MODELS` in
 * `dist/providers/github-copilot.models.js`). If a dsh upgrade moves them, the
 * plugin logs a warning and only narrows the route; it always provides the
 * service, because `llm-pi-ai` waits for it.
 *
 * @module dish-copilot/catalog
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { findPackageJSON } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context, Logger } from '@deepseek-ai/cordis'
import type { CredentialKey } from '@deepseek-ai/dsh-credentials'
import type { SettingsNamespace } from '@deepseek-ai/dsh-settings'
import Schema from '@deepseek-ai/schemastery'
import { printOwnLogs, xdgPaths } from 'dish-kit'
import { listLiveModels, type LiveModel } from './copilot-api.ts'

export const name = 'dish-copilot-catalog'

const PI_AI_NS = 'llm-pi-ai' as SettingsNamespace
const PROVIDER_ID = 'github-copilot'
const KEY = `${PI_AI_NS}/${PROVIDER_ID}` as CredentialKey

/** Copilot endpoint → pi-ai protocol, in the order pi-ai's own catalog prefers them. */
const PROTOCOLS: readonly (readonly [endpoint: string, api: string])[] = [
  ['/v1/messages', 'anthropic-messages'],
  ['/responses', 'openai-responses'],
  ['/chat/completions', 'openai-completions'],
]

declare module '@deepseek-ai/cordis' {
  interface Context {
    copilotCatalog: CopilotCatalog
  }
}

export interface CopilotCatalog {
  /** Fetch the live listing, update the catalog and route, and report what changed. */
  refresh(): Promise<CatalogReport>
  /** The latest refresh, from this run or the cache. */
  readonly last: CatalogReport | undefined
}

export interface CatalogReport {
  refreshedAt: number
  /** Ids the account can use, which the route now lists. */
  available: string[]
  /** Of those, the ids patched into pi-ai's catalog. */
  added: string[]
  /** Catalog ids the account cannot use, dropped from the route. */
  unavailable: string[]
  /** Whether the route's model list was rewritten. */
  routeUpdated: boolean
}

/** What a catalog addition is derived from; re-derived at startup against the installed catalog. */
interface Addition {
  id: string
  name: string
  api: string
  sibling: string
  contextWindow?: number
  maxTokens?: number
  vision: boolean
}

export interface Cache {
  version: 1
  report: CatalogReport
  additions: Addition[]
}

/** A pi-ai `Model`, as far as this plugin reads or writes one. */
type CatalogModel = Record<string, unknown> & { id: string, api: string }

export interface Config {
  cacheFile?: string
  legacyCacheFile?: string
  refreshOnStart: boolean
  updateRoute: boolean
  terminal: boolean
}

export const Config: Schema<Config> = Schema.object({
  cacheFile: Schema.string()
    .description('Where the last refresh is cached, so additions survive restarts. Defaults to copilot-models.json in the XDG cache directory for dish.'),
  legacyCacheFile: Schema.string()
    .description('An older cache location, read once when cacheFile does not exist yet. Never written or deleted.'),
  refreshOnStart: Schema.boolean().default(true)
    .description('Refresh from Copilot at startup when signed in.'),
  updateRoute: Schema.boolean().default(true)
    .description(`Set the "${PROVIDER_ID}" route's model list to what the account can use.`),
  terminal: Schema.boolean().default(true)
    .description('Print this plugin\'s messages to the terminal.'),
})

export async function apply(ctx: Context, config: Config) {
  const logger = ctx.logger(name)
  if (config.terminal) printOwnLogs(ctx, name)

  const cacheFile = config.cacheFile || join(xdgPaths('dish').cache, 'copilot-models.json')
  let record: Record<string, CatalogModel> | undefined
  try {
    record = await piAiCopilotCatalog()
  } catch (error) {
    logger.warn('cannot patch pi-ai\'s Copilot catalog, so new models will not be added: %s', error)
  }
  // No cache yet, or unreadable: the first refresh writes one.
  const cache = await readCache(cacheFile, config.legacyCacheFile || undefined)

  // Ids this plugin put into the catalog, so a refresh can take them back out
  // and never mistakes one for a native entry.
  const applied = new Set<string>()
  if (record !== undefined && cache !== undefined) applyAdditions(record, cache.additions, applied)

  let last = cache?.report
  let running: Promise<CatalogReport> | undefined
  const refresh = async (): Promise<CatalogReport> => {
    const credentials = ctx.get('credentials')
    const grant = await credentials?.readRecord(KEY)
    if (grant?.kind !== 'grant') throw new Error('not signed in to GitHub Copilot')
    const live = await listLiveModels(grant.payload)
    const usable = live.filter(isUsable)
    const additions = record === undefined ? [] : deriveAdditions(usable, record, applied)
    if (record !== undefined) applyAdditions(record, additions, applied)

    const known = (id: string) => record === undefined || Object.hasOwn(record, id)
    const available = usable.map(model => model.id).filter(known).sort(byId)
    const report: CatalogReport = {
      refreshedAt: Date.now(),
      available,
      added: additions.map(addition => addition.id).filter(id => available.includes(id)),
      unavailable: record === undefined ? []
        : Object.keys(record).filter(id => !applied.has(id) && !available.includes(id)).sort(byId),
      routeUpdated: config.updateRoute && await updateRoute(ctx, available),
    }
    await writeCache(cacheFile, { version: 1, report, additions })
    last = report
    logger.info('%d models available%s%s%s', available.length,
      report.added.length > 0 ? `; added ${report.added.join(', ')}` : '',
      report.unavailable.length > 0 ? `; not on this account: ${report.unavailable.join(', ')}` : '',
      report.routeUpdated ? '; model picker updated' : '')
    return report
  }

  const catalog: CopilotCatalog = {
    get last() { return last },
    refresh() {
      running ??= refresh().finally(() => { running = undefined })
      return running
    },
  }
  ctx.provide('copilotCatalog', catalog)

  if (config.refreshOnStart) {
    ctx.inject(['credentials', 'settings'], (child) => {
      void (async () => {
        if (await child.credentials.readRecord(KEY) === undefined) return
        await catalog.refresh()
      })().catch((error: unknown) => { logger.warn('refresh failed: %s', error) })
    })
  }
}

/**
 * The object pi-ai's catalog reads for Copilot, from the same module instance
 * `llm-pi-ai` imports: pi-ai is resolved from `llm-pi-ai`'s own location.
 */
async function piAiCopilotCatalog(): Promise<Record<string, CatalogModel>> {
  const manifest = findPackageJSON('@earendil-works/pi-ai', import.meta.resolve('@deepseek-ai/dsh-llm-pi-ai'))
  if (manifest === undefined) throw new Error('@earendil-works/pi-ai is not resolvable from llm-pi-ai')
  const file = join(dirname(realpathSync(manifest)), 'dist/providers/github-copilot.models.js')
  const module = await import(pathToFileURL(file).href) as { GITHUB_COPILOT_MODELS?: unknown }
  const catalog = module.GITHUB_COPILOT_MODELS
  if (catalog === null || typeof catalog !== 'object') throw new Error(`${file} exports no GITHUB_COPILOT_MODELS`)
  return catalog as Record<string, CatalogModel>
}

function protocolOf(model: LiveModel): string | undefined {
  const endpoints = model.supported_endpoints ?? []
  return PROTOCOLS.find(([endpoint]) => endpoints.includes(endpoint))?.[1]
}

/** What Copilot's own model picker would offer, and the harness can drive: chat with tools. */
function isUsable(model: LiveModel): boolean {
  return model.model_picker_enabled === true
    && model.policy?.state !== 'disabled'
    && (model.capabilities?.type ?? 'chat') === 'chat'
    && model.capabilities?.supports?.tool_calls !== false
    && protocolOf(model) !== undefined
}

/** Live models the installed catalog lacks, each paired with its nearest native sibling. */
function deriveAdditions(
  usable: LiveModel[],
  record: Record<string, CatalogModel>,
  applied: ReadonlySet<string>,
): Addition[] {
  const native = Object.values(record).filter(model => !applied.has(model.id))
  const additions: Addition[] = []
  for (const model of usable) {
    if (native.some(entry => entry.id === model.id)) continue
    const api = protocolOf(model)!
    const sibling = nearest(model.id, native.filter(entry => entry.api === api))
    if (sibling === undefined) continue
    const limits = model.capabilities?.limits
    additions.push({
      id: model.id,
      name: model.name ?? model.id,
      api,
      sibling: sibling.id,
      ...limits?.max_context_window_tokens === undefined ? {} : { contextWindow: limits.max_context_window_tokens },
      ...limits?.max_output_tokens === undefined ? {} : { maxTokens: limits.max_output_tokens },
      vision: model.capabilities?.supports?.vision === true,
    })
  }
  return additions
}

/** Most shared leading plus trailing characters: `gpt-6.1-sol` pairs with `gpt-6-sol`. */
function nearest(id: string, candidates: CatalogModel[]): CatalogModel | undefined {
  const shared = (a: string, b: string) => {
    let n = 0
    while (n < a.length && n < b.length && a[n] === b[n]) n++
    return n
  }
  const reverse = (text: string) => [...text].reverse().join('')
  let best: CatalogModel | undefined
  let bestScore = 0
  for (const candidate of candidates) {
    const score = shared(id, candidate.id) + shared(reverse(id), reverse(candidate.id))
    if (score > bestScore) [best, bestScore] = [candidate, score]
  }
  return best
}

/**
 * Make the catalog hold exactly `additions` beyond its native entries. The
 * sibling supplies everything Copilot's listing does not describe — headers,
 * compat switches, reasoning levels — so the addition is served like it.
 */
function applyAdditions(record: Record<string, CatalogModel>, additions: Addition[], applied: Set<string>): void {
  for (const id of applied) {
    if (!additions.some(addition => addition.id === id)) delete record[id]
  }
  for (const id of [...applied]) if (!Object.hasOwn(record, id)) applied.delete(id)
  for (const addition of additions) {
    // Native now (pi-ai caught up), or its sibling is gone: leave it alone.
    if (Object.hasOwn(record, addition.id) && !applied.has(addition.id)) continue
    const sibling = record[addition.sibling]
    if (sibling === undefined || applied.has(addition.sibling) || sibling.api !== addition.api) continue
    record[addition.id] = {
      ...sibling,
      id: addition.id,
      name: addition.name,
      contextWindow: addition.contextWindow ?? sibling.contextWindow,
      maxTokens: addition.maxTokens ?? sibling.maxTokens,
      input: addition.vision ? ['text', 'image'] : ['text'],
    }
    applied.add(addition.id)
  }
}

/**
 * Set the route's models to `available`, keeping any per-model fields the user
 * configured. `modelOverrides` cannot sit beside a models list, so its entries
 * fold into the list. Leaves a missing route missing: adding it is sign-in's call.
 * @returns whether anything was written.
 */
async function updateRoute(ctx: Context, available: string[]): Promise<boolean> {
  const settings = ctx.get('settings')
  const descriptor = settings?.describe().find(entry => entry.ns === PI_AI_NS)
  const providers = (descriptor?.value as { providers?: Record<string, RouteProfile> } | undefined)?.providers
  const route = providers?.[PROVIDER_ID]
  if (settings === undefined || descriptor === undefined || route === undefined) return false

  const configured = new Map((route.models ?? []).map(model => [model.id, model]))
  const overrides = route.modelOverrides ?? {}
  const current = [...configured.keys()]
  if (current.length === available.length && current.every((id, index) => id === available[index])
    && Object.keys(overrides).length === 0) {
    return false
  }
  const models = available.map(id => ({ ...overrides[id], ...configured.get(id), id }))
  await settings.mutate(PI_AI_NS, [
    { op: 'set', path: ['providers', PROVIDER_ID, 'models'], value: models },
    ...Object.keys(overrides).length > 0 ? [{ op: 'unset' as const, path: ['providers', PROVIDER_ID, 'modelOverrides'] }] : [],
  ], descriptor.revision)
  return true
}

interface RouteProfile {
  models?: ({ id: string } & Record<string, unknown>)[]
  modelOverrides?: Record<string, Record<string, unknown>>
}

/**
 * Read the cache `file`. Only when it does not exist, read `legacy` instead,
 * so a cache from an older location is found once; the first refresh then
 * writes `file`, and `legacy` is never consulted again. Never writes or
 * deletes either file.
 * @returns the cache, or `undefined` if there is none, or it is corrupt or of another version.
 */
export async function readCache(file: string, legacy?: string): Promise<Cache | undefined> {
  let text: string
  try {
    text = await readFile(file, 'utf8')
  } catch (error) {
    if (legacy === undefined || (error as NodeJS.ErrnoException).code !== 'ENOENT') return undefined
    return readCache(legacy)
  }
  try {
    const cache = JSON.parse(text) as Partial<Cache> | null
    if (cache?.version !== 1 || typeof cache.report !== 'object' || !Array.isArray(cache.additions)) return undefined
    return cache as Cache
  } catch {
    return undefined
  }
}

/** Write the cache atomically, creating its directory (`~/.cache/dish` may not exist yet). */
export async function writeCache(file: string, cache: Cache): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`
  await mkdir(dirname(file), { recursive: true })
  await writeFile(temporary, `${JSON.stringify(cache, null, 2)}\n`)
  await rename(temporary, file)
}

function byId(a: string, b: string): number {
  return a.localeCompare(b, 'en', { numeric: true })
}
