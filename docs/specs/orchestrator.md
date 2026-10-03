# Spec: orchestrator (`dish-orchestrator`)

Status: approved 2026-10-03, with the four recommendations under [Questions for you](#questions-for-you) taken. Revised 2026-10-03 from the plan, to match its [Spec corrections](../plans/2026-10-03-orchestrator.md#spec-corrections-for-the-user): review feedback reopens a run with a PR, a final review stays final, the rulesets need one approval (to confirm), coders and reviewers are told to finish with `report`, and ten smaller ones; then three of your decisions after reviewing the plan: a PR's branch is brought up to date by merging, never rebased; `pr_feedback` reads a run's PR; and a reopened run's `open_pr` can change the PR's title and body. The plan is [docs/plans/2026-10-03-orchestrator.md](../plans/2026-10-03-orchestrator.md). This is roadmap step 7. It builds on [crew](crew.md), [gates](gates.md) (6c), [projects and workspaces](projects-workspaces.md) (6b) and the [design](../design.md) ("The pipeline", "Lessons that shape the design"). Every claim about dsh below was checked against dsh 0.2.0-rc.2's sources; see [Checks](#checks-2026-10-03). Built on branch `orchestrator` (2026-10-03) and checked end to end in a scratch dsh; awaiting review and the rollout. What the build added is under [Notes from the build](#notes-from-the-build).

## Summary

Today the pipeline runs on prompts and skills, and the main agent keeps its own ledger, in a markdown file it writes. Step 7 makes the parts that matter structural:
- **Runs.** Every change that ends in a PR is a *run*: its own branch, owned by the project, resumable from any chat, and reopened for review feedback on its PR. A plan is attached when there is one, and a small task is a run with just a goal.
- **A ledger per run,** written by the harness from what it saw: delegations, child endings, gate results, review verdicts and the PR. The main agent adds its rulings, deferred findings and notes, marked as its own.
- **Structured reports** for the coder and the reviewer: a `report` tool with a schema, which ends the child's turn. The coder's `status` and the reviewer's `verdict` are facts the harness reads, not prose the main agent retells.
- **The escalation ladder's last rung, enforced.** From round 5 on a task, `delegate` refuses more coder work unless the call carries a ruling.
- **`open_pr`.** dish pushes the run's branch and opens the PR, but only if the gate passes on the head and the final review approved that head, or a ruling overrides either. The main agent writes the body. dish adds one line, and only for an override.
- **Review feedback on a PR:** `pr_feedback` reads it (reviews, comments, checks) for the main agent; the run reopens, a coder fixes it and merges the branch up to date, never rebasing, and `open_pr` pushes to the same PR.
- **A read-only Runs page,** and a chat `status`, so you can see a run without asking the main agent.

## Decisions (from the 2026-10-03 brainstorm)

| # | Topic | Decision |
|---|---|---|
| 1 | What step 7 buys | Trust and autonomy, with the ledger built first as the backbone for the ladder and the PR step. |
| 2 | What one ledger covers | One run: from its branch being made to its PR (or its abandonment). |
| 3 | Who writes the ledger | The harness alone writes its events, from its own listeners. The main agent adds rulings, deferred findings and notes through a tool, and every entry says who wrote it. |
| 4 | Review verdicts | A structured verdict the harness records, not a claim the main agent retells. |
| 5 | Which roles report structurally | The coder and the reviewer only. Other roles keep free-text closing messages. |
| 6 | The ladder | Advisory for rounds 1–4. From round 5, `delegate` refuses more coder work on the task unless the call carries a ruling. |
| 7 | What `open_pr` requires | The gate passing on the head, and the final review's `APPROVED` for that same head. A ruling can override either. |
| 8 | The PR body | The main agent writes it. dish appends one line only when a check was overridden. |
| 9 | When a run begins | When work on a change begins. Every change that ends in a PR is a run; a small task is a run with just a goal. |
| 10 | Who owns a run | The project. Any chat in the project can resume an open run; one chat drives it at a time. |
| 11 | Where you see a run | A read-only Runs page in Settings, and a `status` in the chat. |
| 12 | Forgetting to open a run | The first worktree a chat makes in a project with no run of its own opens one. Nothing is refused. |
| 13 | Housekeeping (Claude's, unless you object) | A new plugin, `dish-orchestrator`; the dish preset stays with crew; ledgers are JSON Lines files; a run ends with a PR or is abandoned; coders stop running the gate themselves; the skills change to match. |

## Non-goals

- **Merging.** Humans merge. No automerge.
- **Families, the inbox, triggers and memory** (steps 8–10). A run is the unit they will build on, but nothing here schedules work or reads direction.
- **Schemas for the architect, researcher, writer and ops** (decision 5).
- **Editing or deleting ledger entries.** The ledger is append-only, for everyone.
- **Agents pushing.** Only `open_pr` pushes (6b's decision 9). An agent's own `git push` still gets 403: its git keeps read-only tokens.
- **Moving the dish preset** out of crew. Nothing in it for you yet.

## Runs

A run is a change on its way to a PR: a goal, a branch, an optional plan, its tasks, and its ledger.

**What a run is, on disk.**
- **Its record:** `$XDG_STATE_HOME/dish/orchestrator/<owner>/<repo>/runs/<id>.json`, written atomically, 0600 in 0700 directories:
  - `id`: `<yyyymmdd>-<slug>`, unique in the project;
  - `project`, `slug`, `goal` (one line), `plan` (a repo path, set when attached), `branch` (`dish/<slug>`) and `worktree` (its path);
  - `state`: `open`, `pr` (a PR was opened) or `abandoned`, with the PR's URL and number, or the reason; a run reopened for review feedback is `open` again and keeps its PR;
  - `driver`: the session that drives it (none, `''`, once released), and since when;
  - `openedAt`, `closedAt`.
- **Its branch** is a worktree dish-workspaces makes (`worktree create`, slug = the run's slug), so dish tracks it and sweeps it after its PR merges. The tasks of a planned run work in their own worktrees, cut from it (`base: dish/<slug>`), and land on it, as the shipped skills already do.
- **Its ledger:** `$XDG_DATA_HOME/dish/ledgers/<owner>/<repo>/<id>.jsonl` ([The ledger](#the-ledger)).

**Opening a run.**
- **Explicitly:** `run` with `action: open`, `project`, `slug`, `goal`, and `plan` if there is one. dish makes the run's worktree from the project's default branch (or `base`), writes the record, opens the ledger with `run.opened`, and makes the calling chat its driver.
- **Automatically** (decision 12): when a chat creates a worktree in a registered project and drives no run there, dish opens a run around that worktree: its slug and branch are the worktree's, its goal is the slug until the main agent sets one. The `worktree` tool's answer says so: "Opened run `<id>` for this worktree; `run` with `action: goal` names it, and `open_pr` ends it." (`run` `open` makes its own worktree through dish-workspaces' service, which asks nothing, and records it itself.) The clippy README task would have been a run like this.
- **Tasks.** While a chat drives a run in a project, every worktree it creates there is one of that run's tasks (`task.opened`), whatever its base. A task's slug is its id in the ledger.
- **A plan** is attached with `run` `action: plan` (a path in the repo, recorded with the commit it was read at), at the start or once the architect has written it on the run's branch. A run without a plan is one task: the coder works in the run's own worktree.

**Driving and resuming** (decision 10).
- **One chat drives a run at a time.** The driver is the session id in the record. A chat drives at most one run at a time: opening or resuming another releases the first.
- **Resuming:** `run` `action: resume`, with the run's id. It succeeds when the run is open and its driver is the caller, or the driver's main agent isn't live (dsh's agent registry has no running agent for that session), or `takeover: true` is given, which is recorded (`run.takenOver`, with the old driver). A run with a PR is reopened by `resume` (below).
- **What a resumed run knows** is its ledger: the tasks, their state and rounds, the rulings, the last verdicts. A new chat can't send follow-ups to another chat's children (crew refuses `to` across sessions), so open tasks continue with fresh children; their round counts carry over, since they're the task's, not the child's.
- **A restart or a closed chat** leaves the run open, with no live driver, until something resumes it. That is what step 9's unattended wake-ups will do.

**Ending a run.**
- **`open_pr`** ends it with `state: pr` ([The PR](#the-pr)).
- **`run` `action: abandon`,** with a reason, ends it without one. Its worktrees are left for the main agent or the sweep to remove, and the ledger keeps everything.
- **Review feedback on its PR** reopens it: `run` `action: resume` on a run in state `pr` makes it `open` again, keeping its PR, while its worktree is still one dish made (the sweep removes it once the PR merges). It is recorded as `run.resumed` with `reopened`. `pr_feedback` reads what the PR got ([The tools](#the-tools)). Fixes go through rounds as before, and `open_pr` again pushes to the same PR ([The PR](#the-pr)).
- **Bringing the branch up to date is a merge.** When the run's branch is behind its default branch, or GitHub's `dish/<slug>` has commits it lacks (an "Update branch", a committed suggestion, a push of the user's own), a coder in the reopened worktree runs `git fetch origin` and merges `origin/<default>`, and `origin/dish/<slug>` when it moved, resolving any conflicts; the gate runs as usual. Never a rebase, an amend or a squash: dish never force-pushes. `open_pr` still needs the final review's approval of the new head: a scoped re-review, or, for a clean merge of the default branch alone, `reviewRuling` ("Ruling: merge of origin/main only, no conflicts — …").

## The ledger

**One append-only file per run,** one JSON object a line, written the way dish-judge writes its log: `O_APPEND | O_CREAT | O_WRONLY | O_NOFOLLOW`, 0600 in 0700 directories, a promise queue per file, a torn-line guard on the first append in a process, every line masked (`maskSecrets`) and cut to 16 KiB at most.

**Every entry** has `at`, `run`, `kind`, `by` (`harness` or `main`), and, when one is involved, `session`, `child`, `task`.

**Written by the harness only,** from listeners. No tool writes these:

| Kind | When | What it holds |
|---|---|---|
| `run.opened` | a run is opened | goal, branch, base and its commit, plan and its commit (if given), how it was opened (`run` or `auto`) |
| `run.resumed`, `run.takenOver` | a chat resumes it | the new driver; the old one for a takeover; `reopened` for a run that had a PR |
| `run.plan`, `run.goal` | the main agent attaches a plan or names the goal | the path and its commit; the goal |
| `task.opened`, `task.removed` | a worktree of the run is made or removed | slug, base and its commit |
| `child.started` | `delegate` starts a child, or sends a follow-up, in the run | role, model, family, child id, task, follow-up or start, the round it is for the task |
| `child.ended` | crew records a child's run ending | stop reason, the report file, the structured report if there is one, the head of the task's worktree |
| `gate.result` | dish-gates records a result for a child of the run | outcome, exit code, duration, log path, and the worktree's head when the gate ran |
| `review.verdict` | a reviewer of the run reports | verdict, the head it reviewed, whether it was the final review, the findings' counts by severity |
| `ladder.refused`, `ladder.ruled` | `delegate` refuses round 5+, or lets it through on a ruling | task, round, the ruling |
| `pr.checked` | `open_pr` checks before pushing | the head, the gate's result there, the final verdict found, any overrides |
| `pr.opened` | `open_pr` opens the PR | URL, number, head, branch (the base is always the project's default branch) |
| `pr.updated` | `open_pr` pushes to a PR that was already open | URL, number, head, branch, whether its title and body were changed (`titleChanged`, `bodyChanged`), and whether an override's comment was posted |
| `pr.feedback` | `pr_feedback` reads the run's PR | counts only: reviews by state, review comments and how many are outdated, comments, checks by outcome; never the text |
| `run.closed` | the run ends | `pr` or `abandoned`, the reason |

**Written by the main agent,** through `run` (`by: main`):

| Kind | What it holds |
|---|---|
| `ruling` | `what`, `why`, `costIfWrong`, and the task if it is about one |
| `deferred` | a finding left for later: what, where, why |
| `note` | free text, one line to a few |

**Where the events come from.** crew and dish-gates don't write the ledger: they publish what happened, and orchestrator listens.
- **crew** publishes `dish-crew/delegated` after it records a start or a follow-up, and `dish-crew/settled` after `endRun`, each with the child's record. It awaits `delegated` inside `delegate`'s session lock, and `dishRuns.place` waits for the ledger's queue, so a task's rounds count exactly. A child's run tag is the run's ref, `<owner>/<repo>/<id>` (ids are unique only in a project); a bound child is placed in the run that owns its worktree, whichever chat drives it, and a reviewer where the child it reviews is.
- **dish-gates** publishes `dish-gates/result` after `addGate`, with the result and the worktree's head (a new field, `head`: the worktree's HEAD before the gate runs, read through `dishWorkspaces.headOf`, since dish-gates runs no git).
- **dish-workspaces** asks orchestrator's service, when it is there: the `worktree` tool calls `dishRuns.worktreeCreated(...)` once the worktree is made, which returns the run the worktree joined or opened, for the tool's answer, and `worktreeRemoved` once it is removed; the sweep calls `worktreeRemoved` for each worktree it removes. None is called under a project's lock: `open_pr` holds a run's lock while its push waits for the project's.
- These follow the pattern dish-projects and dish-config already use (`ctx.parallel` on a named event). Without orchestrator loaded, nothing listens and nothing changes.

**Retention.** Ledgers are kept; nothing prunes them in step 7. They're small, and they're the history families will want. (See [Questions for you](#questions-for-you), 3.)

## Structured reports (coder and reviewer)

**The `report` tool.** A coder or reviewer finishes by calling `report`. Its parameters have a schema dsh-tools validates; a call that doesn't match comes back to the model as an error (`invalid arguments: …`), and the loop gives it another step. A successful call ends the child's turn (`exec.concludeTurn()`): no further model step, unless something is already waiting in its inbox.

**The coder's schema:**

| Field | Type | |
|---|---|---|
| `status` | `done` \| `blocked` \| `needs_context` | required |
| `summary` | string | required: what changed, for a person |
| `commits` | string[] | the shas it made |
| `blockedOn` | string | required when `status` isn't `done` (checked in the body: dsh's schemas have no conditionals) |
| `rulings` | `{ what, why, costIfWrong }[]` | its own judgment calls |
| `concerns` | string[] | |
| `notFixed` | `{ finding, why }[]` | in a fix round: findings it didn't fix, and why |

**The reviewer's schema:**

| Field | Type | |
|---|---|---|
| `verdict` | `approved` \| `changes_requested` | required |
| `head` | string | required: the full sha of the commit it reviewed (checked in the body) |
| `summary` | string | required |
| `findings` | `{ severity: blocking \| should_fix \| nit, file, line?, summary, fix }[]` | required (empty for a clean review) |
| `checks` | `{ command, exitCode, summary }[]` | what it ran |
| `addressed` | `{ finding, addressed: boolean, evidence }[]` | in a re-review |

The schemas use only what dsh-tools supports: `enum`, nested objects with `required: true`, arrays of objects, explicit `additionalProperties`. No `oneOf` (its errors don't say which field is wrong), no lengths or patterns.

**Who gets it.**
- **Only crew's coder and reviewer children.** crew registers `report` on each such child's own tool scope when it is created (`agent/created`, the way dsh-schedule registers its tools per agent), so the main agent never sees it and no role's tool list needs it. A child of another role, or the main agent, has no `report`.
- **The same tool on a resumed child** (a follow-up, a wake by `send_message`): `agent/created` fires again on a cold resume.
- **What they're told.** Their closing note says to finish with `report`; it begins, as crew's other closing note does, with the parent's id, and keeps `send_message` for a short question they're blocked on. crew's report guard, which refuses a child's long `send_message`, names `report` for them too. Other roles keep both texts as they are.

**Requiring it.**
- **A coder or reviewer that ends its turn without a successful `report`** (one crew gave `report`: a child made before crew loaded has none) is steered back: "Finish by calling `report`: …" At most 2 such steers a turn. After that the turn ends, and the run records `child.ended` with no structured report: the ladder and `open_pr` treat it as no verdict, and the main agent is told so in the finish notice.
- **The order with the gate.** For a bound coder, dish-gates runs the gate when the turn was concluded by a `report` with `status: done`, or when crew's steers ran out. `blocked` and `needs_context` skip the gate, as `BLOCKED:` and `NEEDS CONTEXT:` do today; the text forms stay accepted for a coder that never reports. A gate failure steers the coder back to fix it "and then call `report` again", and the later `report` replaces the earlier one for that turn.
- **What changes in dish-gates.** It decides a coder has finished when the newest message has no tool calls. A `report` call is a tool call, so dish-gates also accepts a turn that a successful `report` concluded, which it learns from a host `tools/result` listener (`report`, not an error, `concludesTurn`) and clears on `turn/start` and on the next assistant message.

**Where it goes.**
- **crew's record:** the structured report is kept beside the closing message: a `report` field on the child for the run in progress, moved onto the run's `structured` at `endRun` (the run's `report` is the `.md`'s path), as gate results are, and a `<n>-<role>-<run>.json` file beside the `.md` (`structuredFile`).
- **The finish notice.** dsh's own notice says "It left no closing message." when the last message is the `report` call, since it keeps only text. crew's notice rewrite renders the structured report instead, and matches a notice to its run by the child and its run, not by comparing the closing text.
- **The ledger:** in `child.ended`, and for a reviewer, a `review.verdict` entry.

## The ladder

**Counting.** A task's round count is the ledger's: each start or follow-up of a coder on the task after its first is a round. The rounds belong to the task, not to a child or a chat, so a resumed run keeps counting.

**Rounds 1–4 are advisory** (decision 6). `delegate`'s answer for a coder on a task says the round and what the skill's ladder suggests ("round 4 of task `fix-parser`: the ladder starts a fresh coder on the strong tier"). Nothing is refused.

**From round 5,** a coder start or follow-up on that task is refused, unless the call carries `ruling` (`Ruling: what — why — cost if wrong`, on one line). The refusal says the task, the round, and the two ways on: rule (with `ruling`) or stop (`run` `abandon`). A ruling is recorded (`ladder.ruled`) and allows that one call.

**What isn't counted:** reviewers, and children outside a run. A bound coder counts in the run that owns its worktree, whichever chat drives it.

## The PR

**`open_pr`** is a main-agent tool. Its arguments: `title`, `body` (Markdown, the main agent's own; both optional on a run reopened for review feedback, where a given one replaces the PR's), and, only when it rules past a check, `gateRuling` and `reviewRuling`.

**What it does, in order:**
1. **The run:** the calling chat must drive an open run in this project, and no coder bound to its worktree may still be running. Its worktree must be clean (`dishWorkspaces.isClean`: nothing uncommitted or untracked, `dish/<slug>` checked out, no nested repository), and its head is read (`dishWorkspaces.headOf`).
2. **The gate on the head:** dish-gates runs the project's gate in the run's worktree, at that head, through a new service method (`dishGates.runAt`, given the head: a worktree whose HEAD moved is an error), in the same sandbox and with the same timeout as a coder's gate. It must pass, unless `gateRuling` is given.
3. **The final review on the head:** the latest `review.verdict` marked final must be `approved` with `head` equal to this head, unless `reviewRuling` is given. A final review is a reviewer `delegate` started with `final: true` (a new parameter for the reviewer role), or made final by a follow-up with it. It stays final for its follow-ups, so a re-review with `to` counts.
4. **`pr.checked`** is recorded, with what was found and any overrides.
5. **The push:** dish-workspaces pushes the run's branch with a write token it mints in memory for this push only, to the project's HTTPS URL (never `origin`, which an agent can repoint), with an explicit refspec and never with force, and only at the head the checks ran on: a branch that moved since is refused. A rejected push (the branch moved on GitHub, or the token lacks a permission, such as Workflows for a change under `.github/workflows/`) fails the tool with GitHub's reason, and nothing more happens. For a branch that moved, the answer says: "The branch on GitHub has commits this one doesn't: have a coder merge `origin/dish/<slug>` into the run's worktree, then call `open_pr` again. dish never forces a push."
6. **The PR:** dish-workspaces opens it (`POST /repos/{owner}/{repo}/pulls`, base the project's default branch, head the run's branch), with the main agent's body, plus, only if a check was overridden, one line at the end: "⚠ dish: opened past a failing gate. Ruling: …" or "⚠ dish: opened without an approved final review of this head. Ruling: …". A PR that already exists for the branch is reported, not opened again, and its title and body aren't changed: an override's line is posted on it as a comment instead (`POST /repos/{owner}/{repo}/issues/{n}/comments`).
7. **`pr.opened`** (or **`pr.updated`**, for a PR that was already open) and **`run.closed`** are recorded, and the run's state becomes `pr`. The answer gives the PR's URL.

**Review feedback.** A run reopened with `run` `resume` (see [Ending a run](#runs)) goes through the same steps: the same checks on its new head, then the push to the same branch. Before the gate it asks whether GitHub's `dish/<slug>` has commits the run's branch lacks, and refuses with the merge hint if so. The PR is already open, so the ledger gets `pr.updated`. Its title and body stay, unless `title` or `body` is given: then dish updates them (`PATCH /repos/{owner}/{repo}/pulls/{n}`, masked, with a Pull requests write token). An override's line is always posted as a comment, never put in the body.

**What dish-workspaces gains:** `headOf`, `isClean`, `compareBranch` (a fetch, then the branch against `origin/<default>` and GitHub's `dish/<slug>`), `pushBranch`, `openPull`, `updatePull`, `commentPull` and `readPull` (a PR's reviews, comments and checks) on its service; the write token (Contents and Pull requests, write) minted in memory per call and never written to disk; dish's in-memory API token reading checks and commit statuses too; and the App permissions to ask for (Contents and Pull requests write, Metadata, Checks and Commit statuses read). Agents' own git keeps read-only tokens.

## The tools

All are main-agent tools: they refuse a crew child (`isTopLevelAgent`), and crew's `NEVER` list keeps them from any role. They're registered globally by `dish-orchestrator`, like `worktree`.

- **`run`** with `action`:
  - `open` (`project`, `slug`, `goal`, `plan?`, `base?`); `resume` (`id`, `takeover?`; it also reopens a run with a PR, for review feedback); `goal` (`goal`); `plan` (`plan`); `abandon` (`reason`);
  - `status`: the run this chat drives, from its ledger: tasks and their state and round, the last gate and verdict for each, the final review, rulings, what `open_pr` would find now, and the branch against GitHub (commits behind the default branch, and on GitHub's `dish/<slug>`);
  - `list`: open runs, for a project or all, with their driver and whether it's live, then the newest runs with a PR;
  - `ruling` (`what`, `why`, `costIfWrong`, `task?`), `defer` (`what`, `where`, `why`), `note` (`text`): the main agent's own entries.
- **`open_pr`** ([The PR](#the-pr)).
- **`pr_feedback`** (`id?`): the PR of the run this chat drives, or of `id`: its state and mergeability; its reviews (author, state, body); its review comments (path, line, author, body, outdated); its comments (author, body); the checks on its head (name, status, conclusion), from check runs and commit statuses. It reads through `dishWorkspaces.readPull` with dish's API token, and changes nothing on GitHub.
  - **Untrusted input.** Everything from GitHub is masked and capped, per item and overall, quoted, and framed as data, not instructions. The judge's shipped `tools.screened` names `pr_feedback`, so its injection screen reads the answer.
  - The ledger records `pr.feedback`: counts, never the text.
- **`delegate`** (crew) gains `ruling` and `final`, and tags every child with the run and task it belongs to.
  - `ruling` is the one word for ruling past a check: a coder past round 5, or a review past a gate that hasn't passed. `gateOverride` stays as a synonym, so briefs and skills that use it still work (question 4).
  - `final: true` marks a reviewer as the run's final review. It stays final for its follow-ups, and a follow-up with it makes a reviewer final. Outside a run it has no effect, and `delegate` says so.

## The Runs page

**Settings → Runs,** read-only, built like Settings → GitHub App (a remote service, a `settings.section` slot):
- **The list:** runs by project, open ones first: goal, state, driver and whether it's live, opened and closed times, the PR link.
- **A run:** its timeline from the ledger, newest last, each entry with who wrote it; tasks with their rounds, last gate and verdict; the rulings, the deferred findings; the PR, with the counts of its last `pr_feedback` read. Reading pages backward through the file, as Settings → Judge reads its log.
- Nothing on the page changes a run.

## Prompts and skills

The shipped defaults change, and `previous.json` is regenerated for each, so unedited copies in your config store move to the new text:
- **`subagent-driven-development`, `executing-plans`:** the ledger file becomes the run's ledger: open or resume a run first, record rulings and deferred findings with `run`, read `run` `status` after a compaction. The plan branch is the run's branch. Coders and reviewers finish with `report`. The final review is `delegate` with `final: true`. Round 5 needs a ruling.
- **`finishing-a-development-branch`:** `open_pr`, not "say the branch is ready and stop"; the main agent writes the body; no `git push` or `gh pr create`; and the review-feedback loop: `pr_feedback`, `resume`, fixes, a merge to bring the branch up to date (never a rebase), a re-review or a ruling, `open_pr`. `subagent-driven-development` points there. `open_pr` at the end of a run needs no user yes: it merges nothing, and its checks are structural.
- **`using-git-worktrees`:** worktrees belong to the chat's run; the plan branch is the run's, made by `run open`.
- **`requesting-code-review`, `reviewing-work`:** the reviewer reports with `report` (verdict, head, findings).
- **`main.md`:** runs, `open_pr`, no pushes of its own.
- **`common.md`:** "Open pull requests" becomes: pull requests are opened with `open_pr`; agents don't push; and never rebase, amend or squash a run's branch: bring it up to date by merging.
- **`crew/coder.md`:** finish with `report`; don't run the gate yourself, dish runs it when you report `done` (the brief still names it, so you can run it while you work if you want).
- **`crew/reviewer.md`:** finish with `report`, with the head you reviewed.
- **`test-driven-development`, `verification-before-completion`, `receiving-code-review`, `systematic-debugging`:** a coder whose brief says dish runs the gate leaves the finishing run to dish. **`changing-infrastructure`:** ops doesn't push; the main agent opens the PR with `open_pr`.
- **Outside a registered project** there is no run: the skills keep a ledger file, and the user pushes.

## Configuration

- **`dish-orchestrator`'s row:** `terminal` (print its messages). The ledger and record directories follow the XDG variables.
- **`dish-crew`'s row:** `reportSteers` (2): the steers to call `report` in one turn; `0` turns the steer off. `report` stays, since the prompts tell coders and reviewers to call it, and a coder that ends with text is gated as today.
- Nothing in the config store for `dish-orchestrator`.
- **`dish-judge`'s shipped `judge.yaml`:** `tools.screened` gains `pr_feedback`. The judge seeds only a missing `judge.yaml`, so an existing one gets it by hand (the plan's rollout).

## Testing

- **Runs:** open, auto-open from `worktree`, tasks joining the driving run, resume by the driver, by another chat when the driver isn't live, takeover, refusal otherwise; reopening a run with a PR, and not once its worktree is gone; abandon; one run per chat.
- **The ledger:** each event kind from its source; `by` on every entry; masking and the 16 KiB cut; torn-line recovery; append-only (no tool edits); retention.
- **`report`:** the two schemas, a bad call's error, `concludeTurn`, the steers and their cap, a later `report` replacing an earlier one, registration on coder and reviewer children only (not the main agent, not other roles), and through a cold resume.
- **dish-gates with `report`:** gated after `done`, skipped after `blocked`, a failure steering back and the next `report` gated again, the fallback when no `report` comes.
- **The ladder:** rounds counted from the ledger across chats, the advisory text, the refusal at round 5, a ruling letting one call through.
- **`open_pr`:** each check passing and failing, each override and its line, a dirty worktree, a stale final review, a re-review of the final reviewer, a rejected push, an existing PR, a reopened run (`pr.updated`, the override as a comment, a new title or body, GitHub's branch ahead), the merge hint on a refused push, the write token never on disk; against dish-workspaces' fake git server (a bare repository behind `git http-backend` on `127.0.0.1`, reached through a setting production can't set) and its fake GitHub, never the network.
- **`pr_feedback`:** each part of the PR read, masking and the caps, a body quoted line by line, the checks unreadable without their permissions, counts only in the ledger, and nothing written to GitHub. **`compareBranch`:** behind, ahead, GitHub's branch ahead or missing.
- **The Runs page:** the remote service's methods; the page by hand in the browser, as other pages are.
- **A live check in a scratch dsh,** as 6c had: a planned run with two tasks, a failing gate fixed in round 2, a review, a final review, and `open_pr` against a test repository; then review feedback on that PR through the reopened run.

## Questions for you

*Answered 2026-10-03: all four recommendations taken.* A: GitHub rulesets on each project's default branch, which you set up on GitHub (the [rollout](../plans/2026-10-03-orchestrator.md#the-rollout-for-you) lists them; it adds one required approval, to confirm, since an App with Contents write can merge a PR through the API); only `open_pr` pushes; ledgers are kept forever; one `ruling` parameter, with `gateOverride` as its synonym.

1. **The App key and write access.** dish keeps the App's private key in dsh's credential store, which an agent's shell can read. Once the App has write permissions, an agent could mint a write token and push anything, past `open_pr`'s checks. 6b decided that step 7 would add write "together with a way to keep the key from agents, such as a token broker under another account". Three ways:
   - **A. GitHub rulesets** on each project's default branch: require a pull request, block force pushes and deletions. GitHub enforces "humans merge" whatever an agent does. Branches other than the default stay pushable by an agent that goes out of its way. Nothing to build; a ruleset per repo (or per org, for frostyard).
   - **B. A token broker:** the key moves to a root-owned helper the `dish` account can't read, which mints only read tokens for agents' git, and write tokens only for pushes it makes itself under a policy (`dish/*` branches, no force, no default branch). It protects every branch, but it is a new privileged component, and since agents run as the same user as dsh, its policy is the only line, not the identity of the caller.
   - **C. Accept it,** as the usability-first rule leans, and rely on reviewing PRs.

   *Recommendation:* A now, B only if it proves needed. Rulesets put the one rule that matters (nothing reaches a default branch without your merge) where no agent can bend it, at no usability cost.
2. **Agents pushing, otherwise.** This spec keeps 6b's decision 9: only `open_pr` pushes. HANDOFF's "check that an agent can push a branch" after the prod App is wrong under it: an agent's push still gets 403, by design. *Recommendation:* keep it, and fix HANDOFF.
3. **Ledger retention.** Forever, as written, or 180 days after a run closes, as crew prunes its records? *Recommendation:* forever for now; prune when it matters.
4. **One `ruling` parameter.** `delegate` already has `gateOverride` (a review past a failed gate). This spec adds `ruling` (round 5+). *Recommendation:* add `ruling`, and accept it for the gate check too, keeping `gateOverride` as a synonym, so the main agent has one word for "I'm ruling past a check".

## Checks (2026-10-03)

Against dsh 0.2.0-rc.2's sources and dish's `main` at `3e44720`:
- **GitHub App permissions,** checked against GitHub's "Permissions required for GitHub Apps" page on 2026-10-03: check runs need Checks read; a commit's combined status, Commit statuses read; a PR's reviews and review comments, Pull requests read; a PR's issue comments, Pull requests (or Issues) read to list and write to post; opening and editing a PR (`POST`/`PATCH .../pulls`), Pull requests write; merging one (`PUT .../pulls/{n}/merge`), Contents write, which is why the rulesets require an approval.
- **`concludeTurn`** (dsh-tools `ToolRunContext`): a successful result carrying it makes the agent loop return "completed" without another model step, unless the next-step inbox has work (dsh-agent-loop `turn()`); `agent/turn-stopping` still fires after it, and a listener's `steer` continues the turn. A failed call never concludes.
- **Settlement:** dsh's notice keeps only text blocks of the last non-empty assistant message, so a turn ended by a `report` call gets "It left no closing message."; `subagent/end`'s `lastAssistantMessage` carries the tool call with its JSON arguments.
- **dsh's own structured output** (`outputSchema`, a scoped `structured_output` tool) exists only for one-shot subagents; `ContinuableStartSpec` omits it, and crew starts continuable children. dsh-llm has no provider-native structured output.
- **Schemas:** dsh-tools supports `type`, `properties`, `required` (per property), `additionalProperties` (explicit), `items`, `enum`, `const`, `oneOf`; it rejects lengths, patterns, formats, `anyOf`, `allOf`, `$ref`. Arguments are validated inside `execute`; a violation is an error result naming the field.
- **dish-gates** treats a newest message with tool calls as "not finished" (`closing.ts`), so without the change above a coder that finishes with `report` would never be gated.
- **Per-agent tools:** dsh-schedule registers tools on each root agent's own scope at `agent/created`; an agent's own layer isn't subject to its tool filter, so a child-scoped `report` needs no allow-list entry, and the main agent never sees it.
- **Pushing:** dish-workspaces mints only read tokens (`createToken` refuses anything but read) and has one REST client (`GitHubApp`, GET and POST). The 6b spec planned in-memory write tokens for the harness's own pushes in step 7 (decision 9). The credential helper answers every `get`, so a push today fails at GitHub with 403, not locally.
- **Locks and resume:** crew refuses `to` and `reviews` across sessions, so a resumed run continues with fresh children; no existing lock lasts across turns, so the run's driver is a persisted session id checked against dsh's agent registry.

## Notes from the build

What the build decided beyond this spec as revised on 2026-10-03 (the plan's Spec corrections are in the text above), from the controller's ledger and the tasks' reports and reviews. Each was checked against the code.

**Runs.**
- **`run` `open` makes its worktree before it takes the chat's lock,** not under it (the plan's Task 9 said under). `createWorktree` can wait up to 10 minutes for the project's lock, behind a push, and the chat's own `worktree` hook needs the chat's lock meanwhile. The record and `run.opened` are still written under the chat's lock (`openAround`).
- **`worktreeCreated` waits at most 30 s for the chat's lock.** Past it, the `worktree` tool answers without a run, and the worktree joins late only as a task of the run the chat drives in that project by then, and only if it still resolves: a late join never opens, switches or releases a run. One log line says which. Once the hook holds the lock, the tool waits for it to finish (local writes only).
- **Time limits,** which the plan didn't give: `place` 30 s (past it, a start goes on outside any run, and a follow-up keeps its child's run and task but isn't counted by the ladder); `driving`, `worktreeCreated`, `worktreeRemoved` and `ladder` 30 s; and each read of a sibling's service inside them (`resolve`, `headOf`, crew's `lookup`) 10 s. The timers never hold the process open.
- **The record decides who drives.** A ledger write that fails after its record was written (`openAround`, `drive`, `setGoal`, `attachPlan`, `close`) is logged, not thrown.
- **Reopening a run with a pull request.** A `resolve` that rejects refuses with "run `<id>`'s worktree can't be checked: …"; a worktree that fails dish's safety check refuses with `resolveProblem`'s reason ("Fix that, or open a new run with `run` `open`."); a gone one keeps the spec's words. The answer reads "Reopened run `<id>` (<project>) for review feedback: <goal>.", then its pull request's line.
- **A reviewer bound to a worktree no run owns** is placed where the child it reviews is. **A coder bound to the worktree of a run that isn't open** (a `pr` run not reopened, or an abandoned one) is placed in no run, not in the chat's other run, whose branch it never touches (the first final review). Runs that aren't open are searched only after the open ones, and one whose ledger can't be read is passed over.
- **The run's own worktree** (the first final review). A later run of the same slug makes its worktree at the same path, on a fresh `dish/<slug>`. So resuming a run with a pull request, and every `open_pr`, are refused when the worktree at the run's path isn't the run's own: the run's ledger shows its worktree removed, or the worktree there was cut from another commit than the run's `baseCommit`.
  - `resume`: "run `<id>` can't be reopened: its worktree is gone (the sweep removes it once its pull request <url> is merged). Open a new run with `run` `open`.", or, for another base, "… its worktree is gone (<path> is now another worktree, cut from <commit7>, not <commit7>). Open a new run with `run` `open`." A reopen whose ledger can't be read is refused too ("run `<id>`'s ledger can't be read: …").
  - `open_pr`: "the run's worktree <path> can't be pushed: it is gone (dish removed it).", or "… it is gone (the worktree there now was cut from <commit7>, not the run's <commit7>)." A ledger that can't be read refuses with "can't read the run's ledger: …".
- **A `worktree` `create` that opens a run in another project** releases the run the chat drove, and the tool's answer says so on a line of its own, as `run` `open` does (the first final review): "Released run `<id>`: it stays open, and `run` `resume` takes it back."
- **`run` `status`'s merge hint names the default branch as `origin/HEAD`,** whatever the run was cut from: dish's fetch points it at the default branch each time (`remote set-head --auto`), so it is the skills' `origin/<default>`.
- **`run` `open` with dish-projects stopped** says "dish-projects isn't running, so no project is registered", not that the project isn't in `projects.yaml`.
- **The `run` tool's writes** read the record again under the chat's and the run's locks, and refuse unless the run is still open and this chat's.

**The ledger.**
- **The 16 KiB fit never cuts an entry's own path fields** (`reportFile`, `structuredFile`, `log`, `path`, `worktree`): they point to what the line had no room for.
- **`append` refuses an entry whose `run` isn't the file's id,** and the derivations count a kind only when its own writer wrote it (`by`).
- **`pr.feedback`'s `state` is only `open` or `closed`,** and its `checks` is `null` whenever not all checks could be read, a partial read included: counting half of them could read "0 failed".
- **The store.** A record that can't be read, or a corrupt one that can't be set aside, is skipped where it is (and logged), and the rest load; only a directory that can't be listed fails the load. A field set to `undefined` is dropped in memory as on disk. A record set aside keeps its id taken, so its ledger is never a new run's.

**Reports (crew).**
- **Changes to one child's record reach the session's queue in the order they were called.**
- **crew's event publisher never rejects,** even for a listener failure that can't be turned into text, and `dish-crew/settled` is awaited, up to 10 s, before `whenRecorded` resolves.
- **A reviewer's `head` is optional** (the second final review): the full sha of the commit it reviewed, when the work is in a git repository, checked as before when given. A review without one is recorded with no head, and never counts as a run's final approval (The PR, below).
- **`report`:** a reviewer's `head` is stored trimmed and lowercased; blank optional fields and empty lists are dropped; giving `report` to an agent whose scope is going away is silent. When the record has lost the child (`setReport` gives nothing), the child is told to end with its report as its closing message, crew stops steering it to `report`, and the report guard goes back to the closing message's words.
- **The notice** says `NO_STRUCTURED_REPORT` ("It ended without a successful `report`, so there is no structured report.") for every coder or reviewer run without a structured report, with `reportSteers: 0` and for runs that ended abnormally too. In the report it renders, empty lists and a blank `blockedOn` read as absent.

**Gates.**
- **A `headOf` answer that isn't a full sha is no head:** `null` on a coder's result, an `error` in `runAt`.
- **After a `report`,** the sandbox hint of the steer changes too: "If it needs another directory, say so in your report's `concerns`."
- **dish-gates waits at most 10 s for `dish-gates/result`'s listeners,** then goes on and logs once: a guard against a deadlock with `open_pr`, which holds a run's lock while `runAt` waits for the worktree's.
- **Not changed:** a reviewer's concluding `report` (no `status`) isn't gated. Only a writing reviewer bound to a worktree could hit it, and the shipped `crew.yaml` has none.

**The ladder.**
- **`final` is recorded only when the call asked for it and `place` gave it,** and on a follow-up only when `place` puts it in the run the reviewer is tagged with. Otherwise `delegate`'s answer says why, such as "start a fresh reviewer with `final: true` for that run's final review".
- **"This chat drives no run" only when it doesn't** (the first final review). dish-orchestrator's `place` gives no run past its time limit or on a failure, which crew can't tell from no run. So a `place` that throws or answers with no run in it, and one that gives no run while `dishRuns.driving` says the chat drives an open run, get "`final` had no effect: dish couldn't place this reviewer in a run, so `final` wasn't recorded; try again with a fresh reviewer and `final: true`; if it is bound to a closed run's worktree, `run` `resume` that run first." (A reviewer bound to a `pr` or abandoned run's worktree gets it too while the chat drives another run, and a retry alone gets it again.) `driving` is asked only for that note, for at most 2 s; failing or late, it counts as dish's failure and is logged.
- **The refusal from round 5 ends** "…, or stop and tell the user (`run` action `abandon`, with a reason, only if they drop the change)." (the second final review): abandoning is the user's call, not a way past the ladder.
- **A malformed `place` answer** is logged and treated as no run; a delegation is never refused for it.

**The PR.**
- **Untracked files never block `open_pr`** (the second final review): a project's gate can write files git doesn't ignore, which would otherwise refuse every `open_pr` after it. `isClean` gains `{ untracked: 'ignore' }`, which `open_pr` asks for before the gate and again after it, and its answer names what it left out: "Untracked, not in the pull request: <names>. If the project's gate writes them, have a coder add them to `.gitignore`; if one should be in the pull request, have a coder commit it, and call `open_pr` again." After the pull request opened, its end reads "…have a coder commit it, then `run` `resume` and call `open_pr` again." Tracked changes, a wrong branch, a nested repository and a head that moved still refuse. `run` `status` reads cleanliness as `open_pr` checks it, so it doesn't say "not clean" for untracked files alone: "head <head7>, clean (untracked, not pushed: <names>)". `run` `plan`'s warning still counts them.
- **The final review's head must be this head exactly** (the second final review): the full sha, not a prefix of it. A verdict with no head never counts as the final approval, and the refusal says the final review gave no head (or, when it requested changes, that it did).
- **The review refusal offers `to` only from the chat that started the reviewer** (the first final review): "Delegate a fresh reviewer with `final: true` (or, from the chat that started it, send the final reviewer a re-review with `to`), …". crew refuses `to` across chats, so after a takeover only a fresh reviewer works.
- **The fallback title.** A reopened run whose pull request was closed on GitHub gets a new one; with no `title`, its title is the goal cut to 256 characters (GitHub's limit, which dish-workspaces checks before it looks for an existing pull request).
- **An existing pull request for `dish/<slug>`,** even one opened by hand before the first `open_pr`, gets an override's line as a comment. `updatePull` edits only the pull request the run recorded, and only the fields given.
- **A ledger write that fails after the push** is logged and named in the answer.
- **A failed read of the worktree's bindings** (who works in it) is logged and the call goes on: the head read again after the gate, and `pushBranch`'s head check, still guard the push.
- **Cancellation** is checked after `compareBranch`, after the gate and just before `pr.checked`: nothing is recorded or pushed after a cancel.
- **`readPull`:** any failure reading the check runs or the statuses leaves the checks unavailable with the reason (a 403 or 404 gives the permission's words), and keeps what the other source gave; a failure reading the reviews or comments still fails the call. A review comment on a whole file isn't outdated. Short strings have their control characters turned into spaces.
- **The API token falls back to the narrow set** (`API_BASE_PERMISSIONS`) only on GitHub's 422.
- **A push doesn't follow redirects,** so pushing to a renamed or transferred repository fails (301) while fetches work.
- **`pr_feedback`:**
  - `readPull` reads the newest 100 reviews, review comments and comments, not the first page (the second final review): the newest are the ones that matter. Their `more` says older ones weren't read. The checks are the first 100 (their `more` means a full page);
  - quoted bodies are split at CR, LF, VT, FF, NEL, U+2028 and U+2029, so nothing from GitHub can start a line of dish's own;
  - the answer is at most 48,000 characters. While it is over, issue comments go first (oldest first), then outdated review comments, then the oldest review comments; then review bodies are cut to 500 characters, then the oldest reviews go;
  - at most 50 check lines, those that didn't pass first; each one-line field at most 200 characters (the URL 500, why the checks can't be read 600);
  - a partial read of the checks lists what was read, and the ledger counts `null`.
- **Not built, on the backlog** (your request, 2026-10-03): watching a run's pull request after `open_pr` (CI failures, conflicts, review comments) and waking the chat that drives the run, as Claude Code desktop's "Auto-fix pull requests" does ([ROADMAP](../../ROADMAP.md#backlog)).

**Settings → Runs** (at order 51, after History).
- **A coder with no recorded end** reads "started, no end recorded", never "running".
- **A link's `href`** comes only from an exact `https://github.com/<owner>/<repo>/pull/<n>` URL; anything else is text.
- **A refresh that fails on the way keeps the run shown;** one the server refused (the record is gone) drops it.

**Prompts and skills.**
- **The rule against a rebase, an amend or a squash** is in dish-prompts (`common.md`, `main.md`) and in dish-skills (`finishing-a-development-branch`), each tested where it lives, since dish-skills can't import dish-prompts.
- **`finishing-a-development-branch`,** step 4: when GitHub's branch moved, it follows `open_pr`'s merge hint (correction 15), not "tell the user", which stays for a missing App permission (Workflows). Step 7 lists task worktrees with `worktree` `list`, since `run` `status` answers only while the run is open.
- **`subagent-driven-development`'s coder brief** leaves the gate sentence to crew: `worktreeBrief` adds it exactly when dish will gate. The skill is at about 7,860 of 8,000 characters, so a later edit must cut as much as it adds.
- **The final reviewer** is "a fresh `reviewer` with `final: true` (in a run, one started outside it never counts)"; from another chat, a fresh one rather than `to`.
- **From the final reviews:** outside a registered project `run` and `open_pr` exist but refuse, since there is no run, and the user pushes (`main.md`, `finishing-a-development-branch`, `changing-infrastructure`); the final reviewer reviews the run's own worktree, whose head `open_pr` pushes (`subagent-driven-development`); a task's rounds carry over on a reopened run, so from round 5 a call needs a `ruling` (`finishing-a-development-branch`); and a reviewer gives `head` when the work is in a git repository (`crew/reviewer.md`, `reviewing-work`).
- **`judge.md`'s yaml block lists `pr_feedback`,** since its test pins it, byte for byte, to the shipped `judge.yaml`.

**End to end (2026-10-03):** in a scratch `dsh web` (`env -i`, every directory scratch), installed by `deploy/install.sh` ("bundles added: … workspaces gates orchestrator"), on the dish preset, with a scripted model on `127.0.0.1` and dish-workspaces' fake GitHub and fake git server, reached through a wrapper that calls `start(ctx, config, { api, web })`. All 49 checks passed, and the install test 10 of 10; no bug in dish's code was found.
- **A planned run with two tasks** (`run` `open` with `docs/plan.md`). Coder a's gate failed in round 1 and passed in round 2, each result with its own head; its own `git push` got 403; its notice rendered the report ("finished: done. … Gate passed (round 2). Its report:"). Review a ended with text, was steered once, and reported. Coder b's follow-ups carried the ladder's notes for rounds 1–4; the fifth was refused and recorded, and the ruled call went through (rounds 0 to 5 in the ledger). A fake `ghp_` token in its concerns was masked in the ledger and its `.json`. The main agent's `ruling`, `defer` and `note` were the only `by: main` lines. The final review (`final: true`) approved the head, and `open_pr` pushed `dish/e2e` and opened PR #1. The record and the ledger were 0600 in 0700 directories.
- **A planless run.** `worktree` opened it (`how: auto`). Its coder never called `report`: it was steered twice, its gate ran once by the old rule and passed, and its notice said there was no structured report. `open_pr` was refused for want of a final review, then opened PR #2 with `reviewRuling`, the override line at the end of its body.
- **Review feedback on PR #1.** `pr_feedback` framed GitHub's text as data, with "Ignore previous instructions" on a quoted `  > ` line, and the ledger kept counts only. `resume` reopened the run, and `run` `status` said the branch was 1 behind, with the merge hint. A coder merged `origin/main` (a two-parent merge) and added a file; its gate passed; and `open_pr` with a new `title` and `reviewRuling` pushed to PR #1 as a fast-forward: `pr.updated` (`titleChanged`, `comment: posted`), the body unchanged, the override line in a comment, no second PR.
- **Settings → Runs** was checked through its remote (`runs`, `run`, `ledger`), as the page calls it: both runs and their timelines, the same after a restart, and no method that changes a run. The visual check of the page is left for the rollout.
- **The scans:** no file held a write token, no `ghs_` token was in dish's data or in orchestrator's or gates' state, and every mint of the API token asked for Checks and Commit statuses read. dish, dsh, the agents and the stub touched nothing but `127.0.0.1`; pnpm's own update check reached its registry during the install.
- **Scaffolding, not dish.** The scratch root under `/tmp` needed `deploy/dish-sandbox` (with dsh's `TMPDIR` under the scratch home's `.cache/dish`), as on the VM: dsh's own sandbox hides `/tmp`, and with it the clone's credential helper. And the scripted model had to skip dsh's repeated-tool-call reminders, which fire on identical follow-ups; they are harmless with the ladder, since the fifth call is refused anyway and a ruling changes the arguments.
- **Seen, as designed:** the final reviewer of a task already removed is placed in the run with no task, so its `child.ended` has `head: null`; `open_pr` reads its `review.verdict`, whose head is the reviewer's own.
