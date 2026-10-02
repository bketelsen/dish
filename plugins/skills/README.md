# dish-skills

dish's own skills, kept in the config store and offered to each agent by role, through dsh's skill registry. They are editable on **Settings → Skills**.
- **The skills.** 18 ship with dish: the [superpowers](https://github.com/obra/superpowers) pipeline adapted to the crew (brainstorm, specs, plans, subagent-driven development, test-first, debugging, review, verification and so on), plus one each for the researcher, writer and ops roles.
- **Where they live.** One document per skill, `skills/<name>/SKILL.md`, in the config store. The shipped copies are in `defaults/<name>/SKILL.md`.
- **Who gets them.** An agent on the dish preset is offered its role's skills. See [Who sees what](#who-sees-what).
- **When edits apply.** Right away. A changed name or description reaches an agent's catalog at its next step, and a changed body applies the next time the skill is loaded. Skills don't snapshot per agent the way prompts do.

The design and its reasoning are in the [spec](../../docs/specs/skills.md) and the [plan](../../docs/plans/2026-10-02-skills.md).

## Install

```sh
pnpm --filter dish-skills build    # src/client → lib/client.js (the Skills page)
pnpm dsh plugin --profile web add ./plugins/skills
```

- **`dish-config` is optional.** With the store, the plugin claims `skills/`, seeds the shipped skills on its first start (one commit), and serves what the store holds. Without it, the shipped skills are served. If the store is there but can't be read (say another dsh process holds its lock), they are served too, and the plugin logs it.
- **`dish-crew` is optional too.** With it, a delegated child is offered its role's skills, and the roles Settings → Skills knows are `main` plus the roles in `crew.yaml`. Without it the roles are `main`, `architect`, `coder`, `reviewer`, `researcher`, `ops` and `writer`.

## A skill

YAML frontmatter, then the instructions:

```markdown
---
name: test-driven-development
description: Use when you're about to write or change code, before writing the implementation.
metadata:
  roles: [coder, main]
---

# Test-driven development
…
```

| Key | Meaning |
|---|---|
| `name` | required; equal to the directory name; lowercase letters, digits and hyphens, at most 64 characters |
| `description` | required; at most 1024 characters. Say *when* to load the skill, never how it goes: an agent that reads the steps in the description skips the body. |
| `metadata.roles` | the roles offered the skill. Absent: every role. `[]`: none. |
| `disable-model-invocation` | `true` keeps it out of every model's catalog, so it is in the `/` menu only |
| `user-invocable` | `false` keeps it out of the `/` menu |
| other keys | kept, ignored |

A save is refused (`INVALID`) when the frontmatter is missing or isn't YAML, the name doesn't match, the description is blank or too long, the body is empty, a boolean isn't a boolean, or `metadata.roles` isn't a list of role names. dsh's older camelCase keys (`disableModelInvocation`, `modelInvocable`, `userInvocable`) are refused too, because dsh's own loader drops them. YAML aliases and anchors are refused ("write it out"). A document over 8000 characters, or with a role dish doesn't know, only gets a warning.

Skills are single files: nothing else sits beside `SKILL.md`.

## Who sees what

- **Agents on a configured preset** (the `presets` setting, `dish` by default):
  - the top-level agent is offered the skills of the role its preset names (`dish` → `main`);
  - a crew child is offered its role's skills, read from crew's record of it.

  They are listed in the agent's skills catalog, so the model loads them with the `skill` tool. A skill outside the role isn't loaded for the model: the tool refuses it.
- **Everywhere,** every skill is in the `/` menu, whatever the role or the preset, unless it sets `user-invocable: false`. A dish skill reaches a model's catalog only through the rule above, so an agent on another preset is never offered one.
- **Skills on disk** (project and user skills) lose to a dish skill of the same name for a dish role, and win elsewhere.

## The Skills page

**Settings → Skills**, between Judge and History.
- **List:** every skill by name. Each shows its role chips ("all roles" or "off"), a dot when it differs from its shipped default, a "yours" badge when you added it, a marker when the stored document doesn't parse, and a count of proposals waiting on it. In a narrow window the list becomes a dropdown.
- **Edit:** **Save** (Ctrl/Cmd+S) writes as you, with an optional note that goes into the history. The text is checked about 300 ms after you stop typing: problems disable Save, warnings don't, and a line summarizes the description length, roles, invocation and size. If the skill changed after you opened it, your text stays, with **Reload**.
- **Default:** a diff from the shipped default to what's saved, and **Reset to default**. A reset is an ordinary commit with the note "Reset to the default", so it can be reverted too.
- **History:** this skill's commits, each with its diff and **Revert**.
- **New:** asks for a name, checks it, and opens the editor on a template with `roles: [main]` and a "Use when…" description to fill in. Nothing is written until you save.

Proposals are accepted or rejected on **Settings → History → Proposals**.

## Adding a skill

- **Yourself:** Settings → Skills → **New**. Give it a name, fill in the description and roles, write the instructions, and save.
- **Through the main agent:** it uses `dish-config`'s tools, and `skills/` is propose-only for agents, so it never rewrites its own instructions without your click. It writes the skill with `config_propose`, and you accept it on Settings → History → Proposals. The `writing-skills` skill tells it how, including to try a change on a fresh child first.

A skill you added can be deleted from its Edit tab.

## Turning a shipped skill off

A shipped skill can't be deleted: the next start seeds it back. Edit it instead:
- `roles: []` takes it out of every agent's catalog;
- `user-invocable: false` as well takes it out of the `/` menu.

Reset it to the default to turn it back on.

## Upgrades

On every start, the plugin seeds the shipped skills with `replace`. A stored skill that is still byte-for-byte an earlier shipped text is replaced with the current one, in one commit with the note "updated to the new defaults". A skill you edited is never touched, and neither is one you added.

"An earlier shipped text" comes from `defaults/previous.json`, which maps each store path to the sha256 hashes of the texts that shipped before. After you change a file in `defaults/`, commit the change and regenerate it:

```sh
node packages/dish-kit/scripts/previous-defaults.mjs plugins/skills/defaults skills/ --exclude NOTICE.md
```

It reads the old texts from git history, so run it from a full clone. A test fails if a default has changed and its old text isn't listed.

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-skills` | `presets` | `{ dish: main }` | Preset id → the role of its top-level agents. Only agents on these presets are offered role skills. |
| `dish-skills` | `terminal` | `true` | Print this plugin's messages to the terminal. |

## Caveats

- **A hand-edited document that doesn't parse** is left out of the catalog and shown as a problem on the page. The other skills still serve.
- **A store with no skill documents** (and no problems) serves the shipped skills, as if it were absent, until the first seed.
- **Skills are written in our own words.** Several are adapted from obra/superpowers (MIT, © 2025 Jesse Vincent); [`defaults/NOTICE.md`](defaults/NOTICE.md) has the credit and the license. It isn't a skill and isn't seeded.
