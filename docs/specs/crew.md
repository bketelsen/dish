# Spec: the crew (`dish-crew`)

Status: implemented 2026-10-01 (branch `crew`). Implements roadmap step 4. Builds on the [design](../design.md) (the crew, the reviewer rule), the [config store](config-store.md), [prompts](prompts.md), the 2026-09-30 spike (`plugins/crew`, design "Spike results") and the [agent-team research](../research/2026-10-01-dsh-agent-team.md).

## Summary

`dish-crew` lets the main agent hand work to a fixed crew of specialists, keeping the conversation open while they run.
- **One tool, `delegate`,** starts a child in a role, or sends a fix round to a child it already started. Each child gets its role's prompt from `dishPrompts`, its role's tools, and a model from its role's tier.
- **The reviewer always runs on a different model family** from the work it reviews. The harness enforces this.
- **`crew.yaml`** in the config store holds the roles, tiers, models and limits. The main agent edits it when you ask, and you review it in History.
- **The harness records what happens.** It keeps its own record of every delegation and saves every child's final report as runtime data. When a child finishes, the notice names its role and model and includes its error, if any.
- **The dish preset moves into this bundle.** `delegate` exists only there.

## Decisions (from the 2026-10-01 discussion)

| Topic | Decision |
|---|---|
| Models | Strong: `gpt-6.1-sol` / `claude-opus-5.5`. Mid: `gpt-5.6-sol` / `claude-sonnet-5.5`. All on `github-copilot`. |
| Families | Coders are Claude, reviewers are GPT. A reviewer can never share the family of the work it reviews. |
| Tools | Per role (table below). No child gets `delegate`, dsh's own delegation tools, or anything meant only for the main agent. |
| Research results | A child's final message is its report. It comes back to the main agent, which can save it anywhere. Crew also saves every report as runtime data, so nothing depends on the main agent remembering to. |
| One directory until step 6 | One writing child at a time. Read-only roles run in parallel. At most 4 running at once. 30 delegations per session. |
| Fix rounds | Children are continuable. The main agent sends review findings to the same child. The escalation ladder belongs to `orchestrator` (step 7). |
| Editing config | `crew.yaml`, written by the agent when you ask and reviewed in History. A settings page comes later. |
| Seeing the crew | dsh's existing subagent tree in the session header. Crew writes labels that show role and model, and notices that carry the outcome. See [Seeing the crew](#seeing-the-crew) for why this replaces a separate panel. |

## Non-goals

- Worktrees and per-repo gates (step 6), and the pipeline and escalation ladder (step 7).
- Nested delegation. Children never delegate.
- A settings page for crew, and budgets beyond the runaway caps.
- Building on dsh's experimental agent teams (see the research note).

## What dsh gives us (checked in 0.2.0-rc.2)

- **`ctx.subagents.startContinuable({ provider, label, request })`.** `request` carries `prompt`, `parent`, `persona` (a string that shadows the persona prefix for that child), `toolFilter` (`{ allow?, deny? }`), `agentOptions` (`{ provider, model, reasoningEffort, maxTokens }`) and `maxDepth`. All of these are stored in the child's descriptor and reapplied when the child is reloaded.
- **`ctx.subagents.sendMessage(sender, childId, content)`.** A running child gets the message at its next step. An idle child starts a turn. A settled child is reloaded from disk.
  - The text is prefixed "Agent <parent> sent a message: ".
  - The standard preset's `send_message` tool does the same for the model, in both directions.
- **Finish notices** are fixed text: "Background subagent <id> finished …", the stop reason and the closing message. They have no label, role, model or error.
  - A parent's `agent/pre-step` waterfall can rewrite them. They're user messages whose `source.kind` is `subagent-settled`.
