# Spec: the crew (`dish-crew`)

Status: draft, 2026-10-01. Implements roadmap step 4. Builds on the [design](../design.md) (the crew, the reviewer rule), the [config store](config-store.md), [prompts](prompts.md), the 2026-09-30 spike (`plugins/crew`, design "Spike results") and the [agent-team research](../research/2026-10-01-dsh-agent-team.md).

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
  architect:  { tier: strong, family: anthropic, writes: true,  tools: [read, glob, grep, write, edit, web_search, web_fetch, skill, todo_write, send_message] }
  coder:      { tier: mid,    family: anthropic, writes: true,  tools: [read, glob, grep, write, edit, bash, job_output, job_list, job_kill, web_fetch, skill, todo_write, send_message] }
  reviewer:   { tier: mid,    reviews: true,                    tools: [read, glob, grep, bash, job_output, job_list, job_kill, web_fetch, skill, todo_write, send_message] }
  researcher: { tier: mid,    family: anthropic,                tools: [read, glob, grep, web_search, web_fetch, skill, todo_write, send_message] }
  ops:        { tier: mid,    family: anthropic, writes: true,  tools: [read, glob, grep, write, edit, bash, job_output, job_list, job_kill, web_search, web_fetch, skill, todo_write, send_message] }
  writer:     { tier: mid,    family: anthropic, writes: true,  tools: [read, glob, grep, write, edit, web_search, web_fetch, skill, todo_write, send_message] }
```

**Validation** (the namespace's `validate`, so neither an agent nor the store can save a broken file):
- **Well-formed:** valid YAML with exactly this shape. Families must name both tiers. Tiers are `strong` or `mid`. Limits are positive integers, with `writers ≤ running`.
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
3. **Follow-up (`to`).** The child must be one this session started, in the same role. A follow-up uses no new delegation, but it's checked against the running and writer limits like a start.
4. **Limits.**
   - **Running:** the count of this session's crew children that are running now (`ctx.agents.get(id)?.status === 'running'`) must be under `limits.running`.
   - **Writers:** if the role `writes`, the count of running writing children must be under `limits.writers`.
   - **Per session:** a new child must keep the session's total under `limits.perSession`. The total is counted from the [record](#the-record), so it survives a restart.

   Each refusal says who's running and what to do: "a coder is running (child X, 'add login'); wait for its notice, or delegate a read-only role."
5. **Model.**
   - **Non-reviewers:** the role's `family` and `tier`, unless `model` names another model in `crew.yaml`'s families.
   - **The reviewer:** `reviews` is required. Its family is the first in `reviewerFamilies` that isn't the reviewed work's family, and that lists no model from the reviewed work's vendor. The exclusion is by vendor as well as by family name, so a model missing from the file or renamed families can't put Claude on Claude. That's the family of the reviewed child's recorded model, or of the main agent's own model for `"main"`. A `model` override is accepted only if its family is also different.
6. **Route check.** `ctx.llm.resolveCallConfig({ provider, model, reasoningEffort })` must resolve. On failure, the error lists the models `crew.yaml` offers.
7. **Start or send.**
   - **Start:** `startContinuable` with:
     - `label`: `<role> · <model> · <title>`;
     - `persona`: `dishPrompts.persona(role).prefix`, so the child keeps that text for life; under the dish preset the persona row adds `common.md` and renders variables;
     - `toolFilter`: `{ allow }` (see [Tools](#tools));
     - `agentOptions`: the route;
     - `maxDepth: 1`.
   - **Follow-up:** `ctx.subagents.sendMessage(parent, to, task)`.

   Either way, the record is written.

**`send_message`** stays available for quick questions in both directions: a child asking the main agent something, or the main agent nudging a child. The limits are enforced on `delegate` only. The main agent's prompt says fix rounds go through `delegate` with `to`, not `send_message`. While everything shares one directory, the writer rule depends on that prompt; step 6's worktrees make it moot.

## Tools

A child's allow list is its role's `tools` from `crew.yaml`, intersected with the tools the parent can see when the child starts.
- A tool that's missing then, such as `bash` on Windows (where it's `pwsh`) or `read_image` without attachments, is dropped, not an error.
- `pwsh` is added wherever `bash` is listed.
- Whatever the file says, a child never gets these, even if a role lists them: `delegate`, `subagent`, `subagent_fork`, `subagent_codex`, `subagent_claude_code`, `list_subagent_models`, `workflow`, `ralph`, `interrupt_agent`, `list_agents`, `ask_user_question`, `create_goal`, `update_goal`, `exit_plan_mode`, `present`, or dsh's reserved `run_code`.
- "Tools the parent can see" means tools the child can inherit: those in the parent's preset and global layers, not tools installed on the parent agent's own scope (such as dsh-schedule's), which dsh won't let a child's filter name. Children can't ask you anything: dsh runs them with approval policy `never`.

The list is stored in the child's descriptor. So if a tool is later removed from the dish preset, older children that were allowed it may no longer reload. That's dsh's behavior, noted in the README.

## The dish preset

It moves here from `dish-prompts`, as `presets/dish.patch.yml`, still generated from the installed dsh's `standard` preset by `pnpm --filter dish-crew sync-preset`, with the drift test. Against `standard`, it:
- **swaps in our persona row:** the stock persona row becomes `dish-prompts/persona` (`role: main`), as now;
- **adds `delegate`:** the row `dish-crew/delegate`;
- **removes dsh's own delegation:** the rows for `subagent`, `subagent_fork`, `workflow` and their engine. The main agent delegates through crew only, which is structural rather than a prompt request. It keeps `send_message`, `interrupt_agent` and `list_agents`.

`dish-prompts` keeps its persona row and loses the preset. `dish-crew` depends on `dish-prompts` and `dish-config`. Installing crew without prompts is refused at load, with a clear message, so the preset can't half-mount. `orchestrator` takes the preset over in step 7.

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
