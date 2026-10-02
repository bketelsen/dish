---
name: using-git-worktrees
description: Use when you're starting a task that changes a repo and needs its own branch and directory, before you make the first change.
metadata:
  roles: [main, coder]
---

# Using git worktrees

Every task gets its own worktree and its own branch, so parallel tasks, a failed attempt and a reviewer's checkout never collide. Start from a baseline you've seen pass, so any later failure is one you caused and can explain.

## When to use

- The main agent: before running a plan, or before handing a task to a coder.
- A coder: when the brief asks you to make your own worktree. If the brief gives you one, use it and start at step 4. You don't have the `worktree` tool, so in a registered project the main agent makes your worktree: if the brief asks you to make one inside a project's clone under the work root, ask the main agent with `send_message` instead.

Not for a read-only look at a repo.

## Steps

1. Check where you are. Inside a linked worktree, `git rev-parse --git-dir` and `git rev-parse --git-common-dir` differ; if you're already in this task's worktree, don't make another. `git branch --show-current` names the branch.
2. Make the worktree.
   - **In a registered project** (your chat's workspace is a clone dish set up: `git config --get-regexp '^credential\..*\.helper$'` names `git-credential-dish`): call `worktree` with action `create`, `project` (`owner/repo`), a `slug` (lowercase letters, digits and `-`, at most 40) and, when the task isn't cut from `origin/<default>`, `base`, such as the plan branch. It makes `.worktrees/<slug>` on a new branch `dish/<slug>`. Read its answer: the path, the branch, the base commit, and whether setup ran.
   - **Anywhere else:** use the directory the brief or the main agent names, or one inside the repo that git ignores, such as `.worktrees/` (`git check-ignore -q .worktrees`; if it isn't ignored, stop and ask, don't commit a `.gitignore` change). Then `git worktree add <dir>/<task> -b <task-branch> <feature-branch>`.
3. The main agent hands a worktree to a coder with `delegate`'s `worktree`, set to the path, never only in the task text: that binds the coder, so dish keeps the worktree while it runs. A reviewer isn't bound; give it the path in its task.
4. Install dependencies the way the repo does (its README, its lockfile, its scripts). Use an offline install where the repo supports one. dish runs a project's setup only on code a human merged, so `worktree` skips it when the base isn't on `origin/<default>`: run the command it gave, in the worktree (a coder gets it in the brief).
5. Run the baseline gate before you change anything, and read the whole output and the exit code. If it fails, stop and report the failures to the main agent (or, if you're the main agent, the user) before starting. Otherwise you can't tell new breakage from old.
6. Note the path, the branch and the base commit (`git rev-parse HEAD`).

## Rules

- Never work on the default branch (`main`, `master`), and never push to it.
- One task, one worktree, one branch. Don't reuse a worktree for a second task.
- Commit only on your task's branch. Don't touch other worktrees or the main checkout.
- A crew child's working directory is the main agent's. Use the worktree's absolute path in file paths, and `git -C <path>` or `cd <path> &&` in commands.
- Cleanup belongs to whoever created the worktree, once its branch is merged or abandoned (the main agent: see `finishing-a-development-branch`). A worktree you were handed isn't yours to remove.
- In a registered project, remove an abandoned worktree with `worktree` action `remove`, never `git worktree remove`. It refuses an unmerged or dirty one. `force` throws that work away and deletes the branch `dish/<slug>`, so use it only when `git -C <path> status --short` is empty, `git -C <path> branch --show-current` prints `dish/<slug>`, and `git -C <path> cherry <plan branch>` (the branch its work belongs on) lists no `+` line, or the user said to discard it. Elsewhere, `git worktree remove`, never `--force`.
- If `worktree` or `git worktree add` is refused (not ready, the wrong workspace, a sandbox, permissions), say so and ask. Don't quietly work in the main checkout instead, or make a git worktree in a registered project's clone.

## Hand back

The worktree path, the branch and its base commit, whether setup ran, and the baseline gate's command, exit code and summary line, or its failures.
