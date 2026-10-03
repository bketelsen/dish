import { createHash } from 'node:crypto'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { computePrevious, readPrevious } from 'dish-kit'
import { DEFAULTS, PREVIOUS, defaultText, defaultsByPath, replaceMap } from '../src/defaults.ts'
import { SHIPPED_ROLES, SKILL_FILE, checkSkill, nameFor, offeredTo, parseSkill, pathFor } from '../src/skill.ts'

const DIRECTORY = new URL('../defaults/', import.meta.url)

/** The shipped skills and their roles: docs/specs/skills.md, "Shipped skills". */
const SPEC: Record<string, readonly string[]> = {
  'brainstorming': ['main'],
  'writing-specs': ['architect', 'main'],
  'writing-plans': ['architect', 'main'],
  'subagent-driven-development': ['main'],
  'executing-plans': ['main'],
  'dispatching-parallel-agents': ['main'],
  'requesting-code-review': ['main'],
  'receiving-code-review': ['main', 'coder', 'architect', 'ops', 'writer'],
  'reviewing-work': ['reviewer'],
  'test-driven-development': ['coder', 'main'],
  'systematic-debugging': ['coder', 'ops', 'main'],
  'verification-before-completion': SHIPPED_ROLES,
  'using-git-worktrees': ['main', 'coder'],
  'finishing-a-development-branch': ['main'],
  'writing-skills': ['main'],
  'researching': ['researcher'],
  'writing-for-readers': ['writer'],
  'changing-infrastructure': ['ops'],
}

const sorted = (names: readonly string[]): string[] => [...names].sort()

test('the shipped skills are exactly the spec\'s eighteen', () => {
  assert.equal(Object.keys(SPEC).length, 18)
  assert.deepEqual(Object.keys(DEFAULTS).sort(), Object.keys(SPEC).sort())
})

test('every shipped skill is a valid skill, with no warnings, and says what the spec says', () => {
  for (const [name, text] of Object.entries(DEFAULTS)) {
    const path = pathFor(name)
    const check = checkSkill(path, text, SHIPPED_ROLES)
    assert.deepEqual(check.problems, [], `${path} has a problem`)
    assert.deepEqual(check.warnings, [], `${path} has a warning`)
    assert.ok(check.skill, path)
    assert.equal(check.skill.name, name)
    assert.deepEqual(sorted(check.skill.roles ?? []), sorted(SPEC[name] ?? []), `the roles of ${name} are not the spec's`)
    assert.equal(check.skill.roles?.length, new Set(check.skill.roles).size, `${name} names a role twice`)
  }
})

test('every shipped role has at least one skill', () => {
  for (const role of SHIPPED_ROLES) {
    const offered = Object.entries(DEFAULTS).filter(([name, text]) => {
      const result = parseSkill(pathFor(name), text)
      return result.ok && offeredTo(result.skill, role)
    })
    assert.ok(offered.length > 0, `no shipped skill is offered to ${role}`)
  }
})

test('verification-before-completion is offered to every role', () => {
  const result = parseSkill(pathFor('verification-before-completion'), DEFAULTS['verification-before-completion']!)
  assert.ok(result.ok)
  for (const role of SHIPPED_ROLES) assert.ok(offeredTo(result.skill, role), role)
})

test('DEFAULTS is every defaults/<name>/SKILL.md, exactly as it is on disk', () => {
  const directories = readdirSync(DIRECTORY, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)
  assert.deepEqual(Object.keys(DEFAULTS).sort(), directories.sort())
  for (const name of directories) {
    assert.equal(DEFAULTS[name], readFileSync(new URL(`${name}/${SKILL_FILE}`, DIRECTORY), 'utf8'), name)
  }
})

test('NOTICE.md and previous.json are not skills', () => {
  const files = readdirSync(DIRECTORY, { withFileTypes: true }).filter(entry => entry.isFile()).map(entry => entry.name)
  assert.ok(files.includes('NOTICE.md'))
  assert.ok(files.includes('previous.json'))
  for (const name of ['NOTICE.md', 'NOTICE', 'previous.json', 'previous']) assert.equal(DEFAULTS[name], undefined, name)
  assert.equal(nameFor('skills/NOTICE.md'), undefined)
  assert.equal(parseSkill('skills/notice/SKILL.md', readFileSync(new URL('NOTICE.md', DIRECTORY), 'utf8')).ok, false)
})

