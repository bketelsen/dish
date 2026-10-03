# Orchestrator Implementation Plan (step 7)

> **For agentic workers:** REQUIRED SUB-SKILL: use subagent-driven-development (recommended) or executing-plans to carry out this plan task by task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **The user's answers, 2026-10-03** (the [spec](../specs/orchestrator.md)'s four questions, all as recommended):
> 1. **GitHub rulesets** protect each project's default branch (require a pull request, block force pushes and deletions). The user sets them up on GitHub; dish builds no token broker ([The rollout](#the-rollout-for-you)).
> 2. **Only `open_pr` pushes.** Agents' own git keeps read-only tokens.
> 3. **Ledgers are kept forever.** Nothing prunes them.
> 4. **One `ruling` parameter** on `delegate`, for round 5+ and for a review past a gate that hasn't passed; `gateOverride` stays as its synonym.

> **Spec corrections, 2026-10-03.** The plan changes the approved spec in fourteen places ([Spec corrections](#spec-corrections-for-the-user)). 1, 2 and 4 are new decisions, for your review. 3 extends your answer 1: confirm it at the rollout's step 2. The rest are obvious. The spec was revised to match, in the same commit as this plan ("Revised 2026-10-03 from the plan" in its status line), so the build reviews against one contract.

**Goal:** Build what the [orchestrator spec](../specs/orchestrator.md) describes, with the corrections below:
- `dish-orchestrator`: runs (owned by the project, driven by one chat at a time, resumable, and reopened for review feedback on their pull request), a ledger per run that the harness writes, the `run` and `open_pr` tools, the `dishRuns` service, and a read-only Runs page;
- crew: structured reports (`report`, for coders and reviewers), their steer, the closing note and the report guard's words for them, the notice built from the reports, the events orchestrator listens to, and `delegate`'s `ruling`, `final`, run tagging and the round-5 stop;
- dish-gates: gating a coder that finishes with `report`, the opt-out from its `status`, each result's `head`, its event, and `runAt` for `open_pr`;
- dish-workspaces: `headOf`, `isClean`, `pushBranch`, `openPull` and `commentPull` (a write token minted in memory per call), and the run hooks on the `worktree` tool and the sweep;
- prompts and skills to match, deploy and docs, a scratch end-to-end run, and then the rollout with you.

**Architecture:**
- **One new plugin, `dish-orchestrator`.** A host plugin, like `dish-gates`. It provides `dishRuns`, registers the global tools `run` and `open_pr` (main agent only), listens to crew's and gates' events, and owns the run records and the ledgers. It reads `dishCrew`, `dishGates`, `dishWorkspaces`, `dishProjects` and dsh's `agents` with `ctx.get` on each use, and injects only `tools` (through `ctx.inject`, for the tools) and `remote` (for the page).
- **Producers publish, orchestrator writes.** crew and dish-gates never write the ledger: they publish cordis events, or call `dishRuns`, and orchestrator turns those into ledger entries (`by: 'harness'`). The main agent's entries come only through `run` (`by: 'main'`).
- **Everything reads services structurally.** crew, dish-gates and dish-workspaces read `dishRuns` with `ctx.get`, and work as today when it's absent. No package gains a runtime dependency on another plugin.
- **dish's own git stays in dish-workspaces.** orchestrator and dish-gates run no git: heads, cleanliness, pushes, pull requests and their comments go through `dishWorkspaces`.
- **The preset stays with crew.** `report` is registered on each coder's and reviewer's own scope at `agent/created`, never in the preset; `run` and `open_pr` are global, like `worktree`.
- **Locks have one order.** A session's lock before a run's (orchestrator); no `dishRuns` hook is called while dish-workspaces holds a project's lock; orchestrator's hooks call no locking method of dish-workspaces. `open_pr` holds a run's lock while `pushBranch` takes the project's, so nothing waits the other way.

**Tech Stack:**
- TypeScript run by Node 24's type stripping (erasable syntax only), `node --test`, Cordis;
- dsh 0.2.0-rc.2: `dsh-tools` (`defineTool`, `ToolRunContext.concludeTurn`), `dsh-agent` (`agent/created`, `agent/turn-stopping`, `agent.steer`), `dsh-llm` (`createUserMessage`, at runtime in crew and dish-gates), and dsh's real shell stack in the dish-gates tests, as 6c;
- the web client as Settings → GitHub App and Settings → Judge build theirs (`TypertRemoteService`, dish-kit's `markRemote` and `client.ts`, `settings.section` slots, `build-client.mjs`);
- git 2.47 in fixtures; for pushes and the REST calls, dish-workspaces' fakes: its smart-HTTP git server (`test/fake-git-http.ts`, `git http-backend` on `127.0.0.1`) and its GitHub API (`test/fake-github-api.ts`), reached only through `WorkspacesInternals`.

**Spec:** [docs/specs/orchestrator.md](../specs/orchestrator.md), approved 2026-10-03 and revised 2026-10-03 to match the corrections below. It builds on [crew](../specs/crew.md), [gates](../specs/gates.md) (6c), [projects and workspaces](../specs/projects-workspaces.md) (6b), [sandbox-home](../specs/sandbox-home.md) and the [design](../design.md). Its [Checks](../specs/orchestrator.md#checks-2026-10-03) say what dsh does that this plan relies on.

Model the code on `plugins/gates` (a host plugin, injected dependencies, the real-shell tests), `plugins/crew` (record, notice, host listeners, `control.ts`), `plugins/judge` (the JSONL log, the remote service, the client page) and `plugins/workspaces` (git, the App client, tokens, real git fixtures and its fakes).

## Spec corrections (for the user)

I checked each interface the spec names against `main` (`3e44720`) and dsh 0.2.0-rc.2's sources under `node_modules/.pnpm`. Two spikes ran in a scratch `HOME` with git 2.47.3: a credential helper reading the token from an inherited fd 3, and a push from an isolated bare repository (Task 6).

Each item says what the spec said, what's true now, the change, and the tasks it touches. Items 1, 2 and 4 are new decisions, applied, for your review. Item 3 extends your answer 1, to confirm at the rollout. Items marked **obvious** are applied. The spec was revised to match all of them on 2026-10-03.

1. **Review feedback on a pull request** (Runs: driving and resuming, ending a run; The PR; The ledger). *New, applied; for your review.*
   - **Spec:** `open_pr` ends the run with `state: pr`, only `open_pr` pushes, and `resume` "succeeds when the run is open".
   - **True:** then nothing can add commits to an open pull request's branch. Review feedback on a PR would need a new run on the PR's branch, and a second PR.
   - **Change:**
     - `run` `resume` reopens a run in state `pr`: it is `open` again and keeps its `pr`, when its worktree is still one dish made (the sweep removes it once the PR merges). The ledger gets `run.resumed` with `reopened: true`.
     - `open_pr` on such a run runs the same checks, then pushes the new head to the same branch. `openPull` reports the PR as `existing`, and the ledger gets `pr.updated` (URL, number, head), not `pr.opened`; then `run.closed`, as before.
     - The PR's title and body aren't edited, so `title` and `body` may be empty on such a run. If a check was overridden, dish posts the override line(s) as a PR comment, through a new `dishWorkspaces.commentPull(project, number, body)` (`POST /repos/{o}/{r}/issues/{n}/comments`, masked, with a Pull requests write token).
     - The same holds when a pull request for the branch was already open on a first `open_pr`.
   - **Tasks** 6 (`commentPull`), 7 (`pr.updated`, the record's state rules), 8 (`drive`), 9 (`resume`, `list`), 10, 11, 12, 13.

2. **A final review stays final** (The PR, step 3; The tools). *New, applied; for your review.*
   - **Spec:** "A final review is one `delegate` started with `final: true`." It says nothing of follow-ups.
   - **True:** the skills re-review with `to`. subagent-driven-development's final review is one fix round, then "one scoped re-review of the new head" to the same reviewer. If that verdict didn't count, every final fix round would need a second, fresh final reviewer.
   - **Change:**
     - `final` is sticky on crew's record: a reviewer started with `final: true` stays final for its follow-ups, and a follow-up with `final: true` makes a reviewer final.
     - `final` comes through `dishRuns.place`, so it is recorded only for a reviewer in a run. Elsewhere `delegate`'s answer says it had no effect; nothing is refused.
     - `final` on a role that doesn't review is refused, with why.
   - **Tasks** 1, 4, 8, 10.

3. **The rulesets need one approval** (Questions for you, 1; the rollout). *Extends your answer 1: confirm at the rollout's step 2.*
   - **Your answer:** rulesets that require a pull request and block force pushes and deletions.
   - **True:** with Contents write, an installation token can merge a pull request through the API (`PUT /repos/{owner}/{repo}/pulls/{n}/merge` needs Contents write). A ruleset that requires a pull request with 0 approvals lets any writer merge one, the App included. A key reader could open a PR and merge it.
   - **Change:** Required approvals 1, "Dismiss stale pull request approvals when new commits are pushed", and "Require approval of the most recent reviewable push". You are on the bypass list (repository admin, and organization admin for frostyard); the App never is. A bot can't approve its own PR. Workflows stays off.
   - **Tasks** 6 (the App's texts), 13 (the rollout).

4. **What coders and reviewers are told about reporting** (Structured reports). *New, applied; for your review.*
   - **Spec:** coders and reviewers finish with `report`. It says nothing of crew's closing note or its report guard.
   - **True:** `closingNote` (`plugins/crew/src/delegate.ts:125-130`) tells every child "Your closing message is your report", and the report guard's refusal (`report-guard.ts:110`) says "write the report as your closing message". A coder would read those beside its prompt's `report`.
   - **Change:**
     - Coders and reviewers get `reportNote` in place of `closingNote`. It begins with `RETURN_NOTE_LEAD` and the parent's id (where dish-judge ends a child's brief), says to finish with `report`, and keeps `send_message` for a short question the child is blocked on.
     - The report guard's two refusals name `report` for a child crew gave it.
     - Architect, researcher, ops and writer keep both texts, byte for byte.
   - **Tasks** 2 (the guard), 4 (the note).

5. **`reportSteers: 0`, and who is steered** (Requiring it; Configuration). *Obvious, applied.*
   - **Spec:** `0` "turns the requirement off, and coders and reviewers end with text, as today".
   - **True:** the shipped prompts and the closing note tell them to call `report`. Removing the tool at `0` would leave them told to call a tool they don't have.
   - **Change:**
     - `0` turns the steer off. `report` stays registered, and a coder that ends with text is gated by dish-gates' rule of today.
     - crew steers only a child it registered `report` on. A child created before crew loaded has none to call.
     - dish-gates' plugin test sets `reportSteers: 0` for its tests that end with text.
   - **Tasks** 2, 5.

6. **The reviewer's `head` is a full sha** (the reviewer's schema). *Obvious, applied.* `open_pr` compares it with the head it pushes, and an abbreviated one could match another commit. `report` refuses a `head` that isn't 40 (or 64) hex digits, and says how to get it (`git rev-parse HEAD`). **Task** 2.

7. **Where a child is placed** (The tools: `delegate` "tags every child with the run and task it belongs to"; The ladder). *Obvious, applied.*
   - **True:** run ids are unique only within a project. And after a takeover, the chat that lost a run can still follow up its own coder bound to one of the run's tasks: placed by its chat, that round wouldn't count.
   - **Change:** `dishRuns.place(sessionId, { worktree?, reviews?, final? })` gives `{ run, task?, round?, final? }`.
     - `run` is a ref, `<owner>/<repo>/<id>`, which `ChildRecord.run` holds. A ledger entry's `run` stays the bare id.
     - A bound child is placed in the run that owns its worktree, whichever chat drives it. A reviewer is placed where the child it reviews is. Anything else goes to the chat's own run, with no task.
     - crew publishes `dish-crew/delegated` and awaits it inside its session lock, and `place` waits for the ledger's queue, so a task's rounds count exactly.
     - A released run's `driver.session` is `''`: the record's `driver` has no other way to say nobody drives it.
   - **Tasks** 1, 4, 7, 8.

8. **The structured report in crew's record** (Where it goes). *Obvious, applied.* "Moved onto the run at `endRun`": `RunRecord.report` is already the `.md` report's path (`record.ts:106-107`), which the notice cites. The report goes on `RunRecord.structured`, its `.json` path on `RunRecord.structuredFile`, and `report` stays the `.md`. **Task** 1.

9. **The worktree hooks** (Where the events come from). *Obvious, applied.*
   - The `worktree` tool calls `dishRuns.worktreeCreated` after `createWorktree` returned, outside the project's lock, and `worktreeRemoved` after its remove. The sweep calls `worktreeRemoved` for each worktree it removed, once its lock is released.
   - `run open` makes its worktree through `createWorktree`, which calls no hook, and records it itself.
   - **Why:** `open_pr` holds a run's lock while `pushBranch` waits for the project's. A hook awaited under the project's lock and waiting for the run would deadlock.
   - **Tasks** 6, 8, 9.

10. **`open_pr`'s checks, exactly** (The PR, steps 1, 2 and 5). *Obvious, applied.*
    - **Clean** is `dishWorkspaces.isClean`: nothing uncommitted or untracked, `dish/<slug>` checked out, no nested worktree or repository (`Worktrees.dirty`, `worktrees.ts:393`), with the reason.
    - **No coder at work:** it refuses while a coder bound to the run's worktree is running, which could commit between the checks.
    - **The same head throughout:** `dishGates.runAt` takes the head and gives `error` if the worktree's HEAD moved before the gate ran; `pushBranch` takes the head and refuses unless the branch is at it. The head that was checked is the head pushed.
    - **Tasks** 5, 6, 10.

11. **`pr.opened` holds the branch, not the base** (The ledger). *Obvious, applied.* `openPull` always opens against the project's default branch and gives `{ url, number, existing }`; the PR shows its base. **Tasks** 6, 10.

12. **Each gate result's head comes through dish-workspaces** (Where the events come from). *Obvious, applied.* The spec reads it "with `git rev-parse HEAD` in the worktree", but dish-gates runs no git (6c's rule). `GateResult.head` is `dishWorkspaces.headOf`'s answer, or `null`. **Tasks** 1, 5.

13. **Prompts and skills** (Prompts and skills). *Obvious, applied.*
    - **Five more skills change:** `test-driven-development`, `verification-before-completion`, `receiving-code-review` and `systematic-debugging` told coders to run the gate to finish, and `changing-infrastructure` told ops to push.
    - **`open_pr` needs no user yes** at the end of a run: it merges nothing, and its checks are structural. `main.md`'s "stop and ask before … pushes" changes to match.
    - **Outside a registered project** there is no run: the skills keep the ledger file, and the user pushes.
    - **Task** 12.

14. **Pushes in tests go to dish-workspaces' fake git server, not `file://`** (Testing). *Obvious, applied.* git never asks a credential helper for `file://`, so such a push can't show the write token reaching git, a read token refused, or the clone's own helper unused. The fake git server (`plugins/workspaces/test/fake-git-http.ts`) shows all three. It is reached through `WorkspacesInternals.web` (`service.ts:141`, "For tests only; never config"), which production can't set. The end-to-end run uses the same seam. **Tasks** 6, 13.

## Global Constraints

- **Safety, for every implementer.** It is not negotiable.
  - **Never run against real state.** dsh, `pnpm dsh`, `pnpm dev` and `deploy/install.sh` never run against the real `~/.dsh`, `~/.config/dish`, `~/.local/state/dish`, `~/.local/share/dish`, `~/.cache/dish`, `~/work`, or the VM.
  - **Live runs use scratch directories:** `HOME`, `DSH_HOME`, `XDG_CONFIG_HOME`, `XDG_STATE_HOME`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `DSH_DISH_HOME`, `TMPDIR` and `HISTFILE`; `pnpm_config_store_dir` set to what `pnpm store path` prints in your normal shell.
  - **Every process a test spawns gets a scratch `HOME`.** Run test files only through `pnpm test`, whose preload gives each test process its own `HOME` and `HISTFILE`.
  - **git in fixtures** gets a scratch `HOME` with a test identity, and `GIT_CONFIG_NOSYSTEM=1`.
  - **No network.** No test reaches GitHub, a model, TypeSafe or any other host.
    - GitHub's API is dish-workspaces' fake (`test/fake-github-api.ts`), or a stub `fetch`.
    - Pushes go to dish-workspaces' fake git server (`test/fake-git-http.ts`, a bare repository behind `git http-backend` on `127.0.0.1`), reached only through `WorkspacesInternals.web`, which production can't set. No `file://` push.
    - The end-to-end run's model is a scripted server on `127.0.0.1`, and its GitHub is those fakes, run on `127.0.0.1`.
  - **Don't read `.envrc`,** and don't run `env` or `printenv`. **Never print a token,** a key, or a credential file.
  - **The VM, incus, ansible and `~/projects/fleet` are off limits.** The rollout is the user's.
- **Check exit codes.** Never pipe the gate through `tail` or `head`.
- **Branch `orchestrator`.** Task worktrees are cut from it. Humans merge.
- **Repo conventions** (as in the gates plan):
  - Node 24, erasable TypeScript only (no `enum`, `namespace`, parameter properties or `import x =`); `verbatimModuleSyntax`; relative imports keep `.ts`; no build step for server code; tests in `<package>/test/*.test.ts`.
  - **`@deepseek-ai/*` at runtime** only from packages declared under both `peerDependencies` (`^0.2.0-rc.2`, cordis `~4.0.4`) and `devDependencies` (`0.2.0-rc.2`). Other plugins' types come in with `import type`, never at runtime.
  - **Services** a plugin doesn't `inject` are read with `ctx.get(name)` on each use. `apply` registers listeners synchronously, before anything is awaited.
  - **Logs** as the plugin's name, printed with `printOwnLogs` when its `terminal` row is true.
  - **Shipped defaults** (prompts, skills, `crew.yaml`) that change get their `previous.json` regenerated with `node packages/dish-kit/scripts/previous-defaults.mjs`, after the change is committed and squashed into its final form.
- **The gate per task:** `pnpm typecheck && pnpm test` passing, and one commit with the message given.
- **The lockfile.** Only Task 0 runs `pnpm install` and changes `pnpm-lock.yaml`; it declares every dependency later tasks need (crew's dsh-llm peer included). A later task that finds one missing stops and reports `NEEDS_CONTEXT`. Every other task worktree runs `pnpm install --offline --frozen-lockfile`, with `pnpm_config_store_dir` set, before its gate.
- **dish's own git.** `git()` in `plugins/workspaces/src/git.ts` stays the only way dish's own code runs git. No `child_process` in `plugins/orchestrator/src` or `plugins/gates/src` (grep it).
- **Pushes.** Only `dishWorkspaces.pushBranch`, called only by `open_pr`.
  - The write token is minted for that one call, kept in memory, handed to git on an inherited fd 3 (never on disk, in an argument or in the environment), and dropped after. The helper's token files stay read-only, and `createToken`'s read-only guard stays for every other caller.
  - The push runs from an isolated bare repository of dish's own, to the project's HTTPS URL (`httpsUrl`), never to `origin`, with an explicit refspec `refs/heads/dish/<slug>:refs/heads/dish/<slug>`; never `--force`, `+` or a delete.
  - Only branches named `dish/<slug>` of a worktree dish made can be pushed (`resolve` must answer for it), and only at the head `open_pr` checked: `pushBranch` refuses unless the branch is at its `head`.
- **The ledger is append-only.** No code path rewrites, truncates or deletes a ledger file. Every line is masked (`maskSecrets`) before it is cut to 16 KiB.
- **Secrets.** Report fields, rulings, notes, PR bodies, PR comments and ledger lines go through `maskSecrets` where they're written (record, ledger, notice, log, GitHub). A PR body or comment is masked before it is sent; a token never reaches a log, a ledger line, an error message or the record.
- **What must not change:**
  - 6b's contracts: `dishWorkspaces.resolve`, `resolveProblem`, the `Worktree` shape, `createWorktree`'s signature (its result gains `baseRef`), the sweep's rules, the helper's read-only tokens.
  - 6c's: `GateResult`'s existing fields (one is added: `head`), the round rules, `maxRounds`, the review check's behaviour (only its parameter gains a synonym), `worktreeBrief`'s text without a gate.
  - crew: `CrewRecords`' existing methods and files (fields are added); `dish-crew/control`; `closingNote`'s text and the report guard's two refusals for every role but coder and reviewer, byte for byte. Coders and reviewers get `reportNote` in place of `closingNote`, and refusals that name `report` ([correction 4](#spec-corrections-for-the-user); Tasks 2 and 4).
  - A profile without `dish-orchestrator` behaves as today, except that coders and reviewers report with `report` and are told so (crew's change, which needs nothing from orchestrator).
- **Contracts** shared between tasks:

  | Name | Value |
  |---|---|
  | package | `plugins/orchestrator`, `dish-orchestrator`; logs as `dish-orchestrator`; service `dishRuns` |
  | `<state>`, `<data>` | dish-kit `xdgPaths('dish').state` and `.data` |
  | run record | `<state>/orchestrator/<owner>/<repo>/runs/<id>.json`, atomic writes, 0600 in 0700 directories: `{ id, project, slug, goal, plan?: { path, commit }, branch, worktree, base, baseCommit, state: 'open' \| 'pr' \| 'abandoned', pr?: { url, number }, reason?, driver: { session, since }, openedAt, closedAt? }`. `base` is the ref it was cut from (`CreatedWorktree.baseRef`). A reopened run is `open` and keeps its `pr`; `closedAt` only when not `open` |
  | released | `driver.session === ''`: nobody drives the run, and it is never live. Opening or resuming another run, and closing this one, release it |
  | run id | `<yyyymmdd>-<slug>` (UTC date); a second run with that id in the project gets `-2`, `-3`, … |
  | run ref | `<owner>/<repo>/<id>`: what `place` gives and `ChildRecord.run` holds. A ledger entry's `run` is the bare id |
  | session id | the main agent's `String(agent.id)`, as crew's `delegate` takes it (`delegate.ts:819`): the driver, `place`'s and the hooks' `sessionId`, and dsh's agent registry key |
  | ledger | `<data>/ledgers/<owner>/<repo>/<id>.jsonl`, the judge's append pattern (`O_APPEND\|O_CREAT\|O_WRONLY\|O_NOFOLLOW`, 0600 in 0700, a queue per file, the torn-line guard), lines masked then cut to 16 KiB; never pruned |
  | ledger entry | `{ at, run, kind, by: 'harness' \| 'main', session?, child?, task?, ...fields }`; kinds as the spec's two tables, with `pr.updated` and `run.resumed`'s `reopened` (correction 1) |
  | owner, repo, slug in paths | each one path segment of `[A-Za-z0-9._-]`, not `.` or `..` (checked by orchestrator itself) |
  | driving | a session drives at most one open run; `driver.session` in the record; live = dsh's `agents` registry has an agent with that id |
  | task | a worktree of the run, by its slug; the run's own worktree is task `<slug>` |
  | round | for a task: the 0-based index of a coder start or follow-up among that task's coder starts and follow-ups (the first start is 0), counted from the ledger |
  | ladder | round 1–4: advisory note in `delegate`'s answer; round ≥ 5: refused unless `ruling`; reviewers and children outside a run aren't counted |
  | `StructuredReport` | crew's `record.ts`: `CoderReport \| ReviewerReport`, each with `role`, `turn` (the dsh turn it ended) and `at` |
  | `CoderReport` | `{ role: 'coder', status: 'done' \| 'blocked' \| 'needs_context', summary, commits?: string[], blockedOn?: string, rulings?: { what, why, costIfWrong }[], concerns?: string[], notFixed?: { finding, why }[] }` |
  | `ReviewerReport` | `{ role: 'reviewer', verdict: 'approved' \| 'changes_requested', head /* a full sha */, summary, findings: { severity: 'blocking' \| 'should_fix' \| 'nit', file, line?, summary, fix }[], checks?: { command, exitCode, summary }[], addressed?: { finding, addressed, evidence }[] }` |
  | `report` tool | registered on a crew coder's or reviewer's own `agent.ctx` at `agent/created`; validates, records (`records.setReport`), returns the stored report as its value, calls `exec.concludeTurn()`; a later call in the same turn replaces the earlier |
  | report steer | crew's `agent/turn-stopping` listener, **prepended**: a coder or reviewer this crew instance registered `report` on, whose turn ends with no successful `report` since its newest assistant message, is steered, at most `reportSteers` (2) times a turn; `dishCrew.reportSteered(childId)` is true from that steer until the child's next assistant message |
  | closing note | coders' and reviewers' `reportNote(parentId, marked)`: `RETURN_NOTE_LEAD`, the parent's id, finish with `report`, `send_message` only for a short blocking question. Every other role keeps `closingNote`, byte for byte (correction 4) |
  | report guard's words | `REFUSED_REPORT` / `CLOSED_REPORT` for a child crew gave `report`; `REFUSED` / `CLOSED` unchanged for the rest |
  | gating with `report` | dish-gates gates a bound coder when (a) a successful `report` concluded the turn with `status: 'done'`, or (b) the newest message has no tool calls and `reportSteered` is false; `blocked`/`needs_context` skip, as the text opt-out still does |
  | `GateResult.head` | `string \| null`, absent on older records: the worktree's `HEAD` when the gate ran (`dishWorkspaces.headOf`), or `null`. The type and its parse are Task 1's; dish-gates fills it (Task 5) |
  | events | `dish-crew/delegated (e: { sessionId, child: ChildRecord, followUp: boolean })`, after `addChild`/`addFollowUp`, published and awaited inside `delegate`'s session lock; `dish-crew/settled (e: { sessionId, child: ChildRecord, run: RunRecord })`, after `endRun`; `dish-gates/result (e: { childId, sessionId, result: GateResult })`, after `addGate`; each published with `ctx.parallel`, as dish-projects does, and declared on cordis' `Events` |
  | `ChildRecord` additions | `run?` (a run ref), `task?`, `final?: true` (sticky: set at the start or by a follow-up, never cleared), `report?: StructuredReport` (the run in progress's) |
  | `RunRecord` additions | `structured?: StructuredReport` (`endRun` moves `ChildRecord.report` here), `structuredFile?` (the `<n>-<role>-<run>.json` path), `notice?` (the finish notice's message id). `report` stays the `.md` path |
  | `dishRuns` | `driving(sessionId): Promise<RunInfo \| undefined>`; `place(sessionId, { worktree?, reviews?, final? }): Promise<{ run: string, task?: string, round?: number, final?: true } \| undefined>`; `worktreeCreated(sessionId, created: { project, slug, branch, path, clone, base, baseRef }): Promise<{ id: string, opened: boolean } \| undefined>`; `worktreeRemoved(project, slug): Promise<void>`; `ladder(entry: { sessionId, run, task, round, outcome: 'refused' \| 'ruled', ruling?, child? }): Promise<void>`. None rejects. A bound child is placed in the run that owns its worktree |
  | the hooks | `worktreeCreated`: called by dish-workspaces' `worktree` tool after `createWorktree` returned, outside the project's lock. `worktreeRemoved`: after the tool's remove, and after each sweep removal once the sweep's lock is released. Orchestrator's hooks never call dish-workspaces' locking methods. `run open` calls `createWorktree` directly: no hook fires for it |
  | `dishWorkspaces` additions | `headOf(pathOrRef): Promise<string \| undefined>`; `isClean(pathOrRef): Promise<{ clean: true } \| { clean: false, why: string }>`; `pushBranch(project, slug, { head, signal? }): Promise<{ head: string }>` (refused unless the branch is at `head`); `openPull(project, { head, title, body }): Promise<{ url, number, existing }>`; `commentPull(project, number, body): Promise<void>` |
  | `dishGates` addition | `runAt(project, worktreePath, { sessionId, head?, signal? }): Promise<GateCheck>`; `GateCheck = Omit<GateResult, 'turn' \| 'round' \| 'maxRounds'>` |
  | `delegate` parameters | `ruling` (one line, `Ruling: what — why — cost if wrong`), `gateOverride` (its synonym), `final` (reviewer only; sticky) |
  | tools | `run` and `open_pr`: global, main agent only (`mainSession`), and on crew's `NEVER` list |
  | override line | `⚠ dish: opened past a failing gate. Ruling: …` / `⚠ dish: opened without an approved final review of this head. Ruling: …`, appended to a new PR's body after a blank line, one each; posted as a PR comment when the PR was already open (correction 1) |
  | config rows | `dish-orchestrator`: `terminal` (true); `dish-crew`: `reportSteers` (2, `0` turns the steer off; `report` stays) |
  | Settings page | Runs, `settings.section` order 51 |
  | bundles | `install.sh`: `… workspaces gates orchestrator` |

## Review Focus

1. **A push that shouldn't happen.**
   - Only `open_pr` pushes, only after its checks (or a ruling), only `dish/<slug>` of a worktree dish made, only at the head it checked, to the explicit HTTPS URL, from dish's own isolated repository, never forced.
   - A run reopened for review feedback pushes only through the same checks, to the same branch.
   - The write token never touches disk, an argument, the environment or a log (Tasks 6, 10).
2. **A ledger line the main agent could forge.** Every `by: 'harness'` entry comes from a listener or a service call made by harness code, never from a tool argument; `run`'s own entries are always `by: 'main'` (Tasks 7, 8, 9).
3. **A check that passes when it shouldn't.**
   - `open_pr`'s gate runs on the head it pushes, in a clean worktree, with no coder at work in it.
   - The final review counts only if `final`, `approved`, and its `head` equals that head. A re-review of a final reviewer counts, since `final` is sticky; a non-final approval never does (Tasks 4, 5, 10).
4. **A coder that escapes its gate through `report`.** `status: done` is gated; a report followed by more edits and a stop is gated again; the text opt-out and `blocked` skip as before (Task 5).
5. **A loop.** The report steer is capped per turn; a report steer and a gate steer never both happen at one stop; the ladder's refusal can't be bypassed by a fresh coder on the same task, since rounds belong to the task (Tasks 2, 4, 5, 8).
6. **The wrong run or task.**
   - Tags come from `dishRuns.place` at delegation, inside crew's session lock, and `delegated` is awaited there, so rounds count exactly.
   - A bound child is placed in the run that owns its worktree; events carry the child's ids; a takeover doesn't mix two chats' children (Tasks 1, 4, 8).
7. **Stale or lost state across restarts.** Runs and ledgers survive a restart; a run with a dead driver can be resumed; a run with a PR can be reopened only while its worktree exists; rounds count from the ledger, not memory (Tasks 7, 8, 9).
8. **A deadlock.** No `dishRuns` hook runs under a project's lock; orchestrator's hooks take no lock of dish-workspaces, and `worktreeRemoved` takes none of orchestrator's; a session's lock is always taken before a run's (Tasks 6, 8, 10).
9. **Nothing changes without orchestrator,** except `report`, its steer, and what coders and reviewers are told. A profile without `dish-orchestrator` delegates, gates and reviews as today; other roles' closing note and guard texts are byte for byte (Tasks 2–6).
10. **Secrets** masked in reports, notices, ledger lines, PR bodies, PR comments and errors (all tasks; above all 1, 3, 6, 7 and 10).

---

## File Structure

```
plugins/orchestrator/                                                              dish-orchestrator
  package.json  cordis.patch.yml  README.md (stub)  tsconfig.client.json
    src/index.ts (stub)  src/protocol.ts (stub)  src/client/index.tsx (stub)                    (Task 0)
  src/text.ts  src/paths.ts  src/store.ts  src/entries.ts  src/ledger.ts  src/derive.ts
    test/helpers.ts  test/paths.test.ts  test/store.test.ts  test/ledger.test.ts  test/derive.test.ts   (Task 7)
  src/locks.ts  src/services.ts  src/service.ts  src/runs.ts  src/listeners.ts  src/index.ts
    src/run-tool.ts (stub)  src/open-pr.ts (stub)  src/remote.ts (stub)
    test/service-helpers.ts  test/runs.test.ts  test/listeners.test.ts  test/plugin.test.ts      (Task 8)
  src/run-tool.ts  src/status.ts  test/run-tool.test.ts  test/status.test.ts                    (Task 9)
  src/open-pr.ts  test/open-pr.test.ts                                                         (Task 10)
  src/remote.ts  src/protocol.ts  src/client/{index.tsx,remote.ts,controller.ts,outcome.ts,format.ts,entries.ts,
    Runs.tsx,RunList.tsx,RunView.tsx,Timeline.tsx,parts.tsx,styles.ts}
    test/remote.test.ts  test/client-remote.test.ts  test/controller.test.ts  test/client-entries.test.ts
    test/client-rendering.test.ts  test/jsx-lite/jsx-runtime.ts                                 (Task 11)
plugins/crew/package.json (the dsh-llm peer)                                                   (Task 0)
plugins/crew/src/record.ts  src/events.ts  src/index.ts  src/delegate.ts (the publications)
  test/record.test.ts  test/events.test.ts  test/plugin.test.ts  test/delegate.test.ts         (Task 1)
plugins/crew/src/report.ts  src/index.ts  src/report-guard.ts  cordis.patch.yml
  test/report.test.ts  test/report-guard.test.ts  test/plugin.test.ts  test/helpers.ts
  plugins/gates/test/plugin.test.ts (one line: reportSteers: 0)                                (Task 2)
plugins/crew/src/notice.ts  test/notice.test.ts                                                (Task 3)
plugins/crew/src/delegate.ts  src/text.ts  src/allow.ts  test/delegate.test.ts  test/allow.test.ts   (Task 4)
plugins/gates/src/locks.ts  src/check.ts  src/closing.ts  src/text.ts  src/logs.ts  src/listener.ts
  src/index.ts  cordis.patch.yml  test/check.test.ts  test/closing.test.ts  test/text.test.ts
  test/logs.test.ts  test/listener.test.ts  test/plugin.test.ts                                (Task 5)
plugins/workspaces/bin/git-credential-dish-push  src/push.ts  src/git.ts  src/paths.ts  src/github.ts
  src/tokens.ts  src/worktrees.ts  src/service.ts  src/index.ts  src/tool.ts  src/client/AppCard.tsx
  README.md  test/push.test.ts  test/publish.test.ts  test/runs.test.ts  test/git.test.ts
  test/helper.test.ts  test/paths.test.ts  test/github.test.ts  test/tokens.test.ts  test/tool.test.ts
  test/plugin.test.ts  test/fake-github-api.ts  test/fake-git-http.ts  test/service-helpers.ts   (Task 6)
plugins/prompts/defaults/{main,common,crew/coder,crew/reviewer}.md, previous.json
  plugins/skills/defaults/<eleven skills>/SKILL.md, previous.json
  plugins/prompts/test/pipeline-texts.test.ts  plugins/skills/test/defaults.test.ts            (Task 12)
deploy/install.sh  deploy/test/install.test.ts  deploy/README.md  README.md  ROADMAP.md  HANDOFF.md
  docs/design.md  docs/specs/{orchestrator,crew,gates,projects-workspaces,prompts,skills,deploy}.md
  plugins/{orchestrator,crew,gates,workspaces,projects}/README.md                              (Task 13)
pnpm-lock.yaml                                                                                 (Task 0 only)
```

## Waves

| Wave | Tasks (in parallel worktrees) |
|---|---|
| 1 | 0, 1 (needs nothing), 6 (needs nothing) |
| 2 | 2 (needs 1; 0 for the peer), 3 (needs 1), 4 (needs 1), 7 (needs 0) |
| 3 | 5 (needs 1, 2, 6) |
| 4 | 8 (needs 1, 5, 6, 7) |
| 5 | 9 (needs 8), 10 (needs 5, 6, 8), 11 (needs 7, 8) |
| 6 | 12 (needs 2, 4, 9, 10) |
| 7 | 13 (needs all), then the final whole-branch review |
| after | the rollout, with you |

**No two tasks of a wave edit one file.**
- **Wave 1:** Task 0 has `plugins/orchestrator/*`, `plugins/crew/package.json` and the lockfile; Task 1 crew's `src` and tests; Task 6 `plugins/workspaces`.
- **Wave 2:** Task 2 has crew's `report.ts`, `index.ts`, `report-guard.ts`, `cordis.patch.yml`, `test/helpers.ts`, `test/report*.test.ts`, `test/plugin.test.ts`, and the one line in `plugins/gates/test/plugin.test.ts`. Task 3 has `notice.ts` and `test/notice.test.ts`, whose host-plugin test it extends. Task 4 has `delegate.ts`, `text.ts`, `allow.ts` and their tests. Task 7 has orchestrator's store, ledger and derivation modules.
- **Wave 5:** Tasks 9, 10 and 11 each replace one stub Task 8 made (`run-tool.ts`, `open-pr.ts`, `remote.ts`); Task 11 also replaces Task 0's `protocol.ts` and `client/index.tsx`. None edits `index.ts`, `runs.ts` or `test/service-helpers.ts`: Tasks 9 and 10 add helpers inside their own test files.
- Tasks of one package in one wave start from the same commit, and the controller lands them one at a time onto the branch.
- **Between waves 2 and 3** the branch has `report` without Task 5: a coder that finishes with `report` isn't gated there. Nothing ships between them.

---

## Task 0: the `dish-orchestrator` package, and crew's dsh-llm peer

**Needs:** —

**Files:**
- **Create** `plugins/orchestrator/package.json`, `cordis.patch.yml`, `README.md` (a stub; Task 13 finishes it), `tsconfig.client.json`, `src/index.ts`, `src/protocol.ts` and `src/client/index.tsx`.
- **The stubs:**
  - `src/index.ts` is `export const name = 'dish-orchestrator'` and an `apply` that does nothing.
  - `src/protocol.ts` is its module comment and `export const NAMESPACE = 'dishRuns'`.
  - `src/client/index.tsx` is `export const inject: string[] = []` and an `apply` that does nothing. Without it, the client typecheck (`tsc -p tsconfig.client.json`, run by the root `pnpm typecheck`) finds no inputs and fails.
- **Modify** `plugins/crew/package.json`: `peerDependencies` gains `"@deepseek-ai/dsh-llm": "^0.2.0-rc.2"`. Its devDependency stays `0.2.0-rc.2`. Task 2's report steer imports `createUserMessage` from it at runtime, and the Global Constraints allow a runtime import only from a package declared under both.
- Run `pnpm install --offline`. Commit `pnpm-lock.yaml`.

**The package.** This is `plugins/judge/package.json`, adapted: the same `dsh.client` block, scripts and client devDependencies.
```json
{
  "name": "dish-orchestrator",
  "version": "0.0.1",
  "private": true,
  "description": "Runs: a change on its way to a pull request, its ledger, the run and open_pr tools, and Settings → Runs",
  "type": "module",
  "main": "./src/index.ts",
  "exports": { ".": "./src/index.ts", "./client": "./lib/client.js" },
  "files": ["src", "lib/client.js", "cordis.patch.yml"],
  "license": "MIT",
  "keywords": ["dsh-plugin"],
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "inject": ["@deepseek-ai/dsh-api-remotes", "@deepseek-ai/dsh-client-ui-settings"],
      "external": ["@deepseek-ai/dsh-api-gateway/client"]
    }
  },
  "dependencies": {
    "@deepseek-ai/schemastery": "~3.18.4",
    "dish-kit": "workspace:*"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": "~4.0.4",
    "@deepseek-ai/dsh-tools": "^0.2.0-rc.2",
    "@deepseek-ai/dsh-typert-protocol": "^0.2.0-rc.2"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "~4.0.4",
    "@deepseek-ai/dsh-agent": "0.2.0-rc.2",
    "@deepseek-ai/dsh-api-gateway": "0.2.0-rc.2",
    "@deepseek-ai/dsh-api-remotes": "0.2.0-rc.2",
    "@deepseek-ai/dsh-client-store": "0.2.0-rc.2",
    "@deepseek-ai/dsh-client-ui-primitives": "0.2.0-rc.2",
    "@deepseek-ai/dsh-client-ui-renderer": "0.2.0-rc.2",
    "@deepseek-ai/dsh-client-ui-settings": "0.2.0-rc.2",
    "@deepseek-ai/dsh-client-ui-slots": "0.2.0-rc.2",
    "@deepseek-ai/dsh-tools": "0.2.0-rc.2",
    "@deepseek-ai/dsh-typert-protocol": "0.2.0-rc.2",
    "@types/react": "~18.3.1",
    "esbuild": "^0.25.0",
    "dish-crew": "workspace:*",
    "dish-gates": "workspace:*",
    "dish-projects": "workspace:*",
    "dish-workspaces": "workspace:*"
  },
  "scripts": {
    "build": "node ../../packages/dish-kit/scripts/build-client.mjs",
    "dev": "node ../../packages/dish-kit/scripts/build-client.mjs --watch",
    "typecheck": "tsc -p tsconfig.client.json"
  }
}
```

**Who uses what,** so a later task finds it declared here:
- **At runtime in `src/`:**
  - `@deepseek-ai/schemastery`: `Config` (Task 8);
  - `dish-kit`: `maskSecrets`, `xdgPaths`, `printOwnLogs`, `isTopLevelAgent` and `markRemote`, and `dish-kit/client` in the browser (Tasks 7–11);
  - `@deepseek-ai/dsh-tools`: `defineTool` (Tasks 9 and 10);
  - `@deepseek-ai/dsh-typert-protocol`: `TypertRemoteService` (Task 11).
- **For types only:**
  - `@deepseek-ai/dsh-agent`: `ctx.agents`, and `exec.agent`'s session;
  - `dish-crew`, `dish-gates`, `dish-projects` and `dish-workspaces`, always with `import type`. They are also loaded by the plugin tests.
- **The client (Task 11):**
  - `dsh-api-remotes`, `dsh-client-store`, and `dsh-client-ui-primitives`, `-renderer`, `-settings` and `-slots`;
  - `dsh-api-gateway`, external as in judge's package;
  - `@types/react`.
- **In tests:**
  - `esbuild`, for the rendering test;
  - `remoteMethods` from dsh-typert-protocol;
  - `ToolRuntime` from dsh-tools;
  - the four dish plugins, for the plugin tests.

**`tsconfig.client.json`** is `plugins/judge/tsconfig.client.json`, byte for byte: `include: ["src/client", "src/protocol.ts"]`.

**`cordis.patch.yml`** inserts `{ id: dish-orchestrator, name: dish-orchestrator }`. Its header comment says:
- **What the plugin does:**
  - runs and their ledgers;
  - the main agent's `run` and `open_pr` tools;
  - the `dishRuns` service;
  - Settings → Runs.
- **That it is a host plugin.** It hears crew's and dish-gates' events, and reads `dishCrew`, `dishWorkspaces`, `dishGates`, `dishProjects` and dsh's `agents` with `ctx.get` on each use, so there is no order to keep.
- **Its row:** `terminal`.

**Steps:**
- [ ] Create the files, and add crew's peer. Run `pnpm install --offline` with `pnpm_config_store_dir` set. Check `git diff pnpm-lock.yaml`:
  - it adds the `plugins/orchestrator` importer, with the four dish plugins as `link:` devDependencies;
  - an importer records no peer specifiers, so crew's new peer shouldn't change it. If pnpm does change crew's entry for it, that change is part of this commit;
  - nothing else changes.
- [ ] Run `pnpm --filter dish-orchestrator build`. It writes `lib/client.js`, which git ignores (`plugins/*/lib/`).
- [ ] Run the gate.
- [ ] Commit `orchestrator: the dish-orchestrator package, and crew's dsh-llm peer`.

---

## Task 1: structured reports and gate heads in the record, and crew's events (`dish-crew`)

**Needs:** —.

**Files:**
- Create `plugins/crew/src/events.ts`; test `plugins/crew/test/events.test.ts`.
- Modify:
  - `plugins/crew/src/record.ts`, with `GateResult.head` (dish-gates fills it in Task 5);
  - `src/index.ts`;
  - `src/delegate.ts`: the two publications only.
- Tests: `plugins/crew/test/record.test.ts`, `test/plugin.test.ts`, `test/delegate.test.ts`.

**Interfaces:**
```ts
// record.ts
export type CoderStatus = 'done' | 'blocked' | 'needs_context'
export const CODER_STATUSES: readonly CoderStatus[]       // frozen, in that order
export type Verdict = 'approved' | 'changes_requested'
export const VERDICTS: readonly Verdict[]
export type Severity = 'blocking' | 'should_fix' | 'nit'
export const SEVERITIES: readonly Severity[]
export interface ReportRuling { what: string, why: string, costIfWrong: string }
export interface NotFixed { finding: string, why: string }
export interface CoderReport {
  role: 'coder'
  turn: number                 // the dsh turn the report ended; 0 when crew saw none (it loaded mid-turn)
  at: number                   // when it was recorded, ms since the epoch
  status: CoderStatus
  summary: string
  commits?: string[]
  blockedOn?: string
  rulings?: ReportRuling[]
  concerns?: string[]
  notFixed?: NotFixed[]
}
export interface ReviewFinding { severity: Severity, file: string, line?: number, summary: string, fix: string }
export interface ReviewCheck { command: string, exitCode: number, summary: string }
export interface ReviewAddressed { finding: string, addressed: boolean, evidence: string }
export interface ReviewerReport {
  role: 'reviewer'
  turn: number
  at: number
  verdict: Verdict
  head: string                 // the full sha it reviewed
  summary: string
  findings: ReviewFinding[]
  checks?: ReviewCheck[]
  addressed?: ReviewAddressed[]
}
export type StructuredReport = CoderReport | ReviewerReport
export type ReportRole = StructuredReport['role']
/** What is wrong with `value` as a StructuredReport, or undefined. Fields it doesn't know are not its concern. */
export function reportProblem(value: unknown): string | undefined
/** A new report of `report`'s own fields, with every string in it passed through dish-kit's `maskSecrets`. */
export function maskReport(report: StructuredReport): StructuredReport
/**
 * Which report a child gives:
 * - 'reviewer' for a child with `reviews` set (only the reviewing role has it: delegate.ts `chooseModel`);
 * - 'coder' for role `coder`;
 * - undefined for every other child.
 * The one definition of "coder" and "reviewer", for crew, dish-gates and orchestrator.
 */
export function reportRole(child: Pick<ChildRecord, 'role' | 'reviews'>): ReportRole | undefined

interface GateResult {
  /* … as now (record.ts:75-96), and: */
  /** The worktree's HEAD when the gate ran (dishWorkspaces.headOf), or null when it couldn't be read or the worktree didn't
   *  resolve. Absent on results recorded before step 7. */
  head?: string | null
}
interface ChildRecord {
  /* … as now (record.ts:113-150), and: */
  run?: string                 // the run's ref, `<owner>/<repo>/<id>`, as dishRuns.place gave it (Task 4); kept for its life, a follow-up never re-tags
  task?: string                // the task (a worktree slug of the run) it works on
  final?: true                 // a reviewer: the run's final review. Sticky: set at its start or by a follow-up, never cleared
  report?: StructuredReport    // the run in progress's; setReport replaces it, endRun moves it onto the run
}
interface RunRecord {
  /* … as now (record.ts:99-110); `report` stays the .md's path, and: */
  structured?: StructuredReport   // the report the run ended with: ChildRecord.report, moved here by endRun
  structuredFile?: string         // its `.json`, beside the `.md`
  notice?: string                 // the id of dsh's finish notice for this run, when crew saw it delivered
}
interface NewChild { /* … */ run?: string, task?: string, final?: true }
interface RunEnd { /* … */ notice?: string }
interface EndedRun {
  report: string
  sessionId: string            // added: the session the child belongs to
  child: ChildRecord           // added: the child as filed (a copy)
  run: RunRecord               // added: the run just filed (a copy), child.runs.at(-1)
}
// CrewRecords
/**
 * Replace the structured report of `childId`'s run in progress with a masked copy of `report`, through its session's queue.
 * Gives the stored copy, or undefined for a child that isn't recorded.
 * @throws TypeError if `report` isn't a StructuredReport; nothing is written.
 */
setReport(childId: string, report: StructuredReport): Promise<StructuredReport | undefined>
/** As now, and with `final: true` marks the child (a reviewer) final. */
addFollowUp(childId: string, extra?: { gateOverride?: string, final?: true }): Promise<void>

// events.ts (new)
export const EVENT_BUDGET_MS = 10_000
export interface CrewDelegated { sessionId: string, child: ChildRecord, followUp: boolean }
export interface CrewSettled { sessionId: string, child: ChildRecord, run: RunRecord }
declare module '@deepseek-ai/cordis' {
  interface Events {
    /** After `addChild` (before dsh starts the child) or after `addFollowUp`. */
    'dish-crew/delegated'(event: CrewDelegated): void | Promise<void>
    /** After `endRun` filed a run. */
    'dish-crew/settled'(event: CrewSettled): void | Promise<void>
  }
}
export type Publish = {
  (name: 'dish-crew/delegated', event: CrewDelegated): Promise<void>
  (name: 'dish-crew/settled', event: CrewSettled): Promise<void>
}
/**
 * `ctx.parallel(name, event)`, awaited for at most `budgetMs`.
 * - A listener that fails, or a wait that runs out, is logged.
 * - A plugin that is going away (INACTIVE_EFFECT) is silent.
 * - Never rejects.
 */
export function publisher(ctx: Context, warn: (format: string, ...args: unknown[]) => void, budgetMs?: number): Publish

// index.ts
export type { CoderReport, CoderStatus, NotFixed, ReportRole, ReportRuling, ReviewAddressed, ReviewCheck, ReviewerReport, ReviewFinding, Severity, StructuredReport, Verdict } from './record.ts'
export { CODER_STATUSES, SEVERITIES, VERDICTS, maskReport, reportProblem, reportRole } from './record.ts'
export type { CrewDelegated, CrewSettled } from './events.ts'
```

**Behavior:**
1. **`reportProblem`.**
   - **The checks,** in the style of `gateProblem` (`record.ts:297-312`). Each message names its field path, such as `findings[2].severity must be one of blocking, should_fix, nit`.
     - **Every report:** an object; `role` is `coder` or `reviewer`; `turn` is a whole number, 0 or more; `at` is finite.
     - **Coder:**
       - `status` is in `CODER_STATUSES`, and `summary` is a string;
       - `commits` and `concerns` are string arrays;
       - `blockedOn` is a string;
       - `rulings` items are `{ what, why, costIfWrong }`, all strings;
       - `notFixed` items are `{ finding, why }`, strings.
       - Each optional field is checked only when present.
     - **Reviewer:**
       - `verdict` is in `VERDICTS`; `head` and `summary` are strings;
       - `findings` is an array of `{ severity ∈ SEVERITIES, file: string, line?: integer, summary: string, fix: string }`;
       - `checks`, when present, holds `{ command: string, exitCode: integer, summary: string }`;
       - `addressed`, when present, holds `{ finding: string, addressed: boolean, evidence: string }`.
   - **Not checked here:** `blockedOn` for a status other than `done`, the form of `head`, and blank strings. Those are the tool's checks (Task 2): the record takes any well-typed report.
   - **`parseReport`** (private): a new object of the known fields only, nested items too; `undefined` when `reportProblem` refuses.
2. **`maskReport`** maps every string, nested ones included, through `maskSecrets`. Numbers and booleans are kept, and so are `role` and the enums: they can't hold a secret, but they go through the same path.
3. **`setReport`**, modelled on `addGate` (`record.ts:645-655`):
   - It is checked, parsed and masked before anything is awaited, so the caller's object can't change what is stored.
   - Then it goes through `#update`: `child.report = copy`, replacing any earlier one. A copy goes back.
   - **The module header gains the ordering argument.** The `report` tool awaits `setReport` inside its `execute`, and dsh-agent-loop awaits the tool before the step and the turn can close. That run's `subagent/end` comes after the turn closes. So the report reaches the session's queue before `endRun` for its run.
4. **`endRun`** (`record.ts:680-701`):
   - **The base name.** `#reportBase(hash, base)` replaces `#writeReport`'s naming. The base is the first of `<n>-<role>-<run>`, `….2`, `….3` and on for which neither `<base>.md` nor `<base>.json` exists.
   - **The files.**
     - With `child.report`: write `<base>.json`, which is `JSON.stringify(report, null, 2)` plus a newline, then `<base>.md`. Both go through `writeAtomic`, before the run that names them is saved.
     - The run gets `structured: report` and `structuredFile`, and `child.report` is deleted.
     - Without a report: no `.json` and no fields.
   - **`notice`:** kept on the run when it is a non-empty string, else left out.
   - **What it gives:** `{ report, sessionId, child, run }`, as copies.
5. **Parsing.**
   - `parseChild` and `parseRun` take the new fields:
     - `run` and `task` are strings;
     - `final` must be `true`;
     - `report` and `structured` go through `parseReport`;
     - `structuredFile` and `notice` are strings.
   - A malformed one makes the child corrupt, as a malformed gate does now. An old file without them parses.
   - Unknown fields, a report's included, are dropped.
   - **`GateResult.head`:** `gateProblem` accepts it absent, `null`, or a full sha (`/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/`), else `head must be a commit id or null`. `parseGate` keeps it when it is present, `null` included. `addGate` stores it as given.
6. **Checks.**
   - `newChildProblem` (`record.ts:409-420`):
     - `run` and `task` are strings when present;
     - `final` is `true` when present (`final must be true when it is given`).
   - `addChild` stores `run`, `task` and `final` when given.
   - `addFollowUp`:
     - `final` other than `undefined` or `true` is a TypeError;
     - `true` sets `child.final = true`;
     - without it, `final` stays as it was.
7. **`events.ts`'s `publisher`:**
   - It calls `ctx.parallel(name, structuredClone(event))` and waits on it with `within(…, budgetMs)` from `guard.ts:70`.
   - **What is logged:**
     - an `AggregateError` gives `a %s listener failed: %s`, once for each cause;
     - a timeout gives `%s listeners took longer than %d s; crew went on without them`;
     - `INACTIVE_EFFECT`, thrown or rejected, is silent.
8. **`index.ts`.**
   - **The notice's id.** A listener on `agent/inbox/inserted` keeps `settling: Map<childId, messageId>`.
     - It reads only a message whose `source.kind === 'subagent-settled'`, with a non-empty string `senderSessionId` and a string `id`.
     - It sets `settling.set(sender, String(message.id))`.
     - It schedules `queueMicrotask(() => { if (settling.get(sender) === id) settling.delete(sender) })`.
     - It never throws.
     - **Why it works:** dsh delivers the notice through the parent's inbox and then emits `subagent/end`, in one synchronous run:
       - `notifySettlement` at `dsh-subagent/lib/index.js:1248`, then `observer.settle` at `:1250`;
       - `steer` and `followup` reach the inbox splice at once (`dsh-agent-loop/lib/index.js:800-811`), which emits `agent/inbox/inserted` (`:206`).
     - The microtask drops an id whose end never came, so it can't land on a later run.
   - **`subagent/end`** (`index.ts:363-383`):
     - It takes and deletes `settling.get(id)` synchronously, next to `remembered`.
     - It passes the id as `RunEnd.notice`.
     - The `inOrder` job becomes: `ended = await records.endRun(…)`; when `ended` is defined, `await publish('dish-crew/settled', { sessionId: ended.sessionId, child: ended.child, run: ended.run })`; then `return ended`.
     - So `whenRecorded` resolves after the listeners, or after the budget. A child's next start or end waits as well.
   - **`publish = publisher(ctx, warn)`** is made in `apply`, before the first `await`.
   - The exports above.
   - **The module header** names both events and the notice id.
9. **`delegate.ts`.** `publish = publisher(ctx, warn)` in `apply`.
   - **`start`** (`:678-730`):
     - Right after `addChild` succeeds, before the prompt is built and before `startContinuable`, `await publish('dish-crew/delegated', { sessionId: call.sessionId, child: <addChild's record>, followUp: false })`. Every `child.started` then comes before that child's `child.ended`.
     - `markFailed` (`:669-675`) gets `endRun`'s `EndedRun`, and when defined publishes `dish-crew/settled` with it, so a start dsh refused also ends in the ledger.
   - **`followUp`** (`:759-787`):
     - After `addFollowUp`, whether it threw (logged as now) or not: `found = await records.lookup(target.id)`, failures ignored.
     - Then `await publish('dish-crew/delegated', { sessionId, child: found?.record ?? { ...target, followUps: target.followUps + 1, last: 'running' }, followUp: true })`.
   - Both run inside the locks the call holds, and are awaited there, before the locks are released. orchestrator's listener queues its ledger write before it returns, and `place` waits for that queue, so the next delegation on the task counts this one (Task 8).

**Tests:**
- **record.test.ts:**
  - `reportProblem` names each wrong field, and gives nothing for a full coder report, a full reviewer report and minimal ones;
  - `setReport`:
    - keeps a masked copy (a `ghp_` token in `summary` and in a finding's `fix`) and gives it back;
    - a second replaces the first;
    - it survives a new `CrewRecords` on the same directory;
    - unknown fields are dropped;
    - a child that isn't recorded is `undefined` and nothing is written;
    - malformed reports (`role: 'architect'`, `status: 'maybe'`, no `summary`, `severity: 'major'`, `line: 1.5`, `exitCode: 'x'`, `addressed: 'yes'`, `turn: -1`) throw TypeError and leave the file byte for byte;
  - `endRun`:
    - writes `<n>-<role>-<run>.json` (the masked report, mode 0600) and the `.md`;
    - the run has `structured` and `structuredFile`, the child has no `report`, and the next run has none;
    - a run without a report has no `.json` and neither field;
    - an orphan `1-coder-1.json` moves both files to `1-coder-1.2.*`;
  - `notice` is kept; `''` and a number are left out;
  - `EndedRun` has `sessionId`, the filed child, and `run` deep-equal to `child.runs.at(-1)`, as copies;
  - `addChild` with `run`, `task` and `final`, and the refusals (`final: false`, `run: 7`) write nothing;
  - `addFollowUp` with `{ final: true }` sets it; without it, it is kept; `{ final: false }` is a TypeError;
  - an old `children.json` parses; a malformed `report` (on a child) or `structured` (on a run), and `final: false` on disk, set the file aside as corrupt;
  - `addGate` keeps `head` (a sha, and `null`) through a reload; `head: 'xyz'` throws `TypeError` and leaves the file byte for byte; an old gate without `head` parses;
  - `reportRole`: coder, a reviewer by `reviews`, `ops` and `writer` undefined;
  - `setReport` and `endRun` called at once: the report is on the run;
  - the package exports the report types and helpers.
- **events.test.ts:**
  - `publisher` waits for async listeners;
  - a failing listener is logged once per cause, and the other listeners still run;
  - a listener held past the budget (budget 50 ms in the test) resolves after the budget, with the warning;
  - a disposed context is silent;
  - no listeners resolves.
- **plugin.test.ts:**
  - **`dish-crew/settled`:**
    - after `subagent/end` for a crew child, it carries the session, the filed child and the run, and `run.structured` when `setReport` came first;
    - `whenRecorded` resolves only after a slow listener;
    - a throwing listener is logged and the run is filed;
    - an agent crew didn't start gets no event.
  - **The notice id:**
    - `agent/inbox/inserted` with a settlement for `c1`, then `subagent/end` for `c1` in the same tick: `run.notice` is the message's id;
    - with the end in a later turn: no `notice`;
    - `c2`'s notice doesn't land on `c1`'s run;
    - other messages and malformed payloads are ignored, without a throw.
  - The `whenRecorded` tests expect the larger `EndedRun`: they assert `recorded.report`.
- **delegate.test.ts:**
  - **A start:**
    - publishes `delegated` once, with `followUp: false` and the recorded child;
    - in the listener, `lookup` finds the child, and `w.starts` is still empty;
    - a listener held on a promise holds `delegate`'s answer.
  - **A follow-up** publishes `followUp: true`, with `followUps: 1`.
  - **A start dsh refuses** publishes `delegated` and then `settled` with `stopReason: 'error'`.
  - **A refusal** at the limits publishes nothing.
  - **A throwing listener** is logged, and the delegation stands.

**Steps:**
- [ ] Failing tests first (above).
- [ ] Implement. Run `pnpm install --offline --frozen-lockfile` with `pnpm_config_store_dir` set, then the gate.
- [ ] Commit `dish-crew: structured reports and gate heads in the record, and the delegated and settled events`.

---

## Task 2: the `report` tool, its steer, and the report guard's words (`dish-crew`)

**Needs:** Task 1, and Task 0 (dsh-llm in crew's peers).

**Files:**
- Create `plugins/crew/src/report.ts`; test `plugins/crew/test/report.test.ts`.
- Modify:
  - `plugins/crew/src/index.ts`;
  - `plugins/crew/src/report-guard.ts`: its refusals name `report` for a child that has it;
  - `plugins/crew/cordis.patch.yml`: its header comment names `reportSteers`;
  - `plugins/gates/test/plugin.test.ts`: one line, `reportSteers: 0` in its `world()`'s crew config (`plugin.test.ts:232`), so its existing real-loop tests, which end with text, keep today's endings. Task 5 makes it a `world()` option.
- Tests: `test/plugin.test.ts`, `test/report-guard.test.ts`; extend `test/helpers.ts`.

**Interfaces:**
```ts
// report.ts
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ParameterSchemaSpec, ToolDefinition, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { AgentLike } from 'dish-kit'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    /** crew's message to a coder or reviewer that ended its turn without `report`. */
    'dish-crew': { kind: 'dish-crew' } & ContextFormed
  }
}
export const REPORT_TOOL = 'report'
export const DEFAULT_REPORT_STEERS = 2
/** A reviewer's `head`, once trimmed and lowercased. */
export const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/
export const CODER_PARAMETERS: { … }      // the literal below
export const REVIEWER_PARAMETERS: { … }   // the literal below
export const CODER_DESCRIPTION: string
export const REVIEWER_DESCRIPTION: string

type Warn = (format: string, ...args: unknown[]) => void
export interface ReportAgent extends AgentLike { id: unknown, session: NonNullable<AgentLike['session']> }

/**
 * What crew keeps of each child's session from dsh's events, for the tool and the steer. Keyed by the session object in
 * WeakMaps, as dish-gates' ClosingHeads is, except `steered`, which is keyed by child id. No method throws.
 */
export class ReportTracker {
  /** `session/event`: see Behavior 3. */
  observe(session: object, event: unknown): void
  /** `tools/result`: a successful `report` that concludes the turn marks its agent's session reported. */
  result(exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>): void
  /** The newest turn seen for the session; 0 when none was. */
  turnOf(session: object): number
  /** Whether a successful concluding `report` came after the session's newest assistant message. */
  reported(session: object): boolean
  /** Count one steer in `turn`, and give its ordinal (1-based), or undefined when `limit` are counted already. */
  takeSteer(session: object, turn: number, limit: number): number | undefined
  markSteered(childId: string): void
  /** dishCrew.reportSteered. */
  steered(childId: string): boolean
  /** agent/disposed. */
  forget(childId: string): void
}

export interface ReportToolDeps {
  role: ReportRole
  agent: ReportAgent
  records: Pick<CrewRecords, 'setReport'>
  tracker: Pick<ReportTracker, 'turnOf'>
  now?: () => number
}
/** The `report` tool for one child (its role's schema). */
export function reportTool(deps: ReportToolDeps): ToolDefinition

export interface RegisteringAgent extends ReportAgent {
  ctx: { tools: { register(definition: ToolDefinition): () => void }, effect(execute: () => () => void): () => void }
}
export interface RegistrarDeps {
  records: Pick<CrewRecords, 'lookup' | 'setReport'>
  tracker: ReportTracker
  effect(execute: () => () => void): () => void   // the host's ctx.effect
  warn: Warn
  now?: () => number
}
export class ReportRegistrar {
  constructor(deps: RegistrarDeps)
  /** agent/created: give a crew coder or reviewer its `report`. Never rejects. */
  attach(agent: RegisteringAgent): Promise<void>
  /** agent/disposed. */
  detach(agent: object): void
  /** The role `report` was registered for on this agent object, by this crew instance; undefined otherwise. */
  roleOf(agent: object): ReportRole | undefined
}

export function reportSteerText(role: ReportRole, steer: number, of: number): string
/** `Asked to finish with report (<steer> of <of>)`, within dsh's 120 characters. */
export function reportSteerSummary(steer: number, of: number): string
export interface SteeringAgent extends ReportAgent { steer(message: UserMessage): void }
export interface SteerDeps {
  limit: number                                  // the reportSteers row
  tracker: ReportTracker
  roleOf(agent: object): ReportRole | undefined  // ReportRegistrar.roleOf
  warn: Warn
}
/** The prepended agent/turn-stopping listener. Never throws. */
export function reportSteerListener(deps: SteerDeps): (payload: { agent: SteeringAgent, turn: number, signal: AbortSignal }) => Promise<void>

// report-guard.ts
export interface ReportGuardDeps {
  /* … as now (report-guard.ts:88-97), and: */
  /** Whether this crew instance gave `agent` its `report` (ReportRegistrar.roleOf). Read for the refusal's words only. Default: never. */
  reports?(agent: unknown): boolean
}
/** The first refusal, for a child that has `report`. Said by report-guard.test.ts word for word. */
const REFUSED_REPORT: string
/** Every later one in the same run, for a child that has `report`. */
const CLOSED_REPORT: string

// index.ts
export interface Config { dataDirectory: string, subagentProvider: string, messageLimit: number, reportSteers: number, terminal: boolean }
// reportSteers: Schema.natural().default(DEFAULT_REPORT_STEERS)
//   .description('How many times in one turn a coder or reviewer that ends its turn without calling report is sent back to call it. 0 turns this off: the tool is still there, and nothing asks for it.')
interface DishCrew {
  /* … */
  /**
   * Whether crew sent this child back to call `report` at its current stop: true from that steer until the child's next
   * assistant message, or its next turn. dish-gates reads it at agent/turn-stopping, after crew's prepended listener.
   */
  reportSteered(childId: string): boolean
}
```

**The schemas** (the defineTool DSL, `dsh-tools` `schema.d.ts`):
- Nested objects say `additionalProperties: false`. The parameter root stays dsh's implicit open object: an extra argument is ignored, not refused.
- No `oneOf`, lengths or patterns.
```ts
const RULING = {
  type: 'object', additionalProperties: false,
  properties: {
    what: { type: 'string', required: true, description: 'What you decided.' },
    why: { type: 'string', required: true, description: 'Why.' },
    costIfWrong: { type: 'string', required: true, description: 'What it costs if the call is wrong.' },
  },
} as const
const NOT_FIXED = {
  type: 'object', additionalProperties: false,
  properties: {
    finding: { type: 'string', required: true, description: 'The finding, as the review gave it.' },
    why: { type: 'string', required: true, description: 'Why it isn\'t fixed.' },
  },
} as const
export const CODER_PARAMETERS = {
  status: { type: 'string', enum: ['done', 'blocked', 'needs_context'], required: true,
    description: '`done`: the work is complete and committed. `blocked` or `needs_context`: you can\'t go on; say why in `blockedOn`.' },
  summary: { type: 'string', required: true, description: 'What changed, for a person: a few sentences.' },
  commits: { type: 'array', items: { type: 'string' }, description: 'The shas of the commits you made, oldest first.' },
  blockedOn: { type: 'string', description: 'Required when status isn\'t done: the question you\'re blocked on, or what you need.' },
  rulings: { type: 'array', items: RULING, description: 'Your own judgment calls.' },
  concerns: { type: 'array', items: { type: 'string' }, description: 'What the main agent should know: risks, doubts, loose ends.' },
  notFixed: { type: 'array', items: NOT_FIXED, description: 'In a fix round: the findings you didn\'t fix, and why.' },
} as const satisfies ParameterSchemaSpec
const FINDING = {
  type: 'object', additionalProperties: false,
  properties: {
    severity: { type: 'string', enum: ['blocking', 'should_fix', 'nit'], required: true },
    file: { type: 'string', required: true, description: 'The path, relative to the repository root.' },
    line: { type: 'integer', description: 'The line, when the finding has one.' },
    summary: { type: 'string', required: true, description: 'What is wrong.' },
    fix: { type: 'string', required: true, description: 'What to change.' },
  },
} as const
const CHECK = {
  type: 'object', additionalProperties: false,
  properties: {
    command: { type: 'string', required: true },
    exitCode: { type: 'integer', required: true },
    summary: { type: 'string', required: true, description: 'What it showed.' },
  },
} as const
const ADDRESSED = {
  type: 'object', additionalProperties: false,
  properties: {
    finding: { type: 'string', required: true, description: 'The earlier finding.' },
    addressed: { type: 'boolean', required: true },
    evidence: { type: 'string', required: true, description: 'What shows it, either way.' },
  },
} as const
export const REVIEWER_PARAMETERS = {
  verdict: { type: 'string', enum: ['approved', 'changes_requested'], required: true,
    description: '`changes_requested` when any finding must be fixed before this can merge, else `approved`.' },
  head: { type: 'string', required: true, description: 'The full sha of the commit you reviewed: `git rev-parse HEAD` in the worktree.' },
  summary: { type: 'string', required: true, description: 'Your review, for a person: a few sentences.' },
  findings: { type: 'array', required: true, items: FINDING, description: 'Every finding; an empty list for a clean review.' },
  checks: { type: 'array', items: CHECK, description: 'The commands you ran, and their exit codes.' },
  addressed: { type: 'array', items: ADDRESSED, description: 'In a re-review: each earlier finding, whether it was addressed, and the evidence.' },
} as const satisfies ParameterSchemaSpec
/** The value the tool returns: the stored report. */
const REPORT_HEAD = {
  turn: { type: 'integer', required: true },
  at: { type: 'number', required: true },
} as const
const CODER_OUTPUT = { type: 'object', additionalProperties: false,
  properties: { role: { type: 'string', const: 'coder', required: true }, ...REPORT_HEAD, ...CODER_PARAMETERS } } as const
const REVIEWER_OUTPUT = { type: 'object', additionalProperties: false,
  properties: { role: { type: 'string', const: 'reviewer', required: true }, ...REPORT_HEAD, ...REVIEWER_PARAMETERS } } as const
```
- `reportTool` calls `defineTool({ name: REPORT_TOOL, description, parameters, output: { schema, render }, execute })` once for each role, with that role's constants.
- `execute` returns `setReport`'s value, typed as `InferValue<typeof CODER_OUTPUT>` (or the reviewer's) with an `as`.

**The descriptions:**
- **`CODER_DESCRIPTION`:**
  "Finish your work with this, as your last call: it records your report for the main agent and ends your turn. The main agent reads this report, not your last message. `status` is `done` when the work is complete and committed: in a worktree, dish then runs the project's gate there, and a failure comes back to you to fix, after which you call `report` again. `blocked` or `needs_context` when you can't go on, with `blockedOn`: the gate is skipped. A later call replaces an earlier one."
- **`REVIEWER_DESCRIPTION`:**
  "Finish your review with this, as your last call: it records your verdict for the main agent and ends your turn. The main agent reads this report, not your last message. `head` is the full sha of the commit you reviewed; `findings` lists every finding (an empty list for a clean review). A later call replaces an earlier one."

**Behavior:**
1. **`execute(args, exec)`.** dsh-tools has already validated `args` against the schema: a mismatch is `invalid arguments: …`, naming the field (`dsh-tools/lib/index.js:817, 869-871`).
   1. **The body's checks,** all of them, joined with `; `, then thrown as one `Error`. Nothing is recorded, and `concludeTurn` isn't called.
      - `summary` blank: "summary is empty: say what changed, for a person". For the reviewer: "…: say what you found, for a person".
      - Coder, `status !== 'done'` and `blockedOn` missing or blank: "blockedOn is required when status is blocked or needs_context: say what you're blocked on, or what you need".
      - Reviewer, `head` trimmed and lowercased doesn't match `FULL_SHA`: "head must be the full sha of the commit you reviewed (40 hex digits): run `git rev-parse HEAD` in the worktree you reviewed".
   2. **The report:**
      - `{ role, turn: tracker.turnOf(agent.session), at: now(), …the schema's fields }`;
      - `head` is stored trimmed and lowercased;
      - optional fields that are `''`, whitespace or `[]` are left out (models fill every optional parameter);
      - `findings` is kept even when empty.
   3. **Recording:** `stored = await records.setReport(String(agent.id), report)`.
      - A throw becomes `Error("dish couldn't record your report (<message>); call report again")`.
      - `undefined` becomes `Error("dish-crew has no record of you as a crew child, so the report wasn't recorded; end your turn with your report as your closing message")`.
   4. **Then** `exec.concludeTurn()`, and return `stored`.
   5. **`render`:**
      - coder: `Report recorded: <status>.`;
      - reviewer: `Report recorded: <verdict> at <head's first 12>.`
2. **Registration** (`ReportRegistrar.attach`), the dsh-schedule pattern (`dsh-schedule/lib/index.js:2654-2668`):
   1. Return when:
      - `isTopLevelAgent(agent)`;
      - the agent object is attached already;
      - `records.lookup(String(agent.id))` has no record;
      - `reportRole(record)` is undefined.
   2. Check again that the agent isn't attached: a second `agent/created` for the same object can race the lookup.
   3. `detach = deps.effect(() => agent.ctx.effect(() => agent.ctx.tools.register(reportTool({ role, agent, records, tracker, now }))))`, kept in a `WeakMap<object, { role, detach }>`.
      - The tool lives on the child's own scope, like dsh's `structured_output` (`dsh-subagent-in-process-driver/lib/index.js:55`).
      - A scope's own layer isn't subject to its tool filter, so no allow list names it, and the main agent never sees it.
   4. A cold resume makes a new agent object with the same id. `agent/created` fires for it, and it is attached as well.
   5. Any throw is logged once per distinct message, "could not give crew child %s the report tool: %s", and nothing is rethrown: a throw in `agent/created` fails the child's creation.
   6. `detach(agent)` runs the stored disposer and forgets the agent.
3. **`ReportTracker`:**
   - **`observe(session, event)`:**
     - `turn/start`: the session's turn is `data.turn` when it is a number, `reported` is false, and its child id (`String(session.id)`) leaves `steered`.
     - `assistant/message`: the turn is `data.turn` when it is a number, `reported` is false, and the child id leaves `steered`.
     - Anything else is ignored, and so is a malformed event.
   - **`result(exec, result)`:** when `exec.name === REPORT_TOOL`, `result.isError === false`, `result.concludesTurn === true` and `exec.agent` has a `session` object, that session is `reported`.
   - **The order dsh keeps,** within a step:
     - the step's `assistant/message` (which clears it);
     - then its tool calls run;
     - then `tools/result`, which sets it;
     - then `agent/turn-stopping`.
   - So `reported` means a successful `report` came after the newest assistant message.
   - **`takeSteer`** keeps `{ turn, count }` per session; a different `turn` starts the count again.
4. **The steer listener.** It is registered with `{ prepend: true }`. dsh runs `agent/turn-stopping` listeners in order (`serial`), so this one runs before dish-gates', whatever the load order. For each stop, in order:
   1. `limit <= 0` → return: the requirement is off.
   2. `signal.aborted` → return.
   3. `role = roleOf(agent)` is undefined → return. That covers:
      - the main agent;
      - another role;
      - an agent crew doesn't know;
      - a child created before this crew instance loaded, which has no `report` to call.
   4. `tracker.reported(agent.session)` → return: it finished with `report`.
   5. `n = tracker.takeSteer(agent.session, turn, limit)` is undefined → return. The steers are used up: the turn ends, and dish-gates falls back to its newest-message rule.
   6. `tracker.markSteered(String(agent.id))`, before the steer, so dish-gates sees it at this stop.
   7. `agent.steer(createUserMessage({ content: [{ type: 'text', text: reportSteerText(role, n, limit) }], source: { kind: 'dish-crew', form: 'notice', summary: reportSteerSummary(n, limit) } }))`.
      - If `steer` throws, the child leaves `steered`, and the throw is logged.
   8. The listener never throws (a throw fails the turn). Each distinct problem is logged once, up to 100 messages.
5. **The steer's text:**
   - **Coder:** "Finish by calling `report`: `status` (`done` when the work is complete and committed; `blocked` or `needs_context`, with `blockedOn`, when you can't go on), a `summary` of what changed, for a person, and `commits`, `rulings`, `concerns` and `notFixed` where they apply. The main agent reads your report, not your last message, and your turn ends when you call it."
   - **Reviewer:** "Finish by calling `report`: your `verdict` (`approved` or `changes_requested`), `head` (the full sha of the commit you reviewed), a `summary`, and `findings`, each with its severity, file, line, summary and fix (an empty list for a clean review), with the `checks` you ran and, in a re-review, `addressed`. The main agent reads your report, not your last message, and your turn ends when you call it."
   - **When `steer === of`,** both add: " If you end your turn without it, the main agent gets your work without a report."
6. **`index.ts`.** All of these are registered in `apply` before the first `await`, after the report guard:
   ```ts
   const tracker = new ReportTracker()
   const registrar = new ReportRegistrar({ records, tracker, effect: execute => ctx.effect(execute), warn })
   ctx.on('session/event', (session, event) => { tracker.observe(session, event) })
   ctx.on('tools/result', (exec, result) => { tracker.result(exec, result) })
   ctx.on('agent/created', async ({ agent }) => { await registrar.attach(agent); return undefined })   // the event's type is undefined | Promise<undefined>
   ctx.on('agent/disposed', ({ agent }) => { registrar.detach(agent); tracker.forget(String(agent.id)) })
   ctx.on('agent/turn-stopping', reportSteerListener({ limit: config.reportSteers, tracker, roleOf: agent => registrar.roleOf(agent), warn }), { prepend: true })
   ```
   - **The service:** `ctx.provide('dishCrew', { …, reportSteered: (childId: string) => tracker.steered(childId) })`.
   - **Children already running** (crew reloaded). After `provide`:
     - `for (const agent of (lookup.get('agents') as { list?(): unknown[] } | undefined)?.list?.() ?? []) void registrar.attach(agent as RegisteringAgent)`;
     - the stub registry in tests has no `list`.
   - **The module header** gains a bullet for `report`, its steer and `reportSteered`.
   - **The report guard** is made with `reports: agent => { try { return registrar.roleOf(agent as object) !== undefined } catch { return false } }`. The registrar is made before the guard.
7. **The report guard's words.** A coder or reviewer finishes with `report`, so "your closing message is your report" would now tell it the opposite of its prompt. The guard's checks, its hold and its fail-open don't change: only which text a refusal carries.
   - **When `deps.reports?.(exec.agent)` is true** (a throw is false): `REFUSED_REPORT` the first time, and `CLOSED_REPORT` for every later `send_message` in the run:
     - `REFUSED_REPORT`: "Not sent: this is your result, and in this crew you report with `report`. It reaches the main agent in full, automatically, when you call it, whatever your task says about sending your result with send_message. Don't resend it shorter or in parts: send_message is closed to you until you finish. Finish the work and call `report`. If this was a question you're blocked on, put it in your report instead; the main agent will follow up."
     - `CLOSED_REPORT`: "Not sent: send_message is closed to you until you finish, because your report was refused here once already. Put everything for the main agent in your `report`, and finish."
   - **Otherwise** (architect, researcher, ops, writer, a child crew didn't give `report`, or no `reports`): `REFUSED` and `CLOSED`, byte for byte as today.
   - The module header's "What the child reads" says so, in two sentences.

**Tests:**
- **`test/helpers.ts` gains `agentScopes(ctx)`,** built like delegate.test.ts's `world()` (`delegate.test.ts:148-180`):
  - dsh's `ToolRuntime`, a `systemPrompt` stub and a `scope-owner` plugin injecting `tools`;
  - `main(id)` and `child(id)` give an agent made with `createScope`, with `ctx`, a `session` (`id`, and a `header` with `delegationDepth: 1, origin: 'subagent'` for a child), `options`, and a recorded `steer`.
- **report.test.ts:**
  - **The schemas:**
    - `parameterSchemaSpecToJsonSchema` and `assertSupportedJsonSchema` accept both parameter sets;
    - every nested object has `additionalProperties: false`;
    - no `oneOf` anywhere;
    - the required lists are as in the contract.
  - **A coder's call:**
    - `setReport` gets the report;
    - the value is the stored, masked report (a `ghp_` token in `summary` comes back masked);
    - `concludeTurn` is called once;
    - `render` says `Report recorded: done.`
  - **A bad call:** a missing `status`, `status: 'finished'`, a ruling without `costIfWrong`, and `severity: 'major'` each give `invalid arguments: …` naming the field. Nothing is recorded, and there is no conclusion.
  - **The body's checks:**
    - `blocked` without `blockedOn`;
    - a blank `summary`;
    - `head: 'HEAD'` and a 12-digit sha refused;
    - an uppercased full sha with spaces stored lowercased and trimmed;
    - two problems in one error.
  - **Optional fields:** blanks and `[]` are left out; an extra root argument (`role: 'x'`) is ignored; `findings: []` is kept.
  - **The turn:** `turn/start` with turn 3, then a call, gives `turn: 3`; with none seen, `turn: 0`.
  - **Failures:** a `setReport` that throws, or that gives `undefined`, is the error above, with no conclusion.
  - **`ReportTracker`:**
    - `reported` is set only by a successful concluding `report`: not by an error, by another tool, or without `concludesTurn`;
    - it is cleared by the next `assistant/message` and by `turn/start`;
    - `takeSteer` counts per turn and starts again in a new turn;
    - `steered` is cleared by `assistant/message`, `turn/start` and `forget`;
    - two sessions are kept apart;
    - malformed events don't throw.
  - **The steer listener:**
    - a coder with no report since its newest message is steered: the text, the source `dish-crew`, the form and the summary;
    - not after a successful concluding `report`;
    - again after a later assistant message;
    - at most 2 a turn: the third stop isn't steered, and turn 2 is steered again;
    - the last steer's sentence;
    - `limit: 0` never steers;
    - `roleOf` undefined (main agent, researcher, unknown) isn't steered;
    - an aborted signal isn't steered;
    - `reportSteered` is true right after the steer and false after the next assistant message;
    - a `steer` that throws is logged once, the child leaves `steered`, and the listener resolves.
- **plugin.test.ts:**
  - **Registration:**
    - `report` is on a coder's and on a reviewer's own scope after `ctx.serial('agent/created', { agent, source })`, each with its own role's schema;
    - not on the main agent, a researcher child, or an agent crew doesn't know;
    - a second agent object for the same child (a cold resume) gets it too, and the same object twice registers once;
    - it is gone after `agent/disposed`, and after crew unloads;
    - an agent already in `agents.list()` when crew loads gets it;
    - a `lookup` that throws is logged, and creation goes on.
  - **The order at a stop:**
    - a sibling plugin's `agent/turn-stopping` listener, registered before crew loaded, reads `ctx.dishCrew.reportSteered(id)` as `true` at the stop crew steers;
    - at the stop after a concluding `report`, it reads `false` and crew doesn't steer.
  - **Through the record:** a coder's call (fake `exec`), then `subagent/end`, leaves `run.structured` and the `.json`.
  - **The service and the configuration:** the keys gain `reportSteered`, and the configuration test names `reportSteers` (2, natural; 0 accepted).
  - **The report guard through the host:** a coder that has `report` and sends a long `send_message` reads `REFUSED_REPORT`; a researcher child reads today's `REFUSED`.
- **report-guard.test.ts:**
  - with `reports` true for the agent: the first refusal is `REFUSED_REPORT` and a later one `CLOSED_REPORT`, word for word;
  - with `reports` false, throwing, or absent: today's two texts, byte for byte (the existing expectations stay as they are);
  - a short message from a child with `report` is still `next()`.
- **gates' plugin.test.ts** stays green with `reportSteers: 0`.

**Steps:**
- [ ] Failing tests first (above).
- [ ] Implement. Run `pnpm install --offline --frozen-lockfile` with `pnpm_config_store_dir` set, then the gate.
- [ ] Commit `dish-crew: the report tool for coders and reviewers, its steer, and the report guard's words for them`.

---

## Task 3: the finish notice from the structured report, matched by run (`dish-crew`)

**Needs:** Task 1.

**Files:** modify `plugins/crew/src/notice.ts`; test `plugins/crew/test/notice.test.ts`.

**Interfaces:**
```ts
/** What a coder's or reviewer's notice says when its run has no structured report. */
export const NO_STRUCTURED_REPORT = 'It ended without a successful `report`, so there is no structured report.'
/** The report as the notice shows it, every string masked again. See "The block". */
export function reportBlock(report: StructuredReport): string
type Child = Pick<ChildRecord, 'id' | 'role' | 'title' | 'model' | 'worktree' | 'reviews'>   // gains 'reviews', for reportRole
// noticeSummary(child, run, lead): a run with `structured` that ended `completed` is
//   "<who> finished: done." | "… finished: blocked." | "… finished: needs context." | "… finished: approved." | "… finished: changes requested."
//   Anything else is as now (notice.ts:210-221).
// noticeText(child, run, lead, label?, gatesOn): a run with `structured` is
//   "<first sentence> Report: `<run.structuredFile ?? run.report>`.<' ' + gate line> Its report:"
//   and `label` isn't used (the label goes after the report block). A run of a coder or reviewer (reportRole) without one is
//   "<first sentence> Report: `<run.report>`.<' ' + gate line> <NO_STRUCTURED_REPORT> <label>". Other runs are as now.
```

**Behavior:**
1. **Matching a notice to its run** (`runOf`, `notice.ts:301-319`), now `runOf(message, parts, runs, claimed, unreadable)`:
   1. **By the notice's id.** `runs.findLast(run => run.notice === String(message.id))`.
      - Found and not claimed: claim it and return it. Found and claimed already: `undefined`.
      - No file is read. It works for any shape of message, unknown shapes included.
      - The id is the one Task 1 records: crew sees the notice enter the parent's inbox just before that run's `subagent/end`.
   2. **Otherwise, the fallback.** The old match by closing text and stop reason, as now, but over the runs that have no `notice` only.
      - A run another notice was recorded for is never taken by text. Two runs ended by `report` both hold "(no closing message)" and would match each other.
      - The fallback is what's left for runs crew filed without seeing the notice (crew loaded late) and for records from before.
   3. Nothing matches: the notice is rewritten with no report, as now.
2. **The rewrite** (`rewritten`, `notice.ts:325-333`) for a matched run with `structured`:
   - `rest` is dsh's blocks after the label: `content.slice(label === undefined ? 1 : 2)`, the same objects.
   - The content is:
     1. a block `noticeText(…)` + `BLOCK_END`;
     2. a block `reportBlock(run.structured)`. Then, when `label === 'Its closing message:'`, `BLOCK_END` + `Its closing message:`. Then `BLOCK_END` when `rest` isn't empty;
     3. `...rest`.
   - dsh's `It left no closing message.` is dropped: the report is the message.
   - Every other notice is built as now.
   - The source's `summary` is `bounded(noticeSummary(…))`, as now.
3. **The block** (`reportBlock`). Lines are joined by `\n`, and a line for an absent field is left out. List items are folded onto one line.
   - **The coder's lines:**
     - `Status: done` (or `blocked`, or `needs context`);
     - `Summary: <summary>`: the summary trimmed, its own line breaks kept;
     - `Commits: \`a\`, \`b\``;
     - `Blocked on: <blockedOn>`;
     - `Rulings:`, then `- <what> — <why> — <costIfWrong>` for each;
     - `Concerns:`, then `- <concern>` for each;
     - `Not fixed:`, then `- <finding> — <why>` for each.
   - **The reviewer's lines:**
     - `Verdict: approved` (or `changes requested`), then `, at \`<head>\``;
     - `Summary: <summary>`;
     - `Findings (<n>): <k> blocking, <k> should_fix, <k> nit`, with only the counts above 0, or `Findings: none`;
     - `- [<severity>] \`<file>[:<line>]\`: <summary> Fix: <fix>` for each finding;
     - `Checks:`, then `- \`<command>\` exit <code>: <summary>` for each;
     - `Addressed:`, then `- <finding>: addressed. <evidence>`, or `NOT addressed`, for each.
   - Code spans go through the existing `codeSpan` (`notice.ts:135-141`).
   - Every string goes through `maskSecrets` again: the record masked it, and this is where it is written into a message.
4. **The rest stays:** the wait for `whenRecorded`, the step's notices from the last, `gateLine`, and the shapes that aren't known.

**Tests:**
- **By id:**
  - two runs of one coder, both ended by `report` (closing `(no closing message)`, both `completed`), with notice ids `m1` and `m2`;
  - the two notices in one step, in either order, each cite their own `.json` and render their own report.
- **The fallback:**
  - a notice whose id is on no run, while the runs carry other ids, gets no run: dsh's account renamed, no report;
  - runs without a `notice` are still matched by text, as before (the existing tests stay green, unchanged).
- **A coder's notice:**
  - every line of the block, and `Report:` names the `.json`;
  - `It left no closing message.` is gone;
  - with closing text, the block, then `Its closing message:`, then dsh's blocks as the same objects;
  - a bound coder's gate line is between the report path and `Its report:`.
- **A reviewer's notice:** the verdict and head, the counts (`Findings (3): 1 blocking, 2 nit`), each finding with and without a line, `Findings: none`, checks and addressed.
- **Masking:** `reportBlock` of a hand-made report with a `ghp_` token in a finding is masked.
- **No report:**
  - a coder's and a reviewer's run without `structured` say `NO_STRUCTURED_REPORT` before the label;
  - a researcher's notice is as it was.
- **The summary:**
  - `… finished: blocked.` and `… finished: changes requested.`;
  - a run with a report that didn't end `completed` keeps its verb and error;
  - the summary is bounded to 120 characters.
- **Through the host plugin,** in notice.test.ts, which mounts it already (`notice.test.ts:558`):
  - `setReport`;
  - then `agent/inbox/inserted` with the notice;
  - then `subagent/end` whose last message is only the `report` call;
  - the rewrite cites the `.json` and renders the report.

**Steps:**
- [ ] Failing tests first (above).
- [ ] Implement. Run `pnpm install --offline --frozen-lockfile` with `pnpm_config_store_dir` set, then the gate.
- [ ] Commit `dish-crew: the finish notice renders the structured report, and finds its run by id`.

---

## Task 4: `delegate`'s ruling, final review, run tags, the ladder and the closing note (`dish-crew`)

**Needs:** Task 1.

**Files:**
- Modify:
  - `plugins/crew/src/delegate.ts`;
  - `src/text.ts`;
  - `src/allow.ts`.
- Tests: `plugins/crew/test/delegate.test.ts`, `test/allow.test.ts`.

**Interfaces:**
```ts
// delegate.ts: what the row reads of dish-orchestrator with ctx.get('dishRuns'), structurally (crew doesn't depend on it)
interface Placement { run: string /* a run ref */, task?: string, round?: number /* given with task */, final?: true }
interface LadderEntry { sessionId: string, run: string, task: string, round: number, outcome: 'refused' | 'ruled', ruling?: string, child?: string }
interface RunsReader {
  place(sessionId: string, where: { worktree?: string, reviews?: string, final?: boolean }): Promise<Placement | undefined>
  ladder(entry: LadderEntry): Promise<void>
}
/** From this round on, a coder start or follow-up on a run's task needs a ruling. */
export const LADDER_RULING_ROUND = 5
/** The note in delegate's answer for a coder's round on a task: undefined for round 0, and from LADDER_RULING_ROUND (see below). */
export function ladderNote(task: string, round: number): string | undefined
interface Call {
  /* … as now (delegate.ts:338-358), with `gateOverride` replaced by: */
  ruling: string | undefined   // `ruling`, else `gateOverride`; one line, masked; undefined for none
  final: boolean               // `final === true`
  runs: RunsReader | undefined // ctx.get('dishRuns'), read in prepare
}
interface Delegated { child: string, role: string, model: string, label: string, note?: string }
/** Inside the locks: the tags for a start, `final`, and the ladder for a coder on a task. @throws the ladder's refusal. */
async function placeCall(call: Call, where: { worktree?: string, reviews?: string }, target?: ChildRecord): Promise<{ tags: { run?: string, task?: string }, final?: true, note?: string }>
/**
 * The closing note for a coder or reviewer (reportRole), in place of closingNote: it begins with RETURN_NOTE_LEAD and the
 * parent's id, as closingNote does (dish-judge ends a child's brief there), says to finish with `report`, and keeps
 * send_message for a short question the child is blocked on. closingNote stays, byte for byte, for every other role.
 */
export function reportNote(parentId: string, marked: boolean): string

// text.ts
/** As now (text.ts:47-54); with `gate` and `reports` (the child is a coder, which finishes with `report`), the gate sentence speaks of `report`. */
export function worktreeBrief(worktree: { path: string, branch: string }, gate?: string, reports?: boolean): string

// allow.ts: NEVER (allow.ts:23-38) gains 'run' and 'open_pr'.
```

**The parameters** (delegate.ts:851-862):
- **`ruling`**, new: `{ type: 'string', description }`. The description: "Only after delegate refused for want of one (a review of work whose gate hasn't passed, or a coder past round 4 of its task): your ruling, on one line, as `Ruling: what — why — cost if wrong`. It is recorded. Leave empty otherwise."
- **`gateOverride`**, kept: `{ type: 'string', description: 'The old name of `ruling`, still accepted. Use `ruling`. Leave empty.' }`
- **`final`**, new: `{ type: 'boolean', description }`. The description: "Reviewer role only: true makes this the run's final review, the one `open_pr` checks (its verdict must approve the head that is pushed). It stays final for its follow-ups, and a follow-up with true makes that reviewer final. Leave false otherwise."
- **The output schema** gains `note: { type: 'string', description: 'For a coder working on a run\'s task: its round, and what the escalation ladder suggests.' }`.
  - `render` appends `\n<note>` when there is one.

**The description** (delegate.ts:847-850):
- **It replaces** the gate sentences with: "While gates are on, a bound coder's work is gated when it reports done, and its finish notice says how the gate ended; a review of that work is refused until the gate passes, unless `ruling` carries your ruling. In a run, each coder start or follow-up on a task is a round: from round 5, delegate refuses more coder work on that task unless `ruling` carries your ruling. Set `final: true` on the reviewer of a run's final review."
- **The last sentence** becomes "Returns the child's id, role, model and label, and for a coder on a run's task the ladder's note."

**Behavior,** in the order a call runs:
1. **`prepare`** (`delegate.ts:790-822`). No lock is held yet.
   - `ruling = given(args.ruling) ?? given(args.gateOverride)`. When `ruling` is given, `gateOverride` is ignored.
     - It is folded with `oneLine` and then masked with `maskSecrets`.
   - `final = args.final === true`.
     - `final` on a role that doesn't review is refused: "final is for the reviewer role (<reviewer>): it marks the run's final review. Leave final out for <article(role)>."
     - Being a cheap check, it comes before persona and target.
   - `runs = lookup.get('dishRuns') as RunsReader | undefined`, read with the same `get` cast `index.ts` uses. Crew doesn't depend on orchestrator, and its `Context` declaration may not exist yet.
2. **Persona or target, the bindings, and the session lock:** as now (`:882-924`). The session lock: `enforceLimits`. When bound, the worktree lock inside it: `enforceFree`.
3. **`start`** (`:678-730`). Everything runs inside the session lock, and inside the worktree lock when bound:
   1. `chooseModel`. Then, for a review, `gateCheck` with `call.ruling`. The check's behaviour doesn't change; only its texts name `ruling` (4 below).
   2. `checkRoute`, then `allowList`.
   3. **`placeCall(call, { worktree: bound?.path, reviews })`.** `reviews` is as `chooseModel` gave it.
   4. `addChild` with what it has now, plus `...tags`, and `final: true` when the placement gave it. The tags are the placement's `run` and `task`.
   5. **`dish-crew/delegated`** (Task 1).
   6. Build the prompt. `worktreeBrief(bound, gate, call.role === 'coder')`. The closing note, when the child has `send_message`: `reportNote(...)` for a child `reportRole({ role, reviews })` names (a coder or a reviewer), else `closingNote(...)` as today. Then `startContinuable`; on failure, `markFailed` and `dish-crew/settled` (Task 1).
   7. Return `{ child, role, model, label, ...note }`.
4. **`followUp`** (`:759-787`). The same locks:
   1. The model check. For a reviewer, `checkReviewer` and `gateCheck` with `call.ruling`.
   2. **`placeCall(call, { worktree: target.worktree, reviews: target.reviews }, target)`.** The follow-up's tags are the child's own and are never changed. `final` on a follow-up to a reviewer comes later, in `addFollowUp`.
   3. `sendMessage`.
   4. `addFollowUp(target.id, { gateOverride?, final? })`. `final: true` is passed when the placement gave it. A reviewer already final stays final: the record never clears it.
   5. **`dish-crew/delegated`** (Task 1).
   6. Return, with `note`.
   - So place and the ladder come after every check that refuses without writing anything: the limits, a busy worktree, the reviewer rule, the gate check, the route and the tools. They come before anything is recorded or sent, and they are still inside the locks. A ladder refusal is then the only refusal that writes, to the ledger.
5. **`placeCall`:**
   1. **No `runs`:** `{ tags: {} }`. No tags, no ladder, and no note but `final`'s: a profile without orchestrator behaves as today.
   2. **The placement.** `placed = await runs.place(call.sessionId, { ...where, ...call.final ? { final: true } : {} })`. A throw, or an answer that isn't `{ run: non-empty string, … }`, is logged once ("could not place a delegation in a run: …") and treated as `undefined`, so it fails open.
      - **`final`** is `true` in the result only when `placed.final === true`. orchestrator gives it only to a reviewer it placed in a run.
      - **`call.final` with no `final` placed** (no run, no `dishRuns`, or a failed `place`) isn't refused. The note says: "`final` had no effect: this chat drives no run, so there is no final review for `open_pr` to read." Without `dishRuns`: "`final` had no effect: dish keeps no runs here (dish-orchestrator isn't loaded)." This note is joined after the ladder's, when both apply.
   3. **The tags:**
      - for a start, `placed?.run` and `placed?.task`, those present;
      - for a follow-up, the target's own `run` and `task`.
   4. **No ladder** (return `{ tags }`) unless all of these hold:
      - `call.role === 'coder'`;
      - the tags have a `task`;
      - `placed?.round` is a whole number;
      - for a follow-up, `placed.run === target.run` and `placed.task === target.task`.
      - So reviewers, other roles, children outside a run, and a follow-up whose child the run no longer places aren't counted.
   5. **`round < LADDER_RULING_ROUND`:** `{ tags, note: ladderNote(task, round) }`. A `ruling` given is ignored and not recorded.
   6. **`round >= LADDER_RULING_ROUND` with no ruling,** or with one `hasRuling` refuses:
      - `await runs.ladder({ sessionId, run, task, round, outcome: 'refused', child: target?.id })`; a throw is logged;
      - then throw the refusal. With a blank ruling, it is prefixed with `ruling needs the ruling itself: what — why — cost if wrong. `
      - Nothing is recorded or sent.
   7. **`round >= LADDER_RULING_ROUND` with a ruling:**
      - `await runs.ladder({ …, outcome: 'ruled', ruling })`; a throw is logged and the call goes on;
      - then `{ tags, note }`, the note being "Round N of task `<task>`, past the ladder, on your ruling (recorded)."
6. **The texts:**
   - **`ladderNote`:**
     - round 0: `undefined`;
     - rounds 1–3: "Round N of task `<task>`. The ladder: rounds 1–3 go to the same coder with `to`; round 4 is a fresh coder on the strong tier (`model`), with the open findings and the previous coder's report; from round 5, delegate needs your ruling.";
     - round 4: "Round 4 of task `<task>`: the ladder starts a fresh coder on the strong tier (`model`), with the open findings and the previous coder's report. From round 5, delegate needs your ruling.";
     - round 5 and up: `undefined`, since the caller words those.
   - **The refusal:** "round N of task `<task>`: the escalation ladder ends at round 4, so delegate won't send more coder work on this task without your ruling. Rule with `ruling: "Ruling: what — why — cost if wrong"` (it is recorded), or stop the run with `run` (action `abandon`, and a reason)."
   - **The gate check's texts** (`gateCheck`, `:482-500`):
     - the hint is `` with `ruling: "Ruling: what — why — cost if wrong"` `` in place of `gateOverride: …`;
     - "gateOverride needs the ruling itself: …" becomes "ruling needs the ruling itself: …".
     - The ruling is still recorded on the reviewer as `ChildRecord.gateOverride`, 6c's field, and its brief is still `gateOverrideBrief`.
7. **`reportNote`:**
   ```ts
   const id = JSON.stringify(parentId)
   return `${RETURN_NOTE_LEAD}${id}. Finish by calling \`report\`: it is your report, and the main agent receives it in full, automatically. `
     + `So don't send your result with send_message, not even a summary or part of it${marked ? ', even though the note after this one says to' : ''}. `
     + `Use send_message({ agent_id: ${id}, message: "…" }) only for a short question you're blocked on while you work.`
   ```
   - The module header's `closingNote` paragraph (delegate.ts:116-124) gains a sentence: coders and reviewers get `reportNote` instead, which differs only in its first sentence after the id.
8. **`worktreeBrief`:**
   - Without `gate`: unchanged, byte for byte.
   - With `gate` and not `reports`: 6c's text, unchanged, for bound writers, ops and architects.
   - With `gate` and `reports`: the block, then " When you finish with `report` and `status: \"done\"`, dish runs this project's gate (`<gate>`) in your worktree, and a failure comes back to you. If you're blocked, report `status: \"blocked\"` or `\"needs_context\"` with `blockedOn`, and the gate is skipped."
9. **`NEVER`:** `'run'` and `'open_pr'` added. The header comment says that the run and PR tools are the main agent's.

**Tests:**
- **`delegate.test.ts`'s `world()`** gains:
  - an option `runs?: boolean`, which provides a `dishRuns` stub through `provide`;
  - `w.placements`: what `place` gives, by `${sessionId}|${worktree ?? ''}|${reviews ?? ''}`, defaulting to `undefined`;
  - `w.placeAsked` and `w.ladderCalls`;
  - `stub.placeFails` and `stub.ladderFails`.
- **The ruling:**
  - a review refused, then started with `ruling`, which is recorded as `gateOverride` and in the brief;
  - `gateOverride` alone still works;
  - with both, `ruling` wins;
  - a `ghp_` token in a ruling is masked on the record;
  - `RULING_HINT` and the expectations that quote "gateOverride needs the ruling itself" now say `ruling` (delegate.test.ts:1898, 2155, 2205, and the description test at 1963-1973);
  - the parameter list (`:347`) gains `final` and `ruling`.
- **Final:**
  - a reviewer started with `final: true`: `place` is asked with `final: true`; when it answers `final: true`, the record has `final: true`; `false` or absent asks and records none;
  - `final: true` with no run placed, and with no `dishRuns`: started, nothing recorded, and each note;
  - `final: true` on a coder is refused before persona or record;
  - a follow-up with `final: true` (placed final) marks the reviewer final; a follow-up without it keeps it.
- **The closing note:**
  - a coder's and a reviewer's prompts end with `reportNote`: it begins with `RETURN_NOTE_LEAD` and the parent's id, and names `report`;
  - with dsh's marked `send_message`, `reportNote` says so, as `closingNote` does;
  - a researcher's, a writer's and an ops child's end with `closingNote`, byte for byte;
  - the existing expectations of a coder's or a reviewer's closing note now expect `reportNote`; the others are unchanged.
- **Tags:**
  - with `dishRuns`, a bound coder's `place` gets `{ worktree: <the canonical path> }` (also when the workspace is reached through a link), and the record and the `delegated` event carry `run` and `task`;
  - a researcher gets `{ }`, and `run` only;
  - a reviewer gets `{ reviews }`;
  - a follow-up keeps the child's tags whatever `place` says;
  - without `dishRuns`, nothing is asked and nothing is tagged;
  - `place` throws: logged, untagged, delegated.
- **Where place runs:**
  - a call refused by the writer limit, by a running child bound to the worktree, by the route, or by the gate check never asks `place`;
  - two coder delegations at once on one task in one session: the second's `place` is asked after the first's `delegated` listener settled (the stub counts a round in its listener).
- **The ladder:**
  - a coder on a task at round 0: no note;
  - rounds 1–3 and round 4: each note;
  - round 5 without a ruling: refused with the text, `ladder` called with `refused`, and nothing recorded, started or published;
  - round 5 with a ruling: started, `ladder` called with `ruled` and the masked ruling, and the note;
  - `Ruling:` alone at round 5 is refused with the prefix;
  - a follow-up at round 6 is refused the same way, and nothing is sent;
  - a follow-up whose child's tags differ from the placement isn't counted;
  - a writer bound to a task at round 7, and a reviewer, aren't counted;
  - a `ruling` at round 2 is ignored, and `ladder` isn't called;
  - `ladder` throwing: the refusal still comes; with a ruling, the start still happens; both are logged.
- **The output:** `note` is in the value, and `render` shows it on its own line.
- **`worktreeBrief`:** with a gate and `reports`, the new sentence; with a gate and not `reports`, 6c's text; without a gate, 6b's, byte for byte. A bound coder's prompt (with dish-gates) carries the `report` form; a bound writer's carries 6c's.
- **allow.test.ts:** `NEVER_NAMES` gains `run` and `open_pr`; a role listing them doesn't get them.

**Steps:**
- [ ] Failing tests first (above), and update the existing expectations named above.
- [ ] Implement. Run `pnpm install --offline --frozen-lockfile` with `pnpm_config_store_dir` set, then the gate.
- [ ] Commit `dish-crew: delegate's ruling, final review, run tags, the escalation ladder, and the closing note for coders and reviewers`.

---

## Task 5: gating after `report`, each result's head and event, and `runAt` (dish-gates)

**Needs:** Tasks 1, 2 and 6.
- **Task 6:** `dishWorkspaces.headOf`.
- **Task 2:** `dishCrew.reportSteered`, crew's `report` tool and its steer. The plugin test drives them through crew's real host plugin, whose `agent/turn-stopping` behaviour Task 2 changes.
- **Task 1:** `GateResult.head` (the type, its check and its parse), and `ChildRecord.report` and `RunRecord.structured`, which the real-loop tests read.

**Files:**
- **Create:**
  - `plugins/gates/src/locks.ts`: `WorktreeLocks`, moved out of `listener.ts` unchanged;
  - `plugins/gates/src/check.ts`: `runAt`;
  - `plugins/gates/test/check.test.ts`.
- **Modify:**
  - `plugins/gates/src/closing.ts`, `src/text.ts`, `src/logs.ts`, `src/listener.ts` and `src/index.ts` (the module doc too);
  - `plugins/gates/cordis.patch.yml` (its header comment).
- **Test:** `plugins/gates/test/closing.test.ts`, `text.test.ts`, `logs.test.ts`, `listener.test.ts` and `plugin.test.ts`.

**Interfaces:**
```ts
// GateResult.head (string | null) is crew's, from Task 1: dish-gates fills it.

// closing.ts
export const REPORT_TOOL = 'report'
export type ReportStatus = 'done' | 'blocked' | 'needs_context'
export const REPORT_STATUSES: readonly ReportStatus[]           // ['done', 'blocked', 'needs_context']
export interface Closing {
  head: string
  toolCalls: boolean
  /** The `status` of a successful `report` that concluded the current turn since its newest assistant message; absent when none. */
  report?: ReportStatus
}
export class ClosingHeads {
  observe(session: object, event: unknown): void   // as today: an `assistant/message` replaces the entry (so `report` goes); `turn/start` deletes it
  /**
   * dsh-tools' `tools/result(exec, result)`: a call named `report`, by an agent with a session object, `result.isError === false`,
   * `result.concludesTurn === true`, and `result.value.status` one of REPORT_STATUSES: that status becomes the session's
   * `report`, keeping its head and toolCalls. Anything else is ignored. Never throws.
   */
  toolResult(exec: unknown, result: unknown): void
  closing(session: object): Closing
  headOf(session: object): string
}

// text.ts
/** Why a gate was skipped when the coder's `report` said it couldn't finish. */
export const REPORTED_REASON: Readonly<Record<'blocked' | 'needs_context', string>>
//   { blocked: 'the coder reported status blocked', needs_context: 'the coder reported status needs_context' }
export interface Failure {
  /* … as today … */
  /** The stop was concluded by the coder's `report`: the message asks for `report` again. Default false. */
  reported?: boolean
}

// locks.ts
/** One job at a time per worktree, shared by the listener and runAt (the class now in listener.ts, unchanged). */
export class WorktreeLocks {
  run<T>(key: string, signal: AbortSignal, job: () => Promise<T>): Promise<T | undefined>
}

// logs.ts
/** <state>/gates/<owner>/<repo>/<slug>/open_pr.log, with gateLogFile's checks of owner, repo and slug. writeLog gives a taken name `.2`, `.3`, … */
export function checkLogFile(state: string, project: string, slug: string): string

// listener.ts
export interface GateResultEvent {
  childId: string
  /** The crew session the child belongs to (records.lookup's sessionId). */
  sessionId: string
  result: GateResult
}
export interface GateDeps {
  /** ctx.get('dishCrew'). `reportSteered` is crew's (Task 2); a crew without it counts as false. */
  crew(): { records: GateRecords, reportSteered?(childId: string): boolean } | undefined
  /** ctx.get('dishWorkspaces'). */
  workspaces(): Pick<DishWorkspaces, 'resolve' | 'resolveProblem' | 'headOf'> | undefined
  /* projects, shell, closing, settings, state, signal, environment, logger, now, run: as today */
  /** Publish `dish-gates/result`. Never rejects: index.ts logs a listener's failure. */
  publish(event: GateResultEvent): Promise<void>
  /** Shared with runAt. Default: one of its own. */
  locks?: WorktreeLocks
}

// check.ts
export interface RunAtOptions {
  /**
   * The session the gate runs for. For open_pr, its caller: the main agent, `String(exec.agent.id)`, which is its session's
   * id (dsh's agent registry is keyed by it, and crew uses the same spelling). The sandbox policy's `sessionId`, as the main
   * agent's own shell commands get from dsh-sandbox-policy (`sessionId: session.id`).
   */
  sessionId: string
  /** The commit the caller read with dishWorkspaces.headOf and means to push. When given, a worktree whose HEAD isn't it isn't gated (`error`). */
  head?: string
  /** The caller's. When it aborts, the gate is cancelled and runAt rejects with its reason. */
  signal?: AbortSignal
}
/** A gate run for open_pr: a GateResult without the turn's rounds. Recorded nowhere: the caller records it. */
export type GateCheck = Omit<GateResult, 'turn' | 'round' | 'maxRounds'>
export interface CheckDeps {
  workspaces(): Pick<DishWorkspaces, 'resolve' | 'resolveProblem' | 'headOf'> | undefined
  projects(): Pick<DishProjects, 'get'> | undefined
  shell(): ShellLike | undefined
  state: string
  signal: AbortSignal                  // the plugin's
  locks: WorktreeLocks                 // the listener's
  environment?: () => Readonly<BaseEnvironment>
  logger: { warn(format: string, ...args: unknown[]): void, info(format: string, ...args: unknown[]): void }
  now?: () => number
  run?: typeof runGate
}
export function gateCheck(deps: CheckDeps): (project: string, worktreePath: string, options: RunAtOptions) => Promise<GateCheck>

// index.ts
export interface DishGates {
  gateFor(project: string): Promise<string | undefined>          // as today
  /** The project's gate in a worktree dish made, at its HEAD, as a coder's gate runs (sandbox, timeout, gateEnv), for `options.sessionId`. */
  runAt(project: string, worktreePath: string, options: RunAtOptions): Promise<GateCheck>
}
declare module '@deepseek-ai/cordis' {
  interface Context { dishGates: DishGates }
  interface Events {
    /** dish-gates recorded `result` for crew child `childId` of session `sessionId`, after addGate kept it. */
    'dish-gates/result'(e: GateResultEvent): void
  }
}
export type { GateCheck, GateResultEvent, RunAtOptions }
```
**The new event's types.** `ctx.on('tools/result', …)` is typed by dsh-tools' augmentation of cordis' `Events`. The one root program (`tsconfig.json` includes every `plugins/*/src`) already loads it through crew, judge and workspaces, as it loads `session/event` today. `toolResult` takes `unknown`. So dish-gates gains no dependency.

**Behavior:**
1. **Hearing `report`** (index.ts). `ctx.on('tools/result', (exec, result) => { heads.toolResult(exec, result) })` is registered beside `session/event`, synchronously in `apply`. The order in dsh 0.2.0-rc.2 (`dsh-agent-loop` `step()` and `runGroup()`, `dsh-tools` `notifyResult`):
   - the step's `assistant/message` is appended before its tools run, so it can't clear the report it carries;
   - `tools/result` is emitted, synchronously, before the result is committed;
   - `agent/turn-stopping` fires after the step;
   - the next step's `assistant/message`, or the next `turn/start`, clears the report.
2. **The gating rule** (listener.ts, `gate()`). It replaces today's `if (closing.toolCalls) return` (`listener.ts:286-287`) in the same place: in the lock, once the record is read.
   - `closing = deps.closing(agent)`.
   - **(a) With `closing.report` set,** the coder has finished, whatever `toolCalls` says.
   - **(b) Without it:**
     - `closing.toolCalls` → return, recording nothing (as today);
     - `reportSteered(id)` true → return, recording nothing: crew's prepended `agent/turn-stopping` listener steered this stop to call `report`. Crew's listener is prepended and cordis' `serial` awaits listeners in order, so the steer is made before this runs.
     - Otherwise the coder has finished: the newest message has no tool calls and crew didn't steer it. With `reportSteers: 0`, crew never steers, and (b) is today's rule.
   - **`reportSteered(id)`:**
     - it is `deps.crew()?.reportSteered?.(id) === true`;
     - a throw is logged once ("dish-gates couldn't ask crew whether it steered child <id>: <message>", masked) and counts as false.
   - So a report steer and a gate steer never both happen at one stop.
3. **The head.** Once `resolve` gives the worktree (`listener.ts:291`), `head` is `await workspaces.headOf(worktree.path)`.
   - **null when:** it gives `undefined`, or it throws. A throw is logged once ("dish-gates couldn't read the HEAD of <path>: <message>", masked), and the gate still runs.
   - **Which results carry it:**
     - every result recorded from there on carries `head`;
     - results recorded before carry `head: null`: no dish-workspaces, unresolved, and an error before resolve;
     - so does the catch path's `error` when it comes before the head was read.
4. **The opt-out** (replaces `listener.ts:301`):
   - **With `closing.report`:**
     - `done` goes on. The text head isn't read: it can be an older message's, since a message holding only the `report` call has no text;
     - `blocked` → `skipped` with `REPORTED_REASON.blocked`;
     - `needs_context` → `skipped` with `REPORTED_REASON.needs_context`.
   - **Without it:** `optsOut(closing.head)` → `skipped` with `BLOCKED_REASON`, as today.
5. **Rounds, the run and the outcome:** as today.
   - A turn has at most `maxRounds` gate runs, however its stops come: by `report` or by text.
   - A report followed by more edits and a text stop goes like this. Its `assistant/message` cleared the report. Crew steers it if it has steers left (not gated), else it is gated by (b).
6. **The steer:** as today, with `failureMessage({ …, reported: closing.report !== undefined })`.
7. **The message** (text.ts), for `reported: true`. Two sentences change; the rest is as today. `failureSummary` doesn't change.
   - **The fix sentence:** "Fix it in your worktree, then call `report` again: the new report replaces the one you made. The gate runs again when you do."
     - The next-to-last round's sentence still follows it.
     - It replaces today's "…finish again with your whole report as your closing message…".
   - **The opt-out sentence:** "If you're blocked, call `report` with `status: "blocked"` or `"needs_context"` and `blockedOn`, and the gate is skipped."
   - **`reported: false`** (or absent) gives today's text, byte for byte.
8. **The event.** Every result that `addGate` kept is published once, right after it: `await deps.publish({ childId: id, sessionId, result })`.
   - **`sessionId`:** the session of `records.lookup(id)`, the lookup in the lock, or `stop()`'s for the catch path.
   - **`result`:** a shallow copy of what was recorded.
   - **When it is published:** `record()` (`listener.ts:254`) publishes after its log line, and the catch path (`listener.ts:341-350`) publishes when `addGate` returned true.
   - **Never published:** a result `addGate` didn't keep (false, or a throw), and a cancelled stop.
   - **Order:** the publish is awaited inside `agent/turn-stopping`. So a listener of `dish-gates/result` runs before the turn can close, and before that run's `subagent/end`.
9. **`publish`** (index.ts):
   - `ctx.parallel('dish-gates/result', event)`, awaited, while the plugin is live (a flag cleared by `ctx.effect` on dispose), as `plugins/projects/src/index.ts:76-84` does;
   - an `AggregateError`'s causes, or the error, are each logged once per distinct message ("a dish-gates/result listener failed: <message>", masked);
   - it never rejects.
10. **One lock** (index.ts). One `WorktreeLocks` is given to `gateListener` (`deps.locks`) and to `gateCheck`. A coder's gate and an open_pr gate never run at once in a worktree.
11. **`runAt(project, worktreePath, options)`** (check.ts):
    1. A call whose `options.sessionId` isn't a non-empty string rejects with a `TypeError`, before anything runs.
    2. `signal = AbortSignal.any([options.signal ?? a signal that never aborts, deps.signal])`.
    3. **Before the lock, each an `error` result, with nothing run:**
       - no dish-workspaces: "dish-workspaces isn't running";
       - `resolve(worktreePath)` gives `undefined`: `resolveProblem`'s reason, else "no worktree dish made at <path> in a registered project";
       - the resolved `worktree.project` isn't `project` (compared without case): "the worktree <path> is <worktree.project>'s, not <project>'s".
    4. **The lock:** `locks.run(worktree.path, signal, job)`. `undefined` (the signal aborted while it waited) is cancellation (step 8).
    5. **In the job, each an `error` result, with nothing run:**
       - no dish-projects: "dish-projects isn't running";
       - `projects.get(worktree.project)` gives `undefined`: "<project> isn't in projects.yaml";
       - `head = await workspaces.headOf(worktree.path)`. A throw is "dish couldn't read the worktree's HEAD: <message>"; `undefined` is "the worktree is gone, or its project is no longer registered";
       - `options.head` given and not `head`: "the worktree's HEAD is <head>, not <options.head>: it moved after the caller read it" (with `head` set);
       - no shell: today's `NO_SHELL`.
    6. **The run:**
       - `run({ shell, command: project.gate, worktree: { path, clone }, timeoutMs: project.gateTimeoutMs, env, log, signal, sessionId: options.sessionId, now })`;
       - `env`: `await withMiseShims(gateEnvironment(project.gateEnv, …), environment())`, as the listener has it;
       - `log`: `checkLogFile(state, worktree.project, worktree.slug)`;
       - run.ts's request then sets `sandboxPolicy: { mode: 'workspace-write', workspaceRoot: <clone>, sessionId: options.sessionId }` and the 10-minute cap. That is the coder's sandbox and timeout, for the main agent's session.
    7. **The outcome:**
       - `ran` → `passed` (exit 0, not timed out) or `failed`, with `command` (masked), `exitCode`, `timedOut`, `durationMs`, `log`, `excerpt: excerptOf(output)`, `head` and `at`;
       - `error` → `error` with the run's reason and `durationMs`.
       - Logged at info: "open_pr's gate for <project>/<slug> at <head, first 12>: passed in 42 s", or "failed in … (exit 1)". An error is logged at warn.
    8. **Cancellation** (`cancelled`, or the lock given up):
       - `options.signal?.aborted` → reject with `options.signal.reason`, or an `Error` named `AbortError` when the reason isn't an Error;
       - else (the plugin stopped) → `error`, "dish-gates stopped before the gate finished".
    9. **What it doesn't do:**
       - It records nothing in crew's record, steers nothing and publishes nothing: the caller records `pr.checked` itself.
       - Any throw of dish's own code is an `error`, "dish-gates failed: <message>" (masked, one line, at most 300 characters).
       - It rejects only as in steps 1 and 8.
       - `error` results have `command: ''`, `exitCode: null`, `timedOut: false`, `log: null`, `excerpt: ''`, and `head` the head read, or null.
12. **The service:** `ctx.provide('dishGates', { gateFor, runAt })`, where `runAt = gateCheck({ … })` reads every service with `ctx.get` on each call, as the listener does.
13. **`cordis.patch.yml`'s comment** says the plugin also hears `tools/result` (a coder's `report`), publishes `dish-gates/result`, and provides `runAt` for open_pr.

**Tests:**
- **`closing.test.ts`:**
  - `toolResult: a successful report that concluded the turn keeps its status for that session`;
  - `toolResult ignores another tool, an error result, one without concludesTurn, an unknown status, an agent without a session, and malformed arguments`;
  - `the next assistant message drops the report, with or without text; turn/start drops it; two sessions are kept apart`;
  - `a report keeps the head and toolCalls the session had`.
- **`text.test.ts`:**
  - `failureMessage after a report asks for report again and gives report's opt-out, and holds no "closing message"`;
  - `failureMessage without reported is today's text, byte for byte`;
  - `the next-to-last round's sentence follows the report fix sentence too`.
- **`logs.test.ts`:**
  - `checkLogFile: <state>/gates/acme/widget/fix-1/open_pr.log, and gateLogFile's refusals (.., a slash in the owner, a slug outside the segment rule)`.
- **`listener.test.ts`.** The world gains:
  - `reports: Map<StoppingAgent, ReportStatus>` (folded into `closing`);
  - `steered: Set<string>` (crew's `reportSteered`);
  - `HEAD` returned by a stub `headOf`, overridable per path;
  - `published: GateResultEvent[]` from a stub `publish`.

  Existing expectations gain `head`: `HEAD` once the worktree resolved, `null` before. New tests:
  - `a stop concluded by a report with status done is gated, though its newest message holds tool calls`;
  - `a report with status blocked or needs_context is skipped with its reason, and nothing runs`;
  - `when a report concluded the stop, the text head isn't read: BLOCKED: in it with status done is gated, Done. with status blocked is skipped`;
  - `a stop crew sent back to call report isn't gated and records nothing; once reportSteered is false, a stop with no tool calls is gated (the fallback)`;
  - `a crew without reportSteered gates as today; one whose reportSteered throws is logged once and counts as false`;
  - `the steer after a report asks for report again; after a closing message it gives today's text`;
  - `rounds count across report and text stops in one turn: report fails, text fails, report fails (recorded, not steered)`;
  - `every result carries the worktree's head; null before the worktree resolves, and when headOf throws (logged once) or gives undefined`;
  - `each kept result is published once on dish-gates/result, after addGate, with the child's session; one crew didn't keep, or that addGate threw for, isn't; a cancelled stop publishes nothing`;
  - `an error recorded by the catch path is published too`.
- **`check.test.ts`** (fake run, stub services, the real `WorktreeLocks`):
  - `runAt runs the project's gate in the worktree for the given session, and gives passed with the head and the log path <state>/gates/acme/widget/fix-1/open_pr.log`;
  - `runAt: a failure gives failed with the excerpt and the log; nothing is recorded, steered or published`;
  - `runAt with head: a worktree whose HEAD moved is an error and nothing runs; the same head runs`;
  - `runAt: a worktree of another project, no dish-workspaces, an unresolved worktree (with and without a problem), no dish-projects, an unregistered project and no shell are each an error, and nothing runs`;
  - `runAt: a gateEnv with <clone> and <worktree> reaches the run expanded, with mise's shims after dsh's PATH`;
  - `runAt and the listener share the lock: runAt waits for a coder's gate on the same worktree, and a coder's stop waits for runAt; another worktree doesn't wait`;
  - `runAt rejects with the caller's reason when its signal aborts while it waits or while the gate runs; the plugin stopping is an error`;
  - `runAt without a sessionId rejects with a TypeError, and nothing runs`;
  - `runAt with dsh's real shell` (`withRealShell`, skipped with `SKIP`): a passing gate and a failing one (exit 3) in `makeClone`'s worktree, both with `head` the worktree's real HEAD (a stub `headOf` reads it with `git rev-parse` through `runOk`).
- **`plugin.test.ts`.** Task 2 set `reportSteers: 0` in `world()`'s crew config. It becomes a `world()` option, default `0`, so the existing fake-agent and real-loop tests keep today's text endings. The `dishWorkspaces` stub gains `headOf`. New tests:
  - **Fake agent:**
    - `dish-gates hears tools/result: a report that concluded a turn makes a stop with tool calls gated, and an assistant message after it doesn't`;
    - `dishGates.runAt is there, and the fake shell's request has sandboxPolicy { mode: 'workspace-write', workspaceRoot: CLONE, sessionId: 'main-1' }`;
    - `a dish-gates/result listener gets the result after crew has it (it reads it back with lookup), and one that throws is logged once and changes nothing`.
  - **Real crew children through dsh's loop** (`reportSteers: 2`). `withDsh`'s `CoderReply.calls` also takes `{ name, args }`, sent as `JSON.stringify(args)`. The children record as `delegate` does: `addChild`, then the start. So crew's `agent/created` gives them `report` (Task 2).
    - `a real crew coder that reports done is gated; a failure steers it to call report again, and that report is gated`. Expect two shell requests, results `[failed 1, passed 2]` in turn 1, and the second coder request holding "call `report` again". The filed run has the second report (`RunRecord.structured`, Task 1).
    - `a real crew coder that reports blocked is skipped with REPORTED_REASON.blocked, and nothing runs`.
    - `a real crew coder that ends with text is steered by crew, not gated, until crew's steers run out; then its stop is gated`. Expect three coder requests and one shell request. Requests 2 and 3 hold crew's steer and not "The gate failed".
    - `a real crew coder that reports, is steered by a failure, calls a tool and ends with text: crew steers it, and its next report is gated`. Expect two shell requests; the text stop isn't gated.
    - `the gate's result reaches a dish-gates/result listener with the child's session, and the head the stub headOf gives`.

**Steps:**
- [ ] Run `pnpm install --offline --frozen-lockfile` with `pnpm_config_store_dir` set.
- [ ] Failing tests first: `closing`, `text`, `logs`, `listener`, `check`, `plugin`.
- [ ] Implement: `locks.ts` (moved); `closing.ts`; `text.ts`; `logs.ts`; `listener.ts`; `check.ts`; `index.ts`; `cordis.patch.yml`'s comment. Grep `plugins/gates/src` for `child_process`: none.
- [ ] Run the gate: `pnpm typecheck && pnpm test`.
- [ ] Commit `dish-gates: gate after report, each result's head and event, and runAt for open_pr`.

---

## Task 6: the head, cleanliness, the push, the pull request and its comments, and the run hooks (dish-workspaces)

**Needs:** nothing.

**Files:**
- **Create:**
  - `plugins/workspaces/bin/git-credential-dish-push`: the one-shot push helper;
  - `plugins/workspaces/src/push.ts`: the isolated push;
  - `plugins/workspaces/test/push.test.ts`, `test/publish.test.ts` and `test/runs.test.ts`.
- **Modify:** in `plugins/workspaces/`:
  - `src/git.ts`, `src/paths.ts`, `src/github.ts`, `src/tokens.ts`, `src/worktrees.ts`, `src/service.ts`, `src/index.ts`, `src/tool.ts` and `src/client/AppCard.tsx`;
  - `README.md`.
- **Test:** in `plugins/workspaces/test/`:
  - `git.test.ts`, `helper.test.ts`, `paths.test.ts`, `github.test.ts`, `tokens.test.ts`, `tool.test.ts` and `plugin.test.ts`;
  - the fakes `fake-github-api.ts` and `fake-git-http.ts`, and `service-helpers.ts`.

**Interfaces:**
```ts
// git.ts
export interface GitOptions {
  /* … as today … */
  /**
   * Written to git's fd 3, a socket its children inherit, then that end is closed. pushBranch's write token, for
   * bin/git-credential-dish-push to read with `read <&3`. Never in an argument, the environment, a file or a message.
   * One line of printable ASCII (/^[\x21-\x7e]{1,4096}$/), else git() rejects before starting anything and doesn't quote it.
   * Without it, git gets no fd 3.
   */
  secret?: string
}

// paths.ts
/** `!/bin/sh '<helper>' '<web>'`, with helperValue's checks (no `'`, no control character, an absolute helper). */
export function pushHelperValue(helper: string, web: string): string

// github.ts
export const PUSH_PERMISSIONS: Readonly<{ contents: 'write', metadata: 'read' }>
export const PULL_PERMISSIONS: Readonly<{ metadata: 'read', pull_requests: 'write' }>
export type WritePermissions = typeof PUSH_PERMISSIONS | typeof PULL_PERMISSIONS
export interface PullOpened { number: number, url: string, base: string }
class GitHubApp {
  /* createToken: unchanged, still read-only */
  /**
   * POST /app/installations/{id}/access_tokens for one repository with exactly PUSH_PERMISSIONS or PULL_PERMISSIONS.
   * Anything else throws before any request. A token GitHub granted more than asked for (a permission not asked, or a
   * higher level), or for another repository, is GitHubError('other') and isn't returned.
   */
  createWriteToken(installationId: number, repository: string, permissions: WritePermissions): Promise<InstallationToken>
  /** POST /repos/{o}/{r}/pulls with an installation token: `{ title, head, base, body }`. */
  createPull(owner: string, repo: string, pull: { title: string, head: string, base: string, body: string }, token: string): Promise<PullOpened>
  /** GET /repos/{o}/{r}/pulls?head=<owner>:<branch>&state=open&per_page=100: the first whose head.ref is `branch`, or undefined. */
  findOpenPull(owner: string, repo: string, branch: string, token: string): Promise<PullOpened | undefined>
  /** POST /repos/{o}/{r}/issues/{number}/comments with an installation token: `{ body }`. A 201 is enough. */
  createComment(owner: string, repo: string, number: number, body: string, token: string): Promise<void>
}

// tokens.ts
class TokenManager {
  /**
   * A token for `owner/repo` with `permissions`, minted now for one call: never cached on the owner's state, never
   * written, never logged. The caller drops it when its call ends.
   */
  writeToken(owner: string, repo: string, permissions: WritePermissions): Promise<string>
}

// push.ts
export const PUSH_TIMEOUT_MS = 600_000
/** Every git the push runs reads no system or global config: only the isolated repository's, and the -c flags. */
export const PUSH_ENV: Readonly<Record<string, string>>     // { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' }
export interface PushRequest {
  clone: string                // canonical, from resolve
  branch: string               // dish/<slug>
  tip: string                  // the commit to push: refs/heads/dish/<slug> in the clone, as read under the lock
  url: string                  // httpsUrl(web, owner, repo)
  web: string                  // the web origin the helper answers for
  helper: string               // bin/git-credential-dish-push, absolute
  parent: string               // projectStateDir(state, owner, repo): where the isolated repository is made
  token: string
  signal?: AbortSignal
}
/** What pushIsolated did. pushBranch logs it, and gives its caller only `head`. */
export interface PushedBranch {
  branch: string
  head: string
  url: string
  result: 'created' | 'updated' | 'up-to-date'
}
/**
 * git's arguments for the push from `gitDir`:
 * ['--git-dir', gitDir, '-c', 'credential.helper=', '-c', `credential.helper=${helperValue}`, '-c', 'http.followRedirects=false',
 *  'push', '--porcelain', url, `refs/heads/${branch}:refs/heads/${branch}`]
 */
export function pushArgs(gitDir: string, url: string, branch: string, helperValue: string): string[]
/** The push's failure as a message: GitHub's reason, masked and cut. */
export function pushFailure(result: GitResult, branch: string): string
export function pushIsolated(request: PushRequest): Promise<PushedBranch>

// worktrees.ts
export interface CreatedWorktree extends Worktree {
  setup: SetupOutcome
  /** The base as asked for: `origin/<default>`, or the caller's `base` (the record's `baseRef`, worktrees.ts:216). */
  baseRef: string
}
class Worktrees {
  /** HEAD's commit in the worktree at `path` (checkWorktree first; a refusal throws). Throws "worktree <slug>'s HEAD isn't a commit". */
  head(clone: string, path: string): Promise<string>
  /** refs/heads/<branch>'s commit in the clone, or undefined (branchTip). */
  tip(clone: string, branch: string): Promise<string | undefined>
}

// service.ts
/**
 * What dish-workspaces reads of dish-orchestrator (dishRuns), structurally: neither package depends on the other. The
 * `worktree` tool calls worktreeCreated after createWorktree returned, and worktreeRemoved after its remove; the sweep calls
 * worktreeRemoved for each worktree it removed. None is called, or awaited, while a project's lock is held.
 */
export interface CreatedForRun { project: string, slug: string, branch: string, path: string, clone: string, base: string /* the commit */, baseRef: string }
export interface RunsHooks {
  worktreeCreated(sessionId: string, created: CreatedForRun): Promise<{ id: string, opened: boolean } | undefined>
  worktreeRemoved(project: string, slug: string): Promise<void>
}
export interface OpenedPull { url: string, number: number, existing: boolean }
export interface DishWorkspaces {
  /* … as today (createWorktree's signature unchanged; its result gains baseRef), with: */
  /** HEAD's commit in the worktree; undefined when resolve gives none. Rejects when git can't say. No lock. */
  headOf(pathOrRef: string): Promise<string | undefined>
  /** Whether the worktree has nothing a commit would lose, on its own branch. Rejects when resolve gives none, or git can't say. No lock. */
  isClean(pathOrRef: string): Promise<{ clean: true } | { clean: false, why: string }>
  /** Push dish/<slug> of a worktree dish made, at `head` only, to the project's HTTPS URL, with a write token minted for this call. Under the project's lock. */
  pushBranch(project: string, slug: string, options: { head: string, signal?: AbortSignal }): Promise<{ head: string }>
  /** Open the pull request from `head` (dish/<slug>) to the project's default branch, or report the open one. No lock. */
  openPull(project: string, pull: { head: string, title: string, body: string }): Promise<OpenedPull>
  /** Comment on pull request `number` of the project (its issue comments), with a write token minted for this call. No lock. */
  commentPull(project: string, number: number, body: string): Promise<void>
}

// tool.ts
/** The `worktree` tool, over `service` and dish-orchestrator's hooks (each read on each call). */
export function worktreeTool(service: () => DishWorkspaces | undefined, runs?: () => RunsHooks | undefined,
  options?: { warn?(format: string, ...args: unknown[]): void }): ToolDefinition
// index.ts: the dishWorkspaces object gains headOf, isClean, pushBranch, openPull and commentPull; the tool gets
// `() => (ctx as unknown as { get(name: string): unknown }).get('dishRuns') as RunsHooks | undefined`;
// it exports the types CreatedForRun, OpenedPull and RunsHooks.
```

**Behavior:**

1. **The token's way to git** (the decision).
   - **The mechanism:** a one-shot credential helper reading an inherited fd.
     - `pushIsolated` runs `git push` with `secret: token`. `git()` gives git a fourth stdio `'pipe'` (fd 3), writes `token + '\n'` to it, and ends it.
     - The helper (`bin/git-credential-dish-push`, below) reads one line from `<&3` on `get`.
     - Checked in the spike: fd 3 reaches a `!` helper started by `git-remote-http`.
   - **Why not the environment:**
     - The environment (an env-reading helper, `GIT_ASKPASS`, or `GIT_CONFIG_COUNT` with `http.extraHeader`) can be read by any process of the same user through `/proc/<pid>/environ`. That holds for the whole push, for git and every child, again and again, unseen. And dsh's agents run as the same user.
     - fd 3 is a socket, which another process can't open through `/proc/<pid>/fd/3` (`ENXIO`). Its line is gone once the helper has read it.
     - A thief that reads it first leaves the helper nothing: the push fails, and it shows.
     - Only `ptrace` or `pidfd_getfd` reach it, which read process memory, and so the App key's credential store, anyway (the spec's question 1).
   - **What stays the same:**
     - The token never touches disk or an argument, and the helper's token files stay read-only.
     - It is checked that no `ghs_` token appears in git's argv, its environment, a file or a message.
2. **`git()`** (git.ts):
   - `secret` is checked first: a string matching `/^[\x21-\x7e]{1,4096}$/`, else `Promise.reject(new Error('git: the secret must be one line of printable ASCII'))`, before `spawn`;
   - with it, `stdio` gets a fourth `'pipe'`, and right after spawn: `child.stdio[3].on('error', () => {})` and `.end(`${secret}\n`)`;
   - `finish` destroys `child.stdio[3]`, as it does stdout and stderr.
   - Nothing else changes, and the module stays the only one that spawns git.
3. **`bin/git-credential-dish-push`.** POSIX `sh`, `set -u`, `LC_ALL=C`, shellcheck clean, run through `/bin/sh` by its absolute path. Its header comment says what follows. Arguments: `$1` the web origin, `$2` the action.
   - **The action:** not `get`, or no web origin → exit 0, printing nothing (`store` and `erase` too).
   - **The request:** it reads git's request from stdin up to a blank line or EOF, keeping `protocol=` and `host=` as `git-credential-dish` does (`bin/git-credential-dish:34-46`).
   - **The origin:** `"$protocol://$host"` not exactly the web origin → `quit=true` alone.
   - **The token:** `token=; { IFS= read -r token <&3; } 2>/dev/null || :`. Empty (fd 3 closed, empty, or read already) → `quit=true` alone.
   - **The answer:** `printf 'username=x-access-token\npassword=%s\nquit=true\n' "$token"`, with `printf` a builtin.
   - **Never:** it never echoes its input, writes no file, and runs no external command on the token.
4. **`createWriteToken`** (github.ts):
   - **Before any request, each throws a plain `Error`:**
     - an installation id that isn't a positive integer;
     - a repository not matching `^[A-Za-z0-9._-]{1,100}$`;
     - permissions whose sorted entries aren't exactly those of `PUSH_PERMISSIONS` or `PULL_PERMISSIONS`: "dish mints write tokens only for a push (contents) or a pull request (pull_requests)".
   - **The request:** body `{ repositories: [repository], permissions }`.
   - **The answer:** malformed → `malformed(call)`.
   - **A token that is never used** (GitHubError('other')):
     - a granted permission that wasn't asked for, or one at a level above the asked one (`write` > `read`): "…: GitHub granted more than asked; the token is not used";
     - `repositories` names that aren't exactly `[repository]` (without case): "…: the token covers other repositories; it is not used".
   - **`createToken`'s read-only guard is unchanged.**
5. **`#request`'s errors** (github.ts). When a failure's JSON body has `errors`, an array, each item's `message` (a string) is added to the excerpt: `"<message> (<msg1>; <msg2>)"`, masked, then cut to 200.
   - An item without one gives `<resource> <field> <code>`, from the strings it has.
   - A body without `errors` reads as today.
6. **`createPull` and `findOpenPull`** (github.ts). An installation-token `Auth` (`checkedToken`), and `segment` for owner and repo.
   - **`createPull`:** `POST` with the four fields. A 201 must have a number `number` and a string `html_url` (else `malformed`). It gives `{ number, url: html_url, base }`.
   - **`findOpenPull`:**
     - `GET` with `head` = `encodeURIComponent(`${owner}:${branch}`)`;
     - not an array → `malformed`;
     - the first item with `head.ref === branch` → `{ number, url: html_url, base: base.ref }`, else `undefined`.
7. **`writeToken`** (tokens.ts).
   - **Refused, with nothing minted:**
     - `ownerKey(owner)` must be a held owner (`#held`; a closed manager throws as today);
     - `repo` must be among its `state.repos` (without case), else "the dish App can't reach <owner>/<repo>: no project of dish has it installed".
   - **The mint:** `this.#app.createWriteToken(state.installation, repo, permissions)`, and its `token` is returned.
   - **Refused by GitHub:** a `GitHubError` of kind `unprocessable` becomes `Error("dish couldn't get a write token for <owner>/<repo>: <its message>. The dish App needs <Contents | Pull requests> read and write, and each installation must accept it (Settings → GitHub App)")`.
   - **Other errors** go through unchanged; they're masked and hold no token.
   - **Kept nowhere:** it touches no lock, no `OwnerState`, no file and no timer.
8. **`pushIsolated(request)`** (push.ts). It pushes from a bare repository of dish's own, so nothing in the clone's config (which agents can write between `checkClone` and the push) can steer the push or see the token. That covers `url.*.insteadOf`, `http.*`, `credential.*`, `remote.*`, the hooks and `push.*`.
   1. **The isolated repository:**
      - `mkdir(parent, { recursive: true, mode: 0o700 })`, then `dir = await mkdtemp(join(parent, 'push-'))`, which is 0700;
      - `<state>` is dish's, which agents can't write.
   2. **Its setup.** Each git below runs through `git()` with `env: { ...PUSH_ENV }` and `cwd: '/'`. Each failure throws a `GitError`, whose message is masked.
      - `gitOk(['init', '--bare', '--quiet', '--template=', `--object-format=${tip.length === 64 ? 'sha256' : 'sha1'}`, dir])`;
      - `writeFile(join(dir, 'objects', 'info', 'alternates'), `${clone}/.git/objects\n`, { flag: 'wx', mode: 0o600 })`;
      - `gitOk(['--git-dir', dir, 'update-ref', `refs/heads/${branch}`, tip])`. This needs the object, through the alternates.
   3. **The push:**
      - `git(pushArgs(dir, url, branch, pushHelperValue(helper, web)), { cwd: '/', env: { ...PUSH_ENV }, secret: token, timeoutMs: PUSH_TIMEOUT_MS, signal })`;
      - `pushArgs` throws unless `branch` matches `^dish/[a-z0-9][a-z0-9-]{0,39}$`;
      - it never passes `--force`, `+`, `--delete`, `--mirror`, `--all`, `--tags` or `--follow-tags`;
      - `-c credential.helper=` first drops any helper from any config (git's documented reset), so only dish's push helper is asked;
      - `http.followRedirects=false`, so a redirect is a failure, not a second host asking for the credential.
   4. **The outcome:**
      - `aborted` → an `Error` named `AbortError` ("the push of dish/<slug> was aborted");
      - `timedOut` → "the push of dish/<slug> timed out after 10 min";
      - exit 0 and the porcelain line `<flag>\trefs/heads/<b>:refs/heads/<b>\t<summary>` with flag `*` → `created`, ` ` → `updated`, `=` → `up-to-date`;
      - any other flag, or no such line → `Error(pushFailure(result, branch))`;
      - a non-zero exit → `Error(pushFailure(result, branch))`.
   5. **`pushFailure`:**
      - **The parts:** the `!` line's summary (`[rejected] (fetch first)`, `[remote rejected] (pre-receive hook declined)`), when there is one; then the first 5 `remote:` lines of stderr (prefix stripped, trimmed, non-empty) joined by a space; then, only without a `!` line, stderr's last `fatal:` or `error:` line.
      - **The message:** "GitHub refused the push of <branch>: " and those parts joined by " — ".
      - **The hint:** a summary with `fetch first` or `non-fast-forward` adds " The branch on GitHub has commits this one doesn't; dish never forces a push."
      - **Masking:** passed through `shown(text, 600)` (git.ts: masked with `maskSecrets` and `maskUrlPasswords`, no control characters, cut).
   6. **Clean-up:** `finally`: `rm(dir, { recursive: true, force: true })`, after success, failure or abort. The token isn't kept.
9. **`headOf(pathOrRef)`** (service.ts): `worktree = await this.resolve(pathOrRef)`.
   - `undefined` gives `undefined`.
   - Otherwise `this.#worktrees.head(worktree.clone, worktree.path)`: `checkWorktree`, then `commitOf(path, 'HEAD')`, which is `rev-parse --verify --quiet --end-of-options HEAD^{commit}`, `SHA`-checked.
10. **`isClean(pathOrRef)`** (service.ts): `resolve`; `undefined` rejects with "no worktree <pathOrRef, shown> that dish made".
    - `why = await this.#worktrees.dirty(worktree.clone, worktree.path, worktree.branch)`. It is `Worktrees.dirty` as today (`worktrees.ts:393`), with its branch: it is dirty when:
      - another branch, or a detached HEAD, is checked out;
      - `git status --porcelain` with untracked files is non-empty;
      - there's a nested worktree;
      - there's a nested repository.
    - `undefined` → `{ clean: true }`; else `{ clean: false, why }`.
11. **`pushBranch(name, slug, options)`** (service.ts):
    1. **Before the lock:**
       - closed → `stopped()`;
       - `project = await this.#registered(name)`;
       - not `ready` → "<project> isn't ready (<state>); see Settings → Projects";
       - `slug` not matching `SLUG` → "<slug> can't name a worktree …";
       - `options.head` missing or not a full sha (`SHA`) → "head must be a full commit id: the commit open_pr checked". There is no push without one.
    2. **Under `this.#locked(project, options.signal, …)`,** so a fetch, a sweep, a create or a removal of that project never runs at once:
       1. `worktree = await this.resolve(`${project.name}/${slug}`)`. `undefined` → "<project>/<slug> can't be pushed: <resolveProblem's reason>", or, without one, "no worktree <project>/<slug> that dish made; dish pushes only the dish/<slug> branch of a worktree it made".
       2. `tip = await this.#worktrees.tip(worktree.clone, worktree.branch)`. `undefined` → "its branch <branch> is gone".
       3. `tip !== options.head` → "<branch> is at <tip>, not <head> (the commit the checks ran on); nothing was pushed".
       4. `token = await this.#tokens.writeToken(project.owner, project.repo, PUSH_PERMISSIONS)`.
       5. `return pushIsolated({ clone: worktree.clone, branch: worktree.branch, tip, url: httpsUrl(this.#web, project.owner, project.repo), web: this.#web, helper: this.#pushHelper, parent: projectStateDir(this.#state, project.owner, project.repo), token, signal })`.
    3. **The answer:** `{ head: tip }`. The push is logged at info, "pushed <branch> of <project> at <tip, first 12> (<created | updated | up-to-date>)".
    4. `#pushHelper` is `realpath` of `../bin/git-credential-dish-push`, as `defaultHelper()` (`service.ts:205-207`).
    5. Nothing is logged with the token. A failure is thrown to the caller (open_pr), not logged here.
12. **`openPull(name, pull)`** (service.ts), with no lock:
    1. **The project:** closed → `stopped()`; `#registered`; `ready` as in 11.
    2. **The head:**
       - `pull.head` must match `^dish/([a-z0-9][a-z0-9-]{0,39})$`;
       - `this.resolve(`${project.name}/<slug>`)` must give a worktree whose `branch === pull.head`;
       - else "dish opens pull requests only from the dish/<slug> branch of a worktree it made".
    3. **The base:** `base = await defaultBranch(worktree.clone)`, from `clone.ts:747`. `undefined` → "dish doesn't know <project>'s default branch (origin/HEAD isn't set); the next fetch sets it".
    4. **The title:** `maskSecrets(maskUrlPasswords(pull.title)).replace(/[\s\x00-\x1f\x7f]+/g, ' ').trim()`.
       - Empty → "a pull request needs a title".
       - Over 256 characters (`Array.from`) → "the title is <n> characters; GitHub takes at most 256".
    5. **The body:** `maskSecrets(maskUrlPasswords(pull.body)).replace(/\x00/g, '')`. Over 65 536 characters → "the body is <n> characters; GitHub takes at most 65 536". The caller's override line is in it already, and is masked with it.
    6. **The token:** `token = await this.#tokens.writeToken(project.owner, project.repo, PULL_PERMISSIONS)`.
    7. **The pull request:**
       - `createPull(owner, repo, { title, head: pull.head, base, body }, token)` → `{ url, number, existing: false }`;
       - on `GitHubError` `unprocessable` (GitHub's 422, "A pull request already exists for <owner>:<branch>."): `findOpenPull(owner, repo, pull.head, token)`. Found → `{ url, number, existing: true }`, and nothing of it is changed: not its title, not its body; none → rethrow;
       - errors are rethrown as `Error("could not open the pull request for <head>: <message>")`.
    8. The token is dropped.
12a. **`commentPull(name, number, body)`** (service.ts), with no lock. For `open_pr` on a run whose pull request already existed: its override lines go there, since the body isn't edited.
    1. **The project:** closed → `stopped()`; `#registered`; `ready` as in 11.
    2. **The number:** a positive integer below 2³¹, else "a pull request number is a positive whole number".
    3. **The body:** `maskSecrets(maskUrlPasswords(body)).replace(/\x00/g, '')`. Blank → "a comment needs a body"; over 65 536 characters → "the comment is <n> characters; GitHub takes at most 65 536".
    4. **The token:** `writeToken(project.owner, project.repo, PULL_PERMISSIONS)`. GitHub lets a token with Pull requests write comment on a pull request's issue.
    5. **The comment:** `createComment(owner, repo, number, body, token)`: `POST /repos/{o}/{r}/issues/{number}/comments` with `{ body }`, through `#request` (so a failure reads as other calls' do, masked). Its errors are rethrown as `Error("could not comment on pull request #<n>: <message>")`.
    6. The token is dropped.
13. **The run hooks.** dish-orchestrator keeps runs; dish-workspaces tells it when the `worktree` tool makes or removes a worktree, and when the sweep removes one. It reads `dishRuns` with `ctx.get` on each use, and works as today without it: in the service, `#runs()` is `(this.#ctx as unknown as { get(name: string): unknown }).get('dishRuns') as RunsHooks | undefined`, as `#bindings` reads crew (`service.ts:817-821`); the tool gets the same read from index.ts.
    - **Never under a project's lock.** No hook is called, or awaited, while dish-workspaces holds a project's lock. `open_pr` holds a run's lock while it waits for `pushBranch`, which takes the project's lock; a hook awaited inside that lock and waiting for the run would deadlock. dish-orchestrator's hooks call no locking method of dish-workspaces either (`createWorktree`, `removeWorktree`, `pushBranch`, `sweep`, `prepare`, `onboard`); `resolve`, `resolveProblem`, `headOf`, `isClean`, `listWorktrees` and `describe` don't lock.
    - **`createWorktree`** doesn't change, but for `baseRef` in its result (`Worktrees.create` returns the record's `baseRef`). It calls no hook: `run open` makes its run's own worktree through it, and records that worktree itself.
    - **The tool's `create`** (14) calls `worktreeCreated` after `createWorktree` returned.
    - **The tool's `remove`** calls `await runs.worktreeRemoved(project, slug)` after `removeWorktree` returned. A throw is logged once by the tool (through the `warn` it is given, topic `runs <project>`), and the removal stands.
    - **The sweep:** `#fetchAndSweep` keeps `result.removed`. Once the `#locked` call that ran it has returned (in `sweep`, `#sweepLater` and `#runRound`), `#runsRemoved(result.removed)` calls `worktreeRemoved(item.project, item.slug)` for each, one after the other, tracked (`#track`) so `close` waits for it, never rejecting: a throw is logged once (topic `runs <project>`). It isn't awaited by the round or by `sweep`'s caller.
14. **The `worktree` tool** (tool.ts):
    - **`create`**, after `createWorktree` returned, with `runs()` there: `answer = await runs.worktreeCreated(String(exec.agent.id), { project, slug, branch, path, clone, base, baseRef })` from `created`. The session id is the main agent's `String(exec.agent.id)`, as crew's `delegate` takes it (`delegate.ts:819`). The call's signal isn't passed: the worktree exists whatever it does.
      - the answer is checked: `undefined` → no run; `{ id, opened }` with `id` a string matching `^[A-Za-z0-9._-]{1,100}$` → `run: { id, opened: opened === true }`; anything else → `runProblem: 'dish-orchestrator gave a malformed run'`;
      - a throw → `runProblem: shown(message, 300)`, logged once (topic `runs <project>`). The worktree stays.
      - Without `runs()`: no call, no field.
    - **`worktreeTool`'s second parameter** is optional, so 6b's tests that make the tool with one argument still work. It also takes a `warn` for the hooks' failures, in an options object: `worktreeTool(service, runs?, options?: { warn?(format: string, ...args: unknown[]): void })`. index.ts passes the plugin's logger.
    - **The output schema's `create` variant** gains `run: { type: 'object', additionalProperties: false, properties: { id: STRING, opened: BOOLEAN } }` and `runProblem: { type: 'string' }`, neither required.
    - **The answer's lines:** today's three, then one of:
      - opened: "Opened run `<id>` for this worktree; `run` with `action: goal` names it, and `open_pr` ends it." (the spec's);
      - joined: "It is task `<slug>` of run `<id>`, which this chat drives.";
      - `runProblem`: "dish couldn't add it to a run: <runProblem>."
    - **The description** gains, after the `create` sentence: "When dish keeps runs (dish-orchestrator), `create` also adds the worktree to the run this chat drives, or opens one; its answer says which."
15. **The App's permission texts:**
    - **`AppCard.tsx`'s intro** (`client/AppCard.tsx:33-37`) becomes: "dish reaches your repositories as a GitHub App. Agents' git clones and fetches with a read-only token, and dish reads pull requests to see which branches were merged. Only the main agent's open_pr pushes a run's branch and opens its pull request (or comments on it), with a write token dish mints in memory for that one push or request. Create the App on GitHub with read and write access to Contents and Pull requests, and read access to Metadata (no webhook), install it on the owners and repositories dish should work in, then give dish its ID and private key here. If the App was read-only before, each installation's owner accepts the new permissions on GitHub. Protect each repository's default branch with a ruleset (require a pull request with an approval, block force pushes and deletions, and never put the App on its bypass list), so nothing reaches it without your merge."
    - **`README.md`:**
      - **"## Credentials":**
        - a bullet after "dish's own API reads": **Write tokens**. `pushBranch` mints `contents: write`, and `openPull` and `commentPull` mint `pull_requests: write`, each with `metadata: read`, for the one repository and one call, in memory: never cached, and never in a file, an argument, the environment or a log. `createWriteToken` takes only those two sets and refuses a token GitHub granted more.
        - "**Read-only, enforced.**" becomes "**Agents' tokens are read-only, enforced**": `createToken` (the file token and the API token) still refuses anything but `read`.
      - **"### The push helper"**, after "### The helper": point 3, and the value `!/bin/sh '<checkout>/plugins/workspaces/bin/git-credential-dish-push' 'https://github.com'`.
      - **A new "## Pushes and pull requests"**, before "## The service":
        - `pushBranch`: points 8 and 11;
        - `openPull` and `commentPull`: points 12 and 12a;
        - `headOf` and `isClean`: points 9 and 10;
        - why the push runs from an isolated repository and the token goes through fd 3: point 1.
      - **"### The `worktree` tool":** the `create` row's answer gains the run sentence (14).
      - **"## The service":** the block gains the five methods, and `createWorktree`'s `baseRef`. The lock sentence: `pushBranch` runs under the project's lock; `headOf`, `isClean`, `openPull` and `commentPull` don't. Then a paragraph on `dishRuns`' hooks (13): who calls them, that none is called under a project's lock, and what they mustn't call.
      - **"## Settings → GitHub App":** the permissions (15).
      - **"## Decisions and known limits":**
        - decision 2 becomes: "**The App can push since step 7** (Contents and Pull requests read and write, Metadata read). Agents' git keeps read-only tokens. Only `pushBranch`, `openPull` and `commentPull`, which `open_pr` calls, mint a write token, in memory, for one call. An agent can read dsh's credential file, so it could mint one itself: GitHub rulesets on each default branch (require a pull request with an approval, block force pushes and deletions, the App never on the bypass list) keep anything from reaching it without your merge (the orchestrator spec's question 1, A)."
        - two known limits are added: a crash mid-push leaves `<state>/workspaces/<owner>/<repo>/push-<hex>/`, a small bare repository with no token in it, for you to remove; and a shallow clone (an adopted one) may fail to push from the isolated repository, with git's message. dish's own clones are full.

**Tests:**
- **The fakes, and the world's wiring:**
  - **`fake-github-api.ts`:**
    - `startFakeGitHub` takes `permissions?` (the App's). The default is today's read-only `APP_PERMISSIONS`, so 6b's tests are unchanged.
    - It exports `WRITE_APP_PERMISSIONS = { contents: 'write', metadata: 'read', pull_requests: 'write' }`.
    - `GET /app` answers the App's.
    - A token request is 422 unless each asked level is `read` or `write` and at most the App's and the installation's (`installation.permissions ?? the App's`), with `read` < `write`.
    - `POST /repos/{o}/{r}/pulls`:
      - the token must cover the repo (404) and have `pull_requests: 'write'` (403 "Resource not accessible by integration");
      - a missing title, head or base is 422 `Validation Failed` with an `errors` item;
      - an open pull with the same head in the repo is 422 `{ message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for <account>:<head>.' }] }`;
      - else 201 `{ number, html_url: 'https://github.com/<o>/<r>/pull/<n>', state: 'open', title, body, head: { ref, label }, base: { ref } }`, recorded in a new `pullRequests: FakePull[]`.
    - `GET /repos/{o}/{r}/pulls?head=…&state=…` lists the matches. The token must cover the repo and have `pull_requests`.
    - `POST /repos/{o}/{r}/issues/{n}/comments`: the token must cover the repo and have `pull_requests: 'write'` (403 otherwise); `n` must be a recorded pull of the repo (404); an empty `body` is 422; else 201 `{ id, html_url, body }`, recorded in a new `comments: FakeComment[]` (`{ repo, number, body }`).
  - **`fake-git-http.ts`:** `hold(service)` makes the next authorised request of that service, a `POST`, wait until `release()`. `reached` resolves when it arrives.
  - **`service-helpers.ts`:**
    - `startServiceWorld({ files?, write? })`: with `write: true` the fake App has `WRITE_APP_PERMISSIONS`;
    - `onToken` sets the git server's level by the token's `contents`: `'write'` → `'write'`, else `'read'`.
- **`git.test.ts`:**
  - `a secret goes to fd 3, which git's children inherit, and nowhere else`. A `!` alias copies `<&3` to a file: it holds the secret. The alias's `/proc/$$/environ` and `cmdline` don't, and `gitOk`'s failure message doesn't.
  - `a secret that isn't one line of printable ASCII is refused before git starts, and the refusal doesn't hold it`.
  - `without a secret, git's children have no fd 3`. The alias's `[ -e /proc/$$/fd/3 ]` fails.
  - The existing `git.ts is the only module of dish-workspaces that runs git` covers `push.ts`.
- **`helper.test.ts`:**
  - `the push helper answers get for its web origin with the line on fd 3, then quit=true, in every POSIX shell here`;
  - `the push helper: another origin, and an empty or closed fd 3, get quit=true alone; store, erase and anything else print nothing; it writes nothing` (a `listing` before and after);
  - `the push helper is POSIX sh, runs by path through /bin/sh without an exec bit, and passes shellcheck`;
  - `git credential fill with only the push helper gets the token from fd 3, and a second fill gets quit=true`.
- **`paths.test.ts`:** `pushHelperValue quotes the helper and the web origin, and refuses a ', a control character and a relative helper`.
- **`github.test.ts`:**
  - `createWriteToken asks for exactly PUSH_PERMISSIONS or PULL_PERMISSIONS for one repository; anything else throws before a request`;
  - `createWriteToken refuses a token GitHub granted more than asked, or for another repository`;
  - `createToken still refuses write` (kept as it is);
  - `createPull posts title, head, base and body with the token, and gives the number, URL and base`;
  - `findOpenPull asks for <owner>:<branch>, open, and gives the first with that head; none is undefined`;
  - `a 422 names GitHub's errors, masked and cut; a body without errors reads as before`.
- **`tokens.test.ts`:**
  - `writeToken mints a new token on each call for one repo with the asked permissions, and keeps nothing: no file, no cache, no timer`;
  - `writeToken refuses an owner it doesn't hold and a repo none of its projects has, before minting`;
  - `writeToken's 422 says what the App needs, and holds no token`.
- **`push.test.ts`** (unit):
  - `pushArgs: the helper reset then dish's push helper, no redirects, --porcelain, the URL, and refs/heads/dish/<slug>:refs/heads/dish/<slug>; never --force, + or a delete`;
  - `pushArgs refuses a branch that isn't dish/<slug> (main, dish/../x, +dish/x, dish/X)`;
  - `pushFailure: a porcelain rejection with remote: lines; a fetch first with dish's sentence; a 403's remote: and fatal: lines; masked (a ghs_ token, a URL password) and cut to 600`.
- **`publish.test.ts`** (`startServiceWorld({ write: true })`, a service onboarded and `ready`, `createWorktree('acme/widget', 'fix-1', …)`, commits made with the world's scratch git):
  - **`headOf`:**
    - `headOf gives the worktree's HEAD and follows a commit; undefined for a worktree dish didn't make`.
  - **`isClean`:**
    - `isClean: clean; a modified or untracked file is not, with why; another branch checked out is not; an unknown worktree rejects`.
  - **`pushBranch`, the push itself:**
    - `pushBranch pushes dish/fix-1 at its tip to the project's URL with a write token: the bare repository's branch is the tip, it gives { head: tip } and logs created; the git server saw level write for git-receive-pack, user x-access-token`;
    - `pushBranch again with nothing new logs up-to-date; after a commit, with the new head, it logs updated`;
    - `pushBranch with a head the branch isn't at refuses, and pushes nothing (the bare repository is unchanged)`;
    - `pushBranch without a head, or with a 12-digit one, refuses before a token is minted`;
    - `pushBranch refuses a project that isn't registered or ready, a slug dish didn't make, and a worktree whose clone fails dish's check (resolveProblem's reason)`.
  - **`pushBranch`, what can't steer it:**
    - `pushBranch never pushes to origin: a remote.origin.pushurl in the clone's config, and an insteadOf for the fake's origin in the global .gitconfig, change nothing`;
    - `the clone's own helper isn't used: its read token file is there, and the push still went with the write token`.
  - **`pushBranch`, refusals:**
    - `a rejected push fails with GitHub's reason: the branch moved on the bare repository (fetch first, dish never forces), and a pre-receive hook's refusal with its remote: lines`;
    - `an App without Contents write: the token request is 422, and the error says the App needs Contents read and write`.
  - **`pushBranch`, the token and the lock:**
    - `while the push is held at the fake, no process's cmdline or environ holds the write token; after it, no file under the world's directory does, and no log line does`. `/proc/*/cmdline` and `/proc/*/environ` are scanned; the token is the one the fake minted with `contents: 'write'` (`github.minted`).
    - `pushBranch runs under the project's lock: a createWorktree of the project waits for a held push; another project's doesn't`;
    - `no push-* directory is left after a success, a failure and close() mid-push (an AbortError)`.
  - **`openPull`:**
    - `openPull opens a pull request from dish/fix-1 to main with the title and body masked (a ghs_ token in each), and gives its URL and number`;
    - `openPull for a branch with an open pull request reports it, existing, opens no second one, and leaves its title and body as they were`;
    - `openPull refuses a head that isn't a dish worktree's branch, an empty title, a 257-character title and a 65 537-character body, before minting a token`;
    - `openPull with an App without Pull requests write fails with GitHub's message, and no token in it`.
  - **`commentPull`:**
    - `commentPull posts the body, masked (a ghs_ token in it), as a comment on the pull request's issue`;
    - `commentPull refuses a blank body, a 65 537-character body and a number that isn't a positive whole number, before minting a token`;
    - `commentPull on a pull request GitHub doesn't have fails with GitHub's message`.
- **`runs.test.ts`** (a `dishRuns` stub from a sibling plugin, via `provideStub`; the tool driven through the plugin, as `plugin.test.ts` does):
  - `the worktree tool's create asks worktreeCreated with the caller's session and the new worktree, baseRef included, and its answer gives the run`;
  - `worktreeCreated is called outside the project's lock: a hook that calls removeWorktree of another worktree of the same project (a test of the rule, not something dish-orchestrator does) finishes`;
  - `worktreeCreated that throws or answers malformed leaves the worktree and its record, logs once, and gives runProblem`;
  - `without dishRuns nothing is asked and there is no run or runProblem; createWorktree called directly (as run open does) asks nothing`;
  - `the tool's remove calls worktreeRemoved once, after the removal; a throw is logged once and the removal stands`;
  - `the sweep calls worktreeRemoved once per worktree it removed, after the project's lock is released: a hook held on a promise doesn't hold a createWorktree of the project`.
- **`tool.test.ts`:**
  - `create passes …` stays as it is: `createWorktree` gets no session;
  - new: `create asks the runs stub with String(exec.agent.id) ('sess-1') and the created worktree`;
  - new: `create's answer says the run it opened, or the task it joined, or why there is none; without a run, its text is today's`;
  - new: `remove tells the runs stub after the removal`;
  - `the output schema dsh accepts includes run and runProblem`.
- **`plugin.test.ts`:** `dishWorkspaces exposes headOf, isClean, pushBranch, openPull and commentPull, and they reach the service`.

**Steps:**
- [ ] Run `pnpm install --offline --frozen-lockfile` with `pnpm_config_store_dir` set.
- [ ] The fakes and the helper first: `fake-github-api.ts`, `fake-git-http.ts`, `service-helpers.ts`; `bin/git-credential-dish-push` and its tests.
- [ ] Failing tests, then the code, in this order:
  - `git.ts` and `paths.ts`;
  - `github.ts` and `tokens.ts`;
  - `push.ts`;
  - `worktrees.ts`, `service.ts` and `index.ts`;
  - `tool.ts`.
- [ ] `AppCard.tsx` and `README.md`. Run `pnpm --filter dish-workspaces build`: the client builds.
- [ ] Grep `plugins/workspaces/src` for `--force`, `'+refs`, `--delete` and `origin` in push.ts: none. Grep for `child_process` outside `git.ts` and `setup.ts`: none new.
- [ ] Run the gate: `pnpm typecheck && pnpm test`.
- [ ] Commit `dish-workspaces: headOf, isClean, pushBranch, openPull and commentPull with a write token in memory, and the run hooks on worktree`.

---

## Task 7: the run store and the ledger (`dish-orchestrator`)

**Needs:** Task 0.

**Files:**
- **Create:**
  - `plugins/orchestrator/src/text.ts`;
  - `src/paths.ts`;
  - `src/store.ts`;
  - `src/entries.ts`;
  - `src/ledger.ts`;
  - `src/derive.ts`.
- **Tests:**
  - `test/helpers.ts`;
  - `test/paths.test.ts`;
  - `test/store.test.ts`;
  - `test/ledger.test.ts`;
  - `test/derive.test.ts`.

**Interfaces:**
```ts
// text.ts: wording helpers the store, the ledger and the tools share
/** `undefined` for `''` or blanks, else trimmed: models fill every optional parameter (workspaces' `given`, tool.ts:107). */
export function given(value: string | undefined): string | undefined
/** Runs of whitespace, line breaks among them, folded into one space (crew's `oneLine`, delegate.ts:189). */
export function oneLine(text: string): string
/** At most `max` UTF-16 units, never ending in half a surrogate pair, with '…' when cut. */
export function cut(text: string, max: number): string
export const RULING_FORM = 'Ruling: what — why — cost if wrong'
/** Something with a letter or digit past a leading `Ruling:`, that isn't the placeholder (crew's `hasRuling` and `PLACEHOLDERS`, delegate.ts:179–200, copied). */
export function hasRuling(text: string): boolean
/** The ruling on one line, with a leading `Ruling:` (and Markdown marks around it) taken off. */
export function rulingBody(text: string): string
export function shortSha(sha: string): string            // the first 7 characters
export function shortSession(id: string): string         // the first 8, and '…' when longer
/** 'just now', '12 min ago', '5 h ago', '3 days ago', then the UTC date: the rule of workspaces' client `relativeTime` (format.ts:19). */
export function age(time: number, now: number): string

// paths.ts
export const SEGMENT: RegExp                              // /^[A-Za-z0-9._-]+$/, and not '.' or '..'
export const SLUG: RegExp                                 // /^[a-z0-9][a-z0-9-]{0,39}$/: dish-workspaces' rule (worktrees.ts:52), copied
export const RUN_ID: RegExp                               // /^[0-9]{8}-[a-z0-9][a-z0-9-]{0,49}$/
/** `owner/repo` split; throws TypeError unless both are a SEGMENT. */
export function splitProject(project: string): { owner: string, repo: string }
export function recordFile(state: string, project: string, id: string): string   // <state>/orchestrator/<owner>/<repo>/runs/<id>.json
export function ledgerFile(data: string, project: string, id: string): string    // <data>/ledgers/<owner>/<repo>/<id>.jsonl
/** Both throw TypeError for a project that fails splitProject or an id that isn't RUN_ID. */
export function runRef(project: string, id: string): string                      // `${owner}/${repo}/${id}`
export function parseRef(ref: unknown): { project: string, id: string } | undefined
/** `<yyyymmdd>-<slug>` (the UTC date of `at`), else `-2`, `-3`, … : the first that `taken` refuses. */
export function runId(slug: string, at: number, taken: (id: string) => boolean): string

// store.ts
export type RunState = 'open' | 'pr' | 'abandoned'
export const RUN_STATES: readonly RunState[]
export interface Run {
  id: string
  project: string                       // `owner/repo`, as projects.yaml writes it (dish-workspaces' `created.project`)
  slug: string
  goal: string                          // one line, masked, at most 300 characters
  plan?: { path: string, commit: string }
  branch: string                        // `dish/<slug>`
  worktree: string                      // absolute, canonical (createWorktree's `path`)
  base: string                          // the ref it was cut from: CreatedWorktree.baseRef (`origin/<default>`, or the base asked for)
  baseCommit: string
  state: RunState
  pr?: { url: string, number: number }  // kept when a run with a PR is reopened for review feedback (`run` `resume`): it is `open` again
  reason?: string                       // abandoned: why, one line, masked, at most 1000 characters
  driver: { session: string, since: number }   // session '' = released: nobody drives it; never live
  openedAt: number
  closedAt?: number                     // absent while open; a reopen removes it
}
export interface NewRun {
  project: string, slug: string, goal: string, branch: string, worktree: string, base: string, baseCommit: string
  plan?: { path: string, commit: string }
  driver: string                        // the session that opens it
  openedAt?: number
}
/** What is wrong with `value` as a Run, or undefined. */
export function runProblem(value: unknown): string | undefined
export class RunStore {
  constructor(state: string, options?: { onCorrupt?: (file: string, aside: string) => void, now?: () => number })
  /** Read every record once. Later calls give the same promise; a call after a failed one tries again. */
  load(): Promise<void>
  /** The rest read the copy load() made, and throw Error('the run store isn't loaded') before it. Each gives copies. */
  list(project?: string): Run[]                             // `project` compared without case; newest openedAt first
  get(project: string, id: string): Run | undefined
  byId(id: string): Run[]
  drivenBy(sessionId: string): Run | undefined
  /** Assign the id (`runId`) and write the record, through the project's queue. @throws TypeError for fields runProblem refuses. */
  create(fields: NewRun): Promise<Run>
  /** `change` gets a copy and returns the new run, or undefined for no change. Through the project's queue. @throws TypeError for a result runProblem refuses, or one with another id or project. */
  update(project: string, id: string, change: (run: Run) => Run | undefined): Promise<Run | undefined>
  flush(): Promise<void>
}

// entries.ts
export const HARNESS_KINDS = ['run.opened', 'run.resumed', 'run.takenOver', 'run.plan', 'run.goal', 'task.opened', 'task.removed',
  'child.started', 'child.ended', 'gate.result', 'review.verdict', 'ladder.refused', 'ladder.ruled', 'pr.checked', 'pr.opened',
  'pr.updated', 'run.closed'] as const
export const MAIN_KINDS = ['ruling', 'deferred', 'note'] as const
export type HarnessKind = typeof HARNESS_KINDS[number]
export type MainKind = typeof MAIN_KINDS[number]
export type Kind = HarnessKind | MainKind
interface Base<K extends Kind, B extends 'harness' | 'main'> {
  at: number, run: string /* the run's id */, kind: K, by: B
  session?: string, child?: string, task?: string
  cut?: true                            // set by the ledger on a line it had to cut to fit
}
/** The header's StructuredReport, as the ledger keeps it (Task 8 checks crew's type against it at compile time). */
export interface LedgerCoderReport { role: 'coder', turn: number, at: number, status: 'done' | 'blocked' | 'needs_context', summary: string,
  commits?: string[], blockedOn?: string, rulings?: { what: string, why: string, costIfWrong: string }[], concerns?: string[],
  notFixed?: { finding: string, why: string }[] }
export interface LedgerReviewerReport { role: 'reviewer', turn: number, at: number, verdict: 'approved' | 'changes_requested', head: string,
  summary: string, findings: { severity: 'blocking' | 'should_fix' | 'nit', file: string, line?: number, summary: string, fix: string }[],
  checks?: { command: string, exitCode: number, summary: string }[], addressed?: { finding: string, addressed: boolean, evidence: string }[] }
export type LedgerReport = LedgerCoderReport | LedgerReviewerReport
export interface RunOpened extends Base<'run.opened', 'harness'> { goal: string, branch: string, worktree: string, base: string, baseCommit: string, plan?: { path: string, commit: string }, how: 'run' | 'auto' }
export interface RunResumed extends Base<'run.resumed', 'harness'> { driver: string, previous?: string, reopened?: true /* it was in state pr */ }
export interface RunTakenOver extends Base<'run.takenOver', 'harness'> { driver: string, previous: string }
export interface RunPlan extends Base<'run.plan', 'harness'> { path: string, commit: string }
export interface RunGoal extends Base<'run.goal', 'harness'> { goal: string }
export interface TaskOpened extends Base<'task.opened', 'harness'> { task: string, path: string, branch: string, base: string, baseCommit: string }
export interface TaskRemoved extends Base<'task.removed', 'harness'> { task: string }
export interface ChildStarted extends Base<'child.started', 'harness'> { child: string, role: string, title: string, model: string, family: string,
  followUp: boolean, round?: number /* coders with a task */, reviews?: string, final?: true }
export interface ChildEnded extends Base<'child.ended', 'harness'> { child: string, role: string, stopReason: string, error?: string,
  reportFile: string /* crew's RunRecord.report, the .md */, structuredFile?: string /* RunRecord.structuredFile */, report?: LedgerReport /* RunRecord.structured */, head: string | null }
export interface GateResultEntry extends Base<'gate.result', 'harness'> { child: string, outcome: 'passed' | 'failed' | 'skipped' | 'error',
  exitCode: number | null, timedOut: boolean, durationMs: number, log: string | null, head: string | null, gateTurn: number, gateRound: number, reason?: string }
export interface ReviewVerdict extends Base<'review.verdict', 'harness'> { child: string, verdict: 'approved' | 'changes_requested', head: string,
  final: boolean, findings: { blocking: number, should_fix: number, nit: number } }
export interface LadderRefused extends Base<'ladder.refused', 'harness'> { task: string, round: number }
export interface LadderRuled extends Base<'ladder.ruled', 'harness'> { task: string, round: number, ruling: string }
export interface PrGate { outcome: string, exitCode: number | null, timedOut: boolean, durationMs: number, log: string | null, head: string | null, reason?: string }
export interface PrFinal { child: string, verdict: string, head: string, at: number }
export interface PrChecked extends Base<'pr.checked', 'harness'> { head: string, gate: PrGate | null, final: PrFinal | null, gateOk: boolean,
  reviewOk: boolean, overrides: { gate?: string, review?: string }, result: 'pass' | 'refused', refused?: string[] }
export interface PrOpened extends Base<'pr.opened', 'harness'> { url: string, number: number, head: string, branch: string }
/** open_pr pushed to a pull request that was already open (openPull's `existing`): its title and body weren't changed. */
export interface PrUpdated extends Base<'pr.updated', 'harness'> { url: string, number: number, head: string, branch: string,
  comment?: 'posted' | 'failed', commentError?: string /* the override lines, posted as a comment (commentPull) */ }
export interface RunClosed extends Base<'run.closed', 'harness'> { state: 'pr' | 'abandoned', reason?: string, pr?: { url: string, number: number } }
export interface RulingEntry extends Base<'ruling', 'main'> { what: string, why: string, costIfWrong: string }
export interface DeferredEntry extends Base<'deferred', 'main'> { what: string, where: string, why: string }
export interface NoteEntry extends Base<'note', 'main'> { text: string }
export type HarnessEntry = RunOpened | RunResumed | RunTakenOver | RunPlan | RunGoal | TaskOpened | TaskRemoved | ChildStarted | ChildEnded
  | GateResultEntry | ReviewVerdict | LadderRefused | LadderRuled | PrChecked | PrOpened | PrUpdated | RunClosed
export type MainEntry = RulingEntry | DeferredEntry | NoteEntry
export type LedgerEntry = HarnessEntry | MainEntry
/** For writing: base fields, a known kind, and `by` the kind's writer ('harness' for HARNESS_KINDS, 'main' for MAIN_KINDS). */
export function entryProblem(value: unknown): string | undefined
/** For reading back: base fields only (any kind string, `by` harness or main); other fields are derive's to check. */
export function lineProblem(value: unknown): string | undefined

// ledger.ts
export const MAX_LINE_BYTES = 16 * 1024          // with the newline
export const DEFAULT_LIMIT = 200
export const MAX_LIMIT = 500
export interface LedgerPage { entries: LedgerEntry[] /* newest first */, next?: string, skipped: number }
export class Ledger {
  constructor(data: string)
  file(project: string, id: string): string                                    // ledgerFile(data, …)
  /** Append in order, masked and cut to fit; gives what was written. @throws TypeError (entryProblem), RangeError (can't fit); nothing of the call is written then. */
  append(project: string, id: string, entries: LedgerEntry | readonly LedgerEntry[]): Promise<LedgerEntry[]>
  /**
   * In the file's queue: `build` gets `current()` (the file's entries now, oldest first, read directly) and returns what to
   * append. For a decision that rests on what is in the file (a round). Never call `entries`/`read` inside `build`: they wait for this queue.
   */
  appendWith(project: string, id: string, build: (current: () => Promise<LedgerEntry[]>) => Promise<readonly LedgerEntry[]>): Promise<LedgerEntry[]>
  /** Every entry, oldest first, once what is queued for the file now is written. A missing file has none. */
  entries(project: string, id: string): Promise<{ entries: LedgerEntry[], skipped: number }>
  /** A page, newest first (judge's `read`, for one file). @throws RangeError for a limit outside 1–500 or a `before` that isn't a cursor. */
  read(project: string, id: string, query?: { limit?: number, before?: string }): Promise<LedgerPage>
  flush(): Promise<void>
}

// derive.ts: everything here is a pure function of a run and its entries
export interface GateView { child: string, outcome: string, exitCode: number | null, head: string | null, at: number, log: string | null }
export interface VerdictView { child: string, verdict: 'approved' | 'changes_requested', head: string, final: boolean, at: number,
  findings: { blocking: number, should_fix: number, nit: number } }
export interface TaskView {
  task: string                          // its slug
  own: boolean                          // the run's own worktree
  path?: string
  removed: boolean
  rounds: number                        // coder starts and follow-ups on it so far: the index the next one gets
  coder?: { child: string, at: number, ended: boolean, stopReason?: string, status?: 'done' | 'blocked' | 'needs_context', summary?: string }
  gate?: GateView                       // its latest
  verdict?: VerdictView                 // its latest
}
export interface RulingView { at: number, by: 'harness' | 'main', source: 'ruling' | 'ladder' | 'pr', text: string, task?: string }
export interface RunSummary {
  tasks: TaskView[]                     // the run's own first, then by task.opened
  finalReview?: VerdictView             // the latest review.verdict with final
  rulings: RulingView[]                 // oldest first
  deferred: Array<{ at: number, what: string, where: string, why: string }>
  notes: Array<{ at: number, text: string }>
  pr?: { checked?: { at: number, head: string, result: 'pass' | 'refused' }, opened?: { at: number, url: string, number: number, head: string },
    updated?: { at: number, url: string, number: number, head: string } }   // each the newest of its kind
}
/** The index the next coder start or follow-up on `task` gets: how many `child.started` with role coder and that task there are. */
export function nextRound(entries: readonly LedgerEntry[], task: string): number
/** The task of `child` in this ledger: its newest child.started's. */
export function taskOfChild(entries: readonly LedgerEntry[], child: string): string | undefined
/** The tasks not removed, slug → path: the run's own worktree (run.slug → run.worktree), then each task.opened without a later task.removed. */
export function openTasks(run: Run, entries: readonly LedgerEntry[]): Map<string, string>
export function latestFinal(entries: readonly LedgerEntry[]): VerdictView | undefined
/** The newest gate.result whose head is `head` (sameHead). */
export function gateAt(entries: readonly LedgerEntry[], head: string): GateView | undefined
/** Both hex shas, 7 to 64 characters: equal without case, or the shorter is a prefix of the longer. */
export function sameHead(a: unknown, b: unknown): boolean
export function summarize(run: Run, entries: readonly LedgerEntry[]): RunSummary
```

**Behavior:**

1. **Paths.**
   - Every part of a path is checked here, not trusted from a caller: owner, repo and slug are each one `SEGMENT`, and an id is a `RUN_ID`.
   - `recordFile` and `ledgerFile` throw `TypeError` for anything else. A slug is checked with `SLUG`, which is stricter than `SEGMENT`.
   - The global constraint's check lives in this module, and orchestrator imports no runtime code from dish-workspaces.
2. **Records (`RunStore`).**
   - **`load`** reads `<state>/orchestrator/<owner>/<repo>/runs/*.json`, one level at a time, with `readdir({ withFileTypes: true })`.
     - It skips what isn't a directory (a link isn't followed), what isn't a `SEGMENT`, and files not named `<RUN_ID>.json`.
     - Each file is opened `O_RDONLY | O_NOFOLLOW`.
   - **`runProblem`'s state rules:** `state` is one of `RUN_STATES`; `pr` is required with `pr`, and allowed with `open` and `abandoned` (a run reopened for review feedback keeps it, and so does one abandoned after that); `reason` only with `abandoned`; `closedAt` with `pr` and `abandoned`, never with `open`; `driver.session` a string (`''` is released) and `driver.since` a number.
   - **A corrupt record:** one that doesn't parse, that `runProblem` refuses, or whose `project` and `id` aren't those of its place.
     - It is renamed `<file>.corrupt-<ms>`, and `onCorrupt(file, aside)` is told.
     - Nothing is removed, and temp files are left alone.
   - **Writes** use crew's `writeAtomic` and `syncDirectory` (record.ts:423–458), copied: a temp file in the same directory, `wx` and 0600, synced, renamed, then the directory synced. Directories are made 0700.
   - Each project has one promise queue (crew's `#serial`, record.ts:498).
   - **`create`, inside the project's queue:**
     - list the `runs` directory;
     - `runId(slug, openedAt, id => cached or listed)`;
     - write;
     - cache.
   - **Masking.** `create` and `update` mask `goal` and `reason`, fold them to one line, and cut them to 300 and 1000 characters. They mask `plan.path` too.
   - **`drivenBy('')`** is `undefined`. Otherwise it is the open run with that `driver.session`; when more than one has it (another process wrote), the newest `driver.since` wins.
   - Nothing in the store deletes a record.
3. **The ledger's writes** follow `JudgeLog.write` (log.ts:441–487) for one file:
   - **Validation, then masking.** `entryProblem` runs, then every string value, at any depth, goes through `maskSecrets` (keys are left alone), then the line is fitted.
   - **The fit**, deterministic:
     1. If the JSON and its newline are within `MAX_LINE_BYTES`, it is written as it is.
     2. Otherwise the line gets `cut: true`. The longest string anywhere outside the base fields is cut to `max(64, half its length)` characters, plus `…`, and the line is measured again. This repeats while it is too long and some such string is over 64.
     3. Then the longest array outside the base fields loses its last element, repeatedly.
     4. If it still doesn't fit, `RangeError`, and nothing of the call is written.
     - The base fields (`at`, `run`, `kind`, `by`, `session`, `child`, `task`) are never cut.
   - **One promise queue per file** (`#serial`, log.ts:414). The lines of one call go in one `appendFile` of all of them.
     - The flags are `O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW`, mode 0600.
     - On `ENOENT` it runs `mkdir(dirname, { recursive: true, mode: 0o700 })`, then appends again.
   - **The torn-line guard** (`endsMidLine`, log.ts:376). On the first append to a file in this process, and the first after an append to it failed, a newline goes first if the file doesn't end with one.
   - **`ledger.ts` imports only `appendFile`, `mkdir` and `open`** from `node:fs/promises`. It never removes, renames, truncates or rewrites a file. No prune.
4. **The ledger's reads.**
   - `entries` and `read` first wait for the file's queue, then go through `linesBackward` (log.ts:325–373, copied): a link or a missing file has no lines.
   - A line that isn't JSON, fails `lineProblem`, or is over 1 MB is skipped and counted in `skipped`.
   - **`read`'s cursor** is `base64url(String(offset))` of the oldest line returned. `next` is there only when an older line exists.
   - **Limits:** `limit` must be a whole number from 1 to 500, and defaults to 200.
5. **Derivations.**
   - Every field past the base ones is read with a type check. An entry whose fields don't fit is passed over by that derivation, and never throws.
   - **`summarize`:**
     - `tasks`: from `openTasks`, plus removed tasks marked `removed`;
     - `rounds`: `nextRound`;
     - `coder`: the newest coder `child.started` on the task, and its `child.ended` if there is one, with `status` and `summary` from a coder report;
     - `gate` and `verdict`: the newest `gate.result` and `review.verdict` for the task;
     - `pr`: the newest `pr.checked`, `pr.opened` and `pr.updated`.
   - **`rulings`:**
     - main `ruling` entries (`text`: `what — why — cost if wrong`, source `ruling`);
     - `ladder.ruled` (`text`: the ruling, source `ladder`);
     - each override of a `pr.checked` (`text`: `gate: <ruling>` or `review: <ruling>`, source `pr`).

**Tests:**
- **text:**
  - `given`: `''`, blanks, a value;
  - `oneLine`;
  - `cut`, including an emoji at the cut;
  - `hasRuling`: `Ruling:` alone, the placeholder, `**Ruling:** x — y — z`;
  - `rulingBody`;
  - `age` at each boundary.
- **paths:**
  - the two files;
  - refused: `..`, `.`, `a/b/c` as a project, an owner with `/`, a bad id;
  - `runRef` and `parseRef`, both ways;
  - `parseRef` of junk;
  - `runId`: the date in UTC near midnight, `-2`, `-3`.
- **store:**
  - `create`, then `get`, `list`, `byId` and `drivenBy`;
  - a reload on the same directory gives the same;
  - the modes: files 0600, directories 0700;
  - two `create`s of one slug on one day, at once, give `…-<slug>` and `…-<slug>-2`;
  - `update`: no change, a change, and a result `runProblem` refuses (a `TypeError`, and the file is untouched byte for byte);
  - a corrupt file is set aside, `onCorrupt` is told, and the other runs load;
  - a link in place of a record isn't followed;
  - a goal holding `ghs_…` is stored masked;
  - `drivenBy` of `''`, of a released run, and of a closed run is `undefined`;
  - the state rules: a reopened run (`open` with `pr`, no `closedAt`) is valid; `pr` without `pr`, `open` with `closedAt`, and `reason` on a `pr` run are refused;
  - a call before `load` throws.
- **ledger:**
  - append and read back;
  - every kind with its `by`;
  - `entryProblem` refuses `by: 'main'` with `gate.result`, and `by: 'harness'` with `note`;
  - masking: a token in a nested `report.findings[].fix` is masked;
  - the cut:
    - a 40 KiB `summary` is cut, the line is at most 16 KiB with `cut: true`, and its base fields are intact;
    - 2,000 findings drop items until it fits;
    - huge base fields give a `RangeError`, and nothing is written;
  - modes 0600 and 0700;
  - a link at the file's place isn't written through (ELOOP), and its target is untouched;
  - torn-line recovery: the file ends mid-line, a new `Ledger` appends, and the torn line is skipped while the next line reads;
  - `appendWith` sees the entries of an append queued before it, and two `appendWith` calls at once each count the other's in order;
  - `read`: pages newest first, `next`, the end, a `before` that isn't a cursor, and limits 0 and 501;
  - `entries` waits for queued writes;
  - append-only: a source scan of `src/ledger.ts` finds no `unlink`, `rm(`, `rename`, `truncate`, `writeFile` or `copyFile`, and its fs imports are exactly `appendFile`, `mkdir` and `open`.
- **derive:**
  - `nextRound` counts coder starts and follow-ups on the task only, not reviewers or other tasks;
  - `taskOfChild`;
  - `openTasks` drops a removed task;
  - `latestFinal`;
  - `gateAt`;
  - `sameHead`: full against full, a 7-character prefix, 6 characters (false), non-hex (false), different (false);
  - `summarize`, over a hand-built ledger of every kind (`pr.updated` and a reopening `run.resumed` among them), gives the documented views;
  - malformed fields (`round: 'x'`, `findings: null`) are passed over without a throw.

**Steps:**
- [ ] Failing tests first: the list above.
- [ ] Implement.
- [ ] Run the gate.
- [ ] Commit `dish-orchestrator: the run store and the ledger`.

---

## Task 8: `dishRuns` and the harness's ledger entries (`dish-orchestrator`)

**Needs:** Tasks 1 (the crew events, `ChildRecord`'s tags, `RunRecord.structured` and `GateResult.head`), 5 (`dish-gates/result` and `runAt`'s type), 6 (`resolve`, `headOf` and the reader types) and 7.

**Files:**
- **Create:**
  - `src/locks.ts`;
  - `src/services.ts`;
  - `src/service.ts`;
  - `src/runs.ts`;
  - `src/listeners.ts`.
- **Replace** `src/index.ts`.
- **Create these stubs,** which Tasks 9, 10 and 11 replace whole:
  - `src/run-tool.ts`, whose `runTool` returns `undefined`;
  - `src/open-pr.ts`, whose `openPrTool` returns `undefined`;
  - `src/remote.ts`, whose `runsRemote` does nothing.
- **Tests:**
  - `test/service-helpers.ts`, which Tasks 9 and 10 read and don't change;
  - `test/runs.test.ts`;
  - `test/listeners.test.ts`;
  - `test/plugin.test.ts`.

**Interfaces:**
```ts
// locks.ts: dish-workspaces' KeyedLock (locks.ts:8–37), copied
export class KeyedLock { run<T>(key: string, job: () => Promise<T>): Promise<T>; busy(key: string): boolean }

// services.ts: the other plugins' services, read with ctx.get on each use, their types by `import type`
import type { DishCrew } from 'dish-crew'
import type { DishGates } from 'dish-gates'
import type { DishProjects } from 'dish-projects'
import type { DishWorkspaces } from 'dish-workspaces'
export type WorkspacesReader = Pick<DishWorkspaces, 'createWorktree' | 'resolve' | 'resolveProblem' | 'headOf' | 'isClean' | 'pushBranch' | 'openPull' | 'commentPull'>
export type CrewReader = Pick<DishCrew, 'records' | 'worktreeBindings'>
export type GatesReader = Pick<DishGates, 'runAt'>
export type ProjectsReader = Pick<DishProjects, 'get'>
export interface AgentsReader { get(id: string): unknown }      // dsh's registry (`ctx.agents`); `isRunning`'s LiveAgents, record.ts:209
export interface Services {
  workspaces(): WorkspacesReader | undefined
  crew(): CrewReader | undefined
  gates(): GatesReader | undefined
  projects(): ProjectsReader | undefined
  agents(): AgentsReader | undefined
}

// service.ts: the dishRuns service. crew and dish-workspaces read it structurally, with local copies of these types
export interface RunInfo {
  ref: string                           // `<owner>/<repo>/<id>`: what a child is tagged with; run ids are unique only in a project
  id: string, project: string, slug: string, goal: string, branch: string, worktree: string
  state: 'open' | 'pr' | 'abandoned'
}
export interface PlaceTarget {
  worktree?: string                     // a bound child's worktree: its canonical path (as crew records it) or `<owner>/<repo>/<slug>`
  reviews?: string                      // a reviewer's: a child id, or 'main'
  final?: boolean                       // a reviewer started, or followed up, with `final: true`
}
export interface Placement {
  run: string                           // the run's ref: crew stores it as ChildRecord.run
  task?: string                         // the task's slug: ChildRecord.task
  round?: number                        // given with `task`: the index a coder start or follow-up on it gets now (the first start is 0)
  final?: true                          // a reviewer placed in a run, asked for with `final`: ChildRecord.final
}
export interface LadderEntry {
  sessionId: string
  run: string                           // Placement.run
  task: string
  round: number
  outcome: 'refused' | 'ruled'
  ruling?: string                       // for 'ruled': the ruling, as given
  child?: string                        // a follow-up's target
}
/** What the `worktree` tool gives worktreeCreated: Task 6's `CreatedForRun`, field for field. */
export interface CreatedForRun {
  project: string, slug: string, branch: string, path: string, clone: string
  base: string                          // the commit (CreatedWorktree.base)
  baseRef: string                       // the ref it was cut from (CreatedWorktree.baseRef)
}
export interface JoinedRun {
  id: string                            // the run's id
  opened: boolean                       // true: a run was opened around the worktree; false: it joined the run this chat drives
}
export interface DishRuns {
  /** The open run `sessionId` drives, or undefined. Never rejects. */
  driving(sessionId: string): Promise<RunInfo | undefined>
  /** Where a child `delegate` is starting or following up belongs. undefined when it belongs to no open run. Never rejects (a failure is logged, and gives undefined). */
  place(sessionId: string, target: PlaceTarget): Promise<Placement | undefined>
  /** The `worktree` tool made a worktree: it joins the run the session drives in that project, or a run is opened around it. Never rejects. */
  worktreeCreated(sessionId: string, created: CreatedForRun): Promise<JoinedRun | undefined>
  /** dish-workspaces removed a worktree (the tool, or the sweep): `task.removed` in each open or `pr` run of the project that has it as a task. Never rejects, and takes no lock. */
  worktreeRemoved(project: string, slug: string): Promise<void>
  /** `delegate` refused round 5+ on a task, or let it through on a ruling. Never rejects. */
  ladder(entry: LadderEntry): Promise<void>
}
declare module '@deepseek-ai/cordis' { interface Context { dishRuns: DishRuns } }
export function dishRunsOf(runs: Runs): DishRuns          // exactly the five methods

// runs.ts: the core; Tasks 9 and 10 use the rest of it
export interface Logger { info(format: string, ...args: unknown[]): void, warn(format: string, ...args: unknown[]): void }
export interface RunsDeps { store: RunStore, ledger: Ledger, services: Services, now: () => number, logger: Logger }
export interface ToolDeps { runs: Runs, services: Services }
type Input<E> = E extends unknown ? Omit<E, 'at' | 'run' | 'by'> : never
export type HarnessInput = Input<HarnessEntry>
export type MainInput = Input<MainEntry>
export class Runs {
  constructor(deps: RunsDeps)
  readonly store: RunStore
  readonly ledger: Ledger
  readonly services: Services
  ready(): Promise<void>                                     // store.load(); logged once on failure
  refOf(run: Run): string
  byRef(ref: string): Run | undefined                        // after ready
  /** Its driver is not '' and dsh's agent registry has an agent with that id. No registry: false. */
  live(run: Run): boolean
  // the DishRuns five, as in service.ts
  driving(sessionId: string): Promise<RunInfo | undefined>
  place(sessionId: string, target: PlaceTarget): Promise<Placement | undefined>
  worktreeCreated(sessionId: string, created: CreatedForRun): Promise<JoinedRun | undefined>
  worktreeRemoved(project: string, slug: string): Promise<void>
  ladder(entry: LadderEntry): Promise<void>
  // for the tools: the lock-free ones are called holding the locks named
  withSession<T>(sessionId: string, job: () => Promise<T>): Promise<T>
  withRun<T>(run: Run, job: () => Promise<T>): Promise<T>   // keyed by ref; always taken after the session's, never before
  /** Holding the session's lock: write the record (driver = the session), `run.opened`, and release the session's other open run. */
  openAround(sessionId: string, worktree: CreatedForRun, options: { goal: string, plan?: { path: string, commit: string }, how: 'run' | 'auto' }): Promise<{ run: Run, released?: Run }>
  /** Holding the session's lock (it takes the run's): the resume rules, and a `pr` run's reopening; @throws Error with the refusal's words. */
  drive(sessionId: string, run: Run, options: { takeover: boolean }): Promise<{ run: Run, how: 'already' | 'resumed' | 'takenOver' | 'reopened', previous?: string, released?: Run }>
  /** Holding the run's lock. Each returns the record as written. */
  setGoal(run: Run, sessionId: string, goal: string): Promise<Run>
  attachPlan(run: Run, sessionId: string, plan: { path: string, commit: string }): Promise<Run>
  /** `state`, `pr` or `reason`, `closedAt`, and the driver released (`''`); then `run.closed`. */
  close(run: Run, sessionId: string, end: { state: 'abandoned', reason: string } | { state: 'pr', pr: { url: string, number: number } }): Promise<Run>
  /** Append one entry: `by: 'harness'` (a harness kind only) or `by: 'main'` (ruling, deferred, note only), `at` now, `run` the id. @throws TypeError for a kind of the other writer. */
  harness(run: Run, entry: HarnessInput): Promise<void>
  main(run: Run, sessionId: string, entry: MainInput): Promise<void>
  entries(run: Run): Promise<LedgerEntry[]>
  summary(run: Run): Promise<RunSummary>
}
/**
 * The caller of a main-agent tool: `String(exec.agent.id)` when `isTopLevelAgent(exec.agent)` and it is non-empty, else
 * undefined. The same id crew's `delegate` takes as its session (`delegate.ts:819`), the worktree tool passes to
 * worktreeCreated, and dsh's agent registry is keyed by. `run` and `open_pr` both use it.
 */
export function mainSession(exec: { agent?: unknown }): string | undefined

// listeners.ts
export interface Delegated { sessionId: string, child: ChildRecord, followUp: boolean }          // `dish-crew/delegated`'s payload (Task 1)
export interface Settled { sessionId: string, child: ChildRecord, run: CrewRunRecord }            // `dish-crew/settled`'s (crew's RunRecord)
export interface GateFinished { childId: string, sessionId: string, result: GateResult }          // `dish-gates/result`'s (Task 5)
export function startedEntry(run: Run, e: Delegated, round: number | undefined, at: number): ChildStarted
export function endedEntries(run: Run, e: Settled, head: string | null, at: number): Array<ChildEnded | ReviewVerdict>
export function gateEntry(run: Run, e: GateFinished, task: string | undefined, at: number): GateResultEntry
/** The three listeners. Each returns undefined at once, and never throws. */
export function createListeners(runs: Runs): { delegated(e: Delegated): void, settled(e: Settled): void, gateResult(e: GateFinished): void }
// compile-time: crew's report is the ledger's, member by member (judge's Same/Check, remote.ts:57–72)
export type ReportMatchesLedger = [
  Check<Same<Extract<StructuredReport, { role: 'coder' }>, LedgerCoderReport>>,
  Check<Same<Extract<StructuredReport, { role: 'reviewer' }>, LedgerReviewerReport>>,
]

// index.ts
export const name = 'dish-orchestrator'
export interface Config { terminal: boolean }
export const Config: Schema<Config>                 // terminal: boolean, default true, "Print this plugin's messages to the terminal."
export interface OrchestratorInternals { state?: string, data?: string, now?: () => number }   // tests only; never config
export function apply(ctx: Context, config: Config): void
export function start(ctx: Context, config: Config, internals: OrchestratorInternals): Runs
export type { CreatedForRun, DishRuns, JoinedRun, LadderEntry, Placement, PlaceTarget, RunInfo } from './service.ts'
export type { Run, RunState } from './store.ts'
export type { Kind, LedgerEntry } from './entries.ts'

// the stubs, with the signatures the later tasks keep
export function runTool(deps: ToolDeps): ToolDefinition | undefined      // run-tool.ts (Task 9)
export function openPrTool(deps: ToolDeps): ToolDefinition | undefined   // open-pr.ts (Task 10)
export interface RemoteOptions { store: RunStore, ledger: Ledger, live(run: Run): boolean }
export function runsRemote(ctx: Context, options: RemoteOptions): void   // remote.ts (Task 11)
```

**Behavior:**

1. **The plugin** (`start`) is synchronous and awaits nothing:
   1. **Logs.** It logs as `dish-orchestrator`, with `printOwnLogs` when `terminal` is on.
   2. **The directories.** `state` and `data` are `xdgPaths('dish').state` and `.data`, unless the internals give them.
   3. **The core.** It makes `RunStore(state, { onCorrupt: warn })` and `Ledger(data)`. `Services` reads `ctx.get('dishWorkspaces')`, `'dishCrew'`, `'dishGates'`, `'dishProjects'` and `'agents'` on each use. Then it makes `runs = new Runs(...)`, and calls `void runs.ready()`.
   4. **The listeners.**
      - `const l = createListeners(runs)`;
      - `ctx.on('dish-crew/delegated', e => { l.delegated(e) })`;
      - `ctx.on('dish-crew/settled', e => { l.settled(e) })`;
      - `ctx.on('dish-gates/result', e => { l.gateResult(e) })`.
      - They hear crew's and gates' `ctx.parallel`, as dish-workspaces hears `dish-projects/changed` (projects index.ts:72–84).
   5. **The service.** `ctx.provide('dishRuns', dishRunsOf(runs))`.
   6. **The tools.** `ctx.inject(['tools'], inner => { … })` registers each of `runTool(deps)` and `openPrTool(deps)` that is defined, as workspaces registers `worktree` (index.ts:111–113).
   7. **The remote.** `runsRemote(ctx, { store, ledger, live: run => runs.live(run) })`.
   8. **Shutdown.** `ctx.effect(() => async () => { await ledger.flush(); await store.flush() })`.
2. **`ready`.** The first call starts `store.load()`, and every call returns that promise. A rejection is logged once and forgotten, so the next call tries again. The public methods wait for it, catch, log once per distinct message (at most 100 kept), and give `undefined`.
3. **`driving(sessionId)`** is `store.drivenBy(sessionId)` as a `RunInfo`.
4. **`place(sessionId, target)`.** It takes no lock and calls no locking method of another plugin: crew calls it inside its session lock (Task 4).
   1. **A bound child** (`worktree` given, through `given()`) is placed in the run that owns its worktree, whichever chat drives it.
      - `resolved = await services.workspaces()?.resolve(worktree)` (lock-free; a rejection is `undefined`). With it, the candidates are the open runs of `resolved.project`, compared without case. Without it, every open run.
      - For each candidate, newest `openedAt` first: `entries(run)` (which waits for the file's queue, rule 11), then `openTasks(run, entries)`. The first whose map holds the worktree gives the run and the task. The worktree is held when a path equals its `realpath` (or the path as given, when that fails), or, for the form `<owner>/<repo>/<slug>`, when the slug is a key and the project is the run's.
      - No run owns it: as in 3.
   2. **A reviewer** (`reviews` given, not `'main'`) is placed where the child it reviews was.
      - The reviewed child's tags come from the child index (rule 11), or on a miss from `crew()?.records.lookup(reviews)`: `record.run` and `record.task` (a rejection is a miss).
      - The ref is an open run (`byRef`) whose `openTasks` still has the task: that run and task. The ref is an open run and the task is gone: that run, with no task.
      - Otherwise: as in 3.
   3. **Otherwise** (an unbound child, `reviews: 'main'`, or nothing found above): `store.drivenBy(sessionId)`, with no task. With none, `undefined`.
   4. **`round`:** with a task, `nextRound(entries, task)` over that run's entries, read after its queue. No `round` without a task.
   5. **`final: true`** only when `target.final === true`, `reviews` is given, and a run was found.
   6. It gives `{ run: refOf(run), task?, round?, final? }`.
   - **A takeover doesn't mix two chats' children.** A follow-up from the chat that lost a run, to its coder bound to one of the run's tasks, is placed in that run and counts on that task. An unbound child goes to the run its own chat drives.
5. **`worktreeCreated(sessionId, created)`.** The `worktree` tool calls it after `createWorktree` returned, outside dish-workspaces' project lock (Task 6). `run open` makes its own worktree with `createWorktree`, which calls no hook, and records it itself (Task 9).
   1. **Checks.** `splitProject(created.project)`; `SLUG.test(created.slug)`; `created.branch === 'dish/' + slug`; an absolute `path`; a non-empty `base` and `baseRef`. A failure logs, and gives `undefined`.
   2. Under `withSession(sessionId)`, with `run = store.drivenBy(sessionId)`:
      - **A run in this project** (compared without case): `harness(run, { kind: 'task.opened', session, task: slug, path, branch, base: baseRef, baseCommit: base })`. It gives `{ id: run.id, opened: false }`.
      - **Otherwise:** `openAround(sessionId, created, { goal: created.slug, how: 'auto' })`. It gives `{ id, opened: true }`. A run it released is logged at info: "released run <old id> of <project>: this chat opened run <id> in <project>".
   - The `worktree` tool words its answer from `opened` (Task 6).
6. **`openAround`:**
   1. `previous = store.drivenBy(sessionId)`.
   2. `run = store.create({ project, slug, goal, branch, worktree: path, base: baseRef, baseCommit: base, plan, driver: sessionId, openedAt: now })`.
   3. `harness(run, { kind: 'run.opened', session, goal, branch, worktree, base, baseCommit, plan?, how })`. A failure of this append is logged: the record already stands.
   4. When `previous` is there, its driver becomes `{ session: '', since: now }`, through `store.update`, and only if it is still this session's.
   - The record comes before the ledger, because the record decides who drives.
7. **`worktreeRemoved(project, slug)`.** For each open or `pr` run of the project (compared without case) where `openTasks` has `slug`: `harness(run, { kind: 'task.removed', task: slug })`. It goes through the ledger's queue only, and takes no session or run lock: the sweep calls it, and `open_pr` holds a run's lock while it waits for the project's (Task 6). There is no session: the sweep knows none.
8. **`ladder(entry)`:**
   - `byRef(entry.run)`, an unknown ref, a `task` that isn't a SLUG, and a `round` that isn't a whole number ≥ 0 are each logged and dropped.
   - `refused` → `harness(run, { kind: 'ladder.refused', session, child?, task, round })`.
   - `ruled` → `harness(run, { kind: 'ladder.ruled', session, child?, task, round, ruling: cut(rulingBody(ruling), 1000) })`.
9. **`drive(sessionId, run, { takeover })`.** Under `withRun`, with a fresh copy of the record:
   1. **Abandoned:** `Error("run `<id>` was abandoned (<reason>). Open a new run with `run` `open`.")`.
   2. **A run with a PR (`state: 'pr'`) is reopened,** for review feedback on its pull request:
      - Its worktree must still be one dish made. No dish-workspaces → `Error("dish-workspaces isn't running, so run `<id>`'s worktree can't be checked")`. `resolve(run.worktree)` gives `undefined` → `Error("run `<id>` can't be reopened: its worktree is gone (the sweep removes it once its pull request <url> is merged). Open a new run with `run` `open`.")`.
      - The record: `state: 'open'`, `pr` kept, `closedAt` removed, driver `{ session: sessionId, since: now }`.
      - The entry: `run.resumed { driver, previous?, reopened: true }`, with `previous` the old driver when it wasn't `''`. `how: 'reopened'`.
      - `open_pr` then pushes to the same pull request (Task 10).
   3. **The caller drives it:** `how: 'already'`, with no entry.
   4. **`old = driver.session`.** It is live (`live`), and there is no `takeover`: `Error("run `<id>` is driven by another chat that is still open (session <shortSession>). Give `takeover: true` to drive it from here; that chat then drives nothing.")`.
   5. **Otherwise,** the driver becomes `{ session: sessionId, since: now }`:
      - a live old driver (a takeover) → `run.takenOver { driver, previous: old }`;
      - anything else → `run.resumed { driver, previous: old || omitted }`.
   6. **The caller's other run.** The open run the caller drove before, if it isn't this one, is released (rule 6.4) and returned as `released`.
10. **`close(run, sessionId, end)`,** under `withRun`: the record first (`state`, `pr` replacing any earlier one, or `reason`; `closedAt` now; the driver released, `{ session: '', since: now }`), then `run.closed { session, state, reason? | pr? }`. A closed run's chat drives nothing.
11. **The listeners.**
    - **The order.** Each one queues its ledger write before it returns:
      - its synchronous part reads the in-memory store and calls `ledger.appendWith` directly;
      - everything slow (`headOf`, crew's `lookup`) runs inside `build`;
      - nothing is awaited between `await ready()` and the `appendWith` call.
    - **Why it holds.** cordis' `parallel` calls listeners synchronously (`EventsService.parallel`, cordis lib/index.js:271–274), and `place` waits for the file's queue. crew awaits its publish inside `delegate`'s session lock (Task 1), so a start it published is counted by the next `place` for that task.
    - Each listener returns `undefined` at once, so a producer that awaits its publish never waits for git.
    - **`delegated(e)`:**
      - `e.child.run` is missing → ignored.
      - `byRef` is unknown → ignored, logged once per ref.
      - The child goes in the child index, kept on `Runs` so `place` reads it for a reviewer: `childId → { ref, task, sessionId }`, the oldest out past 1000.
      - In `build`: `round = role === 'coder' && task ? nextRound(current, task) : undefined`. It appends `startedEntry`:
        - `session`: `e.sessionId`;
        - `child`, `task?`, `role`, `title`, `model`, `family`;
        - `followUp`, `round?`;
        - `reviews?`, and `final?` when the child has it.
    - **`settled(e)`:**
      - an untagged child or an unknown run is ignored;
      - in `build`, `path = e.child.worktree ?? openTasks(run, current).get(e.child.task)`, and `head = path ? await workspaces?.headOf(path) ?? null : null` (a rejection is `null`);
      - it appends `endedEntries`.
    - **`endedEntries`:**
      - `child.ended`:
        - `session`, `child`, `task?`, `role`;
        - `stopReason`, `error?`;
        - `reportFile: run.report` (the `.md`), `structuredFile?: run.structuredFile`;
        - `report?: run.structured`, as a copy;
        - `head`.
      - And, when the structured report is a reviewer's, `review.verdict`:
        - `session`, `child`, `task?`;
        - `verdict`, `head: report.head`;
        - `final: child.final === true`;
        - `findings`: the counts by severity.
    - **`gateResult(e)`:**
      - The tags come from the index.
      - On a miss (a restart): in a promise of its own, `crew()?.records.lookup(e.childId)`, then the same path.
      - An untagged child is ignored.
      - It appends `gateEntry`:
        - `session: e.sessionId`, `child`, `task?`;
        - `outcome`, `exitCode`, `timedOut`, `durationMs`, `log`;
        - `head: result.head ?? null`;
        - `gateTurn: result.turn`, `gateRound: result.round`;
        - `reason?`.
    - **Failures.** A throw or rejection anywhere is logged once per distinct message, masked, and never rethrown.
12. **Who writes each kind.** A `by: 'harness'` entry is never built from a tool's `kind` or `by`. Only `Runs.harness` makes harness entries, and only `Runs.main` main ones (`entryProblem` again in the ledger).

    | Kind | Written by | From |
    |---|---|---|
    | `run.opened` | `openAround` | `run open` (Task 9, `how: 'run'`), or `worktreeCreated` (`how: 'auto'`) |
    | `run.resumed`, `run.takenOver` | `drive` | `run resume` (Task 9), a reopening included |
    | `run.goal`, `run.plan` | `setGoal`, `attachPlan` | `run goal`, `run plan` (Task 9) |
    | `task.opened` | `worktreeCreated` | dish-workspaces' `worktree` tool, after `create` (Task 6) |
    | `task.removed` | `worktreeRemoved` | the `worktree` tool's `remove`, and the sweep (Task 6) |
    | `child.started` | the `delegated` listener | `dish-crew/delegated` (Tasks 1, 4) |
    | `child.ended`, `review.verdict` | the `settled` listener | `dish-crew/settled` (Task 1) |
    | `gate.result` | the `gateResult` listener | `dish-gates/result` (Task 5) |
    | `ladder.refused`, `ladder.ruled` | `ladder` | crew's `delegate` (Task 4) |
    | `pr.checked`, `pr.opened`, `pr.updated` | `harness` | `open_pr` (Task 10) |
    | `run.closed` | `close` | `run abandon` (Task 9), `open_pr` (Task 10) |
    | `ruling`, `deferred`, `note` (`by: 'main'`) | `main` | `run ruling`, `defer`, `note` (Task 9) |

**Tests** (`test/service-helpers.ts`):
- **`world(options?)`:**
  - a temp `state` and `data`, a `Runs` over them, and a fixed clock;
  - stub services, each a plain object recording its calls:
    - `workspaces`: `createWorktree`, `resolve` (a map from path or ref to a worktree), `resolveProblem`, `headOf` (a map from path to sha), `isClean`, `pushBranch`, `openPull`, `commentPull`;
    - `crew`: `records.lookup`, `worktreeBindings`;
    - `gates`: `runAt`;
    - `projects`: `get`;
    - `agents`: a `Set` of live ids;
  - `worktree(slug)`: a real directory under the temp dir, for `realpath`.
- **`mainExec(sessionId, cwd)`** and **`childExec()`:** `ToolRunContext`s as `workspaces/test/tool.test.ts` makes them (line 21); the main agent's `id` is `sessionId`.
- **`delegated(...)`, `settled(...)` and `gateDone(...)`:** payload builders.

**`runs.test.ts`:**
- **`driving`:** none; after `openAround`; released; a closed run; after a reload on the same directories.
- **`place`:**
  - no run → `undefined`;
  - the run's own worktree by path → its slug, round 0;
  - by `owner/repo/slug`; by a link to the worktree (realpath);
  - after a coder's start and a follow-up on the task → round 2; a reviewer's start on it doesn't count;
  - a `task.opened` worktree → that task; after `task.removed` → the session's run, no task;
  - a worktree no run owns → the session's run, no task, no `round`;
  - **the run that owns it:** a worktree that is a task of run R, which another chat drives (a takeover), placed for the chat that lost R → R, the task and its round; for a chat that drives no run → the same;
  - two open runs in two projects: the worktree's project narrows the search (`resolve`), and without dish-workspaces the path still finds it;
  - `reviews: 'main'` → the session's run, no task;
  - `reviews` of a child of the run (from the child index, and after a restart through crew's `lookup`) → its run, task and that task's round;
  - an unknown child → the session's run, no task;
  - `final` given back only with `reviews` and a run;
  - an unbound child → the session's run, no task;
  - an I/O failure (an unreadable ledger) → `undefined`, logged once.
- **The order:** a `delegated` for a coder emitted with `ctx.parallel`, then `place` with no await between → round 1.
- **`worktreeCreated`:**
  - a run in the project → `task.opened` with `base: baseRef` and `baseCommit`, and `{ id, opened: false }`;
  - no run → a run opened: its record (slug, branch, worktree, base = baseRef, baseCommit, goal = slug, driver), `run.opened` with `how: 'auto'`, and `{ id, opened: true }`;
  - a run in another project → it is released (`driver.session === ''`, logged) and a new one opened;
  - malformed input (a bad slug, a branch that isn't `dish/<slug>`, a relative path, no `baseRef`) → `undefined`, and nothing written;
  - two at once in one session → one run, and one `task.opened`.
- **`worktreeRemoved`:**
  - a task → `task.removed`;
  - the run's own → `task.removed`, and in a `pr` run too (the sweep after a merge);
  - an unknown slug, an abandoned run and another project → nothing;
  - it takes no lock: it completes while a `withRun` job on the run is held.
- **`ladder`:**
  - refused, and ruled (the ruling folded, `Ruling:` taken off, a token masked);
  - an unknown ref → nothing, logged.
- **`drive`:**
  - by the driver → `'already'`, no entry;
  - the driver not live → `run.resumed` with `previous`;
  - released → `run.resumed` without `previous`;
  - live → the refusal's words;
  - live with `takeover` → `run.takenOver`;
  - `takeover` when not live → `run.resumed`;
  - an abandoned run → refused;
  - a `pr` run whose worktree resolves → reopened: `open`, `pr` kept, no `closedAt`, the caller drives it, `run.resumed` with `reopened: true`;
  - a `pr` run whose worktree is gone, and one with no dish-workspaces → refused with each text, and the record unchanged;
  - the caller's other run is released.
- **`harness`** with `note` → `TypeError`; **`main`** with `gate.result` → `TypeError`.
- **`setGoal`, `attachPlan` and `close`:** the record and the entries; `close` releases the driver, and a second `close` with `pr` replaces the record's `pr`.

**`listeners.test.ts`:**
- **`child.started`:**
  - for a start and a follow-up;
  - a coder with a task (its round);
  - a reviewer with `reviews` and `final`, and its follow-up still `final` (sticky on the record);
  - an untagged child and an unknown ref → nothing (logged once for two events).
- **`child.ended`:**
  - stop reason, error, `reportFile` and `structuredFile`, the structured report (`run.structured`) copied, and the head of `child.worktree`;
  - a reviewer's head from its task's path;
  - `headOf` rejecting → `null`;
  - no structured report → none.
- **`review.verdict`:** the counts, and `final` true and false. A coder's report makes none.
- **`gate.result`:** from the index; after a restart, through crew's `lookup`; an untagged child → nothing.
- **Masking:** a `ghs_…` in a coder's summary is masked in the ledger.
- **`by`:** every entry the listeners write is `'harness'`.
- **Failures:** an append that fails (the ledger's directory replaced by a file) is logged, and the listener returns.

**`plugin.test.ts`,** in a `Context` with stub siblings (a `provideStub` as in `gates/test/plugin.test.ts:84–89`) and dsh's `ToolRuntime` with a `systemPrompt` stub (`workspaces/test/plugin.test.ts:58–64`):
- `dishRuns` is provided, with exactly the five methods.
- **The events,** emitted with `ctx.parallel`: `dish-crew/delegated`, `dish-crew/settled` and `dish-gates/result` each land in the ledger.
- **With dish-crew's real host plugin** (records in a temp directory):
  - a child added with `run` and `task` tags;
  - `subagent/end` emitted;
  - → `child.ended` in the ledger. This pins Task 1's publish.
- **Defaults:** with `DSH_DISH_HOME=<tmp>/inst`, records go under `<tmp>/inst/state/dish/orchestrator`, and ledgers under `<tmp>/inst/data/dish/ledgers`.
- **Retention:** a record and a ledger with an mtime two years old are untouched after start, and still listed.
- **The tools** register once `tools` is there; the stubs register nothing.
- `terminal: false` prints nothing. After dispose, `dishRuns` is gone.
- **Source scans:**
  - no `child_process` anywhere under `plugins/orchestrator/src`;
  - `'ledgers'` appears only in `src/paths.ts`.

**Steps:**
- [ ] Failing tests first: the lists above.
- [ ] Implement.
- [ ] Run the gate.
- [ ] Commit `dish-orchestrator: dishRuns and the harness's ledger entries`.

---

## Task 9: the `run` tool (`dish-orchestrator`)

**Needs:** Task 8.

**Files:**
- **Replace** `src/run-tool.ts`.
- **Create** `src/status.ts`.
- **Tests:** `test/run-tool.test.ts` and `test/status.test.ts`.

**Interfaces:**
```ts
// run-tool.ts
export const MAIN_ONLY = 'the run tool is for the main agent only'
export const NO_RUN = 'This chat drives no run: `run` `open` one (making a worktree opens one too), or `resume` one; `run` `list` shows the open runs.'
export const ACTIONS = ['open', 'resume', 'goal', 'plan', 'abandon', 'status', 'list', 'ruling', 'defer', 'note'] as const
export function runTool(deps: ToolDeps): ToolDefinition
/** A path in the repo for `plan`: relative, no `..` segment, no NUL or backslash, at most 300 characters, and a regular file inside the worktree once real paths are taken. Gives the normalized path, or why not. */
export function planProblem(worktree: string, path: string): Promise<{ ok: true, path: string } | { ok: false, why: string }>

// status.ts
export interface StatusContext {
  caller: string, now: number
  head?: string, clean?: { clean: true } | { clean: false, why: string }, headProblem?: string   // the run's worktree now (headOf, isClean)
  gateAtHead?: GateView                                  // derive's gateAt(entries, head)
}
export function statusText(run: Run, summary: RunSummary, context: StatusContext): string
/** `open`: the open runs; `withPr`: the runs in state `pr`, newest closedAt first, which `resume` can reopen. */
export function listText(open: readonly Run[], withPr: readonly Run[], context: { caller: string, now: number, live(run: Run): boolean, project?: string }): string
```

**Parameters** (each optional unless the action needs it; `''` and blanks are absent, through `given`):

| Name | Type | Description (as the model sees it) |
|---|---|---|
| `action` | enum `ACTIONS`, required | "What to do; see the tool's description." |
| `project` | string | "open: the project, `owner/repo` as in projects.yaml. list: leave empty for every project." |
| `slug` | string | "open: the run's name, 1 to 40 of a-z, 0-9 and \"-\". Its branch is `dish/<slug>`, and it names the run's own worktree." |
| `goal` | string | "open, goal: what the change is for, in one line." |
| `plan` | string | "open (optional), plan: the plan's path in the repo, such as `docs/plans/2026-10-03-x.md`." |
| `base` | string | "open (optional): what to cut the run's branch from (a branch, tag or commit). Leave empty for the default branch." |
| `id` | string | "resume: the run's id as `list` shows it, or `owner/repo/<id>`. A run with a pull request reopens, for review feedback on it." |
| `takeover` | boolean | "resume only: drive the run even though another chat that is still open drives it. That chat then drives nothing." |
| `reason` | string | "abandon: why, in one line." |
| `what` | string | "ruling: the call you made. defer: the finding you leave for later." |
| `why` | string | "ruling, defer: why." |
| `costIfWrong` | string | "ruling: what it costs if the call is wrong." |
| `where` | string | "defer: the file, function or area." |
| `task` | string | "ruling (optional): the slug of the task it is about." |
| `text` | string | "note: one line to a few." |

**Description:** "Runs: every change that ends in a pull request is a run, with its own branch `dish/<slug>` and a ledger the harness keeps. The project owns it, and one chat drives it at a time (main agent only).
- `open` (`project`, `slug`, `goal`, optional `plan` and `base`) makes the run's worktree and drives it. While you drive a run, every worktree you make in its project with `worktree` is one of its tasks. The first worktree a chat makes without a run opens one around it.
- `resume` (`id`, optional `takeover`) drives an open run again: after a compaction, a restart, or from another chat. A run whose pull request is open reopens: fix what its review asks, and `open_pr` pushes to that same pull request.
- `goal`, `plan` (a path in the repo, recorded with its commit) and `abandon` (`reason`) change the run you drive.
- `status` reads where it stands from its ledger: tasks and rounds, the last gate and verdict of each, the final review, the rulings and deferred findings, and what `open_pr` would find now. Read it after a compaction.
- `list` (optional `project`) shows the open runs and who drives them.
- `ruling` (`what`, `why`, `costIfWrong`, optional `task`), `defer` (`what`, `where`, `why`) and `note` (`text`) add your own entries to the ledger. Delegations, endings, gates, verdicts and the PR are recorded by the harness itself.
- `open_pr` ends a run with a pull request."

**Output schema:** `{ type: 'object', additionalProperties: false, properties: { action: STRING, run: STRING, text: STRING } }`.
- `run` is the id, or `''`.
- `render` gives `[{ type: 'text', text }]`.

**Behavior,** in this order for every call:
1. **The caller.**
   - `session = mainSession(exec)` (Task 8: `String(exec.agent.id)` of a top-level agent, the id crew's `delegate` and the `worktree` tool use). `undefined` → `Error(MAIN_ONLY)`.
   - Then `await runs.ready()`.
2. **`open`:**
   1. **The arguments.**
      - `project` and `slug` are required: "`project` is required for open: `owner/repo` as in projects.yaml", and "`slug` is required for open: 1 to 40 of a-z, 0-9 and \"-\"". A slug that fails `SLUG` gets the second.
      - `goal` is required: "`goal` is required for open: what the change is for, in one line". It is folded, masked and cut to 300.
      - `splitProject(project)` refuses: "… isn't a project name: `owner/repo`".
   2. **The services.**
      - No dishWorkspaces: "dish-workspaces isn't running, so the run's worktree can't be made".
      - `projects()?.get(project)` gives `undefined`: "<project> isn't in projects.yaml".
   3. **The worktree.** Under `withSession`:
      - `created = await workspaces.createWorktree(project, slug, given(base), { cwd: exec.agent.session.header.cwd, signal: exec.signal })`. It calls no hook (Task 6), so the run is recorded once, below.
      - Its refusal passes through as an `Error` with its message (already masked by dish-workspaces).
   4. **The plan.** With `plan`: `planProblem(created.path, plan)`.
      - OK → `{ path, commit: created.base }`.
      - Otherwise there is no plan, and the answer says "Plan not attached: <why>. Attach it with `run` `plan` once it is in the run's branch."
   5. **The run.** `openAround(session, { project: created.project, slug, branch: created.branch, path: created.path, clone: created.clone, base: created.base, baseRef: created.baseRef }, { goal, plan?, how: 'run' })`.
   6. **The answer:**
      ```
      Opened run `<id>` (<project>): <goal>
      Its worktree is <path>, on branch dish/<slug>, cut from <baseRef> (<base7>).
      [Plan: <path> at <commit7>. | Plan not attached: …]
      This chat drives it. Worktrees you make in <project> while you drive it are its tasks; bind a coder to the run's own worktree with delegate's `worktree`: <project>/<slug>. `open_pr` ends the run.
      <the worktree tool's setup sentence for `created.setup` (workspaces tool.ts:162–164, the same words)>
      [Released run `<old>`: it stays open, and `run` `resume` takes it back.]
      ```
3. **`resume`:**
   1. `id` is required: "`id` is required for resume: the run's id, as `run` `list` shows it".
   2. **The run:**
      - `owner/repo/id` → `parseRef`, then `store.get`;
      - a bare id → `store.byId(id)`: none → "no run `<id>`: `run` `list` shows the open ones"; more than one → "`<id>` names runs in several projects (<a>, <b>): give `owner/repo/<id>`".
   3. Under `withSession`: `drive(session, run, { takeover: args.takeover === true })`. Its `Error` passes through.
   4. **The answer:** "Resumed run `<id>` (<project>): <goal>." Then:
      - "You already drive it.";
      - or "Its driver (session <s>) wasn't live.";
      - or "Nobody drove it.";
      - or "Took it over from session <s>, which now drives nothing."
      - For a reopened run, in place of those: "Reopened run `<id>` (<project>) for review feedback: its pull request #<n> (<url>) stays open. Fix what the review asks in rounds, as before; then `open_pr` runs the same checks and pushes the new head to that pull request."
      - Then, when a run was released: " Released run `<old>`."
      - Then: "Read `run` `status` for where it stands; open tasks continue with fresh children, and their rounds carry over."
4. **`goal`, `plan`, `abandon`, `status`, `ruling`, `defer` and `note`** need `run = store.drivenBy(session)`, or `Error(NO_RUN)`. The writes go under `withSession` then `withRun`, and inside, the run is read again: it must still be open and this chat's, or `NO_RUN`.
   - **`goal`:**
     - required, folded, cut to 300;
     - `setGoal` → `run.goal`;
     - "Run `<id>`'s goal is now: <goal>."
   - **`plan`:**
     - required;
     - `planProblem(run.worktree, plan)`: refused with "plan <path>: <why>";
     - `commit = await workspaces.headOf(run.worktree)`: `undefined` or a rejection → "can't read the run's head: <message>";
     - `attachPlan` → `run.plan`;
     - "Attached plan <path> at <commit7> to run `<id>`." When `isClean` gives `{ clean: false, why }`, it adds: " The worktree isn't clean (<why>), so <commit7> may not hold the plan as it is now: commit it, then attach it again." A rejection of `isClean` adds nothing.
   - **`abandon`:**
     - `reason` required, folded, cut to 1000;
     - `close(run, session, { state: 'abandoned', reason })` → the record (`state`, `reason`, `closedAt`) and `run.closed { state: 'abandoned', reason }`;
     - "Abandoned run `<id>`: <reason>. Its worktrees are left as they are: remove them with `worktree` `remove` (with `force` if unmerged). This chat drives no run now."
   - **`ruling`:**
     - `what`, `why` and `costIfWrong` each required, folded, cut to 500: "`what`, `why` and `costIfWrong` are required for ruling";
     - `task`, when given, must be a task in `summarize`'s tasks: "task `<t>` isn't one of run `<id>`'s tasks (<list>)";
     - `main(run, session, { kind: 'ruling', what, why, costIfWrong, task? })`;
     - "Recorded your ruling in run `<id>`[ on task `<t>`]."
   - **`defer`:**
     - `what`, `where` and `why` required, folded, cut to 500;
     - `main(…, { kind: 'deferred', … })`;
     - "Recorded the deferred finding in run `<id>`."
   - **`note`:**
     - `text` required; line breaks kept, runs of blank lines folded to one; cut to 2000;
     - `main(…, { kind: 'note', text })`;
     - "Noted in run `<id>`."
   - **`status`:**
     - `entries`, then `summarize`;
     - `head = await headOf(run.worktree)` and `clean = await isClean(run.worktree)` (`{ clean: true }` or `{ clean: false, why }`), each in a try: a failure is `headProblem`;
     - `gateAtHead = head ? gateAt(entries, head) : undefined`;
     - `statusText(...)`.
     - Read only, so no locks.
   - **`list`:** `listText(open, withPr, …)` over `store.list(given(project))`: the open runs, and those in state `pr`. It needs no run of its own.
   - When the session drives no run, `status` gives `NO_RUN`, then a blank line, then `listText` of all runs.
5. **Masking.** Every `text` the tool returns goes through `maskSecrets` once more. A thrown `Error`'s message is masked too.
6. **`statusText`** gives these lines, in order:
   1. "Run `<id>` (<project>): <goal>"
   2. "Branch dish/<slug> in <worktree>, cut from <base> (<baseCommit7>); opened <age>; this chat drives it."
   3. "Plan: <path> at <commit7>." or "No plan: the run is one task, in its own worktree."
   4. "Tasks:", then one line per task:
      - "- <task>[ (the run's own worktree)][ (removed)]: "
      - then "no coder yet", or "coder round <rounds-1> (child <c>, <running | ended <stopReason>[, reported <status>]>)";
      - then "; gate <outcome> at <head7> (<age>)", or "; no gate result";
      - then "; review <verdict>[ (final)] at <head7>" when there is one.
   5. "Final review:", then one of:
      - "approved <h7> (child <c>, <age>)", then "; that is the head now." or "; the head is now <h7>, so `open_pr` needs a new final review or `reviewRuling`.";
      - "changes requested at <h7> (child <c>).";
      - "none yet: `delegate` a reviewer with `final: true`."
   6. "Rulings:" with the newest 20, each "- [<task>: ]<text> (<harness|you>, <age>)", then "(and N older)". Omitted when there are none.
   7. "Deferred:" the same way, each "- <what> (<where>): <why>".
   8. "Notes:" with the newest 5.
   9. "`open_pr` now:", then one of:
      - "head <h7>, clean";
      - "head <h7>, not clean: <why> (it refuses until that's fixed)";
      - "the head can't be read: <problem>".
      Then "the gate runs on that head when you call it[ (the last result at this head: <outcome>, <age>)]", then:
      - "the final review approved this head";
      - or "no final review approved this head (give `reviewRuling` to open past it)".
10. **`listText`.** "Open runs[ in <project>]:", then one line per run:
    - "- <project> `<id>`: <goal>, opened <age>; " followed by one of:
      - "this chat drives it";
      - "driven by another chat (session <s>, still open)";
      - "driven by session <s>, which isn't live (`run` `resume` takes it)";
      - "nobody drives it (`run` `resume` takes it)".
    - At most 50 lines, then "(and N more)".
    - With none: "No open runs[ in <project>]."
    - Then, when there are runs in state `pr`: a blank line, "With a pull request (`run` `resume` reopens one for review feedback):", and the newest 10 by `closedAt`, each "- <project> `<id>`: <goal>, PR #<n> <url>, <age>", then "(and N older)".

**Tests** (`run-tool.test.ts`, over Task 8's `world` with `runTool(deps).execute(args, exec)`, and one call through dsh's `ToolRuntime` to check the parameter schema):
- **The caller:**
  - a crew child (`delegationDepth: 1`, `origin: 'subagent'`) and an agent with no id → `MAIN_ONLY`, for every action;
  - nothing is read or written.
- **`open`:**
  - the record and `run.opened` (`how: 'run'`, `base`, `baseCommit`), and the answer's lines;
  - with a plan that exists → attached at the base commit;
  - with a plan that is missing, outside the worktree (`../x`), absolute, or a link to `/etc/passwd` → the run opens without it, and the answer says why;
  - `createWorktree` refusing → its message, and no record;
  - missing `project`, `slug` or `goal`, a bad slug, and an unknown project → each refusal;
  - no dish-workspaces → refused;
  - opening a second run releases the first;
  - `createWorktree` is called with the chat's `cwd` and the call's signal;
  - the run is recorded once: one `run.opened` and no `task.opened`, since `createWorktree` calls no hook.
- **`resume`:**
  - every branch of Task 8's `drive`, through the tool's words, a reopened run's included;
  - a bare id; `owner/repo/id`; an unknown id; an id in two projects;
  - "one run per chat": resuming B releases A.
- **`goal`, `plan` and `abandon`:**
  - the entries and the record;
  - `abandon` leaves the chat driving nothing;
  - after it, `goal` → `NO_RUN`.
- **`ruling`, `defer` and `note`:**
  - `by: 'main'`, with the session;
  - a missing field → refused;
  - an unknown task → refused with the list;
  - a token in `why` → masked in the ledger;
  - a `note` of 5,000 characters → cut;
  - no argument can choose a kind or `by`: extra arguments such as `kind: 'gate.result'` or `by: 'harness'` are ignored, and the entry is `note` by `main`.
- **`status`:**
  - with no run → `NO_RUN` and the list;
  - with a run → `statusText` (the head and clean from the stubs);
  - `headOf` rejecting → `headProblem` in the text.
- **`list`:** for a project, for all, the four driver wordings, and the runs with a pull request after the open ones.

**`status.test.ts`:**
- `statusText` over hand-made summaries: each task line form; the three final-review forms (with the head matching and stale); rulings past 20; the three `open_pr now` forms;
- `listText`, including 51 open runs, and 11 runs with a pull request (the newest 10, then "(and 1 older)").

**Steps:**
- [ ] Failing tests first: the lists above.
- [ ] Implement.
- [ ] Run the gate.
- [ ] Commit `dish-orchestrator: the run tool`.

---

## Task 10: `open_pr` (`dish-orchestrator`)

**Needs:** Tasks 5 (`runAt`), 6 (`headOf`, `isClean`, `pushBranch`, `openPull`, `commentPull`) and 8.

**Files:** replace `src/open-pr.ts`; test `test/open-pr.test.ts`.

**Interfaces:**
```ts
export const MAIN_ONLY = 'open_pr is for the main agent only'
export const NO_RUN = 'open_pr needs a run this chat drives: `run` `open` or `resume` one first (`run` `list` shows the open runs).'
export const GATE_LINE = '⚠ dish: opened past a failing gate. Ruling: '
export const REVIEW_LINE = '⚠ dish: opened without an approved final review of this head. Ruling: '
export const TITLE_MAX = 256
export const BODY_MAX = 60_000
export function openPrTool(deps: ToolDeps): ToolDefinition
/** The override lines, masked: the gate's first, then the review's, each `GATE_LINE`/`REVIEW_LINE` + the ruling, joined by a blank line. '' for none. */
export function overrideLines(overrides: { gate?: string, review?: string }): string
/** The body as sent to a new pull request: the main agent's, masked, then, only for an override, a blank line and `overrideLines`. */
export function prBody(body: string, overrides: { gate?: string, review?: string }): string
/** The refusal's text, from what the checks found. */
export function refusalText(run: Run, head: string, found: { gate: PrGate | null, gateOk: boolean, final: VerdictView | undefined, reviewOk: boolean, gatesMissing: boolean }): string
```

What Task 10 reads of Tasks 5 and 6, through `services.ts`' `Pick`s (a difference is a compile error):
- `headOf(pathOrRef): Promise<string | undefined>`: the worktree's `HEAD`;
- `isClean(pathOrRef): Promise<{ clean: true } | { clean: false, why: string }>`: nothing uncommitted or untracked, `dish/<slug>` checked out, no nested worktree or repository;
- `runAt(project, worktreePath, { sessionId, head?, signal? }): Promise<GateCheck>`: the project's gate at that head (an `error` result when the worktree's `HEAD` isn't `head`); it rejects only when the caller's signal aborts;
- `pushBranch(project, slug, { head, signal? }): Promise<{ head: string }>`: refused, with nothing pushed, unless `dish/<slug>` is at `head`; rejects with GitHub's reason, masked;
- `openPull(project, { head, title, body }): Promise<{ url: string, number: number, existing: boolean }>`: `existing` when a pull request for that branch was open already, which it leaves as it was;
- `commentPull(project, number, body): Promise<void>`.

**Parameters** (strings; `''` is none):

| Name | Description (as the model sees it) |
|---|---|
| `title` | "The pull request's title: one line, at most 256 characters. Required unless the run already has a pull request." |
| `body` | "The pull request's description, in Markdown: what changed and why, for a reviewer. Yours; dish adds a line only for an override. Required unless the run already has a pull request." |
| `gateRuling` | "Only to open the PR although the gate didn't pass on the head: your ruling, `Ruling: what — why — cost if wrong`, on one line. Leave empty otherwise." |
| `reviewRuling` | "Only to open the PR without an approved final review of the head: your ruling, `Ruling: what — why — cost if wrong`, on one line. Leave empty otherwise." |

**Description:** "Push the run this chat drives and open its pull request (main agent only). This is the only way anything is pushed: never `git push` or `gh pr create`.
- **What it needs:** the run's worktree clean. It runs the project's gate on the worktree's head, and needs the latest final review (a reviewer started with `delegate`'s `final: true`) to have approved that same head.
- **What you write:** `title` and `body` (Markdown), for a reviewer.
- **Only when you rule past a check:** `gateRuling` (the gate didn't pass) or `reviewRuling` (no approved final review of this head), each `Ruling: what — why — cost if wrong`. dish then adds one line saying so at the end of the body.
- **Review feedback:** on a run you reopened with `run` `resume`, it runs the same checks and pushes the new head to the same pull request. Its title and body stay as they are, and an override's line is posted as a comment.
- A refused check pushes nothing. It takes as long as the gate. It ends the run."

**Output schema:** `{ url: STRING, number: INTEGER, existing: BOOLEAN, head: STRING, text: STRING }`. `render` gives `text`.

**Behavior: the exact order.** No step pushes, opens or writes before the steps above it have passed.

1. **The caller.**
   - `session = mainSession(exec)` (Task 8). `undefined` → `Error(MAIN_ONLY)`.
   - Nothing is read before this.
2. **The arguments,** as far as they don't need the run:
   - **`title`:** `oneLine(title)`; when given, at most `TITLE_MAX`. Otherwise "`title` is one line, at most 256 characters".
   - **`body`:** when given, at most `BODY_MAX`. Otherwise "`body` is at most 60,000 characters".
   - **The rulings:** `given(gateRuling)` and `given(reviewRuling)`. A given one where `hasRuling` is false: "gateRuling needs the ruling itself: `Ruling: what — why — cost if wrong`" (the same for `reviewRuling`).
3. **The run.** `await runs.ready()`; `run = store.drivenBy(session)`, or `Error(NO_RUN)`.
   - **Without `run.pr`:** `title` and `body` are required: "`title` is required: one line, at most 256 characters" and "`body` is required: the pull request's description in Markdown, at most 60,000 characters".
   - **With `run.pr`** (a run reopened for review feedback): both may be empty. They are used only if GitHub has no open pull request for the branch any more; then the title is the run's goal and the body is empty.
4. **The lock.** Everything after this runs in `withRun(run)`.
   - The record is read again. It must be `open`, with this chat as driver. Otherwise "run `<id>` is no longer driven by this chat (<closed: its PR <url> | abandoned | taken over by another chat>). Nothing was pushed."
   - A second `open_pr` waits here, and then finds the run closed.
5. **dish-workspaces:** `services.workspaces()`, or "dish-workspaces isn't running, so nothing can be pushed".
6. **No coder still at work** (only with dishCrew; skipped without it). `crew.worktreeBindings(run.worktree)` with any `running` gives "<role> «<title>» (child <id>) is still working in the run's worktree: wait for its finish notice, then call open_pr again. Nothing was pushed."
7. **The worktree is one dish can push.** `resolve(run.worktree)`:
   - `undefined` → "the run's worktree <path> can't be pushed: <resolveProblem(…) ?? 'it is gone, or its project is no longer registered'>. Nothing was pushed.";
   - a branch other than `run.branch` → "the run's worktree is on <branch>, not <run.branch>. Nothing was pushed."
8. **Clean.** `isClean(run.worktree)` gives `{ clean: false, why }` → "the run's worktree isn't clean (<why>): commit or remove the changes in a coder's round, then call open_pr again. Nothing was pushed." A rejection gives "can't tell whether the run's worktree is clean: <message>. Nothing was pushed."
9. **The head.** `head = await headOf(run.worktree)`. `undefined` or a rejection gives "can't read the run's head: <message>. Nothing was pushed."
   - Steps 5–9 record nothing: they refuse before any check of substance ran.
10. **The gate on the head.**
    - **No dishGates:** `gate = null`, `gatesMissing = true`, `gateOk = false`.
    - **Otherwise:**
      - `result = await gates.runAt(run.project, run.worktree, { sessionId: session, head, signal: exec.signal })`;
      - a rejection with `exec.signal` aborted → "open_pr was cancelled while the gate ran. Nothing was pushed.", with nothing recorded; any other rejection is `gate = { outcome: 'error', reason: message, … }`;
      - `gate` is `result`'s fields, as a `PrGate`;
      - `gateOk = result.outcome === 'passed' && sameHead(result.head, head)`. `runAt` itself gives `error` when the worktree's `HEAD` moved before the gate ran.
11. **Did the worktree move?** `head2 = await headOf(run.worktree)`, `clean2 = await isClean(run.worktree)`.
    - If `head2 !== head` or `!clean2.clean`:
      - append `pr.checked` (`result: 'refused'`, `refused: ['the worktree changed while the gate ran']`, and what was found);
      - `Error("the run's worktree changed while the gate ran (<head7> → <head2_7>, or new uncommitted changes): call open_pr again. Nothing was pushed.")`.
12. **The final review on the head.** `final = latestFinal(entries)` from `runs.entries(run)`. `reviewOk = final?.verdict === 'approved' && sameHead(final.head, head)`.
    - A final review is any `review.verdict` with `final: true`: a reviewer started with `final: true`, or one a follow-up made final, and every later run of that reviewer (its re-reviews), since `final` stays on its record (Tasks 1, 4).
13. **The overrides.**
    - `overrides.gate = !gateOk && gateRuling ? cut(rulingBody(gateRuling), 1000) : undefined`.
    - `overrides.review` the same way, with `reviewOk` and `reviewRuling`.
    - A ruling given for a check that passed is ignored: it is neither recorded nor added to the body.
    - `pass = (gateOk || overrides.gate) && (reviewOk || overrides.review)`.
14. **`pr.checked`** is appended either way:
    - `session`, `head`;
    - `gate`: the `PrGate`, or `null`;
    - `final`: `{ child, verdict, head, at }`, or `null`;
    - `gateOk`, `reviewOk`, `overrides`;
    - `result: pass ? 'pass' : 'refused'`, and `refused` (the failed checks, a phrase each).
    - When refused: `Error(refusalText(...))`:
      ```
      open_pr refused for run `<id>` at <head7>; nothing was pushed:
      - the gate <failed with exit <code> after <duration> (log <path>) | was stopped at its time limit (log <path>) | couldn't run: <reason> | didn't run: dish-gates isn't running>. Fix it in a coder's round, or give `gateRuling: "Ruling: what — why — cost if wrong"` to open the PR past it.
      - no final review approved <head7>: <there is none yet | the latest final review (child <c>) requested changes at <h7> | the latest final review (child <c>) approved <h7>, not this head>. Delegate a reviewer with `final: true` (or send the final reviewer a re-review with `to`), or give `reviewRuling: "Ruling: what — why — cost if wrong"` to open past it.
      ```
      Only the lines of the failed checks are given.
15. **The push.** `await workspaces.pushBranch(run.project, run.slug, { head, signal: exec.signal })`.
    - A rejection gives "GitHub refused the push of <run.branch>: <message, masked>. Nothing else was done; the run stays open."
    - No entry is written: per the spec, nothing more happens.
16. **The pull request.** `pull = await workspaces.openPull(run.project, { head: run.branch, title, body: prBody(body, overrides) })`, the title masked as well, and with step 3's fallbacks for a reopened run.
    - `prBody`: `maskSecrets(body.trimEnd())`, then, when there is an override, `\n\n` + `overrideLines(overrides)`. The body alone when it is empty.
    - A rejection gives "<run.branch> was pushed at <head7>, but GitHub refused the pull request: <message>. The run stays open: call open_pr again once that's fixed." Pushing the same head again is a no-op.
17. **A pull request that was already open** (`pull.existing`): GitHub's title and body stay as they were, so the body's override lines never reach it.
    - When there is an override: `await workspaces.commentPull(run.project, pull.number, overrideLines(overrides))`. A rejection doesn't fail the call: it is logged, and `comment: 'failed'` with `commentError` (masked, one line, at most 300 characters) goes in the entry, and the answer says so. Otherwise `comment: 'posted'`.
    - Without an override: no comment, no `comment` field.
18. **The record.**
    - `pull.existing` → `pr.updated { session, url, number, head, branch: run.branch, comment?, commentError? }`; otherwise `pr.opened { session, url, number, head, branch: run.branch }`;
    - `close(run, session, { state: 'pr', pr: { url, number } })`, which writes the record (`state: 'pr'`, `pr`, `closedAt`, the driver released) and `run.closed { state: 'pr', pr }`.
    - The chat drives no run after this.
19. **The answer:**
    ```
    Opened PR #<n> for run `<id>`: <url>
    Pushed dish/<slug> at <head7>: <the gate passed on it | past a gate that didn't pass, on your ruling>; <the final review approved it | without an approved final review of it, on your ruling>.
    [The body ends with dish's line for each override.]
    Run `<id>` is closed. Humans merge; dish removes the run's worktrees once the PR is merged. Review feedback: `run` `resume` reopens it.
    ```
    With `existing`, the first line is "Pushed <head7> to the pull request already open for dish/<slug>: #<n> <url>. dish opened no other, and its title and body are as they were." The third is "dish posted the override line as a comment on it." or "dish couldn't post the override line as a comment (<reason>): add it to the pull request by hand.", when there is an override.

**Tests** (`open-pr.test.ts`, over Task 8's `world`, the stubs recording every call):
- **The caller:** a child → `MAIN_ONLY`, and no service is called.
- **The arguments:** a title of 300 characters, a body over 60,000, `Ruling:` alone in each ruling; with no PR on the run, no title and an empty body are each refused.
- **No run** → `NO_RUN`.
- **Each check, failing, and nothing pushed** (`pushBranch`, `openPull` and `commentPull` never called):
  - no dish-workspaces;
  - a running coder bound to the run's worktree;
  - an unresolvable worktree;
  - a worktree on another branch;
  - not clean (the `why` in the text), and `isClean` rejecting;
  - an unreadable head;
  - the gate `failed`;
  - the gate `error` (and `runAt`'s error for a moved head);
  - no dish-gates;
  - no final review;
  - a final review that requested changes;
  - an approved final review of an older head (stale);
  - a non-final reviewer's approval of this head, which doesn't count;
  - the head moving during the gate (`headOf` gives another sha on its second call).
  - The gate check and the review check refusals record `pr.checked` (`refused`). The ones before the gate record nothing.
- **All passing:**
  - `runAt` got the run's project, worktree, the session, the head and the call's signal;
  - `pushBranch` got `{ head, signal }`;
  - `openPull` got `head: dish/<slug>`, the masked title and the body unchanged (no line);
  - `pr.checked` (`pass`), `pr.opened` and `run.closed` were written in that order;
  - the record is `pr`, with `pr` and `closedAt`, and its driver released;
  - the chat drives nothing.
- **A final review re-reviewed with `to`:** a reviewer started with `final: true` that approved an older head, then (a follow-up, its record still `final`) the new head → passes.
- **A final review that approved a 7-character prefix** of the head passes.
- **Overrides:**
  - `gateRuling` past a failing gate → the gate's line;
  - `reviewRuling` → the review's line;
  - both → both, the gate's first, each after a blank line;
  - a ruling with `Ruling:` → no doubled "Ruling: Ruling:";
  - a ruling for a check that passed → ignored, so no line and no override in `pr.checked`;
  - no dish-gates with `gateRuling` → passes.
- **The push rejected** → GitHub's reason (with a `ghs_` token in it, masked). No `pr.opened`; the run is open.
- **`openPull` rejected** → the error. The run is open, and a second `open_pr` pushes again and opens the PR.
- **Review feedback (a reopened run):**
  - a run with `pr`, reopened (Task 8's `drive`), with no `title` or `body` → passes the arguments; the checks run as for a first PR; `pushBranch` gets the new head; `openPull` answers `existing: true`;
  - → `pr.updated` (not `pr.opened`) and `run.closed`, the record `pr` with the same `pr`, and no `commentPull` without an override;
  - with `reviewRuling` → `commentPull(project, number, <the review line>)`, and `pr.updated` has `comment: 'posted'`; `commentPull` rejecting → `comment: 'failed'` with the reason, the run still closed, and the answer says to add it by hand;
  - `openPull` answering `existing: false` (the old pull request was closed on GitHub) → `pr.opened` with the new number, the title the run's goal, and the record's `pr` replaced.
- **An existing PR on a first `open_pr`** (opened outside dish) → `pr.updated`, reported, and the run closed.
- **Secrets:** a token in the body is masked in what `openPull` got, in a comment, and in every ledger line.
- **Cancelled** during the gate → nothing recorded, nothing pushed.
- **Two `open_pr` calls at once** → one PR; the second is refused with "no longer driven by this chat (closed …)".

**Steps:**
- [ ] Failing tests first: the list above.
- [ ] Implement.
- [ ] Run the gate. Then check:
  - `grep -rn pushBranch plugins/orchestrator/src` finds the one call in `src/open-pr.ts` (and `services.ts`' type);
  - `grep -rn child_process plugins/orchestrator/src` finds nothing.
- [ ] Commit `dish-orchestrator: open_pr`.

---

## Task 11: the remote and Settings → Runs (`dish-orchestrator`)

**Needs:** Task 7, and Task 8 for `index.ts`'s wiring.

**Files:**
- **Replace:**
  - `src/remote.ts`;
  - `src/protocol.ts`;
  - `src/client/index.tsx`.
- **Create:**
  - `src/client/remote.ts`;
  - `controller.ts`;
  - `outcome.ts`;
  - `format.ts`;
  - `entries.ts`;
  - `Runs.tsx`;
  - `RunList.tsx`;
  - `RunView.tsx`;
  - `Timeline.tsx`;
  - `parts.tsx`;
  - `styles.ts`.
- **Tests:**
  - `test/remote.test.ts`;
  - `test/client-remote.test.ts`;
  - `test/controller.test.ts`;
  - `test/client-entries.test.ts`;
  - `test/client-rendering.test.ts`;
  - `test/jsx-lite/jsx-runtime.ts`, which is judge's, copied.

**Interfaces:**
```ts
// protocol.ts: browser-safe; imports nothing (judge's protocol.ts pattern)
export const NAMESPACE = 'dishRuns'                   // the page calls ctx.remote.dishRuns; the Cordis key is dishRunsRemote
export type ErrorCode = 'INVALID' | 'NOT_FOUND'
export type Outcome<T> = { ok: true, value: T } | { ok: false, code: ErrorCode, message: string }
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }
export interface DriverInfo { session: string, since: number, live: boolean }
export interface RunRow {
  project: string, id: string, slug: string, goal: string, state: 'open' | 'pr' | 'abandoned'
  driver: DriverInfo | null             // null: released
  openedAt: number, closedAt?: number, pr?: { url: string, number: number }, reason?: string
}
export interface GateView { /* derive's, field for field */ }
export interface VerdictView { /* derive's */ }
export interface TaskView { /* derive's */ }
export interface RulingView { /* derive's */ }
export interface RunSummary { /* derive's */ }
export interface RunDetail extends RunRow {
  branch: string, worktree: string, base: string, baseCommit: string, plan?: { path: string, commit: string }
  summary: RunSummary
}
export interface LedgerLine {
  at: number, run: string, kind: string, by: 'harness' | 'main'
  session?: string, child?: string, task?: string, cut?: boolean
  fields: { [key: string]: JsonValue }  // everything else in the entry
}
export interface LedgerPage { lines: LedgerLine[] /* newest first */, next?: string, skipped: number }

// remote.ts
export const SERVICE = 'dishRunsRemote'
declare module '@deepseek-ai/cordis' { interface Context { dishRunsRemote: RunsRemote } }
export type WireMatchesServer = [
  Check<Same<RunSummary, derive.RunSummary>>, Check<Same<TaskView, derive.TaskView>>, Check<Same<GateView, derive.GateView>>,
  Check<Same<VerdictView, derive.VerdictView>>, Check<Same<RulingView, derive.RulingView>>,
]
export class RunsRemote extends TypertRemoteService {
  static inject = ['dishRuns']
  constructor(ctx: Context, options: RemoteOptions)
  /** Every run, by project, open ones first, then newest opened first. Not an Outcome: it refuses nothing. */
  runs(): Promise<RunRow[]>
  run(project: string, id: string): Promise<Outcome<RunDetail>>
  /** A page of the run's ledger, newest first. `limit` 0 is the default (200); `before` '' is the newest. */
  ledger(project: string, id: string, limit: number, before: string): Promise<Outcome<LedgerPage>>
}
export function runsRemote(ctx: Context, options: RemoteOptions): void      // ctx.plugin(RunsRemote, options)

// client/remote.ts (judge's client/remote.ts pattern)
export interface RunsApi {
  runs(): Promise<RemoteResult<RunRow[]>>
  run(project: string, id: string): Promise<RemoteResult<Outcome<RunDetail>>>
  ledger(project: string, id: string, limit: number, before: string): Promise<RemoteResult<Outcome<LedgerPage>>>
}
declare module '@deepseek-ai/dsh-typert-protocol' { interface TypertRemoteNamespaceMap { dishRuns: RunsApi } }
export const runsRemote: TypertRemoteContribution   // descriptors: runs; run(project, id); ledger(project, id, limit, before)

// client/controller.ts
export const TIMELINE_PAGE = 200
export const TIMELINE_MAX = 2000
export type Load = 'idle' | 'loading' | 'ready' | 'error'
export interface PageState {
  list: { load: Load, rows: RunRow[], error?: Notice }
  selected?: { project: string, id: string }
  detail: { load: Load, value?: RunDetail, error?: Notice }
  timeline: { load: Load, lines: LedgerLine[] /* oldest first, as shown */, next?: string, skipped: number,
    more: 'idle' | 'loading', moreError?: Notice, capped: boolean, error?: Notice }
}
export interface RunsActions {
  hooks: { page: ObservableSnapshot<PageState> }
  open(): Promise<void>                 // the section was shown: read the list, and the selected run again
  refresh(): Promise<void>
  select(project: string, id: string): Promise<void>
  back(): void
  loadOlder(): Promise<void>
}
export interface RunsController { face: RunsActions, getState(): PageState, dispose(): void }
export function createRunsPage(api: RunsApi): RunsController

// client/entries.ts: plain TypeScript, no DOM
/** One ledger line in words: a label, and lines of text. Every field is read with a type check; an unknown kind shows its fields as JSON (at most 2000 characters). */
export function describeEntry(line: LedgerLine): { label: string, text: string[] }
// client/format.ts
export function relativeTime(time: number, now: number): string            // workspaces' (client/format.ts:19)
export function shortSha(sha: string): string
/** `url` when it is exactly https://github.com/<owner>/<repo>/pull/<n>; else undefined, and the page shows it as text. */
export function prHref(url: string): string | undefined
// components: plain functions of their props; no hooks and nothing from dsh in RunList, RunView and Timeline
export function RunList(props: { rows: RunRow[], now: number, select(project: string, id: string): void }): JSX.Element
export function RunView(props: { detail: RunDetail, timeline: PageState['timeline'], now: number, back(): void, loadOlder(): void }): JSX.Element
export function Timeline(props: { timeline: PageState['timeline'], now: number, loadOlder(): void }): JSX.Element
```

**Behavior:**
1. **The server half.**
   - **How it is built:** `RunsRemote` is built like `JudgeRemote` (judge `remote.ts`).
     - `markRemote(RunsRemote, 'runs' | 'run' | 'ledger')`; none of the names is in `RESERVED_REMOTE_METHODS`.
     - Parameters are plain identifiers, and `''` and `0` mean absent.
     - `stringOf`, `countOf`, `outcome`, `wire` and `masked` are judge's (remote.ts:99–151), copied.
   - **Each method** first awaits `options.store.load()`.
   - **`runs()`:** `store.list()` as `RunRow`s.
     - `driver` is `null` for a `''` session, and otherwise has `live: options.live(run)`.
     - Sorted by project (without case), then open first, then newest `openedAt`.
     - The result is `masked(wire(...))`.
   - **`run(project, id)`:**
     - `INVALID` when `splitProject` throws or the id isn't a `RUN_ID`;
     - `NOT_FOUND` "no run <project>/<id>" when the store has none;
     - otherwise the row, the record's fields, and `summarize(run, (await ledger.entries(...)).entries)`.
   - **`ledger(...)`:**
     - the same checks;
     - `ledger.read(project, id, { limit?, before? })`, where its `RangeError` is `INVALID`;
     - each entry becomes a `LedgerLine`: the base fields, and the rest in `fields`.
   - **Masking.** Everything that leaves passes `masked` once more.
   - **Read only.** No method writes anything: there is no method but these three.
2. **The client.** `index.tsx` is workspaces' `client/index.tsx`, adapted:
   - `inject = ['remote', 'slots']`;
   - `ctx.remote.$mount(runsRemote)`;
   - `ctx.inject(['remote.dishRuns', 'slots'], register)`;
   - the controller is disposed with its scope;
   - the `settings.section` entry is `{ id: 'dish-orchestrator', order: 51, label: () => 'Runs', inject: () => page.face }`, with `Runs` as the component. Its comment: after History (50).
3. **The controller** follows workspaces' `createAppCard` pattern (controller.ts): a small snapshot store, `settle` folding failures into a `Notice`, generation counters for stale answers, and `dispose`.
   - **`open`, `refresh`:** read the list again, and, if a run is selected, its detail and the first page of its timeline.
   - **`select`:** sets `selected`, and reads `run(project, id)` and `ledger(project, id, TIMELINE_PAGE, '')` together. An answer for a run no longer selected is dropped.
   - **The timeline.** `lines` is the page reversed (oldest first, newest last, as the spec shows a timeline).
     - `loadOlder` reads with `next` and puts the older lines before.
     - It stops at `TIMELINE_MAX`, with `capped`, as judge's `loadMore` (controller.ts:747–766).
   - **`back`:** clears `selected`, `detail` and `timeline`.
   - **An `Outcome` refusal** becomes a `Notice` with the server's message.
4. **The components.**
   - **`Runs`.** It is the owner: `SettingsSectionOwnerProps & InjectFace<RunsActions>`, `usePage`, `useEffect(() => { void open() }, [open])`. It shows:
     - the title "Runs";
     - the intro "Every change on its way to a pull request is a run. This page shows them and their ledgers; it changes nothing.";
     - then `RunList` or `RunView`;
     - load errors with `LoadError` (judge's `parts.tsx`), and a Refresh button.
   - **`RunList`.** Grouped by project, each group in the order given. Each row is a button that selects the run, holding:
     - the goal;
     - the id;
     - a state tag (open / PR / abandoned);
     - the driver ("driven by session <8>… (live)", "… (not live)", or "no driver");
     - "opened <relative>" and "closed <relative>";
     - the PR, as a link only through `prHref` (`<a href rel="noopener noreferrer" target="_blank">#<n></a>`), and otherwise as text. An open run can have one too: a run reopened for review feedback keeps its PR.
     - With no runs: "No runs yet. A run starts when the main agent calls `run` `open`, or makes a worktree."
   - **`RunView`.** It shows:
     - a Back button;
     - the facts (`dl`): project, id, goal, state, PR, reason, branch, worktree, base and its commit, plan and its commit, driver, opened, closed;
     - "Tasks": a list with each task's rounds, its latest coder, gate and verdict, and marks for the run's own worktree and for removed tasks;
     - "Final review";
     - "Rulings";
     - "Deferred";
     - "Notes";
     - then `Timeline`.
   - **`Timeline`.**
     - "Load older" at the top while there is a `next`; "Older entries aren't shown: …" when `capped`; "N unreadable lines skipped" when `skipped > 0`.
     - Then an `ol` of entries, oldest first. Each entry has its time, a "harness" or "main agent" mark (who wrote it), `describeEntry`'s label and lines, the task and child when there are some, and "(cut to fit)" for `cut`.
   - **Everything from the ledger is text.** It goes in only as text children or attribute values, never as markup. No `dangerouslySetInnerHTML`, and no string taken for a tag, a handler or a link except through `prHref`. This is judge's `LogLines.tsx` rule.
5. **The styles.** `.dish-runs-*`, colours from `--dsw-alias-*` tokens only, as in workspaces' `client/styles.ts`:
   - `.dish-runs` is a size container (`container: dish-runs / inline-size`, `width: 100%`);
   - long text wraps anywhere;
   - the facts' columns give way below 560px;
   - nothing is wider than its container.

**Tests:**
- **`remote.test.ts`** (a `Context` with the plugin over temp directories and the stub services of Task 8's `world`):
  - `runs()` order and driver forms (live, not live, released);
  - `run()`'s detail matches `summarize`;
  - `INVALID` for `../x`, an id with `/`, and a bad cursor;
  - `NOT_FOUND`;
  - `ledger()` pages newest first with `next`, the defaults, and `fields`;
  - a `ghs_` token planted raw in a ledger file (written directly, bypassing masking) comes out masked;
  - `remoteMethods(RunsRemote)` is exactly `runs`, `run` and `ledger`;
  - no method writes: the directories' listings and mtimes are unchanged after every call.
- **`client-remote.test.ts`:**
  - the descriptors name exactly the marked methods, with the server's parameter names (judge's `client-remote.test.ts`);
  - `remoteContribution` doesn't throw.
- **`controller.test.ts`** (a fake `RunsApi`):
  - the list;
  - `select` (detail and first page together);
  - a stale answer dropped after another `select` or `back`;
  - `loadOlder` (order kept, oldest first) up to `capped`;
  - a refusal becomes a notice;
  - the carrier failing;
  - `dispose` stops answers landing.
- **`client-entries.test.ts`:**
  - `describeEntry` for every kind of the two tables and `pr.updated` (with its comment posted, and failed), and a `run.resumed` that reopened a run, with the fields Task 7 defines;
  - an unknown kind;
  - fields of the wrong type (no throw, a generic line);
  - `prHref`: accepted, and refused for `javascript:`, `http:`, another host, an extra path, and a query.
- **`client-rendering.test.ts`** (judge's `client-rendering.test.ts`, compiled with esbuild against `jsx-lite`):
  - `RunList`, `RunView` and `Timeline` over rows and lines whose goal, summaries, findings, rulings, notes, URL and title hold `<script>`, `<img onerror>`, `javascript:` and a quote;
  - only the declared tags appear (`ul`, `ol`, `li`, `div`, `span`, `p`, `dl`, `dt`, `dd`, `code`, `button`, `h3`, and `a` only for an accepted `prHref`);
  - no attribute that loads or runs anything;
  - every hostile string is escaped;
  - a source scan of the three files finds no `dangerouslySetInnerHTML`, `innerHTML` or `href={` other than `prHref`'s.

**Steps:**
- [ ] Failing tests first: the lists above.
- [ ] Implement. Run `pnpm --filter dish-orchestrator build`: `lib/client.js` builds.
- [ ] Run the gate.
- [ ] Commit `dish-orchestrator: Settings → Runs`.
- [ ] The page is checked by hand in a browser in Task 13's scratch run, as other pages are.

---

## Task 12: the shipped prompts and skills (`dish-prompts`, `dish-skills`)

**Needs:** Tasks 2, 4, 9 and 10, for the names the texts use (below). It changes no code.

**Files:**
- **Modify the prompts:** `plugins/prompts/defaults/main.md`, `common.md`, `crew/coder.md` and `crew/reviewer.md`. Regenerate `plugins/prompts/defaults/previous.json`.
- **Modify the skills:** `plugins/skills/defaults/<name>/SKILL.md` for each of:
  - `subagent-driven-development`, `executing-plans`, `finishing-a-development-branch`, `using-git-worktrees`;
  - `requesting-code-review`, `reviewing-work`;
  - `test-driven-development`, `verification-before-completion`, `receiving-code-review`, `systematic-debugging`;
  - `changing-infrastructure`.

  Regenerate `plugins/skills/defaults/previous.json`.
- **Tests:** create `plugins/prompts/test/pipeline-texts.test.ts`. Modify `plugins/skills/test/defaults.test.ts`.
- **Unchanged:**
  - `plugins/skills/defaults/NOTICE.md`: the texts are still dish's own words, and it is excluded from `previous.json` (`--exclude NOTICE.md`);
  - `plugins/crew/defaults/crew.yaml` and its `previous.json`: `report` is per child, and a child's own layer isn't filtered by the role's tools (spec, Checks); `run` and `open_pr` are on crew's `NEVER` list in code;
  - the architect, ops, researcher and writer prompts: decision 5 gives them no `report`;
  - every other skill. `writing-plans` still has plans' task steps say "run the gate": a gated coder that follows them runs it once more, which is harmless. `using-git-worktrees`' baseline gate (its step 5) is a run before work, not a finishing run, and stays.

**Names the texts use.** They come from the Contracts and must match Tasks 2, 4, 9 and 10 exactly. If a task named one differently, stop and report `NEEDS_CONTEXT`.

| Where | Names |
|---|---|
| `run` (Task 9) | actions `open` (`project`, `slug`, `goal`, `plan`, `base`), `resume` (`id`, `takeover`; it reopens a run with a pull request), `goal`, `plan`, `abandon` (`reason`), `status`, `list`, `ruling` (`what`, `why`, `costIfWrong`, `task`), `defer` (`what`, `where`, `why`), `note` (`text`) |
| `open_pr` (Task 10) | `title`, `body`, `gateRuling`, `reviewRuling` |
| `delegate` (Task 4) | `ruling`, `gateOverride`, `final: true` |
| `report` (Task 2) | coder: `status` (`done`, `blocked`, `needs_context`), `summary`, `commits`, `blockedOn`, `rulings`, `concerns`, `notFixed`. Reviewer: `verdict` (`approved`, `changes_requested`), `head`, `summary`, `findings` (severity `blocking`, `should_fix`, `nit`), `checks`, `addressed` |

**Behavior** (rules for the texts):
1. **House style.** Short sentences, bold leads, lists. Each `SKILL.md` stays at most 8000 characters (`WARN_CHARS`, `plugins/skills/src/skill.ts:36`), and `checkSkill` gives no problems or warnings. `subagent-driven-development` below is 7800 characters: don't add to it without cutting.
2. **A run in a registered project, a file elsewhere.** Runs exist only in registered projects. So the skills say:
   - **In a registered project:** `run` and `open_pr`;
   - **Elsewhere** (no run): a ledger file (`.worktrees/<plan file name>-ledger.md`), and the user pushes.

   "A registered project" keeps its one check (the parenthetical the existing test pins).
3. **"The plan branch" stays the term.** It is now defined as the run's branch. So the pinned placeholders (`git -C <path> cherry <plan branch>`) don't change.
4. **No agent pushes.** No text tells any agent to `git push` or `gh pr create`. In a run, `open_pr` opens the PR. Elsewhere, the user pushes.
5. **`open_pr` needs no user yes.** At the end of a run it is routine, like bringing a task onto the plan branch: it merges nothing, and its checks are structural ([Spec correction 13](#spec-corrections-for-the-user)). Cost if wrong: a PR opened that the user wanted held; they close it.
6. **A gated coder doesn't run the whole gate to finish.** The sentence everywhere is "dish runs it when you `report` `done`", conditioned on "your brief says dish runs the gate" (the `worktreeBrief` gate sentence). A coder may still run it while it works. An unbound coder still runs the gate itself.
7. **The main agent reads the notice.** A coder's `status` and its gate line, and a reviewer's `verdict` and `head`, are what dish recorded. The rest of a report is a claim. With no gate line, the main agent runs the gate itself.
8. **The main agent's Skills section in `main.md`** gains no backticked name that isn't a skill (`skills-mentioned.test.ts:73-76`).
9. **The crew prompts** name no skill outside their `- Skills:` line, and keep that line before the first line holding `` `send_message` `` (`skills-mentioned.test.ts:103-116`).

### The texts

**`prompts/main.md`:**
- **Line 15,** in "Leave the task's builds…": `(a gate run to verify, a worktree, bringing commits onto the plan branch, a push)` → `(a run, a worktree, a gate run to verify, bringing commits onto the plan branch)`.
- **After line 20** ("For a fix round…"), a new bullet:
  > - Coders and reviewers finish with `report`. Their notice shows it: a coder's `status` and a reviewer's `verdict` and reviewed `head` are what dish recorded; the rest is their account.
- **A new section between "## Delegate" and "## In the chat":**
  ```markdown
  ## Runs

  - Every change that ends in a pull request is a run: a goal, its own branch `dish/<slug>`, its tasks and a ledger. A run belongs to its project, so any chat there can take it up, and one chat drives it at a time.
  - Open one before the work starts: `run` with action `open`, the `project`, a `slug`, a one-line `goal`, and the `plan` when there is one. A worktree you make with no run opens one around it; then name its goal with action `goal`. While your chat drives a run, every worktree you make in its project is one of its tasks.
  - dish writes the ledger from what it sees: delegations, reports, gates, verdicts and the pull request. Add your own with `run`: rulings (action `ruling`), deferred findings (`defer`) and notes (`note`). After a compaction, action `status` says where the run stands.
  - To take up a run another chat drove: action `list`, then `resume` with its id. Its tasks go on with fresh children, and their rounds carry over.
  - From round 5 of a task, `delegate` refuses more coder work unless you give `ruling`. If no ruling unblocks it, stop and tell the user.
  - A run ends with `open_pr`, with a `title` and a `body` you write. dish pushes the run's branch and opens the pull request once the gate passes on its head and the final review (`delegate` with `final: true`) approved that head. Or it ends with action `abandon` and the reason, when the user drops the change.
  - Review feedback on its pull request: `resume` the run (it reopens), fix in rounds as before, and call `open_pr` again: it runs the same checks and pushes to the same pull request.
  - Never push yourself: no `git push`, no `gh pr create`. Your git and your children's can't push; only `open_pr` does. Without a `run` tool (a repo that isn't a registered project), keep a ledger file as `subagent-driven-development` says, and leave the push to the user.
  ```
- **Line 37** (Skills): `` - `finishing-a-development-branch`: when the last task is reviewed, before you call the branch ready. `` → `` - `finishing-a-development-branch`: when the last task is reviewed, to open the pull request. ``
- **Line 52:** `…and record each one as a ruling: `Ruling: what — why — cost if wrong`.` → `…and record each one as a ruling, `Ruling: what — why — cost if wrong`, with `run` action `ruling` in a run.`
- **Line 53:** `- Stop and ask before irreversible or security-sensitive actions, pushes and merges, or when a plan is too broken to continue.` → `- Stop and ask before irreversible or security-sensitive actions and merges, or when a plan is too broken to continue. A finished run's `open_pr` isn't one of them: it merges nothing.`

**`prompts/common.md`, line 3:**
- **Old:** `- Humans merge. Open pull requests. Never force-push or push to a default branch, and merge only when the user tells you to in so many words.`
- **New:** `- Humans merge. Pull requests are opened with `open_pr`, the main agent's tool: agents don't push, with git or anything else. Merge only when the user tells you to in so many words.`

**`prompts/crew/coder.md`,** whole file:
```markdown
You are dish's coder, powered by the {{model}} model. You carry out one task from a plan.

- Read the task and the files it names before changing anything. Match the style of the code around you.
- Change files with `write` and `edit`, not heredocs, `sed -i` or `echo >`. `read` a file before you `edit` it: `edit` refuses a file you've only seen through `cat`.
- Test first: write the failing test, watch it fail, make it pass, then tidy up.
- Stay inside the task. If the task is wrong or blocked, stop and say why in your `report` instead of improvising a different design.
- When your brief says dish runs the project's gate, don't run the whole gate to finish: dish runs it when you `report` `done`, and a failure comes back to you. You may run it while you work. Otherwise, run the repo's gate before you finish. Either way, done means the gate passed.
- Commit with a message that says what changed and why.
- Skills: load `test-driven-development`, `systematic-debugging`, `receiving-code-review`, `using-git-worktrees`, `verification-before-completion` when the work calls for them.
- If you're blocked or need a decision, ask the main agent with `send_message`. Never send your findings or report that way: report once, with `report`.
- Finish by calling `report`, which ends your turn: `status` `done`, or `blocked` or `needs_context` with `blockedOn`; a `summary` of what changed (files and behavior); the `commits` you made; your judgment calls in `rulings`; `concerns`, for anything left undone or worth a second look; and in a fix round, each finding you didn't fix in `notFixed`, with why. What your skills say to hand back goes there too.
```

**`prompts/crew/reviewer.md`,** whole file:
```markdown
You are dish's reviewer, powered by the {{model}} model. You check work against its spec and task. You don't edit; you report.

- Review against the spec, the task and the repo's conventions, not your taste.
- Run the tests and the gate yourself; don't trust a report that they passed.
- For each finding give the severity (`blocking`, `should_fix` or `nit`), the file and line, a concrete way it fails (inputs or state, then the wrong result), and the fix.
- Rank findings most severe first. Say plainly when there are none.
- Check what's missing too: untested cases, unhandled errors, docs that no longer match.
- Skills: load `reviewing-work`, `verification-before-completion` when the work calls for them.
- If you're blocked or need a decision, ask the main agent with `send_message`. Never send your findings or report that way: report once, with `report`.
- Finish by calling `report`, which ends your turn: `verdict` `approved` only when no finding is `blocking` or `should_fix`, else `changes_requested`; the `head` you reviewed (`git rev-parse HEAD` where the work is); a `summary`; the `findings` (empty when there are none); the commands you ran in `checks`, with their exit codes; and in a re-review, `addressed` for each earlier finding.
```

**`skills/subagent-driven-development/SKILL.md`,** whole file (7800 characters):
```markdown
---
name: subagent-driven-development
description: Use when you have an approved implementation plan to carry out with the crew, task by task, in this session.
metadata:
  roles: [main]
---

# Subagent-driven development

You are the controller. You don't write the code: you brief, check, rule, and keep going without stopping to ask. The core principle: **a fresh coder per task, the gate, a cross-family review, and a run whose ledger remembers for you.**

## When to use

- An approved plan in `docs/plans/`, with `delegate` available.
- Not without `delegate`, or for one or two small tasks: load `executing-plans`. Not without a plan: load `writing-plans`.

## Steps

### Set up

1. **Read the plan once, and the spec it names.** The spec is binding. Note the Global Constraints and the Review Focus.
2. **Open the run** in a registered project (your chat's workspace is a clone dish set up: `git config --get-regexp '^credential\..*\.helper$'` names `git-credential-dish`): `run` with action `open`, the `project`, a `slug`, a one-line `goal`, and the plan's path as `plan` (or later, action `plan`). Its branch, `dish/<slug>`, is the plan branch. A run another chat started: action `resume` with its id (`list` shows them). Tell the user the run's id.
   - **Its ledger remembers for you.** dish records the delegations, reports, gates, verdicts and the pull request. Record yours with `run`: every ruling (action `ruling`, with its `task`), every deferred finding (`defer`), and notes (`note`).
   - **After a compaction,** trust `run` action `status` and `git log` over memory.
   - **Elsewhere** there is no run: keep the same record in a git-ignored file, `.worktrees/<plan file name>-ledger.md`, with the branch and its base commit.
3. **Scan for conflicts:** tasks that contradict each other or the Global Constraints, share files or interfaces, or disagree with themselves. Rule on each now.
4. **Count delegations:** two starts per task, one more per round 4, two for the final review, plus what this session already used. Follow-ups with `to` are free. If the total exceeds the per-session limit (30 by default, crew.yaml `limits`), tell the user before Task 1.
5. **Work on the plan branch,** never the default branch. Load `using-git-worktrees`: one worktree per task, each cut from the plan branch. While your chat drives the run, each worktree you make in its project is one of its tasks.

### Each task

1. **Record BASE** and make the task's worktree with `worktree` (action `create`, a slug for the task, `base` the plan branch). It doesn't run setup in a worktree: run the command from its answer there, in the sandbox, before the work starts (yourself, or tell the coder to run it first). Only if it fails with "Read-only file system", run it again escalated (`sandbox_permissions: "danger-full-access"`, a `justification` saying it runs the branch's install scripts outside the sandbox), so the judge allows it or asks the user. A coder can't escalate: when it reports a command that needs it, you run it.
2. **Delegate to a fresh `coder`,** with `delegate`'s `worktree` set to that path: it binds the coder, and crew adds the path and branch to its prompt. It can't see this conversation, so the brief stands alone:
   - where the task fits in the project;
   - the task's full text, pasted, plus the plan and spec paths;
   - the Global Constraints, the worktree path and branch (its setup already run, or the command it runs first), and the gate command;
   - the interfaces it uses from earlier tasks, and the rulings that touch it;
   - that it finishes with `report`, its commits and rulings included, and dish runs the gate when it reports `done`;
   - to ask with `send_message` when blocked, not guess.

   Then **end your turn.** You're notified when it finishes; don't poll.
3. **Read the notice.** The coder's `status` and the gate line are what dish recorded. `blocked` or `needs_context` needs your answer, with `to`. A gate that didn't pass is a fix round, not a review. The rest of the report is claims: check its commits. With no gate line, run the gate yourself in the worktree.
4. **Review.** Delegate a `reviewer` with `reviews` set to the coder's child id. Load `requesting-code-review` for the brief, and put the worktree path in it: `delegate`'s `worktree` is for coders. The next coder may start meanwhile if its task doesn't build on this one; a fix round for the first coder then waits for it to finish.
5. **Fix rounds,** for a red gate and for blocking and should-fix findings. Nits are deferred (`run` action `defer`). dish counts each task's rounds; `delegate`'s answer names the round.
   - **Rounds 1–3:** `delegate` with `to` set to the same coder, findings verbatim. It keeps its worktree.
   - **Round 4:** a fresh `coder` with `model` set to the strong tier of its family in `crew.yaml`, given the brief, the open findings and the previous coder's report path, and `worktree` set to the same path.
   - **Round 5:** rule on each open finding. Reviewer wrong, or real but not blocking: park or defer it with a ruling. Real and load-bearing: if a ruling unblocks it (narrow the requirement, or fold the fix into a named later task's brief), make it, and pass it as `delegate`'s `ruling`: from round 5, it refuses coder work without one. Otherwise stop: the plan is too broken.
   - After a red-gate round: the first review.
   - After a findings round: a scoped re-review, `to` the same reviewer with `reviews` and `model` empty (it stays tied to the first coder), given the findings, the fix's range and the coder's `notFixed`, marking each finding addressed or not. If they still disagree, you rule.
6. **Complete the task.** Bring its commits onto the plan branch (fast-forward or cherry-pick), run the gate there, record `Task N: complete (base..head, review clean)` or `… K parked` (`run` action `note`), and remove the task's worktree with `worktree` (action `remove`). Its branch usually isn't merged into `origin/<default>` (a cherry-picked one never is), so `remove` refuses it without `force`. Set `force` only when `git -C <path> status --short` is empty, `git -C <path> branch --show-current` prints `dish/<slug>`, and `git -C <path> cherry <plan branch>` lists no `+` line: its work is on the plan branch.

### Finish

1. **Final whole-branch review:** a `reviewer` with `final: true`, `reviews` set to a coder this session started whose gate passed (`"main"` if there is none), `model` the strongest of the reviewer's family, over `git merge-base <default branch> HEAD`..`HEAD`, with the spec, the plan, the Review Focus and the deferred and parked findings. Then one fix round (a fresh coder in a new worktree from the plan branch, bound with `delegate`'s `worktree`, every finding), one scoped re-review of the new head, and rulings on the rest: `open_pr` needs the final review's approval of the head it pushes.
2. **Load `finishing-a-development-branch`.**

## Rules

- **Coders run one at a time:** crew allows one writing child among four running, by default (crew.yaml `limits`). Reviewers and researchers may overlap.
- **Never fix a task yourself:** your context is for coordination.
- Never accept "close enough", or skip a re-review because a fix was small.
- **Don't ask "should I continue?"** Stop only for an irreversible or security-sensitive action, a merge into the default branch, or a plan too broken to continue. Bringing a task branch onto the plan branch is routine, and so is `open_pr` at the end.
- Every judgment call is a ruling, recorded with `run`; a silent decision is a bug.

## Hand back

The pull request's URL, the tasks with their commits, the final review's verdict, the deferred findings, and a **Rulings** section: every ruling in the run's ledger, in order, each with its cost if wrong.
```
The old last sentence, "It's the only place the user sees the decisions you made for them.", goes: Settings → Runs shows them now.

**`skills/executing-plans/SKILL.md`,** whole file:
```markdown
---
name: executing-plans
description: Use when you have an approved implementation plan to carry out yourself, because `delegate` isn't available or the plan is only one or two small tasks.
metadata:
  roles: [main]
---

# Executing plans

You carry out the plan alone, with the run, gate, review and rulings the crew would use. The core principle: **the decisions are made; carry them out and prove it.** The proof is a test that failed before your change and passes after it; the run's ledger keeps what a compaction would erase.

## When to use

- There's no `delegate` tool in this session.
- A plan of one or two small tasks, where a coder and reviewer per task cost more than they save.
- Not for a longer plan when `delegate` is available: load `subagent-driven-development`.

## Steps

1. **Read the plan and its spec once.** The spec is binding. Rule on any conflict between tasks, or with the Global Constraints, before you start.
2. **Open the run,** or resume it, by the rule in `subagent-driven-development`: in a registered project, `run` with action `open` (its branch is the plan branch); elsewhere, a ledger file. After a compaction, trust `run` action `status` and `git log` over memory.
3. **Never work on the default branch.** Load `using-git-worktrees`.
4. **Load `test-driven-development`** before Task 1.
5. **For each task:**
   1. Record BASE and re-read the task's text, not your memory of it.
   2. Write the failing tests it names, run them, and watch them fail for the right reason.
   3. Implement, then run the tests and the gate. Compare the output with what the plan expects.
   4. If the code is wrong, load `systematic-debugging`. If the plan is wrong, make the smallest decision the spec supports and record it with `run` action `ruling`: what, why, cost if wrong.
   5. Commit with the plan's message. Load `verification-before-completion`, then record `Task N: complete (base..head, gate: <command> → exit 0)` with `run` action `note` straight away.
6. **Review the whole branch.** With `delegate`, delegate a `reviewer` with `reviews: "main"` and `final: true`, and load `requesting-code-review`. Without it, review your own diff against the spec and the Review Focus, say in your final message that a self-review is weaker than a cross-family one, and give `open_pr` your `reviewRuling`.
7. **Fix blocking and should-fix findings once,** each test first, with the whole gate after each, then have the reviewer look at the new head (`to` the same reviewer). Defer nits with `run` action `defer`. A finding you decline is a ruling.
8. **Load `finishing-a-development-branch`.**

## Rules

- Don't check in between tasks. Stop only for an irreversible or security-sensitive action, a merge into the default branch, or a plan too broken to continue. Bringing a task branch onto the plan branch is routine.
- One `note` per task, recorded with its commit.
- "It should pass" isn't evidence. Run it and read the exit code.
- A deviation from the plan without a ruling is a secret decision.

## Hand back

The pull request's URL, the tasks with their commits, the gate command and its exit code on the final tree, which review was done (cross-family or self-review), the deferred findings, and a **Rulings** section listing every ruling in order, each with its cost if wrong.
```

**`skills/finishing-a-development-branch/SKILL.md`,** whole file (about 4700 characters):
```markdown
---
name: finishing-a-development-branch
description: Use when every task on a branch is done and reviewed and the work needs wrapping up, before you report it finished or open its pull request.
metadata:
  roles: [main]
---

# Finishing a development branch

A branch isn't done when its last task is. It's done when the final tree passes the gate, the final review approved it, and its pull request is open. The core principle: **humans merge.** You verify, dish opens the pull request, and the user decides.

## When to use

- At the end of `subagent-driven-development` or `executing-plans`, or whenever you're about to call a branch ready.
- Not while a review still has an open blocking or should-fix finding.

## Steps

1. **The gate on the final tree:** the branch's tip, not a task's worktree, and not "it passed earlier". In a run, `open_pr` runs the project's gate on the head it pushes; elsewhere, run it yourself and read the whole output and the exit code. If it's red, fix it through a coder in a new worktree from the plan branch, bound with `delegate`'s `worktree` in a registered project (yourself without `delegate`).
2. **Settle the final review.** If no whole-branch review has run, run one (load `requesting-code-review`): a `reviewer` with `final: true`. Fix blocking and should-fix findings, and rule on the rest. It must approve the head you push, so after any later commit, a re-review of the new head.
3. **Confirm the base branch.** A run's pull request goes to the project's default branch. Elsewhere, if your notes don't record the base, check with `git merge-base` and ask the user. A wrong base is expensive to undo.
4. **Open the pull request with `open_pr`,** in a run: a `title`, and a `body` you write, following the repo's conventions: what changed, why, how it was tested, and the rulings a reviewer should see. dish pushes the run's branch and opens the pull request, but only when the gate passes on the head and the final review approved that head. Otherwise it refuses and says why: fix it and call again. Rule past a check only on purpose, with `gateRuling` or `reviewRuling` (`Ruling: what — why — cost if wrong`): dish adds a line to the body saying so. A rejected push fails with GitHub's reason, such as the branch having moved or the App lacking a permission (Workflows, for a change under `.github/workflows/`): tell the user. Report the URL. The run ends there.
5. **Never push yourself.** In a registered project (your chat's workspace is a clone dish set up: `git config --get-regexp '^credential\..*\.helper$'` names `git-credential-dish`), never `git push` or `gh pr create`: agents' git there is read-only by design, and only `open_pr` pushes. A 403 isn't the remote moving, and never look for other credentials. Elsewhere there is no `open_pr`: report the branch ready and stop; the user pushes it. Review feedback on an opened pull request: `run` action `resume` with the run's id reopens it; fix it in rounds as before, then `open_pr` again, which pushes to the same pull request.
6. **The user merges.** If they tell you in so many words to merge this branch, confirm the target, then merge, and run the gate on the merged result before deleting anything. If it fails, stop and leave everything in place.
7. **Clean up only what you created:** the task worktrees you made for this plan and haven't removed (`run` action `status` lists them), once their commits are on the branch. Leave the run's own worktree: the sweep removes it once its pull request merges.
   - Worktrees made by the `worktree` tool go with `worktree` action `remove`, never `git worktree remove`: dish made them, and the tool also takes the branch and the record. The sweep removes merged ones by itself, so one already gone is fine.
   - `remove` refuses one that isn't merged into `origin/<default>` or is dirty. A task worktree cut from the plan branch usually isn't merged there, and a cherry-picked one never is. If `git -C <path> status --short` is empty, `git -C <path> branch --show-current` prints `dish/<slug>`, and `git -C <path> cherry <plan branch>` lists no `+` line, its work is on the plan branch: set `force`. Otherwise show what exists only there and ask; `force` it only when the user says to discard it.
   - Worktrees made with plain git (a repo that isn't a registered project) go with `git worktree remove`, never `--force`.
   - Never touch other worktrees, the user's own checkout, or branches you didn't create. Discard work only when the user says so in as many words.

## Hand back

The gate command with its exit code on the final tree, the review verdict, the pull request's URL or the branch, the worktrees removed and kept, the deferred findings, and a **Rulings** section listing every ruling in order, each with its cost if wrong.
```

**`skills/using-git-worktrees/SKILL.md`:**
- **Line 23,** the "In a registered project" bullet:
  - **Old:** `Read its answer: the path, the branch, the base commit, and whether setup ran.`
  - **New:** `Read its answer: the path, the branch, the base commit, whether setup ran, and the run it joined. While your chat drives a run, the worktree is one of its tasks; with none, dish opens a run around it, and you name its goal with `run` action `goal`. For a plan, open the run first (`run` action `open`): its branch is the plan branch, and the tasks' worktrees are cut from it.`
- **Line 32:** `- Never work on the default branch (`main`, `master`), and never push to it.` → `- Never work on the default branch (`main`, `master`). Never push: in a registered project only `open_pr` pushes, and elsewhere the user does.`

**`skills/requesting-code-review/SKILL.md`:**
- **Line 27:**
  - **Old:** `- for a re-review: the earlier findings, the coder's `Not fixed:` lines with their evidence, and the fix's range, asking ADDRESSED or NOT ADDRESSED for each, and new breakage in the fix only;`
  - **New:** `- for a re-review: the earlier findings, the coder's `notFixed` entries with their evidence, and the fix's range, asking whether each is addressed, and new breakage in the fix only;`
- **Line 28:**
  - **Old:** `- the report shape: a verdict, then findings, each with a severity (blocking, should fix or nit), `file:line`, the concrete failure and the fix, plus the gate output and exit code.`
  - **New:** `- that it finishes with `report`: its `verdict`, the `head` it reviewed, and `findings`, each with a severity (`blocking`, `should_fix` or `nit`), the file and line, the concrete failure and the fix, with the gate and its exit code in `checks`.`
- **Line 31:** `For a final review, set `model` to the strongest model of the reviewer's family.` → `For the final review, set `final: true`, and `model` to the strongest model of the reviewer's family: `open_pr` needs its approval of the head it pushes.`
- **Line 33:** `**Nits:** ledgered as deferred.` → `**Nits:** deferred with `run` action `defer`.`
- **Line 34:** `…(load `receiving-code-review`) and record a ruling.` → `…(load `receiving-code-review`) and record a ruling (`run` action `ruling`).`
- **Line 46:** `…to the user if they asked, otherwise in the ledger.` → `…to the user if they asked, otherwise in the run's ledger.`

**`skills/reviewing-work/SKILL.md`:**
- **Line 26:** `(blocking, should fix, or nit)` → `` (`blocking`, `should_fix` or `nit`) ``.
- **Line 27:** `When there are none, say "No findings."` → `When there are none, `findings` is empty and your summary says so.`
- **Line 32:** `- Mark each finding ADDRESSED or NOT ADDRESSED, with a file and line. An attempt isn't ADDRESSED: the failure must be gone.` → `- Mark each finding in `addressed`: whether it is addressed, with the evidence (a file and line). An attempt isn't addressed: the failure must be gone.`
- **Line 34:** `- List anything outside the fix diff under "Out of scope". It doesn't block.` → `- Name anything outside the fix diff as out of scope in your summary. It doesn't block.`
- **Line 48** (Hand back), the whole paragraph:
  > Finish by calling `report`: `verdict` `approved` only when no finding is `blocking` or `should_fix`, else `changes_requested`; the `head` you reviewed (`git rev-parse HEAD` where the work is); a `summary` with the spec-compliance and quality verdicts; the `findings`, ranked; the gate and the other commands you ran in `checks`, each with its exit code and summary line; and in a re-review, `addressed`. No preamble.

**`skills/test-driven-development/SKILL.md`:**
- **Line 29:** after `…and check its exit code.` add ` A coder whose brief says dish runs the gate leaves that run to dish: dish runs it when you `report` `done`, and a failure comes back to you.`
- **Line 45:** `Then the gate command, its exit code and its summary line.` → `Then the gate command, its exit code and its summary line, or that dish runs it.`

**`skills/verification-before-completion/SKILL.md`:**
- **Line 28:**
  - **Old:** `- **coder:** the repo's gate on your final tree, exit code 0. Done means the gate passed. For a bug fix, the test that reproduced the bug now passes.`
  - **New:** `- **coder:** the repo's gate on your final tree, exit code 0: done means the gate passed. When your brief says dish runs the gate, dish runs it when you `report` `done`, and a failure comes back to you; you run the tests your change touches. For a bug fix, the test that reproduced the bug now passes.`
- **Line 30:** `…(`git log`, `git diff BASE..HEAD`), the gate, and the files it says it wrote.` → `…(`git log`, `git diff BASE..HEAD`), the gate (a notice's gate line is dish's own run), and the files it says it wrote.`

**`skills/receiving-code-review/SKILL.md`:**
- **Line 33:**
  - **Old:** `9. If you have `bash`, run the repo's gate after the last fix and read its exit code. Without it, re-read each changed passage against its source, and say the gate wasn't run.`
  - **New:** `9. If you have `bash`, run the repo's gate after the last fix and read its exit code; when your brief says dish runs the gate, dish runs it when you `report` `done`. Without `bash`, re-read each changed passage against its source, and say the gate wasn't run.`
- **Line 49:** after `…and anything still open.` add ` A coder puts these in `report`: the fixes in `summary`, and each `Not fixed:` line as an entry of `notFixed`.`

**`skills/systematic-debugging/SKILL.md`:**
- **Line 36:** `3. Run the test, then the gate, and check the exit codes.` → `3. Run the test, then the gate, and check the exit codes. When your brief says dish runs the gate, dish runs it when you `report` `done`: run the tests your fix touches.`
- **Line 55:** `…and the gate result with its exit code.` → `…and the gate result with its exit code, or that dish runs it.`

**`skills/changing-infrastructure/SKILL.md`, line 19:** `Pushing, the pull request and the apply wait for the main agent's go-ahead.` → `Don't push: the main agent opens the pull request with `open_pr`, and the apply waits for its go-ahead.`

**Tests:**
- **`plugins/prompts/test/pipeline-texts.test.ts`** (new):
  - **`main.md has a Runs section between Delegate and In the chat, naming run, open_pr and final review`:**
    - the order of `## Delegate`, `## Runs` and `## In the chat`;
    - the section matches `/action `open`/`, `/action `status`/`, `/`ruling`/`, `/`open_pr`/`, `/`final: true`/`, `/pushes to the same pull request/` and `/no `git push`, no `gh pr create`/`;
    - `main.md` doesn't match `/, a push\)/`.
  - **`main.md no longer stops for pushes, and open_pr isn't a stop`:** `Decide and record` doesn't match `/pushes and merges/`, and matches `/`open_pr` isn't one of them/`.
  - **`common.md's first house rule opens pull requests with open_pr, and agents don't push`:**
    - the first bullet under `## House rules` starts `- Humans merge.` and holds `` `open_pr` `` and `agents don't push`;
    - `common.md` doesn't match `/Open pull requests\./`.
  - **`the coder finishes with report, and leaves the gate to dish when its brief says so`:**
    - matches `/Finish by calling `report`/`, `/`status`/`, `/`notFixed`/` and `/dish runs it when you `report` `done`/`;
    - doesn't match `/Run the repo's gate before you say you're done/`.
  - **`the reviewer finishes with report, with its verdict and the head it reviewed`:** `/Finish by calling `report`/`, `/`verdict`/`, `/`head`/`, `/`should_fix`/`.
  - **`the other crew prompts have no report`:** architect, ops, researcher and writer don't match `/`report`/`.
- **`plugins/skills/test/defaults.test.ts`:**
  - **Replace `PREVIOUS lists the earlier texts of exactly the three skills that moved to the worktree tool`** with `PREVIOUS lists the earlier texts of exactly the skills whose shipped text changed`:
    - `STEP7_SKILLS = ['executing-plans', 'requesting-code-review', 'reviewing-work', 'test-driven-development', 'verification-before-completion', 'receiving-code-review', 'systematic-debugging', 'changing-infrastructure']`;
    - the keys are `[...WORKTREE_SKILLS, ...STEP7_SKILLS].map(pathFor)`;
    - the same no-self-hash and frozen checks.
  - **In `the worktree skills use the worktree tool…`,** replace `assert.match(finishing, /in a registered project \(.*\), don't push\. Agents' git there is read-only/)` with `assert.match(finishing, /In a registered project \(.*\), never `git push` or `gh pr create`: agents' git there is read-only by design, and only `open_pr` pushes/)`. Mind the capital `I`: step 5 now opens with it, and step 1's lowercase "in a registered project (yourself…" is on another line. Every other assertion there stays and must pass on the new texts.
  - **New: `the pipeline skills use the run, report and open_pr (step 7)`:**
    - **driven:** `/`run` with action `open`/`, `/action `status`/`, `/`final: true`/`, `/`delegate`'s `ruling`/`, `/`report`/`, `/`notFixed`/`;
    - **driven and executing:** neither has `/ledger\.md`/` outside the `Elsewhere` line. Test that `.worktrees/<plan file name>-ledger.md` appears only on that line of driven, and not in executing;
    - **finishing:** `/`open_pr`/`, `/`gateRuling` or `reviewRuling`/`, `/never look for other credentials/`, `/action `resume` with the run's id reopens it/`; doesn't match `/push the branch/i` or `/a new run, with `base`/`;
    - **using:** `/`run` action `open`/`, `/`run` action `goal`/`;
    - **requesting:** `/`final: true`/`, `/`report`/`, `/`should_fix`/`; doesn't match `/ADDRESSED/`;
    - **reviewing:** `/Finish by calling `report`/`, `/`verdict`/`, `/`head`/`, `/`addressed`/`; doesn't match `/ADDRESSED/`.
  - **New: `the coder's skills leave the gate to dish when the brief says so`:** `test-driven-development`, `verification-before-completion`, `receiving-code-review` and `systematic-debugging` each match `/dish runs it when you `report` `done`/`.
  - **New: `no shipped skill tells an agent to push`:** in every shipped skill, the number of matches of `` /`git push`/g `` equals the number of matches of ``/never `git push` or `gh pr create`/g``, and `/gh pr create/g` likewise. Only finishing has either, once.
- **Must stay green:**
  - `skills-mentioned.test.ts` (rules 8 and 9);
  - `previous.test.ts` and the skills drift test;
  - `plugin.test.ts` in both plugins (an unedited earlier default is replaced, an edited one kept);
  - `preview.test.ts` and `persona.test.ts` (`main.md` keeps `{{model}}` as its only variable, `common.md` keeps `{{cwd}}` and its last line);
  - the skills' `every shipped skill is a valid skill, with no warnings`.

**Steps:**
- [ ] Write the failing tests first. Run them, and watch the new ones fail on the current texts.
- [ ] Edit the four prompts and the eleven skills as above. Check the length of `subagent-driven-development` (`node -e "console.log(require('fs').readFileSync('plugins/skills/defaults/subagent-driven-development/SKILL.md','utf8').length)"` prints at most 8000).
- [ ] Regenerate both `previous.json`, with the new texts in the working tree and not yet committed:
  ```bash
  node packages/dish-kit/scripts/previous-defaults.mjs plugins/prompts/defaults prompts/
  node packages/dish-kit/scripts/previous-defaults.mjs plugins/skills/defaults skills/ --exclude NOTICE.md
  ```
  The script hashes every committed version except the working tree's. Check `git diff -- '*/previous.json'`:
  - prompts: exactly one hash added to each of `prompts/main.md`, `prompts/common.md`, `prompts/crew/coder.md` and `prompts/crew/reviewer.md`;
  - skills: one hash added to each of the three existing entries, and eight new entries with one hash each;
  - each added hash is `git show HEAD:<the file> | sha256sum`;
  - nothing else changes.
- [ ] Run the gate.
- [ ] Commit the texts and both `previous.json` together: `dish-prompts, dish-skills: runs, report and open_pr in the shipped texts`.
- [ ] **After the final review** (the controller, before the branch goes to the user):
  - Any later change to one of these texts is committed as `fixup! dish-prompts, dish-skills: runs, report and open_pr in the shipped texts`, with both `previous.json` regenerated in it, so the gate stays green.
  - Once the final fix round is in, squash those fixups into Task 12's commit: `git rebase --autosquash <Task 12's parent>`. That is non-interactive in git ≥ 2.44, and the plan branch's history is linear (tasks land by fast-forward or cherry-pick).
  - Then run the two commands above again, so `previous.json` lists only texts that shipped (main's), not the drafts. Commit the result as `dish-prompts, dish-skills: previous.json lists only shipped texts` if it changed, and run the gate.
  - Without fixups, there is nothing to do.

## Task 13: deploy, docs, and the end-to-end run

**Needs:** all (Tasks 0–12).

**Files:**
- **Deploy:**
  - `deploy/install.sh`:
    - `bundles=(copilot config prompts skills crew judge web projects workspaces gates orchestrator)`;
    - the comment above it ends "…gates after them, and orchestrator last (it reads crew, gates, workspaces and projects)".
  - `deploy/test/install.test.ts`:
    - `BUNDLES` gains `'dish-orchestrator'`;
    - the three `bundles added:` / `already linked:` assertions (lines 244, 269, 304) end `… workspaces gates orchestrator`.
  - `deploy/README.md`:
    - **"The state":**
      - `~/.local/state/dish` gains "`orchestrator/<owner>/<repo>/runs/<id>.json`, the run records of [`dish-orchestrator`](../plugins/orchestrator/) (0600 in 0700 directories)";
      - `~/.local/share/dish` becomes "crew's records, and `ledgers/<owner>/<repo>/<id>.jsonl`, each run's ledger (append-only, 0600 in 0700 directories, never pruned)".
    - **install.sh step 4:** the list ends "…workspaces, gates and orchestrator", and the reason ends "…gates after them, since it reads crew, projects and workspaces, and orchestrator last, since it reads crew, gates, workspaces and projects".
    - **"Rolling back past step 7",** after the 6c paragraph:
      - first, `… pnpm exec dsh plugin --profile web remove dish-orchestrator`, in the same form as the 6c command;
      - an older crew drops the `report`, `run`, `task` and `final` fields when it next writes a child's record;
      - run records and ledgers stay where they are;
      - the store's prompts and skills stay at step 7's texts, which name `run`, `report` and `open_pr`, because an older `previous.json` doesn't know them. Reset main, common, coder and reviewer on Settings → Prompts, and the eleven changed skills on Settings → Skills.
    - **"The GitHub App":**
      - "read-only for now" → "read for agents' git, write only for `open_pr` (step 7)";
      - the "Agents' git" bullet's last sentence → "Only `open_pr` pushes: a write token dish mints in memory for that one push, to the project's HTTPS URL, never forced";
      - a new bullet, **Write permissions:** Contents and Pull requests write, which each installation accepts once, and rulesets on each project's default branch, with a pointer to [the rollout](../docs/plans/2026-10-03-orchestrator.md#the-rollout-for-you).
    - **Security notes,** the reads bullet: "…the GitHub App's private key, which is why the App is read-only for now" → "…the GitHub App's private key. Since step 7 the App can write, for `open_pr`, so an agent set on it could mint a write token and push a branch; GitHub rulesets on each project's default branch keep anything from reaching it without a person's merge ([the orchestrator spec, question 1](../docs/specs/orchestrator.md#questions-for-you))".
- **Plugin docs:**
  - **`plugins/orchestrator/README.md`, complete** (create it, or finish Task 0's stub). Its sections:
    - what it does (the spec's Summary, in five bullets);
    - **Install:** `install.sh` links it last; it needs nothing at load and reads `dishCrew`, `dishGates`, `dishWorkspaces`, `dishProjects` and `agents` with `ctx.get`; without crew it records only what `worktree` and `run` give it;
    - **Runs:** open, the automatic open from `worktree`, tasks, the id rule, driving and liveness, resume and takeover, abandon;
    - **The ledger:** the path, the line format, the two kind tables with `by`, append-only and kept forever, the 16 KiB cut and masking;
    - **The tools:**
      - `run`'s actions and parameters, and `resume` reopening a run with a pull request;
      - `open_pr`'s seven steps, its two rulings and the two override lines word for word, what a rejected push says, and what it does on a reopened run (`pr.updated`, the comment);
      - both tools refuse a crew child;
    - **The ladder:** advisory 1–4 and the refusal at round 5, as crew applies it, read from `dishRuns.ladder`;
    - **Settings → Runs:** read-only, order 51;
    - **The service:** `dishRuns`, the signatures as Task 8 gives them;
    - **Files:** the record and ledger paths in dev (`.dev/…`) and on the VM;
    - **Configuration:** the `terminal` row;
    - **Known limits:**
      - a key reader can push a non-default branch;
      - a pull request closed on GitHub without a merge gets a new one on the run's next `open_pr`; one merged has its worktree swept, so its run can't be reopened;
      - a ledger read mid-append shows a torn last line until the next append.
  - **`plugins/crew/README.md`:**
    - the intro bullet "Children report once, in their closing message." → coders and reviewers report with `report`, which ends their turn; the other roles in their closing message;
    - **A new "### Reports" section:**
      - the tool and both schemas;
      - registered on the child's own scope at `agent/created`, through a cold resume too;
      - the steer and `reportSteers` (`0` turns the steer off, not the tool);
      - `reportNote`, the closing note coders and reviewers get, and the report guard's words for them;
      - a later `report` in the same turn replaces the earlier one;
      - the `<n>-<role>-<run>.json` file;
      - the notice built from the report, and what it says without one;
    - **A new "### Runs and the ladder" section:**
      - `delegate`'s `ruling` (`gateOverride` its synonym), `final` (sticky on the record), and the run and task tags from `dishRuns.place` (a run ref; a bound child in the run that owns its worktree);
      - the advisory `note` and the refusal at round 5;
      - the `dish-crew/delegated` and `dish-crew/settled` events;
      - `run` and `open_pr` on the `NEVER` list;
    - the "Gates" section's quoted brief sentence, as Tasks 2 and 5 left `worktreeBrief`;
    - "What crew records": `report`, `run`, `task`, `final` and the `.json` file;
    - a Configuration row for `reportSteers`.
  - **`plugins/gates/README.md`:**
    - "When." and steps 1 and 5 of "A gated stop": the gating rules with `report` (the contract's "gating with `report`"), `reportSteered`, and the opt-outs kept;
    - "The message to the coder": the steer text Task 5 wrote;
    - "The record": `GateResult.head`;
    - "The service": `runAt`, with its signature from Task 5, and the `dish-gates/result` event;
    - "Install": "`deploy/install.sh` links it after workspaces; orchestrator comes last";
    - the "Gates can run twice" limit → "Since step 7, coders' prompts and skills leave the gate to dish when their brief names it; a plan's task steps may still say to run it (writing-plans)".
  - **`plugins/workspaces/README.md`:** Task 6 wrote its Credentials, push helper, "Pushes and pull requests", service, `worktree` tool, App and decision 2 texts. Check they match what was built (`commentPull`, the hooks outside the lock, the rulesets with an approval), fix what doesn't, and add only:
    - line 5's "read-only in 6b" → "read tokens for agents' git; `open_pr`'s pushes, pull requests and comments use a write token minted in memory per call (step 7)";
  - **`plugins/projects/README.md`:**
    - line 6: "[dish-gates](../gates/) reads `gate`, `gateTimeout` and `gateEnv` from it" + ", for a coder's gate and for `open_pr`'s check of a run's head";
    - line 45's `gate` row: + "and that `open_pr` runs on a run's head before it opens a pull request".
- **Root docs:**
  - **`README.md`:**
    - `pnpm dsh plugin --profile web add ./plugins/orchestrator` after gates in the by-hand list;
    - an `orchestrator` row in the plugin table: runs, the ledger, `run` and `open_pr` with their checks, Settings → Runs;
    - the crew row: "Coders and reviewers finish with a structured `report`.";
    - the workspaces row: "(agents can fetch, not push)" → "(agents' git can fetch, not push; only `open_pr` pushes, with a write token dish mints in memory)".
  - **`ROADMAP.md`:**
    - row 7 → "`orchestrator` ([spec](docs/specs/orchestrator.md)): runs owned by the project, a ledger per run written by the harness, structured reports for coders and reviewers, the ladder's last rung, `open_pr`, Settings → Runs. The dish preset stays with crew." with the status "built on branch `orchestrator`, [spec], [plan]; checked end to end in a scratch dsh; awaiting review and the rollout";
    - row 8's "ledger" → "ledger (builds on step 7's runs)".
  - **`docs/design.md`:**
    - **The Storage table:**
      - Data: `ledgers/<owner>/<repo>/<run>.jsonl`, each run's ledger, written by `orchestrator`, kept forever; the "until `orchestrator`…" parenthesis becomes "outside a registered project, the skills keep a plan's ledger in `.worktrees/<plan>-ledger.md`";
      - State: + "run records (`orchestrator/<owner>/<repo>/runs/`)".
    - **The crew table:** main "keeps the ledger" → "records its rulings in the run's ledger".
    - **The pipeline:**
      - step 2: "pushes and merges" → "merges";
      - step 4 ends "From round 5, `delegate` refuses more coder work on the task unless the main agent rules (step 7).";
      - step 5 → "Final whole-branch review, then `open_pr`: dish pushes the run's branch and opens the PR when the gate passes on its head and the final review approved that head. A human merges."
    - **The plugin table:**
      - orchestrator: provides `dishRuns`; nothing at load, reads `dishCrew`, `dishGates`, `dishWorkspaces`, `dishProjects` and dsh's `agents` with `ctx.get`; owns runs, ledgers, `run`, `open_pr` and Settings → Runs. "The dish preset stays in `crew`." Drop "the main-agent preset";
      - crew: + `report`, the events, `ruling` and `final`;
      - gates: + gating after `report`, `runAt`, `dish-gates/result`;
      - workspaces: + `headOf`, `isClean`, `pushBranch`, `openPull`.
    - **The lessons bullet** "Don't trust the main agent's account of events": + "(step 7: the run's ledger does, from listeners; the main agent's own entries are marked `by: main`)".
    - **Open question 5:** "which `crew` owns until `orchestrator`" → "which `crew` owns (step 7 left it there)".
  - **`HANDOFF.md`:**
    - "What dish is": + a bullet "**The pipeline:** runs with a harness-written ledger, structured reports, and `open_pr`".
    - "Next" item 1 → 7 `orchestrator`: built on branch, checked end to end, awaiting review and [the rollout](docs/plans/2026-10-03-orchestrator.md#the-rollout-for-you). Fold 6c's "still to see live" into its live run.
    - Item 4's "and check that an agent can push a branch" → "with Contents and Pull requests write from the start; an agent's own `git push` stays refused (403) by design: only `open_pr` pushes" (spec question 2).
    - The GitHub App paragraph: "Until then an agent's `git push` gets 403, though the prompts already tell agents to open pull requests." → "Agents' own pushes get 403 by design; `open_pr` pushes."
    - The known limit "The GitHub App is read-only, so agents never push…" → "Agents never push: their git gets read tokens. Only `open_pr` pushes, after its checks. The App's key is readable by agents, so the rulesets on default branches are what keep a key reader from reaching them."
    - "Reading a session": + "a run's ledger under `~dish/.local/share/dish/ledgers/<owner>/<repo>/`, and Settings → Runs".
- **The specs:**
  - **`docs/specs/orchestrator.md`:**
    - the status line + "Built on branch `orchestrator` (<date>) and checked end to end in a scratch dsh; awaiting review and the rollout. What the build added is under [Notes from the build](#notes-from-the-build).";
    - a last section, `## Notes from the build`, with what the build decided beyond the spec as revised on 2026-10-03 (the plan's Spec corrections are in the spec already), from the controller's ledger and the tasks' reports (the controller passes them in the brief), grouped as Runs, The ledger, Reports, Gates, The ladder, The PR, Prompts and skills. It ends with **End to end (<date>):** what the run below showed.
  - **`docs/specs/crew.md`:**
    - a new section "## Reports, runs and the ladder (step 7)" before "## Gates (6c)": what the README sections say, the closing note and the report guard's words for coders and reviewers, pointing to the orchestrator spec for the schemas;
    - line 178's "`orchestrator` takes the preset over in step 7." → "Step 7 left the preset here.";
    - a Configuration row for `reportSteers`;
    - Notes from the build: what Tasks 1–4 decided. The dated decisions (line 23) stay as written.
  - **`docs/specs/gates.md`:**
    - line 42's non-goal + " (built in step 7: [orchestrator](orchestrator.md))";
    - a short section "## With structured reports (step 7)" before "## Testing": the gating rules with `report`, `reportSteered`, the steer text, `head`, the event, `runAt`.
  - **`docs/specs/projects-workspaces.md`** (decision 9 is now built). Don't rewrite the dated text:
    - line 18 "(step 7)" → "(built in step 7: `open_pr`)";
    - decision table row 7 "write comes in step 7" → "write came in step 7 (Contents and Pull requests, for `open_pr`)";
    - row 9 → "Only the harness: `open_pr` (built in step 7, [orchestrator](orchestrator.md))";
    - line 136, write tokens → "`pushBranch` and `openPull` mint one per call, in memory (step 7)";
    - line 279, Decided: add one sentence, "Since step 7: write was added, and the key was answered with GitHub rulesets on default branches, not a broker ([orchestrator spec](orchestrator.md#questions-for-you), 1).";
    - line 376, known limit: the same.
  - **`docs/specs/prompts.md`:**
    - line 18's "Main agent before `orchestrator`" → "Main agent";
    - line 112 → "Step 7 (`orchestrator`) left the preset in `crew`.";
    - the Defaults table's `common`, `main`, `coder` and `reviewer` rows to match Task 12.
  - **`docs/specs/skills.md`:**
    - the Shipped skills rows of the eleven changed skills, one line each, as Task 12 left them;
    - line 310 → "Step 7 (`orchestrator`) moved the ledger into the run, and left the skills here.";
    - line 327: + "In a registered project the run's ledger replaces it (step 7)".
  - **`docs/specs/deploy.md`,** line 3: "`install.sh` links nine bundles" → "eleven bundles".

**Steps:**
- [ ] Edit the files. Run the gate. Then run the install test in the Global Constraints' scratch environment, and check both exit codes:
  ```bash
  DISH_INSTALL_TEST=1 TMPDIR=<scratch>/tmp node --test --test-timeout=900000 deploy/test/install.test.ts
  ```
- [ ] **The end-to-end run, by hand, scratch only.** It checks the spec's live check with dsh's real agent loop: a planned run with two tasks, a failing gate fixed in its second round, reviews (one steered to `report`), the round-5 refusal and a ruling, the main agent's entries, a final review, and `open_pr`. Then a planless run: opened by `worktree`, a coder that never reports, and `open_pr` past a missing final review with `reviewRuling`. Then review feedback on the first run's pull request: the run reopened, a fix, and `open_pr` pushing to the same pull request, its override posted as a comment. `<s>` is the scratch root and `<w>` this worktree.
  1. **The environment.** As in the gates plan's Task 8:
     - every variable set through `env -i`: scratch `HOME`, `DSH_HOME=<s>/dsh`, `XDG_*`, `DSH_DISH_HOME=<s>/inst`, `TMPDIR` and `HISTFILE`; `PATH` with Node and pnpm; `pnpm_config_store_dir`; for git, `GIT_CONFIG_NOSYSTEM=1` and a test identity;
     - record `find <s> | sort` and `stat -c '%Y %s' ~/.bash_history`.
  2. **The install.**
     - From `<w>`: `DISH_REMOTE='' DISH_USER_NAME=t DISH_USER_EMAIL=t@t.invalid DISH_PROFILE=web deploy/install.sh`. Expect `bundles added: … workspaces gates orchestrator`.
     - Then, in the scratch profile only, with `DSH_DISH_HOME` unset as the install test does: `pnpm exec dsh plugin --profile web remove dish-workspaces dish-judge`, then `pnpm exec dsh plugin --profile web add <s>/e2e-workspaces` (step 3). Don't run `install.sh` again after this.
     - Why:
       - the stub GitHub's URLs reach dish-workspaces only through `start(ctx, config, internals)` (`plugins/workspaces/src/index.ts:82`; never config);
       - the judge, with no TypeSafe key, would refuse every child's command.
  3. **The wrapper, `<s>/e2e-workspaces/`** (not committed):
     - `package.json`: name `dish-e2e-workspaces`, `"type": "module"`, `"main": "./index.ts"`, keyword `dsh-plugin`, `dsh.bundle.patch` `./cordis.patch.yml`;
     - `cordis.patch.yml`: inserts `{ id: dish-e2e-workspaces, name: dish-e2e-workspaces }`;
     - `index.ts`:
       - imports `Config` and `start` from `<w>/plugins/workspaces/src/index.ts` by absolute path;
       - exports `name = 'dish-e2e-workspaces'` and `Config`;
       - `apply(ctx, config)` calls `start(ctx, config, { api, web })`, read from `<s>/stub.json`. `web` is the push's seam too: `pushBranch` pushes to `httpsUrl(web, …)`, the fake git server, and production can't set it (Task 6).

     If dsh won't load it, stop and report `NEEDS_CONTEXT`.
  4. **The stub GitHub, `<s>/stub.ts`** (not committed), run with `node` in the background. It reuses `<w>/plugins/workspaces/test/fake-github-api.ts` and `fake-git-http.ts` as Task 6 left them (write permissions, `POST /repos/{o}/{r}/pulls`, the existing-PR lookup, issue comments). They are wired as `test/service-helpers.ts:160-175` does:
     - `testKeys()`; the private key PEM to `<s>/app-key.pem`, mode 0600. It is a throwaway, never printed;
     - `startFakeGit(<s>/git-root)`, with a bare `bketelsen/orch-e2e.git` seeded from a scratch repo whose `main` holds `README.md` and `docs/plan.md` (two tasks, "a.txt" and "b.txt");
     - `startFakeGitHub({ publicKey })`, an installation for `bketelsen` with `orch-e2e`, and `onToken((token, permissions) => git.tokens.set(token, permissions.contents === 'write' ? 'write' : 'read'))`;
     - `<s>/stub.json`: `{ api, web: git.origin, appId }`, no secret;
     - **On SIGUSR2:** read every file under `<s>` and print the paths of those holding any write token it minted. Never print the token.
     - **On SIGTERM:** print each pull request opened (number, head, base, title, body), each comment (its pull request's number and body), and each mint's permissions, then close.

     The fakes import `after` from `node:test`; outside a test run that is harmless.
  5. **The scripted model, `<s>/model.ts`** (not committed), modelled on the gates run's:
     - an OpenAI-compatible server on `127.0.0.1:0`;
     - `<s>/overlay.yml` gives `dsh-llm-pi-ai` a provider `fake` (`api: openai-completions`) with `fake-main`, `claude-fake` and `gpt-fake`, and gives `agent-default-model` `fake-main`;
     - it logs each request's agent, the rule that fired and its tool call to `<s>/model.log`.

     **Routing,** by the request's tools:
     - `delegate`: the main agent;
     - `write` and `report`: a coder;
     - `report` without `write`: a reviewer;
     - no tools (a title): the text `e2e`.

     Rules go by the last message. Paths are `<s>/inst/work/bketelsen/orch-e2e/.worktrees/<slug>`. Notices are recognized by their child's title.

     **The main agent, run 1:**
     1. On "go": `run` `{ action: 'open', project: 'bketelsen/orch-e2e', slug: 'e2e', goal: 'Add a.txt and b.txt', plan: 'docs/plan.md' }`.
     2. Then `worktree` create `task-a` with `base: 'dish/e2e'`.
     3. Then `delegate` a coder, title `task a`, `worktree: 'bketelsen/orch-e2e/task-a'`, task "Create a.txt and commit it.". After any `delegate` result, the text "waiting".
     4. On task a's notice: `delegate` a reviewer, title `review a`, `reviews` that coder's id, a task naming its worktree path.
     5. On review a's notice: `bash` `git -C <run worktree> merge --ff-only dish/task-a`, then `worktree` remove `task-a` with `force`.
     6. Then `worktree` create `task-b` (base `dish/e2e`), and `delegate` coder `task b`.
     7. On each of task b's notices, while fewer than four follow-ups were sent: `delegate` `{ to: <b>, task: 'Check b.txt again.' }`. On the fifth: the same call, which `delegate` refuses. On that refusal: the same call with `ruling: 'Ruling: one more pass on task-b — checks the ladder — none'`.
     8. On task b's notice after it: reviewer `review b`, then the merge and the `force` remove of `task-b`.
     9. Then `run` `ruling` `{ what: 'b.txt stays short', why: 'the plan says one line', costIfWrong: 'a later edit', task: 'task-b' }`, `run` `defer` `{ what: 'tidy b.txt', where: 'b.txt', why: 'a nit' }`, and `run` `note` `{ text: 'Task 2: complete' }`.
     10. Then `delegate` a reviewer, title `final review`, `final: true`, `reviews` coder b's id, a task naming the run's worktree.
     11. On its notice: `run` `status`, then `open_pr` `{ title: 'Add a.txt and b.txt', body: 'Adds a.txt and b.txt, per docs/plan.md.' }`, then text with the URL.

     **The main agent, run 2:**
     1. On "small": `worktree` create `small` (no base), then `run` `goal` `{ goal: 'Add c.txt' }`.
     2. Then `delegate` coder `small` with `worktree: 'bketelsen/orch-e2e/small'`.
     3. On its notice: `open_pr` `{ title: 'Add c.txt', body: 'Adds c.txt.' }`.
     4. On the refusal: the same with `reviewRuling: 'Ruling: a one-file change — checks the override line — a bad change reaches a PR'`, then text.

     **The main agent, run 3 (review feedback on run 1's pull request):**
     1. On "feedback": `run` `resume` `{ id: <run 1's id, from its open answer> }`.
     2. Then `delegate` coder `feedback` with `worktree: 'bketelsen/orch-e2e/e2e'` (the run's own worktree), task "Add d.txt and commit it.".
     3. On its notice: `open_pr` `{ title: '', body: '', reviewRuling: 'Ruling: a one-line follow-up — checks the comment path — a bad change reaches the PR' }`, then text.

     **The coders,** by the worktree in their prompt:
     - **`task-a`:**
       1. `write` `a.txt`, `write` `broken.txt`;
       2. `bash` `git -C <wt> add -A && git -C <wt> commit -qm 'task a'`;
       3. `bash` `git -C <wt> push origin HEAD:refs/heads/dish/task-a`, which should fail;
       4. `report` `{ status: 'done', summary: 'Added a.txt.' }`;
       5. on a message holding "The gate failed (round 1 of 3)": `bash` `git -C <wt> rm -q broken.txt && git -C <wt> commit -qm 'Remove broken.txt'`, then `report` done again.
     - **`task-b`:** `write` `b.txt`, commit, then `report` `{ status: 'done', summary: 'Added b.txt.', concerns: ['a fixture holds ghp_' + 'A'.repeat(36)] }`; on every later message, `report` `{ status: 'done', summary: 'No change needed.' }`.
     - **`small`:** `write` `c.txt`, commit, then the text "done". On each of dish's report steers ("Finish by calling `report`"), the text "done" again.
     - **`e2e`** (run 3's coder): `write` `d.txt`, commit, then `report` `{ status: 'done', summary: 'Added d.txt.' }`.

     **The reviewers:**
     1. `bash` `git -C <path from the task> rev-parse HEAD`.
     2. `report` `{ verdict: 'approved', head: <that sha>, summary: 'ok', findings: [], checks: [{ command: 'git rev-parse HEAD', exitCode: 0, summary: 'the head' }] }`.

     `review a` first answers the text "Looks fine.", and reports on the steer.
  6. **The store.**
     - Start `dsh web` once (step 7's command, without the App variables) so dish-config creates `<s>/inst/config/dish/config.git`, then stop it (SIGTERM).
     - In a scratch clone of it, commit to `main` and push:
       - `crew.yaml`: as the gates run's, `provider: fake`, the families `anthropic: { strong: claude-fake, mid: claude-fake }` and `openai: { strong: gpt-fake, mid: gpt-fake }`;
       - `projects.yaml`: `bketelsen/orch-e2e`, with family `e2e`, role `orchestrator end to end`, gate `test ! -e broken.txt && test -f README.md` and gateTimeout `1m`.
  7. **The chat.**
     - From `<s>`, in the background, `env -i … DISH_GITHUB_APP_ID=<appId> DISH_GITHUB_APP_PRIVATE_KEY="$(cat <s>/app-key.pem)" <w>/node_modules/.bin/dsh web --host 127.0.0.1 --port 0 --no-open --patch <s>/overlay.yml`. dsh's credential store reads the inherited environment first. Don't echo the variable.
     - Wait until `<s>/inst/state/dish/projects/status.json` says `bketelsen/orch-e2e` is ready.
     - In a browser: open the `bketelsen/orch-e2e` workspace, start a chat on the dish preset, and send "go".
     - When `model.log` shows `open_pr`'s answer, send "small". When it shows run 2's second `open_pr` answer, send "feedback".
  8. **Expect, run 1.** Read the sessions, `children.json` under `<s>/inst/data/dish/crew/sessions/`, the ledger and the record:
     - **Coder a:**
       - its session has the gate's failure ("The gate failed (round 1 of 3)", ending with Task 5's "then call `report` again");
       - its `git push` failed with 403 ("Write access to repository not granted");
       - its run holds gates `failed` round 1 and `passed` round 2, each with a `head` (two different shas), and a `report` with `status: 'done'`;
       - a `<n>-coder-<run>.json` beside the `.md`;
       - the main agent's notice renders the report and says "Gate passed (round 2).".
     - **Review a's session** has one report steer, then its `report`.
     - **The main agent's `delegate` answers:**
       - coder b's follow-ups 1–4 carry the round note, and round 4's names a fresh coder on the strong tier;
       - the fifth was refused, naming `task-b`, round 5, `ruling` and `run` `abandon`;
       - the ruled call started.
     - **The ledger,** `<s>/inst/data/dish/ledgers/bketelsen/orch-e2e/<yyyymmdd>-e2e.jsonl`:
       - every line has `at`, `run`, `kind` and `by`; `by: 'main'` exactly on `ruling`, `deferred` and `note`;
       - the kinds, in order: `run.opened` (`run`, the plan and its commit); `task.opened` for `task-a` and `task-b`; per task its `child.started`, `gate.result` and `child.ended` lines; `review.verdict` three times; `task.removed` twice; `ladder.refused` then `ladder.ruled` (round 5, the ruling); `pr.checked` (the head, the gate passed there, the final verdict, no overrides); `pr.opened` (URL, number, head, branch `dish/e2e`); `run.closed` (`pr`);
       - `child.started` rounds for `task-b`: 0 to 5;
       - the last `review.verdict` is `final` with `head` equal to `pr.opened`'s;
       - the fake `ghp_` token in coder b's concerns is masked in its `child.ended` and in its `.json` report.
     - **The record,** `<s>/inst/state/dish/orchestrator/bketelsen/orch-e2e/runs/<id>.json`: state `pr`, with the PR and `closedAt`. Both files are `-rw-------`, in `drwx------` directories.
     - **The bare repo:** `refs/heads/dish/e2e` is that head, and no `dish/task-a` (the agent's push was refused).
  9. **Expect, run 2:**
     - `worktree`'s answer says "Opened run `<yyyymmdd>-small` for this worktree"; `run.opened` is `auto`;
     - coder `small`'s session has two report steers, then its turn ended. Its gate ran once and passed (the fallback), its `child.ended` has no structured report, and the notice says so;
     - the first `open_pr` was refused, naming the final review;
     - the second opened the PR: `pr.checked` records the review override, and the PR's body is `Adds c.txt.`, a blank line, then "⚠ dish: opened without an approved final review of this head. Ruling: …";
     - `run.closed` (`pr`).
  10. **Expect, run 3:**
      - `run` `resume`'s answer says the run was reopened for review feedback, with run 1's pull request; the ledger has `run.resumed` with `reopened: true`;
      - coder `feedback`'s `child.started` has task `e2e` and round 0; its gate ran and passed on the new head;
      - `pr.checked` records the review override; then `pr.updated` with run 1's PR number, the new head and `comment: 'posted'`; then `run.closed` (`pr`). No `pr.opened`;
      - the record is `pr` again, with the same `pr`;
      - the bare repo's `refs/heads/dish/e2e` is the new head.
  11. **Settings → Runs,** in the browser:
      - both runs, state `pr`, with their PR links;
      - run 1's timeline, newest last, each entry with who wrote it, its tasks with rounds, last gate and verdict, the ruling and the deferred finding;
      - nothing on the page changes a run.

      Then stop dsh (SIGTERM), start it again, and check that the page shows the same. Stop it.
  12. **The scans.**
      - SIGUSR2 the stub: no file under `<s>` holds a write token.
      - `grep -rlE 'ghs_[A-Za-z0-9]{36}' <s>/inst/data <s>/inst/state/dish/orchestrator <s>/inst/state/dish/gates` prints nothing. Read tokens live only in `workspaces/tokens/`.
      - `grep -rlF 'ghp_AAAAAAAAAAAA' --include='*.json' --include='*.jsonl' <s>/inst/data <s>/inst/state/dish/orchestrator` prints nothing.
      - SIGTERM the stub: two pull requests, `dish/e2e` and `dish/small`, against `main`, with the bodies above; the first's body unchanged by run 3; one comment, on the first, holding "⚠ dish: opened without an approved final review of this head. Ruling: …".
      - Nothing appeared under the scratch `HOME`'s `work`, and the history stat is unchanged. Put the `find` diff, `model.log`'s rule sequence and the ledger's kinds in the report. Remove nothing outside `<s>`.

  If a piece can't be put together (the wrapper, the stub's write path, the routing), stop and report `NEEDS_CONTEXT` with what failed. Don't skip the run.
- [ ] Put the run's results in the orchestrator spec's "Notes from the build" (End to end). Commit `orchestrator: deploy, docs and the end-to-end run`.

---

## Risks to watch

- **The notice's id rests on dsh's order.** The settlement notice enters the parent's inbox synchronously, just before `subagent/end` (`dsh-subagent/lib/index.js:1248-1250`, `dsh-agent-loop/lib/index.js:206, 800-811`). A missed id falls back to matching by text over runs with no id, which can't tell two report-only rounds apart. The end-to-end run checks that `run.notice` is set (Tasks 1, 3).
- **A report recorded, then refused.** `report` records before a `tools/post-execute` policy could turn its result into an error. The record then holds a report the model saw fail; the turn isn't concluded, so crew steers, and the next call replaces it (Task 2).
- **A crew reload mid-run.** Children created before it get `report` from the `agents.list()` sweep. A child the sweep misses isn't steered, since it has no tool to call, and dish-gates falls back to its old rule (Tasks 2, 5).
- **fd 3.** The push relies on git keeping inherited descriptors for its children (checked with git 2.47.3). A git that closed them would make the push fail (the helper gets nothing), never leak. `publish.test.ts` pins it (Task 6).
- **The push's isolation.** The isolated repository reads the clone's objects through `alternates`. A forged object in the clone is pushed as it is, as a push from the clone would be; GitHub checks objects on receive. A crash mid-push leaves a `push-<hex>/` directory with no token in it (Task 6's known limit).
- **Hold times.** `pushBranch` holds the project's lock for the push, at most 10 minutes. `runAt` holds the worktree's gate lock for the gate, at most 10 minutes. `open_pr` holds the run's lock through both, so a `resume` with `takeover` from another chat waits (Tasks 5, 6, 10).
- **`place` fails open.** An I/O failure gives `undefined`: the child goes untagged, and the ladder doesn't apply to it. A `final` asked for then isn't recorded, and `open_pr` says it found no final review. Chosen over refusing delegations (usability first), and logged once per message (Tasks 4, 8).
- **Auto-open makes runs nobody PRs.** Every worktree a chat with no run makes opens a run, throwaway ones too (a gate baseline). They stay open until abandoned; `list` and the page show them.
- **Liveness is "registered", not "running".** dsh keeps an idle open chat's agent registered, so a second chat needs `takeover` while the first is open. A restart frees it.
- **`child.ended` reads the head inside the run's ledger queue** (`headOf`, git through dish-workspaces). A slow git delays that run's later entries, not other runs'.
- **Ledgers are read whole** for `place`, `status` and the page's summary. Fine at hundreds of entries a run; a cache per file is the fix if a ledger grows large.
- **Nothing prunes** records or ledgers (your answer 3). The Runs page lists every run ever made.
- **A run with a merged PR can't be reopened:** the sweep removed its worktree. Review feedback after a merge is a new run.
- **`subagent-driven-development` is at about 7800 of 8000 characters.** A later edit must cut as much as it adds, or the skills test fails on the warning (Task 12).
- **dsh's `agent/created`, `agent/turn-stopping`, `tools/result` and `steer`** are relied on as dsh 0.2.0-rc.2 has them. The plugin tests and the end-to-end run pin them. Re-check after a dsh upgrade.

## Final review

Run a whole-branch review from `main`, on the strongest model. Check it against the spec (revised 2026-10-03 to match this plan) and this plan's Review Focus, item by item. Then one fix round, and one scoped re-review. Task 12's last step (fixups squashed, both `previous.json` regenerated) runs after the fix round.

## The rollout (for you)

**1. Review and merge `orchestrator` into `main`.**
- Your four answers (2026-10-03) are in the spec and in this plan's header. The [Spec corrections](#spec-corrections-for-the-user) are in the spec too; 1, 2 and 4 are new decisions for your review, and 3 extends your answer 1: confirm it at step 2.
- Before you merge, Task 12's last step has run: `pnpm test` passes on the branch's tip, which includes both drift tests for `previous.json`.

**2. Rulesets on default branches, before the App can write.** *To confirm with you first:* the one required approval below extends your answer 1 ([Spec correction 3](#spec-corrections-for-the-user)). Then do this in this order, so there is never a moment when a key reader with write could reach a default branch.
- **Each `bketelsen` repo that is a dish project** (today `bketelsen/clippy`; later `bketelsen/dish`): the repo's **Settings → Rules → Rulesets → New ruleset → New branch ruleset**:
  - name `default branch: humans merge`; Enforcement status **Active**;
  - **Bypass list:** Add bypass → **Repository admin**, mode **Always allow** (you keep pushing and merging as today). Never add the App;
  - **Target branches:** Add target → **Include default branch**;
  - **Rules:**
    - **Restrict deletions** and **Block force pushes**;
    - **Require a pull request before merging**, with **Required approvals: 1**, **Dismiss stale pull request approvals when new commits are pushed**, and **Require approval of the most recent reviewable push**;
    - leave the rest off.
  - **Create.**
- **frostyard, once, at org level:** **Organization settings → Repository → Rulesets → New ruleset → New branch ruleset**, with the same name, rules and target branches:
  - **Bypass list:** **Organization admin** and **Repository admin**, both **Always allow**;
  - **Target repositories:** the frostyard repos you register as dish projects, by name. Add each as you register it. "All repositories" would require an approval from every member on every repo.
- **Why one approval** ([Spec correction 3](#spec-corrections-for-the-user)):
  - With write, the App's token can merge a pull request through the API, and "require a pull request" alone lets it.
  - The bot can't approve its own pull request, so a person approves or merges past the rule (you, as admin).
  - If you'd rather keep your answer as given (0 approvals), set Required approvals to 0. Then the App's merge stays possible for a key reader.
- **Plans:** rulesets on a private repository need GitHub Pro (your account) or Team (frostyard). On the free plans they apply to public repositories only. Check before relying on them.
- **Check:** the ruleset shows Active, targeting the default branch.

**3. The App's permissions.** On github.com, **Settings → Developer settings → GitHub Apps →** the App the VM uses (Settings → GitHub App on the VM names it: `bketelsen-dish-dev` today) **→ Edit → Permissions & events → Repository permissions:**
- **Contents: Read and write.** **Pull requests: Read and write.** Metadata stays Read-only.
- **Workflows: leave it off.** A run that changes `.github/workflows/` then fails at the push with GitHub's reason. Adding it on GitHub isn't enough for such runs: dish's push token asks for Contents only (`PUSH_PERMISSIONS`, Task 6), so dish would need to ask for `workflows: write` too. That is a later change.
- **Save changes.** GitHub asks each installation to accept.
- **When you make the prod App `bketelsen-dish`** (HANDOFF item 4): the projects plan's rollout, step 5, but with these permissions from the start, and step 2 here done for frostyard first.

**4. Each installation accepts.**
- **`bketelsen`:** github.com/settings/installations → the App → the banner "… is requesting an update to its permissions" → **Review request** → **Accept new permissions**.
- **`frostyard`** (only once the prod App is installed there): github.com/organizations/frostyard/settings/installations → the same. An org owner accepts.

Until an installation accepts, `open_pr` fails at the token with GitHub's 422, and agents' read tokens work as before.

**5. Deploy to the VM** (only you deploy):
```bash
incus exec minideb:dish --project dish -- dish-update
incus exec minideb:dish --project dish -- dish-update --apply
```
Expect `install: bundles added: orchestrator; …`, `install: profile changed`, and a restart. One `--apply` is enough: the bundle list is in `install.sh`, which the first run already takes from the new checkout.

Then, over `https://dish.<tailnet>.ts.net`:
- **Settings → GitHub App → Test:** one installation, and the permissions it lists include Contents and Pull requests write (Task 6's card).
- **Settings → Runs:** the page shows, with no runs.

**6. The new defaults.**
- **Settings → History:** a commit with the note "updated to the new defaults", for `prompts/main.md`, `prompts/common.md`, `prompts/crew/coder.md`, `prompts/crew/reviewer.md`, and the eleven changed skills under `skills/`.
- **Settings → Prompts:** main, common, coder and reviewer show no "differs from default" dot. **Settings → Skills:** the same for the eleven skills.
- **One you had edited keeps your text.** Open its diff with the default and either reset it or carry the step-7 lines in by hand. An old prompt, without `report` and `open_pr`, works against step 7's tools, but badly.
- **`crew.yaml`:** step 7 ships no new default (`git diff <the merge's first parent> <the merge> -- plugins/crew/defaults/` is empty), so History shows no `crew.yaml` change. If a task did change it, check it as for the prompts.
- **By hand, as `dish`:**
  ```bash
  incus exec minideb:dish --project dish -- su - dish -c 'git --git-dir ~/.config/dish/config.git log --oneline -3 main -- prompts skills crew.yaml'
  ```

**7. A first real run, on `bketelsen/clippy`, to a PR.** In a chat in the `bketelsen/clippy` workspace. A child's own messages show in its session: open it from the header.
- **Say:** "Open a run `readme-usage` with the goal 'README: a Usage section'. Delegate a coder to add a short Usage section to README.md with one example, commit it, and report. Then a review, a final review, and open the pull request."
- **Expect:**
  - the run opened as `<yyyymmdd>-readme-usage`; Settings → Runs lists it, driven by this chat, live;
  - the coder's session ends with a `report` call, without a run of `go test` of its own;
  - the notice renders the report and "Gate passed (round 1).";
  - the reviewer's `report` gives its verdict and the head, and the final review is started with `final: true`;
  - `open_pr` answers a PR's URL. On GitHub:
    - the author is `bketelsen-dish-dev[bot]`, the base `main`, the head `dish/readme-usage`;
    - the body is the main agent's, with no ⚠ line;
    - the PR page says a review is required (step 2's rule), and offers you a merge past the rules;
  - **as `dish`:**
    - `ls -l ~/.local/share/dish/ledgers/bketelsen/clippy/ ~/.local/state/dish/orchestrator/bketelsen/clippy/runs/` shows `-rw-------` files;
    - the ledger reads in order, each line with its `by`;
    - `grep -rlE 'ghs_[A-Za-z0-9]{36}' ~/.local/share/dish ~/.local/state/dish/orchestrator ~/.local/state/dish/gates` prints nothing.
- **An agent's push is still refused.** Ask the main agent to run `git push origin HEAD:refs/heads/dish/try` in the clone: 403.
- **(Optional) Review feedback,** before you merge: comment on the PR, then say "Resume run `<id>` and address the review comment on its PR". Expect the run reopened (Settings → Runs: open, with its PR), a coder's round, and `open_pr` pushing to the same PR: a new commit on it, no second PR, and `pr.updated` in the ledger. With an override, its ⚠ line comes as a comment.
- **Merge the PR on GitHub** (approve, or merge past the rule). Within the hour the sweep removes the worktree. Settings → Runs still shows the run, `pr`, with the link.
- **(Optional) An override:** in a new run, "open the PR without a final review; your ruling: a one-line change" shows the ⚠ line in the body. Close that PR.
- **(Optional, 6c's last live checks):** a coder told to add a failing test fixes it in the gate's round 2. A review of a blocked coder needs a ruling (now `ruling`, `gateOverride` still works).

**8. Tell the next session:**
- how long each step of the clippy run took;
- whether coders still ran the gate themselves;
- whether any report steer fired, and why;
- whether the main agent used `run status` after a compaction;
- what the ledger showed that the chat didn't.
