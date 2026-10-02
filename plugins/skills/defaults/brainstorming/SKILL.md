---
name: brainstorming
description: Use when the user brings an idea, a feature or a change that hasn't been designed yet, before anyone writes a spec, a plan or code for it.
metadata:
  roles: [main]
---

# Brainstorming

Turn an idea into a design the user agrees with, by talking it through. The core principle is **talk before specs**. The user wants the shape of a thing settled in conversation first, and a spec written too early locks in decisions they haven't made. Nothing gets built until the user has approved the design you actually showed them: no spec, no plan, no scaffold, no code.

## When to use

- A new feature, plugin or subsystem, a change in behavior, a "what if we…", or a goal that's still vague.
- Not for a bug with a clear expected behavior: load `systematic-debugging`.
- Not for work that already has an approved spec or plan: load `writing-plans` or `subagent-driven-development`.
- Not for a small change the user has already specified completely. Just do it, test first.

## Pick the path

Classify the request first. When you're torn between two paths, take the heavier one, and re-classify as soon as hidden complexity shows up.

- **Spike:** a feasibility question, such as "can dsh do X?". Agree the question and a cheap probe in two or three sentences, investigate (through a `researcher`, or a `coder` for a throwaway probe), and report a recommendation. Spike code is throwaway. Acting on the answer is a new request.
- **Bounded:** a well-scoped change to existing code. Clarify it, then present a short design in chat: the approach, the files, the tests. Wait for an explicit yes, then build it without a spec document.
- **Architectural:** a new plugin or subsystem, or anything with several moving parts or with decisions the user would want to see. Follow the steps below, which end in a spec at `docs/specs/<topic>.md`.

## Steps (architectural)

1. **Explore the context first.** Read `docs/design.md`, the related specs, the roadmap, the code and the recent commits. Hand wide reading to a `researcher`, or to several at once (load `dispatching-parallel-agents`). Don't ask the user what the repo can tell you.
2. **Check the scope.** If the request is really several independent subsystems, say so now and propose how to split it. Each part gets its own spec, plan and build, in an order you agree.
3. **Talk it through in rounds.** Each round: play back what you heard so far (goal, users, constraints, success), then ask two to four numbered questions, multiple choice where you can, that the user can answer tersely by number. Cover purpose, constraints, success criteria and what's out of scope.
4. **Offer two or three approaches** with their trade-offs. Lead with the one you recommend and say why. Cut anything the goal doesn't need.
5. **Agree the design section by section:** architecture, the components and their boundaries, data flow, errors, testing. Scale each section to its complexity, and ask after each one whether it's right. Build on the patterns the codebase already has. Give each unit one purpose and an interface someone can use without reading its insides.
6. **Wait for the go.** Keep talking until the user says something like "write the spec", "make it so" or "this is a good start". If you can't tell, ask whether to write it up or keep talking.
7. **Write or delegate the spec.** Load `writing-specs`, or delegate the spec to the `architect`. The architect can't see this conversation, so its brief carries every agreed decision with its reason, the open questions, and the paths and links you read. Then ask the user to review the spec before anyone writes a plan.

## When the user is away

If the user has asked you to work on your own, don't stall on questions they can't answer. Make each call yourself, preferring the conventional and reversible option. Record each one, with what it costs if wrong, in the spec's Decisions table under a heading like "Decisions (made without you; please review)". Put anything you couldn't reasonably decide under Open items, then carry on as the user asked.

## Red flags

- "This is too simple to need a design." Simple changes are where unchecked assumptions waste the most work. The design can be three sentences, but present it.
- Treating approval of an idea as approval of a spec that doesn't exist yet. A yes approves what you showed.
- Open-ended questions with no numbers.

## Hand back

At each stage: what you understood, the question or the options, and your recommendation. At the end: the agreed decisions, or the spec's path and the decisions in it that need review, and the next step, which is `writing-plans`.
