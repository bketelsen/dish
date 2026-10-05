/**
 * A page's aria snapshot (`ariaSnapshot({ mode: 'ai' })`), made fit for a result: a password field's value blanked, secrets
 * masked, and the text cut at a line end, with the sections past the cut named. What a browser keeps of it (`keep`). And
 * the words for one element, from its line.
 *
 * The lines are in the shape playwright-core 1.63.0's renderer gives them (`renderAriaSnapshotAsYaml` and its helpers, in
 * the injected script of `lib/coreBundle.js`):
 * - a node is `- <key>`, `- <key>: <text>`, or `- <key>:` with its children under it, two spaces deeper;
 * - its key is `role "name" [attr] [ref=e5]`, in single quotes (a `'` in it doubled) when YAML needs them, as for a name
 *   holding ": ". The name is JSON-quoted, or written as it is when it starts and ends with `/`;
 * - an `<input>`'s value is its text: `- textbox "Password" [ref=e5]: hunter2`. With a placeholder that isn't its name,
 *   the textbox is a block, the placeholder on a `- /placeholder:` line and the value on a `- text:` line under it. A
 *   password input given another role (`role="searchbox"`) shows its value under that role the same way;
 * - a node gets a ref only when it is visible and takes the pointer, so a covered textbox shows its value with no ref.
 *
 * Every pattern here runs in time linear in the line: a name written as it is has at most 900 characters (Playwright
 * leaves out a longer one), and an attribute is a word, maybe with `=` and a value with no blank. A page controls the
 * text, so a pattern that could backtrack across a long line would block dsh.
 *
 * Pure: the password check comes in as an argument.
 *
 * @module dish-browser/snapshot
 */

import { createHash } from 'node:crypto'
import { maskSecrets } from 'dish-kit'
import { PASSWORD_CHECKS } from './types.ts'
import { ELEMENT_MAX, PASSWORD_HIDDEN, quoted, VALUE_HIDDEN } from './words.ts'

/** A ref as Playwright gives it: `e7`, or `f1e7` in a frame (the form Playwright's MCP checks). */
export const REF = /^(?:f\d+)?e\d+$/

export interface Processed {
  /** What a result shows: the text cut at a line end, within `max` with the sections' words. */
  text: string
  /** All of it, masked and blanked, before the cut. */
  whole: string
  /** `whole`'s length. */
  total: number
  cut: boolean
  /**
   * When cut, the sections whose line is past the cut, by their words (`region "Bottom" [ref=e3002]`): the shallowest
   * first, up to `SECTIONS_LISTED` and a sixteenth of `max`, listed in page order; and how many more there are.
   */
  sections: { listed: string[], more: number }
}

/** What a browser keeps of the full snapshot its agent last got: the text for `elementOf`, and a digest of all of it. */
export interface Kept {
  /** `whole` up to `KEEP_FACTOR` × max, cut at a line end. */
  text: string
  /** SHA-256 of `whole`, all of it: the unchanged line compares these. */
  digest: string
}

/** How much of a snapshot a browser keeps, in `snapshotChars`: 4, so 120,000 characters at the default. */
export const KEEP_FACTOR = 4
/** The most sections past the cut a result names. */
const SECTIONS_LISTED = 20
/** The share of `max` the sections' words may take: a sixteenth (1,875 characters of 30,000). */
const SECTIONS_SHARE = 16
/** The roles a section has: what `browser_read` with a ref usefully reads. */
const SECTION_ROLES = 'main|navigation|region|form|complementary|article|list|table|dialog'

/**
 * A key's name: JSON-quoted; a lone `/`, which ends where the attributes or the key do; or a name that starts and ends with
 * `/`, written as it is, of at most 900 characters.
 */
