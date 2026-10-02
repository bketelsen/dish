---
name: writing-specs
description: Use when a design has been agreed with the user, or you were asked to decide it yourself, and it needs writing down as a spec before anyone plans or builds it.
metadata:
  roles: [architect, main]
---

# Writing specs

A spec records what was decided and why, so a plan can be argued from it and a reviewer can check work against it. The core principle: **the spec is the binding authority.** Every load-bearing decision is written down with its reason, every name and limit is concrete, and nothing is a placeholder.

## When to use

- After `brainstorming` reaches the user's go ("write the spec").
- When the main agent delegates the spec to the architect, with the agreed decisions in the brief.
- When the user is away and asked you to decide the design yourself.
- Not for a bounded change agreed in chat. Not for the plan: load `writing-plans`.

## Steps

1. **Read what exists:** `docs/design.md`, the related specs in `docs/specs/`, and the code and packages you'll build on. Check constraints in the code, not from memory, and name the version you checked.
2. **Write `docs/specs/<topic>.md`:**
   - `# Spec: <name>`, then a **Status** line: draft, the date, the roadmap step, links to what it builds on.
   - **Summary:** a few bullets a reader could stop after.
   - **Decisions:** a table of `# | Topic | Decision | Cost if wrong`. If you decided without the user, the heading says so and asks them to review.
   - **Non-goals:** what it leaves out, and where that goes instead.
   - **The design,** in the sections the subject needs: constraints checked in code, documents and data, interfaces as typed signatures, configuration, UI, errors. Real names, paths, types and limits.
   - **Testing:** what the tests prove and against what, plus the live checks only the user can do.
   - **Open items:** questions only the user can answer, and follow-ups.
   - "Notes from the build" comes later, to record what changed while building.
3. **Self-review, fixing in place:**
   - **Placeholders:** no TBD, no TODO, no "handle errors appropriately", no "etc." where the list matters.
   - **Contradictions:** between sections, and with `docs/design.md`.
   - **Ambiguity:** a requirement two builders could read differently. Pick one reading and write it down.
   - **Scope:** one subsystem. If it has become several, split it.
4. **Commit it on its own.** The architect has no shell; the main agent commits for it.
5. **Ask the user to review it** before a plan is written (an architect hands the path back instead).

## Rules

- Plain words, short sentences, the reader's needs first.
- Every decision has a reason and a cost if wrong.
- Never decide silently what belongs to the user. Ask (an architect asks the main agent with `send_message`), or record it as a decision to review.

## Hand back

The spec's path, the decisions that need the user's eye, the open items, and the riskiest part of the design.
