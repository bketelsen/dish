/**
 * What looks like a credential, in one place: dish-config refuses to store a document that holds one (`secretKind`), and
 * dish-judge masks them out of its decision log (`maskSecrets`). Both start from the same patterns, so what the store
 * would refuse is what the log hides. dish-judge's result screen also cuts a private key out of what it sends the judge
 * (`privateKeyCuts`), from the same header and END patterns, without what is written around it.
 *
 * A known limit, which the guard and the mask share: a token that follows a letter or digit is not a match (that is what keeps
 * `risk-…` and `xghp_…` from matching), so a fragment that is too short to be a token on its own (`ghp_` and 29 letters),
 * glued to the front of one (a TypeSafe key), leaves that one undetected and unmasked: it follows a letter. With 30 or more,
 * the first one's length is made up by the letters of the second's prefix, and both are found.
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
  /**
   * What a match is, after `before`. What `secretKind` looks for. It stops at the first match, so how far a match reaches
   * doesn't matter to it.
   *
   * No body has a loop with no bound: V8 keeps a backtrack entry for each character one takes, and throws "Maximum call
   * stack size exceeded" on a run of about 8 MB. A body is at most `BODY_MAX` characters here, and a run that is longer is
   * dealt with by `more`. No real token is anywhere near it: a GitHub token has 36 to 255 characters after its prefix, a
   * fine-grained one 82, a TypeSafe key 35 and 64.
   */
  body: RegExp
  /**
   * What `maskSecrets` looks for in place of `body`, where a match has to reach a different distance than a detection
   * needs. It matches wherever `body` does, so a text one finds a secret in is a text the other masks something in.
   */
  mask?: RegExp
  /**
   * Where a match really ends: the index after the run of the match's characters that it stopped in the middle of because
   * its body is at most `BODY_MAX` long. `end` is where the match ended and `matched` is the match. Not there for a match
   * that has no body to run on (a private key, which has its own bound, and an AWS key, whose length is fixed).
   */
  more?: (text: string, end: number, matched: string) => number
}

/** The most characters a token's body may have for a pattern to take them. */
const BODY_MAX = 1024

/** A table of the ASCII characters that `one`, a regular expression of one character, takes. A token's body is ASCII. */
function table(one: RegExp): Uint8Array {
  const taken = new Uint8Array(128)
  for (let code = 0; code < 128; code++) taken[code] = one.test(String.fromCharCode(code)) ? 1 : 0
  return taken
}

/** The index after the run of characters in `taken` that starts at `from`. A loop on character codes: no regular expression and no stack. */
function runOf(taken: Uint8Array, text: string, from: number): number {
  let index = from
  while (index < text.length) {
    const code = text.charCodeAt(index)
    if (code >= 128 || taken[code] === 0) break
    index++
  }
  return index
}

const ALNUM = table(/[A-Za-z0-9]/)
const ALNUM_UNDERSCORE = table(/[A-Za-z0-9_]/)
const ALNUM_UNDERSCORE_DASH = table(/[A-Za-z0-9_-]/)
const HEX = table(/[0-9a-fA-F]/)

/**
 * The start of a TypeSafe API key that is long enough to be one: `apikey_` and 32 hex digits. It is the point at which a run
 * of something else (a private key's base64, another key's hex) has to stop, so that the key is at the end of the mask and
 * is masked in its turn.
 */
const APIKEY_START = String.raw`apikey_[0-9a-fA-F]{32}`

/** What `secretKind` and `maskSecrets` call a private key. */
export const PRIVATE_KEY_KIND = 'a private key'

/**
 * The start of a PEM private key header: RSA, EC, OPENSSH, ENCRYPTED, and PGP's `PRIVATE KEY BLOCK`. The gaps are bounded so
 * that a long near-miss (`-----BEGIN ` and a megabyte of `PRIVATE KEY`) takes a fixed time for each start, not time for every
 * pair of positions in it. No real header has a word that long before `PRIVATE KEY`.
 */
const KEY_START = String.raw`-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY`
/** A whole private key header. */
const KEY_HEADER = String.raw`${KEY_START}[A-Z ]{0,20}-----`
/** A private key's END line. */
const KEY_END = String.raw`-----END [A-Z0-9 ]{0,40}PRIVATE KEY[A-Z ]{0,20}-----`

