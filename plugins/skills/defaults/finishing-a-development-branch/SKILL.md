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

1. **Run the gate on the final tree:** the branch's tip, not a task's worktree, and not "it passed earlier". Read the whole output and the exit code. If it's red, fix it through a coder in a new worktree from the plan branch, bound with `delegate`'s `worktree` in a registered project (yourself without `delegate`).
2. **Settle the final review.** If no whole-branch review has run, run one (load `requesting-code-review`). Fix blocking and should-fix findings, and rule on the rest.
3. **Confirm the base branch.** If the ledger doesn't record it, check with `git merge-base` and ask the user. A wrong base is expensive to undo.
4. **Report, then offer.** Give the report below, then ask: push the branch and open a pull request, or keep it as it is? Wait for the answer. (In a registered project, skip the offer: see step 5.) Pushing and opening a pull request are outward-facing, so ask every time; a yes for an earlier branch isn't a yes for this one.
5. **On "open a PR":** in a registered project (your chat's workspace is a clone dish set up: `git config --get-regexp '^credential\..*\.helper$'` names `git-credential-dish`), don't push. Agents' git there is read-only by design: only the harness will push, so a push gets a 403, which isn't the remote moving. Say the branch is ready and stop, and never look for other credentials. Elsewhere, push the branch, never with force. A rejected push means the remote moved, so find out why. Open the pull request with `gh pr create`, following the repo's conventions: what changed, why, how it was tested, and the rulings a reviewer should see. Report the URL. Pull request feedback is fixed in a new task worktree cut from the plan branch, made as in `using-git-worktrees`.
6. **The user merges.** If they tell you in so many words to merge this branch, confirm the target, then merge, and run the gate on the merged result before deleting anything. If it fails, stop and leave everything in place.
7. **Clean up only what you created:** the worktrees the ledger says you made for this plan and haven't removed, once their commits are on the branch.
   - Worktrees made by the `worktree` tool go with `worktree` action `remove`, never `git worktree remove`: dish made them, and the tool also takes the branch and the record. The sweep removes merged ones by itself, so one already gone is fine.
   - `remove` refuses one that isn't merged into `origin/<default>` or is dirty. A task worktree cut from the plan branch usually isn't merged there, and a cherry-picked one never is. If `git -C <path> status --short` is empty, `git -C <path> branch --show-current` prints `dish/<slug>`, and `git -C <path> cherry <plan branch>` lists no `+` line, its work is on the plan branch: set `force`. Otherwise show what exists only there and ask; `force` it only when the user says to discard it.
   - Worktrees made with plain git (a repo that isn't a registered project) go with `git worktree remove`, never `--force`.
   - Never touch other worktrees, the user's own checkout, or branches you didn't create. Discard work only when the user says so in as many words.

## Hand back

The gate command with its exit code on the final tree, the review verdict, the pull request's URL or the branch, the worktrees removed and kept, the deferred findings, and a **Rulings** section listing every ruling in order, each with its cost if wrong.
