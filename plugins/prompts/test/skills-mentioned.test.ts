/**
 * The shipped prompts and the shipped skills agree: every skill a prompt names exists, `main.md` names every skill
 * offered to `main`, and each crew prompt's `Skills:` line names exactly the skills offered to that role.
 *
 * The skills are read straight from `plugins/skills/defaults/` and the role sets come from each `SKILL.md`'s
 * `metadata.roles` (`offeredTo`), so a skill whose roles change is caught here, not by a list kept in step by hand.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { offeredTo, parseSkill, SHIPPED_ROLES } from 'dish-skills/skill'
import type { ParsedSkill } from 'dish-skills/skill'
import { DEFAULTS } from '../src/defaults.ts'
import { CREW_ROLES } from '../src/roles.ts'

const SKILL_DEFAULTS = new URL('../defaults/', import.meta.resolve('dish-skills/skill'))

/** Every shipped skill by name: each `<directory>/SKILL.md` in dish-skills' defaults (NOTICE.md and previous.json are files, not skills). */
function shippedSkills(): Map<string, ParsedSkill> {
  const skills = new Map<string, ParsedSkill>()
  for (const entry of readdirSync(fileURLToPath(SKILL_DEFAULTS), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const path = `skills/${entry.name}/SKILL.md`
    const parsed = parseSkill(path, readFileSync(new URL(`${entry.name}/SKILL.md`, SKILL_DEFAULTS), 'utf8'))
    assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem)
    skills.set(entry.name, parsed.skill)
  }
  return skills
}

const SKILLS = shippedSkills()

/** The names in backticks in `text`, in order, repeats kept. In a Skills line or section every one is a skill. */
function backticked(text: string): string[] {
  return [...text.matchAll(/`([^`\n]+)`/g)].map(match => match[1]!)
}

/** The Skills section of `main.md`: from its `## Skills` heading to the next heading. */
function skillsSection(text: string): string {
  const lines = text.split('\n')
  const start = lines.indexOf('## Skills')
  assert.ok(start >= 0, 'main.md has no "## Skills" section')
  const end = lines.findIndex((line, index) => index > start && line.startsWith('## '))
  return lines.slice(start + 1, end < 0 ? undefined : end).join('\n')
}

/** The one `- Skills:` bullet of a crew prompt. */
function skillsLine(role: string): string {
  const lines = DEFAULTS[role]!.split('\n').filter(line => line.startsWith('- Skills:'))
  assert.equal(lines.length, 1, `${role} should have exactly one "- Skills:" bullet, has ${lines.length}`)
  return lines[0]!
}

/** The skills `role` is offered, by name, sorted. */
function offered(role: string): string[] {
  return [...SKILLS].filter(([, skill]) => offeredTo(skill, role)).map(([name]) => name).sort()
}

test('the shipped skills are read from dish-skills\' defaults, and every role they name has a prompt here', () => {
  assert.ok(SKILLS.size > 0, 'no skills found')
  const roles = new Set([...SKILLS.values()].flatMap(skill => skill.roles ?? []))
  assert.ok(roles.size > 0)
  for (const role of roles) assert.ok(role === 'main' || CREW_ROLES.includes(role), `a skill names the role "${role}", which has no shipped prompt`)
  // A skill with no roles list is offered to the roles dish ships, which are the ones with a prompt.
  assert.deepEqual([...SHIPPED_ROLES].sort(), ['main', ...CREW_ROLES].sort())
})

test('main.md has a Skills section before "Decide and record", and it names exactly the skills offered to main', () => {
  const text = DEFAULTS.main!
  assert.ok(text.indexOf('\n## Skills\n') >= 0 && text.indexOf('\n## Skills\n') < text.indexOf('\n## Decide and record\n'),
    'the Skills section comes before "Decide and record"')
  const named = backticked(skillsSection(text))
  for (const name of named) assert.ok(SKILLS.has(name), `main.md names "${name}", which is not a shipped skill`)
  assert.equal(new Set(named).size, named.length, 'main.md names a skill twice in its Skills section')
  assert.deepEqual([...named].sort(), offered('main'))
})

test('main.md names the pipeline in order: brainstorm, spec and plan, carry out, review, finish', () => {
  const section = skillsSection(DEFAULTS.main!)
  const at = (name: string): number => section.indexOf(`\`${name}\``)
  const pipeline = ['brainstorming', 'writing-specs', 'writing-plans', 'subagent-driven-development', 'executing-plans', 'requesting-code-review', 'finishing-a-development-branch']
  for (const name of pipeline) assert.ok(at(name) >= 0, `${name} is not in the Skills section`)
  for (let i = 1; i < pipeline.length; i++) {
    assert.ok(at(pipeline[i - 1]!) < at(pipeline[i]!), `${pipeline[i - 1]} comes before ${pipeline[i]}`)
  }
})

for (const role of CREW_ROLES) {
  test(`the ${role} prompt's Skills line names exactly the skills offered to ${role}`, () => {
    const named = backticked(skillsLine(role))
    for (const name of named) assert.ok(SKILLS.has(name), `${role}.md names "${name}", which is not a shipped skill`)
    assert.equal(new Set(named).size, named.length, `${role}.md names a skill twice`)
    assert.ok(named.length > 0)
    assert.deepEqual([...named].sort(), offered(role))
  })

  test(`the ${role} prompt's Skills line ends with verification-before-completion`, () => {
    // Every role is offered it, so it goes last: the role's own skills come first.
    assert.equal(backticked(skillsLine(role)).at(-1), 'verification-before-completion')
  })

  test(`the ${role} prompt's Skills line comes before its send_message bullet`, () => {
    const lines = DEFAULTS[role]!.split('\n')
    const skills = lines.findIndex(line => line.startsWith('- Skills:'))
    const send = lines.findIndex(line => line.includes('`send_message`'))
    assert.ok(skills >= 0 && send >= 0 && skills < send)
  })
}

test('a crew prompt names no skill outside its Skills line', () => {
  for (const role of CREW_ROLES) {
    const rest = DEFAULTS[role]!.split('\n').filter(line => !line.startsWith('- Skills:')).join('\n')
    for (const name of backticked(rest)) assert.ok(!SKILLS.has(name), `${role}.md names the skill "${name}" outside its Skills line`)
  }
})

test('common.md\'s house rules tell every role to load a matching skill with the skill tool before starting', () => {
  const lines = DEFAULTS.common!.split('\n')
  const rule = lines.find(line => line.startsWith('- ') && line.includes('`skill` tool'))
  assert.ok(rule, 'no house rule mentions the `skill` tool')
  assert.match(rule, /before you start/)
  assert.match(rule, /unless your brief says not to/, 'a brief can override it')
  const index = lines.indexOf(rule)
  assert.ok(index > lines.indexOf('## House rules'), 'the rule is under House rules')
  assert.ok(index < lines.findIndex(line => line.startsWith('Your working directory is')), 'the rule comes before the working-directory line')
})
