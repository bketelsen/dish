/**
 * The two small things every refusal in dish-crew does to text it doesn't control: cut a name short, and list names.
 *
 * @module dish-crew/text
 */

/** The longest a name or value from outside is shown in a message, so one bad key can't make a message the size of the file. */
export const SHOWN = 40
/** The most names listed in a message. */
export const LISTED = 12

/** `text`, cut to `length` characters with `…` where it was cut. */
export function truncate(text: string, length = SHOWN): string {
  return text.length > length ? `${text.slice(0, length)}…` : text
}

/**
 * The first `max` of `names`, comma-separated, with `, …` if there are more. No names is `none`, in every message that
 * lists any. A name is shown whole unless `cut` says how long one may be: a model id or a tool name a caller has to
 * copy back mustn't be cut, but a key from a file nobody checked might be anything.
 */
export function listed(names: readonly string[], max = LISTED, cut?: number): string {
  if (names.length === 0) return 'none'
  const head = names.slice(0, max).map(name => cut === undefined ? name : truncate(name, cut)).join(', ')
  return names.length > max ? `${head}, …` : head
}
