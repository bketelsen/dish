/**
 * The shared diff helpers: how a patch's lines are told apart (moved here from dish-config's History page, unchanged),
 * and `unifiedDiff`, which builds the same kind of patch from two texts. `unifiedDiff` is checked against hand-written
 * patches, against git itself (`git diff --no-index`), and, for texts with repeated lines (where git may legitimately
 * pick another, equally short diff), by applying its patch and checking the result.
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { classifyPatch, patchTotals, unifiedDiff } from '../src/ui/diff.ts'
import type { FileDiff } from '../src/ui/diff.ts'
import { DIFF_CSS } from '../src/ui/styles.ts'

const PATCH = [
  'diff --git a/prompts/a.md b/prompts/a.md',
  'index 1111111..2222222 100644',
  '--- a/prompts/a.md',
  '+++ b/prompts/a.md',
  '@@ -1,3 +1,3 @@ heading',
  ' keep',
  '-old',
  '+new',
  ' tail',
  '',
].join('\n')

test('classifyPatch tells headers, hunk markers, added, removed and context lines apart', () => {
  const lines = classifyPatch(PATCH)
  assert.deepEqual(lines.map(line => line.kind), [
    'meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'remove', 'add', 'context',
  ])
  assert.equal(lines[4]!.text, '@@ -1,3 +1,3 @@ heading')
  assert.equal(lines[6]!.text, '-old', 'a line keeps its marker')
  assert.equal(lines[7]!.text, '+new')
})

test('classifyPatch: the trailing newline is not a line of its own', () => {
  assert.equal(classifyPatch('diff --git a/x b/x\n').length, 1)
  assert.deepEqual(classifyPatch(''), [])
})

test('classifyPatch: inside a hunk a line starting with --- or +++ is a removed or added line, not a header', () => {
  const lines = classifyPatch([
    'diff --git a/x.md b/x.md',
    '--- a/x.md',
    '+++ b/x.md',
    '@@ -1,2 +1,2 @@',
    '--- a rule',
    '+++ a heading',
    '',
  ].join('\n'))
  assert.deepEqual(lines.map(line => line.kind), ['meta', 'meta', 'meta', 'hunk', 'remove', 'add'])
})

test('classifyPatch: "no newline" notes and empty context lines', () => {
  const lines = classifyPatch([
    'diff --git a/x b/x',
    '@@ -1 +1 @@',
    '-a',
    '\\ No newline at end of file',
    '+b',
    '',
    ' c',
    '',
  ].join('\n'))
  assert.deepEqual(lines.map(line => line.kind), ['meta', 'hunk', 'remove', 'note', 'add', 'context', 'context'])
})

test('classifyPatch: several hunks, and a binary file or a new empty file with no hunk at all', () => {
  const several = classifyPatch([
    'diff --git a/x b/x',
    '@@ -1 +1 @@',
    '-a',
    '+b',
    '@@ -9 +9 @@',
    '-y',
    '+z',
    '',
  ].join('\n'))
  assert.deepEqual(several.map(line => line.kind), ['meta', 'hunk', 'remove', 'add', 'hunk', 'remove', 'add'])

  const none = classifyPatch('diff --git a/e b/e\nnew file mode 100644\nindex 0000000..e69de29\n')
  assert.deepEqual(none.map(line => line.kind), ['meta', 'meta', 'meta'])
})

test('patchTotals counts the added and removed lines, and not the headers', () => {
  assert.deepEqual(patchTotals(classifyPatch(PATCH)), { added: 1, removed: 1 })
  assert.deepEqual(patchTotals([]), { added: 0, removed: 0 })
})

// ---- unifiedDiff ------------------------------------------------------------------------------------------------------

const P = 'prompts/x.md'
const HEAD = `--- a/${P}\n+++ b/${P}\n`

/** `n` distinct lines, `l1` ... `ln`, each ending in a newline. */
function numbered(n: number, change: Record<number, string | null> = {}): string {
  let text = ''
  for (let i = 1; i <= n; i++) {
    const line = i in change ? change[i] : `l${i}`
    if (line !== null && line !== undefined) text += `${line}\n`
  }
  return text
}

