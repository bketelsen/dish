/**
 * Taking a secret out of a text, for what a failure says: the masks of dish-kit know the shapes of tokens and PEM blocks, and
 * not the App's ID or the lines of its key. This imports nothing, so the server (`service.ts`, for GitHub's error text) and the
 * browser (`client/input.ts`, for dsh's) use the one copy.
 * @module dish-workspaces/hiding
 */

/** A secret shorter than this is left in a text: it can't be told from other text, and would turn every match into noise. */
const SHORTEST_WHOLE = 4

/** A line of a longer secret (a PEM's body) shorter than this is left, for the same reason. */
const SHORTEST_LINE = 16

/**
 * A function that takes each of `secrets` out of a text, in every form it can take there (as it is, JSON-escaped,
 * URL-encoded), and each long line of it too, replacing it with `…`. The longest piece goes first, so a whole key is taken out
 * before its lines.
 * @param secrets - the values to hide. Blank ones, and ones too short to tell from other text, are ignored.
 */
export function hiding(secrets: readonly string[]): (text: string) => string {
  const pieces = new Set<string>()
  const add = (value: string, shortest: number): void => {
    const plain = value.trim()
    if (plain.length < shortest) return
    for (const form of [plain, JSON.stringify(plain).slice(1, -1), encodeURIComponent(plain)]) pieces.add(form)
  }
  for (const secret of secrets) {
    add(secret, SHORTEST_WHOLE)
    for (const line of secret.split(/\r?\n/)) add(line, SHORTEST_LINE)
  }
  const ordered = [...pieces].sort((a, b) => b.length - a.length)
  return text => ordered.reduce((hidden, piece) => hidden.split(piece).join('…'), text)
}
