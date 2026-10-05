# dish-crew

A fixed crew of specialists the main agent hands work to, with the conversation staying open while they run.
- **One tool, `delegate`.** It starts a child in a role, or sends a fix round to a child it already started. Each child gets its role's prompt from `dish-prompts`, its role's tools, and a model from its role's tier.
- **Reviewers run on another family.** The reviewer runs on a different model family, and vendor, from the work it reviews, and the harness enforces this. A model `crew.yaml` doesn't list whose id names no known vendor counts as its own family, so an alias that hides its vendor can get a reviewer of the same vendor; list it in a family to close that.
- **`crew.yaml`** in the config store holds the roles, tiers, models and limits.
- **Crew keeps its own record.** It saves every child's final report, and finish notices name the child's role and model.
- **Children report once.** Coders and reviewers report with `report`, a tool with a schema that ends their turn ([Reports](#reports)); the other roles report in their closing message. A new child is told so after its task. A child's `send_message` longer than `messageLimit` characters (1200 by default) is refused, and `send_message` stays closed to it until it finishes, so the main agent gets one delivery and not two.
- **Runs and the ladder.** With [`dish-orchestrator`](../orchestrator/), each child is tagged with the run and task it works on, and from round 5 of a task `delegate` refuses more coder work without a ruling ([Runs and the ladder](#runs-and-the-ladder)).
- **Its blocks are kept apart.** dsh's adapters join a message's text blocks with nothing between them, so crew ends each block it writes into a message (a child's task, its worktree block, a ruling's block, the closing note, and the first block of a finish notice when dsh's blocks follow it) with a blank line. The blocks themselves are as described here.
- **This bundle ships the dish preset:** the main agent's preset, with `delegate`, with [`dish-memory`](../memory/)'s row for dish's memory and direction, and with dsh's own delegation tools turned off.

The design and its reasoning are in the [spec](../../docs/specs/crew.md). Why this builds on dsh's subagents directly rather than its experimental agent teams is in the [research note](../../docs/research/2026-10-01-dsh-agent-team.md).

## Install

```sh
pnpm dsh plugin --profile web add ./plugins/crew
```

It needs `dish-config` and `dish-prompts` in the same profile. On its first start with the store, it seeds `crew.yaml`. On later starts, a `crew.yaml` that is still an earlier shipped default moves to the current one (one commit, note "updated to the new defaults"); an edited one stays. After changing `defaults/crew.yaml`, run `node packages/dish-kit/scripts/previous-defaults.mjs plugins/crew/defaults ''`.

**Choose the preset:** on **Settings → Agent presets**, use **Set as new task default** on **dish**. The mode picker on a new chat switches per chat.

## Using it

Talk to the main agent as usual. It delegates by itself, as its prompt (`prompts/main.md`) tells it to:

> delegate a researcher to find …
> delegate a coder to …, then have a reviewer check it

- **The main agent ends its turn after delegating.** You can keep talking. When a child finishes, its notice wakes the main agent.
- **The session header's subagent list** shows each child as `role · model · title`, with its status. Click a child to open its session.
- **Fix rounds:** `delegate` again with `to` set to the same child. It continues with its history.
- **Reviews:** the `reviewer` role with `reviews` set to the child whose work it checks, or `main` for the main agent's own work.

### Reports

A coder (role `coder`) and a reviewer (a child with `reviews`) finish by calling `report`, whose arguments are a structured report. The coder's `status` and the reviewer's `verdict` and `head` are then facts the harness records, not prose the main agent retells.
- **The coder's report:** `status` (`done`, `blocked` or `needs_context`) and `summary`, required; `commits` (shas); `blockedOn`, required when `status` isn't `done`; `rulings` (`{ what, why, costIfWrong }`); `concerns`; in a fix round, `notFixed` (`{ finding, why }`); and `remember`.
- **The reviewer's report:** `verdict` (`approved` or `changes_requested`), `summary` and `findings` (`{ severity: blocking | should_fix | nit, file, line?, summary, fix }`, an empty list for a clean review), required; `head`, the full sha of the commit it reviewed (`git rev-parse HEAD`), when the work is in a git repository; `checks` (`{ command, exitCode, summary }`); in a re-review, `addressed` (`{ finding, addressed, evidence }`); and `remember`. A review without a `head` never counts as a run's final approval: `open_pr` says the final review gave no head (or, when it requested changes, that it did).
- **`remember`, in both:** up to five one-line items of at most 300 characters each, things a later agent in this family should know that the code doesn't say (a pitfall, a flaky test, an undocumented requirement). The finish notice shows them to the main agent as "Worth remembering", and the main agent keeps each one with [`dish-memory`](../memory/)'s `remember`, or doesn't: a child never writes memory itself.
- **Checked, then recorded.** dsh-tools checks the schema, and a call that doesn't match comes back as `invalid arguments: …`, naming the field. Then crew checks what a schema can't: a blank `summary`, `blockedOn` for a coder that isn't `done`, a `head`, when given, that isn't 40 (or 64) hex digits ("run `git rev-parse HEAD` in the worktree you reviewed"), and a `remember` of more than five items ("remember holds at most 5 items"), or with one that isn't one line of at most 300 characters ("each remember item is one line of at most 300 characters"). Each problem is said at once, and nothing is recorded. A report that passes is masked, kept on the child (blank optional fields and empty lists dropped, `head` trimmed and lowercased, `remember`'s items trimmed and the blank ones dropped), and returned as the tool's value, and the child's turn ends (`concludeTurn`). A later `report` in the same turn replaces the earlier one.
- **On the child's own scope.** crew registers `report` on each coder's and reviewer's own tool scope at `agent/created` (and, when crew loads, on each one already in dsh's agent registry), and a cold resume gets it again. It is never in the preset: no allow list names it, and the main agent and the other roles never see it.
- **The steer.** A coder or reviewer crew gave `report` whose turn is about to end without a successful `report` since its newest message is sent back, by a prepended `agent/turn-stopping` listener: "Finish by calling `report`: …", naming its role's fields. At most `reportSteers` times a turn (2); the last adds "If you end your turn without it, the main agent gets your work without a report." `0` turns the steer off; the tool stays, since the prompts tell coders and reviewers to call it. `dishCrew.reportSteered(childId)` is true from the steer until the child's next assistant message or turn, so dish-gates doesn't gate a stop crew sent back.
- **What they're told.** Coders and reviewers get `reportNote` in place of the closing note: "Your parent agent id is "<id>". Finish by calling `report`: it is your report, and the main agent receives it in full, automatically. So don't send your result with send_message, not even a summary or part of it. Use send_message({ agent_id: "<id>", message: "…" }) only for a short question you're blocked on while you work." The report guard's refusals name `report` for them: "Not sent: this is your result, and in this crew you report with `report`. … Finish the work and call `report`. If this was a question you're blocked on, put it in your report instead; the main agent will follow up." Every other role keeps the closing note and the guard's words byte for byte.
- **A child the record lost** (its `children.json` set aside as corrupt after `report` was given) is told "dish-crew has no record of you as a crew child, so the report wasn't recorded; end your turn with your report as your closing message", and from then on crew neither steers it nor names `report` in the guard's refusals.
- **The file.** At the run's end, `endRun` writes the report as `<n>-<role>-<run>.json` beside the `.md`, and moves it from the child onto the run (`runs[].structured`, with its path as `structuredFile`).
- **The notice** of a run with a report renders it, since dsh's own says only "It left no closing message." for a turn a `report` call ended:

  > coder «add login» (claude-sonnet-5.5) finished: done. Report: `/…/3-coder-1.json`. Gate passed (round 1). Its report:
  >
  > Status: done
  > Summary: …

  The collapsed row says what was reported (`done`, `blocked`, `needs context`, `approved`, `changes requested`). A coder's or reviewer's run without a report says so before dsh's label: "It ended without a successful `report`, so there is no structured report." Each notice is matched to its own run by the notice's id, which crew files on the run when it sees the notice delivered (`runs[].notice`), and otherwise by its text.

### Binding a coder to a worktree

In a chat whose workspace is a project's clone ([`dish-workspaces`](../workspaces/)), the main agent makes a worktree with the `worktree` tool and passes it to `delegate` as `worktree`: `<project>/<slug>`, or the path the tool returned.
- **Crew checks it before anything starts:** the role writes (a reviewer is given the path in its task instead), `dish-workspaces` is running and knows the worktree, the worktree is inside the chat's workspace (a child works in its parent's sandbox, and couldn't write anywhere else), and no running crew child, of any chat, is bound to it.
- **The child is bound:** its record keeps the worktree's path (`worktree` in `children.json`), and its brief gets a block after the task naming the worktree and its branch, and telling it to work only there. While [`dish-gates`](../gates/) runs, the block goes on to name the project's gate and the opt-out ([Gates](#gates)).
- **Follow-ups keep the binding** and add nothing to the text. One that names another worktree is refused, and so is one to a child whose worktree has been merged or removed: start a new coder.
- **A worktree dish made that fails a check is refused with the reason.** When `resolve` gives nothing, crew asks `dishWorkspaces.resolveProblem(ref)` why: the project's clone, or the worktree itself, failed dish's safety check (with the finding), or its branch is gone. A start says "worktree `<ref>` can't be bound: <reason>. Nothing was started or sent; tell the user."; a follow-up to a bound child says its worktree "can't be used: <reason>" instead of calling it gone. Without a reason (a worktree dish doesn't know), the refusals are as above.
- **`dishCrew.worktreeBindings(path)`** lists the children bound to a worktree, with whether each is running, for `dish-workspaces`' `list`, `remove` and sweep.

### Gates

While [`dish-gates`](../gates/) runs, a bound coder's work is gated each time it is about to finish: dish runs the project's gate in its worktree, and a failure goes back to the coder, up to 3 gate runs a turn. Crew's part:
- **The brief.** A bound coder's block ends with: "When you finish with `report` and `status: "done"`, dish runs this project's gate (`<gate>`) in your worktree, and a failure comes back to you. If you're blocked, report `status: "blocked"` or `"needs_context"` with `blockedOn`, and the gate is skipped." Another bound role (ops, the architect, the writer), which ends with a closing message, keeps 6c's words: "When you finish, dish runs this project's gate (`<gate>`) in your worktree, and a failure comes back to you. If you're blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped." The gate comes from `dishGates.gateFor(project)`. Without dish-gates, or a gate, the block is as above.
- **The record.** Each gate result is a `GateResult` (the turn, the round of `maxRounds`, `passed`, `failed`, `skipped` or `error`, the command, the exit code, whether it timed out, how long it took, the log, the output's last lines, and why for a skip or an error). dish-gates adds it with `records.addGate(child, result)`. A run in progress keeps its results on the child (`gates`), and they move onto the run when it ends (`runs[].gates`).
- **The finish notice** of a bound coder says how its gate ended, after the report's path (and before `Its report:`), from the run's last result:
  - "Gate passed (round 2)." In a run that ended another way than `completed` (aborted, failed) after its gate passed: "Gate passed earlier in this run (round 2), but the run ended (aborted) after it, so any work after the gate wasn't gated."
  - "Gate FAILED after 3 rounds (`<gate>`, exit 1); last lines:", the output's last lines in a code fence, then "Full log: `<path>`. Start a fix round with `to` or a fresh coder (escalation ladder)." A gate that hit its time limit says "stopped at its time limit" in place of the exit code.
  - "Gate failed in round 1 of 3 (`<gate>`, exit 1), and the run ended before the coder finished again. Full log: `<path>`." The run ended some other way, such as an error.
  - "Gate skipped: the coder reported BLOCKED / NEEDS CONTEXT." or another skip's reason, such as "its worktree is gone, or its project is no longer registered".
  - "Gate not run: <reason>." for an error, such as a clone that failed dish's safety check.
  - "Gate not run." for a run with no result. That line is left out while dish-gates isn't running: no gate was going to run.
- **The review check.** A review of a bound coder's work, a reviewer started with `reviews: <child>` or a follow-up to a reviewer (a re-review), is refused while that coder's gate hasn't passed:
  - it is still running: wait for its finish notice;
  - its latest run's last result isn't a pass;
  - or that run has none (an error or an abort ended it before its turn could, dsh restarted mid-gate, or it ran before dish-gates was on: "the coder ran before gates were on");
  - or it is a pass, but the run didn't end `completed` after it: a follow-up steered into the same turn had the coder go on, and the turn was then aborted or failed, or dsh restarted. The work after the pass was never gated.

  The refusal says where the gate stands and what to do: "coder «add login» (child <id>)'s gate hasn't passed (skipped: the coder reported BLOCKED / NEEDS CONTEXT). Send it a fix round with `to: "<id>"`, or start the review anyway with `ruling: "Ruling: what — why — cost if wrong"`."
- **`ruling`,** a `delegate` parameter, is the main agent's ruling to review work whose gate hasn't passed, on one line (line breaks are folded), masked. `gateOverride`, its name before step 7, is still accepted as a synonym. The ruling is recorded on the reviewer (`gateOverride` in `children.json`), and the reviewer gets a block after its task: "The harness's gate for the work you review (<role> «<title>», child <id>) hasn't passed: <where it stands>. The main agent started this review anyway, with this ruling: <ruling>", without the ruling's leading `Ruling:`. A follow-up with a ruling replaces the recorded one, and its text gets the same block.
  - An empty `ruling` is none. `Ruling:` alone, or the placeholder `Ruling: what — why — cost if wrong` copied back, is refused: "ruling needs the ruling itself: what — why — cost if wrong.", followed by the refusal above.
  - A re-review without one keeps the reviewer's ruling while the reviewed coder hasn't run since the ruling was given: the ruling was given on the standing it still has. Its time is `gateOverrideAt` in `children.json`: the reviewer's start, or the follow-up that gave it. A ruling recorded before that field existed counts from the reviewer's start.
  - When nothing is refused (the gate passed, the coder isn't bound, `reviews: "main"`, or dish-gates isn't running), the ruling is ignored and not recorded. The same `ruling` is the ladder's, from round 5 ([Runs and the ladder](#runs-and-the-ladder)).

### Runs and the ladder

While [`dish-orchestrator`](../orchestrator/) runs, crew reads its `dishRuns` with `ctx.get`, without depending on it. Without it, nothing below happens: no tags, no ladder, and `final` only says it had no effect.
- **`ruling`** is the one word for ruling past a check: a review of work whose gate hasn't passed ([Gates](#gates)), or a coder past round 4 of its task. `gateOverride` stays as its synonym, so briefs and skills that use it still work.
- **Tags.** Inside its locks, after every check that refuses without writing, `delegate` asks `dishRuns.place` where the call belongs, and a start is recorded with what it gives: `run`, the run's ref `<owner>/<repo>/<id>`, and `task`, a worktree slug of the run. A bound child goes in the run that owns its worktree, whichever chat drives it, and in no run when only a run that isn't open has it (a `pr` run not reopened, an abandoned one); a reviewer where the child it reviews is; anything else in the run its chat drives, with no task. A follow-up keeps its child's tags. A `place` that fails, or answers something malformed, is logged and counts as no run: a delegation is never refused for it.
- **`final: true`** marks a reviewer as the run's final review, the one `open_pr` checks. It is for the reviewer role only ("final is for the reviewer role (reviewer): it marks the run's final review. Leave final out for a coder."). It is sticky on the record (`final`): a reviewer started with it stays final for its follow-ups, and a follow-up with it makes a reviewer final, but only in the run the reviewer is tagged with. When it can't be recorded, the answer says why, each note opening "`final` had no effect:":
  - "… this chat drives no run, so there is no final review for `open_pr` to read.": `place` gave no run, and `dishRuns.driving` says this chat drives none (or dish-orchestrator has no `driving`);
  - "… dish couldn't place this reviewer in a run, so `final` wasn't recorded; try again with a fresh reviewer and `final: true`; if it is bound to a closed run's worktree, `run` `resume` that run first.": `place` threw or answered with no run in it (crew logs it), or gave no run while `driving` says this chat drives an open run (dish-orchestrator's `place` gives none past its time limit or on a failure, which it logs; and none for a reviewer bound to the worktree of a run that isn't open, a `pr` run not reopened or an abandoned one, which a retry wouldn't change). `driving` is asked only for this note, for at most 2 s; one that fails or is late counts as dish's failure, and is logged;
  - "… this reviewer was started outside the run this chat drives now, so start a fresh reviewer with `final: true` for that run's final review.": a follow-up to a reviewer tagged with another run, or with none;
  - "… dish keeps no runs here (dish-orchestrator isn't loaded)."
- **The ladder.** Each coder start or follow-up on a run's task is a round, which `place` counts from the run's ledger (the first start is round 0). Rounds 1 to 4 add a `note` to `delegate`'s answer: "Round 2 of task `fix-parser`. The ladder: rounds 1–3 go to the same coder with `to`; round 4 is a fresh coder on the strong tier (`model`), with the open findings and the previous coder's report; from round 5, delegate needs your ruling.", and at round 4 "Round 4 of task `fix-parser`: the ladder starts a fresh coder on the strong tier (`model`), …". From round 5 the call is refused: "round 5 of task `fix-parser`: the escalation ladder ends at round 4, so delegate won't send more coder work on this task without your ruling. Rule with `ruling: "Ruling: what — why — cost if wrong"` (it is recorded), or stop and tell the user (`run` action `abandon`, with a reason, only if they drop the change)." A call with a ruling goes through ("Round 5 of task `fix-parser`, past the ladder, on your ruling (recorded)."). Both are recorded with `dishRuns.ladder`. Reviewers, other roles, children outside a run, and a follow-up that `place` no longer puts where its child's tags say aren't counted.
- **Events.** crew publishes what happened, for dish-orchestrator's ledger, with `ctx.parallel`, each awaited for at most 10 s; a listener's failure is logged, never thrown, and a listener gets a copy:
  - `dish-crew/delegated` `{ sessionId, child, followUp }`: a start, after its record and before dsh starts the child, or a follow-up, after it was sent. It is awaited inside `delegate`'s session lock, so the next `place` on the task counts this round.
  - `dish-crew/settled` `{ sessionId, child, run }`: a run filed by `endRun`, with its structured report, and a start dsh refused. `whenRecorded` waits for it, so a child's next start or end does too.
- **The main agent's run tools** `run`, `open_pr` and `pr_feedback` are on the never-list: no role gets them, whatever `crew.yaml` says.

## crew.yaml

Edit it by asking the main agent, which writes it with `config_write`, and review the change on Settings → History. The shipped file:

```yaml
provider: github-copilot
families:
  anthropic: { strong: claude-opus-5.5, mid: claude-sonnet-5.5 }
  openai:    { strong: gpt-6.1-sol,     mid: gpt-5.6-sol }
reviewerFamilies: [openai, anthropic]
limits: { running: 4, writers: 1, perSession: 30 }
roles:
  architect:  { tier: strong, family: anthropic, writes: true,  tools: [...] }
  coder:      { tier: mid,    family: anthropic, writes: true,  tools: [...] }
  reviewer:   { tier: mid,    reviews: true,                    tools: [...] }
  researcher: { tier: mid,    family: anthropic,                tools: [...] }
  ops:        { tier: mid,    family: anthropic, writes: true,  tools: [...] }
  writer:     { tier: mid,    family: anthropic, writes: true,  tools: [...] }
```

For direct API keys, with Claude through an `anthropic` provider and GPT through an `openai` one, give each family its provider and keep the rest of the file (`limits` and `roles` as above). Use the model ids the provider's API names:

```yaml
provider: anthropic       # required: the provider of any family that doesn't have its own
families:
  anthropic: { provider: anthropic, strong: claude-opus-5.5, mid: claude-sonnet-5.5 }
  openai:    { provider: openai,    strong: gpt-6.1-sol,     mid: gpt-5.6-sol }
reviewerFamilies: [openai, anthropic]
```

- **A broken file can't be saved.** It is checked when written: unknown keys, model ids padded with spaces, a model listed in two families, a role with no tools, and more are refused, each with the path at fault.
- **Families and tiers.** Each role uses its family's model at its tier. The main agent may pass `model` to pick another model listed in `families`.
- **A provider per family.** `provider` at the top is where every family runs, and it is required. A family may add its own `provider` next to its tiers, for direct API keys, where Claude and GPT come through different providers (the example above). A model override runs on the provider of the family its model is in. When a refusal lists the models, a family with its own provider shows them as `provider/model`, and either form is accepted back as `model`. A model id that equals another model's `provider/model` name is refused when the file is saved.
- **The reviewer** has no `family`. It takes the first `reviewerFamilies` entry that isn't the reviewed work's family, and that lists no model of the same vendor. That is told by model ids, never by provider names, and it runs on the provider of the family it lands in.
- **Limits.**
  - At most `running` children run at once, and at most `writers` of the roles marked `writes: true`. Children share the chat's workspace, so one writer at a time; a coder bound to its own worktree is kept to it by its brief, not by the sandbox.
  - A session can start `perSession` children in all. Follow-ups don't count toward it.
- **Tools.**
  - A role's `tools` are an allow list. Tools the main agent can't pass on are dropped when the child starts; those are the ones on its own scope, not the preset's.
  - Every shipped role lists `ask_judge`, which comes from [`dish-judge`](../judge/). Without that plugin there is no such tool, and the name is dropped like any other missing one: children start with the rest of their tools.
  - Every shipped role lists `recall`, just before `ask_judge`. It comes from the dish preset's `dish-memory/context` row ([`dish-memory`](../memory/)) and reads the memory dish's agents saved: a child gets its family's memory, not your user memory. A `crew.yaml` you've edited keeps its own lists, so add `recall` to each role yourself.
  - Whatever the file says, a child never gets `delegate`, dsh's delegation and workflow tools, the goal or plan tools, `ask_user_question`, `present`, `worktree`, `run`, `open_pr`, `pr_feedback`, `remember` or `forget`. Only the main agent writes memory.

A role also needs a prompt: `prompts/crew/<role>.md`, or a shipped default.

## What crew records

In `$XDG_DATA_HOME/dish/crew/`:
- `sessions/<hash of the session>/children.json` holds each child's role, model, family, what it reviews, the worktree it is bound to, its follow-ups and its runs, and, with [`dish-gates`](../gates/), each run's gate results (each with the worktree's `head` when the gate ran) and a reviewer's `gateOverride` with its `gateOverrideAt` ([Gates](#gates)). Since step 7 it also holds a coder's or reviewer's `report` while its run is in progress, then on the run as `structured` with `structuredFile`, and the id of the run's finish notice (`notice`) ([Reports](#reports)); and, with [`dish-orchestrator`](../orchestrator/), the child's `run` and `task`, and a reviewer's `final` ([Runs and the ladder](#runs-and-the-ladder)).
- `<n>-<role>-<run>.md` in the same folder holds each run's closing message, the child's report, and `<n>-<role>-<run>.json` beside it a coder's or reviewer's structured report.
- `by-child/` holds pointers, so a child resumed after a restart is filed under the right session.

Records not touched for 180 days are pruned at startup. A finish notice gives its run's report path. Copy reports worth keeping into a repo's docs.

## The dish preset

`presets/dish.patch.yml` is **generated** from the `standard` preset of the dsh you have installed. It differs in five ways:
- the stock persona row is replaced by `dish-prompts/persona`;
- the `dish-crew/delegate` row is added;
- dsh's own delegation rows (`subagent`, `subagent_fork` and the workflow engine) are disabled;
- dsh's `tool-subagent-control` row is replaced by `dish-crew/control`: the same `send_message` and `interrupt_agent`, without the mark that has dsh append "send your result to that agent with send_message" to a child's task. `delegate`'s own note gives the child its parent's id instead;
- the `dish-memory/context` row is added right after `agent-instructions`: dish's memory and direction, delivered as dsh delivers `AGENTS.md`, and the tools `remember`, `forget` and `recall` ([`dish-memory`](../memory/)). The row resolves through this package's dependency on `dish-memory`.

Any row from dsh's delegation packages left enabled fails the generator, and so does a row that would still load `@deepseek-ai/dsh-tool-subagent-control` beside `dish-crew/control` (two `send_message` tools in one scope). The `subagent` row would otherwise install its tool into every agent on the preset, children included, where no filter reaches. A `standard` without exactly one `agent-instructions` row fails it too: the generator can't tell where the memory row goes.

After a dsh upgrade, a test fails if `standard` changed. Run:

```sh
pnpm --filter dish-crew sync-preset
```

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-crew` | `dataDirectory` | `$XDG_DATA_HOME/dish/crew` | Where records and reports go. Absolute, or starting with `~/`. |
| `dish-crew` | `subagentProvider` | `spawn` | The `ctx.subagents` provider for children. |
| `dish-crew` | `messageLimit` | `1200` | The most characters a crew child's `send_message` may have. A longer one is refused as a report, and `send_message` is closed to that child until it finishes. `0` turns the guard off. |
| `dish-crew` | `reportSteers` | `2` | How many times in one turn a coder or reviewer that ends without a successful `report` is sent back to call it. `0` turns the steer off; `report` stays. |
| `dish-crew` | `terminal` | `true` | Print this plugin's messages, and the preset row's, to the terminal. |

## Caveats

- **A start that fails still counts** toward `perSession`, a cancelled one included.
- **`send_message` isn't checked against the limits.** It can still wake a finished child, and the woken child counts as running from then on. Fix rounds should go through `delegate` with `to`.
- **The report guard reads length, then holds.** A crew child's first `send_message` over `messageLimit` characters is refused, whatever it says, and from then on every `send_message` of that child is refused until its run ends: it can't tell a report in pieces from a question, so a question a child is blocked on goes in its closing message, and you or the main agent follow up with `delegate` and `to`. A follow-up run starts with `send_message` open. Messages from the main agent and from other plugins' children, and any message sent while crew's record can't be read, are never refused. On the dish preset dsh no longer adds its note telling a child to send its result with `send_message` (`dish-crew/control`), and crew's own note says not to; the guard keeps a child that does anyway from sending a long one. On a preset saved in Settings that still loads dsh's `send_message`, dsh's note comes back after crew's, and crew's says so.
- **Children share the main agent's working directory.** dsh 0.2.0-rc.2 has no per-child `cwd`. A bound coder starts in the chat's workspace too, and may write anywhere in it: its brief, not the sandbox, keeps it to its worktree.
- **Children can't ask you anything.** dsh runs them with approval policy `never`.
- **A crew child's approval requests are refused when `dish-judge` isn't loaded.** With `dish-judge`, a child is switched to approval policy `ask` and the judge answers it. If the judge is then disabled, uninstalled or unloaded, a child that had settled still has `ask` in its log, and a follow-up would resume it at `ask`. Without a guard, dsh would show its prompt in the child's own session, where nobody sees it, and nothing times it out. So crew refuses a crew child's request whenever `dish-judge` is absent. Other children, and the main agent, are untouched.
- **Without `dish-prompts`,** the persona row logs once and `delegate` refuses every call, naming the missing plugin. Nothing refuses at load.
- **Without `dish-memory` running,** the preset's `dish-memory/context` row adds no memory message, and `remember`, `forget` and `recall` answer that memory is unavailable. Nothing refuses at load.
- **Claude Sonnet 5.5 comes from `dish-copilot`'s catalog,** which copies settings from the nearest catalog model of the same generation. An older copy rejected every request from crew children (Task 9's live check found it).
