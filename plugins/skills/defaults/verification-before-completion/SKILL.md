---
name: verification-before-completion
description: Use when you're about to say work is done, fixed, passing or correct — before a closing report, a commit, a pull request, or passing on what a child or a tool told you.
metadata:
  roles: [main, architect, coder, reviewer, researcher, ops, writer]
---

# Verification before completion

No claim without fresh evidence. Before you say something is done, run the check that proves it, read all of its output, and only then say it, with the evidence beside it. "Should work" is not a status.

## When to use

Before any claim of success: a closing report, a commit, a pull request, "fixed", "passes", moving on to the next task, or passing on what a child or a tool reported. Every role, every time.

## Steps

1. Name the claim: "the gate passes", "the bug is fixed", "the commands in this page work".
2. Name the check that proves it: a command, a read-back, a source.
3. Run it now, in full. A run from before your last change doesn't count.
4. Read the whole output and the exit code. Count the failures and the warnings. Never pipe a gate or a test run through `tail` or `head`: the summary hides failures, and the pipe hides the exit code.
5. If the output proves the claim, state it with the evidence. If it doesn't, state what's actually true, with the evidence.

A task is done when each of its requirements is checked, not when the tests pass. Re-read the task and check every item.

## By role

- **coder:** the repo's gate on your final tree, exit code 0. Done means the gate passed. For a bug fix, the test that reproduced the bug now passes.
- **reviewer:** you ran the gate yourself. A report that says it passed is not evidence.
- **main:** a child's report is a claim. Check its commits and diff (`git log`, `git diff BASE..HEAD`), the gate, and the files it says it wrote.
- **architect:** every file and interface the plan names exists in the repo, or is created by an earlier task. Every command it names exists in the repo's scripts or docs.
- **researcher:** the source actually says it. Open the link, or the file at the line, and read it again.
- **writer:** every command, name, path and flag checked against its source: the code, its help text, the config.
- **ops:** the status after the change, such as the service status, the health check or the log line, compared with the status before.

## Red flags

- "should", "probably", "looks right", "seems to";
- feeling done before the check ran;
- trusting a child's, a tool's, or your own earlier report;
- a partial check standing in for the full one: a linter for a build, one test file for the suite;
- "just this once".

## Hand back

Each claim next to its evidence: the command with its exit code and summary line, or the link or file and line. Say plainly what you couldn't verify, and why.
