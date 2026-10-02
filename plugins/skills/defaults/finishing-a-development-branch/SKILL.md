---
name: finishing-a-development-branch
description: Use when every task on a branch is done and reviewed and the work needs wrapping up, before you report it finished or offer a pull request.
metadata:
  roles: [main]
---

# Finishing a development branch

A branch isn't done when its last task is. It's done when the final tree passes the gate, a whole-branch review is settled, and the user has decided what happens to it. The core principle: **humans merge.** You verify, you offer, and you wait.

## When to use

- At the end of `subagent-driven-development` or `executing-plans`, or whenever you're about to call a branch ready.
- Not while a review still has an open blocking or should-fix finding.

## Steps

1. **Run the gate on the final tree:** the branch's tip, not a task's worktree, and not "it passed earlier". Read the whole output and the exit code. If it's red, fix it through a coder first (yourself without `delegate`).
2. **Settle the final review.** If no whole-branch review has run, run one (load `requesting-code-review`). Fix blocking and should-fix findings, and rule on the rest.
3. **Confirm the base branch.** If the ledger doesn't record it, check with `git merge-base` and ask the user. A wrong base is expensive to undo.
4. **Report, then offer.** Give the report below, then ask: push the branch and open a pull request, or keep it as it is? Wait for the answer. Pushing and opening a pull request are outward-facing, so ask every time; a yes for an earlier branch isn't a yes for this one.
5. **On "open a PR":** push the branch, never with force. A rejected push means the remote moved, so find out why. Open the pull request with `gh pr create`, following the repo's conventions: what changed, why, how it was tested, and the rulings a reviewer should see. Report the URL. Pull request feedback is fixed in a new task worktree cut from the plan branch.
6. **The user merges.** If they tell you in so many words to merge this branch, confirm the target, then merge, and run the gate on the merged result before deleting anything. If it fails, stop and leave everything in place.
7. **Clean up only what you created:** the worktrees the ledger says you made for this plan, once their commits are on the branch, with `git worktree remove` and never `--force`. A refusal means files exist only there: show them and ask. Never touch other worktrees, the user's own checkout, or branches you didn't create. Discard work only when the user says so in as many words.

## Hand back

The gate command with its exit code on the final tree, the review verdict, the pull request's URL or the branch, the worktrees removed and kept, the deferred findings, and a **Rulings** section listing every ruling in order, each with its cost if wrong.
