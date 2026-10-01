import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseRoute, familyOf, offeredModels, vendorsOf } from '../src/models.ts'
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
  for (const model of ['llama-3.3', 'mistral-large', 'omega', 'o', 'oss-120b', 'sonnet', 'sonnet-x', '', ' ']) {
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
  assert.deepEqual(routeOf(chooseRoute({ settings: plain, role: 'judge', reviewed: { family: 'b' } })), { provider: 'p', model: 'a-small', family: 'a' })
  assert.deepEqual(routeOf(chooseRoute({ settings: plain, role: 'judge', reviewed: { family: 'a' } })), { provider: 'p', model: 'b-small', family: 'b' })
  assert.equal(familyOf('constructor', plain), undefined)
  assert.equal(familyOf('b-big', plain), 'b')
})

test('a long role name from the model is cut short in the problem', () => {
  const problem = problemOf(chooseRoute({ settings: SETTINGS, role: 'x'.repeat(5_000) }))
  assert.ok(problem.length < 600, String(problem.length))
})

test('a non-reviewer ignores reviewed', () => {
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'coder', reviewed: { family: 'anthropic' } })).model, 'claude-sonnet-5.5')
})

// --- the reviewer ---------------------------------------------------------------------------------

test('the reviewer runs in the first reviewer family that isn\'t the reviewed work\'s, at its tier', () => {
  // Reviewing a Claude coder: openai first.
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: 'anthropic' } })),
    { provider: 'github-copilot', model: 'gpt-5.6-sol', family: 'openai' })
  // Reviewing a GPT coder: anthropic.
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: 'openai' } })),
    { provider: 'github-copilot', model: 'claude-sonnet-5.5', family: 'anthropic' })
  // Reviewing a Gemini coder, a family the file doesn't have: openai, the first.
  assert.deepEqual(routeOf(chooseRoute({ settings: WITH_GOOGLE, role: 'reviewer', reviewed: { family: familyOf('gemini-3-pro', WITH_GOOGLE) } })).family, 'openai')
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: familyOf('gemini-3-pro', SETTINGS) } })).family, 'openai')
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: familyOf('grok-4', SETTINGS) } })).family, 'openai')
})

test('the reviewer takes its tier from the file', () => {
  const settings = settingsOf((document) => { document.roles.reviewer.tier = 'strong' })
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { family: 'anthropic' } })).model, 'gpt-6.1-sol')
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { family: 'openai' } })).model, 'claude-opus-5.5')
})

test('the order of reviewerFamilies decides, skipping the reviewed family', () => {
  const settings = settingsOf((document) => {
    document.families.google = { strong: 'gemini-3-pro', mid: 'gemini-3-flash' }
    document.reviewerFamilies = ['anthropic', 'google', 'openai']
  })
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { family: 'openai' } })).family, 'anthropic')
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { family: 'anthropic' } })).family, 'google')
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { family: 'google' } })).family, 'anthropic')
})

test('a reviewer needs to know the reviewed work: without a model or a family there is no review', () => {
  for (const reviewedFamily of [undefined, '', '  ']) {
    const problem = problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: reviewedFamily } }))
    assert.match(problem, /model or family/, problem)
  }
  assert.match(problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { model: ' ', family: '' } })), /model or family/)
  assert.match(problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: {} })), /model or family/)
  // Even with an override: it can't be checked against nothing.
  assert.match(problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', override: 'gpt-5.6-sol' })), /model or family/)
})

test('a reviewer override in the reviewed family is refused, and the problem offers the other families\' models', () => {
  const problem = problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: 'anthropic' }, override: 'claude-opus-5.5' }))
  assert.ok(problem.includes('claude-opus-5.5'), problem)
  assert.ok(problem.includes('anthropic'), problem)
  assert.ok(problem.includes('gpt-6.1-sol') && problem.includes('gpt-5.6-sol'), problem)
  const other = problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: 'openai' }, override: 'gpt-6.1-sol' }))
  assert.ok(other.includes('claude-opus-5.5') && other.includes('claude-sonnet-5.5'), other)
})

test('a reviewer override in another family is accepted', () => {
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: 'anthropic' }, override: 'gpt-6.1-sol' })),
    { provider: 'github-copilot', model: 'gpt-6.1-sol', family: 'openai' })
  assert.deepEqual(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: 'openai' }, override: 'claude-opus-5.5' })),
    { provider: 'github-copilot', model: 'claude-opus-5.5', family: 'anthropic' })
  // Work in a family the file doesn't have, reviewed on one it does.
  assert.equal(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: 'google' }, override: 'claude-sonnet-5.5' })).family, 'anthropic')
})

