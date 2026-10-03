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
   - that it finishes with `report`, its commits and rulings included;
   - to ask with `send_message` when blocked, not guess.

   Then **end your turn.** You're notified when it finishes; don't poll.
3. **Read the notice.** Its opening, up to `Its report:`, is dish's: the coder's `status` and the gate line. `blocked` or `needs_context` needs your answer, with `to`. A gate that didn't pass is a fix round, not a review. The report after it is claims: check its commits. With no gate line, run the gate yourself in the worktree.
4. **Review.** Delegate a `reviewer` with `reviews` set to the coder's child id. Load `requesting-code-review` for the brief, and put the worktree path in it: `delegate`'s `worktree` is for coders. The next coder may start meanwhile if its task doesn't build on this one; a fix round for the first coder then waits for it to finish.
5. **Fix rounds,** for a red gate and for blocking and should-fix findings. Nits are deferred (`run` action `defer`). dish counts each task's rounds; `delegate`'s answer names the round.
   - **Rounds 1–3:** `delegate` with `to` set to the same coder, findings verbatim. It keeps its worktree.
   - **Round 4:** a fresh `coder` with `model` set to the strong tier of its family in `crew.yaml`, given the brief, the open findings and the previous coder's report path, and `worktree` set to the same path.
   - **Round 5:** rule on each open finding. Reviewer wrong, or real but not blocking: park or defer it with a ruling. Real and load-bearing: if a ruling unblocks it (narrow the requirement, or fold the fix into a named later task's brief), make it, and pass it as `delegate`'s `ruling` (`Ruling: what — why — cost if wrong`): from round 5, it refuses coder work without one. Otherwise stop: the plan is too broken.
   - After a red-gate round: the first review.
   - After a findings round: a scoped re-review, `to` the same reviewer with `reviews` and `model` empty (it stays tied to the first coder), given the findings, the fix's range and the coder's `notFixed`, marking each finding addressed or not. If they still disagree, you rule.
6. **Complete the task.** Bring its commits onto the plan branch (fast-forward or cherry-pick), run the gate there, record `Task N: complete (base..head, review clean)` or `… K parked` (`run` action `note`), and remove the task's worktree with `worktree` (action `remove`). Its branch usually isn't merged into `origin/<default>` (a cherry-picked one never is), so `remove` refuses it without `force`. Set `force` only when `git -C <path> status --short` is empty, `git -C <path> branch --show-current` prints `dish/<slug>`, and `git -C <path> cherry <plan branch>` lists no `+` line: its work is on the plan branch.

### Finish

1. **Final whole-branch review:** a `reviewer` with `final: true`, `reviews` a coder this session started whose gate passed (`"main"` if none), `model` the strongest of the reviewer's family, over `git merge-base <default branch> HEAD`..`HEAD` in the run's own worktree (the head `open_pr` pushes needs its approval), with the spec, the plan, the Review Focus and the deferred and parked findings. Then one fix round (a fresh coder in a new worktree from the plan branch, bound with `delegate`'s `worktree`, every finding), one scoped re-review of the new head, and rulings on the rest.
2. **Load `finishing-a-development-branch`:** for the pull request, and later for review feedback on it.

## Rules

- **Coders run one at a time:** crew allows one writing child among four running, by default (crew.yaml `limits`). Reviewers and researchers may overlap.
- **Never fix a task yourself:** your context is for coordination.
- Never accept "close enough", or skip a re-review because a fix was small.
- **Don't ask "should I continue?"** Stop only for an irreversible or security-sensitive action, a merge into the default branch, or a plan too broken to continue. Bringing a task branch onto the plan branch is routine, and so is `open_pr` at the end.
- Every judgment call is a ruling, recorded with `run`; a silent decision is a bug.

## Hand back

The pull request's URL, the tasks with their commits, the final review's verdict, the deferred findings, and a **Rulings** section: every ruling in the run's ledger, in order, each with its cost if wrong.
