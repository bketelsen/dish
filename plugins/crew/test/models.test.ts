import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseRoute, familyOf, offeredModels } from '../src/models.ts'
import type { Route, RouteResult } from '../src/models.ts'
import { DEFAULT_SETTINGS, parseSettings } from '../src/settings.ts'
import type { CrewSettings } from '../src/settings.ts'
import { shippedWith } from './helpers.ts'

const SETTINGS = DEFAULT_SETTINGS

function settingsOf(change: (document: Record<string, any>) => void): CrewSettings {
  const parsed = parseSettings(shippedWith(change))
  assert.ok(parsed.ok, parsed.ok ? '' : parsed.problem)
  return parsed.settings
}

/** The default settings plus a google family, reviewed by openai first and then google. */
const WITH_GOOGLE = settingsOf((document) => {
  document.families.google = { strong: 'gemini-3-pro', mid: 'gemini-3-flash' }
  document.reviewerFamilies = ['openai', 'anthropic', 'google']
})

function routeOf(result: RouteResult): Route {
  assert.ok(result.ok, result.ok ? '' : result.problem)
  return result.route
}

function problemOf(result: RouteResult): string {
  assert.equal(result.ok, false, 'expected the route to be refused')
  return result.ok ? '' : result.problem
}

// --- familyOf -------------------------------------------------------------------------------------

test('familyOf finds a model the families list, whatever it is called', () => {
  assert.equal(familyOf('claude-opus-5.5', SETTINGS), 'anthropic')
  assert.equal(familyOf('claude-sonnet-5.5', SETTINGS), 'anthropic')
  assert.equal(familyOf('gpt-6.1-sol', SETTINGS), 'openai')
  assert.equal(familyOf('gpt-5.6-sol', SETTINGS), 'openai')
  // The list comes first: a model the file puts in a family is in that family, whatever its prefix says.
  const settings = settingsOf((document) => {
    document.families.inhouse = { strong: 'claude-inhouse', mid: 'gpt-inhouse' }
  })
  assert.equal(familyOf('claude-inhouse', settings), 'inhouse')
  assert.equal(familyOf('gpt-inhouse', settings), 'inhouse')
  assert.equal(familyOf('claude-haiku-4.5', settings), 'anthropic')
})

test('familyOf falls back to prefixes for a model no family lists', () => {
  for (const model of ['claude-haiku-4.5', 'claude-3-opus', 'CLAUDE-SONNET']) assert.equal(familyOf(model, SETTINGS), 'anthropic', model)
  for (const model of ['gpt-5', 'gpt-4o-mini', 'o1', 'o3-mini', 'o4', 'codex-mini', 'codex']) assert.equal(familyOf(model, SETTINGS), 'openai', model)
  for (const model of ['gemini-3-pro', 'gemini-2.5-flash']) assert.equal(familyOf(model, SETTINGS), 'google', model)
  for (const model of ['grok-4', 'grok-code-fast-1']) assert.equal(familyOf(model, SETTINGS), 'xai', model)
})

test('familyOf is undefined for a model it can\'t tell', () => {
  for (const model of ['llama-3.3', 'mistral-large', 'omega', 'o', 'oss-120b', 'sonnet', 'my-claude', '', ' ']) {
    assert.equal(familyOf(model, SETTINGS), undefined, JSON.stringify(model))
  }
})

test('familyOf asks for own properties only: an Object member name is no model and no family', () => {
  for (const model of ['constructor', 'toString', 'hasOwnProperty', '__proto__', 'valueOf']) {
    assert.equal(familyOf(model, SETTINGS), undefined, model)
  }
})

// --- non-reviewers --------------------------------------------------------------------------------

test('every non-reviewer role defaults to its family at its tier, on the settings\' provider', () => {
  const expected: Record<string, string> = {
    architect: 'claude-opus-5.5',
    coder: 'claude-sonnet-5.5',
    researcher: 'claude-sonnet-5.5',
    ops: 'claude-sonnet-5.5',
    writer: 'claude-sonnet-5.5',
  }
  for (const [role, model] of Object.entries(expected)) {
    assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role })), { provider: 'github-copilot', model, family: 'anthropic' }, role)
  }
})

test('the route follows the file: provider, family and tier', () => {
  const settings = settingsOf((document) => {
    document.provider = 'other-provider'
    document.roles.coder.family = 'openai'
    document.roles.coder.tier = 'strong'
  })
  assert.deepEqual(routeOf(chooseRoute({ settings, role: 'coder' })), { provider: 'other-provider', model: 'gpt-6.1-sol', family: 'openai' })
})

test('a coder can be overridden to a model the families list, and its family comes from there', () => {
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'coder', override: 'gpt-5.6-sol' })),
    { provider: 'github-copilot', model: 'gpt-5.6-sol', family: 'openai' })
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'coder', override: 'gpt-6.1-sol' })).family, 'openai')
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'researcher', override: 'claude-opus-5.5' })),
    { provider: 'github-copilot', model: 'claude-opus-5.5', family: 'anthropic' })
})

