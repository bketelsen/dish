---
name: dispatching-parallel-agents
description: Use when you face two or more independent questions or checks, such as research, investigations or reviews, that could run at the same time without sharing files or waiting on each other.
metadata:
  roles: [main]
---

# Dispatching parallel agents

Independent questions answered one after another cost wall-clock time and fill your context. Give each one to its own crew child, all at once, with a brief that stands on its own, then put the answers together. The core principle: **one child per independent problem, a self-contained brief for each, and you check the results against each other.**

## When to use

- Several questions that don't depend on each other: three libraries' docs to read, failures in unrelated subsystems, a spec and a plan to review, background reading before a brainstorm.
- Not when the problems are related, so fixing one may fix the others. Investigate them together.
- Not when you don't yet know what's broken. Look first, then split.
- Not when the children would write the same files or share a resource.
- Not for coders: writing work runs one task at a time.

## Crew limits

By default (crew.yaml `limits`):
- at most **four** crew children run at once;
- only **one** may be a writing role (architect, coder, ops, writer). Researchers and reviewers are read-only, so they're the ones to run in parallel;
- a session may start **30** delegations. Follow-ups with `to` don't count.

`delegate` refuses a call that breaks a limit and says who's running. Wait for a notice, or pick a read-only role.

## Steps

1. **Split the work into independent domains.** Check that no two write the same file, and that none needs another's answer first.
2. **Write one brief per child.** It can't see this conversation, so give it:
   - one problem;
   - the context it needs: paths, error output, versions, links;
   - the constraints: read-only or not, what not to touch;
   - the shape of the answer: the answer first, then evidence with citations, then open questions.
3. **Delegate them all in the same step, then end your turn.** You're notified as each finishes; don't poll.
4. **When they're all back,** read each report (the notice gives its path) and check them against each other: contradicting findings, overlapping edits, an assumption one child made that another disproved. Spot-check the claims that matter against their sources (load `verification-before-completion`).
5. **Merge the answers** into one for the user, keeping disagreements and unknowns visible.

## Red flags

- One brief that says "fix all the failing tests". Split it by domain.
- A brief that says "as discussed". The child wasn't there.
- Two coders at once. Crew refuses it, and the files would conflict anyway.
- Passing on a finding that contradicts another child's without checking which is right.

## Hand back

The merged answer, each child's key finding with its report path, the conflicts and how you settled them, and the open questions.
