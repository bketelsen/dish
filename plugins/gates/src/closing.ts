/**
 * The coder's closing message, and the opt-out in it. A coder that is blocked says so at the start of its closing message,
 * and its gate is skipped: a gate run on work the coder says it couldn't do is noise.
 *
 * The message comes from dsh's `session/event`, which a session calls synchronously inside `append`. So the step's
 * `assistant/message` has been seen by the time `agent/turn-stopping` fires, with no read of the log: `snapshotEvents` is
 * deprecated, and dsh's `turnOutline` projection (a `draft` preview) is mounted only by the web profile.
 *
 * What dsh publishes, checked against 0.2.0-rc.2 (`dsh-session`, `dsh-llm`): `session/event(session, event)`, where `session` is
 * the `Session` itself, the same object as an agent's `agent.session`. An `assistant/message` event is
 * `{ type, seq, time, data: { turn, step, message: { role: 'assistant', content: ContentBlock[] }, stream, … } }`, and a
 * block of visible text is `{ type: 'text', text }`. Reasoning and tool calls are other block types. A message can hold no
 * text (reasoning only, only blanks, or a `max-tokens` cut), so the head is the newest message *with* text. Every turn opens
 * with a `turn/start` event, which clears the head: a `BLOCKED:` that closed an earlier turn says nothing about this one.
 *
 * **Tool calls.** Beside the head, it keeps whether the newest `assistant/message` of the turn holds `tool-call` blocks: a
 * coder whose newest message calls tools hasn't finished. dsh-agent-loop (0.2.0-rc.2, `turn()`) keeps a turn's end as
 * `max-tokens` for the rest of the turn once a step is cut, so `agent/turn-stopping` fires after every later step, tool-call
 * steps included; the listener lets those go by. The cut message itself never holds a tool call: dsh-llm's `BlockAssembler`
 * drops the tool calls of a `max-tokens` message, as they can't be run safely. So the stop at the cut is gated, once.
 *
 * **A coder's `report`** (step 7). A crew coder finishes with crew's `report` tool, which records its structured report and
 * concludes its turn. dsh-tools' `tools/result(exec, result)` tells of it (`toolResult`): a successful `report` that concluded
 * the turn keeps its `status` on the session's closing, beside the head and the tool calls the session had. Its message holds
 * the `report` call, so `toolCalls` is true, and its head can be an older message's: the listener goes by the status then, not
 * by either. The order in dsh 0.2.0-rc.2 (`dsh-agent-loop`'s `step()`, `dsh-tools`' `notifyResult`) makes the status the stop's
 * own: the step's `assistant/message` is appended before its tools run, so it can't clear the report it carries; `tools/result`
 * is emitted, synchronously, before the result is committed; `agent/turn-stopping` fires after the step; and the next step's
 * `assistant/message`, or the next `turn/start`, clears the report.
 *
 * @module dish-gates/closing
 */

/**
 * A closing message opts out when its head starts with `BLOCKED:` or `NEEDS CONTEXT:`: after any Markdown marks (`**BLOCKED:**`,
 * `# NEEDS CONTEXT:`), in any case, and `NEEDS_CONTEXT:` counts. A looser match only skips a gate run, and a skip lets nothing
 * through: the review of a skipped run still needs a pass or a ruling.
 */