// No `\b` anchors: `_` is a word character, so `\b` would let `TOKEN_ghp_...` and `_ghp_..._` through. A lookbehind
// for a letter or digit still keeps `risk-...`, `task-...` and `xghp_...` from matching.
const PATTERNS: readonly SecretPattern[] = [
  {
    // The body takes the letters of a token that follows it (`ghp_<A>ghp_<B>` has `ghp` in `<A>`'s run, and its match ends
    // at the second token's `_`). `maskOnce` looks for a token in the last few characters of a match for that.
    label: 'a GitHub token',
    before: NOT_AFTER_ALNUM,
    body: /gh[pousr]_[A-Za-z0-9]{36,1024}/,
    more: (text, end) => runOf(ALNUM, text, end),
  },
  {
    // Real fine-grained tokens have 82 characters after the prefix; 50 leaves room without matching `github_pat_token_for_deploy_scripts`.
    // Its characters include `_` and a TypeSafe key's, but not `-`: what follows it that is a token with a `-` in it
    // (`sk-`) is cut short of the `-`, by its first letters.
    label: 'a GitHub fine-grained token',
    before: NOT_AFTER_ALNUM,
    body: /github_pat_[A-Za-z0-9_]{50,1024}/,
    more: (text, end) => runOf(ALNUM_UNDERSCORE, text, end),
  },
  {
    // Its characters include those of every token but a private key's header, so what follows it, up to a space or a quote, is in it.
    label: 'an sk- API key',
    before: NOT_AFTER_ALNUM,
    body: /sk-[A-Za-z0-9_-]{32,1024}/,
    more: (text, end) => runOf(ALNUM_UNDERSCORE_DASH, text, end),
  },
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
    // it stops at the first character of whatever token follows it (`ghp_`, `sk-`, `github_pat_`, `-----BEGIN`). Another
    // `apikey_` and an AKIA or ASIA key start with a hex digit, which it takes: `maskOnce` looks for a token in the last few
    // characters of a match, as it does for the GitHub token. An `sk-` or a fine-grained token that comes before a key takes the
    // whole of it, in one mask.
    label: 'a TypeSafe API key',
    before: NOT_AFTER_ALNUM,
    body: /apikey_[0-9a-fA-F]{32,1024}/,
    mask: /apikey_[0-9a-fA-F]{32,1024}(?:_[0-9a-fA-F]{0,1024})?/,
    more: (text, end, matched) => {
      // Hex that goes on after the match is a part that hit the bound. If it was the first (the match has no `_` after the
      // prefix yet), the second follows it.
      const run = runOf(HEX, text, end)
      if (run === end) return end
      return !matched.includes('_', 7) && text[run] === '_' ? runOf(HEX, text, run + 1) : run
    },
  },
  {
    // Any PEM private key header (see `KEY_START`).
    label: PRIVATE_KEY_KIND,
    body: new RegExp(KEY_HEADER),
    // The key is the header and what follows it, up to 8 KB:
    // - to its END line, if there is one before another private key header (whatever is between: PGP armor has `Version:`
    //   and `Comment:` lines with dots and brackets in them, and a fake `-----BEGIN x.` line does not end it). The gap stops
    //   at the next real header, which is a match of its own and is merged with this one, so that a text with many headers and
    //   no END lines is scanned once, not once for each header, which would be 8 KB for every 28 characters;
    // - or, with no END line, the characters a key can be made of: base64, the `Proc-Type: 4,ENCRYPTED` and `DEK-Info:`
    //   lines of an old key, the dots, brackets, `@` and `<>` of a PGP `Version:` or `Comment:` line, spaces and line
    //   breaks, and the backslash of a `\n` that is written out. The first other character ends it, so that
    //   `grep "-----BEGIN RSA PRIVATE KEY-----" ~/.ssh/id_rsa | wc -l` keeps all but the header. It stops before another
    //   private key header, which is a key of its own and is masked on its own (the dashes, capitals and space of a header
    //   are among the characters: a run that took the header in would end 8 KB from the first one, and the key after it
    //   would be masked only as far as that, its end in the clear). And it stops before a token (a prefix with the body to
    //   go with it), so that the token is at the end of the mask and is masked in its turn: the letters of `ghp`, `github`,
    //   `sk-` and `apikey` are among the characters, and it would otherwise run into the token and stop at its `_`, leaving
    //   the rest of the token. A prefix with no token behind it (`risk-free`) is not a place to stop.
    mask: new RegExp(String.raw`${KEY_HEADER}(?:(?:(?!${KEY_START})[\s\S]){0,8192}?${KEY_END}|(?:(?!${KEY_START}|gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{50}|sk-[A-Za-z0-9_-]{32}|${APIKEY_START})[A-Za-z0-9+\/=:,\s\\.()@<>-]){0,8192})`),
  },
  // AKIA is a long-term access key, ASIA a temporary one.
  { label: 'an AWS access key ID', before: NOT_AFTER_UPPER, body: /(?:AKIA|ASIA)[0-9A-Z]{16}(?![0-9A-Z])/ },
]

const SECRET_PATTERNS: ReadonlyArray<{ label: string, pattern: RegExp }> = PATTERNS.map(({ label, before, body }) => ({
  label,
  pattern: new RegExp((before?.source ?? '') + body.source),
}))

/** The kind that `secretKind` gives a text that couldn't be scanned, which is refused or masked as if it held a secret. */
const UNREADABLE = 'an unreadable secret scan'

/**
 * What kind of credential `text` looks like, in words ("a GitHub token"), or
 * `undefined` if nothing in it does. Never returns any of the text itself.
 */
export function secretKind(text: string): string | undefined {
  try {
    return SECRET_PATTERNS.find(({ pattern }) => pattern.test(text))?.label
  } catch {
    // The scan itself failed (no pattern of these should throw, but V8 does on a text that is long enough for one that
    // loops). A text that couldn't be read is not one that has nothing in it: the guard that asks refuses it.
    return UNREADABLE
  }
}

interface Masker {
  label: string
  /** Every match in a text. `matchAll` works on a copy, so this holds no `lastIndex` between calls. */
  scan: RegExp
  /** The match that starts exactly where `lastIndex` is, with nothing required before it: for a secret that sits right at the end of a mask. */
  glued: RegExp
  more: (text: string, end: number, matched: string) => number
}

const MASKERS: readonly Masker[] = PATTERNS.map(({ label, before, body, mask, more }) => {
  const match = mask ?? body
  return {
    label,
    scan: new RegExp((before?.source ?? '') + match.source, 'g'),
    glued: new RegExp(match.source, 'y'),
    more: more ?? ((_text, end) => end),
  }
})

/**
 * The source of each pattern `maskSecrets` looks for a secret with where a lookbehind would refuse it: at the end of a mask,
 * and in the last few characters of a match, where a token starts that the match's body took the first letters of. None
 * starts with a lookbehind: each is built from the pattern's own parts, with no `before`, and not by cutting a lookbehind
 * off the front of one's source. Exported for the test that says so.
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
  for (const { label, glued, more } of MASKERS) {
    glued.lastIndex = index
    const match = glued.exec(text)
    if (match === null || match[0].length === 0) continue
    const end = more(text, index + match[0].length, match[0])
    if (best === undefined || end > best.end) best = { start: index, end, label }
  }
  return best
}

/**
 * How many characters back from the end of a match `maskOnce` looks for a token that starts inside it. A body takes the
 * letters of the prefix of a token that follows it, up to the `_` or `-` that its characters don't include: `github` and
 * `apikey` are six, the most; `ghp`, `sk`, and the `a` of `apikey_` or `A` of AKIA that a hex run takes are fewer.
 */
const GLUE_BACK = 6

