/**
 * What looks like a credential, in one place: dish-config refuses to store a document that holds one (`secretKind`), and
 * dish-judge masks them out of its decision log (`maskSecrets`). Both use the same patterns, so what the store would
 * refuse is what the log hides.
 *
 * @module dish-kit/secrets
 */

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

/**
 * The same patterns with the global flag, for finding every match. `matchAll` works on a copy of the regular
 * expression, so these hold no `lastIndex` between calls.
 */
const GLOBAL_PATTERNS: ReadonlyArray<{ label: string, pattern: RegExp }> = SECRET_PATTERNS.map(({ label, pattern }) => ({
  label,
  pattern: new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`),
}))

/** What replaces a secret of kind `label`. It holds nothing of the secret, and no pattern matches it or any part of it. */
function maskFor(label: string): string {
  return `‹secret: ${label}›`
}

/** One pass: `text` with every match of every pattern masked, or `text` itself if nothing matches. */
function maskOnce(text: string): string {
  const found: Array<{ start: number, end: number, label: string }> = []
  for (const { label, pattern } of GLOBAL_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      // Not possible with these patterns (each needs a literal prefix), but a pattern that could match nothing must not loop or mask nothing.
      if (match[0].length === 0) continue
      found.push({ start: match.index, end: match.index + match[0].length, label })
    }
  }
  if (found.length === 0) return text
  // The earliest start first, and the longest of those: a match that sits inside another changes nothing.
  found.sort((a, b) => a.start - b.start || b.end - a.end)
  let out = ''
  let cursor = 0
  let current = found[0]!
  const flush = (): void => {
    out += text.slice(cursor, current.start) + maskFor(current.label)
    cursor = current.end
  }
  for (const next of found.slice(1)) {
    if (next.start < current.end) {
      // Overlapping: one mask over both, under the label of the one that starts first, so that no tail of either is left.
      current = { ...current, end: Math.max(current.end, next.end) }
    } else {
      flush()
      current = next
    }
  }
  flush()
  return out + text.slice(cursor)
}

/**
 * `text` with everything that looks like a credential replaced by `‹secret: <kind>›`, where `<kind>` is what
 * `secretKind` says ("a GitHub token"). The mask holds nothing of the secret.
 *
 * - **Patterns.** The same as `secretKind`'s. A lookbehind or lookahead in them is judged against the text as it was
 *   given, so a match is a match here exactly when it is one to `secretKind`.
 * - **Overlapping matches** (an `sk-` key's characters run over the token that follows it) become one mask over all of
 *   them, under the kind of the one that starts first.
 * - **Masking is idempotent and complete.** A secret that was glued to a neighbour (`AKIA…ghp_…`: the token follows a
 *   letter, so it is not a match) can become one once the neighbour is a mask, so the text is masked again until nothing
 *   matches. The result is a fixed point: `secretKind` finds nothing in it, and masking it changes nothing. This ends
 *   because no pattern can match across a mask (`‹` and `›` are in no pattern's characters), so every pass takes at least
 *   one match's worth of the original text and there are at most `text.length` of them.
 * - **Text with no secret** comes back unchanged.
 */
export function maskSecrets(text: string): string {
  let current = text
  for (let pass = 0; pass <= text.length; pass++) {
    const masked = maskOnce(current)
    if (masked === current) return current
    current = masked
  }
  return current
}
