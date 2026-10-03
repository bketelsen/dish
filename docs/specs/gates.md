# Spec: gates (`dish-gates`)

Status: draft 2026-10-02, for review. This is roadmap step 6c. It builds on [projects and workspaces](projects-workspaces.md) (6b: the registry's `gate` and `gateTimeout`, worktrees, and `delegate`'s worktree binding), [crew](crew.md) and the [design](../design.md) ("Gates (structural)").

## Summary

When a crew coder bound to a worktree is about to end its turn, dish runs the project's gate in that worktree.
- **A failure** goes back to the coder, and its turn continues, up to three rounds.
- **The ending** is a pass, or rounds that ran out and a finish notice that says so. Either way, "done" means the gate actually passed, not that the coder said so.
- **Reviews** of a coder whose last gate didn't pass are refused, unless the main agent records a ruling.

## Decisions (from the 2026-10-02 discussion)

| # | Topic | Decision |
|---|---|---|
| 1 | Who is gated | Crew coders bound to a worktree of a registered project. Never the main agent, and never anything outside a project. |
| 2 | When | At every turn end of a bound coder (dsh's `agent/turn-stopping`). The exception is a closing message that starts with `BLOCKED:` or `NEEDS CONTEXT:`. |
| 3 | What runs | The registry's `gate` command, in the coder's worktree, with `gateTimeout` (at most 10 minutes, dsh's cap). Never a command the coder chose. |
| 4 | Sandbox | dsh's shell service, confined to the clone (writes only inside the clone and `/tmp`, network open). Caches are pointed inside the clone. |
| 5 | Failure | Send the output's tail back to the coder (`agent.steer`) and let the turn continue. At most 3 rounds per run, then let the turn end. |
| 6 | Review | Crew refuses `delegate` with `reviews` for a coder whose latest run didn't end with a passing gate, unless `gateOverride` carries a ruling. |
| 7 | Record | Each gate result goes in crew's record of the child, so restarts don't reset rounds. The finish notice and the review check read it. |

## Non-goals

- Gates longer than 10 minutes. A long build like snosi's image isn't a gate; use its lint or validate step. Open item 1 is whether dish can wait longer itself.
- Gating the main agent's own work. Its skills tell it to run the gate.
- Pushing, PRs and the escalation ladder beyond round 3 (step 7).

## The hook

A host-level `agent/turn-stopping` listener in `dish-gates`. dsh fires it before a turn closes, after a step that made no tool calls (and after a `max-tokens` stop). The listener keeps the turn going by steering, as dsh's Claude Code hooks bridge does for its Stop hook.

For each event, in order:
1. **Not a crew child bound to a worktree** → return:
   - the agent is top-level;
   - or crew's record (`dishCrew.records.lookup(agent.id)`) has no `worktree`;
   - or `dishWorkspaces.resolve(worktree)` finds no project.
2. **The turn's signal is aborted** → return.
3. **The closing message opts out** → record it as `skipped` and return. That is, the turn's last assistant text, with leading whitespace trimmed, starts with `BLOCKED:` or `NEEDS CONTEXT:`.
4. **Rounds have run out:** this run already has 3 failed gates → return, so the turn closes. The record holds `failed` and `rounds: 3`.
5. **Run the gate** (below). A pass is recorded, and the listener returns.
6. **A failure** is recorded, and the listener steers the coder with the message below.

- **One gate per worktree at a time.** A second event for the same worktree while one is running waits for it.
- **The listener never throws.** An error in dish's own code is logged once and the turn closes, recorded as `error` (not a pass).

## Running the gate

Through `ctx.shell` (the executor dsh's bash tool uses), with:

| Setting | Value |
|---|---|
| `command` | the project's `gate` from `projects.yaml` as it is now |
| `workdir` | the coder's worktree |
| `sandboxPolicy` | `{ mode: 'workspace-write', workspaceRoot: <clone> }` |
| `timeoutMs` | `gateTimeout`, at most 600 000 |
| `stdoutMaxBytes` | 4 MB, of which the tail is kept |
| `env` | the cache variables below, plus the project's optional `gateEnv` |
| `signal` | the turn's signal |

**Caches.** Under the sandbox everything outside the clone is read-only, and `/tmp` is emptied for each run. So a gate gets its caches under `<clone>/.worktrees/.cache/`, shared by that clone's worktrees:
- `XDG_CACHE_HOME`, `XDG_DATA_HOME` and `XDG_STATE_HOME`, which cover Go's build cache, pnpm's store and most tools;
- `GOPATH`, `npm_config_cache` and `CARGO_HOME`, explicitly.

A project that needs more sets `gateEnv` in `projects.yaml`. That's a map of variable names to values, and `<clone>` and `<worktree>` are expanded in the values. 6b's registry gains this field, and validation refuses names that look like secrets, such as `*TOKEN*` or `*KEY*`.

**Outcomes:**
- `passed`: exit 0.
- `failed`: any other exit, a timeout, or a command the sandbox refused.
- **Cancelled:** the signal aborted. Nothing is recorded, and nothing is steered.

**Logs:** the whole output goes to `$XDG_STATE_HOME/dish/gates/<owner>/<repo>/<slug>/<child>-<run>-<round>.log`. Logs older than 30 days are pruned at startup.

## The message to the coder

> The gate failed (round N of 3): `<gate>` exited <code> after <duration>. <timeout note if any>
> Last lines of its output:
> ```
> <tail: last 200 lines, at most 16 KB>
> ```
> Full log: `<path>`. Fix it in your worktree and finish again; the gate runs again when you do. If you're blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped.

The output is the coder's own, from its own code, so it isn't screened. dish-judge's result screen is for web and MCP content.

## The record (crew)

`ChildRecord.runs[]` gains `gates: GateResult[]`:

```ts
interface GateResult {
  round: number                 // 1..3 within the run
  outcome: 'passed' | 'failed' | 'skipped' | 'error'
  exitCode: number | null
  timedOut: boolean
  durationMs: number
  log: string | null            // path
  at: number
}
```

- **Writing it:** crew exposes `records.addGate(childId, result)` for `dish-gates`. It's written on the run in progress, through crew's existing queue (atomic and durable, like the rest of the record).
- **Rounds** count failures within one run. A follow-up (`delegate` with `to`) starts a new run, so the coder gets three new rounds. That's the main agent's fix round.

## Reviews (crew)

- **The check:** `delegate` with `reviews: <child>` reads that child's latest run. If the child is bound to a worktree, and that run's last gate result isn't `passed`, the start is refused with: "<child>'s gate hasn't passed (<outcome>, round <n>; log <path>). Send it a fix round with `to`, or start the review anyway with `gateOverride: "Ruling: what — why — cost if wrong"`."
- **The override:** `gateOverride` is a new optional string on `delegate`. It must be a non-blank one-line ruling. Crew records it on the reviewer's `ChildRecord` (`gateOverride`) and repeats it in the reviewer's brief, so the reviewer knows the gate didn't pass.
- **Unbound coders and `reviews: "main"`** aren't checked.

## The finish notice (crew)

When a bound coder's run ends, crew's notice to the main agent adds one line:
- after a pass: "Gate passed (round N)."
- when rounds ran out: "Gate FAILED after 3 rounds (`<gate>`, exit <code>); last lines: … Full log: <path>. Start a fix round with `to` or a fresh coder (escalation ladder)."
- after a skip: "Gate skipped: the coder reported BLOCKED / NEEDS CONTEXT."

## The worktree brief block (crew, from 6b)

The block 6b adds to a bound coder's brief gains: "When you finish, dish runs this project's gate (`<gate>`) in your worktree, and a failure comes back to you. If you're blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped."

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-gates` | `maxRounds` | 3 | Gate failures per run before the turn is allowed to end |
| `dish-gates` | `tailLines` | 200 | Lines of output sent back (capped at 16 KB) |
| `dish-gates` | `terminal` | true | Print this plugin's messages |

## Testing

`node --test`.
- **The listener,** with a fake agent, a crew stub (records with a worktree), a workspaces stub and a fake shell:
  - unbound coders and top-level agents are left alone;
  - an aborted signal;
  - the `BLOCKED:` and `NEEDS CONTEXT:` opt-outs (with leading whitespace, and a marker that isn't at the start);
  - a pass and a failure, and the steer message's content and tail limits;
  - rounds 1, 2, 3 and then closing;
  - a follow-up run resets the rounds;
  - one gate per worktree;
  - errors are recorded as `error` and never thrown.
- **A real shell run** through dsh's shell service and sandbox, in a temporary git clone with a worktree:
  - a passing and a failing gate;
  - writes outside the clone are refused;
  - the cache variables point inside the clone;
  - the timeout;
  - `gateEnv` expansion, and secret-looking names refused.
- **Crew:**
  - `records.addGate`, written on the right run and kept across a reload;
  - the review check: refused, allowed after a pass, allowed with a valid `gateOverride` (recorded and in the brief), and a blank override refused;
  - the finish-notice lines;
  - the brief block's gate sentence.
- **End to end,** in a scratch dsh with the fake model from this morning's check:
  1. a bound coder finishes with a failing gate and gets the message;
  2. it fixes the code, and the gate passes;
  3. the review is allowed.

## Open items

1. **Gates past 10 minutes:** whether `onExpiry: 'none'` with dish's own deadline lets a gate run past dsh's 10-minute cap, and whether that's wise. A turn stays "running" for as long as its gate does.
2. **Reading the turn's last assistant text in `turn-stopping`:** the supported way, not `snapshotEvents`, which is deprecated (see the judge backlog item).
3. **After a restart mid-gate:** what happens when dsh restarts while a gate runs. The gate process dies with dsh. On resume, the coder's turn may need the gate again; check how dsh resumes a child whose turn was mid-stop.