- **A note appended to a continuable child's task.** `startContinuable` adds a text block after `request.prompt`, only when the child's `send_message` is the standard one. It tells the child its parent's agent id, to send its result to the parent with `send_message` before it finishes, and to send earlier messages too when a finding changes what the parent should do. It lives in `withContinuableReturnGuidance` in `@deepseek-ai/dsh-subagent` (`lib/index.js`, used by the continuable start path), and a follow-up gets none. It is the opposite of how the crew reports, so crew puts a note of its own in front of it and refuses the send (both under [Report guard](#report-guard)). Re-check them when dsh is upgraded: if the note changes or goes, the crew's note and the guard's texts should change with it.
- **`subagent/end`** gives `{ id, stopReason, lastAssistantMessage }` each time a child finishes a run. `agent/error` gives a live child error.
- **Tool filters** throw if they name a tool the child can't see, and they're reapplied on reload.
- **No custom session-log events.** dsh refuses to reload a session whose log contains an event type it doesn't know, so a plugin outside dsh can't journal into the session log the way agent-team does.
- **No per-child working directory.** Children inherit the parent's `cwd`.
- **The header already lists children.** `dsh-client-ui-subagent` shows them in the session header, with their label, a running or finished dot, duration and tokens, and click-through to the child's session.

## `crew.yaml`

A document in the config store, claimed by `dish-crew` with agent policy `write`, and seeded once. It's YAML because that's comfortable to read in diffs and History; it's parsed with `js-yaml`, which is already in dsh's dependency tree and is declared as a dependency.

```yaml
provider: github-copilot
families:                 # model ids per family and tier; a family's models identify it
  anthropic: { strong: claude-opus-5.5, mid: claude-sonnet-5.5 }
  openai:    { strong: gpt-6.1-sol,     mid: gpt-5.6-sol }
reviewerFamilies: [openai, anthropic]   # the reviewer takes the first one that isn't the reviewed work's
limits:
  running: 4              # crew children running at once, per session
  writers: 1              # of those, roles with writes: true
  perSession: 30          # delegations a session may start, ever
roles:
  architect:  { tier: strong, family: anthropic, writes: true,  tools: [read, glob, grep, write, edit, web_search, web_fetch, skill, todo_write, send_message, ask_judge] }
  coder:      { tier: mid,    family: anthropic, writes: true,  tools: [read, glob, grep, write, edit, bash, job_output, job_list, job_kill, web_fetch, skill, todo_write, send_message, ask_judge] }
  reviewer:   { tier: mid,    reviews: true,                    tools: [read, glob, grep, bash, job_output, job_list, job_kill, web_fetch, skill, todo_write, send_message, ask_judge] }
  researcher: { tier: mid,    family: anthropic,                tools: [read, glob, grep, web_search, web_fetch, skill, todo_write, send_message, ask_judge] }
  ops:        { tier: mid,    family: anthropic, writes: true,  tools: [read, glob, grep, write, edit, bash, job_output, job_list, job_kill, web_search, web_fetch, skill, todo_write, send_message, ask_judge] }
  writer:     { tier: mid,    family: anthropic, writes: true,  tools: [read, glob, grep, write, edit, web_search, web_fetch, skill, todo_write, send_message, ask_judge] }
```

**With direct API keys, a family can have a provider of its own.** The shipped file sends both families through the top-level `provider`, because Copilot serves Claude and GPT alike. With direct keys, Claude comes through an `anthropic` provider and GPT through an `openai` one, so each family says so, next to its tiers. A family without a `provider` runs on the top-level one, which stays required. This is an alternative example, not the shipped file; the `limits` and `roles` are as above.

```yaml
provider: anthropic       # required: the provider of any family that doesn't have its own
families:
  anthropic: { provider: anthropic, strong: claude-opus-5.5, mid: claude-sonnet-5.5 }
  openai:    { provider: openai,    strong: gpt-6.1-sol,     mid: gpt-5.6-sol }   # ids as that provider's API names them
reviewerFamilies: [openai, anthropic]
```

