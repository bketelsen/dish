/**
 * The one Copilot endpoint `llm-pi-ai` does not expose: the live model listing,
 * with the metadata (protocols, limits, vision) a catalog entry is built from.
 *
 * Authenticates from pi-ai's stored grant. The grant is opaque by the
 * credentials contract, so this reads only the two fields pi-ai's Copilot
 * login has always written — `refresh` (the GitHub token) and `enterpriseUrl`
 * — and never writes the record back.
 *
 * @module dish-copilot/copilot-api
 */

/** The client identity pi-ai presents to Copilot; its requests and ours should look alike. */
const COPILOT_HEADERS = {
  'User-Agent': 'GitHubCopilotChat/0.35.0',
  'Editor-Version': 'vscode/1.107.0',
  'Editor-Plugin-Version': 'copilot-chat/0.35.0',
  'Copilot-Integration-Id': 'vscode-chat',
}
const COPILOT_API_VERSION = '2026-06-01'
const REQUEST_TIMEOUT_MS = 15_000

/** One entry of Copilot's `GET /models`, narrowed to the fields used here. */
export interface LiveModel {
  id: string
  name?: string
  vendor?: string
  model_picker_enabled?: boolean
  policy?: { state?: string }
  supported_endpoints?: string[]
  capabilities?: {
    type?: string
    limits?: { max_context_window_tokens?: number, max_output_tokens?: number }
    supports?: { tool_calls?: boolean, vision?: boolean }
  }
}

interface CopilotGrant {
  refresh: string
  enterpriseUrl?: string
}

function grantFrom(payload: unknown): CopilotGrant {
  const grant = payload as Partial<CopilotGrant> | null
  if (typeof grant?.refresh !== 'string' || grant.refresh.length === 0) {
    throw new Error('the stored Copilot sign-in has no GitHub token; sign in again')
  }
  return grant as CopilotGrant
}

function githubDomain(grant: CopilotGrant): string {
  if (!grant.enterpriseUrl) return 'github.com'
  const url = grant.enterpriseUrl.includes('://') ? grant.enterpriseUrl : `https://${grant.enterpriseUrl}`
  return new URL(url).hostname
}

async function getJson(url: string, headers: Record<string, string>, signal?: AbortSignal): Promise<unknown> {
  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  const response = await fetch(url, {
    headers: { Accept: 'application/json', ...COPILOT_HEADERS, ...headers },
    signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
  })
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`)
  return response.json()
}

/**
 * List every model the signed-in account's Copilot endpoint serves.
 * @param payload - the `llm-pi-ai/github-copilot` grant payload.
 * @param signal - aborts the requests.
 */
export async function listLiveModels(payload: unknown, signal?: AbortSignal): Promise<LiveModel[]> {
  const grant = grantFrom(payload)
  const domain = githubDomain(grant)
  const exchange = await getJson(`https://api.${domain}/copilot_internal/v2/token`,
    { Authorization: `Bearer ${grant.refresh}` }, signal) as { token?: unknown }
  if (typeof exchange.token !== 'string') throw new Error('Copilot token exchange returned no token')
  // The token names its own proxy (individual, business, or enterprise).
  const proxy = /proxy-ep=([^;]+)/.exec(exchange.token)?.[1]
  const baseUrl = proxy !== undefined ? `https://${proxy.replace(/^proxy\./, 'api.')}`
    : grant.enterpriseUrl ? `https://copilot-api.${domain}` : 'https://api.individual.githubcopilot.com'
  const listing = await getJson(`${baseUrl}/models`,
    { 'Authorization': `Bearer ${exchange.token}`, 'X-GitHub-Api-Version': COPILOT_API_VERSION }, signal) as { data?: unknown }
  if (!Array.isArray(listing.data)) throw new Error('Copilot /models returned no data array')
  return (listing.data as LiveModel[]).filter(model => typeof model?.id === 'string')
}
