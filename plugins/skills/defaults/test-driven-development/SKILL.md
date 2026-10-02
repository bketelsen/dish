---
name: test-driven-development
description: Use when you're about to write or change code — a feature, a bug fix, a behavior change — before writing the implementation.
metadata:
  roles: [coder, main]
---

# Test-driven development

Write the test first, watch it fail for the reason you expect, then write the least code that makes it pass. A test you never saw fail proves nothing: it may test the wrong thing, or nothing at all.

## When to use

Every feature, bug fix, behavior change and refactor. Skip it only when the main agent's brief says so (or, if you're the main agent, the user), for example for a throwaway spike or generated code. "Too simple to test" is not an exception.

## The iron law

No production code without a failing test first. If you wrote code before its test, delete it and start again from the test. Don't keep it "for reference": you'd end up testing what you wrote instead of what's needed.

## Steps

1. **Red.** Write one test for one behavior, named for that behavior. Before writing its body, name the change to the production code that would make it fail: a wrong branch, a missing side effect, an off-by-one. If you can't name one, the test guards nothing.
2. Derive the expected value by hand, as a literal or a fixture you checked yourself. Never compute it with the code under test or its helpers, or the test passes whatever the code does.
3. Run it and watch it fail. It must fail, not error, and for the right reason: the behavior is missing, not a typo or a bad import. If it passes, it tests something that already works. Fix the test.
4. **Green.** Write the simplest code that passes: no options, no extra cases, nothing "while I'm here".
5. Run the test, then the rest of the suite. If something fails, fix the code, not the test. Warnings count as failures.
6. **Refactor** with everything green: names, duplication, helpers. No new behavior.
7. Repeat for the next behavior. A bug fix starts with a test that reproduces the bug.
8. Before you finish, run the repo's whole gate, not just your file, and check its exit code.

## Good tests

- Don't mock what you can run: use real stores, files and git repos in temporary directories. Mock only what's slow or external, like a network service or a model, and give the fake the real shape.
- Assert behavior, never that a mock exists or was called.
- Test what depends on a decision, not the decision: not "the limit is 5", but "the sixth try never happens".
- Keep test-only helpers in test files, never in production code.
- No sleeps. Wait on the condition (see `systematic-debugging`).

## Red flags

Go back to red if you notice code written before its test, a test that passed on its first run, a failure you can't explain, "I'll add tests after", "I checked it by hand", "deleting it wastes the work", "I'm being pragmatic", or "this case is different".

## Hand back

For each behavior: the test's file and name, the failure you saw before the fix (one line), and that it passes now. Then the gate command, its exit code and its summary line.