test('a reviewer override the families don\'t list is refused, whatever its prefix says', () => {
  for (const override of ['gpt-9', 'claude-haiku-4.5', 'gemini-3-pro', '__proto__']) {
    const problem = problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: 'google' }, override }))
    assert.ok(problem.includes(JSON.stringify(override)), problem)
    assert.ok(problem.includes('gpt-5.6-sol') && problem.includes('claude-sonnet-5.5'), problem)
  }
})

test('case and padding don\'t make a different family', () => {
  assert.equal(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: 'Anthropic' } })).family, 'openai')
  assert.equal(routeOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: ' OPENAI ' } })).family, 'anthropic')
  assert.match(problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: 'ANTHROPIC' }, override: 'claude-opus-5.5' })), /different family/)
})

test('with no family that differs there is no reviewer, and the problem says what to change', () => {
  const settings = settingsOf((document) => { document.reviewerFamilies = ['openai'] })
  assert.equal(problemOf(chooseRoute({ settings, role: 'reviewer', reviewed: { family: 'openai' } })),
    'no reviewer family differs from openai; add one to reviewerFamilies in crew.yaml')
  // The other direction still works.
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { family: 'anthropic' } })).family, 'openai')
  // An empty list means no reviewer for anyone.
  const none = settingsOf((document) => { document.reviewerFamilies = [] })
  assert.match(problemOf(chooseRoute({ settings: none, role: 'reviewer', reviewed: { family: 'anthropic' } })), /^no reviewer family differs from anthropic; add one to reviewerFamilies in crew\.yaml/)
})

test('the reviewer is the role with reviews: true, not the role called reviewer', () => {
  const settings = settingsOf((document) => {
    document.roles.critic = document.roles.reviewer
    document.roles.reviewer = { tier: 'strong', family: 'anthropic', writes: true, tools: ['read'] }
  })
  assert.equal(settings.roles.critic!.reviews, true)
  assert.equal(settings.roles.reviewer!.reviews, false)
  // `critic` follows the reviewer rule.
  assert.equal(routeOf(chooseRoute({ settings, role: 'critic', reviewed: { family: 'anthropic' } })).family, 'openai')
  assert.equal(routeOf(chooseRoute({ settings, role: 'critic', reviewed: { family: 'openai' } })).family, 'anthropic')
  assert.match(problemOf(chooseRoute({ settings, role: 'critic' })), /model or family/)
  assert.match(problemOf(chooseRoute({ settings, role: 'critic', reviewed: { family: 'anthropic' }, override: 'claude-opus-5.5' })), /different|differs/)
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
          const result = chooseRoute({ settings, role: 'reviewer', reviewed: { family: reviewedFamily }, override })
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
    const route = routeOf(chooseRoute({ settings: WITH_GOOGLE, role: 'reviewer', reviewed: { family: reviewedFamily } }))
    assert.notEqual(route.family, reviewedFamily, model)
    assert.notEqual(familyOf(route.model, WITH_GOOGLE), familyOf(model, WITH_GOOGLE), model)
  }
})

// --- the reviewer rule, by vendor -----------------------------------------------------------------

/** The families of the file may be called anything: here `claude` and `gpt`, with the models the default has. */
const RENAMED = settingsOf((document) => {
  document.families = {
    claude: { strong: 'claude-opus-5.5', mid: 'claude-sonnet-5.5' },
    gpt: { strong: 'gpt-6.1-sol', mid: 'gpt-5.6-sol' },
  }
  document.reviewerFamilies = ['claude', 'gpt']
  for (const role of Object.values(document.roles) as any[]) if (role.family !== undefined) role.family = 'claude'
})

/** Reviewed models that no family of the file lists, in the forms a model id comes in: bare, provider-qualified, regional. */
const UNLISTED_CLAUDE = [
  'claude-opus-4.7',
  'claude-3-5-haiku-latest',
  'CLAUDE-OPUS-4.7',
  'github-copilot/claude-opus-4.7',
  'openrouter/anthropic/claude-3.7-sonnet',
  'us.anthropic.claude-3-5-sonnet-20241022-v2:0',
  'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'anthropic.claude-v2',
  'claude-3-5-sonnet@20240620',
]
const UNLISTED_GPT = ['gpt-4.1', 'o3-mini', 'codex-mini-latest', 'github-copilot/gpt-5', 'openai/gpt-4o', 'eu.openai.gpt-oss-120b-1:0']