test('unifiedDiff: an added line', () => {
  assert.deepEqual(unifiedDiff(P, 'a\nb\n', 'a\nb\nc\n'), {
    path: P,
    status: 'modified',
    patch: `${HEAD}@@ -1,2 +1,3 @@\n a\n b\n+c\n`,
  })
})

test('unifiedDiff: a removed line', () => {
  assert.equal(unifiedDiff(P, 'a\nb\nc\n', 'a\nc\n').patch, `${HEAD}@@ -1,3 +1,2 @@\n a\n-b\n c\n`)
})

test('unifiedDiff: a changed line is the old line removed, then the new one added', () => {
  assert.equal(unifiedDiff(P, 'a\nb\nc\n', 'a\nB\nc\n').patch, `${HEAD}@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n`)
})

test('unifiedDiff: three lines of context, and a single-line side is written without a count', () => {
  const before = numbered(20)
  const after = numbered(20, { 10: 'ten' })
  assert.equal(
    unifiedDiff(P, before, after).patch,
    `${HEAD}@@ -7,7 +7,7 @@\n l7\n l8\n l9\n-l10\n+ten\n l11\n l12\n l13\n`,
  )
  assert.equal(unifiedDiff(P, 'a\n', 'b\n').patch, `${HEAD}@@ -1 +1 @@\n-a\n+b\n`)
})

test('unifiedDiff: two changes far apart are two hunks', () => {
  const patch = unifiedDiff(P, numbered(20), numbered(20, { 2: 'two', 18: 'eighteen' })).patch
  assert.equal(patch, [
    `${HEAD}@@ -1,5 +1,5 @@`,
    ' l1', '-l2', '+two', ' l3', ' l4', ' l5',
    '@@ -15,6 +15,6 @@',
    ' l15', ' l16', ' l17', '-l18', '+eighteen', ' l19', ' l20',
    '',
  ].join('\n'))
})

test('unifiedDiff: changes six lines apart are one hunk, seven lines apart are two', () => {
  // Lines 5 and 12 changed: l6..l11 are the six lines between them.
  const six = unifiedDiff(P, numbered(16), numbered(16, { 5: 'five', 12: 'twelve' })).patch
  assert.equal(classifyPatch(six).filter(line => line.kind === 'hunk').length, 1)
  assert.equal(six.split('\n')[2], '@@ -2,14 +2,14 @@')
  // Lines 5 and 13 changed: seven lines between them.
  const seven = unifiedDiff(P, numbered(17), numbered(17, { 5: 'five', 13: 'thirteen' })).patch
  assert.deepEqual(
    classifyPatch(seven).filter(line => line.kind === 'hunk').map(line => line.text),
    ['@@ -2,7 +2,7 @@', '@@ -10,7 +10,7 @@'],
  )
})

test('unifiedDiff: identical texts give an empty patch', () => {
  assert.deepEqual(unifiedDiff(P, 'a\nb\n', 'a\nb\n'), { path: P, status: 'modified', patch: '' })
  assert.deepEqual(unifiedDiff(P, '', ''), { path: P, status: 'modified', patch: '' }, 'two empty texts: nothing was added or deleted')
  assert.deepEqual(unifiedDiff(P, 'no newline', 'no newline'), { path: P, status: 'modified', patch: '' })
})

test('unifiedDiff: an empty before is an add, an empty after is a delete', () => {
  assert.deepEqual(unifiedDiff(P, '', 'a\nb\n'), { path: P, status: 'added', patch: `${HEAD}@@ -0,0 +1,2 @@\n+a\n+b\n` })
  assert.deepEqual(unifiedDiff(P, 'a\nb\n', ''), { path: P, status: 'deleted', patch: `${HEAD}@@ -1,2 +0,0 @@\n-a\n-b\n` })
  assert.deepEqual(unifiedDiff(P, '', 'a'), {
    path: P,
    status: 'added',
    patch: `${HEAD}@@ -0,0 +1 @@\n+a\n\\ No newline at end of file\n`,
  })
  assert.equal(unifiedDiff(P, 'a', '').patch, `${HEAD}@@ -1 +0,0 @@\n-a\n\\ No newline at end of file\n`)
})

