/**
 * The agent tools of dish-config: `config_read`, `config_list`, `config_write` and `config_propose`.
 *
 * - Only the main agent has them. Every tool checks who is calling before it does anything else, so a child that
 *   somehow got hold of one (a missing tool filter, a stale registry) is still refused.
 * - Reading follows the namespaces' `agent` policy here (`none` is invisible to an agent). Writing and proposing are
 *   the store's to enforce (`FORBIDDEN`), and are not checked a second time.
 * - A store refusal reaches the model as an `Error` whose message starts with the code (`CONFLICT: ...`), so it can
 *   tell a conflict to re-read and redo from a secret to remove. The store's messages never carry document text.
 * - Models fill every optional parameter, often with `''`, so an empty `note` or `base` is taken as absent.
 *
 * @module dish-config/tools
 */

import type {} from '@deepseek-ai/dsh-agent'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ConfigStoreError } from './store/errors.ts'
import type { NamespaceRegistry } from './store/namespaces.ts'
import type { Change, ConfigStore, EditAuthor } from './store/store.ts'

/** What the tools need of the store: the `dishConfig` service has all of it. */
export type ToolStore = Pick<ConfigStore, 'head' | 'read' | 'list' | 'write' | 'propose'>

const MAIN_ONLY = 'config tools are for the main agent only; ask the main agent to make this change'
/** The longest path a message quotes. */
const SHOWN_PATH_CHARS = 80

/**
 * The author of this call: the main agent of its session.
 * @throws a plain `Error` unless the caller is a top-level agent (no `delegationDepth`, or zero).
 */
function mainAuthor(exec: ToolRunContext): EditAuthor {
  const header = exec.agent?.session?.header
  if (header === undefined) throw new Error(MAIN_ONLY)
  const depth: unknown = header.delegationDepth
  if (depth !== undefined && depth !== 0) throw new Error(MAIN_ONLY)
  return { kind: 'agent', sessionId: header.id, role: 'main' }
}

/** Run `body`, turning a store refusal into an `Error` that starts with its code. Anything else passes through. */
async function guarded<T>(body: () => Promise<T>): Promise<T> {
  try {
    return await body()
  } catch (error) {
    if (!(error instanceof ConfigStoreError)) throw error
    throw new Error(error.message === error.code ? error.code : `${error.code}: ${error.message}`, { cause: error })
  }
}

/** A string the model may have left empty: `undefined` for `''` or only whitespace. */
function given(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === '' ? undefined : trimmed
}

function shown(path: string): string {
  return JSON.stringify(path.length > SHOWN_PATH_CHARS ? `${path.slice(0, SHOWN_PATH_CHARS)}...` : path)
}

interface ChangeArg {
  path: string
  text?: string
  delete?: boolean
}

/**
 * The store's changes for the model's: each is exactly one of a `text` (which may be empty) or `delete: true`.
 * `delete: false` is no delete, so a model that fills every field in still gets what it meant.
 * @throws `INVALID` for a change that is both, or neither. The message names the change, never its text.
 */
function toChanges(items: readonly ChangeArg[]): Change[] {
  return items.map((item, index) => {
    const hasText = item.text !== undefined
    const deletes = item.delete === true
    if (hasText === deletes) {
      throw new ConfigStoreError('INVALID', `change ${index + 1} (${shown(item.path)}) has ${hasText ? 'both' : 'neither'}: `
        + 'give exactly one of `text` (the whole new document, which may be empty) or `delete: true`')
    }
    return deletes ? { path: item.path, delete: true } : { path: item.path, text: item.text! }
  })
}

/** The `changes` parameter, which `config_write` and `config_propose` share. */
function changesParameter(what: string) {
  return {
    type: 'array',
    required: true,
    description: `${what} Each change has a \`path\` and exactly one of \`text\` (the whole new content of the document, which may `
      + 'be empty) or `delete: true` (remove the document; leave `text` out).',
    items: {
      type: 'object',
      additionalProperties: false,
      properties: {
        path: { type: 'string', required: true, description: 'The document path, such as `prompts/main.md`. `config_list` shows what exists.' },
        text: { type: 'string', description: 'The whole new content of the document. Leave out when deleting.' },
        delete: { type: 'boolean', description: 'true to delete the document. Leave out when writing.' },
      },
    },
  } as const
}

function text(value: string): [{ type: 'text', text: string }] {
  return [{ type: 'text', text: value }]
}

/**
 * The four tools, over `service` (the store, or the `dishConfig` service) and the namespaces that decide what an agent may see.
 * Exported for tests; the plugin registers them when a `tools` service is there.
 */
