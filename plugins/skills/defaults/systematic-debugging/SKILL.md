---
name: systematic-debugging
description: Use when a test fails, a build or gate breaks, or something behaves unexpectedly, before you propose or make any fix.
metadata:
  roles: [coder, ops, main]
---

# Systematic debugging

Find the root cause before you fix anything. A fix you can't explain only moves the symptom. Three failed fixes in a row usually mean the design is wrong, not the last guess.

## When to use

Any failure: a red test, a failing gate, a broken build, a service that won't start, a wrong value. Most of all when a fix looks obvious, or one just didn't work. Not for new behavior with no failure yet.

## Phase 1: investigate

1. Read the whole error: the message, the stack, the file and line, the exit code.
2. Reproduce it reliably, with exact steps. If it's intermittent, gather data until it isn't. Don't guess.
3. Check what changed: `git diff`, `git log`, dependencies, config, the environment.
4. Trace the bad value back. Ask what passed it in, then what passed that, until you reach where it was made. Fix it there, not where it surfaced.
5. Across components, record what goes in and out at each boundary, run once, and see which one breaks.

## Phase 2: compare

Find similar code that works, here or in the reference you're following. Read it in full and list every difference. Don't assume a difference can't matter.

## Phase 3: hypothesize

State one hypothesis: "X causes it, because Y." Test it with the smallest change, one variable at a time. If it's wrong, undo the change and form a new one. Don't stack fixes. If you don't understand something, say so.

## Phase 4: fix

1. Write a failing test that reproduces the bug first (coder and main: load `test-driven-development`).
2. Make one fix, at the source. No refactoring along the way.
3. Run the test, then the gate, and check the exit codes.

## After three failed fixes

Stop; don't try a fourth. Fixes that each expose a new problem point at the design, which isn't yours to decide alone. Report to the main agent with `send_message` (or, if you're the main agent, to the user): what you tried, what each attempt showed, and what you now think the real question is.

## Red flags

Go back to phase 1 if you notice: a fix proposed before you traced the value, "quick fix now, investigate later", "it's probably X", "no time for this", several changes at once, skipping the test, or one more try after two failed ones.

## Rules

- Wait on conditions, not time: instead of a `sleep`, poll for the state you need (the file exists, the event arrived), with a timeout and a clear message. A fixed delay is right only when timing is what you're testing.
- Never hide a failure: no `| tail` or `| head` on a gate or test run, no `|| true`, no skipped or deleted tests. Check exit codes.
- Remove temporary logging before you finish.
- "No root cause" usually means an unfinished investigation. If it really is out of reach, say what you checked.

## Hand back

The root cause (what, where, why), the evidence for it, the fix and its test, and the gate result with its exit code. If you stopped, what you tried and what you learned.