test('DEFAULTS has no prototype, so a name like constructor is not a default, and cannot be changed', () => {
  assert.equal(Object.getPrototypeOf(DEFAULTS), null)
  assert.equal(defaultText('constructor'), undefined)
  assert.equal(defaultText('toString'), undefined)
  assert.equal(defaultText('no-such-skill'), undefined)
  assert.ok(Object.isFrozen(DEFAULTS))
})

test('defaultText gives the text of a shipped skill', () => {
  for (const name of Object.keys(SPEC)) assert.equal(defaultText(name), DEFAULTS[name], name)
})

test('defaultsByPath is the shipped texts by their path in the store', () => {
  const byPath = defaultsByPath()
  assert.deepEqual(Object.keys(byPath).sort(), Object.keys(SPEC).map(pathFor).sort())
  for (const name of Object.keys(SPEC)) assert.equal(byPath[pathFor(name)], DEFAULTS[name], name)
  // A new object each time: seed takes it, and nobody else may change what the next caller gets.
  assert.notEqual(defaultsByPath(), byPath)
})

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

/** The skills whose shipped text moved to the `worktree` tool (docs/specs/projects-workspaces.md, "The shipped skills"). */
const WORKTREE_SKILLS = ['finishing-a-development-branch', 'subagent-driven-development', 'using-git-worktrees']

/** The other skills whose shipped text changed in step 7, for runs, `report` and `open_pr` (docs/specs/orchestrator.md, "Prompts and skills"). */
const STEP7_SKILLS = ['executing-plans', 'requesting-code-review', 'reviewing-work', 'test-driven-development', 'verification-before-completion', 'receiving-code-review', 'systematic-debugging', 'changing-infrastructure']

test('PREVIOUS lists the earlier texts of exactly the skills whose shipped text changed', () => {
  const changed = [...WORKTREE_SKILLS, ...STEP7_SKILLS]
  assert.deepEqual(Object.keys(PREVIOUS).sort(), changed.map(pathFor).sort())
  for (const name of changed) {
    const hashes = PREVIOUS[pathFor(name)]!
    assert.ok(hashes.length > 0, name)
    // The shipped text is never its own predecessor, or an unedited copy would be "upgraded" to itself forever.
    assert.ok(!hashes.includes(sha256(DEFAULTS[name]!)), name)
  }
  assert.ok(Object.isFrozen(PREVIOUS))
})