const NAME = String.raw`"(?:[^"\\\n]|\\.)*"|\/(?= \[|'?:|'?$)|\/[^\n]{0,898}?\/`
/** A key's attributes, each a word maybe with a value: `[level=1]`, `[active]`, `[ref=e5]`, `[cursor=pointer]`, `[box=1,2,3,4]`. */
const ATTRS = String.raw`(?: \[[a-z-]+(?:=[^\]\s]*)?\])*`
/** The roles an `<input>` that may be a password field can have: its own, `textbox`, or one a page gave it. */
const VALUE_ROLES = 'textbox|searchbox|combobox|spinbutton'
/** What `processSnapshot` writes after a key whose value it left out. */
const HIDDEN = String.raw`(?: (?:${escaped(PASSWORD_HIDDEN)}|${escaped(VALUE_HIDDEN)}))?`

/** `text` as a pattern that matches it literally. */
function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** A node's key line up to its colon: the indent, `- `, and the key, in single quotes or not. */
function keyLine(role: string): string {
  return String.raw`(?<head>(?<indent> *)- (?<q>'?)(?<role>${role})(?: (?<name>${NAME}))?(?<attrs>${ATTRS})\k<q>)`
}

/** A value role with its value on its line. */
const INLINE = new RegExp(String.raw`^${keyLine(VALUE_ROLES)}: (?<value>[^\n]+)$`)
/** A value role whose children (a placeholder, its value) are under it. */
const BLOCK = new RegExp(String.raw`^${keyLine(VALUE_ROLES)}:$`)
/** A value role with no value. */
const BARE = new RegExp(String.raw`^${keyLine(VALUE_ROLES)}$`)
/** Any value role's line, whatever follows the role. */
const VALUE_LINE = new RegExp(String.raw`^ *- '?(${VALUE_ROLES})\b`)
/** Any node's line, for `elementOf`, also as `processSnapshot` leaves it. */
const ANY = new RegExp(String.raw`^${keyLine('[a-z][a-z-]*')}${HIDDEN}(?::(?: [^\n]*)?)?$`)
/** A section's line, from where the line starts (sticky: `lastIndex` is set to the line's start). */
const SECTION_AT = new RegExp(String.raw` *- '?(?:${SECTION_ROLES})\b`, 'y')
/** A block's value line. */
const TEXT_LINE = /^ *- text: /
/** A textbox's placeholder line, which comes before its value line. */
const PLACEHOLDER_LINE = /^ *- \/placeholder: /

/** A line of a value role that shows a value. */
interface Candidate {
  /** The line of the key. */
  line: number
  /** The key line up to its colon, and how the line ended: the value after it (`inline`), or children under it (`block`). */
  head: string
  form: 'inline' | 'block'
  /** The block's value line, which goes when the value is hidden. */
  valueLine?: number
  /** The ref to check by; undefined when the line has none, or when the line's shape isn't one dish knows. */
  ref: string | undefined
}

function indentOf(line: string): number {
  return /^ */.exec(line)![0].length
}

/** The ref in a key's attributes, when it has a well-formed one. */
function refOf(attrs: string | undefined): string | undefined {
  const ref = / \[ref=([^\]]*)\]/.exec(attrs ?? '')?.[1]
  return ref !== undefined && REF.test(ref) ? ref : undefined
}

/**
 * A block's value: an `<input>`'s `- text:` line is its first child, or its second, after its `- /placeholder:` line.
 * Nothing further is looked at, so nested blocks cost no more than their lines.
 */
function valueLineOf(lines: readonly string[], at: number): number | undefined {
  const depth = indentOf(lines[at]!) + 2
  for (let index = at + 1; index <= at + 2 && index < lines.length; index++) {
    const line = lines[index]!
    if (indentOf(line) !== depth) return undefined
    if (TEXT_LINE.test(line)) return index
    if (!PLACEHOLDER_LINE.test(line)) return undefined
  }
  return undefined
}

/** Every value role's line that shows a value. One in a shape the patterns don't know comes with no ref, and no head of its own. */
function candidates(lines: readonly string[]): Candidate[] {
  const found: Candidate[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    const role = VALUE_LINE.exec(line)?.[1]
    if (role === undefined) continue
    const inline = INLINE.exec(line)
    if (inline !== null) {
      found.push({ line: index, head: inline.groups!.head!, form: 'inline', ref: refOf(inline.groups!.attrs) })
      continue
    }
    const block = BLOCK.exec(line)
    if (block !== null) {
      const valueLine = valueLineOf(lines, index)
      if (valueLine !== undefined) found.push({ line: index, head: block.groups!.head!, form: 'block', valueLine, ref: refOf(block.groups!.attrs) })
      continue
    }
    if (BARE.test(line)) continue
    // A shape the patterns don't know, which may hold a value: everything after the role goes.
    const head = `${' '.repeat(indentOf(line))}- ${role}`
    if (line.endsWith(':')) found.push({ line: index, head, form: 'block', valueLine: valueLineOf(lines, index), ref: undefined })
    else if (line.includes(': ')) found.push({ line: index, head, form: 'inline', ref: undefined })
  }
  return found
}

