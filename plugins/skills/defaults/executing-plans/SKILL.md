---
name: executing-plans
description: Use when you have an approved implementation plan to carry out yourself, because `delegate` isn't available or the plan is only one or two small tasks.
metadata:
  roles: [main]
---

# Executing plans

You carry out the plan alone, with the ledger, gate, review and rulings the crew would use. The core principle: **the decisions are made; carry them out and prove it.** The proof is a test that failed before your change and passes after it; the ledger keeps what a compaction would erase.

## When to use

- There's no `delegate` tool in this session.
- A plan of one or two small tasks, where a coder and reviewer per task cost more than they save.
- Not for a longer plan when `delegate` is available: load `subagent-driven-development`.

## Steps

1. **Read the plan and its spec once.** The spec is binding. Rule on any conflict between tasks, or with the Global Constraints, before you start.
2. **Start the ledger** by the rule in `subagent-driven-development`: a git-ignored file in your working directory, by default `.worktrees/<plan file name>-ledger.md`. After a compaction, trust it and `git log` over memory.
3. **Never work on the default branch.** Load `using-git-worktrees`.
4. **Load `test-driven-development`** before Task 1.
5. **For each task:**
   1. Record BASE and re-read the task's text, not your memory of it.
   2. Write the failing tests it names, run them, and watch them fail for the right reason.
   3. Implement, then run the tests and the gate. Compare the output with what the plan expects.
   4. If the code is wrong, load `systematic-debugging`. If the plan is wrong, make the smallest decision the spec supports and record `Ruling: what — why — cost if wrong`.
   5. Commit with the plan's message. Load `verification-before-completion`, then ledger `Task N: complete (base..head, gate: <command> → exit 0)` straight away.
6. **Review the whole branch.** With `delegate`, delegate a `reviewer` with `reviews: "main"` and load `requesting-code-review`. Without it, review your own diff against the spec and the Review Focus, and say in your final message that a self-review is weaker than a cross-family one.
7. **Fix blocking and should-fix findings once,** each test first, with the whole gate after each. Ledger nits as deferred. A finding you decline is a ruling.
8. **Load `finishing-a-development-branch`.**

## Rules

- Don't check in between tasks. Stop only for an irreversible or security-sensitive action, a push, a merge into the default branch, or a plan too broken to continue. Bringing a task branch onto the plan branch is routine.
- One ledger line per task, written with its commit.
- "It should pass" isn't evidence. Run it and read the exit code.
- A deviation from the plan without a ruling is a secret decision.

## Hand back

The tasks with their commits, the gate command and its exit code on the final tree, which review was done (cross-family or self-review), the deferred findings, and a **Rulings** section listing every ruling in order, each with its cost if wrong.