test('an empty or blank override is no override', () => {
  const plain = routeOf(chooseRoute({ settings: SETTINGS, role: 'coder' }))
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'coder', override: '' })), plain)
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'coder', override: '  ' })), plain)
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'coder', override: ' gpt-5.6-sol ' })).model, 'gpt-5.6-sol')
})

test('an override the families don\'t list is refused, and the problem lists the ones they do', () => {
  for (const override of ['gpt-9', 'claude-haiku-4.5', 'constructor', '__proto__', 'toString']) {
    const problem = problemOf(chooseRoute({ settings: SETTINGS, role: 'coder', override }))
    assert.ok(problem.includes(JSON.stringify(override)), problem)
    for (const model of ['claude-opus-5.5', 'claude-sonnet-5.5', 'gpt-6.1-sol', 'gpt-5.6-sol']) assert.ok(problem.includes(model), `${override}: ${problem}`)
    assert.match(problem, /crew\.yaml/)
  }
})

test('an unknown role is refused, and the problem names the roles there are', () => {
  for (const role of ['', 'coderr', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const problem = problemOf(chooseRoute({ settings: SETTINGS, role }))
    assert.match(problem, /unknown role/, problem)
    for (const name of ['architect', 'coder', 'reviewer', 'researcher', 'ops', 'writer']) assert.ok(problem.includes(name), `${role}: ${problem}`)
  }
})

test('a role is looked up as an own property: Object member names work as roles when the file has them', () => {
  const settings = settingsOf((document) => {
    document.roles.constructor = { tier: 'mid', family: 'openai', tools: ['read'] }
  })
  assert.deepEqual(routeOf(chooseRoute({ settings, role: 'constructor' })), { provider: 'github-copilot', model: 'gpt-5.6-sol', family: 'openai' })
  assert.match(problemOf(chooseRoute({ settings, role: 'toString' })), /unknown role/)
})

test('lookups are for own properties even when the settings are ordinary objects with a prototype', () => {
  const plain: CrewSettings = {
    provider: 'p',
    families: { a: { strong: 'a-big', mid: 'a-small' }, b: { strong: 'b-big', mid: 'b-small' } },
    reviewerFamilies: ['constructor', 'a', 'b'],
    limits: { running: 1, writers: 1, perSession: 1 },
    roles: {
      worker: { tier: 'mid', family: 'toString', writes: false, reviews: false, tools: [] },
      judge: { tier: 'mid', writes: false, reviews: true, tools: [] },
    },
  }
  for (const role of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) assert.match(problemOf(chooseRoute({ settings: plain, role })), /unknown role/, role)
  // A role whose family is an Object member, not a family of the file: a problem, not a crash or a made-up model.
  assert.match(problemOf(chooseRoute({ settings: plain, role: 'worker' })), /has no model to run on/)
  // A reviewer family that is an Object member is skipped, not chosen.
  assert.deepEqual(routeOf(chooseRoute({ settings: plain, role: 'judge', reviewedFamily: 'b' })), { provider: 'p', model: 'a-small', family: 'a' })
  assert.deepEqual(routeOf(chooseRoute({ settings: plain, role: 'judge', reviewedFamily: 'a' })), { provider: 'p', model: 'b-small', family: 'b' })
  assert.equal(familyOf('constructor', plain), undefined)
  assert.equal(familyOf('b-big', plain), 'b')
})

test('a long role name from the model is cut short in the problem', () => {
  const problem = problemOf(chooseRoute({ settings: SETTINGS, role: 'x'.repeat(5_000) }))
  assert.ok(problem.length < 600, String(problem.length))
})

test('a non-reviewer ignores reviewedFamily', () => {
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'coder', reviewedFamily: 'anthropic' })).model, 'claude-sonnet-5.5')
})

// --- the reviewer ---------------------------------------------------------------------------------

test('the reviewer runs in the first reviewer family that isn\'t the reviewed work\'s, at its tier', () => {
  // Reviewing a Claude coder: openai first.
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: 'anthropic' })),
    { provider: 'github-copilot', model: 'gpt-5.6-sol', family: 'openai' })
  // Reviewing a GPT coder: anthropic.
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: 'openai' })),
    { provider: 'github-copilot', model: 'claude-sonnet-5.5', family: 'anthropic' })
  // Reviewing a Gemini coder, a family the file doesn't have: openai, the first.
  assert.deepEqual(routeOf(chooseRoute({ settings: WITH_GOOGLE, role: 'reviewer', reviewedFamily: familyOf('gemini-3-pro', WITH_GOOGLE) })).family, 'openai')
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: familyOf('gemini-3-pro', SETTINGS) })).family, 'openai')
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: familyOf('grok-4', SETTINGS) })).family, 'openai')
})

