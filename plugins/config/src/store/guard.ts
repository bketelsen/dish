import { ConfigStoreError } from './errors.ts'

interface SecretPattern {
  /** What the match looks like, in words: "looks like <label>". */
  label: string
  pattern: RegExp
}

const SECRET_PATTERNS: readonly SecretPattern[] = [
  { label: 'a GitHub token', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { label: 'a GitHub fine-grained token', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}/ },
  { label: 'an sk- API key', pattern: /\bsk-[A-Za-z0-9_-]{32,}/ },
  { label: 'a private key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { label: 'an AWS access key ID', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
]

/** `path` as it's safe to put in a one-line message: a path with control characters can't forge log lines. */
function shown(path: string): string {
  return /[\x00-\x1f\x7f]/.test(path) ? JSON.stringify(path) : path
}

/**
 * Refuse a document that is too big or looks like it holds a credential.
 * Everything in the store is pushed to GitHub, so this runs before anything is
 * written.
 *
 * The messages name the path and the kind of secret and nothing else: they end
 * up in logs, tool results and agent transcripts, so they never carry the
 * matched text or anything around it.
 * @param maxBytes - the most `text` may take as UTF-8.
 * @throws `TOO_LARGE` over `maxBytes`, checked first so the scan never reads an oversized document;
 *   `SECRET` if a pattern matches.
 * @throws a plain `Error` if `maxBytes` is not a number that is zero or more.
 */
export function checkContent(path: string, text: string, maxBytes: number): void {
  // `!(x >= 0)` rather than `x < 0`: NaN must not turn the size cap off.
  if (!(maxBytes >= 0)) throw new Error(`maxBytes must be zero or more, got ${String(maxBytes)}`)
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > maxBytes) {
    throw new ConfigStoreError('TOO_LARGE', `${shown(path)}: ${bytes} bytes is over the ${maxBytes}-byte limit`)
  }
  for (const { label, pattern } of SECRET_PATTERNS) {
    if (pattern.test(text)) throw new ConfigStoreError('SECRET', `${shown(path)}: looks like ${label}`)
  }
}
