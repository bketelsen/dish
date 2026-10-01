import { ConfigStoreError } from './errors.ts'

interface SecretPattern {
  /** What the match looks like, in words: "looks like <label>". */
  label: string
  pattern: RegExp
}

// No `\b` anchors: `_` is a word character, so `\b` would let `TOKEN_ghp_...` and `_ghp_..._` through. A lookbehind
// for a letter or digit still keeps `risk-...`, `task-...` and `xghp_...` from matching.
const SECRET_PATTERNS: readonly SecretPattern[] = [
  { label: 'a GitHub token', pattern: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/ },
  // Real fine-grained tokens have 82 characters after the prefix; 50 leaves room without matching `github_pat_token_for_deploy_scripts`.
  { label: 'a GitHub fine-grained token', pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{50,}/ },
  { label: 'an sk- API key', pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{32,}/ },
  // Any PEM private key header: RSA, EC, OPENSSH, ENCRYPTED, and PGP's `PRIVATE KEY BLOCK`.
  { label: 'a private key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY[A-Z ]*-----/ },
  // AKIA is a long-term access key, ASIA a temporary one.
  { label: 'an AWS access key ID', pattern: /(?<![A-Z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/ },
]

/**
 * What kind of credential `text` looks like, in words ("a GitHub token"), or
 * `undefined` if nothing in it does. Never returns any of the text itself.
 */
export function secretKind(text: string): string | undefined {
  return SECRET_PATTERNS.find(({ pattern }) => pattern.test(text))?.label
}

/** `path` as it's safe to put in a one-line message: a path with control characters can't forge log lines. */
function shown(path: string): string {
  return /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path
}

/**
 * Refuse a document that is too big or looks like it holds a credential.
 * Everything in the store is pushed to GitHub, path included (it goes into
 * the tree and the commit subject), so both the path and the text are scanned,
 * and this runs before anything is written.
 *
 * The messages name the kind of secret and, when the path is clean, the path,
 * and nothing else: they end up in logs, tool results and agent transcripts, so
 * they never carry the matched text or anything around it. A path that holds a
 * secret is not shown at all.
 *
 * Checks run in this order: the path (`SECRET`), the size (`TOO_LARGE`, so the
 * scan never reads an oversized document), then the text (`SECRET`).
 * @param maxBytes - the most `text` may take as UTF-8.
 * @throws a plain `Error` if `maxBytes` is not a number that is zero or more.
 */
export function checkContent(path: string, text: string, maxBytes: number): void {
  // `!(x >= 0)` rather than `x < 0`: NaN must not turn the size cap off.
  if (!(maxBytes >= 0)) throw new Error(`maxBytes must be zero or more, got ${String(maxBytes)}`)
  const inPath = secretKind(path)
  if (inPath !== undefined) throw new ConfigStoreError('SECRET', `the document path looks like ${inPath}`)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxBytes) {
    throw new ConfigStoreError('TOO_LARGE', `${shown(path)}: ${bytes} bytes is over the ${maxBytes}-byte limit`)
  }
  const inText = secretKind(text)
  if (inText !== undefined) throw new ConfigStoreError('SECRET', `${shown(path)}: looks like ${inText}`)
}