/** Whether `ref` is a password field. A check that rejects, or answers anything but false, says it is. */
async function passwordField(isPassword: (ref: string) => Promise<boolean>, ref: string): Promise<boolean> {
  try {
    return (await isPassword(ref)) !== false
  } catch {
    return true
  }
}

/** `text`'s first `units` UTF-16 units, one fewer when the last would be the first half of a surrogate pair. */
function headOf(text: string, units: number): string {
  const head = text.slice(0, Math.max(0, units))
  return /[\ud800-\udbff]$/.test(head) ? head.slice(0, -1) : head
}

/** Where `text` is cut to at most `max`: its last line end past half of `max`, else `max` (never inside a surrogate pair). */
function cutEnd(text: string, max: number): number {
  const lineEnd = text.lastIndexOf('\n', max)
  return headOf(text, lineEnd > max / 2 ? lineEnd : max).length
}

interface Section { at: number, indent: number, words: string }

/** The sections whose line starts after `from`'s line, in page order. */
function sectionsAfter(text: string, from: number): Section[] {
  const found: Section[] = []
  for (let end = text.indexOf('\n', from); end !== -1;) {
    const start = end + 1
    end = text.indexOf('\n', start)
    SECTION_AT.lastIndex = start
    if (!SECTION_AT.test(text)) continue
    const line = text.slice(start, end === -1 ? text.length : end)
    const words = lineWords(line)
    if (words !== undefined) found.push({ at: start, indent: indentOf(line), words: words.words })
  }
  return found
}

/** Of `found`, the shallowest first, up to `SECTIONS_LISTED` whose words, joined, fit in `room`; in page order. */
function pick(found: readonly Section[], room: number): Section[] {
  const order = found.map((section, index) => ({ section, index })).sort((a, b) => a.section.indent - b.section.indent || a.index - b.index)
  const picked: Section[] = []
  let used = 0
  for (const { section } of order) {
    if (picked.length >= SECTIONS_LISTED) break
    const cost = section.words.length + (picked.length > 0 ? ', '.length : 0)
    if (used + cost > room) continue
    picked.push(section)
    used += cost
  }
  return picked.sort((a, b) => a.at - b.at)
}

/**
 * Blank password values, mask secrets, cut at `max` at a line end. `isPassword` rejecting counts as a password.
 *
 * The candidates are the lines of a textbox, a searchbox, a combobox or a spinbutton that show a value. The first
 * `PASSWORD_CHECKS` of them with a ref are checked, in parallel. One past them, or with no ref to check it by (covered, or
 * not visible), has its value blanked unchecked.
 *
 * A text over `max` is cut, and the sections past the cut are named, so that a read with one's ref reaches it: up to a
 * sixteenth of `max` is set aside for their words, and the tree takes what they leave, so the two stay within `max`.
 */