export const OPT_OUT = /^[\s#>*_`]*(?:BLOCKED|NEEDS[ _]CONTEXT)[*_`]*\s*:/i

/** How much of a closing message is kept: enough for a marker and the marks before it. */
export const HEAD_CHARS = 200

/** Whether a closing message's head opts out. */
export function optsOut(head: string): boolean {
  return OPT_OUT.test(head)
}

/** crew's tool a coder finishes with (dish-crew's `REPORT_TOOL`; dish-gates imports no runtime code of crew's). */
export const REPORT_TOOL = 'report'

/** A coder report's `status` (dish-crew's `CoderStatus`). */
export type ReportStatus = 'done' | 'blocked' | 'needs_context'

/** Every `ReportStatus`, in that order. */
export const REPORT_STATUSES: readonly ReportStatus[] = Object.freeze(['done', 'blocked', 'needs_context'] as const)

/** What `ClosingHeads` keeps of a session's current turn. */
export interface Closing {
  /** The head of the newest assistant message with text, or `''`. */
  head: string
  /** Whether the newest assistant message, text or not, holds `tool-call` blocks: the agent hasn't finished. */
  toolCalls: boolean
  /** The `status` of a successful `report` that concluded the current turn since its newest assistant message; absent when none. */
  report?: ReportStatus
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

const NONE: Closing = Object.freeze({ head: '', toolCalls: false })

/**
 * The closing of each session's current turn: the head of its newest assistant message with text, and whether its newest
 * assistant message holds tool calls. Keyed by the session object, in a `WeakMap`, as dsh's own recorders are: a session
 * that is gone takes its entry with it, and nothing needs disposing.
 */
export class ClosingHeads {
  readonly #closings = new WeakMap<object, Closing>()

  /**
   * An `assistant/message` event: whether it holds tool calls, and, when it has text blocks, the head: their text joined
   * by a newline, leading whitespace dropped, its first `HEAD_CHARS` characters. A message with no text (only tool calls or
   * reasoning, or only blanks) leaves the head before it. Either way the message replaces the entry, so a `report` before it
   * goes. A `turn/start` clears the entry. Anything else is ignored. Never throws: it runs inside a session's append, where
   * dsh would only log a throw, but that event's closing would be lost.
   */
  observe(session: object, event: unknown): void {
    try {
      if (typeof event !== 'object' || event === null) return
      const kind = (event as { type?: unknown }).type
      if (kind === 'turn/start') {
        this.#closings.delete(session)
        return
      }
      if (kind !== 'assistant/message') return
      const data = (event as { data?: unknown }).data
      if (typeof data !== 'object' || data === null) return
      const message = (data as { message?: unknown }).message
      if (typeof message !== 'object' || message === null) return
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) return
      const texts: string[] = []
      let toolCalls = false
      for (const block of content as unknown[]) {
        if (typeof block !== 'object' || block === null) continue
        const { type, text } = block as { type?: unknown, text?: unknown }
        if (type === 'text' && typeof text === 'string') texts.push(text)
        if (type === 'tool-call') toolCalls = true
      }
      const whole = texts.join('\n')
      const head = whole.trim() === '' ? this.closing(session).head : whole.trimStart().slice(0, HEAD_CHARS)
      this.#closings.set(session, { head, toolCalls })
    } catch {
      // a malformed event, or one that throws when read: not a closing
    }
  }

  /**
   * dsh-tools' `tools/result(exec, result)`: a call named `report`, by an agent with a session object, `result.isError === false`,
   * `result.concludesTurn === true`, and `result.value.status` one of `REPORT_STATUSES`: that status becomes the session's
   * `report`, keeping its head and toolCalls. A later one replaces it. Anything else is ignored. Never throws: dsh contains a
   * listener's throw, but the report would be lost.
   */
  toolResult(exec: unknown, result: unknown): void {
    try {
      if (!isObject(exec) || exec.name !== REPORT_TOOL) return
      if (!isObject(result) || result.isError !== false || result.concludesTurn !== true) return
      const agent = exec.agent
      if (!isObject(agent)) return
      const session = agent.session
      if (!isObject(session)) return
      const value = result.value
      if (!isObject(value)) return
      const status = value.status
      if (!REPORT_STATUSES.includes(status as ReportStatus)) return
      const { head, toolCalls } = this.closing(session)
      this.#closings.set(session, { head, toolCalls, report: status as ReportStatus })
    } catch {
      // A malformed call or result, or one that throws when read: no report.
    }
  }

  /** The session's current turn's closing; `{ head: '', toolCalls: false }` when none was seen. */
  closing(session: object): Closing {
    return this.#closings.get(session) ?? NONE
  }

  /** The head the newest message with text in the session's current turn had, or `''` when none was seen. */
  headOf(session: object): string {
    return this.closing(session).head
  }
}
