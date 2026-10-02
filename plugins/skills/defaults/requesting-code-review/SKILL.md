---
name: requesting-code-review
description: Use when a task, a fix round or a whole branch is finished and needs checking by a reviewer, before you build on it or offer it to the user to merge.
metadata:
  roles: [main]
---

# Requesting code review

A review helps only if the reviewer judges the work, not your account of it. In dish it runs on another model family, which the harness enforces. The core principle: **give the reviewer a precise brief (what should exist, where the change is, how to check it) and never your conversation.**

## When to use

- After every task and every fix round in `subagent-driven-development`, and over the whole branch before finishing it.
- On your own work before a pull request (`reviews: "main"`), or when you're stuck.
- Not for a plain question about the code: that's a `researcher`.

## Steps

1. **Find the range:** BASE, recorded before the work started, to HEAD. Never `HEAD~1`: work may span commits. For a whole branch, BASE is `git merge-base <default branch> HEAD`.
2. **Write the brief:**
   - what was built, in a line;
   - the task's text, pasted, plus the spec and plan paths;
   - the worktree or branch, and `BASE..HEAD`;
   - the gate command, which it runs itself, and the Review Focus and Global Constraints, copied in;
   - the coder's report, marked as claims to verify;
   - for a re-review: the earlier findings, the coder's `Not fixed:` lines with their evidence, and the fix's range, asking ADDRESSED or NOT ADDRESSED for each, and new breakage in the fix only;
   - the report shape: a verdict, then findings, each with a severity (blocking, should fix or nit), `file:line`, the concrete failure and the fix, plus the gate output and exit code.

   Don't pre-judge: never tell the reviewer to ignore an issue or cap a severity.
3. **Delegate to `reviewer`** with `reviews` set to the child whose work it is, or `main` for your own. For a final review, set `model` to the strongest model of the reviewer's family. For a re-review, use `to` with the same reviewer and leave `reviews` and `model` empty. Then end your turn.
4. **Sort the findings:**
   - **Blocking and should fix:** through the fix rounds (`delegate` with `to` the coder), then a re-review. **Nits:** ledgered as deferred.
   - **One you think is wrong:** check it against the code. If it still looks wrong, push back with evidence (load `receiving-code-review`) and record a ruling.
   - **"Can't verify from the diff":** you hold the cross-task context, so check it yourself. A real gap is blocking.

## Red flags

- Skipping review because the change is small.
- Pasting the chat into the brief.
- Arguing with a valid finding, or accepting a wrong one.
- Building on work with an open blocking or should-fix finding.

## Hand back

The verdict, each blocking or should-fix finding with what was done about it, and the deferred findings: to the user if they asked, otherwise in the ledger.
