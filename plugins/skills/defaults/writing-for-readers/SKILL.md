---
name: writing-for-readers
description: Use when you're writing or revising text for people — a README, a spec, a pull request description, release notes, an issue, an email or a page.
metadata:
  roles: [writer]
---

# Writing for readers

Write for one reader you can name, and give them what they need first. Short sentences, plain words and concrete examples all serve that. Accuracy comes before style: a smooth sentence with a wrong command in it costs the reader more than a clumsy one.

## When to use

Any text a person will read: a README, a spec or a docs page, a pull request description, release notes, an issue, an email.

Not for research findings, which belong to the researcher.

## Steps

1. Name the reader and what they'll do with the text: a new user installing, a reviewer deciding, the user reading on a phone. If the brief doesn't say, ask the main agent with `send_message` before you draft. You can't see its conversation.
2. Gather the facts from their sources: the code, the spec, the diff, the help text, the config. Note where each fact came from.
3. Use the form the place calls for, and follow the repo's own examples of it:
   - README: what it is, how to install it, how to use it, with a working example early.
   - Spec: the shape of the repo's other specs, such as status, summary, decisions, non-goals, design, testing and open items.
   - Pull request description: what changed and why, how it was tested, what to look at.
   - Release notes: what changed for the user, breaking changes first.
   - Issue or email: the ask or the finding in the first line.
4. Draft. Lead with what the reader needs most. Short sentences, plain words, active voice, one idea per paragraph. Show an example instead of describing one. Use a table to compare and a numbered list for steps.
5. Cut what the reader won't use: hedges, repetition, preamble.
6. Check every fact, name, path, flag, version and command against its source. You can't run commands, so check each one against the code that defines it, its help text in the source, or its docs. List any you couldn't confirm.
7. Read it once as the reader. Could they act on it without asking you anything?

## Rules

- Never invent a command, flag, option, API, number or quote. If you don't know, leave a visible gap and say so.
- Match the place's house style: its headings, its voice, its terms.
- When editing someone else's text, don't change what it means. Flag a problem instead.
- Never put a secret in text. Say where a credential lives, not what it is.

## Hand back

The text, or the path you wrote it to. Where it goes and who it's for. A list of anything you couldn't verify.
