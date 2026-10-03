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
 * block of visible text is `{ type: 'text', text }`. Reasoning and tool calls are other block types. A step that produced
 * nothing is never appended.
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

/**
 * The head of the newest assistant message with text, per session. Keyed by the session object, in a `WeakMap`, as dsh's own
 * recorders are: a session that is gone takes its head with it, and nothing needs disposing.
 */
export class ClosingHeads {
  readonly #heads = new WeakMap<object, string>()

  /**
   * An `assistant/message` event with text blocks: their text joined by a newline, leading whitespace dropped, its first
   * `HEAD_CHARS` characters. A message with no text (only tool calls or reasoning, or only blanks) leaves the head before it.
   * Anything else is ignored. Never throws: it runs inside a session's append, and a throw there would fail the agent.
   */
  observe(session: object, event: unknown): void {
    try {
      if (typeof event !== 'object' || event === null || (event as { type?: unknown }).type !== 'assistant/message') return
      const data = (event as { data?: unknown }).data
      if (typeof data !== 'object' || data === null) return
      const message = (data as { message?: unknown }).message
      if (typeof message !== 'object' || message === null) return
      const content = (message as { content?: unknown }).content
      if (!Array.isArray(content)) return
      const texts: string[] = []
      for (const block of content as unknown[]) {
        if (typeof block !== 'object' || block === null) continue
        const { type, text } = block as { type?: unknown, text?: unknown }
        if (type === 'text' && typeof text === 'string') texts.push(text)
      }
      const whole = texts.join('\n')
      if (whole.trim() === '') return
      this.#heads.set(session, whole.trimStart().slice(0, HEAD_CHARS))
    } catch {
      // a malformed event, or one that throws when read: not a head
    }
  }

  /** The head the session's newest message with text had, or `''` when none was seen. */
  headOf(session: object): string {
    return this.#heads.get(session) ?? ''
  }
}
