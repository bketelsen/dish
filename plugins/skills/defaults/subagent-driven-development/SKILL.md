---
name: subagent-driven-development
description: Use when you have an approved implementation plan to carry out with the crew, task by task, in this session.
metadata:
  roles: [main]
---

# Subagent-driven development

You are the controller. You don't write the code: you brief, check, rule, and keep going without stopping to ask. The core principle: **a fresh coder per task, the gate, a cross-family review, and a ledger that remembers for you.**

## When to use

- An approved plan in `docs/plans/`, with `delegate` available.
- Not without `delegate`, or for one or two small tasks: load `executing-plans`. Not without a plan: load `writing-plans`.

## Steps

### Set up

1. **Read the plan once, and the spec it names.** The spec is binding. Note the Global Constraints and the Review Focus.
2. **Start the ledger:** a git-ignored file in your working directory, so the sandbox lets you append without asking. By default it's `.worktrees/<plan file name>-ledger.md` (check `git check-ignore -q .worktrees`). Tell the user the path.
   - The header: the plan, the branch, its base commit, the user's standing instructions.
   - One row per task: the coder's and the reviewer's child ids (so `to` still works after a compaction), the worktree's slug, commits, review, notes.
   - Append every ruling, fix round and deferred finding as it happens.
   - After a compaction, trust the ledger and `git log` over memory; a task marked complete is done.
3. **Scan for conflicts:** tasks that contradict each other or the Global Constraints, share files or interfaces, or disagree with themselves. Rule on each now.
4. **Count delegations:** two starts per task, one more per round 4, two for the final review, plus what this session already used. Follow-ups with `to` are free. If the total exceeds the per-session limit (30 by default, crew.yaml `limits`), tell the user before Task 1.
5. **Work on the plan's branch,** never the default branch. Load `using-git-worktrees`: one worktree per task, each cut from the plan branch.

### Each task

1. **Record BASE** and make the task's worktree with `worktree` (action `create`, a slug for the task, `base` the plan branch). Setup runs only on merged code, so on the plan branch it's usually skipped: keep the command from the answer. That needs a registered project (your chat's workspace is a clone dish set up: `git config --get-regexp '^credential\..*\.helper$'` names `git-credential-dish`); in any other repo, `using-git-worktrees` has the git steps.
2. **Delegate to a fresh `coder`,** with `delegate`'s `worktree` set to that path: it binds the coder, and crew adds the path and branch to its prompt. It can't see this conversation, so the brief stands alone:
   - where the task fits in the project;
   - the task's full text, pasted, plus the plan and spec paths;
   - the Global Constraints, the worktree path and branch, the setup command if it was skipped, and the gate command;
   - the interfaces it uses from earlier tasks, and the rulings that touch it;
   - the report: what changed, the gate output and exit code, the commit sha, concerns, and its rulings as `Ruling: what — why — cost if wrong`;
   - to ask with `send_message` when blocked, not guess.

   Then **end your turn.** You're notified when it finishes; don't poll.
3. **Treat the report as claims.** Run the gate yourself in the worktree. A red gate is a fix round, not a review.
4. **Review.** Delegate a `reviewer` with `reviews` set to the coder's child id. Load `requesting-code-review` for the brief, and put the worktree path in it: `delegate`'s `worktree` is for coders. The next coder may start meanwhile if its task doesn't build on this one; a fix round for the first coder then waits for it to finish.
5. **Fix rounds,** for a red gate and for blocking and should-fix findings. Nits are ledgered as deferred.
   - **Rounds 1–3:** `delegate` with `to` set to the same coder, findings verbatim. It keeps its worktree.
   - **Round 4:** a fresh `coder` with `model` set to the strong tier of its family in `crew.yaml`, given the brief, the open findings and the previous coder's report path, and `worktree` set to the same path.
   - **Round 5:** rule on each open finding. Reviewer wrong, or real but not blocking: park or defer it with a ruling. Real and load-bearing: if a ruling unblocks it (narrow the requirement, or fold the fix into a named later task's brief), make it; otherwise stop: the plan is too broken.
   - After a red-gate round: the gate again, then the first review.
   - After a findings round: a scoped re-review, `to` the same reviewer with `reviews` and `model` empty (it stays tied to the first coder), given the findings, the fix's range and the coder's `Not fixed:` evidence, marking each ADDRESSED or NOT ADDRESSED. If they still disagree, you rule.
6. **Complete the task.** Bring its commits onto the plan branch (fast-forward or cherry-pick), run the gate there, ledger `Task N: complete (base..head, review clean)` or `… K parked`, and remove the task's worktree with `worktree` (action `remove`). Its branch usually isn't merged into `origin/<default>` (a cherry-picked one never is), so `remove` refuses it without `force`. Set `force` only when `git -C <path> status --short` is empty, `git -C <path> branch --show-current` prints `dish/<slug>`, and `git -C <path> cherry <plan branch>` lists no `+` line: its work is on the plan branch.

### Finish

1. **Final whole-branch review:** a `reviewer` with `reviews` set to a coder this session started (`"main"` if there is none), `model` set to the strongest of the reviewer's family, over `git merge-base <default branch> HEAD`..`HEAD`, with the spec, the plan, the Review Focus and the ledger's deferred and parked lines. Then one fix round (a fresh coder in a new worktree from the plan branch, bound with `delegate`'s `worktree`, every finding), one scoped re-review, and rulings on the rest.
2. **Load `finishing-a-development-branch`.**

## Rules

- **Coders run one at a time:** crew allows one writing child among four running, by default (crew.yaml `limits`). Reviewers and researchers may overlap.
- **Never fix a task yourself:** your context is for coordination.
- Never accept "close enough", or skip a re-review because a fix was small.
- **Don't ask "should I continue?"** Stop only for an irreversible or security-sensitive action, a push, a merge into the default branch, or a plan too broken to continue. Bringing a task branch onto the plan branch is routine.
- Every judgment call is a ledgered ruling; a silent decision is a bug.

## Hand back

The tasks with their commits, the final review's verdict, the deferred findings, and a **Rulings** section: every ruling in the ledger, in order, each with its cost if wrong. It's the only place the user sees the decisions you made for them.
