/**
 * The text dish-crew writes: the two small things every refusal does to text it doesn't control (cut a name short, and list
 * names), the block a bound coder's brief gets (`worktreeBrief`), the block a reviewer gets when the main agent overrode
 * the gate of the work it reviews (`gateOverrideBrief`), and what goes between the blocks of a message (`BLOCK_END`).
 *
 * @module dish-crew/text
 */

/**
 * What crew puts after a text block it writes into a message, before the next block: a blank line. dsh's adapters join a
 * message's text blocks with nothing between them (pi-ai's `flattenText` and `userContent`, and deepseek's), so without it
 * a model reads "create ok.txtYour worktree is…". The blocks themselves (`worktreeBrief`, `CLOSING_NOTE`, `noticeText`) stay
 * as they are, byte for byte; only the assembly of a message adds it.
 */
export const BLOCK_END = '\n\n'

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

/**
 * The block added to a bound coder's prompt, after its task and before the closing note: where its worktree is, and that it
 * works only there. dsh gives a child its parent's `cwd` (the chat's workspace, the clone), so this is what points it at the
 * worktree. The one place the block is built.
 *
 * With `gate` (projects.yaml's, which `delegate` reads from `dishGates.gateFor` while dish-gates runs), the block goes on to
 * say that dish runs it when the coder finishes, and how to opt out when blocked. Without one, or with one that has nothing
 * in it, the block is 6b's, byte for byte.
 */
export function worktreeBrief(worktree: { path: string, branch: string }, gate?: string): string {
  const { path, branch } = worktree
  const block = `Your worktree is \`${path}\` on branch \`${branch}\`. Work only there: use absolute paths, and \`git -C ${path}\` or \`cd ${path} &&\` in commands. `
    + 'The main agent\'s own checkout is not yours to change.'
  if (gate === undefined || gate.trim() === '') return block
  return `${block} When you finish, dish runs this project's gate (\`${gate}\`) in your worktree, and a failure comes back to you. `
    + 'If you\'re blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped.'
}

/**
 * The block a reviewer's brief, or a follow-up to it, gets after its task when the main agent overrode the gate of the work
 * it reviews (`delegate`'s `gateOverride`): whose work it is, where its gate stands, and the main agent's ruling, without
 * the `Ruling:` it usually starts with ("with this ruling: Ruling: …" says it twice). The record keeps the ruling as given.
 */
export function gateOverrideBrief(reviewed: string, standing: string, ruling: string): string {
  return `The harness's gate for the work you review (${reviewed}) hasn't passed: ${standing}. The main agent started this review anyway, with this ruling: ${ruling.replace(/^\s*ruling\s*:\s*/i, '')}`
}