test('vendorsOf tells the vendor of a model id by the prefix table, whatever is around it', () => {
  assert.deepEqual([...vendorsOf('claude-opus-4.7')], ['anthropic'])
  assert.deepEqual([...vendorsOf('github-copilot/claude-opus-4.7')], ['anthropic'])
  assert.deepEqual([...vendorsOf('openrouter/anthropic/claude-3.7-sonnet')], ['anthropic'])
  assert.deepEqual([...vendorsOf('us.anthropic.claude-3-5-sonnet-20241022-v2:0')], ['anthropic'])
  assert.deepEqual([...vendorsOf('eu.openai.gpt-oss-120b-1:0')], ['openai'])
  assert.deepEqual([...vendorsOf('gpt-5.6-sol')], ['openai'])
  assert.deepEqual([...vendorsOf('o3-mini')], ['openai'])
  assert.deepEqual([...vendorsOf('codex-mini')], ['openai'])
  assert.deepEqual([...vendorsOf('gemini-2.5-flash')], ['google'])
  assert.deepEqual([...vendorsOf('google/gemini-3-pro')], ['google'])
  assert.deepEqual([...vendorsOf('grok-4')], ['xai'])
  // A vendor name on its own is as good as a model prefix.
  assert.deepEqual([...vendorsOf('anthropic.something-new')], ['anthropic'])
  for (const id of ['llama-3.3', 'mistral-large', 'omega', 'o', 'sonnet-x', 'deepseek-v4', '', ' ', 'meta-llama/llama-3', 'constructor', '__proto__']) {
    assert.equal(vendorsOf(id).size, 0, JSON.stringify(id))
  }
})

test('vendorsOf finds a vendor in any token of the id: an alias, a hosting prefix, a fine-tune', () => {
  const found: Array<[string, string]> = [
    ['anthropic-claude-x', 'anthropic'],
    ['azure-gpt-4o', 'openai'],
    ['my-claude', 'anthropic'],
    ['chatgpt-4o-latest', 'openai'],
    ['github-copilot:claude-opus-4.7', 'anthropic'],
    ['ft:gpt-4o:acme::abc123', 'openai'],
    ['claude_opus_4_7', 'anthropic'],
    ['claude-3-5-sonnet@20240620', 'anthropic'],
    ['team o3 mini', 'openai'],
    ['vertex_ai/gemini-2.5-pro', 'google'],
    ['xai:grok-4', 'xai'],
  ]
  for (const [id, vendor] of found) assert.deepEqual([...vendorsOf(id)], [vendor], id)
  // Two vendors in one id are both found, so neither can be got past the rule through it.
  assert.deepEqual([...vendorsOf('claude-gpt-bridge')].sort(), ['anthropic', 'openai'])
  // A token has to be a vendor's word: a letter-and-digit that merely contains an o, or a model's own name, isn't.
  for (const id of ['4o-mini', 'sonnet-x', 'opus', 'haiku-3', 'llama-3', 'o', 'ob1']) assert.equal(vendorsOf(id).size, 0, id)
})

test('familyOf gives a family only when exactly one vendor matches', () => {
  assert.equal(familyOf('my-claude', SETTINGS), 'anthropic')
  assert.equal(familyOf('chatgpt-4o-latest', SETTINGS), 'openai')
  assert.equal(familyOf('ft:gpt-4o:acme::abc123', SETTINGS), 'openai')
  assert.equal(familyOf('claude-gpt-bridge', SETTINGS), undefined)
  assert.equal(familyOf('sonnet-x', SETTINGS), undefined)
})