test('unifiedDiff: a missing final newline gets git\'s note, on the side that lacks it', () => {
  const note = '\\ No newline at end of file'
  assert.equal(unifiedDiff(P, 'a\nb', 'a\nb\n').patch, `${HEAD}@@ -1,2 +1,2 @@\n a\n-b\n${note}\n+b\n`)
  assert.equal(unifiedDiff(P, 'a\nb\n', 'a\nb').patch, `${HEAD}@@ -1,2 +1,2 @@\n a\n-b\n+b\n${note}\n`)
  assert.equal(unifiedDiff(P, 'a\nb', 'a\nc').patch, `${HEAD}@@ -1,2 +1,2 @@\n a\n-b\n${note}\n+c\n${note}\n`)
  // Both lack it and the last line is unchanged: it is context, and the note follows it.
  assert.equal(unifiedDiff(P, 'x\nb', 'y\nb').patch, `${HEAD}@@ -1,2 +1,2 @@\n-x\n+y\n b\n${note}\n`)
})

test('unifiedDiff: lines that begin with the diff markers, and blank lines, are plain lines', () => {
  assert.equal(
    unifiedDiff(P, 'a\n\n-- rule\n++ x\n', 'a\n\n--- rule\n++ y\n').patch,
    `${HEAD}@@ -1,4 +1,4 @@\n a\n \n--- rule\n-++ x\n+--- rule\n+++ y\n`,
  )
})

test('unifiedDiff: carriage returns are part of the line, so a CRLF change shows', () => {
  assert.equal(unifiedDiff(P, 'a\r\nb\r\n', 'a\r\nb\n').patch, `${HEAD}@@ -1,2 +1,2 @@\n a\r\n-b\r\n+b\n`)
})

test('unifiedDiff: its output classifies like a store diff, and the totals add up', () => {
  const { patch } = unifiedDiff(P, 'a\nb\nc\n', 'a\nB\nc\nd')
  const lines = classifyPatch(patch)
  assert.deepEqual(lines.map(line => line.kind), [
    'meta', 'meta', 'hunk', 'context', 'remove', 'add', 'context', 'add', 'note',
  ])
  assert.deepEqual(patchTotals(lines), { added: 2, removed: 1 })
  assert.deepEqual(classifyPatch(unifiedDiff(P, '', 'x\n').patch).map(line => line.kind), ['meta', 'meta', 'hunk', 'add'])
  assert.deepEqual(classifyPatch(unifiedDiff(P, 'x\n', 'x\n').patch), [], 'no changes: no lines')
  // A removed line that reads "-- rule" is written "--- rule" and is still a removed line, never a header.
  const dashes = classifyPatch(unifiedDiff(P, '-- rule\n', '++ rule\n').patch)
  assert.deepEqual(dashes.map(line => line.kind), ['meta', 'meta', 'hunk', 'remove', 'add'])
  assert.deepEqual(dashes.slice(3).map(line => line.text), ['--- rule', '+++ rule'])
})

test('unifiedDiff: status is added, deleted or modified; a FileDiff has exactly path, status and patch', () => {
  const diff: FileDiff = unifiedDiff('p', 'a\n', 'b\n')
  assert.deepEqual(Object.keys(diff).sort(), ['patch', 'path', 'status'])
  assert.equal(unifiedDiff('p', '', 'b\n').status, 'added')
  assert.equal(unifiedDiff('p', 'a\n', '').status, 'deleted')
  assert.equal(unifiedDiff('p', 'a\n', 'b\n').status, 'modified')
})

