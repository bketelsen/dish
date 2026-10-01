/**
 * What looks like a credential, in one place: dish-config refuses to store a document that holds one (`secretKind`), and
 * dish-judge masks them out of its decision log (`maskSecrets`). Both start from the same patterns, so what the store
 * would refuse is what the log hides.
 *
 * @module dish-kit/secrets
 */

interface SecretPattern {
  /** What the match looks like, in words: "looks like <label>". */
  label: string
  /** What `secretKind` looks for. It stops at the first match, so how far a match reaches doesn't matter to it. */
  pattern: RegExp
  /**
   * What `maskSecrets` looks for instead, where a match has to reach a different distance than a detection needs. It
   * matches wherever `pattern` does, so a text one finds a secret in is a text the other masks something in.
   */
  mask?: RegExp
}

// No `\b` anchors: `_` is a word character, so `\b` would let `TOKEN_ghp_...` and `_ghp_..._` through. A lookbehind
// for a letter or digit still keeps `risk-...`, `task-...` and `xghp_...` from matching.
const SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    label: 'a GitHub token',
    pattern: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/,
    // The body is as short as it can be and stops before another token's prefix. The greedy body above eats the letters
    // of a token that follows it (`ghp_<A>ghp_<B>`), stops at that token's `_`, and so leaves all of its body unmasked.
    mask: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}?(?=gh[pousr]_|github_pat_|sk-|[^A-Za-z0-9]|$)/,
  },
  {
    // Real fine-grained tokens have 82 characters after the prefix; 50 leaves room without matching `github_pat_token_for_deploy_scripts`.
    label: 'a GitHub fine-grained token',
    pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{50,}/,
    // As the GitHub token's: stops before an `sk-` key that follows it. A `ghp_` after it is inside its characters already.
    mask: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{50,}?(?=sk-|[^A-Za-z0-9_]|$)/,
  },
  { label: 'an sk- API key', pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{32,}/ },
  {
    // Any PEM private key header: RSA, EC, OPENSSH, ENCRYPTED, and PGP's `PRIVATE KEY BLOCK`. The gaps are bounded so
    // that a long near-miss (`-----BEGIN ` and a megabyte of `PRIVATE KEY`) takes a fixed time for each start, not time
    // for every pair of positions in it. No real header has a word that long before `PRIVATE KEY`.
    label: 'a private key',
    pattern: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----/,
    // The key is the header and what follows it: to its END line, or, if there is none within 8 KB (a key that was cut
    // off, or a header that's quoted), for 8 KB. A header and no body would leave the key itself in the text.
    mask: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----(?:[\s\S]{0,8192}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----|[\s\S]{0,8192})/,
  },
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

/** A leading lookbehind: `(?<![A-Za-z0-9])`. */
const LEADING_LOOKBEHIND = /^\(\?<![^)]*\)/

interface Masker {
  label: string
  /** Every match in a text. `matchAll` works on a copy, so this holds no `lastIndex` between calls. */
  scan: RegExp
  /** The match that starts exactly where `lastIndex` is, with no lookbehind: for a secret that sits right at the end of a mask. */
  glued: RegExp
}

const MASKERS: readonly Masker[] = SECRET_PATTERNS.map(({ label, pattern, mask }) => {
  const source = (mask ?? pattern).source
  return { label, scan: new RegExp(source, 'g'), glued: new RegExp(source.replace(LEADING_LOOKBEHIND, ''), 'y') }
})

/** What replaces a secret of kind `label`. It holds nothing of the secret, and no pattern matches it or any part of it. */
function maskFor(label: string): string {
  return `‹secret: ${label}›`
}

interface Range {
  start: number
  end: number
  label: string
}

/** The secret that starts at `index`, whatever comes before it (the longest, if several do), or `undefined`. */
function gluedAt(text: string, index: number): Range | undefined {
  let best: Range | undefined
  for (const { label, glued } of MASKERS) {
    glued.lastIndex = index
    const match = glued.exec(text)
    if (match === null || match[0].length === 0) continue
    const end = index + match[0].length
    if (best === undefined || end > best.end) best = { start: index, end, label }
  }
  return best
}

/** One pass: `text` with every match of every pattern masked, or `text` itself if nothing matches. */
function maskOnce(text: string): string {
  const found: Range[] = []
  for (const { label, scan } of MASKERS) {
    for (const match of text.matchAll(scan)) {
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
  let next = 1
  for (;;) {
    // Overlapping: one mask over all of them, under the label of the one that starts first, so that no tail of any is left.
    while (next < found.length && found[next]!.start < current.end) {
      current = { ...current, end: Math.max(current.end, found[next]!.end) }
      next++
    }
    // A secret glued to the end of this one. Its lookbehind would see the end of the secret before it, a letter or digit, and
    // refuse; but it is there to be seen only until this one is a mask, and a mask ends in `›`. So it is a match, and it is
    // found here, in this pass, which keeps a long run of them a single pass over the text.
    const glued = gluedAt(text, current.end)
    out += text.slice(cursor, current.start) + maskFor(current.label)
    cursor = current.end
    if (glued !== undefined) {
      current = glued
    } else if (next < found.length) {
      current = found[next]!
      next++
    } else {
      break
    }
  }
  return out + text.slice(cursor)
}

/**
 * Passes `maskSecrets` makes at most. Two do it: one that masks, and one that finds nothing more. The rest is a bound
 * on what a text that I haven't thought of could cost.
 */
const MAX_PASSES = 8

/**
 * `text` with everything that looks like a credential replaced by `‹secret: <kind>›`, where `<kind>` is what
 * `secretKind` says ("a GitHub token"). The mask holds nothing of the secret.
 *
 * - **Patterns.** Those of `secretKind`, with two differences that are about how far a match reaches: a private key is
 *   masked from its header to its END line (or for 8 KB, if it has none), and a token's body stops before the prefix of
 *   another token that is glued to it. A lookbehind or lookahead is judged against the text as it was given.
 * - **Overlapping matches** (an `sk-` key's characters run over the token that follows it) become one mask over all of
 *   them, under the kind of the one that starts first.
 * - **Glued secrets** (`ghp_…ghp_…`, with nothing between): the second follows a letter, so on its own it isn't a match,
 *   but it is the moment the first is a mask. Each is masked, as two masks.
 * - **Masking is idempotent and complete.** The result is a fixed point: `secretKind` finds nothing in it and masking it
 *   changes nothing. A text that is not one after `MAX_PASSES` passes is replaced by one mask for what it still holds.
 * - **Text with no secret** comes back unchanged.
 */
export function maskSecrets(text: string): string {
  let current = text
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const masked = maskOnce(current)
    if (masked === current) return current
    current = masked
  }
  const kind = secretKind(current)
  return kind === undefined ? current : maskFor(kind)
}
