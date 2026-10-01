/**
 * What looks like a credential, in one place: dish-config refuses to store a document that holds one (`secretKind`), and
 * dish-judge masks them out of its decision log (`maskSecrets`). Both start from the same patterns, so what the store
 * would refuse is what the log hides.
 *
 * @module dish-kit/secrets
 */

/**
 * Not right after a letter or digit, unless that one comes right after a backslash. A token in a string that holds an
 * escape (`"x\nghp_…"`, `printf 'x\tsk-…'`) follows a letter, the `n` or `t` of the escape, and is a token all the same.
 * The backslash is what tells the two apart: `xghp_…` and `\ncghp_…` still follow a letter, and a plain one blocks a match.
 * A known limit: `\uXXXX` and `\xXX` escapes are not treated as escapes. A hex digit before a token still blocks it, and
 * detection has the same gap.
 */
const NOT_AFTER_ALNUM = /(?<!(?<!\\)[A-Za-z0-9])/
/** The same for capitals and digits only, which is what an AWS key's neighbour is judged by. */
const NOT_AFTER_UPPER = /(?<!(?<!\\)[A-Z0-9])/

interface SecretPattern {
  /** What the match looks like, in words: "looks like <label>". */
  label: string
  /** What must not be right before a match. It is an assertion, so it takes no characters of the text. */
  before?: RegExp
  /** What a match is, after `before`. What `secretKind` looks for. It stops at the first match, so how far a match reaches doesn't matter to it. */
  body: RegExp
  /**
   * What `maskSecrets` looks for in place of `body`, where a match has to reach a different distance than a detection
   * needs. It matches wherever `body` does, so a text one finds a secret in is a text the other masks something in.
   */
  mask?: RegExp
}

/**
 * The start of a TypeSafe API key that is long enough to be one: `apikey_` and 32 hex digits. It is the point at which a run
 * of something else (a private key's base64, another key's hex) has to stop, so that the key is at the end of the mask and
 * is masked in its turn.
 */
const APIKEY_START = String.raw`apikey_[0-9a-fA-F]{32}`
/**
 * One hex digit of a TypeSafe API key as `maskSecrets` takes it: not one that starts another key. Hex digits include the
 * `a` of the next key's `apikey_` and the `A` of an AKIA or ASIA key, so a plain run of them would eat the first letter of
 * what follows and leave the rest of it a prefix short, which is no key to look for.
 */
const APIKEY_HEX = String.raw`(?:(?!${APIKEY_START}|(?:AKIA|ASIA)[0-9A-Z]{16})[0-9a-fA-F])`