export function toolDefinitions(service: ToolStore, registry: Pick<NamespaceRegistry, 'ownerOf'>): ToolDefinition[] {
  /** Whether an agent may see the document at `path`: its namespace allows agents to write or propose there. */
  const visible = (path: string): boolean => {
    const policy = registry.ownerOf(path)?.agent
    return policy === 'write' || policy === 'propose'
  }

  const read = defineTool({
    name: 'config_read',
    description: 'Read one config document (a prompt, a crew definition, ...) as it is on main. '
      + 'Returns its `text`, which is null if there is no such document, and `commit`, the main commit it was read at. '
      + 'Before changing a document, read it, and pass that `commit` as `base` to `config_write`: then a change the user '
      + 'made in the UI in the meantime is reported as a CONFLICT instead of being overwritten. '
      + 'Documents in a namespace that is closed to agents are refused (FORBIDDEN). `config_list` shows what exists.',
    parameters: {
      path: { type: 'string', required: true, description: 'The document path, such as `prompts/main.md`.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          text: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: 'The document, or null if there is none.' },
          commit: { type: 'string', required: true, description: 'The main commit this was read at: pass it as `base` to `config_write`.' },
        },
      },
      render: (_args, value) => text(value.text === null
        ? `${value.path} does not exist (main is at commit ${value.commit})`
        : `path: ${value.path}\ncommit: ${value.commit}${value.text === '' ? '\n(empty document)' : ''}\n---\n${value.text}`),
    },
    async execute(args, exec) {
      mainAuthor(exec)
      return guarded(async () => {
        const owner = registry.ownerOf(args.path)
        if (owner === undefined) throw new ConfigStoreError('UNOWNED', `no config namespace owns ${shown(args.path)}`)
        if (owner.agent === 'none') {
          throw new ConfigStoreError('FORBIDDEN', `agents may not read ${shown(args.path)}: the ${owner.owner} namespace is closed to agents`)
        }
        // Two steps on the store's queue: reading at the commit the first one named is what makes `commit` true.
        const commit = await service.head()
        const found = await service.read(args.path, commit)
        return { path: args.path, text: found ?? null, commit }
      })
    },
  })

  const list = defineTool({
    name: 'config_list',
    description: 'List the config documents on main under a prefix: a directory such as `prompts/`, one path, or an empty string for all of them. '
      + 'Returns the `paths` and the `commit` they were listed at. '
      + 'Only documents you may read or change appear; documents in a namespace that is closed to agents are left out.',
    parameters: {
      prefix: { type: 'string', required: true, description: 'A directory such as `prompts/`, or one path. An empty string lists everything you may see.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          paths: { type: 'array', required: true, items: { type: 'string' } },
          commit: { type: 'string', required: true, description: 'The main commit this was listed at.' },
        },
      },
      render: (_args, value) => text(value.paths.length === 0
        ? `no documents (main is at commit ${value.commit})`
        : `commit: ${value.commit}\n${value.paths.join('\n')}`),
    },
    async execute(args, exec) {
      mainAuthor(exec)
      return guarded(async () => {
        const commit = await service.head()
        const paths = await service.list(args.prefix, commit)
        return { paths: paths.filter(visible), commit }
      })
    },
  })

  const write = defineTool({
    name: 'config_write',
    description: 'Commit changes to config documents straight to main, as one commit. '
      + 'Use this ONLY for a change the user asked you to make in this conversation. '
      + 'For anything you initiate yourself, use `config_propose`: the user reviews it first. '
      + 'Read each document with `config_read` first and pass the `commit` it returned as `base`. '
      + 'If any of the documents changed since (the user may have edited one in the UI), the write fails with CONFLICT and writes nothing: '
      + 'read again, then redo the change from what is there now. '
      + 'In a namespace where agents may only propose, a write fails with FORBIDDEN: use `config_propose`. '
      + 'Never put credentials in a document: it is refused (SECRET). '
      + 'Returns the new `commit` and the `paths` it changed; `commit` is null, and `paths` empty, when the documents already held that content.',
    parameters: {
      changes: changesParameter('The changes, committed together or not at all.'),
      note: { type: 'string', description: 'Optional: one line saying why, shown in the history. Leave empty for none.' },
      base: {
        type: 'string',
        description: 'The `commit` that `config_read` returned for the document(s) you are changing, in full. Optional but strongly recommended: '
          + 'without it a change made since your read is overwritten silently. Leave empty for none.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          commit: { oneOf: [{ type: 'string' }, { type: 'null' }], required: true, description: 'The new commit, or null if nothing changed.' },
          paths: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => text(value.commit === null
        ? 'no change: the documents already hold that content, so nothing was committed'
        : `committed ${value.commit}: ${value.paths.join(', ')}`),
    },
    async execute(args, exec) {
      const author = mainAuthor(exec)
      return guarded(async () => {
        const changes = toChanges(args.changes)
        const note = given(args.note)
        const base = given(args.base)
        const info = await service.write(changes, {
          author,
          ...(note === undefined ? {} : { note }),
          ...(base === undefined ? {} : { base }),
        })
        return info === undefined ? { commit: null, paths: [] } : { commit: info.id, paths: info.paths }
      })
    },
  })

  const propose = defineTool({
    name: 'config_propose',
    description: 'Propose changes to config documents without applying them: the user reviews the proposal and accepts or rejects it in Settings, History. '
      + 'Nothing changes on main until they accept. '
      + 'Use this for any change you initiate yourself, and wherever `config_write` is FORBIDDEN. '
      + 'The title and rationale are what the user reads, so say what changes and why. '
      + 'If the user tells you a proposal went STALE (the documents changed on main after you made it), read them again and open a fresh proposal. '
      + 'Never put credentials in a document: it is refused (SECRET). '
      + 'Returns the `proposal` id and the `paths` it changes.',
    parameters: {
      title: { type: 'string', required: true, description: 'One line naming the change.' },
      rationale: { type: 'string', required: true, description: 'Why you propose it, in as many lines as it takes. May be empty.' },
      changes: changesParameter('The changes the proposal makes, applied together if accepted.'),
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          proposal: { type: 'string', required: true, description: 'The proposal id.' },
          paths: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => text(`opened proposal ${value.proposal} for ${value.paths.join(', ')}. `
        + 'Nothing changes until the user accepts it in Settings, History.'),
    },
    async execute(args, exec) {
      const author = mainAuthor(exec)
      return guarded(async () => {
        const changes = toChanges(args.changes)
        const info = await service.propose(changes, { author, title: args.title, rationale: args.rationale })
        return { proposal: info.id, paths: info.paths }
      })
    },
  })

  return [read, list, write, propose]
}