test('a family of the file whose models are aliases that name their vendor in any token is kept from the reviewer of that vendor', () => {
  // `other` lists a Claude under a name that doesn't start with the vendor's: the probe that got past a start-of-segment check.
  const probe = settingsOf((document) => {
    document.families = {
      claude: { strong: 'claude-opus-5.5', mid: 'claude-sonnet-5.5' },
      other: { strong: 'anthropic-claude-x', mid: 'anthropic-claude-y' },
      gpt: { strong: 'gpt-6.1-sol', mid: 'gpt-5.6-sol' },
    }
    document.reviewerFamilies = ['other', 'gpt']
    for (const role of Object.values(document.roles) as any[]) if (role.family !== undefined) role.family = 'claude'
  })
  assert.equal(routeOf(chooseRoute({ settings: probe, role: 'reviewer', reviewed: { model: 'claude-sonnet-5.5' } })).family, 'gpt')
  assert.equal(routeOf(chooseRoute({ settings: probe, role: 'reviewer', reviewed: { family: 'claude' } })).family, 'gpt')
  assert.equal(routeOf(chooseRoute({ settings: probe, role: 'reviewer', reviewed: { model: 'claude-opus-4.7' } })).family, 'gpt')
  assert.match(problemOf(chooseRoute({ settings: probe, role: 'reviewer', reviewed: { model: 'claude-sonnet-5.5' }, override: 'anthropic-claude-x' })), /different family/)
  // Reviewing the GPT side, `other` is the Claude and is fine.
  assert.equal(routeOf(chooseRoute({ settings: probe, role: 'reviewer', reviewed: { model: 'gpt-5.6-sol' } })).family, 'other')

  // Each alias that names no vendor at its start, as a candidate family against work of its vendor.
  const aliases: Array<[alias: string, reviewed: string, other: string]> = [
    ['anthropic-claude-x', 'claude-opus-4.7', 'gpt-4.1'],
    ['azure-gpt-4o', 'gpt-4.1', 'claude-opus-4.7'],
    ['my-claude', 'claude-opus-4.7', 'gpt-4.1'],
    ['chatgpt-4o-latest', 'gpt-4.1', 'claude-opus-4.7'],
    ['github-copilot:claude-opus-4.7', 'claude-3-5-haiku-latest', 'gpt-4.1'],
    ['ft:gpt-4o:acme::abc123', 'o3-mini', 'claude-opus-4.7'],
  ]
  for (const [alias, reviewed, other] of aliases) {
    const settings = settingsOf((document) => {
      document.families = {
        alias: { strong: alias, mid: alias },
        gem: { strong: 'gemini-3-pro', mid: 'gemini-3-flash' },
      }
      document.reviewerFamilies = ['alias', 'gem']
      for (const role of Object.values(document.roles) as any[]) if (role.family !== undefined) role.family = 'gem'
    })
    assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { model: reviewed } })).family, 'gem', `${alias} reviewed on ${reviewed}`)
    assert.match(problemOf(chooseRoute({ settings, role: 'reviewer', reviewed: { model: reviewed }, override: alias })), /different family/, alias)
    // Work of the other vendor is fine to review on it.
    assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { model: other } })).family, 'alias', `${alias} reviewed on ${other}`)
  }
})

test('familyOf reads a provider-qualified id by its vendor, and a list still beats it', () => {
  assert.equal(familyOf('github-copilot/claude-opus-4.7', SETTINGS), 'anthropic')
  assert.equal(familyOf('us.anthropic.claude-3-5-sonnet-20241022-v2:0', SETTINGS), 'anthropic')
  assert.equal(familyOf('openai/gpt-4o', SETTINGS), 'openai')
  assert.equal(familyOf('claude-opus-5.5', RENAMED), 'claude')
  // Unlisted, the vendor's own name: the file's names for its families don't change what a vendor is called.
  assert.equal(familyOf('claude-opus-4.7', RENAMED), 'anthropic')
})

test('renamed families and an unlisted reviewed model: the default reviewer is never the same vendor', () => {
  for (const model of UNLISTED_CLAUDE) {
    const route = routeOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { model } }))
    assert.equal(route.family, 'gpt', model)
    assert.equal(route.model, 'gpt-5.6-sol', model)
  }
  // The other direction: reviewerFamilies still lists claude first, and claude differs from a GPT.
  for (const model of UNLISTED_GPT) {
    assert.equal(routeOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { model } })).family, 'claude', model)
  }
})

test('renamed families and an unlisted reviewed model: an override in the same vendor is refused, one in another is accepted', () => {
  for (const model of UNLISTED_CLAUDE) {
    for (const override of ['claude-sonnet-5.5', 'claude-opus-5.5']) {
      const problem = problemOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { model }, override }))
      assert.match(problem, /different family/, `${model} ${override}`)
      assert.ok(problem.includes('gpt-6.1-sol') && problem.includes('gpt-5.6-sol'), problem)
      assert.ok(!problem.includes('Models offered outside it: claude'), problem)
    }
    assert.deepEqual(routeOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { model }, override: 'gpt-6.1-sol' })),
      { provider: 'github-copilot', model: 'gpt-6.1-sol', family: 'gpt' }, model)
  }
  for (const model of UNLISTED_GPT) {
    assert.match(problemOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { model }, override: 'gpt-5.6-sol' })), /different family/, model)
    assert.equal(routeOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { model }, override: 'claude-opus-5.5' })).family, 'claude', model)
  }
})

