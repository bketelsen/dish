---
name: receiving-code-review
description: Use when review findings come back on your work — from the reviewer, the main agent or the user — before you change anything in response.
metadata:
  roles: [main, coder, architect, ops, writer]
---

# Receiving code review

A finding is a claim about your work, not an order. Check each one against the code (or the document, or the machine) before you act. Fix what's real, test-first, and push back with evidence on what isn't. The fix shows you heard it; saying so doesn't.

## When to use

- A fix round: the main agent sends the reviewer's findings back to you with `delegate` and `to`.
- Comments from the main agent or the user on your change, spec, plan, document or config.
- The main agent: a reviewer's findings on your own work (`reviews: main`).

Not for reviewing someone else's work. That's `reviewing-work`.

## Steps

1. Read every finding before you touch anything.
2. Restate each one in your own words: what's wrong, where, and what would show it. If you can't, it's unclear.
3. Ask about every unclear finding at once, before changing anything. A crew child asks the main agent with `send_message`; the main agent asks the user. Findings are often related, and fixing half of them on a guess wastes a round.
4. Verify each finding. Read the code at its file and line, and reproduce the failure it describes. Check whether the suggestion breaks something else, whether the current form has a reason, and whether the reviewer had the context: a reviewer sees the diff and the brief, never the conversation.
5. Decide, per finding:
   - real: fix it;
   - wrong: push back with evidence, such as a test, an output, a file and line, or the spec's words;
   - can't verify: say what you'd need to check it.
6. YAGNI check: before adding anything "proper" (extra options, metrics, an abstraction), check who would use it. If nothing does and the task didn't ask for it, say so instead of building it.
7. Fix one finding at a time, blocking ones first. For code, write the test that shows the failure first (coder and main: load `test-driven-development`), then fix, then rerun it.
8. If a finding conflicts with the task, the spec or an earlier ruling, don't pick a side silently. Name the conflict; the main agent decides.
9. If you have `bash`, run the repo's gate after the last fix and read its exit code; when your brief says dish runs the gate, dish runs it when you `report` `done`. Without `bash`, re-read each changed passage against its source, and say the gate wasn't run.

## Rules

- No performative agreement: no "great catch", no "you're absolutely right", no thanks. State the fix.
- A finding you didn't verify isn't fixed, only changed.
- If you pushed back and were wrong, say so in one line and fix it.
- Stay inside the findings. Note anything else in the report instead of fixing it.

## Hand back

One line per finding, in the order you got them:

- `Fixed: <finding> — <what changed, file:line, the test or check that covers it>`
- `Not fixed: <finding> — <why, with the evidence>`

Then the gate result, or that you couldn't run it, and anything still open. A coder puts these in `report`: the fixes in `summary`, and each `Not fixed:` line as an entry of `notFixed`.
