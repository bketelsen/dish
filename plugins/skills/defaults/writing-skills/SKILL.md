---
name: writing-skills
description: Use when the user asks for a new dish skill or a change to one, or when a skill misled you or a crew child, before you propose any change under `skills/`.
metadata:
  roles: [main]
---

# Writing skills

Dish keeps skills in the config store at `skills/<name>/SKILL.md`; the user edits them on Settings → Skills, and you change them only by proposal. The core principle: **a skill is code for agents, so test it like code.** Before proposing, see an agent fail without the change and succeed with it, even for "just wording".

## When to use

- A reusable technique, a mistake agents repeat, a misleading skill, or one the user wants changed.
- Not for a one-off fix, a project convention (the repo's docs or a role prompt), or a rule a check could enforce.

## The format

- **Frontmatter:** `name` is the directory's name (lowercase, hyphens, at most 64 characters). `description`: one "Use when" sentence, at most 1024 characters, ideally 300. `metadata.roles` lists who is offered it, such as `[main, coder]`; absent means every role, `[]` none. Roles are `main` plus those in `crew.yaml`.
- `disable-model-invocation: true` keeps a skill in the `/` menu only; `user-invocable: false` hides it there. Their camelCase spellings are refused.
- To turn off a shipped skill, propose `roles: []` (and `user-invocable: false`). A deleted shipped skill is seeded back at the next start.
- **The description says when, never how.** An agent follows a summary found there and skips the body.
- **The body:** overview and core principle, when (not) to use it, numbered steps, red flags for a discipline, what to hand back. `##` headings, no HTML or flowcharts. Name other skills instead of repeating them. One file, nothing beside it.
- **Budget:** about 500 words (900 for a pipeline skill), under 8000 characters, or dsh may trim it.

## Steps

1. **Read** the skill and its neighbors with `config_list` and `config_read`.
2. **Baseline.** Write a pressure scenario: a concrete task with a forced choice and real stakes (a deadline, sunk cost, a tempting shortcut). Delegate it to a fresh child in the skill's role, with the current text pasted in (nothing for a new skill), and tell it not to load `<name>` with the `skill` tool, so it follows only the brief. For a `main` skill, brief the nearest crew role as the main agent, and ask for its decisions and reasons, since it can't delegate. Record its choices and reasons.
3. **Write the smallest change** that answers those failures.
4. **Test it:** the same scenario on another fresh child, with your draft pasted in instead, and again tell it not to load `<name>`. It should now choose right; answer any new excuse in the text and rerun.
5. **Check** the format and the budget.
6. **Propose it with `config_propose`:** what failed, what both runs showed, what changes. The user decides on Settings → History. `config_write` is refused under `skills/`.

## Hand back

The proposal id, the scenario, what the child did before and after, and what you couldn't test.