test('the reviewer takes its tier from the file', () => {
  const settings = settingsOf((document) => { document.roles.reviewer.tier = 'strong' })
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewedFamily: 'anthropic' })).model, 'gpt-6.1-sol')
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewedFamily: 'openai' })).model, 'claude-opus-5.5')
})

test('the order of reviewerFamilies decides, skipping the reviewed family', () => {
  const settings = settingsOf((document) => {
    document.families.google = { strong: 'gemini-3-pro', mid: 'gemini-3-flash' }
    document.reviewerFamilies = ['anthropic', 'google', 'openai']
  })
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewedFamily: 'openai' })).family, 'anthropic')
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewedFamily: 'anthropic' })).family, 'google')
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewedFamily: 'google' })).family, 'anthropic')
})

test('a reviewer needs to know the reviewed family: without it there is no review', () => {
  for (const reviewedFamily of [undefined, '', '  ']) {
    const problem = problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily }))
    assert.match(problem, /family of the work/, problem)
  }
  // Even with an override: it can't be checked against nothing.
  assert.match(problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', override: 'gpt-5.6-sol' })), /family of the work/)
})

test('a reviewer override in the reviewed family is refused, and the problem offers the other families\' models', () => {
  const problem = problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: 'anthropic', override: 'claude-opus-5.5' }))
  assert.ok(problem.includes('claude-opus-5.5'), problem)
  assert.ok(problem.includes('anthropic'), problem)
  assert.ok(problem.includes('gpt-6.1-sol') && problem.includes('gpt-5.6-sol'), problem)
  const other = problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: 'openai', override: 'gpt-6.1-sol' }))
  assert.ok(other.includes('claude-opus-5.5') && other.includes('claude-sonnet-5.5'), other)
})

test('a reviewer override in another family is accepted', () => {
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: 'anthropic', override: 'gpt-6.1-sol' })),
    { provider: 'github-copilot', model: 'gpt-6.1-sol', family: 'openai' })
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: 'openai', override: 'claude-opus-5.5' })),
    { provider: 'github-copilot', model: 'claude-opus-5.5', family: 'anthropic' })
  // Work in a family the file doesn't have, reviewed on one it does.
  assert.equal(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: 'google', override: 'claude-sonnet-5.5' })).family, 'anthropic')
})

test('a reviewer override the families don\'t list is refused, whatever its prefix says', () => {
  for (const override of ['gpt-9', 'claude-haiku-4.5', 'gemini-3-pro', '__proto__']) {
    const problem = problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: 'google', override }))
    assert.ok(problem.includes(JSON.stringify(override)), problem)
    assert.ok(problem.includes('gpt-5.6-sol') && problem.includes('claude-sonnet-5.5'), problem)
  }
})

test('case and padding don\'t make a different family', () => {
  assert.equal(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: 'Anthropic' })).family, 'openai')
  assert.equal(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: ' OPENAI ' })).family, 'anthropic')
  assert.match(problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: 'ANTHROPIC', override: 'claude-opus-5.5' })), /different family/)
})

test('with no family that differs there is no reviewer, and the problem says what to change', () => {
  const settings = settingsOf((document) => { document.reviewerFamilies = ['openai'] })
  assert.equal(problemOf(chooseRoute({ settings, role: 'reviewer', reviewedFamily: 'openai' })),
    'no reviewer family differs from openai; add one to reviewerFamilies in crew.yaml')
  // The other direction still works.
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewedFamily: 'anthropic' })).family, 'openai')
  // An empty list means no reviewer for anyone.
  const none = settingsOf((document) => { document.reviewerFamilies = [] })
  assert.match(problemOf(chooseRoute({ settings: none, role: 'reviewer', reviewedFamily: 'anthropic' })), /^no reviewer family differs from anthropic; add one to reviewerFamilies in crew\.yaml/)
})

test('the reviewer is the role with reviews: true, not the role called reviewer', () => {
  const settings = settingsOf((document) => {
    document.roles.critic = document.roles.reviewer
    document.roles.reviewer = { tier: 'strong', family: 'anthropic', writes: true, tools: ['read'] }
  })
  assert.equal(settings.roles.critic!.reviews, true)
  assert.equal(settings.roles.reviewer!.reviews, false)
  // `critic` follows the reviewer rule.
  assert.equal(routeOf(chooseRoute({ settings, role: 'critic', reviewedFamily: 'anthropic' })).family, 'openai')
  assert.equal(routeOf(chooseRoute({ settings, role: 'critic', reviewedFamily: 'openai' })).family, 'anthropic')
  assert.match(problemOf(chooseRoute({ settings, role: 'critic' })), /family of the work/)
  assert.match(problemOf(chooseRoute({ settings, role: 'critic', reviewedFamily: 'anthropic', override: 'claude-opus-5.5' })), /different|differs/)
  // `reviewer` is an ordinary role: its own family, no reviewed work needed.
  assert.deepEqual(routeOf(chooseRoute({ settings, role: 'reviewer' })), { provider: 'github-copilot', model: 'claude-opus-5.5', family: 'anthropic' })
})

