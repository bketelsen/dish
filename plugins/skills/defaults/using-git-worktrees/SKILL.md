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
- A coder: when the brief asks you to make your own worktree. If the brief gives you one, use it and start at step 4.

Not for a read-only look at a repo.

## Steps

1. Check where you are. Inside a linked worktree, `git rev-parse --git-dir` and `git rev-parse --git-common-dir` differ; if you're already in this task's worktree, don't make another. `git branch --show-current` names the branch.
2. Choose the directory:
   - the one the brief or the main agent names, such as a scratch directory;
   - otherwise a directory inside the repo that git ignores, such as `.worktrees/`. Check it with `git check-ignore -q .worktrees`. If it isn't ignored, stop and ask rather than committing a `.gitignore` change that isn't part of your task.
3. Create it, on a new branch for this task, cut from the feature branch: `git worktree add <dir>/<task> -b <task-branch> <feature-branch>`.
4. Install dependencies the way the repo does (its README, its lockfile, its scripts). Use an offline install where the repo supports one.
5. Run the baseline gate before you change anything, and read the whole output and the exit code. If it fails, stop and report the failures to the main agent (or, if you're the main agent, the user) before starting. Otherwise you can't tell new breakage from old.
6. Note the path, the branch and the base commit (`git rev-parse HEAD`).

## Rules

- Never work on the default branch (`main`, `master`), and never push to it.
- One task, one worktree, one branch. Don't reuse a worktree for a second task.
- Commit only on your task's branch. Don't touch other worktrees or the main checkout.
- A crew child's working directory is the main agent's. Use the worktree's absolute path in file paths, and `git -C <path>` or `cd <path> &&` in commands.
- Cleanup belongs to whoever created the worktree, once its branch is merged or abandoned (the main agent: see `finishing-a-development-branch`). A worktree you were handed isn't yours to remove, and never force-remove one.
- If `git worktree add` is refused (a sandbox, permissions), say so and ask. Don't quietly work in the main checkout instead.

## Hand back

The worktree path, the branch and its base commit, and the baseline gate's command, exit code and summary line, or its failures.
