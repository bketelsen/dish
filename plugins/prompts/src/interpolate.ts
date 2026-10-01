/**
 * Lenient `{{variable}}` interpolation for persona text.
 *
 * dsh renders a section with a strict interpolator that throws on a malformed, unknown or valueless reference, and
 * that would fail the agent's step. A prompt that anyone can edit must never do that, so this one follows dsh's
 * grammar exactly and, where dsh would throw, leaves the text as written:
 *
 * - a group is a complete `{{...}}` with no braces inside, and a variable name is `[a-z][a-z0-9_]*`;
 * - a group with a name that has a value is replaced, and the value is not scanned again;
 * - a group with a name that has no value (unknown, or known but `undefined`) stays as written, and its name is
 *   reported in `unknown`;
 * - a malformed group (`{{ model }}`, `{{Model}}`, `{{}}`, `{{{model}}`) stays as written, and is not reported: it is
 *   not a reference to anything. dsh throws for it, when a `}}` comes later in the text;
 * - a `{{` that nothing closes is literal text. dsh agrees.
 *
 * So a group dsh would accept is exactly a group replaced here.
 *
 * @module dish-prompts/interpolate
 */

/** dsh's `VARIABLE_NAME`: how a variable is written between the braces. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
/** dsh's `GROUP_AT`, as a sticky pattern: a complete `{{...}}` group at `lastIndex`. */
const GROUP_AT = /\{\{([^{}]*)\}\}/y

/** What interpolation made of a text. */
export interface Interpolated {
  /** The text, with each group that has a value replaced by it. */
  text: string
  /** Each well-formed name left as written because it has no value, once, in order of first appearance. */
  unknown: string[]
}

/**
 * Replace the `{{name}}` groups of `text` that have a value in `variables`, and leave all else as written.
 *
 * A name has a value if it is an own property of `variables` that is not `undefined`; names a plain object inherits
 * (`constructor`) have none.
 * @param text - the text to interpolate.
 * @param variables - the values by name. An `undefined` value is no value.
 */
export function interpolate(text: string, variables: Readonly<Record<string, string | undefined>>): Interpolated {
  const unknown = new Set<string>()
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    GROUP_AT.lastIndex = open
    const group = GROUP_AT.exec(text)
    const name = group?.[1]
    if (group === null || name === undefined || !VARIABLE_NAME.test(name)) {
      // Unclosed, or closed but malformed. Keep the `{{` and go on after it, as dsh does for an unclosed one.
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const end = open + group[0].length
    const value = Object.hasOwn(variables, name) ? variables[name] : undefined
    if (value === undefined) {
      unknown.add(name)
      result += text.slice(last, end)
    } else {
      result += text.slice(last, open) + value
    }
    last = end
  }
  return { text: result + text.slice(last), unknown: [...unknown] }
}