**Validation** (the namespace's `validate`, so neither an agent nor the store can save a broken file):
- **Well-formed:** valid YAML with exactly this shape. Families must name both tiers, and may name a `provider`, which is checked like the top-level one: a non-empty string with no whitespace around it. A model id may not be another model's `provider/model` name, since a listing and a `model` override would then mean different models. Tiers are `strong` or `mid`. Limits are positive integers, with `writers ≤ running`.
- **Role names** follow the prompts grammar. Each role needs a prompt: a shipped default or a document under `prompts/crew/`. That's checked when delegating, not at save, because the prompts plugin owns those documents.
- **`reviews: true`** marks the reviewer: it has no fixed `family`, and its family comes from `reviewerFamilies`. Exactly one role may set it.
- **Tools** are names only. A name the child can't see when it starts is left out at that moment (see [Tools](#tools)), so the file never makes a delegation fail.
- Unknown keys are refused, so typos don't silently do nothing.

A missing or unreadable `crew.yaml` falls back to the shipped default, with one logged warning.

## The `delegate` tool

Registered by the row `dish-crew/delegate` inside the dish preset, so only agents on that preset see it. Children get it filtered out.

```text
delegate({
  role,            // a role in crew.yaml
  title,           // 3–6 words; the child's label shows it
  task,            // the complete, self-contained brief
  to?,             // an existing crew child's id: send it this task as a follow-up (fix round) instead of starting a new child
  reviews?,        // reviewer only: the crew child id whose work is reviewed, or "main" for the main agent's own work
  model?,          // optional override, a model id from crew.yaml's families; not allowed to break the reviewer rule
})
→ { child, role, model, label }
```

Empty strings are treated as absent. The checks run in this order, before anything starts, and each failure is an error the model can act on:

1. **Caller.** Only a top-level agent may delegate (`isTopLevelAgent`).
2. **Role.** It must exist in `crew.yaml` and have a prompt (`dishPrompts.persona(role)`).
3. **Follow-up (`to`).** The child must be one this session started, in the same role. A follow-up uses no new delegation. It's checked against the running and writer limits counting every other child, not itself: a follow-up to a running child adds no running child.
4. **Limits.**
   - **Running:** the count of this session's crew children that are running now (`ctx.agents.get(id)?.status === 'running'`) must be under `limits.running`.
   - **Writers:** if the role `writes`, the count of running writing children must be under `limits.writers`.
   - **Per session:** a new child must keep the session's total under `limits.perSession`. The total is counted from the [record](#the-record), so it survives a restart.

   Each refusal says who's running and what to do: "a coder is running (child X, 'add login'); wait for its notice, or delegate a read-only role."
5. **Model.**
   - **Non-reviewers:** the role's `family` and `tier`, unless `model` names another model in `crew.yaml`'s families.
   - **The provider** of a route is its family's `provider`, or else the top-level one. An override takes the provider of the family its model is in, since a model is in one family only. `model` is the bare id; for a family with a provider of its own it may also be `provider/model`, which is how the refusals list the models.
   - **The reviewer:** `reviews` is required. Its family is the first in `reviewerFamilies` that isn't the reviewed work's family, and that lists no model from the reviewed work's vendor. The exclusion is by vendor as well as by family name, so a model missing from the file whose id names its vendor, or renamed families, can't put Claude on Claude. That's the family of the reviewed child's recorded model, or of the main agent's own model for `"main"`. A `model` override is accepted only if its family is also different. A model the file doesn't list, whose id names none of the ten known vendors (Claude, GPT, Gemini, Grok, Qwen, DeepSeek, Kimi, GLM, Llama, Mistral), is its own family: it excludes nothing, so the first of `reviewerFamilies` reviews it and an override in any family is accepted. That's an accepted risk for an alias that hides its vendor ([Notes from the build](#notes-from-the-build)).
6. **Route check.** `ctx.llm.resolveCallConfig({ provider, model, reasoningEffort })` must resolve. On failure, the error lists the models `crew.yaml` offers, as `provider/model` for each family that has a provider of its own, so the model can see where each runs.
7. **Start or send.**
   - **Start:** `startContinuable` with:
     - `label`: `<role> · <model> · <title>`;
     - `prompt`: the task, and, if the child has `send_message`, a second text block that says its closing message is its report (see [Report guard](#report-guard));
     - `persona`: `dishPrompts.persona(role).prefix`, so the child keeps that text for life; under the dish preset the persona row adds `common.md` and renders variables;
     - `toolFilter`: `{ allow }` (see [Tools](#tools));
     - `agentOptions`: the route;
     - `maxDepth: 1`.
   - **Follow-up:** `ctx.subagents.sendMessage(parent, to, task)`.

   Either way, the record is written.

**`send_message`** stays available for quick questions in both directions: a child asking the main agent something, or the main agent nudging a child. A crew child can't use it to send its report: a long message is refused, and `send_message` is then closed to that child until its run ends (see [Report guard](#report-guard)). The limits are enforced on `delegate` only. The main agent's prompt says fix rounds go through `delegate` with `to`, not `send_message`. While everything shares one directory, the writer rule depends on that prompt; step 6's worktrees make it moot.

## Tools

A child's allow list is its role's `tools` from `crew.yaml`, intersected with the tools the parent can see when the child starts.
- A tool that's missing then, such as `bash` on Windows (where it's `pwsh`) or `read_image` without attachments, is dropped, not an error.
- **`ask_judge`** is in every shipped role. It belongs to `dish-judge`, which registers it as a global tool, so children inherit it. Without `dish-judge` installed no such tool exists, so the name is dropped like any other missing one: the child starts with the rest of its role. A role whose only tool is `ask_judge` is the "no tools" refusal below.
- `pwsh` is added wherever `bash` is listed.
- Whatever the file says, a child never gets these, even if a role lists them: `delegate`, `subagent`, `subagent_fork`, `subagent_codex`, `subagent_claude_code`, `list_subagent_models`, `workflow`, `ralph`, `interrupt_agent`, `list_agents`, `ask_user_question`, `create_goal`, `update_goal`, `exit_plan_mode`, `present`, or dsh's reserved `run_code`.
- "Tools the parent can see" means tools the child can inherit: those in the parent's preset and global layers, not tools installed on the parent agent's own scope (such as dsh-schedule's), which dsh won't let a child's filter name. Children can't ask you anything: dsh runs them with approval policy `never`.
- **A crew child's approvals are refused when `dish-judge` isn't loaded.** [`dish-judge`](judge.md) switches crew's children to approval policy `ask` and answers their requests itself; it puts `never` back on the live ones when it unloads. A child that settled keeps `ask` in its log and is resumed at `ask` by a follow-up. If `dish-judge` is absent then (disabled, uninstalled, failed to load, or a restart without it), dsh would put the child's request to the browser, which shows it in the child's own session and has no time limit. So crew registers an `approval/request` listener, prepended, that does nothing when `dishJudge` is there, and otherwise returns `rejected` for a request from a child that isn't top-level and that crew's record knows (also `rejected` if the record can't be read within 2 s). Anything else goes on to `next()`.

The list is stored in the child's descriptor. So if a tool is later removed from the dish preset, older children that were allowed it may no longer reload. That's dsh's behavior, noted in the README.

### Report guard

A crew child reports once, in its closing message. Two things make it so: a note at the start of the child's task, and a guard that refuses the other way.

- **Why.** `dsh web` shows only a turn's last message and folds everything before it. A child that sends its findings with `send_message` and then finishes gives the main agent two deliveries: the message, and the finish notice with the closing message. The main agent answers in two steps, and the fuller answer is the one that gets folded. The crew prompts say not to ("report once, in your closing message"), and some models do it anyway, because dsh appends a note to the child's task that says the opposite (see [What dsh gives us](#what-dsh-gives-us-checked-in-020-rc2)). Prompts alone lose, so the call is refused where it is made.
- **The delegate note.** When `delegate` starts a child that has `send_message` in its allow list, the child's prompt is the task and then a second text block: its closing message is its report, the main agent receives it in full automatically, so it should not send its result with `send_message`, not even a summary or part of it, even though the note after this one says to; `send_message` is for a short question it is blocked on. dsh adds its note under the same condition, after ours. A follow-up (`to`) gets nothing added, as dsh adds nothing to it.
- **The guard.** crew registers a `tools/pre-execute` listener on the host. The checks, in this order and cheapest first:
  1. the tool is not `send_message`: `next()`;
  2. the agent is top-level (`isTopLevelAgent`): `next()`. The main agent briefs and nudges its children as long as it likes;
  3. the agent was refused earlier in this run: refused again (see below), whatever it sends;
  4. `message` is not a string, or is at most `messageLimit` characters (JS string length): `next()`. `exec.arguments` is dsh's parsed object, and a message that isn't a string is the tool's to refuse;
  5. the agent has no id: `next()`;
  6. the record is asked, last, and only for a long message from a non-top-level agent: a child crew did not start is `next()`; a crew child is refused and held.
- **What the child reads.** The first refusal is a tool error: the message is its result, its closing message is its report and reaches the main agent in full when it finishes, whatever its task says about `send_message`; resending it shorter or in parts is pointless, because `send_message` is closed to it until it finishes; finish and write the report as the closing message, and if it was a question, put that in the closing message and the main agent will follow up. **It names no length and no limit**: a budget invites the child to shorten or split the message and send it again, which satisfies dsh's note and brings the two deliveries back.
- **The hold.** The refusal is sticky. Any later `send_message` of that child in the same run is refused, short or not, with a shorter text: closed because its report was refused once, put everything in the closing message, and finish. The guard can't tell a report in pieces from a question, so a child gets one refusal and then no sends. The ids are kept in a bounded set (256, oldest out) of children the record has vouched for, so the check costs no read. crew's `subagent/end` listener opens it for that child, so a follow-up run (`delegate` with `to`) can ask a question again. A restart, or an end that is never heard, loses the hold and not the refusal: the child's next long message is refused as before.
- **The limit.** `messageLimit` on the `dish-crew` row, a natural number, default 1200: a question is a few sentences, a report is not. `0` turns the guard off.
- **It fails open.** If the record can't be read, or takes more than 2 s, the message goes through, with one logged warning for each distinct problem. The approval guard refuses in that case, and for the opposite reason: there the other outcome is a child hung on a prompt nobody sees; here it is a message delivered, which is harmless. And the record is read for any long message from any non-top-level agent, so failing closed would refuse other plugins' children whenever crew's disk is broken, and a real question refused for a slow disk leaves a child unable to ask for what it is blocked on.
- **Where it stands.** It is registered on the host, **prepended**, before the plugin awaits anything. A refusal does not call `next()`, so no later `tools/pre-execute` listener hears of the call: no `PreToolUse` hook, no dsh auto-review classifier (an LLM call) and no workspace-changes recorder, which is the rule dish-judge's own gate follows. The `tools/result` listeners still see the error. dish-judge's gate is prepended as well, and which of the two is first makes no difference for `send_message`: the judge doesn't gate it by default (`tools.gated` is `bash` and `pwsh`) and calls `next()` for what it doesn't gate; when it does gate it, it calls `next()` for an allow or an ask and keeps the stricter answer, which is our deny.

## The dish preset

It moves here from `dish-prompts`, as `presets/dish.patch.yml`, still generated from the installed dsh's `standard` preset by `pnpm --filter dish-crew sync-preset`, with the drift test. Against `standard`, it:
- **swaps in our persona row:** the stock persona row becomes `dish-prompts/persona` (`role: main`), as now;
- **adds `delegate`:** the row `dish-crew/delegate`;
- **removes dsh's own delegation:** the rows for `subagent`, `subagent_fork`, `workflow` and their engine. The main agent delegates through crew only, which is structural rather than a prompt request. It keeps `send_message`, `interrupt_agent` and `list_agents`.

`dish-prompts` keeps its persona row and loses the preset. `dish-crew` depends on `dish-prompts` and `dish-config`. Without `dish-prompts`, the persona row logs once and `delegate` refuses every call, naming the missing plugin; nothing refuses at load. `orchestrator` takes the preset over in step 7.

## Notices and labels

- **Labels:** `<role> · <model> · <title>`, so dsh's subagent tree in the header shows who's doing what on which model.
- **Finish notices:** the `dish-crew/delegate` row registers an `agent/pre-step` listener for the preset's agents. It rewrites each `subagent-settled` message from a crew child into this, keeping the child's closing message as is:

  > coder «add login» (claude-sonnet-5.5) finished. Report: `$XDG_DATA_HOME/dish/crew/…/3-coder.md`. Its closing message: …

  On failure:

  > coder «add login» (claude-sonnet-5.5) failed: <stop reason> — <the child's last error, from `agent/error`>. Report: … Its closing message: …

  Messages from children crew didn't start pass through untouched.

## The record

Crew keeps its own runtime record, because the session log can't hold custom events. It lives in `$XDG_DATA_HOME/dish/crew/`: `sessions/<sha256(parent session id)>/` per session, and `by-child/<sha256(child id)>` pointers so a child's runs are filed after a restart. Each session directory holds:
- **`children.json`** names its session and lists, per child: `id`, `n` (its order in the session), `role`, `title`, `model`, `family`, `reviews`, `startedAt`, `followUps`, `runs[]` (`{ endedAt, stopReason, error?, report }`) and `last` (status).
  - It's written atomically: a temp file, then rename.
  - It's the source for limits, the reviewer rule, and notices.
- **`<n>-<role>-<run>.md`** holds the child's closing message from each run, captured on `subagent/end`. A child is marked running on every `subagent/start` (a first start, a wake or a resume), so a child woken by `send_message` still counts toward the limits.
- **Deleting old records:** session directories not written to for 180 days are pruned at startup.

The notice gives the report's path. The main agent decides whether to promote a report into a repo's docs or, later, the memory vault.

## Seeing the crew

dsh already puts a subagent tree in the session header, through `dsh-client-ui-subagent`. It shows each child's label, a running or finished dot, duration and tokens, and click-through to the child's session. With crew's labels, it answers "who's running, in what role, on which model".

What it lacks (the stop reason, the error, the report) is in each finish notice in the chat. So this step builds no separate panel. A crew view with the record's details belongs with the inbox and the Families page (step 8), and can read the record through a remote then.

## Prompt changes

Both changes are made to the shipped defaults. Seeding never overwrites, so your stored copies stay as they are. The install step resets them, as you, through the Prompts page or the store, after checking they still match the old defaults. If you've edited them, it proposes the change instead.
- **`main.md`:**
  - After delegating, end your turn; you'll be notified when the child finishes. This is from the spike: without it, the agent busy-polls.
  - Fix rounds go through `delegate` with `to`.
  - Reviews name what they review with `reviews`.
  - Reports are saved for you; promote the ones worth keeping.
- **Crew roles:** if you're blocked or need a decision, ask the main agent with `send_message`. Otherwise report once, at the end, in your closing message.

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-crew` | `dataDirectory` | `$XDG_DATA_HOME/dish/crew` | Where records and reports go. |
| `dish-crew` | `subagentProvider` | `spawn` | The `ctx.subagents` provider for children. |
| `dish-crew` | `messageLimit` | `1200` | The most characters a crew child's `send_message` may have before it is taken for a report and refused, which closes `send_message` to that child until its run ends; `0` turns the report guard off. |
| `dish-crew` | `terminal` | `true` | Print this plugin's messages. |
| `dish-crew/delegate` | — | | The preset row: the tool, the notice rewriter. |

Roles, models and limits live in `crew.yaml`, not here.

## Testing

`node --test`, with a real config store and the prompts plugin in temp directories:
- **`crew.yaml`:** validation (every refusal), the default, and the fallback when missing.
- **Model choice:** tier and family, overrides, and the reviewer rule (coder Claude → reviewer GPT; coder GPT by override → reviewer Claude; `reviews: "main"` on either family; an override that breaks the rule is refused).
- **Limits:** running, writers, per session, and the per-session count after a restart. Use a stub `subagents` service that reports running children.
- **Follow-ups (`to`):** the role must match, the limits apply, and `sendMessage` is called.
- **Tool lists:** intersection with visible tools, the pwsh swap, and the never-list.
- **The record:** atomic writes, reports captured on `subagent/end`, errors from `agent/error`, and pruning.
- **The report guard:** other tools, the main agent, short messages and non-crew children pass; a long message from a crew child is refused, with no number in the reason, at the limit exactly and one over; the child's later messages are refused too, until `subagent/end` for it, and other children are not; the set of held children is bounded; an unreadable or slow record lets a message through with one warning; `0` turns it off; and through the real tool registry, with the plugin's `messageLimit`, a refused call reaching no earlier-registered listener, and the plugin's `subagent/end` listener opening the child again.
- **The delegate note:** a new child with `send_message` gets the task and then the closing-message note; one without it, or whose parent can't give it, gets the task alone; a follow-up sends the task alone.
- **The notice rewrite:** a crew child finished, a crew child failed, and a non-crew child left untouched.
- **The preset generator:** the drift test, and the removed delegation rows.

**Live,** on the real install:
1. Delegate a researcher, then a coder: the labels show in the header, and each notice names its role and model.
2. Start a second coder while one runs: refused, with a clear message.
3. Review the coder: the reviewer runs on GPT.
4. Send a fix round with `to`: the same child continues.
5. Restart dsh and resume: the record and the limits hold.

## For later steps

- **Step 6 (workspaces):** children can't have their own working directory in dsh 0.2.0-rc.2. They inherit the parent's `cwd`, and `workspace-write` limits writes to the session workspace. Worktrees per task will need to live inside the workspace, or wait for an upstream option. A per-child `cwd` in `startContinuable` would be a reasonable upstream proposal.
- **Upstream:** finish notices with the child's label and error, and journaling custom session events from outside dsh, would each remove a workaround here.

## Notes from the build

- **The running rule.** A child counts as running when dsh says it's running, or when the record says `running` and the agent still exists. The record is marked running on every `subagent/start`, so a child woken by `send_message` counts too.
- **The reviewer rule excludes by vendor as well as family name.** A model missing from `crew.yaml` whose id names its vendor, renamed families, or provider-qualified ids (`github-copilot/claude-…`, `us.anthropic.claude-…`) can't put a reviewer on the reviewed work's vendor. `reviews` can't name a reviewer child, and a follow-up to a reviewer is re-checked against the reviewed work as it is now.
- **A model of no known vendor is its own family.** The vendors are told by model id: `anthropic`, `openai`, `google`, `xai`, and (since 2026-10-02, friction) `alibaba` (qwen, qwq), `deepseek`, `moonshot` (kimi), `zhipu` (glm, chatglm), `meta` (llama) and `mistral` (mistral, mixtral, codestral, devstral, magistral, ministral, pixtral). A model that `crew.yaml` doesn't list and whose id names none of them used to be refused (`reviews: "main"` with a local model failed). It is now its own family and excludes nothing; the known vendors behave as before, and `reviews: "main"` with no model to read is still refused. **Accepted risk:** an alias that hides its vendor (`sonnet-x` for a Claude model) can get a reviewer of the same vendor. List it in a family in `crew.yaml` to close that, as before.
- **The reviewer rule reads models, never providers.** A family's `provider` decides where its route runs and nothing else: `vendorsOf` and the family checks look at model ids only, so a provider called `anthropic-proxy` on the `openai` family doesn't make GPT count as Anthropic's. Labels, notices and the record show the model alone, which is one family's, so they are unchanged.
- **Visible tools are the ones a child can inherit:** the parent's preset and global layers, never tools on the parent agent's own scope. dsh's `restrict` refuses those, and a refusal that slips through is turned into "remove X from `roles.<r>.tools`".
- **Services.** The preset row reads everything it doesn't inject through `ctx.get`. A property read of an un-injected service throws in dsh, because the providers are siblings of the row, not ancestors. The tests provide every stub from a sibling plugin, so they'd catch it.
- **Notices.** Each notice is matched to its own run by the report's content and the stop reason dsh's line implies, not by "the latest run". The notice's collapsed summary is role-named too.
- **The preset generator** refuses to emit any enabled row from dsh's delegation packages.
- **Live check (2026-10-01), on the real install:**
  - a researcher on Claude Sonnet 5.5;
  - a coder, with a second coder in the same step refused;
  - a reviewer on `gpt-5.6-sol`;
  - fix rounds to the same coder, including after a dsh restart.

  The records, reports and labels were as specified. It also found a `dish-copilot` catalog bug: Sonnet 5.5 was copied from Sonnet 5 and rejected every request. That's fixed by preferring the closest version of the same vendor.
- **Small follow-up, done in the skills step:** the Prompts remote's `reset` defaults its note to "Reset to the default" itself, as the page does. Before, a reset made through the remote without a note read as an edit in History.