test('the worktree skills use the worktree tool in a registered project and keep git for any other repo', () => {
  const using = DEFAULTS['using-git-worktrees']!
  // The tool's actions, its answer, delegate's input, and the way setup is handed on.
  assert.match(using, /`worktree`/)
  assert.match(using, /action `create`/)
  assert.match(using, /`base`/)
  assert.match(using, /`dish\/<slug>`/)
  assert.match(using, /`delegate`'s `worktree`/)
  assert.match(using, /`remove`/)
  assert.match(using, /setup/)
  // A repo that isn't a registered project keeps the git steps, and a coder doesn't have the tool.
  assert.match(using, /git worktree add/)
  assert.match(using, /A crew child's working directory is the main agent's/)
  assert.match(using, /coder.*(?:don't|doesn't|never) have/s)
  assert.match(using, /ask the main agent with `send_message`/)
  // `force` throws work away, and `remove` deletes the branch dish/<slug>: only for a clean tree on that branch whose
  // commits are on another one (git cherry from HEAD), or a discard the user asked for.
  assert.match(using, /`force`.*`git -C <path> status --short` is empty, `git -C <path> branch --show-current` prints `dish\/<slug>`, and `git -C <path> cherry <plan branch>` \(the branch its work belongs on\) lists no `\+` line.*discard/s)

  const driven = DEFAULTS['subagent-driven-development']!
  assert.match(driven, /`worktree`.*`create`/s)
  assert.match(driven, /`base`/)
  assert.match(driven, /`delegate`.*`worktree`|`worktree`.*`delegate`/s)
  assert.match(driven, /`remove`.*`force`|`force`.*`remove`/s)
  assert.doesNotMatch(driven, /git worktree/)
  assert.match(driven, /`force` only when `git -C <path> status --short` is empty, `git -C <path> branch --show-current` prints `dish\/<slug>`, and `git -C <path> cherry <plan branch>` lists no `\+` line/)
  assert.match(driven, /a cherry-picked one never is/)
  assert.match(driven, /fresh coder in a new worktree from the plan branch, bound with `delegate`'s `worktree`/)

  const finishing = DEFAULTS['finishing-a-development-branch']!
  assert.match(finishing, /`worktree` action `remove`, never `git worktree remove`/)
  assert.match(finishing, /`git -C <path> status --short` is empty, `git -C <path> branch --show-current` prints `dish\/<slug>`, and `git -C <path> cherry <plan branch>` lists no `\+` line.*set `force`/s)
  assert.match(finishing, /usually isn't merged there, and a cherry-picked one never is/)
  assert.match(finishing, /`force` it only when the user says to discard it/)
  assert.match(finishing, /through a coder in a new worktree from the plan branch, bound with `delegate`'s `worktree`/)
  // Agents' git is read-only in a registered project: no push, no hunting for other credentials.
  assert.match(finishing, /In a registered project \(.*\), never `git push` or `gh pr create`: agents' git there is read-only by design, and only `open_pr` pushes/)
  // One checkable test for "a registered project" (every top-level agent has the worktree tool whenever dish-workspaces is loaded).
  for (const text of [using, driven, finishing]) {
    assert.match(text, /your chat's workspace is a clone dish set up: `git config --get-regexp '\^credential\\\..\*\\\.helper\$'` names `git-credential-dish`/)
  }
  assert.doesNotMatch(finishing, /you have the `worktree` tool/)
  assert.doesNotMatch(using, /and you have the `worktree` tool\)/)
  assert.match(finishing, /never look for other credentials/)
  // Git's own remove stays for a worktree dish didn't make, never forced.
  assert.match(finishing, /plain git.*`git worktree remove`, never `--force`/s)
})

/** The section of `text` under the heading line `heading`, up to the next heading of the same level or above. */
function section(text: string, heading: string): string {
  const lines = text.split('\n')
  const start = lines.indexOf(heading)
  assert.ok(start >= 0, `no "${heading}" section`)
  const level = /^#+/.exec(heading)![0].length
  const end = lines.findIndex((line, index) => index > start && /^#+ /.test(line) && /^#+/.exec(line)![0].length <= level)
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

/** The sentences of `text`: split at line breaks, and after a `.`, `!` or `?` that ends one. */
function sentences(text: string): string[] {
  return text.split(/\n+|(?<=[.!?])\s+/).filter(sentence => sentence.trim() !== '')
}

/** How many times `pattern` (global) matches `text`. */
function count(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

test('the pipeline skills use the run, report and open_pr (step 7)', () => {
  const driven = DEFAULTS['subagent-driven-development']!
  for (const pattern of [/`run` with action `open`/, /action `status`/, /`final: true`/, /`delegate`'s `ruling`/, /`report`/, /`notFixed`/, /review feedback/]) {
    assert.match(driven, pattern)
  }

  // Outside a registered project there is no run: the ledger file is kept there, and only there.
  const executing = DEFAULTS['executing-plans']!
  const file = '.worktrees/<plan file name>-ledger.md'
  const lines = driven.split('\n').filter(line => line.includes(file))
  assert.equal(lines.length, 1, 'driven names the ledger file on one line')
  assert.match(lines[0]!, /^\s*- \*\*Elsewhere\*\*/, 'the ledger file is the Elsewhere line\'s')
  assert.equal(count(driven, new RegExp(file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')), 1)
  assert.doesNotMatch(driven.split('\n').filter(line => !line.includes(file)).join('\n'), /ledger\.md/)
  assert.doesNotMatch(executing, /ledger\.md/)

  const finishing = DEFAULTS['finishing-a-development-branch']!
  for (const pattern of [/`open_pr`/, /`gateRuling` or `reviewRuling`/, /never look for other credentials/]) assert.match(finishing, pattern)
  const feedback = section(finishing, '## Review feedback on the pull request')
  for (const pattern of [/`pr_feedback`/, /action `resume` with its id/, /`origin\/dish\/<slug>`/, /Never rebase, amend or squash/, /`reviewRuling`/]) {
    assert.match(feedback, pattern)
  }
  assert.doesNotMatch(finishing, /push the branch/i)
  assert.doesNotMatch(finishing, /a new run, with `base`/)

  const using = DEFAULTS['using-git-worktrees']!
  assert.match(using, /`run` action `open`/)
  assert.match(using, /`run` action `goal`/)

  const requesting = DEFAULTS['requesting-code-review']!
  for (const pattern of [/`final: true`/, /`report`/, /`should_fix`/]) assert.match(requesting, pattern)
  assert.doesNotMatch(requesting, /ADDRESSED/)

  const reviewing = DEFAULTS['reviewing-work']!
  for (const pattern of [/Finish by calling `report`/, /`verdict`/, /`head`/, /`addressed`/]) assert.match(reviewing, pattern)
  assert.doesNotMatch(reviewing, /ADDRESSED/)
})

test('the coder\'s skills leave the gate to dish when the brief says so', () => {
  for (const name of ['test-driven-development', 'verification-before-completion', 'receiving-code-review', 'systematic-debugging']) {
    assert.match(DEFAULTS[name]!, /dish runs it when you `report` `done`/, name)
  }
})

test('no shipped skill tells an agent to push', () => {
  const having: string[] = []
  for (const [name, text] of Object.entries(DEFAULTS)) {
    const never = count(text, /never `git push` or `gh pr create`/g)
    assert.equal(count(text, /`git push`/g), never, `${name} names \`git push\` outside "never \`git push\` or \`gh pr create\`"`)
    assert.equal(count(text, /gh pr create/g), never, `${name} names gh pr create outside "never \`git push\` or \`gh pr create\`"`)
    if (never > 0) having.push(name)
  }
  assert.deepEqual(having, ['finishing-a-development-branch'])
  assert.equal(count(DEFAULTS['finishing-a-development-branch']!, /never `git push` or `gh pr create`/g), 1)
})

test('no shipped skill tells an agent to rebase: each rebase, amend or squash is in a sentence that says never', () => {
  // The prompts' side is plugins/prompts/test/pipeline-texts.test.ts: common.md and main.md say it too.
  const having: string[] = []
  for (const [name, text] of Object.entries(DEFAULTS)) {
    const found = sentences(text).filter(sentence => /\b(rebase|amend|squash)/i.test(sentence))
    for (const sentence of found) assert.match(sentence, /never/i, `${name}: ${sentence}`)
    if (found.length > 0) having.push(name)
  }
  assert.deepEqual(having, ['finishing-a-development-branch'])
})

test('replaceMap keeps the earlier hashes of the shipped paths and drops the rest', () => {
  assert.deepEqual(replaceMap(), Object.fromEntries(Object.entries(PREVIOUS).map(([path, hashes]) => [path, [...hashes]])))
  const hash = 'a'.repeat(64)
  const other = 'b'.repeat(64)
  const previous = {
    [pathFor('brainstorming')]: [hash, other],
    [pathFor('researching')]: [other],
    // Not shipped any more: seed refuses a path that isn't in the defaults, so it must not get here.
    [pathFor('retired-skill')]: [hash],
    'prompts/main.md': [hash],
  }
  const map = replaceMap(previous)
  assert.deepEqual(map, { [pathFor('brainstorming')]: [hash, other], [pathFor('researching')]: [other] })
  // Copies: the caller's lists and the constant are not shared.
  map[pathFor('researching')] = []
  assert.deepEqual(previous[pathFor('researching')], [other])
})

test('previous.json is what the git history of the defaults says', async (t) => {
  const directory = fileURLToPath(DIRECTORY)
  let computed: Record<string, string[]>
  try {
    computed = await computePrevious(directory, 'skills/', ['NOTICE.md'])
  } catch (error) {
    if ((error as { code?: unknown }).code === 'NO_HISTORY') {
      t.skip(`no git history to compare with: ${(error as Error).message}`)
      return
    }
    throw error
  }
  assert.deepEqual(await readPrevious(directory), computed,
    'a default changed without its old text in previous.json: run node packages/dish-kit/scripts/previous-defaults.mjs plugins/skills/defaults skills/ --exclude NOTICE.md')
})