test('the reviewed family given as a vendor name excludes the families of the file that hold that vendor\'s models', () => {
  // `anthropic` is what familyOf says of an unlisted Claude, though the file calls its Claude family `claude`.
  assert.equal(routeOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { family: 'anthropic' } })).family, 'gpt')
  assert.equal(routeOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { family: 'ANTHROPIC' } })).family, 'gpt')
  assert.match(problemOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { family: 'anthropic' }, override: 'claude-sonnet-5.5' })), /different family/)
  assert.equal(routeOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { family: 'openai' } })).family, 'claude')
})

test('the reviewed family given by the file\'s own name excludes every family that holds a model of the same vendor', () => {
  const settings = settingsOf((document) => {
    document.families = {
      claude: { strong: 'claude-opus-5.5', mid: 'claude-sonnet-5.5' },
      'claude-small': { strong: 'claude-haiku-9', mid: 'claude-haiku-8' },
      gpt: { strong: 'gpt-6.1-sol', mid: 'gpt-5.6-sol' },
    }
    document.reviewerFamilies = ['claude-small', 'claude', 'gpt']
    for (const role of Object.values(document.roles) as any[]) if (role.family !== undefined) role.family = 'claude'
  })
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { family: 'claude' } })).family, 'gpt')
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { model: 'claude-sonnet-5.5' } })).family, 'gpt')
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { model: 'claude-haiku-8' } })).family, 'gpt')
  assert.match(problemOf(chooseRoute({ settings, role: 'reviewer', reviewed: { family: 'claude' }, override: 'claude-haiku-9' })), /different family/)
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { family: 'gpt' } })).family, 'claude-small')
})

test('a family that holds models of two vendors counts as both, so it is excluded when either is reviewed', () => {
  const settings = settingsOf((document) => {
    document.families = {
      mixed: { strong: 'claude-mixed', mid: 'gpt-mixed' },
      gemini: { strong: 'gemini-3-pro', mid: 'gemini-3-flash' },
    }
    document.reviewerFamilies = ['mixed', 'gemini']
    for (const role of Object.values(document.roles) as any[]) if (role.family !== undefined) role.family = 'mixed'
  })
  for (const model of ['claude-opus-4.7', 'gpt-4.1', 'claude-mixed', 'gpt-mixed']) {
    assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { model } })).family, 'gemini', model)
  }
  // Reviewing Gemini work, the mixed family is fine.
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { model: 'gemini-9' } })).family, 'mixed')
})

test('model and family together: the reviewer differs from both', () => {
  assert.equal(routeOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { model: 'gemini-3-pro', family: 'google' } })).family, 'claude')
  // A family label and a model that disagree: both are kept away from, so with only two families there's no reviewer.
  assert.match(problemOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { model: 'gpt-4.1', family: 'claude' } })), /^no reviewer family differs from claude/)
})

test('a reviewed model whose family can\'t be told is refused, and the problem names it', () => {
  for (const model of ['llama-3.3', 'deepseek-v4', 'meta-llama/llama-3', 'mistral-large']) {
    const problem = problemOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { model } }))
    assert.ok(problem.includes(`can't tell the family of model ${JSON.stringify(model)}`), problem)
    assert.match(problem, /add it to a family in crew\.yaml/)
  }
  // With a family given as well, the family is what tells.
  assert.equal(routeOf(chooseRoute({ settings: RENAMED, role: 'reviewer', reviewed: { model: 'llama-3.3', family: 'meta' } })).family, 'claude')
  // A model the file lists is told by the list, whatever it is called.
  const settings = settingsOf((document) => { document.families.inhouse = { strong: 'llama-3.3', mid: 'llama-3.1' } })
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { model: 'llama-3.3' } })).family, 'openai')
})

