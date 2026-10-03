---
name: reviewing-work
description: Use when you're asked to review work against its brief — a task's commits, a whole branch, a fix round, or a spec, plan or document.
metadata:
  roles: [reviewer]
---

# Reviewing work

Check the work against what was asked, and prove every finding. The author's report is a list of claims; the diff, the gate and the spec are the evidence. You report; you don't edit.

## When to use

A task's commits (`BASE..HEAD`) against its task in the plan; a whole branch against the spec; a fix round against your earlier findings; a spec, plan or document against its brief. Not for fixing what you find.

## Steps

1. Read the brief: the spec, the task, the review focus, the gate command and `BASE..HEAD`. You can't see the conversation, so ask the main agent with `send_message` if anything is missing. Note each claim the author's report makes.
2. Get the change: `git log --oneline BASE..HEAD`, `git diff --stat BASE..HEAD`, then `git diff BASE..HEAD`. Read code outside the diff only to check a risk you can name, such as a changed contract's callers.
3. Run the gate yourself, without piping it through `tail`, and read the whole output and the exit code. A failing gate is a blocking finding, whatever the report says.
4. First verdict, spec compliance. Does it do exactly the task?
   - missing: asked for and not done, or claimed and not done;
   - extra: not asked for;
   - wrong: asked for, built another way.
5. Second verdict, quality: edge cases and errors, tests that would fail if the behavior broke (not tests of mocks), the repo's conventions, docs that no longer match.
6. Write each finding with its severity (`blocking`, `should_fix` or `nit`), the file and line, a concrete failure (the inputs or state, then the wrong result), and the fix. If you can't name a failure, it's a nit or nothing.
7. Rank the findings, most severe first. When there are none, `findings` is empty and your summary says so.

## Re-review mode

Your scope is the earlier findings (yours, or the ones the brief lists) and the fix diff, from the head that was reviewed to the new one. Run the gate again.
- Mark each finding in `addressed`: whether it is addressed, with the evidence (a file and line). An attempt isn't addressed: the failure must be gone.
- Flag anything the fix broke, with a severity.
- Name anything outside the fix diff as out of scope in your summary. It doesn't block.

## Specs, plans and documents

The same steps, without the diff. A spec: every decision has a reason, and nothing contradicts. A plan: a fresh coder could do each task from its text alone, and every file and interface it names exists or comes from an earlier task. A document: it serves its reader, and every command, name and path matches its source.

## Rules

- Review against the spec, the task and the repo's conventions, not your taste.
- A stated reason ("kept simple", "YAGNI") never lowers a severity.
- Read-only: `bash` is for git, the gate, tests and other read-only commands. Never change the working tree, the index or HEAD. To read another revision, use `git show <rev>:<path>`.

## Hand back

Finish by calling `report`: `verdict` `approved` only when no finding is `blocking` or `should_fix`, else `changes_requested`; `head`, the full sha of the commit you reviewed (`git rev-parse HEAD`), when the work is in a git repository (a review without one never counts as a run's final approval); a `summary` with the spec-compliance and quality verdicts; the `findings`, ranked; the gate and the other commands you ran in `checks`, each with its exit code and summary line; and in a re-review, `addressed`. No preamble.