/** One pass: `text` with every match of every pattern masked, or `text` itself if nothing matches. */
function maskOnce(text: string): string {
  const found: Range[] = []
  for (const { label, scan, more } of MASKERS) {
    scan.lastIndex = 0
    for (let match = scan.exec(text); match !== null; match = scan.exec(text)) {
      const matched = match.index + match[0].length
      // Not possible with these patterns (each needs a literal prefix), but a pattern that could match nothing must not loop or mask nothing.
      if (match[0].length === 0) {
        scan.lastIndex = matched + 1
        continue
      }
      const end = more(text, matched, match[0])
      found.push({ start: match.index, end, label })
      // On from where the run that this was the start of ends, and not through it: a run of 5 MB has a match at each
      // 11 characters of it, each of which would run on to the end of it. A token that starts in the last few characters of the
      // run is found there, so that it can be told from one that is inside.
      scan.lastIndex = Math.max(matched, end - GLUE_BACK)
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
    // Overlapping: one mask over all of them, under the label of the one that starts first, so that no tail of any is left. Not
    // a match that starts in the last few characters of this one and runs past it: that is a token that this one's body took
    // the first letters of, and it is a mask of its own, below.
    while (next < found.length && found[next]!.start < current.end && (found[next]!.end <= current.end || found[next]!.start < current.end - GLUE_BACK)) {
      current = { ...current, end: Math.max(current.end, found[next]!.end) }
      next++
    }
    // A secret glued to the end of this one. Its lookbehind would see the end of the secret before it, a letter or digit, and
    // refuse; but it is there to be seen only until this one is a mask, and a mask ends in `›`. So it is a match, and it is
    // found here, in this pass, which keeps a long run of them a single pass over the text.
    let glued = gluedAt(text, current.end)
    // Or one that starts inside it: a body that takes the first letters of the token after it (`ghp_<33>ghp_<36>` is a token
    // to `secretKind`, as `ghp_` and 36 letters and digits, and its match ends at the second token's `_`). The longest that
    // runs past the end of this one. Its start is before `cursor` below, and the text of both masks is what the output has.
    for (let back = 1; back <= GLUE_BACK && current.end - back > current.start; back++) {
      const inside = gluedAt(text, current.end - back)
      if (inside !== undefined && inside.end > current.end && (glued === undefined || inside.end > glued.end)) glued = inside
    }
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
 *   masked from its header to its END line (or for 8 KB, if it has none), and a token's body, which a pattern takes up to
 *   1024 characters of, is masked through to the end of its run, however long that is. A lookbehind or lookahead is judged
 *   against the text as it was given.
 * - **Overlapping matches** (an `sk-` key's characters run over the token that follows it) become one mask over all of
 *   them, under the kind of the one that starts first.
 * - **Glued secrets** (`ghp_…ghp_…`, with nothing between): the second follows a letter, so on its own it isn't a match,
 *   but it is the moment the first is a mask. Each is masked, as two masks. A body takes the first letters of the prefix of
 *   a token after it (`ghp_<A>ghp_<B>`: `ghp` is in the run of `<A>`, and the match ends at the `_`), so a token is looked for
 *   at the end of a match and in the last 6 characters of it, and the longest that runs past the end is a mask of its own.
 *   That also makes a token that has too few characters of its own, and the letters of the next one's prefix to make up
 *   the length, a token (to `secretKind` as well), and masks the second whole.
 * - **It does not throw.** An error from the scan (V8's "Maximum call stack size exceeded" on a long enough run, if a pattern
 *   had a loop with no bound) gives a mask for an unreadable scan, and nothing of the text.
 * - **Masking is idempotent and complete.** The result is a fixed point: `secretKind` finds nothing in it and masking it
 *   changes nothing. A text that is not one (after `MAX_PASSES` passes, or because a pattern finds in it what its mask
 *   doesn't) is replaced by one mask for what it still holds.
 * - **Text with no secret** comes back unchanged.
 */
export function maskSecrets(text: string): string {
  try {
    let current = text
    for (let pass = 0; pass < MAX_PASSES; pass++) {
      const masked = maskOnce(current)
      if (masked === current) break
      current = masked
    }
    // What is left should have nothing in it that a pattern finds. If it has, a pattern finds what its mask doesn't, in a text
    // I haven't thought of: better one mask than a secret in a log.
    const kind = secretKind(current)
    return kind === undefined ? current : maskFor(kind)
  } catch {
    // The masking itself failed: the same, with nothing of the text kept.
    return maskFor(UNREADABLE)
  }
}

// --- a private key cut out of a text that a reader is to judge ------------------------------------------------------

/**
 * What stands for a secret of kind `kind` in a text that is sent on without it: `[a private key, left out]`. Plain words: no
 * pattern finds anything in it, and it is not a mask, so the judge's client neither masks it nor refuses a request that holds it.
 */
export function leftOut(kind: string): string {
  return `[${kind}, left out]`
}

/**
 * The fewest base64 characters in a run that `privateKeyCuts` takes for a line of a key's body wherever it is: a line of a key is
 * 64 (PEM, PGP), 70 (OpenSSH) or 76 characters, and no word of a sentence is 40. An escaped character (`\/`, `+`, `&#43;`)
 * counts as one.
 */
export const KEY_LINE_MIN = 40

/**
 * The fewest characters in a run that `privateKeyCuts` takes for part of a key's line in its reach when it looks like data, not a
 * word: it has a digit, a `+` or a `=`, or a capital after its first letter and a small letter. Of runs of random base64, 997 in
 * 1000 of eight characters do, and all but 1 in 10,000 of twelve; a word in small letters, a Capitalised word or one in CAPITALS
 * doesn't. It is what is left of a key's line that something else split (a page break, a command for each line).
 */
export const KEY_DATA_MIN = 8

/**
 * How far after a header its key is looked for: an END line, or, with none, the lines of a key that was cut off. More than the
 * mask's 8 KB, so that a big key (RSA 8192, PGP with subkeys) written with a prefix on each line (a file name, a line number)
 * is in reach whole.
 */
export const KEY_REACH_CHARS = 16 * 1024

/** A part of a text to leave out, from `start` to `end` in UTF-16 units, and what kind of secret it is. */
export interface KeyCut {
  start: number
  end: number
  kind: string
}

/** What `privateKeyCuts` found: how many private key headers, and what to leave out, in order, none touching the next. */
export interface KeyCuts {
  keys: number
  spans: KeyCut[]
}

const BASE64 = table(/[A-Za-z0-9+\/=]/)
/** ASCII punctuation that is not base64: what may stand around a line of a key (a quote, a `>`, a `#`, a bar, a comma). */
const AFFIX = table(/(?![A-Za-z0-9+\/=])[!-~]/)
/** What a filler is made of: printable ASCII that is not a letter (a line number, a quote, the `+` between two strings). */
const FILLER = table(/(?![A-Za-z])[!-~]/)
/** The most affix characters before or after a line of a key. */
const MAX_AFFIX = 4
/** The longest filler. */
const MAX_FILLER = 8
const BACKSLASH = 0x5c
const SPACE = /\s/
const LINE_BREAK = /[\n\r\u2028\u2029]/
const BREAK_TAG = /<br\s{0,8}\/?>/iy
const AFFIX_SOURCE = String.raw`(?:(?![A-Za-z0-9])[!-~])`
/** A header or an END line at a place, after an affix (a `+` or `-` of a diff, a `>` of a mail, a quote). */
const HEADER_AT = new RegExp(`${AFFIX_SOURCE}{0,${MAX_AFFIX}}?${KEY_HEADER}`, 'y')
const END_AT = new RegExp(`${AFFIX_SOURCE}{0,${MAX_AFFIX}}?(${KEY_END})`, 'y')
/** The name of a PEM or PGP armor header (`Proc-Type:`, `DEK-Info:`, `Version:`, `Comment:`). */
const ARMOR_NAME = /[A-Za-z][A-Za-z0-9-]{0,63}:/y
/** A PGP armor checksum: `=` and four base64 characters. */
const CHECKSUM = /^=[A-Za-z0-9+\/]{4}$/
/** A `+`, `/` or `=` written as an HTML entity or a URL escape: one character of a run of base64. (`\/` and `+` are read by hand.) */
const ENTITY_UNIT = /&(?:#0{0,4}(?:43|47|61)|#[xX]0{0,4}(?:2[bBfF]|3[dD])|plus|sol|equals);/y
const PERCENT_UNIT = /%(?:2[bBfF]|3[dD])/y
const ESCAPED_UNIT = /^00(?:2[bBfF]|3[dD])$/
/** A line break written as an entity or a URL escape: `&#xD;`, `&#10;`, `%0A`. */
const ENTITY_BREAK = /&#(?:[xX]0{0,4}[aAdD]|0{0,4}1[03]);/y
const PERCENT_BREAK = /%0[aAdD]/y
/** Any HTML entity, which is not read for base64 (`&amp;` is not the letters `amp`). */
const ENTITY = /&(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|[A-Za-z][A-Za-z0-9]{1,31});/y
/** The start of an HTML tag, to its name, which is not read for base64. Its attributes are. */
const TAG_NAME = /<\/?([A-Za-z][A-Za-z0-9]{0,15})/y
/** Tags that start a new line on a page: what a row of a key in markup ends at. */
const BLOCK_TAGS = new Set(['br', 'p', 'div', 'li', 'tr', 'pre', 'table', 'tbody', 'thead', 'tfoot', 'ul', 'ol', 'dd', 'dt', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'section', 'article'])
/** Tags with no attributes, which may stand between two cut parts and be cut with them. */
const GAP_TAG = /<\/?(?:br|p|div|li|tr|td|th|pre|code|tt|span|table|tbody)\s{0,8}\/?>/iy
/** The words a header or an END line may have that say what kind of key it is: cut with it. Any other word in one is kept. */
const KEY_WORDS = new Set(['BEGIN', 'END', 'PRIVATE', 'KEY', 'RSA', 'DSA', 'EC', 'ECDSA', 'ED25519', 'ED448', 'X25519', 'X448', 'OPENSSH', 'SSH2', 'ENCRYPTED', 'PGP', 'BLOCK', 'ANY'])
/** What the mask takes for a private key, from its header: to its END line, or the characters a key is made of. */
const KEY_REACH = MASKERS.find(({ label }) => label === PRIVATE_KEY_KIND)!.glued
/** Every pattern but a private key's. */
const TOKEN_MASKERS = MASKERS.filter(({ label }) => label !== PRIVATE_KEY_KIND)
/** How far back from a header a token that runs into it may start: the longest body a pattern takes, and its prefix. */
const TOKEN_BACK = BODY_MAX + 16

interface Line {
  start: number
  end: number
}

function isIn(taken: Uint8Array, text: string, index: number): boolean {
  const code = text.charCodeAt(index)
  return code < 128 && taken[code] === 1
}

/** Where `pattern` (sticky) matches at `index` ends, or `undefined`. */
function stickyEnd(pattern: RegExp, text: string, index: number): number | undefined {
  pattern.lastIndex = index
  const match = pattern.exec(text)
  return match === null ? undefined : index + match[0].length
}

/** Past the run of backslashes at `index`. */
function pastBackslashes(text: string, index: number): number {
  let after = index
  while (text.charCodeAt(after) === BACKSLASH) after++
  return after
}

/** The END line at `index` (after an affix): where its dashes start, and where it ends. */
function endLineAt(text: string, index: number): Line | undefined {
  END_AT.lastIndex = index
  const match = END_AT.exec(text)
  if (match === null) return undefined
  const end = index + match[0].length
  return { start: end - match[1]!.length, end }
}

/**
 * Where one character of a run of base64 at `index` ends, or `undefined`: a base64 character, or one written escaped, as JSON,
 * markup or a URL may write it (`\/`, `+`, `=`, `&#43;`, `&#x2F;`, `&equals;`, `%2B`). A run of backslashes is read once.
 */
function unitEnd(text: string, index: number): number | undefined {
  const code = text.charCodeAt(index)
  if (code < 128 && BASE64[code] === 1) return index + 1
  if (code === BACKSLASH) {
    const after = pastBackslashes(text, index)
    if (text.charCodeAt(after) === 0x2f) return after + 1
    if (text.charAt(after) === 'u' && ESCAPED_UNIT.test(text.slice(after + 1, after + 5))) return after + 5
    return undefined
  }
  if (code === 0x26) return stickyEnd(ENTITY_UNIT, text, index)
  if (code === 0x25) return stickyEnd(PERCENT_UNIT, text, index)
  return undefined
}

/**
 * Where a line break at `index` ends, or `undefined`: one in the text, one written out (`\n`, `\r`), as an entity or a URL escape
 * (`&#xD;`, `%0A`), or a tag that starts a new line on a page (`<br>`, `<tr>`, `</p>`; to the end of its name).
 */
function breakEnd(text: string, index: number): number | undefined {
  const char = text.charAt(index)
  if (char === '\n' || char === '\u2028' || char === '\u2029') return index + 1
  if (char === '\r') return text.charAt(index + 1) === '\n' ? index + 2 : index + 1
  if (char === '\\') {
    const after = pastBackslashes(text, index)
    const letter = text.charAt(after)
    return letter === 'n' || letter === 'r' ? after + 1 : undefined
  }
  if (char === '&') return stickyEnd(ENTITY_BREAK, text, index)
  if (char === '%') return stickyEnd(PERCENT_BREAK, text, index)
  if (char === '<') {
    TAG_NAME.lastIndex = index
    const tag = TAG_NAME.exec(text)
    return tag !== null && BLOCK_TAGS.has(tag[1]!.toLowerCase()) ? index + tag[0].length : undefined
  }
  return undefined
}

/** Past what is at `index` that is neither base64 nor a line break: a run of backslashes (and a `\t`), an entity, a tag's name, or one character. */
function skipEnd(text: string, index: number): number {
  const char = text.charAt(index)
  if (char === '\\') {
    const after = pastBackslashes(text, index)
    return text.charAt(after) === 't' ? after + 1 : after
  }
  if (char === '&') return stickyEnd(ENTITY, text, index) ?? index + 1
  if (char === '<') return stickyEnd(TAG_NAME, text, index) ?? index + 1
  return index + 1
}

/** A run of base64 characters (escaped ones each counted as one, in `units`), and the row it starts on. */
interface Run {
  start: number
  end: number
  units: number
  row: number
  /** Whether it has a digit, a `+` or a `=` (written escaped or not), or a capital after its first character and a small letter. */
  data: boolean
}

/** What one character of a run is, escaped or not: its own, or the `+`, `/` or `=` an escape stands for. */
function unitChar(text: string, start: number, end: number): string {
  if (end - start === 1) return text.charAt(start)
  const escape = text.slice(start, end).toLowerCase()
  return /2b|43;|plus/.test(escape) ? '+' : /3d|61;|equals/.test(escape) ? '=' : '/'
}

/** The runs of base64 in `text` from `from` to `to`, in order, each with its row (how many line breaks come before it), and how many rows there are. */
function scanRuns(text: string, from: number, to: number): { runs: Run[], rows: number } {
  const runs: Run[] = []
  let row = 0
  let run: Run | undefined
  let lower = false
  let capitalLater = false
  let at = from
  while (at < to) {
    const unit = unitEnd(text, at)
    if (unit !== undefined && unit <= to) {
      const char = unitChar(text, at, unit)
      if (run === undefined) {
        run = { start: at, end: unit, units: 1, row, data: false }
        runs.push(run)
        lower = false
        capitalLater = false
      } else {
        run.end = unit
        run.units++
        if (char >= 'A' && char <= 'Z') capitalLater = true
      }
      if (char >= 'a' && char <= 'z') lower = true
      if ((char >= '0' && char <= '9') || char === '+' || char === '=' || (lower && capitalLater)) run.data = true
      at = unit
      continue
    }
    run = undefined
    const lineBreak = breakEnd(text, at)
    if (lineBreak !== undefined) {
      row++
      at = lineBreak
    } else {
      at = skipEnd(text, at)
    }
  }
  return { runs, rows: row }
}

/**
 * The separator at `index`, if there is one: a whitespace character, a line break written out (`\n`, `\r`, `\t`, after any
 * number of backslashes, as a string in JSON or code has it, or `&#xD;`), or a `<br>`. A run of backslashes is read once.
 */
function separatorAt(text: string, index: number): { end: number, lineBreak: boolean } | undefined {
  const char = text.charAt(index)
  if (char === '') return undefined
  if (SPACE.test(char)) return { end: index + 1, lineBreak: LINE_BREAK.test(char) }
  if (char === '\\') {
    const after = pastBackslashes(text, index)
    const letter = text.charAt(after)
    return letter === 'n' || letter === 'r' || letter === 't' ? { end: after + 1, lineBreak: letter !== 't' } : undefined
  }
  if (char === '<') {
    const end = stickyEnd(BREAK_TAG, text, index)
    if (end !== undefined) return { end, lineBreak: true }
  }
  if (char === '&') {
    const end = stickyEnd(ENTITY_BREAK, text, index)
    if (end !== undefined) return { end, lineBreak: true }
  }
  return undefined
}

/** Past the separators at `index`, and whether there was a line break among them. */
function skipSeparators(text: string, index: number): { end: number, lineBreak: boolean } {
  let end = index
  let lineBreak = false
  for (let found = separatorAt(text, end); found !== undefined; found = separatorAt(text, end)) {
    end = found.end
    lineBreak ||= found.lineBreak
  }
  return { end, lineBreak }
}

/**
 * A secret other than a private key that starts at `index`, whatever comes before it (the longest, as the mask takes it), or
 * `undefined`. Only `g`, `s`, `a` and `A` start one.
 */
function tokenAt(text: string, index: number): Range | undefined {
  const first = text.charAt(index)
  if (first !== 'g' && first !== 's' && first !== 'a' && first !== 'A') return undefined
  let best: Range | undefined
  for (const { label, glued, more } of TOKEN_MASKERS) {
    glued.lastIndex = index
    const match = glued.exec(text)
    if (match === null || match[0].length === 0) continue
    const end = more(text, index + match[0].length, match[0])
    if (best === undefined || end > best.end) best = { start: index, end, label }
  }
  return best
}

/** Whether a token that has a `_` or `-` in it starts at `index`: a line of a key stops before one, and never takes its prefix. */
function tokenStarts(text: string, index: number): boolean {
  const first = text.charAt(index)
  return (first === 'g' || first === 's' || first === 'a') && tokenAt(text, index) !== undefined
}

/** Whether a word ends at `index`: the text ends, a separator, a header, an END line or a token starts there. */
function boundaryAt(text: string, index: number): boolean {
  return index >= text.length
    || separatorAt(text, index) !== undefined
    || stickyEnd(HEADER_AT, text, index) !== undefined
    || endLineAt(text, index) !== undefined
    || tokenAt(text, index) !== undefined
}

/** A filler at `index`, a word of up to `MAX_FILLER` characters with no letter in it (a line number, a quote, a bar): where it ends. */
function fillerAt(text: string, index: number): number | undefined {
  let end = index
  while (end < text.length && end - index <= MAX_FILLER && isIn(FILLER, text, end)) end++
  if (end === index || end - index > MAX_FILLER) return undefined
  return boundaryAt(text, end) ? end : undefined
}

/**
 * A run of base64 at `index`, after an affix of up to `MAX_AFFIX` characters: where it starts and ends, how many characters it
 * has (an escaped one counted as one), and where the word it is in ends (`next`). `whole` is false when something else is glued
 * to it, past an affix: the word goes on, and is not a key's.
 */
function runAt(text: string, index: number): { start: number, end: number, units: number, next: number, whole: boolean } | undefined {
  let start = index
  while (start < text.length && start - index < MAX_AFFIX && isIn(AFFIX, text, start) && unitEnd(text, start) === undefined) start++
  let end = start
  let units = 0
  while (end < text.length) {
    if (isIn(BASE64, text, end) && tokenStarts(text, end)) break
    const unit = unitEnd(text, end)
    if (unit === undefined) break
    end = unit
    units++
  }
  if (units === 0) return undefined
  if (boundaryAt(text, end)) return { start, end, units, next: end, whole: true }
  let after = end
  while (after < text.length && after - end < MAX_AFFIX && isIn(AFFIX, text, after)) after++
  const whole = after > end && boundaryAt(text, after)
  return { start, end, units, next: after, whole }
}

/** Whether a line ends after `index`: the text ends, or a line break or an END line comes, past the separators. */
function endsLine(text: string, index: number): boolean {
  const gap = skipSeparators(text, index)
  return gap.end >= text.length || gap.lineBreak || endLineAt(text, gap.end) !== undefined
}

/**
 * An armor header line at `index` (`Proc-Type: 4,ENCRYPTED`, `Version: GnuPG v2`): where the line ends. A run of backslashes
 * is read once.
 */
function armorAt(text: string, index: number): number | undefined {
  const name = stickyEnd(ARMOR_NAME, text, index)
  if (name === undefined) return undefined
  let end: number = name
  const next = text.charAt(end)
  if (next !== '' && next !== ' ' && next !== '\t' && separatorAt(text, end)?.lineBreak !== true) return undefined
  while (end < text.length) {
    const code = text.charCodeAt(end)
    if (code === BACKSLASH) {
      const after = pastBackslashes(text, end)
      const letter = text.charAt(after)
      if (letter === 'n' || letter === 'r') break
      end = after
      continue
    }
    if (LINE_BREAK.test(text.charAt(end)) || (code === 0x3c && stickyEnd(BREAK_TAG, text, end) !== undefined)) break
    end++
  }
  return end
}

/**
 * Cut, into `cuts`, a header or an END line (`start` to `end`), but for any word in it that doesn't say what kind of key it is
 * (`KEY_WORDS`): such a word, and the spaces around it, are kept, since the patterns let a header carry about 60 characters of
 * capitals and spaces, and the words of a sentence among them would otherwise be hidden from the judge.
 */
function cutLine(text: string, start: number, end: number, cuts: KeyCut[]): void {
  let from = start
  for (const word of text.slice(start, end).matchAll(/[A-Z0-9]+/g)) {
    if (KEY_WORDS.has(word[0])) continue
    const wordStart = start + word.index
    const wordEnd = wordStart + word[0].length
    const keepFrom = wordStart - 1 >= from && text.charAt(wordStart - 1) === ' ' ? wordStart - 1 : wordStart
    if (keepFrom > from) cuts.push({ start: from, end: keepFrom, kind: PRIVATE_KEY_KIND })
    from = wordEnd < end && text.charAt(wordEnd) === ' ' ? wordEnd + 1 : wordEnd
  }
  if (end > from) cuts.push({ start: from, end, kind: PRIVATE_KEY_KIND })
}

/**
 * Cut, into `cuts`, what follows the header `header` for as long as it is a key's body, read as a key is written: any armor
 * header lines (kept: they say how the key is kept, and hold nothing of it); then lines of `KEY_LINE_MIN` or more base64
 * characters, apart from each other by whitespace, a line break written out, a `<br>`, or a filler (a line number, a quote, a `+`
 * between two strings); then, at most, one shorter line that a line break, the text's end or the END line follows (the key's
 * last), a PGP checksum, and the END line. It stops at anything else, and what it stops at is not cut. This is what reaches a key
 * longer than `KEY_REACH_CHARS`; `cutRegion` cuts what it doesn't read.
 */
function walkKey(text: string, header: Line, cuts: KeyCut[]): void {
  let open: number | undefined = header.end
  let last = header.end
  const cut = (start: number, end: number): void => {
    open ??= start
    last = end
  }
  const close = (): void => {
    if (open !== undefined && last > open) cuts.push({ start: open, end: last, kind: PRIVATE_KEY_KIND })
    open = undefined
  }
  let phase: 'start' | 'body' | 'tail' = 'start'
  let checksum = false
  let at = header.end
  for (;;) {
    at = skipSeparators(text, at).end
    if (at >= text.length || stickyEnd(HEADER_AT, text, at) !== undefined) break
    const endLine = endLineAt(text, at)
    if (endLine !== undefined) {
      if (open !== undefined) last = endLine.start
      close()
      cutLine(text, endLine.start, endLine.end, cuts)
      break
    }
    if (phase === 'start') {
      const line = armorAt(text, at)
      if (line !== undefined) {
        close()
        at = line
        continue
      }
    }
    const filler = fillerAt(text, at)
    if (filler !== undefined) {
      at = filler
      continue
    }
    const run = runAt(text, at)
    if (run === undefined) break
    if (phase !== 'tail' && run.units >= KEY_LINE_MIN) {
      cut(run.start, run.end)
      // Something glued to a line of a key that isn't one: the line is cut, and the walk goes no further.
      if (!run.whole) break
      phase = 'body'
    } else if (phase !== 'start' && run.whole && !checksum && run.units === 5 && CHECKSUM.test(text.slice(run.start, run.end))) {
      cut(run.start, run.end)
      checksum = true
      phase = 'tail'
    } else if (phase === 'body' && run.whole && endsLine(text, run.next)) {
      cut(run.start, run.end)
      phase = 'tail'
    } else {
      break
    }
    at = run.next
  }
  close()
}

/**
 * Cut, into `cuts`, what a key is made of between its header (`from`) and its END line, or, with no END line in reach, the next
 * header or `KEY_REACH_CHARS` (`to`), however the key is written: with a prefix on each line (`rg` and `grep -n`'s file and line
 * number, a numbered file view, a log line's time, a table cell), escaped (`\/`, `+`, `&#43;`), or cut off. Rows are what
 * line breaks make (in the text, written out, as entities, or as tags that start a line on a page).
 *
 * - every run of `KEY_LINE_MIN` or more base64 characters (an escaped one counted as one): a line of a key;
 * - every run of `KEY_DATA_MIN` or more that looks like data, not a word (a digit, a `+` or `=`, a capital inside it): what is
 *   left of a line that something else split;
 * - after the header, and after each block of rows that have a long run, the first and the last runs of the next row that has
 *   any (past armor header lines): the key's last line, or its only one, which is shorter, whatever stands before or after it
 *   on its row (a line number, a file name, `… [truncated]`); on the header's own row, the first run after it;
 * - with an END line: the last run on the END line's row before it, and the last run of the row before that has any: the key's
 *   last line, whatever its row's prefix is; and the END line.
 *
 * Words are not cut but in those places: the first and last word of the row after a header or a key's lines, the last word
 * before an END line, and words of eight letters or more that look like data.
 */
function cutRegion(text: string, from: number, to: number, endLine: Line | undefined, cuts: KeyCut[]): void {
  const { runs, rows } = scanRuns(text, from, endLine?.start ?? to)
  const cut = (run: Run): void => {
    cuts.push({ start: run.start, end: run.end, kind: PRIVATE_KEY_KIND })
  }
  const rowsOf: Array<{ first: Run, last: Run, long: boolean }> = []
  for (const run of runs) {
    const long = run.units >= KEY_LINE_MIN
    if (long || (run.data && run.units >= KEY_DATA_MIN)) cut(run)
    const current = rowsOf.at(-1)
    if (current !== undefined && current.first.row === run.row) {
      current.last = run
      current.long ||= long
    } else {
      rowsOf.push({ first: run, last: run, long })
    }
  }
  // The header counts as such a row: the row after it is a key's only line when it is short (an Ed25519 key's is 64 characters,
  // and cut off it is less), so its first and last runs are cut too, or, on the header's own row, the first run after it. Armor
  // header lines right after the header are passed over: they hold nothing of a key, and the walk keeps them.
  let previousLong = true
  let afterHeader = true
  for (const row of rowsOf) {
    if (afterHeader && !row.long && armorAt(text, row.first.start) !== undefined) continue
    if (previousLong && !row.long) {
      cut(row.first)
      if (!afterHeader || row.first.row > 0) cut(row.last)
    }
    previousLong = row.long
    afterHeader = false
  }
  if (endLine === undefined) return
  // The last run on the END line's row (a prefix, or the last line of a key written on one line), then the last of the row before.
  let index = rowsOf.length - 1
  if (index >= 0 && rowsOf[index]!.first.row === rows) cut(rowsOf[index--]!.last)
  if (index >= 0) cut(rowsOf[index]!.last)
  cutLine(text, endLine.start, endLine.end, cuts)
}

/**
 * Cut, into `cuts`, every token (a secret that is not a private key) that the mask would take with the key whose header starts at
 * `start`, whole: one up to `reach` (what the mask takes for the key, and what `cutRegion` reads), one glued to its end, and one
 * that runs into its header. A cut that left part of a token, or a token glued to a letter that the mask's lookbehind then
 * refuses, would leave it for the judge.
 */
function cutTokens(text: string, start: number, reach: number, cuts: KeyCut[]): void {
  let from = start
  while (from > 0 && start - from < TOKEN_BACK && /[A-Za-z0-9_-]/.test(text.charAt(from - 1))) from--
  for (let at = from; at <= reach && at < text.length;) {
    let token = tokenAt(text, at)
    if (token === undefined || token.end <= start) {
      at++
      continue
    }
    while (token !== undefined) {
      cuts.push({ start: token.start, end: token.end, kind: token.label })
      at = token.end
      // A token whose prefix this one's body took (`ghp_<A>ghp_<B>`), as `maskOnce` finds it: one that starts in its last few
      // characters and runs past it.
      let glued: Range | undefined
      for (let back = 1; back <= GLUE_BACK && token.end - back > token.start; back++) {
        const inside = tokenAt(text, token.end - back)
        if (inside !== undefined && inside.end > token.end && (glued === undefined || inside.end > glued.end)) glued = inside
      }
      token = glued
    }
  }
}

/** Every match of `source` in `text`, also those that start inside another (a header can start in the dashes that end one). */
function everyMatch(text: string, source: string): Line[] {
  const found: Line[] = []
  const pattern = new RegExp(source, 'g')
  for (let match = pattern.exec(text); match !== null; match = pattern.exec(text)) {
    found.push({ start: match.index, end: match.index + match[0].length })
    pattern.lastIndex = match.index + 1
  }
  return found
}

/** The first of `lines` (in order) that starts at or after `index`. */
function firstFrom(lines: readonly Line[], index: number): Line | undefined {
  let low = 0
  let high = lines.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (lines[middle]!.start < index) low = middle + 1
    else high = middle
  }
  return lines[low]
}

/**
 * Whether what is between two cuts, from `from` to `to`, is nothing a reader needs: whitespace, ASCII that is not a letter
 * (punctuation, a line number, the `+` between two strings), a line break written out (`\n`, `&#xD;`), or a tag with no
 * attributes. Two cuts with that between them are one.
 */
function isGap(text: string, from: number, to: number): boolean {
  let at = from
  while (at < to) {
    const code = text.charCodeAt(at)
    if (code === BACKSLASH) {
      const after = pastBackslashes(text, at)
      const letter = text.charAt(after)
      at = letter === 'n' || letter === 'r' || letter === 't' ? after + 1 : after
      continue
    }
    if (code === 0x26) {
      const end = stickyEnd(ENTITY_BREAK, text, at)
      if (end !== undefined) {
        at = end
        continue
      }
    }
    if (code === 0x3c) {
      const end = stickyEnd(GAP_TAG, text, at)
      if (end !== undefined) {
        at = end
        continue
      }
    }
    if (isIn(FILLER, text, at) || SPACE.test(text.charAt(at))) {
      at++
      continue
    }
    return false
  }
  return true
}

/**
 * The private keys in `text`, as what to cut out of it so that a reader (the judge) can be sent the rest: none of a key, and
 * nothing written around it but a few words where a key's last line would be. The text is not changed; `withoutPrivateKeys` puts
 * `leftOut` in each place.
 *
 * - **What is a key.** Each private key header (the patterns', at every place one starts, also in the dashes that end another).
 *   The header is cut (`cutLine`), but for words in it that don't say what kind of key it is.
 * - **What is cut after it** goes as far as its END line, if one is in reach (the first after the header, within
 *   `KEY_REACH_CHARS` and before any other header), or else the next header or `KEY_REACH_CHARS`. In that reach (`cutRegion`):
 *   every run of `KEY_LINE_MIN` or more base64 characters, an escaped one counted as one, and every run of `KEY_DATA_MIN` or
 *   more that looks like data; the first and last runs of the row after the header and after a block of rows that have a long
 *   run (the key's last line, whatever prefix its row has); the last runs before the END line; and the END line. And what
 *   follows the header for as long as it reads as a key's body (`walkKey`), however long. Where it can't tell, it cuts: a few
 *   words near a header cost the judge little, and a key's line sent costs the user its key.
 * - **Tokens** that the mask would take with a key, or that are in its reach (`cutTokens`), are cut whole, so that no cut leaves
 *   part of one.
 * - **What is never cut:** a sentence. What is cut has no space in it: a run of base64, or whitespace, punctuation and line
 *   breaks between two cut parts (`isGap`). A fake header above a page, or a fake header and END line around it, can't take the
 *   page out of what the judge reads. What one can take is runs of base64 with no space in them (instructions written as one long
 *   word, as a token-shaped word can be, and words of eight or more with a digit or a capital inside), the first and last words
 *   of the row after a header or a long run, and the last before an END line: a few words for each fake header.
 *
 * Linear in the length of the text.
 */
export function privateKeyCuts(text: string): KeyCuts {
  if (!text.includes('-----BEGIN ')) return { keys: 0, spans: [] }
  const headers = everyMatch(text, KEY_HEADER)
  const endLines = text.includes('-----END ') ? everyMatch(text, KEY_END) : []
  const cuts: KeyCut[] = []
  /** Which key each cut is for: two cuts with only a gap between them are one if they are for the same key. */
  const owners: number[] = []
  for (const [index, header] of headers.entries()) {
    const first = cuts.length
    cutLine(text, header.start, header.end, cuts)
    walkKey(text, header, cuts)
    const limit = Math.min(headers[index + 1]?.start ?? text.length, header.end + KEY_REACH_CHARS, text.length)
    const next = firstFrom(endLines, header.end)
    const endLine = next !== undefined && next.start < limit ? next : undefined
    if (limit > header.end) cutRegion(text, header.end, limit, endLine, cuts)
    KEY_REACH.lastIndex = header.start
    const taken = KEY_REACH.exec(text)
    const reach = Math.max(taken === null ? header.end : header.start + taken[0].length, endLine?.end ?? limit)
    cutTokens(text, header.start, reach, cuts)
    for (let at = first; at < cuts.length; at++) owners[at] = index
  }
  const order = cuts.map((_cut, at) => at).sort((a, b) => cuts[a]!.start - cuts[b]!.start || cuts[b]!.end - cuts[a]!.end)
  const spans: KeyCut[] = []
  let owner = -1
  for (const at of order) {
    const cut = cuts[at]!
    const previous = spans.at(-1)
    // Overlapping or touching cuts are one. So are a key's cuts with a gap between them, but not two keys': a page of fake keys
    // shows the judge each of them.
    if (previous !== undefined && (cut.start <= previous.end || (owners[at] === owner && isGap(text, previous.end, cut.start)))) {
      previous.end = Math.max(previous.end, cut.end)
    } else {
      spans.push({ ...cut })
    }
    owner = owners[at]!
  }
  return { keys: headers.length, spans }
}

/** `text` with each of `privateKeyCuts`' spans replaced by `leftOut` of its kind. */
export function withoutPrivateKeys(text: string): string {
  let out = ''
  let cursor = 0
  for (const span of privateKeyCuts(text).spans) {
    out += text.slice(cursor, span.start) + leftOut(span.kind)
    cursor = span.end
  }
  return out + text.slice(cursor)
}
