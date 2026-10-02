# dish-prompts

The persona text of each dish agent, kept in the config store and editable on **Settings → Prompts**.
- **The prompts:**
  - `prompts/main.md` for the main agent;
  - `prompts/crew/<role>.md` for architect, coder, researcher, ops, writer and reviewer;
  - `prompts/common.md`, house rules for every role.
- **Agents get them through a persona row** in their preset. The **dish** preset for the main agent, which mounts that row, ships with `dish-crew`. `dish-crew` also gives delegated children their role text.
- **Edits apply to agents that start afterwards.** An agent keeps the prompt it started with for its whole life, a dsh restart included.

The design and its reasoning are in the [spec](../../docs/specs/prompts.md).

## Install

```sh
pnpm --filter dish-prompts build    # src/client → lib/client.js (the Prompts page)
pnpm dsh plugin --profile web add ./plugins/prompts
```

It needs `dish-config` in the same profile, installed first. On its first start with the store, it seeds the eight default prompts as one commit, and the store pushes it like any other. On later starts, a prompt that is still an earlier shipped default moves to the current one (one commit, note "updated to the new defaults"); an edited one stays. After changing a file in `defaults/`, run `node packages/dish-kit/scripts/previous-defaults.mjs plugins/prompts/defaults prompts/`.

**Choose the preset:** the **dish** preset comes with `dish-crew`, not with this plugin, so install that too (see [dish-crew](../crew)). Then, on **Settings → Agent presets**, use **Set as new task default** on **dish** (under Custom). dsh's own presets stay available, and the mode picker on a new chat switches per chat. On its own, this plugin gives you the persona row for a preset of your own.

## What an agent sees

dsh builds a system prompt from ordered sections. This plugin fills two of them and leaves the rest to dsh:

1. dsh's identity line, "You are an AI agent powered by DeepSeek Harness."
2. **The role's prompt** (`main.md` or `crew/<role>.md`), in dsh's persona-prefix slot.
3. dsh's own guidance: tools, skills, structured output, the web surface.
4. **`common.md`**, in dsh's persona-suffix slot, at the very end.

Sandbox and approval policy, delegation info and a repo's `AGENTS.md` reach the model as separate messages, as before.

**Variables.** `{{model}}`, `{{cwd}}`, `{{provider}}` and any variable a plugin registers can be used. dsh itself fails a step on an unknown variable. This plugin fills in its own sections leniently instead: a name with no value is left as written and logged once per agent. The editor warns about unknown names but never refuses them.

**Snapshots.** The first time an agent's prompt is built, the plugin records the store commit it read, in `$XDG_STATE_HOME/dish/prompts/agents/`. Every later step, and a resume after a restart, reads the texts at that commit, so the model never sees its instructions change mid-conversation. Snapshot files not read for 180 days are pruned at startup.

**When the store isn't running** (for example, another dsh process holds its lock), agents get the shipped defaults, and the plugin logs it. Once the store answers, an agent resumed from a snapshot switches back to its recorded text, and that's logged too.

## The Prompts page

- **Role list:**
  - Common, Main, then the crew;
  - a dot marks a prompt that differs from its default;
  - a count shows proposals waiting on it;
  - in a narrow window the list becomes a dropdown.
- **Edit:**
  - **Save** writes as you, with an optional note that goes into the history.
  - If the prompt changed after you opened it, your text stays in the editor, and a notice shows what changed, with **Reload** and **Keep mine**.
  - Ctrl/Cmd+S saves.
- **Default:** a diff from the shipped default to what's saved, and **Reset to default**. A reset is an ordinary commit with the note "Reset to the default", so it can be reverted too.
- **Preview:** the whole system prompt a new agent in this role would get now, assembled by dsh from the dish preset. Per-agent variables show as `‹model›`, `‹cwd›`. If dsh's assembly can't be used, a banner says so, and the text shows markers where dsh's sections go.
- **History:** this prompt's commits, each with its diff and **Revert**.

Proposals are accepted or rejected on **Settings → History → Proposals**.

## Agents changing prompts

The main agent uses `dish-config`'s tools:

| Document | The agent may |
|---|---|
| `prompts/crew/<role>.md` | `config_write` (commit directly), when you asked for the change |
| `prompts/main.md`, `prompts/common.md` | `config_propose` only; you accept or reject |

So the agent never rewrites its own instructions or the house rules without your click.

## The dish preset

The preset now lives in `dish-crew` (`plugins/crew/presets/dish.patch.yml`), which also generates it from your installed dsh and tests it for drift. It mounts this plugin's persona row (`role: main`), so without `dish-crew` there is no dish preset, and the Prompts page's preview shows its fallback text with a banner. After a dsh upgrade, regenerate it there:

```sh
pnpm --filter dish-crew sync-preset
```

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-prompts` | `stateDirectory` | `$XDG_STATE_HOME/dish/prompts` | Where snapshots are kept. Absolute, or starting with `~/`. |
| `dish-prompts` | `terminal` | `true` | Print this plugin's messages, and the persona row's, to the terminal. |
| `dish-prompts/persona` | `role` | required | `main`, or a crew role. Checked when the preset loads. |

## Caveats

- **Crew role names:** lowercase letters, digits and hyphens, starting with a letter, and not `common` or `main`.
- **A typo in the persona row's `role` stops the whole dish preset from mounting,** so no dish agent can start until it's fixed. dsh reports the preset as broken.
- **`/clear` doesn't refresh a session's prompt yet.** dsh 0.2.0-rc.2 never reports a clear to plugins, so a cleared session keeps its snapshot. Start a new chat to pick up edits.
- **Agents on other presets don't get these prompts.** Only presets that include the persona row do.
- **The preview is approximate.** Runtime context isn't shown, and per-agent values are placeholders.