/** A patch, applied to `before`: the text it produces, or an Error saying how the patch fails to fit. */
function applyPatch(before: string, patch: string): string {
  if (patch === '') return before
  const rows = patch.split('\n')
  assert.equal(rows.pop(), '', 'a patch ends with a newline')
  assert.equal(rows[0]!.startsWith('--- a/'), true)
  assert.equal(rows[1]!.startsWith('+++ b/'), true)
  // A line with its newline, so that a missing final newline is part of what has to match.
  const old = before === '' ? [] : before.split(/(?<=\n)/)
  const out: string[] = []
  let at = 0
  let i = 2
  let last: 'old' | 'new' | 'both' | undefined
  while (i < rows.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@$/.exec(rows[i]!)
    assert.ok(header, `a hunk header at row ${i}: ${rows[i]}`)
    const oldCount = header[2] === undefined ? 1 : Number(header[2])
    const newCount = header[4] === undefined ? 1 : Number(header[4])
    const start = oldCount === 0 ? Number(header[1]) : Number(header[1]) - 1
    assert.ok(start >= at, 'hunks are in order and do not overlap')
    while (at < start) out.push(old[at++]!)
    let seenOld = 0
    let seenNew = 0
    i++
    for (; i < rows.length && !rows[i]!.startsWith('@@'); i++) {
      const row = rows[i]!
      if (row.startsWith('\\')) {
        assert.equal(row, '\\ No newline at end of file')
        assert.ok(last, 'a note follows a line')
        if (last !== 'new') assert.equal(old[at - 1]!.endsWith('\n'), false, 'the old line really has no newline')
        if (last !== 'old') out[out.length - 1] = out[out.length - 1]!.replace(/\n$/, '')
        continue
      }
      const text = row.slice(1)
      if (row[0] === ' ' || row[0] === '-') {
        const line = old[at++]
        assert.ok(line !== undefined, 'the patch does not run past the end of the old text')
        // The old line may lack its newline; a following note says so, so compare without it.
        assert.equal(line.replace(/\n$/, ''), text, `old line ${at} is what the patch says`)
        assert.equal(line.endsWith('\n') || rows[i + 1] === '\\ No newline at end of file', true, 'a line with no newline has the note')
        seenOld++
        if (row[0] === ' ') { out.push(line); seenNew++; last = 'both' } else last = 'old'
      } else {
        assert.equal(row[0], '+')
        out.push(`${text}\n`)
        seenNew++
        last = 'new'
      }
    }
    assert.equal(seenOld, oldCount, 'the hunk header counts the old lines')
    assert.equal(seenNew, newCount, 'the hunk header counts the new lines')
  }
  while (at < old.length) out.push(old[at++]!)
  return out.join('')
}

/** Deterministic pseudo-random numbers, so that a failure repeats. */
function random(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 2 ** 32
  }
}

/** The length of the longest common subsequence of two line lists, the simple way. */
function lcsLength(a: readonly string[], b: readonly string[]): number {
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  return table[0]![0]!
}

const linesOf = (text: string): string[] => (text === '' ? [] : text.split(/(?<=\n)/))

test('unifiedDiff: the patch applies to the old text and gives the new one, with no more edits than needed (random texts with repeated lines)', () => {
  const next = random(7)
  for (let round = 0; round < 400; round++) {
    const make = (): string => {
      const count = Math.floor(next() * 14)
      let text = ''
      for (let i = 0; i < count; i++) text += `${'abc'[Math.floor(next() * 3)]}${next() < 0.2 ? ' ' : ''}\n`
      // Sometimes there is no newline at the end.
      return text !== '' && next() < 0.25 ? text.slice(0, -1) : text
    }
    const before = make()
    const after = round % 2 === 0 ? make() : mutate(before, next)
    const diff = unifiedDiff(P, before, after)
    assert.equal(applyPatch(before, diff.patch), after, `round ${round}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}\n${diff.patch}`)
    assert.equal(diff.patch === '', before === after, `round ${round}: empty only when identical`)
    const { added, removed } = patchTotals(classifyPatch(diff.patch))
    const common = lcsLength(linesOf(before), linesOf(after))
    assert.equal(removed, linesOf(before).length - common, `round ${round}: removed lines`)
    assert.equal(added, linesOf(after).length - common, `round ${round}: added lines`)
  }
})

/** `text` with a few lines changed, added or dropped. */
function mutate(text: string, next: () => number): string {
  const lines = linesOf(text)
  const edits = 1 + Math.floor(next() * 3)
  for (let i = 0; i < edits; i++) {
    const at = Math.floor(next() * (lines.length + 1))
    const roll = next()
    if (roll < 0.4) lines.splice(at, 0, `${'abc'[Math.floor(next() * 3)]}\n`)
    else if (roll < 0.7) lines.splice(at, 1)
    else if (at < lines.length) lines[at] = `${'xyz'[Math.floor(next() * 3)]}\n`
  }
  return lines.join('')
}

