# Spec: gates (`dish-gates`)

Status: built on branch `gates` (2026-10-03) and checked end to end in a scratch dsh; awaiting review and the rollout. What the build added is under [Notes from the build](#notes-from-the-build). Approved 2026-10-02, revised 2026-10-03 (below). This is roadmap step 6c. It builds on [projects and workspaces](projects-workspaces.md) (6b: the registry's `gate` and `gateTimeout`, worktrees, and `delegate`'s worktree binding), [crew](crew.md), [sandbox-home](sandbox-home.md) and the [design](../design.md) ("Gates (structural)"). The plan is [docs/plans/2026-10-03-gates.md](../plans/2026-10-03-gates.md).

**Revised 2026-10-03 (from the plan).** The plan checked this spec against `main` and dsh 0.2.0-rc.2's sources, and this text now says what the plan builds. Its "Spec corrections" section has each change, the evidence and why.
- **Two of your decisions:**
  - **No cache redirects.** Since sandbox-home, a gate writes the home directory on dish's VM, as the coder's own commands do. It runs with their environment, plus `gateEnv` (decision 4, [The environment](#the-environment)).
  - **The last round ends the turn.** The failure in round 3 isn't sent back, so every result is about the code as the coder left it (decision 5, [The hook](#the-hook)).
- **What the code called for:**
  - results of the run in progress live on the child, and move onto the run when it ends;
  - rounds are counted per turn;
  - a worktree that doesn't resolve is recorded, not skipped silently;
  - the review check's details;
  - `dishGates.gateFor` for the brief;
  - looser opt-out forms;
  - the gate runs as `exec 2>&1` and then the command;
  - the open items are answered.

## Summary

When a crew coder bound to a worktree is about to end its turn, dish runs the project's gate in that worktree.
- **A failure** goes back to the coder, and its turn continues. The third failure in a turn isn't sent back: the turn ends with it.
- **The ending** is a pass, or rounds that ran out and a finish notice that says so. Either way, "done" means the gate actually passed, not that the coder said so.
- **Reviews** of a coder whose last gate didn't pass are refused, unless the main agent records a ruling.

## Decisions (from the 2026-10-02 discussion, revised 2026-10-03)

| # | Topic | Decision |
|---|---|---|
| 1 | Who is gated | Crew coders bound to a worktree of a registered project. Never the main agent, and never anything outside a project. |
| 2 | When | At every turn end of a bound coder (dsh's `agent/turn-stopping`). The exception is a closing message that starts with `BLOCKED:` or `NEEDS CONTEXT:`. |
| 3 | What runs | The registry's `gate` command, in the coder's worktree, with `gateTimeout` (at most 10 minutes, dsh's cap). Never a command the coder chose. |
| 4 | Sandbox | dsh's shell service, in the sandbox the coder's own commands run in: writes go to the clone, the per-call `/tmp`, and, on dish's VM, the home directory less sandbox-home's protected list. The network is open. The environment is the coder's, plus the project's `gateEnv`; no cache variables (your decision, 2026-10-03). |
| 5 | Failure | Send the output's tail back to the coder (`agent.steer`) and let the turn continue. At most 3 gate runs per turn: the failure in round 3 isn't sent back, and the turn ends with it (your decision, 2026-10-03). |
| 6 | Review | Crew refuses `delegate` with `reviews` for a coder whose latest run didn't end with a passing gate, unless `gateOverride` carries a ruling. It checks only while dish-gates runs. |
| 7 | Record | Each gate result goes in crew's record of the child, so restarts don't reset rounds. It goes on the child while its run is in progress, and on the run once the run ends. The finish notice and the review check read it. |

## Non-goals

- **Gates longer than 10 minutes.** A long build like snosi's image isn't a gate; use its lint or validate step. Open item 1 asks whether dish could wait longer itself.
- **Gating the main agent's own work.** Its skills tell it to run the gate.
- **Pushing, PRs and the escalation ladder beyond a turn's rounds** (step 7).

## The hook

A host-level `agent/turn-stopping` listener in `dish-gates`.
- dsh fires it before a turn closes: after a step that made no tool calls, and after a `max-tokens` stop. Once a step is cut at `max-tokens`, dsh keeps that as the turn's end, so it also fires after every later step of that turn, tool-call steps included.
- The listener keeps the turn going by steering, as dsh's Claude Code hooks bridge does for its Stop hook.
- dsh awaits it (serial), and a listener that throws fails the turn, so this one never throws.

For each event, in order:
1. **Not a crew child bound to a worktree** → return. That is:
   - the agent is top-level;
   - or crew's record (`dishCrew.records.lookup(agent.id)`) has no `worktree`;
   - or the agent's newest message in this turn holds tool calls: it hasn't finished. Nothing is recorded.
2. **The turn's signal is aborted** → return.
3. **The worktree doesn't resolve** (`dishWorkspaces.resolve(worktree)` gives `undefined`) → record it, and return without steering:
   - **as `error`,** when `dishWorkspaces.resolveProblem` gives a reason: the clone or the worktree failed dish's safety check, such as a key an agent wrote in `.git/config`. So a coder can't skip its gate by breaking the clone's config;
   - **as `skipped`,** "not gated", when there's no reason: the worktree was removed, or its project is no longer registered;
   - **as `error`,** when dish-workspaces isn't running.
4. **The closing message opts out** → record it as `skipped` and return.
   - The closing message is the newest assistant message with text, with leading whitespace dropped.
   - It opts out when it starts with `BLOCKED:` or `NEEDS CONTEXT:`. Markdown marks may come first (`**BLOCKED:**`, `# NEEDS CONTEXT:`), any case is fine, and `NEEDS_CONTEXT:` counts too.
   - A skip lets nothing through: a review still needs a pass or a ruling.
5. **Rounds have run out:** this turn already has 3 failed gates → return, so the turn closes. This only happens when another listener steered the turn on after round 3.
6. **Run the gate** (below). A pass is recorded, and the listener returns.
7. **A failure** is recorded.
   - In rounds 1 and 2, the listener steers the coder with the message below.
   - In round 3 it doesn't: the turn ends with the failure.

Three more rules:
- **One gate per worktree at a time.** A second event for the same worktree while one is running waits for it.
- **The listener never throws.** An error in dish's own code is logged once and the turn closes, recorded as `error` (not a pass).
- **The closing message** comes from a host-level `session/event` listener. dsh calls it inside the append, so it has the step's message before `agent/turn-stopping` fires. `snapshotEvents` is deprecated.

## Running the gate

Through `ctx.shell` (the executor dsh's bash tool uses), and only when it sandboxes: `ctx.shell.sandboxMode` is set. With the request:

| Setting | Value |
|---|---|
| `command` | `exec 2>&1`, a newline, and then the project's `gate` from `projects.yaml` as it is now |
| `workdir` | the coder's worktree |
| `sandboxPolicy` | `{ mode: 'workspace-write', workspaceRoot: <clone>, sessionId: <the coder's> }` |
| `timeoutMs` | `gateTimeout`, at most 600 000 (the executor's cap; the limit that applied is reported) |
| `stdoutMaxBytes` | 4 MB of the joined output, of which the tail is kept |
| `env` | the project's optional `gateEnv`, expanded; nothing else |
| `signal` | the turn's, joined with the plugin's own (aborted when dish-gates stops) |

- **Why `exec 2>&1`.** dsh collects stdout and stderr apart: the 4 MB applies to stdout only, and stderr keeps the executor's 64 KB. So the gate's two streams are joined, in order, in one stream. That also means a gate's own stderr can't be taken for the sandbox runner failing, which dsh decides by `bwrap: ` and `dish-sandbox: ` on stderr.
- **No unconfined run.** `dsh-bash-local` doesn't sandbox, and would ignore the policy: with it, the gate isn't run (`error`). When no sandbox runner works, dsh refuses to run unconfined (`SANDBOX_UNAVAILABLE`); that is an `error` too, never a retry.

### The environment

A gate runs in the sandbox the coder's own commands run in, with dsh's environment and the scrub dsh gives every agent shell.
- **On dish's VM,** that sandbox writes the home directory, less sandbox-home's protected list. So Go's build cache, pnpm's store and mise's installs are where the coder's commands put them, and a gate runs a command the way the coder's own run of it did.
- **dish sets no cache variables.** Pointing `XDG_*`, `GOPATH`, `npm_config_cache` or `CARGO_HOME` into the clone would:
  - hide mise's installs and its trust records;
  - move pnpm's store, which then refuses an existing `node_modules` without a terminal;
  - download Go's modules again for every clone;
  - break the rule `common.md` gives agents.
- **Where the sandbox can't write the home directory** (dev without `DISH_SANDBOX_HOME=on`), a project points its caches into the clone with `gateEnv`, for example `GOCACHE: <clone>/.worktrees/.cache/go-build`.
- **In dev with `DISH_SANDBOX_HOME=on`,** clones under `<checkout>/.dev/work` sit inside the protected checkout. They're read-only to every sandboxed command, a gate included (sandbox-home's known limit).

`gateEnv` in `projects.yaml` is a map of variable names to values, and `<clone>` and `<worktree>` are expanded in the values. 6b's registry validates it: it refuses names that look like secrets, such as `*TOKEN*` or `*KEY*`, and `DSH_*` names.

### Outcomes

- **`passed`:** exit 0.
- **`failed`:** any other exit, a timeout, or a command the sandbox refused. A refusal is recognised by "Read-only file system" in the output, and the message gives the coder a hint.
- **`error`:** dish couldn't run it. The shell doesn't sandbox, the sandbox failed to start, the worktree failed dish's check, or dish's own code failed. Not steered.
- **`skipped`:** the coder opted out, or the bound worktree is no longer gated. Not steered.
- **Cancelled:** the signal aborted. Nothing is recorded, and nothing is steered.

**Logs:**
- **What and where.** The whole output (the kept tail, at most 4 MB), with a short header, goes to `$XDG_STATE_HOME/dish/gates/<owner>/<repo>/<slug>/<child>-<turn>-<round>.log`.
- **How it's written.** Directories 0700, files 0600, created new and never through a link.
- **Pruning.** Logs older than 30 days are pruned at startup.
- **Secrets.** The output is masked (dish-kit's `maskSecrets`) before it reaches the log, the record or the coder.

## The message to the coder

> The gate failed (round N of 3): `<gate>` exited <code> after <duration>. <timeout note if any>
> Last lines of its output:
> ```
> <tail: last 200 lines, at most 16 KB>
> ```
> <a hint, if the sandbox refused a write: where a gate can write>
> Full log: `<path>`. Fix it in your worktree, then finish again with your whole report as your closing message: it replaces the one above. The gate runs again when you do. <in round 2: "If it fails once more, your turn ends with the failure, and the main agent decides what's next.">
> If you're blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped.

- **The whole report again.** dsh's report of a child is its last non-empty assistant message, so a coder that answers a steer with "Fixed the test." would replace the full report it wrote before. The message asks for the whole report as the new closing message (from the final review).
- **When it's sent.** Only after rounds 1 and 2. The steer's source is `dish-gates`, a notice, with a one-line summary.
- **No screening.** The output is the coder's own, from its own code, so it isn't screened. dish-judge's result screen is for web and MCP content. Secrets in it are masked, as above.
- **The judge's task.** The message is never part of it: the judge reads a child's brief and its latest instruction from its parent or a person.

## The record (crew)

`GateResult` is crew's type:

```ts
interface GateResult {
  turn: number                  // the dsh turn whose end it gated; rounds are counted per turn
  round: number                 // 1 + the failures already recorded in this turn
  maxRounds: number             // dish-gates' maxRounds when it was recorded
  outcome: 'passed' | 'failed' | 'skipped' | 'error'
  command: string               // the gate as it ran; '' when none ran
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  log: string | null            // path
  excerpt: string               // the output's last lines (10, at most 1000 characters), masked
  reason?: string               // skipped and error: why
  at: number
}
```

- **Where it lives.** Crew files a run only when it ends (`endRun`), so a run in progress has no entry in `runs[]`.
  - While the run is in progress, results go on the child: `ChildRecord.gates`.
  - `endRun` moves them onto the run it files, as `RunRecord.gates`, and the next run starts with none.
- **Writing it:** crew exposes `records.addGate(childId, result)` for `dish-gates`.
  - It goes through crew's existing queue, atomic and durable like the rest of the record.
  - dish-gates awaits it inside `agent/turn-stopping`, before the turn can close. So it lands before that run's `subagent/end` files the run.
- **Rounds** count failures within one turn of the child. A steer continues the turn. A follow-up (`delegate` with `to`), or any message to a finished child, starts a new turn, so the coder gets three new rounds: that's the main agent's fix round.
- **A reviewer's ruling** is kept on its record as `gateOverride`, with when it was given as `gateOverrideAt`.

## Reviews (crew)

- **The check:** `delegate` with `reviews: <child>` reads that child's record, while dish-gates runs (`ctx.get('dishGates')`). If the child is bound to a worktree and its gate hasn't passed, the start is refused with: "<child>'s gate hasn't passed (<outcome>, round <n>; log <path>). Send it a fix round with `to`, or start the review anyway with `gateOverride: "Ruling: what — why — cost if wrong"`."
- **What hasn't passed:**
  - the latest result isn't `passed`;
  - the child is still running;
  - its latest run has no gate result at all: an error or an abort ended it before its turn could, or dsh restarted mid-gate;
  - the latest result is a pass, but its run didn't end `completed`: it was aborted or failed after the gate passed, or dsh stopped it. A follow-up steered into the turn the gate passed in has the coder go on in that turn, and only a normal end gates that work again.
- **Re-reviews too.** A follow-up to a reviewer (`to`, which is how the skills re-review) runs the same check on the work it reviews.
- **The override:** `gateOverride` is a new optional string on `delegate`.
  - **What counts as a ruling.** An empty string means none, as for every optional parameter. One with no ruling in it, such as `Ruling:` alone, is refused. Line breaks are folded into one line.
  - **Where it goes.** Crew records it on the reviewer's `ChildRecord` (`gateOverride`) and repeats it in the reviewer's brief, or in the follow-up's text, so the reviewer knows the gate didn't pass.
  - **When it's ignored.** When no check refuses.
- **Not checked:** unbound coders, `reviews: "main"`, and any review while dish-gates isn't running.

## The finish notice (crew)

When a bound coder's run ends, crew's notice to the main agent adds one line, from the run's last result:
- **after a pass:** "Gate passed (round N)."; in a run that ended another way than `completed`, "Gate passed earlier in this run (round N), but the run ended (<reason>) after it, so any work after the gate wasn't gated."
- **when rounds ran out:** "Gate FAILED after 3 rounds (`<gate>`, exit <code>); last lines: … Full log: <path>. Start a fix round with `to` or a fresh coder (escalation ladder)."
- **after a failure with rounds left** (the run ended another way): "Gate failed in round N of 3 (`<gate>`, exit <code>), and the run ended before the coder finished again. Full log: <path>."
- **after a skip:** "Gate skipped: the coder reported BLOCKED / NEEDS CONTEXT.", or another skip's reason.
- **after an error:** "Gate not run: <reason>."
- **a run with no result:** "Gate not run."

## The worktree brief block (crew, from 6b)

The block 6b adds to a bound coder's brief gains: "When you finish, dish runs this project's gate (`<gate>`) in your worktree, and a failure comes back to you. If you're blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped."
- Crew reads the gate from `dishGates.gateFor(project)`, so the sentence is there only while dish-gates runs, and crew doesn't read dish-projects.
- Without it, 6b's block is unchanged.

## The service

`dish-gates` provides `dishGates`. It needs nothing at load: it reads `dishCrew`, `dishWorkspaces`, `dishProjects` and dsh's `shell` with `ctx.get` when it uses them.

```ts
interface DishGates {
  gateFor(project: string): Promise<string | undefined>   // projects.yaml's gate as it is now; undefined for a project that isn't registered
}
```

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-gates` | `maxRounds` | 3 | Gate runs per turn. The failure in the last one isn't sent back: the turn ends with it |
| `dish-gates` | `tailLines` | 200 | Lines of output sent back (capped at 16 KB) |
| `dish-gates` | `terminal` | true | Print this plugin's messages |

## Testing

`node --test`.
- **The listener,** with a fake agent, crew's record (with a worktree on the child), a workspaces stub and a fake runner:
  - unbound coders and top-level agents are left alone;
  - an aborted signal;
  - a worktree that fails dish's check is an `error`; one that's gone is `skipped`;
  - the `BLOCKED:` and `NEEDS CONTEXT:` opt-outs (with leading whitespace, Markdown marks, any case and `NEEDS_CONTEXT:`, and a marker that isn't at the start);
  - a pass and a failure, and the steer message's content and tail limits;
  - rounds 1 and 2 steered, round 3 recorded and not steered, and a stop after it not gated;
  - a follow-up's new turn resets the rounds;
  - one gate per worktree, and two coders gated at once each get their own results;
  - errors are recorded as `error` and never thrown.
- **A real shell run** through dsh's shell service and sandbox (dsh's own stack, with and without `deploy/dish-sandbox` as its runner), in a temporary git clone with a worktree:
  - a passing and a failing gate, with both streams in order;
  - writes outside the clone, the per-call `/tmp` and (with `dish-sandbox`) the home directory are refused, and so are writes to protected paths;
  - no cache variables: the gate's environment is dsh's own, plus `gateEnv`;
  - the timeout and an abort, each killing the whole process tree;
  - `gateEnv` expansion. (6b's registry tests refuse secret-looking names.)
- **Crew:**
  - `records.addGate`, written on the child and moved onto the run by `endRun`, and kept across a reload;
  - the review check:
    - refused after a failure, a skip, an error and no result, and while the coder runs;
    - allowed after a pass;
    - allowed with a valid `gateOverride` (recorded and in the brief);
    - an override with no ruling refused;
    - a re-review with `to` checked the same way;
  - the finish-notice lines;
  - the brief block's gate sentence, there only with dish-gates.
- **End to end,** in a scratch dsh with a scripted model, as in sandbox-home's live run:
  1. a bound coder finishes with a failing gate and gets the message;
  2. it fixes the code, and the gate passes;
  3. the review is allowed.

## Open items (answered 2026-10-03, from the plan)

1. **Gates past 10 minutes:**
   - **Possible.** `onExpiry: 'none'` arms no deadline, and dish could abort at a deadline of its own.
   - **Not done.** The non-goal stands: a turn stays running for as long as its gate does.
2. **Reading the turn's last assistant text in `turn-stopping`:** a host-level `session/event` listener ([The hook](#the-hook)).
   - dsh's `turnOutline` projection has a draft of it, but only the web profile mounts it.
   - `snapshotEvents` is deprecated.
3. **After a restart mid-gate:** the gate process dies with dsh. bwrap runs it with `--die-with-parent` in its own PID namespace, and dsh's subprocess service kills its range at teardown.
   - Nothing is recorded for that run.
   - dsh doesn't resume the child by itself: a message from the main agent cold-resumes it into a new turn, gated from round 1.
   - The run before has no gate result, so a review of it needs a ruling.

## Notes from the build

What the build decided within this spec, or added to it, beyond the plan's corrections (which are in the text above).

**The hook.**
- **Skip reasons are read after "Gate skipped: ",** with no "not gated: " prefix: "Gate skipped: its worktree is gone, or its project is no longer registered." A project removed from `projects.yaml` between the worktree's check and the gate is "<project> isn't in projects.yaml".
- **Without dish-projects,** as without dish-workspaces or dsh's shell, dish-gates' own check records an `error`. In practice dish-workspaces resolves no worktree without dish-projects, so such a stop is `skipped` as a worktree that is gone, before that check. Nothing runs either way, and a review still needs a pass or a ruling.
- **The opt-out is per turn.** Each turn's `turn/start` clears the closing message held for its session, so a `BLOCKED:` that closed an earlier turn doesn't skip a later turn's gate (a follow-up whose last step has no text, say).
- **A stop after a `max-tokens` cut** (found in the final review). dsh-agent-loop keeps a turn's end as `max-tokens` for the rest of the turn, so `agent/turn-stopping` fires after every later step, tool-call steps included. Gating those ran the gate mid-work, steered the coder again, and could end a turn "failed after 3 rounds" while the coder was still working. So a stop whose newest assistant message holds tool calls isn't gated and records nothing. The cut message itself never holds one (dsh-llm's assembler drops the tool calls of a `max-tokens` message), so the stop at the cut is gated once, and so is the step that finishes. dsh ends such a turn after the next step unless something steers it; a gate failure at the cut therefore gets one step of fixing in that turn, and the failure stays on the record for the main agent's fix round.
- **Cancels.** A stop whose signal aborts while it waits for the worktree's lock returns at once, recording nothing, and the lock still passes to the stops after it in order. A result that comes back after an abort is dropped: once the signal is aborted, nothing is recorded or steered.
- **Every steer adds a failure to the record.** A failure that couldn't be recorded (crew no longer has the child) isn't steered, so a turn's rounds always run out. When the steer itself throws, the failure stays on the record and an `error` ("dish-gates failed: …") is recorded after it, so the run's last result, which the notice and the review check read, is that error.

**Running the gate.**
- **A cut output** (over 4 MiB) loses its partial first line before it is masked: a secret cut at its start would no longer match its pattern.
- **The gate's command is masked wherever it is shown** (found in the final review): in the recorded `GateResult.command`, the steer, crew's notice line and the gate sentence of a coder's brief (`gateFor` gives it masked, and crew masks it again). Only the run gets projects.yaml's gate as it is. The log already masked it.
- **dsh's spill files.** For a cut run, dsh keeps the whole stream in a spill file in its temp directory, unmasked. dish-gates removes them; its own log has what it keeps.

**Logs** are pruned at start and every day while dish-gates runs, not only at start: dsh web runs for days.

**Crew.**
- **`latestGate`** gives no result while a run is in progress and has none yet, never the previous run's.
- **A pass counts only in a run that ended `completed`** (found in the final review). The gate passes, a follow-up is steered into the same turn and the coder edits more, then the turn is aborted or fails, or dsh restarts: the run's last result is still that pass, though the work after it was never gated. So the review check counts a pass only when its run ended `completed`, and otherwise says "the run ended (<reason>) after its gate passed, so any work after the gate wasn't gated" (or "dsh stopped the run after its gate passed, …" for a run still in progress), with the usual advice: a fix round or a ruling. The notice says "Gate passed earlier in this run (round N), but the run ended (<reason>) after it, …". `latestGate` itself is unchanged.
- **The finish notice** says "Gate not run." for a bound coder's run with no result only while dish-gates runs. Without it no gate was going to run, so the line is left out.
- **The review check's refusal** names the fix round's target (`to: "<id>"`), and for a coder still running says to wait for its finish notice. "No gate result" gives the likeliest cause as an example: "no gate result: it didn't run (for example, the coder ran before dish-gates was on)". Work done before dish-gates was installed needs a ruling to be reviewed.
- **Rulings.** The placeholder copied back (`Ruling: what — why — cost if wrong`, with or without `Ruling:`) is no ruling, and is refused as `Ruling:` alone is. A re-review without `gateOverride` keeps the reviewer's ruling while the reviewed coder hasn't run since the ruling was given (its latest run ended before then, and it isn't running): the ruling was given on the standing it still has. A fix round, a crash or a resume of the coder ends it. The ruling's time is kept as `gateOverrideAt`: the reviewer's start for a ruling given then, the follow-up's time for one given on a re-review (found in the final review: comparing with the reviewer's start lost a ruling given on a re-review at the next one). A ruling recorded before `gateOverrideAt` was kept uses the reviewer's start.

**End to end (2026-10-03).** In a scratch `dsh web` (`env -i`, every directory scratch), installed by `deploy/install.sh`, on the dish preset with crew's `delegate`, and a scripted model on `127.0.0.1`. The project `bketelsen/gates-e2e` (gate `test -f ok.txt`) had a clone and two worktrees made by hand; its onboarding failed at the App, as expected, and `resolve` took the worktrees.
- A coder bound to `e2e` finished without the file. Its session got "The gate failed (round 1 of 3): `test -f ok.txt` exited 1 after 31 ms." with the log's path; it wrote `ok.txt` and finished again.
- Its run in `children.json` held `failed`, round 1, then `passed`, round 2, and the child had no `gates` left. The main agent's notice said "Gate passed (round 2).", and the reviewer it then started ran. The two logs were `-rw-------`, in 0700 directories.
- A coder bound to `e2e-blocked` closed with "BLOCKED: which file?": recorded `skipped`, and the notice said "Gate skipped: the coder reported BLOCKED / NEEDS CONTEXT." The review was refused with "coder «blocked coder» (child …)'s gate hasn't passed (skipped: the coder reported BLOCKED / NEEDS CONTEXT). Send it a fix round with `to: "…"`, or start the review anyway with `gateOverride: …`". With `gateOverride: "Ruling: nothing changed — a check of the override — none"` it started: the ruling was on the reviewer's record, and the block with it came right after the reviewer's task.
