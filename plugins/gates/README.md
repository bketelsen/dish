# dish-gates

Runs a project's gate in a crew coder's worktree when the coder is about to finish, and sends a failure back to it.
- **Who is gated.** A crew child bound to a worktree of a registered project ([crew's `delegate`](../crew/README.md#binding-a-coder-to-a-worktree) with `worktree`). Never the main agent, and never anything outside a project.
- **When.** At every end of the coder's turn (dsh's `agent/turn-stopping`), unless its closing message starts with `BLOCKED:` or `NEEDS CONTEXT:`.
- **What runs.** The project's `gate` from `projects.yaml`, as it is at that moment, in the coder's worktree, through dsh's sandboxed shell. Never a command the coder chose.
- **A failure** goes back to the coder, and its turn goes on. At most 3 gate runs per turn: the failure in the last one isn't sent back, and the turn ends with it.
- **The result** goes in crew's record. The main agent's finish notice says how the gate ended, and crew refuses a review of work whose gate didn't pass, unless the main agent gives a ruling ([crew's README](../crew/README.md#gates)).

So "done" means the gate passed, not that the coder said so. The design is in the [spec](../../docs/specs/gates.md) and the [plan](../../docs/plans/2026-10-03-gates.md). The spec's "Notes from the build" say what changed on the way.

## Install

```sh
pnpm dsh plugin --profile web add ./plugins/gates
```

`deploy/install.sh` links it, last. It needs nothing at load: it reads `dishCrew`, `dishWorkspaces`, `dishProjects` and dsh's `shell` with `ctx.get` each time it uses them, so there is no order to keep. It is a host plugin, so it hears every agent's end of turn, crew's children included.

Without [`dish-crew`](../crew/) it does nothing. Without [`dish-workspaces`](../workspaces/), a bound coder's stop is recorded as an `error`, "dish-workspaces isn't running". Without [`dish-projects`](../projects/), dish-workspaces resolves no worktree, so the stop is `skipped` as a worktree that is gone. Either way nothing runs, and a review of the work needs a ruling.

## A gated stop, step by step

For each end of turn of any agent:
1. **Not gated:** the turn was cancelled, the agent is the main agent, crew isn't running, or crew's record has no worktree for the child. Nothing is recorded. Nor is a stop whose newest message holds tool calls: the coder hasn't finished. dsh fires such stops only after a step of the turn was cut at `max-tokens`, as it then keeps `max-tokens` as the turn's end; the cut message holds no tool calls (dsh drops them), so its stop is gated once.
2. **One gate per worktree.** A second stop for the same worktree waits for the first. A stop cancelled while it waits returns at once.
3. **The round** is 1 + the failed gates already recorded for this turn of the child.
4. **The worktree** must resolve (`dishWorkspaces.resolve`, which runs dish's checks on the clone and the worktree). When it doesn't:
   - a clone or worktree that fails dish's safety check is an `error`, with the finding. So a coder can't skip its gate by breaking its clone's `.git/config`;
   - a worktree that is gone, or whose project was removed, is `skipped`: "its worktree is gone, or its project is no longer registered";
   - a project no longer in `projects.yaml` is `skipped`: "<project> isn't in projects.yaml".
5. **The opt-out:** a closing message that starts with `BLOCKED:` or `NEEDS CONTEXT:` is `skipped`: "the coder reported BLOCKED / NEEDS CONTEXT". Markdown marks may come first (`**BLOCKED:**`, `# NEEDS CONTEXT:`), any case is fine, and `NEEDS_CONTEXT:` counts too. The closing message is the newest assistant message with text in this turn.
6. **Rounds used up:** with `maxRounds` failures in this turn already, nothing runs and nothing is recorded. Only another plugin's steer can bring a turn here.
7. **The run** (below). A pass is recorded. A failure is recorded and, with rounds left, sent back to the coder as a message from `dish-gates`; in the last round it isn't sent back, and the turn ends with it. So a turn has at most `maxRounds` gate runs and `maxRounds - 1` fix attempts.

A follow-up to the coder (`delegate` with `to`) starts a new turn, so it gets new rounds: that is the main agent's fix round.

The listener never throws: a thrown listener would fail the coder's turn in dsh. A failure of dish's own code is logged once per distinct message and recorded as an `error`, "dish-gates failed: <message>". A cancelled stop (the turn's, or dish-gates stopping) records and sends nothing.

## Running the gate

Through `ctx.shell`, the executor dsh's `bash` tool uses, and only when it sandboxes (`sandboxMode` is set):

| | |
|---|---|
| command | `exec 2>&1`, a newline, then the project's `gate`. The two streams are one, in order, and the gate's own stderr can't be taken for the sandbox runner failing. |
| working directory | the coder's worktree |
| sandbox | `workspace-write`, with the clone as its workspace root, and the coder's id as the session |
| time limit | the project's `gateTimeout`, at most 10 minutes (dsh's cap). The limit that applied is reported. |
| output | the last 4 MiB is kept |
| environment | the coder's own, plus the project's `gateEnv` (below) |

- **No unconfined run.** With a shell that doesn't sandbox (`dsh-bash-local`), the gate isn't run: `error`, "dsh's shell here doesn't sandbox commands, so dish won't run the gate". When no sandbox runner works, dsh refuses to run unconfined (`SANDBOX_UNAVAILABLE`), and that is an `error` too, "the sandbox couldn't run the gate: …", never a retry.
- **Outcomes.** `passed` is exit 0. `failed` is any other exit, a timeout, or a gate killed with no exit code. A sandbox refusal is recognised by "Read-only file system" in the output, and the message to the coder says where a gate can write.
- **Timeouts and cancels** kill the gate's whole process tree: bwrap runs it in a PID namespace of its own.
- **dsh's spill files** of a cut run (the whole output, unmasked) are removed: the gate keeps its own log.

### The environment

A gate runs in the sandbox the coder's own commands run in, with dsh's environment and the scrub dsh gives every agent shell, plus the project's `gateEnv`, with `<clone>` and `<worktree>` in its values replaced. dish sets no `HOME`, `XDG_*`, `GOPATH`, `npm_config_cache` or `CARGO_HOME`. So a gate runs a command the way the coder's own run of it did, and finds the caches and installs the coder's did.
- **Tools from mise.** Unless `gateEnv` sets `PATH` (which then wins as given), the gate's `PATH` is dsh's own followed by mise's shims, `${XDG_DATA_HOME:-~/.local/share}/mise/shims`, when that directory exists. So bare tool names (`go test ./...`, `cargo test`, `pytest`) resolve through mise's shims, and `mise exec -- …` works too. The service's own `PATH` on the VM has no `go` or `cargo`. The shims come after the system's directories, so dish's own node still comes first, and a shim runs sandboxed, as everything the gate starts does.
- **On dish's VM,** the sandbox writes the home directory, less sandbox-home's protected list ([deploy/README.md](../../deploy/README.md#the-sandbox)). Go's build cache, pnpm's store and mise's installs work as they do for the coder.
- **In dev,** without `DISH_SANDBOX_HOME=on`, the home directory is read-only to a gate. A project whose gate writes a cache points it into the clone with `gateEnv`, such as `GOCACHE: <clone>/.worktrees/.cache/go-build`.
- **In dev with `DISH_SANDBOX_HOME=on`,** dev's clones under `<checkout>/.dev/work` sit inside the protected checkout, so they are read-only to every sandboxed command, a gate included (sandbox-home's known limit). Gate dev projects without it.

`gateEnv` is checked by [`dish-projects`](../projects/README.md#projectsyaml) when it is saved: no `DSH_*` names, no names that look like secrets, and no `HOME` or `LD_*` (they reach the sandbox runner, which runs outside the sandbox). `XDG_*` may move a cache; the sandbox runner protects dish's own directories wherever it points. Its values are never logged, recorded or sent to the coder.

## The message to the coder

Sent after a failure with rounds left (round 1 and 2 of 3), as a message in the coder's session from `dish-gates`, with a one-line summary such as "Gate failed (round 1 of 3): exit 1":

> The gate failed (round 1 of 3): `pnpm test` exited 1 after 42 s.
> Last lines of its output:
> ```
> …the last `tailLines` lines, at most 16 KiB…
> ```
> Full log: `<path>`. Fix it in your worktree, then finish again with your whole report as your closing message: it replaces the one above. The gate runs again when you do.
> If you're blocked, start your closing message with `BLOCKED: <question>` or `NEEDS CONTEXT: <what you need>`, and the gate is skipped.

On a timeout the first line says the gate "was stopped at its time limit (<limit>)", and with no exit code that it "was killed". A gate that printed nothing says so. A sandbox refusal adds where a gate can write. In the next-to-last round the message adds "If it fails once more, your turn ends with the failure, and the main agent decides what's next." The output isn't screened (it is the coder's own), but secrets in it are masked (dish-kit's `maskSecrets`) before it reaches the message, the log or the record.

The judge never reads this message: a child's task, for the judge, is its brief and its latest instruction from its parent or a person.

## The logs

`<state>/gates/<owner>/<repo>/<slug>/<child>-<turn>-<round>.log`, where `<state>` is dish's state directory (`~/.local/state/dish` on the VM, `<checkout>/.dev/state/dish` in dev). One per gate that ran: a header (the gate, the worktree, how it ended and after how long, and whether the output was cut), then the kept output, masked.
- **Written new:** directories 0700, files 0600, never through a link. A name that is taken gets `.2`, `.3` and on.
- **Pruned** at start, and every day while dsh runs: `.log` files older than 30 days, and the directories that leaves empty.
- **A log that can't be written** doesn't change the result: the record's `log` is `null`, and the message to the coder says why.

## The record

Each result is a `GateResult` in crew's record of the child: on the child while its run is in progress, then on the run when it ends (`children.json`, see [crew's README](../crew/README.md#gates)). dish-gates writes it with `dishCrew.records.addGate`, awaited before the turn can close, so it lands before crew files the run. Restarts don't reset the rounds of a turn. A gate cut short by a restart records nothing: the gate dies with dsh, and the run it was in has no gate result, so a review of it needs a ruling.

## The service

```ts
interface DishGates {
  /** The gate dish-gates runs for a project's bound coders: projects.yaml's `gate` as it is now; undefined for a project that isn't registered, or without dish-projects. */
  gateFor(project: string): Promise<string | undefined>
}
```

Crew reads `dishGates` without depending on this plugin. The service being there is what turns on crew's side: the gate sentence in a bound coder's brief (from `gateFor`), the finish notice's "Gate not run." for a run with no result, and the review check.

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-gates` | `maxRounds` | `3` | Gate runs per turn, at least 1. A failure with rounds left goes back to the coder; the failure in the last round ends its turn. |
| `dish-gates` | `tailLines` | `200` | How many of a failed gate's last lines the coder is sent, at least 10, and at most 16 KiB. The whole output is in the log. |
| `dish-gates` | `terminal` | `true` | Print this plugin's messages to the terminal: one line per gate run ("child <id>, round N, <worktree>: passed in 42 s"), and warnings. |

## Known limits

- **10 minutes at most.** dsh caps a shell run at 10 minutes, and a turn stays running for as long as its gate does. A long build like an image isn't a gate: use its lint or validate step. dish could wait longer with a deadline of its own (`onExpiry: 'none'`); it doesn't.
- **A long gate holds the turn.** At worst a turn takes `maxRounds` × `gateTimeout`. The coder counts as running all that time, so the writer limit keeps another coder from starting.
- **Gates can run twice.** The coder's prompt and skills tell it to run the gate before it finishes, and then dish runs it again.
- **The closing message comes from `session/event`.** A message written before dish-gates loaded is missed, which matters only for a turn that ends right after a reload: then there is no opt-out, and the gate runs.
- **The home directory is shared.** A gate's caches and installs land where the coder's do, across workspaces (sandbox-home's limits).
- **dsh's `agent/turn-stopping` and `steer`** are relied on as dsh 0.2.0-rc.2 has them; `test/plugin.test.ts` runs real crew children through dsh's agent loop to pin them. Check again after a dsh upgrade.