test('unifiedDiff: texts too big for an exact diff still give a patch that applies', () => {
  const before = numbered(2600).replace(/l/g, 'before ')
  const after = numbered(2600).replace(/l/g, 'after ')
  const { patch } = unifiedDiff(P, before, after)
  assert.equal(applyPatch(before, patch), after)
  assert.deepEqual(patchTotals(classifyPatch(patch)), { added: 2600, removed: 2600 })
  // The lines both texts share at their ends are still context, not part of the change.
  const sandwiched = unifiedDiff(P, `top\n${before}end\n`, `top\n${after}end\n`)
  assert.equal(applyPatch(`top\n${before}end\n`, sandwiched.patch), `top\n${after}end\n`)
  // Half the lines are shared, in the middle: an exact diff would keep them; whatever is done, the patch must apply.
  const shared = (tag: string): string => Array.from({ length: 2600 }, (_, i) => (i % 2 === 0 ? `same ${i}` : `${tag} ${i}`)).join('\n') + '\n'
  assert.equal(applyPatch(shared('old'), unifiedDiff(P, shared('old'), shared('new')).patch), shared('new'))
  assert.equal(sandwiched.patch.split('\n')[2], '@@ -1,2602 +1,2602 @@')
})

// ---- against git ------------------------------------------------------------------------------------------------------

const scratch = mkdtempSync(join(tmpdir(), 'dish-kit-diff-'))
after(() => { rmSync(scratch, { recursive: true, force: true }) })
// The HOME of every git these tests start: a scratch directory, never the runner's.
const home = join(scratch, 'home')
mkdirSync(home)
const git = spawnSync('git', ['--version'], { encoding: 'utf8', env: { PATH: process.env.PATH, HOME: home } })
const hasGit = git.status === 0

/**
 * What git says about the change from `before` to `after`, as the part `unifiedDiff` also writes. git's own header lines
 * are not the same, and are dropped: the `diff --git` and `index` lines `unifiedDiff` leaves out, and `---` and `+++`
 * lines that name the scratch files. A hunk's header may also carry a "section heading" (the last line above the hunk
 * that looks like a function name, which for prose is nearly any line of text); `unifiedDiff` does not write one, so
 * it is cut from git's.
 */
function gitHunks(before: string, after: string): string {
  const dir = mkdtempSync(join(scratch, 'case-'))
  mkdirSync(join(dir, 'a'))
  mkdirSync(join(dir, 'b'))
  writeFileSync(join(dir, 'a', 'f'), before)
  writeFileSync(join(dir, 'b', 'f'), after)
  const run = spawnSync('git', ['diff', '--no-index', '--no-ext-diff', '--no-color', '-U3', '--', 'a/f', 'b/f'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  })
  assert.ok(run.status === 0 || run.status === 1, `git diff failed: ${run.stderr}`)
  const out = run.stdout
  const first = out.indexOf('\n@@')
  if (first < 0) return ''
  return out.slice(first + 1).replace(/^(@@ -[\d,]+ \+[\d,]+ @@).*$/gm, '$1')
}

/** What `unifiedDiff` wrote after its two header lines. */
function ourHunks(before: string, after: string): string {
  const { patch } = unifiedDiff(P, before, after)
  if (patch === '') return ''
  assert.ok(patch.startsWith(HEAD), 'the headers name the path, as a/<path> and b/<path>')
  return patch.slice(HEAD.length)
}