// No `\b` anchors: `_` is a word character, so `\b` would let `TOKEN_ghp_...` and `_ghp_..._` through. A lookbehind
// for a letter or digit still keeps `risk-...`, `task-...` and `xghp_...` from matching.
const PATTERNS: readonly SecretPattern[] = [
  {
    label: 'a GitHub token',
    before: NOT_AFTER_ALNUM,
    body: /gh[pousr]_[A-Za-z0-9]{36,}/,
    // The body is as short as it can be and stops before another token's prefix. The greedy body above eats the letters
    // of a token that follows it (`ghp_<A>ghp_<B>`), stops at that token's `_`, and so leaves all of its body unmasked.
    mask: /gh[pousr]_[A-Za-z0-9]{36,}?(?=gh[pousr]_|github_pat_|sk-|apikey_|[^A-Za-z0-9]|$)/,
  },
  {
    // Real fine-grained tokens have 82 characters after the prefix; 50 leaves room without matching `github_pat_token_for_deploy_scripts`.
    label: 'a GitHub fine-grained token',
    before: NOT_AFTER_ALNUM,
    body: /github_pat_[A-Za-z0-9_]{50,}/,
    // As the GitHub token's: stops before an `sk-` key that follows it. A `ghp_` after it is inside its characters already.
    mask: /github_pat_[A-Za-z0-9_]{50,}?(?=sk-|[^A-Za-z0-9_]|$)/,
  },
  { label: 'an sk- API key', before: NOT_AFTER_ALNUM, body: /sk-[A-Za-z0-9_-]{32,}/ },
  {
    // `apikey_`, 35 hex digits, `_`, and 64 hex digits, which is what a TypeSafe API key is. Detected from 32 digits of the
    // first part, whatever follows:
    // - 32 is the floor of a first part that is 35 (a little under it, for a key of another length; capitals for another
    //   case). It is 128 bits, so no word or name has that many hex digits after `apikey_`: `apikey_placeholder` and
    //   `apikey_environment_variable_name` are not hex at all, and 31 digits and an underscore is not a key;
    // - the second part, which may be 64 digits or any number a cut leaves, is not asked for. A key that is cut after its
    //   first part (a log line, a command that was cut, a truncated result) is half of a credential, and is masked with
    //   what it has of the rest. A false detection here is a name or a hash that has 32 hex digits after `apikey_`, and a
    //   refusal of that is the safe way to be wrong.
    //
    // The mask takes the first part, and an underscore and the second as far as it is hex. It has no `-` or other letter in it, so
    // it stops at the first character of whatever token follows it (`ghp_`, `sk-`, `github_pat_`, `-----BEGIN`), which is
    // masked in its turn. Only AKIA and ASIA and another `apikey_` start with a hex digit, and it stops before those, by their
    // whole shape (`APIKEY_HEX`). It is not stopped by a token of a kind whose characters include a key's: an `sk-` or a
    // fine-grained token that comes before one takes the whole of it, in one mask.
    label: 'a TypeSafe API key',
    before: NOT_AFTER_ALNUM,
    body: /apikey_[0-9a-fA-F]{32,}/,
    mask: new RegExp(String.raw`apikey_${APIKEY_HEX}{32,}(?:_${APIKEY_HEX}*)?`),
  },
  {
    // Any PEM private key header: RSA, EC, OPENSSH, ENCRYPTED, and PGP's `PRIVATE KEY BLOCK`. The gaps are bounded so
    // that a long near-miss (`-----BEGIN ` and a megabyte of `PRIVATE KEY`) takes a fixed time for each start, not time
    // for every pair of positions in it. No real header has a word that long before `PRIVATE KEY`.
    label: 'a private key',
    body: /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----/,
    // The key is the header and what follows it, up to 8 KB:
    // - to its END line, if there is one before another private key header (whatever is between: PGP armor has `Version:`
    //   and `Comment:` lines with dots and brackets in them, and a fake `-----BEGIN x.` line does not end it). The gap stops
    //   at the next real header, which is a match of its own and is merged with this one, so that a text with many headers and
    //   no END lines is scanned once, not once for each header, which would be 8 KB for every 28 characters;
    // - or, with no END line, the characters a key can be made of: base64, the `Proc-Type: 4,ENCRYPTED` and `DEK-Info:`
    //   lines of an old key, the dots, brackets, `@` and `<>` of a PGP `Version:` or `Comment:` line, spaces and line
    //   breaks, and the backslash of a `\n` that is written out. The first other character ends it, so that
    //   `grep "-----BEGIN RSA PRIVATE KEY-----" ~/.ssh/id_rsa | wc -l` keeps all but the header. It stops before a token
    //   (a prefix with the body to go with it), so that the token is at the end of the mask and is masked in its turn: the
    //   letters of `ghp`, `github`, `sk-` and `apikey` are among the characters, and it would otherwise run into the token and
    //   stop at its `_`, leaving the rest of the token. A prefix with no token behind it (`risk-free`) is not a place to stop.
    mask: new RegExp(String.raw`-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----(?:(?:(?!-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY)[\s\S]){0,8192}?-----END [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----|(?:(?!gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50}|sk-[A-Za-z0-9_-]{32}|${APIKEY_START})[A-Za-z0-9+\/=:,\s\\.()@<>-]){0,8192})`),
  },
  // AKIA is a long-term access key, ASIA a temporary one.
  { label: 'an AWS access key ID', before: NOT_AFTER_UPPER, body: /(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/ },
]

const SECRET_PATTERNS: ReadonlyArray<{ label: string, pattern: RegExp }> = PATTERNS.map(({ label, before, body }) => ({
  label,
  pattern: new RegExp((before?.source ?? '') + body.source),
}))

/**
 * What kind of credential `text` looks like, in words ("a GitHub token"), or
 * `undefined` if nothing in it does. Never returns any of the text itself.
 */
export function secretKind(text: string): string | undefined {
  return SECRET_PATTERNS.find(({ pattern }) => pattern.test(text))?.label
}

interface Masker {
  label: string
  /** Every match in a text. `matchAll` works on a copy, so this holds no `lastIndex` between calls. */
  scan: RegExp
  /** The match that starts exactly where `lastIndex` is, with nothing required before it: for a secret that sits right at the end of a mask. */
  glued: RegExp
}

const MASKERS: readonly Masker[] = PATTERNS.map(({ label, before, body, mask }) => {
  const match = mask ?? body
  return { label, scan: new RegExp((before?.source ?? '') + match.source, 'g'), glued: new RegExp(match.source, 'y') }
})

/**
 * The source of each pattern `maskSecrets` looks for a secret at the end of a mask with. None starts with a lookbehind: it
 * is built from the pattern's own parts, with no `before`, and not by cutting a lookbehind off the front of one's source.
 * Exported for the test that says so.
 * @internal
 */
export const GLUED_SOURCES: readonly string[] = MASKERS.map(({ glued }) => glued.source)

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
 *   changes nothing. A text that is not one (after `MAX_PASSES` passes, or because a pattern finds in it what its mask
 *   doesn't) is replaced by one mask for what it still holds.
 * - **Text with no secret** comes back unchanged.
 */
export function maskSecrets(text: string): string {
  let current = text
  for (let pass = 0; pass < MAX_PASSES; pass++) {
    const masked = maskOnce(current)
    if (masked === current) break
    current = masked
  }
  // What is left should have nothing in it that a pattern finds. If it has, a pattern finds what its mask doesn't, in a text
  // I haven't thought of (two keys, the first cut so that its last digit is the second's first letter): better one mask than
  // a secret in a log.
  const kind = secretKind(current)
  return kind === undefined ? current : maskFor(kind)
}
