/**
 * Telling the lines of one file's patch apart, for the page to colour them. Plain TypeScript with no DOM or React in it,
 * so `node --test` can load it.
 * @module dish-config/client/diff
 */

/**
 * What a line of a patch is.
 * - `meta`: git's header for the file (`diff --git`, `index`, `new file mode`, `---`, `+++`, `Binary files ...`).
 * - `hunk`: an `@@ -1,3 +1,3 @@` marker.
 * - `add`, `remove`, `context`: a line of a hunk.
 * - `note`: git's `\ No newline at end of file`.
 */
export type DiffLineKind = 'meta' | 'hunk' | 'add' | 'remove' | 'context' | 'note'

export interface DiffLine {
  kind: DiffLineKind
  /** The line as git wrote it, marker (`+`, `-`, space) included. */
  text: string
}

/**
 * Classify the lines of git's unified patch for one file.
 *
 * Before the first hunk every line is the file's header, so `--- a/x` and `+++ b/x` are not mistaken for a removed and an
 * added line. Inside a hunk the first character says what a line is, so a removed line that reads `-- rule` (which git
 * writes as `--- rule`) is still a removed line. No line inside a hunk begins with `diff --git `, so that starts a new
 * header whatever came before.
 * @param patch - one file's patch, as the store gives it.
 * @returns one entry per line; the newline that ends the patch is not a line.
 */
export function classifyPatch(patch: string): DiffLine[] {
  if (patch === '') return []
  const lines = patch.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  let inHunk = false
  return lines.map((text): DiffLine => {
    if (text.startsWith('diff --git ')) {
      inHunk = false
      return { kind: 'meta', text }
    }
    if (text.startsWith('@@')) {
      inHunk = true
      return { kind: 'hunk', text }
    }
    if (!inHunk) return { kind: 'meta', text }
    if (text.startsWith('+')) return { kind: 'add', text }
    if (text.startsWith('-')) return { kind: 'remove', text }
    if (text.startsWith('\\')) return { kind: 'note', text }
    return { kind: 'context', text }
  })
}

/** How many lines `lines` adds and removes. */
export function patchTotals(lines: readonly DiffLine[]): { added: number, removed: number } {
  let added = 0
  let removed = 0
  for (const { kind } of lines) {
    if (kind === 'add') added++
    else if (kind === 'remove') removed++
  }
  return { added, removed }
}