test('unifiedDiff matches git diff -U3 hunk for hunk', { skip: !hasGit && 'git is not available' }, () => {
  const cases: Record<string, [string, string]> = {
    'an added line': ['a\nb\n', 'a\nb\nc\n'],
    'a removed line': ['a\nb\nc\n', 'a\nc\n'],
    'a changed line': ['a\nb\nc\n', 'a\nB\nc\n'],
    'two hunks far apart': [numbered(20), numbered(20, { 2: 'two', 18: 'eighteen' })],
    'a change at the very start': [numbered(12), numbered(12, { 1: 'one' })],
    'a change at the very end': [numbered(12), numbered(12, { 12: 'twelve' })],
    'six lines between changes (one hunk)': [numbered(16), numbered(16, { 5: 'five', 12: 'twelve' })],
    'seven lines between changes (two hunks)': [numbered(17), numbered(17, { 5: 'five', 13: 'thirteen' })],
    'three hunks': [numbered(40), numbered(40, { 3: null, 20: 'twenty', 21: 'twenty-one', 38: 'thirty-eight' })],
    'a block replaced': [numbered(10), numbered(10, { 4: 'x', 5: 'y', 6: null })],
    'every line replaced': ['a\nb\nc\n', 'x\ny\nz\n'],
    'an empty before': ['', 'a\nb\n'],
    'an empty after': ['a\nb\nc\n', ''],
    'an empty before, no final newline': ['', 'a'],
    'an empty after, no final newline': ['a\nb', ''],
    'no final newline gained': ['a\nb', 'a\nb\n'],
    'no final newline lost': ['a\nb\n', 'a\nb'],
    'no final newline on both, last line changed': ['a\nb', 'a\nc'],
    'no final newline on both, last line kept': ['x\nb', 'y\nb'],
    'a single line each': ['a', 'b'],
    'a blank line added': ['a\nb\n', 'a\n\nb\n'],
    'dashes and plus signs': ['a\n-- rule\n++ x\n', 'a\n--- rule\n++ y\n'],
    'identical': ['a\nb\n', 'a\nb\n'],
  }
  for (const [name, [before, after]] of Object.entries(cases)) {
    assert.equal(ourHunks(before, after), gitHunks(before, after), name)
  }
})

test('unifiedDiff matches git diff -U3 on random edits of texts with no repeated lines', { skip: !hasGit && 'git is not available' }, () => {
  // With every line distinct there is one shortest diff, so git and unifiedDiff must agree. (With repeated lines they may
  // pick different, equally short diffs, and git also slides a hunk to a nicer boundary: those are checked by applying.)
  const next = random(11)
  for (let round = 0; round < 60; round++) {
    const count = 1 + Math.floor(next() * 40)
    const lines = Array.from({ length: count }, (_, i) => `line ${i} ${'x'.repeat(Math.floor(next() * 4))}`)
    const edited = [...lines]
    const edits = 1 + Math.floor(next() * 6)
    for (let i = 0; i < edits; i++) {
      const at = Math.floor(next() * (edited.length + 1))
      const roll = next()
      if (roll < 0.35) edited.splice(at, 0, `new ${round}.${i}`)
      else if (roll < 0.65) edited.splice(at, 1)
      else if (at < edited.length) edited[at] = `changed ${round}.${i}`
    }
    const eol = next() < 0.3 ? '' : '\n'
    const before = lines.join('\n') + (lines.length > 0 ? eol : '')
    const after = edited.join('\n') + (edited.length > 0 ? eol : '')
    assert.equal(ourHunks(before, after), gitHunks(before, after), `round ${round}: ${JSON.stringify(before)} -> ${JSON.stringify(after)}`)
  }
})

// ---- the styles -------------------------------------------------------------------------------------------------------

test('the diff styles cover every class DiffView uses, and are named for the diff, not for a page', () => {
  const source = readFileSync(new URL('../src/ui/DiffView.tsx', import.meta.url), 'utf8')
  const used = new Set<string>()
  for (const [, name] of source.matchAll(/\b(dish-diff[\w-]*)/g)) used.add(name!)
  // A context line is the plain `dish-diff-line`; every other kind has a rule of its own.
  for (const kind of ['meta', 'hunk', 'add', 'remove', 'note']) used.add(`dish-diff-line-${kind}`)
  used.delete('dish-diff-line-') // the prefix of the template string the kind is appended to
  assert.ok(used.size >= 8, 'found the classes')
  for (const name of used) assert.ok(DIFF_CSS.includes(`.${name}`), `${name} has a rule`)
  assert.equal(source.includes('dish-history'), false, 'DiffView names nothing of a page')
  assert.equal(DIFF_CSS.includes('dish-history'), false, 'nor do its styles')
})
