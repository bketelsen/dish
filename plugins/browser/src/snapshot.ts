/**
 * A page's aria snapshot (`ariaSnapshot({ mode: 'ai' })`), made fit for a result: a password field's value blanked, secrets
 * masked, and the text cut at a line end. And the words for one element, from its line.
 *
 * The lines are in the shape playwright-core 1.63.0's renderer gives them (`renderAriaSnapshotAsYaml` and its helpers, in
 * the injected script of `lib/coreBundle.js`):
 * - a node is `- <key>`, `- <key>: <text>`, or `- <key>:` with its children under it, two spaces deeper;
 * - its key is `role "name" [attr] [ref=e5]`, in single quotes (a `'` in it doubled) when YAML needs them, as for a name
 *   holding ": ". The name is JSON-quoted, or written as it is when it starts and ends with `/`;
 * - an `<input>`'s value is its text: `- textbox "Password" [ref=e5]: hunter2`. With a placeholder that isn't its name,
 *   the textbox is a block, the placeholder on a `- /placeholder:` line and the value on a `- text:` line under it;
 * - a node gets a ref only when it is visible and takes the pointer, so a covered textbox shows its value with no ref.
 *
 * Pure: the password check comes in as an argument.
 *
 * @module dish-browser/snapshot
 */

import { maskSecrets } from 'dish-kit'
import { PASSWORD_CHECKS } from './types.ts'
import { ELEMENT_MAX, PASSWORD_HIDDEN, quoted, VALUE_HIDDEN } from './words.ts'

/** A ref as Playwright gives it: `e7`, or `f1e7` in a frame (the form Playwright's MCP checks). */
export const REF = /^(?:f\d+)?e\d+$/

export interface Processed {
  text: string
  /** The masked text's length, before the cut. */
  total: number
  cut: boolean
}

/** A key's name: JSON-quoted, or a name that starts and ends with `/`, written as it is. */
const NAME = String.raw`"(?:[^"\\\n]|\\.)*"|\/[^\n]*?\/`
/** A key's attributes: `[level=1]`, `[active]`, `[ref=e5]`, `[cursor=pointer]`. */
const ATTRS = String.raw`(?: \[[^\]\n]*\])*`

/** A node's key line up to its colon: the indent, `- `, and the key, in single quotes or not. */
function keyLine(role: string): string {
  return String.raw`(?<head>(?<indent> *)- (?<q>'?)${role}(?: (?<name>${NAME}))?(?<attrs>${ATTRS})\k<q>)`
}

/** A textbox with its value on its line. */
const INLINE = new RegExp(String.raw`^${keyLine('textbox')}: (?<value>.+)$`)
/** A textbox whose children (a placeholder, its value) are under it. */
const BLOCK = new RegExp(String.raw`^${keyLine('textbox')}:$`)
/** A textbox with no value. */
const BARE = new RegExp(String.raw`^${keyLine('textbox')}$`)
/** Any textbox line, whatever follows the role. */
const TEXTBOX = /^ *- '?textbox\b/
/** Any node's line, for `elementOf`. */
const ANY = new RegExp(String.raw`^${keyLine('(?<role>[a-z][a-z-]*)')}(?::(?: .*)?)?$`)
/** A block's value line. */
const TEXT_LINE = /^ *- text: /

/** A textbox line that shows a value. */
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

/** A block's value: the `- text:` line among its own children. */
function valueLineOf(lines: readonly string[], at: number): number | undefined {
  const indent = indentOf(lines[at]!)
  for (let index = at + 1; index < lines.length; index++) {
    const depth = indentOf(lines[index]!)
    if (depth <= indent) break
    if (depth === indent + 2 && TEXT_LINE.test(lines[index]!)) return index
  }
  return undefined
}

/** Every textbox line that shows a value. One in a shape the patterns don't know comes with no ref, and no head of its own. */
function candidates(lines: readonly string[]): Candidate[] {
  const found: Candidate[] = []
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!
    if (!TEXTBOX.test(line)) continue
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
    const head = `${' '.repeat(indentOf(line))}- textbox`
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

/**
 * Blank password values, mask secrets, cut at `max` at a line end. `isPassword` rejecting counts as a password.
 *
 * The first `PASSWORD_CHECKS` textboxes with a value and a ref are checked, in parallel. A textbox past them, or with no
 * ref to check it by (covered, or not visible), has its value blanked unchecked.
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
  if (text.length <= max) return { text, total: text.length, cut: false }
  const lineEnd = text.lastIndexOf('\n', max)
  return { text: headOf(text, lineEnd > max / 2 ? lineEnd : max), total: text.length, cut: true }
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

/** The words for `ref` from its snapshot line (`button "Save" [ref=e14]`, cut to 120), else `[ref=e14]`. */
export function elementOf(snapshot: string | undefined, ref: string): string {
  const tail = ` [ref=${ref}]`
  if (snapshot === undefined || !REF.test(ref)) return tail.trimStart()
  const needle = `[ref=${ref}]`
  for (let at = snapshot.indexOf(needle); at !== -1; at = snapshot.indexOf(needle, at + needle.length)) {
    const start = snapshot.lastIndexOf('\n', at) + 1
    const end = snapshot.indexOf('\n', at)
    const match = ANY.exec(snapshot.slice(start, end === -1 ? snapshot.length : end))
    if (match === null || refOf(match.groups!.attrs) !== ref) continue
    const role = match.groups!.role!
    const name = match.groups!.name
    const room = ELEMENT_MAX - role.length - ' ""'.length - tail.length
    if (name === undefined || room < 2) return `${role}${tail}`
    const words = quoted(nameText(name, match.groups!.q === '\''), room)
    return words === '' ? `${role}${tail}` : `${role} "${words}"${tail}`
  }
  return tail.trimStart()
}
