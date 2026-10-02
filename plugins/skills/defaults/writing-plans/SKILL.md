---
name: writing-plans
description: Use when an approved spec or agreed design needs turning into an implementation plan, before any code for it is written.
metadata:
  roles: [architect, main]
---

# Writing plans

A plan turns a spec into tasks that a fresh mid-tier coder can carry out one at a time, from the task text alone, each one leaving the repo working and tested. The core principle: **the plan makes every decision a coder can't make alone**: the files, the names, the signatures, the test cases, the exact values. A line that decides nothing is a gap, and the coder will fill it with a guess.

## When to use

- After the user has approved a spec, or agreed a design in chat that's too big for one sitting.
- When the main agent delegates the plan to the architect.
- Not for a bounded change: do it test first.
- Not for a design that isn't agreed yet: that's `brainstorming`, the main agent's (an architect asks the main agent with `send_message`).

## Steps

1. **Read the spec,** `docs/design.md`, and the code the plan will touch. The spec is binding and the plan argues from it. If the spec covers independent subsystems, write one plan for each.
2. **Map the files first.** List what each task creates or changes, and what each file is responsible for. Split by responsibility, follow the repo's layout, and name an existing package to model the new code on.
3. **Size the tasks.** Each should be big enough to deserve its own review, and small enough that one fresh coder can finish it, tests and all, in one sitting. Setup goes in the task that first needs it. Order the tasks so that every one leaves the gate green.
4. **Write `docs/plans/YYYY-MM-DD-<topic>.md`:**
   - **Header:** `# <Topic> Implementation Plan`, a note that it's carried out with `subagent-driven-development` (or `executing-plans`), then **Goal**, **Architecture**, **Tech Stack** and a link to the spec.
   - **Global Constraints:** what holds for every task. Runtime and syntax rules, dependency rules, the branch, the gate command with "check the exit code", no side effects on real state, naming grammars, limits. These are copied into every coder's brief.
   - **Review Focus:** the five or so failure modes that matter most, each tied to the tasks whose tests cover it. Reviewers check these.
   - **File Structure:** every file, with the task that owns it.
   - **Waves:** which tasks need which. Dish runs one coder at a time, so this sets the order and shows where a review can overlap the next task.
   - **Tasks,** each with:
     - **Needs:** the earlier tasks it builds on.
     - **Files:** exact paths to create, modify and test.
     - **Interfaces:** what it consumes and produces, as typed signatures, so later tasks can be planned against them.
     - **Behavior:** the rules, edge cases and error codes, as bullets.
     - **Steps,** as checkboxes: write the failing tests (name every case), run them and watch them fail, implement, run the gate, commit.
     - **Done:** the condition, with the gate green.
     - **Commit:** the exact message subject.
   - **Final review,** and the **live checks** only the user can do.
5. **Self-review, and fix what you find in place:**
   - **Coverage:** point to the task for each requirement in the spec, and list any gaps.
   - **Placeholders:** no TBD, no "add validation", no "handle edge cases", no "same as Task 3". Say which validation and which cases.
   - **Consistency:** each name, signature and type is the same everywhere it appears.
   - **Review Focus:** each failure mode has a test in some task.
   - **Proportion:** code blocks hold signatures and test names, not whole implementations. The plan shouldn't be longer than the spec.
   - **Standalone tasks:** could a coder who never saw the spec do each task from its text plus the Global Constraints?
6. **Commit the plan.** The architect has no shell, so it hands the path back and the main agent commits.

## Red flags

- "The coder will figure it out." A mid-tier coder with no history will guess, and its guess won't be yours.
- "See the spec" in place of a value. Exact strings, limits, error messages and test inputs go in the task text.
- Two tasks that change the same file with no order between them.
- A task whose done condition can't be checked by running something.
- Planning work the spec lists as a non-goal.
- A choice the spec doesn't make, made silently. Make it, and mark it as a ruling (`Ruling: what — why — cost if wrong`) or an open item.

## Hand back

The plan's path, the number of tasks and their order, the riskiest task, the open questions, and a recommendation for how to carry it out: `subagent-driven-development` for most plans, or `executing-plans` for one or two small tasks or when `delegate` isn't available.
