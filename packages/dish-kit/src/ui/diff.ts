/**
 * Patches for the page: telling the lines of one file's patch apart so they can be coloured, and `unifiedDiff`, which
 * builds a patch from two texts. Plain TypeScript with no DOM, React or Node in it, so `node --test` can load it and a
 * plugin's controller can use it.
 * @module dish-kit/ui/diff
 */

/**
 * One file's change, as a unified patch. This is the same shape as dish-config's `FileDiff`, declared here so that
 * dish-kit does not depend on dish-config; dish-config's client checks at compile time that the two stay identical.
 */
export interface FileDiff {
  path: string
  status: 'added' | 'modified' | 'deleted'
  patch: string
}

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

/** Lines of context git writes around a change (`-U3`). */
const CONTEXT = 3

/** git's note for a last line with no newline after it. */
const NO_NEWLINE = '\\ No newline at end of file'

/**
 * The most cells of the table the line diff fills (its two inputs' line counts multiplied, after the lines both texts
 * share at either end are set aside). Past it the texts are too different and too long for an exact diff, and
 * `unifiedDiff` says every remaining line of the old text was replaced by every remaining line of the new. That is
 * still a correct patch, only a longer one.
 */
const MAX_CELLS = 4_000_000

/** A line of the old text (`-`), of the new (`+`), or of both (` `), with its newline if it has one. */
interface Op {
  mark: ' ' | '-' | '+'
  line: string
}

/**
 * A text's lines, each with the newline that ends it. Only the last can lack one, and a line that has it and the same
 * line without it are different lines, as in git.
 */
function splitLines(text: string): string[] {
  return text === '' ? [] : text.split(/(?<=\n)/)
}

/**
 * The line-by-line edit script from `a` to `b`: a longest common subsequence, found by the classic table of suffix
 * lengths. At a mismatch the walk drops the old line first, so a changed block is the old lines removed and then the new
 * ones added, as git writes it.
 */
function diffLines(a: readonly string[], b: readonly string[]): Op[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let aEnd = a.length
  let bEnd = b.length
  while (aEnd > head && bEnd > head && a[aEnd - 1] === b[bEnd - 1]) { aEnd--; bEnd-- }

  const ops: Op[] = []
  for (let i = 0; i < head; i++) ops.push({ mark: ' ', line: a[i]! })
  const n = aEnd - head
  const m = bEnd - head
  if (n > 0 && m > 0 && n * m <= MAX_CELLS) {
    const width = m + 1
    const lcs = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] = a[head + i] === b[head + j]
          ? lcs[(i + 1) * width + j + 1]! + 1
          : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (a[head + i] === b[head + j]) {
        ops.push({ mark: ' ', line: a[head + i]! })
        i++
        j++
      } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
        ops.push({ mark: '-', line: a[head + i]! })
        i++
      } else {
        ops.push({ mark: '+', line: b[head + j]! })
        j++
      }
    }
    for (; i < n; i++) ops.push({ mark: '-', line: a[head + i]! })
    for (; j < m; j++) ops.push({ mark: '+', line: b[head + j]! })
  } else {
    for (let i = head; i < aEnd; i++) ops.push({ mark: '-', line: a[i]! })
    for (let j = head; j < bEnd; j++) ops.push({ mark: '+', line: b[j]! })
  }
  for (let i = aEnd; i < a.length; i++) ops.push({ mark: ' ', line: a[i]! })
  return ops
}

/** One side of a hunk header: `start,length`, with the length left out when it is 1. An empty side starts at the line before. */
function range(before: number, length: number): string {
  const start = length === 0 ? before : before + 1
  return length === 1 ? `${start}` : `${start},${length}`
}

/**
 * A unified patch from `before` to `after`, as git writes one: `--- a/<path>` and `+++ b/<path>`, then hunks of
 * `@@ -line,count +line,count @@` with three lines of context. Changes that are no more than six lines apart share a hunk,
 * and `\ No newline at end of file` follows a last line that has no newline. It is the part of `git diff -U3` after the
 * `diff --git` and `index` lines, which this leaves out, and with no section heading after the `@@`s. The headers are
 * `a/` and `b/` for an added or deleted file too (git writes `/dev/null` there), so the file's name is always in them.
 * `classifyPatch` and the page's `DiffView` read it like a patch from the store.
 *
 * The diff is a longest common subsequence of the two texts' lines, so it is as short as a line diff can be. Which of
 * several equally short diffs it picks can differ from git's, when lines repeat. Texts too long and too different for
 * that (see `MAX_CELLS`) come out as one block removed and one added.
 * @param path - the file's path, for the headers and the result.
 * @param before - the old text; `''` for a file that did not exist.
 * @param after - the new text; `''` for a file that is gone.
 * @returns `added` when `before` is `''`, `deleted` when `after` is, else `modified`; `patch` is `''` when the texts are
 * the same (and the status is then `modified`: nothing was added or deleted).
 */
export function unifiedDiff(path: string, before: string, after: string): FileDiff {
  if (before === after) return { path, status: 'modified', patch: '' }
  const status = before === '' ? 'added' : after === '' ? 'deleted' : 'modified'
  const ops = diffLines(splitLines(before), splitLines(after))

  // The old and new line numbers each op sits at, counted before it.
  const oldBefore: number[] = []
  const newBefore: number[] = []
  let oldCount = 0
  let newCount = 0
  const changed: number[] = []
  ops.forEach((op, index) => {
    oldBefore.push(oldCount)
    newBefore.push(newCount)
    if (op.mark !== '+') oldCount++
    if (op.mark !== '-') newCount++
    if (op.mark !== ' ') changed.push(index)
  })
  oldBefore.push(oldCount)
  newBefore.push(newCount)

  // Runs of changes: one run goes on while the lines between two changes are no more than both sides' context.
  const runs: Array<[first: number, last: number]> = []
  for (const index of changed) {
    const run = runs[runs.length - 1]
    if (run !== undefined && index - run[1] - 1 <= 2 * CONTEXT) run[1] = index
    else runs.push([index, index])
  }

  let patch = `--- a/${path}\n+++ b/${path}\n`
  for (const [first, last] of runs) {
    const from = Math.max(0, first - CONTEXT)
    const to = Math.min(ops.length, last + 1 + CONTEXT)
    patch += `@@ -${range(oldBefore[from]!, oldBefore[to]! - oldBefore[from]!)} +${range(newBefore[from]!, newBefore[to]! - newBefore[from]!)} @@\n`
    for (let index = from; index < to; index++) {
      const { mark, line } = ops[index]!
      patch += line.endsWith('\n') ? `${mark}${line}` : `${mark}${line}\n${NO_NEWLINE}\n`
    }
  }
  return { path, status, patch }
}