test('the reviewer never runs in the reviewed family, for any reviewed family, order, override or tier', () => {
  const orders = [['openai', 'anthropic', 'google'], ['anthropic', 'google', 'openai'], ['google', 'openai'], ['openai'], ['anthropic'], ['google', 'anthropic', 'openai'], []]
  const reviewed = ['anthropic', 'openai', 'google', 'xai', 'unheard-of', '__proto__', 'constructor']
  let accepted = 0
  for (const order of orders) {
    for (const tier of ['strong', 'mid']) {
      const settings = settingsOf((document) => {
        document.families.google = { strong: 'gemini-3-pro', mid: 'gemini-3-flash' }
        document.reviewerFamilies = order
        document.roles.reviewer.tier = tier
      })
      for (const reviewedFamily of reviewed) {
        for (const override of [undefined, ...offeredModels(settings), 'gpt-9', 'claude-haiku-4.5']) {
          const result = chooseRoute({ settings, role: 'reviewer', reviewedFamily, override })
          if (!result.ok) continue
          accepted++
          const label = `${order.join(',')} ${tier} reviewing ${reviewedFamily} override ${override}`
          assert.notEqual(result.route.family, reviewedFamily, label)
          // The family the route names is the family the model is in, so a reviewed child whose model is this one would be in the same family.
          assert.equal(familyOf(result.route.model, settings), result.route.family, label)
          assert.notEqual(familyOf(result.route.model, settings), reviewedFamily, label)
          assert.ok(Object.hasOwn(settings.families, result.route.family), label)
        }
      }
    }
  }
  assert.ok(accepted > 50, `only ${accepted} routes were ever accepted`)
})

test('a reviewed model in the file and a reviewer picked for it never share a family', () => {
  // For every model the families list, whatever it is reviewed on, review its family's work on another family.
  for (const model of offeredModels(WITH_GOOGLE)) {
    const reviewedFamily = familyOf(model, WITH_GOOGLE)
    assert.ok(reviewedFamily !== undefined, model)
    const route = routeOf(chooseRoute({ settings: WITH_GOOGLE, role: 'reviewer', reviewedFamily }))
    assert.notEqual(route.family, reviewedFamily, model)
    assert.notEqual(familyOf(route.model, WITH_GOOGLE), familyOf(model, WITH_GOOGLE), model)
  }
})

// --- offeredModels --------------------------------------------------------------------------------

test('offeredModels lists every model the families list, once, family by family', () => {
  assert.deepEqual(offeredModels(SETTINGS), ['claude-opus-5.5', 'claude-sonnet-5.5', 'gpt-6.1-sol', 'gpt-5.6-sol'])
  const settings = settingsOf((document) => {
    document.families.anthropic = { strong: 'claude-opus-5.5', mid: 'claude-opus-5.5' }
  })
  assert.deepEqual(offeredModels(settings), ['claude-opus-5.5', 'gpt-6.1-sol', 'gpt-5.6-sol'])
})

// --- robustness -----------------------------------------------------------------------------------

test('chooseRoute never throws, and doesn\'t touch the settings', () => {
  const before = JSON.stringify(SETTINGS)
  const odd = ['', ' ', '__proto__', 'constructor', 'toString', 'a'.repeat(10_000), '\u0000', 'coder\n']
  for (const role of [...odd, 'coder', 'reviewer']) {
    for (const override of [undefined, ...odd, 'gpt-5.6-sol']) {
      for (const reviewedFamily of [undefined, ...odd, 'anthropic']) {
        const result = chooseRoute({ settings: SETTINGS, role, override, reviewedFamily })
        assert.equal(typeof result.ok, 'boolean')
        if (!result.ok) assert.ok(result.problem.length > 0 && result.problem.length < 2_000, result.problem.slice(0, 80))
      }
    }
  }
  assert.equal(JSON.stringify(SETTINGS), before)
})

test('a problem is a sentence to act on: it says what was wrong and what to do', () => {
  const problems = [
    problemOf(chooseRoute({ settings: SETTINGS, role: 'nope' })),
    problemOf(chooseRoute({ settings: SETTINGS, role: 'coder', override: 'nope' })),
    problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer' })),
    problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewedFamily: 'anthropic', override: 'claude-opus-5.5' })),
  ]
  for (const problem of problems) {
    assert.ok(problem.length > 30, problem)
    assert.ok(!problem.includes('undefined') && !problem.includes('[object'), problem)
  }
})