test('no reviewer family differs when every candidate is the reviewed vendor, and the problem says what to change', () => {
  const settings = settingsOf((document) => {
    document.families = { claude: { strong: 'claude-opus-5.5', mid: 'claude-sonnet-5.5' }, gpt: { strong: 'gpt-6.1-sol', mid: 'gpt-5.6-sol' } }
    document.reviewerFamilies = ['claude']
    for (const role of Object.values(document.roles) as any[]) if (role.family !== undefined) role.family = 'claude'
  })
  assert.equal(problemOf(chooseRoute({ settings, role: 'reviewer', reviewed: { model: 'claude-opus-4.7' } })),
    'no reviewer family differs from anthropic; add one to reviewerFamilies in crew.yaml')
  assert.equal(problemOf(chooseRoute({ settings, role: 'reviewer', reviewed: { family: 'claude' } })),
    'no reviewer family differs from claude; add one to reviewerFamilies in crew.yaml')
  assert.equal(routeOf(chooseRoute({ settings, role: 'reviewer', reviewed: { model: 'gpt-4.1' } })).family, 'claude')
})

test('whatever the families are called and however the reviewed model is spelled, the reviewer shares no vendor and no family with it', () => {
  const namings: Array<Record<string, [string, string]>> = [
    { claude: ['claude-opus-5.5', 'claude-sonnet-5.5'], gpt: ['gpt-6.1-sol', 'gpt-5.6-sol'] },
    { a: ['claude-opus-5.5', 'claude-sonnet-5.5'], b: ['gpt-6.1-sol', 'gpt-5.6-sol'], c: ['gemini-3-pro', 'gemini-3-flash'] },
    { anthropic: ['gpt-6.1-sol', 'gpt-5.6-sol'], openai: ['claude-opus-5.5', 'claude-sonnet-5.5'] },
    { 'claude-x': ['claude-opus-5.5', 'claude-sonnet-5.5'], 'claude-y': ['claude-haiku-9', 'claude-haiku-8'], gpt: ['gpt-6.1-sol', 'gpt-5.6-sol'], mixed: ['claude-m', 'gpt-m'] },
  ]
  const reviewedModels = [...UNLISTED_CLAUDE, ...UNLISTED_GPT, 'gemini-3-pro', 'grok-4', 'claude-opus-5.5', 'gpt-5.6-sol', 'claude-m', 'gpt-m', 'claude-haiku-9']
  let accepted = 0
  for (const naming of namings) {
    const names = Object.keys(naming)
    for (const order of [names, [...names].reverse()]) {
      const settings = settingsOf((document) => {
        document.families = Object.fromEntries(Object.entries(naming).map(([name, [strong, mid]]) => [name, { strong, mid }]))
        document.reviewerFamilies = order
        for (const role of Object.values(document.roles) as any[]) if (role.family !== undefined) role.family = names[0]
      })
      for (const model of reviewedModels) {
        for (const family of [undefined, 'anthropic', 'openai', 'google', ...names]) {
          for (const override of [undefined, ...offeredModels(settings), 'claude-opus-4.7', 'gpt-4.1']) {
            const result = chooseRoute({ settings, role: 'reviewer', reviewed: { model, family }, override })
            if (!result.ok) continue
            accepted++
            const label = `${names.join(',')} / ${order.join(',')} reviewing ${model} (${family}) override ${override}`
            const reviewedVendors = new Set<string>([...vendorsOf(model)])
            const routeVendors = vendorsOf(result.route.model)
            for (const vendor of routeVendors) assert.ok(!reviewedVendors.has(vendor), `${label}: both are ${vendor}`)
            // A model the file lists is in the family that lists it. (For one it doesn't, familyOf says a vendor, which is no family of the file.)
            if (offeredModels(settings).includes(model)) assert.notEqual(result.route.family, familyOf(model, settings), label)
            if (family !== undefined) assert.notEqual(result.route.family.toLowerCase(), family, label)
            // Nothing in the chosen family is the reviewed vendor either.
            for (const listed of offeredModels({ ...settings, families: { [result.route.family]: settings.families[result.route.family]! } })) {
              for (const vendor of vendorsOf(listed)) assert.ok(!reviewedVendors.has(vendor), `${label}: family ${result.route.family} holds ${listed}`)
            }
          }
        }
      }
    }
  }
  assert.ok(accepted > 200, `only ${accepted} routes were ever accepted`)
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
        const result = chooseRoute({ settings: SETTINGS, role, override, reviewed: { family: reviewedFamily } })
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
    problemOf(chooseRoute({ settings: SETTINGS, role: 'reviewer', reviewed: { family: 'anthropic' }, override: 'claude-opus-5.5' })),
  ]
  for (const problem of problems) {
    assert.ok(problem.length > 30, problem)
    assert.ok(!problem.includes('undefined') && !problem.includes('[object'), problem)
  }
})
