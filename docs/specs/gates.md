# Spec: gates (`dish-gates`)

Status: approved 2026-10-02, revised 2026-10-03 (below). This is roadmap step 6c. It builds on [projects and workspaces](projects-workspaces.md) (6b: the registry's `gate` and `gateTimeout`, worktrees, and `delegate`'s worktree binding), [crew](crew.md), [sandbox-home](sandbox-home.md) and the [design](../design.md) ("Gates (structural)"). The plan is [docs/plans/2026-10-03-gates.md](../plans/2026-10-03-gates.md).

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
- dsh fires it before a turn closes: after a step that made no tool calls, and after a `max-tokens` stop.
- The listener keeps the turn going by steering, as dsh's Claude Code hooks bridge does for its Stop hook.
- dsh awaits it (serial), and a listener that throws fails the turn, so this one never throws.

For each event, in order:
1. **Not a crew child bound to a worktree** → return. That is:
   - the agent is top-level;
   - or crew's record (`dishCrew.records.lookup(agent.id)`) has no `worktree`.
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
> Full log: `<path>`. Fix it in your worktree and finish again; the gate runs again when you do. <in round 2: "If it fails once more, your turn ends with the failure, and the main agent decides what's next.">
> If you're blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped.

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
- **A reviewer's ruling** is kept on its record as `gateOverride`.

## Reviews (crew)

- **The check:** `delegate` with `reviews: <child>` reads that child's record, while dish-gates runs (`ctx.get('dishGates')`). If the child is bound to a worktree and its gate hasn't passed, the start is refused with: "<child>'s gate hasn't passed (<outcome>, round <n>; log <path>). Send it a fix round with `to`, or start the review anyway with `gateOverride: "Ruling: what — why — cost if wrong"`."
- **What hasn't passed:**
  - the latest result isn't `passed`;
  - the child is still running;
  - its latest run has no gate result at all: an error or an abort ended it before its turn could, or dsh restarted mid-gate.
- **Re-reviews too.** A follow-up to a reviewer (`to`, which is how the skills re-review) runs the same check on the work it reviews.
- **The override:** `gateOverride` is a new optional string on `delegate`.
  - **What counts as a ruling.** An empty string means none, as for every optional parameter. One with no ruling in it, such as `Ruling:` alone, is refused. Line breaks are folded into one line.
  - **Where it goes.** Crew records it on the reviewer's `ChildRecord` (`gateOverride`) and repeats it in the reviewer's brief, or in the follow-up's text, so the reviewer knows the gate didn't pass.
  - **When it's ignored.** When no check refuses.
- **Not checked:** unbound coders, `reviews: "main"`, and any review while dish-gates isn't running.

## The finish notice (crew)

When a bound coder's run ends, crew's notice to the main agent adds one line, from the run's last result:
- **after a pass:** "Gate passed (round N)."
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