export async function processSnapshot(raw: string, isPassword: (ref: string) => Promise<boolean>, max: number): Promise<Processed> {
  const lines = raw.split('\n')
  const hidden = new Map<Candidate, string>()
  const checks: Promise<void>[] = []
  for (const candidate of candidates(lines)) {
    if (candidate.ref === undefined || checks.length >= PASSWORD_CHECKS) {
      hidden.set(candidate, VALUE_HIDDEN)
      continue
    }
    const ref = candidate.ref
    checks.push(passwordField(isPassword, ref).then(password => { if (password) hidden.set(candidate, PASSWORD_HIDDEN) }))
  }
  await Promise.all(checks)
  const gone = new Set<number>()
  for (const [candidate, note] of hidden) {
    lines[candidate.line] = candidate.form === 'inline' ? `${candidate.head} ${note}` : `${candidate.head} ${note}:`
    if (candidate.valueLine !== undefined) gone.add(candidate.valueLine)
  }
  const text = maskSecrets(lines.filter((_, index) => !gone.has(index)).join('\n'))
  if (text.length <= max) return { text, whole: text, total: text.length, cut: false, sections: { listed: [], more: 0 } }
  const found = sectionsAfter(text, cutEnd(text, max - Math.floor(max / SECTIONS_SHARE)))
  const picked = pick(found, Math.floor(max / SECTIONS_SHARE))
  const end = cutEnd(text, max - picked.map(section => section.words).join(', ').length)
  // The tree took the room the sections left: one now in it is no longer past the cut.
  const listed = picked.filter(section => section.at >= end).map(section => section.words)
  const past = found.filter(section => section.at >= end).length
  return { text: text.slice(0, end), whole: text, total: text.length, cut: true, sections: { listed, more: past - listed.length } }
}

/** What a browser keeps of `processed`, a full snapshot cut at `max`: see `Kept`. */
export function keep(processed: Processed, max: number): Kept {
  return { text: keepText(processed.whole, max), digest: createHash('sha256').update(processed.whole).digest('base64') }
}

/** `text` up to `KEEP_FACTOR` × `max`, cut at a line end: what a browser keeps to name elements by. */
export function keepText(text: string, max: number): string {
  const limit = KEEP_FACTOR * max
  return text.length <= limit ? text : text.slice(0, cutEnd(text, limit))
}

/** A key's name as a reader sees it: `''` undone in a quoted key, and the JSON quoting taken off. */
function nameText(name: string, quotedKey: boolean): string {
  const literal = quotedKey ? name.replace(/''/g, '\'') : name
  if (!literal.startsWith('"')) return literal
  try {
    return String(JSON.parse(literal))
  } catch {
    return literal.slice(1, -1)
  }
}

/** A node's line as words (`button "Save" [ref=e14]`, cut to 120) and its ref; undefined for a line with no ref. */
function lineWords(line: string): { words: string, ref: string } | undefined {
  const match = ANY.exec(line)
  const ref = match === null ? undefined : refOf(match.groups!.attrs)
  if (match === null || ref === undefined) return undefined
  const tail = ` [ref=${ref}]`
  const role = match.groups!.role!
  const name = match.groups!.name
  const room = ELEMENT_MAX - role.length - ' ""'.length - tail.length
  if (name === undefined || room < 2) return { words: `${role}${tail}`, ref }
  const words = quoted(nameText(name, match.groups!.q === '\''), room)
  return { words: words === '' ? `${role}${tail}` : `${role} "${words}"${tail}`, ref }
}

/** The words for `ref` from its line in `snapshot`, or undefined. */
function wordsIn(snapshot: string | undefined, ref: string): string | undefined {
  if (snapshot === undefined || !REF.test(ref)) return undefined
  const needle = `[ref=${ref}]`
  for (let at = snapshot.indexOf(needle); at !== -1; at = snapshot.indexOf(needle, at + needle.length)) {
    const start = snapshot.lastIndexOf('\n', at) + 1
    const end = snapshot.indexOf('\n', at)
    const words = lineWords(snapshot.slice(start, end === -1 ? snapshot.length : end))
    if (words?.ref === ref) return words.words
  }
  return undefined
}

/**
 * The words for `ref` from its snapshot line (`button "Save" [ref=e14]`, cut to 120), else `[ref=e14]`. A line
 * `processSnapshot` blanked is known too.
 */
export function elementOf(snapshot: string | undefined, ref: string): string {
  return wordsIn(snapshot, ref) ?? `[ref=${ref}]`
}

/** `elementOf` over several texts: the first that knows `ref`, else `[ref=e14]`. */
export function elementIn(snapshots: ReadonlyArray<string | undefined>, ref: string): string {
  for (const snapshot of snapshots) {
    const words = wordsIn(snapshot, ref)
    if (words !== undefined) return words
  }
  return `[ref=${ref}]`
}
