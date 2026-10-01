/**
 * Settings back to `judge.yaml`: the page edits `JudgeSettings`, and what is saved is the shipped file with the values
 * replaced. The shipped file (`DEFAULT_TEXT`) is the template, so the keys come in its order and its comments, aligned
 * as it aligns them, are what a person finds in the store and in History.
 *
 * A line of the template that is `key: value  # comment` keeps its indentation, its key and its comment, and gets the new
 * value; a line that isn't one (a section's heading, a comment line, a blank one) is copied as it is. The template is the
 * code's own file, so a line shape it doesn't have is a bug and throws.
 *
 * The text is checked before it is returned: it must pass `parseSettings` and mean what was given. A value this module
 * would write in a way YAML reads as something else (the model `1.13` is a number, a tool called `null` is null) is
 * written in quotes, and if a case slips through, the check throws rather than hand a file that says something different
 * to the store.
 *
 * @module dish-judge/serialize
 */

import { JSON_SCHEMA, load } from 'js-yaml'
import { DEFAULT_TEXT, parseSettings } from './settings.ts'
import type { JudgeSettings, ParseResult } from './settings.ts'

/** `key: value` with an optional trailing comment, at any indentation. A section's heading has no value. */
const KEY_LINE = /^(\s*)([A-Za-z][A-Za-z0-9]*):(?:\s+(\S.*?))?(\s+#.*)?$/

/** What is safe to write bare: no character YAML gives a meaning to, and nothing that starts like a number or a sign. */
const PLAIN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/** `text` as a YAML scalar that loads back as this same string: bare when that is safe, else in double quotes (JSON's, which YAML reads). */
function scalar(text: string): string {
  if (PLAIN.test(text)) {
    try {
      if (load(text, { schema: JSON_SCHEMA }) === text) return text
    } catch {
      // Quoted below.
    }
  }
  return JSON.stringify(text)
}

/** A threshold the way the file writes one: two decimals when two are enough (`0.90`), else as the number reads. */
function threshold(value: number): string {
  return Math.round(value * 100) / 100 === value ? value.toFixed(2) : String(value)
}

function list(items: readonly string[]): string {
  return `[${items.map(scalar).join(', ')}]`
}

/** The values to write, by their path in the file. */
function valuesOf(settings: JudgeSettings): Map<string, string> {
  return new Map([
    ['model', scalar(settings.model)],
    ['timeoutMs', String(settings.timeoutMs)],
    ['commands.readOnly', threshold(settings.commands.readOnly)],
    ['commands.reversible', threshold(settings.commands.reversible)],
    ['commands.servesTask', threshold(settings.commands.servesTask)],
    ['screening.withhold', threshold(settings.screening.withhold)],
    ['screening.warn', threshold(settings.screening.warn)],
    ['screening.chunkChars', String(settings.screening.chunkChars)],
    ['tools.gated', list(settings.tools.gated)],
    ['tools.screened', list(settings.tools.screened)],
  ])
}

/** Whether two settings say the same, key by key, in the order the parser gives them. */
function same(a: JudgeSettings, b: JudgeSettings): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/**
 * `settings` as the text of `judge.yaml`: the shipped file with the values replaced, its comments and its order kept.
 * @param settings - settings that passed `parseSettings`.
 * @param parse - what reads the text back for the check: `parseSettings`. A seam for a test to put a reader that disagrees in its
 *   place, since a bug that would make the check fail can't be had from valid settings.
 * @throws a plain `Error` if the shipped file has a line this can't fill, or the text it made doesn't parse back to `settings`:
 *   both are bugs, and neither can come from what a person typed.
 */
export function serializeSettings(settings: JudgeSettings, parse: (text: string) => ParseResult = parseSettings): string {
  const values = valuesOf(settings)
  const used = new Set<string>()
  let section = ''
  const lines = DEFAULT_TEXT.split('\n').map((line) => {
    const match = KEY_LINE.exec(line)
    if (match === null) return line
    const indent = match[1]!
    const key = match[2]!
    if (match[3] === undefined) {
      // A heading: the keys under it, indented, are its.
      if (indent === '') section = key
      return line
    }
    const path = indent === '' ? key : `${section}.${key}`
    const value = values.get(path)
    if (value === undefined) throw new Error(`the shipped judge.yaml has a setting this can't write: ${path}`)
    used.add(path)
    const head = `${indent}${key}: ${value}`
    const comment = match[4]
    if (comment === undefined) return head
    // The comment stays in the column the shipped file has it in, unless the value is too long for that.
    const from = line.length - comment.trimStart().length
    return head + ' '.repeat(Math.max(2, from - head.length)) + comment.trimStart()
  })
  for (const path of values.keys()) {
    if (!used.has(path)) throw new Error(`the shipped judge.yaml has no line for ${path}`)
  }
  const text = lines.join('\n')
  const back = parse(text)
  if (!back.ok) throw new Error(`the settings were written as a judge.yaml that is not valid (${back.problem}); this is a bug`)
  if (!same(back.settings, settings)) throw new Error('the settings were written as a judge.yaml that says something else; this is a bug')
  return text
}
