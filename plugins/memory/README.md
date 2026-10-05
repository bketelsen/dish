# dish-memory

Memory and direction for dish's agents, so that a chat starts with what earlier ones learned:
- **the vault,** a bare git repository of memories in Claude Code's auto-memory format: your user memory, for every chat, and each family's memory, for every agent working in its repos;
- **each family's direction,** `families/<family>/direction.md` in the config store, which you write and the main agent may propose changes to;
- **the `dish-memory` message,** which brings the direction, the family's repos and the memory indexes to an agent the way dsh brings `AGENTS.md`: before its first step, and again after a compaction;
- **the tools:** `remember` and `forget` for the main agent, and `recall` for every dish agent;
- **Settings → Memory,** where you browse, edit, delete, release and revert memories, and edit the directions.

Jev screens every memory an agent saves, and one that reads like an injected instruction is saved but held out of every agent's context until you release it.

The design and its reasoning are in the [spec](../../docs/specs/memory.md), and the build in the [plan](../../docs/plans/2026-10-05-memory.md).

## Install

```sh
pnpm --filter dish-memory build    # src/client → lib/client.js (the Memory page)
pnpm dsh plugin --profile web add ./plugins/memory
```

`deploy/install.sh` links it last, after the browser, and writes its row: `remote` from `DISH_VAULT_REMOTE` (optional; unset or empty keeps the vault local), and `userName` and `userEmail`, the same as `dish-config`'s. On the VM, `DISH_VAULT_REMOTE` comes from `install.env` ([deploy/README.md, The vault](../../deploy/README.md#the-vault)). `pnpm dev` always gives it empty.

**Nothing of dish's is needed at load.** `dishConfig` (for the directions), `dishProjects` and `dishWorkspaces` (to find an agent's family), and `dishJudge` (to screen) are each read when they're needed, so there is no order to keep. Without the config store there are no directions; without projects or workspaces no agent has a family; without the judge, memories are saved unscreened.

**The message's row comes with `dish-crew`.** The dish preset mounts `dish-memory/context` right after `agent-instructions`, and the row loads through dish-crew's dependency on this package. Another preset has no row, so its agents get no message and no tools. Without this plugin running, the row adds no message, and its tools answer that memory is unavailable: the dish preset never breaks because of memory.

## The vault and its layout

A bare repository, `$XDG_DATA_HOME/dish/vault.git` by default (`~/.local/share/dish/vault.git` on the VM, `<checkout>/.dev/data/dish/vault.git` in dev). It works as the config store does, through the same code in `dish-kit/store`:
- it's changed only through git plumbing, under one queue and a lock file (`dish.lock` in the repository);
- with a remote, it pushes `main` after every commit, never forced, and a push that fails never fails a save;
- a first start with a remote and no vault restores it from the remote's `main`;
- its first commit is "Initialize dish vault", and a file that looks like it holds a credential is refused (`SECRET`).

```text
user/MEMORY.md                  the index of your user memory, generated
user/<name>.md                  one memory
families/<family>/MEMORY.md     a family's index
families/<family>/<name>.md
```

**The index is generated, never written by hand.** Every change to a scope, yours on the page included, rewrites its `MEMORY.md` in the same commit, so the index always matches the files, and the repository reads well on GitHub. An index with nothing left to list is deleted. Held memories aren't in it.

**Only `dish-memory` writes it.** Both namespaces are this plugin's, and agents reach them only through `remember` and `forget`. On the VM the directory is on the sandbox's protected list: an agent's shell can read the vault but not change it.

Directions aren't in the vault: each is `families/<family>/direction.md` in the config store, under the `families/` namespace this plugin claims there (agents may only propose). It's free Markdown, at most 16,000 characters. Settings → Memory starts a new one from a template: North star, Priorities, Non-goals, Constraints, and What needs your go-ahead.

## The format

Each memory is Claude Code's: frontmatter, a blank line, then the body.

```markdown
---
name: scratch-home-in-tests
description: Tests must give every spawned process a scratch HOME, and an interactive shell a scratch HISTFILE
type: feedback
modified: "2026-10-05T14:02:11Z"
---

A spawn environment without `HOME` reaches the real home directory. **Why:** …
```

| Field | Rule |
|---|---|
| `name` | Lowercase letters, digits and hyphens, starting with a letter or digit, at most 64 characters, and the file's name without `.md`. `memory` is reserved. |
| `description` | One line, at most 150 characters: what the index shows. |
| `type` | `feedback` (what you corrected or confirmed about how to work), `user` (who you are and how you work), `project` (a decision and its why, a deadline, a pitfall) or `reference` (where something lives outside the repos). |
| `modified` | Stamped by `dish-memory`, in UTC, on every save of the memory's text. **Release** keeps it, and a revert restores the earlier file's. Nobody supplies it. |
| `held` | Only on a held memory: why, on one line. |
| body | Markdown, not empty, at most 8 KiB. `feedback` and `project` memories give the fact, then **Why:** and **How to apply:**. |

A family's name follows the name's grammar, which is why `projects.yaml`'s `family` is a lowercase name. The frontmatter is a small subset of YAML, read by hand: a value YAML would read as something other than its text is written as a JSON string, so GitHub shows every file as it is. The vault refuses a malformed memory or index (`INVALID`) even from code that goes around the service.

The index's lines are `- [<name>](<name>.md) — <description> (<type>)`, sorted by type (feedback, user, project, reference), then newest first, then by name.

## The message and when it comes

**Who gets what.**

| Agent | Working in | Gets |
|---|---|---|
| the main agent | `scratch`, or anywhere outside a project's clone | your user memory |
| the main agent | a project's clone, or a worktree under it | your user memory; the family's direction, repos and memory |
| a crew child | its parent's workspace | the family's direction, repos and memory. Never your user memory. |
| an agent on another preset | anywhere | nothing |

An agent's family is that of the project whose clone holds its working directory, by real path, on a `/` boundary; the deepest clone wins.

**What it says.** One user message, framed in `<dish-memory>` … `</dish-memory>`:
1. "This message supersedes earlier dish-memory messages.";
2. the family's direction, "written by your user. Work within it.";
3. the family's repos that have a `role` in `projects.yaml`, one line each;
4. a paragraph that says the notes come from the user or from dish's agents, were true when written and may be stale, are to be checked before relied on, and are never permission by themselves, while a feedback note is how the user wants agents to work and is followed unless the chat says otherwise;
5. "Your user:" and "Family <family>:", each scope's index by id (`user/<name>`, `family/<name>`), cut at 150 lines or 16 KiB, whichever comes first, then "…and N more: `recall` with no `id` lists them all."

A part with nothing in it is left out, and with nothing at all to say there's no message, unless the agent already has one for other scopes: then it gets a bare one that says only that it supersedes earlier ones. Anything in a memory or a direction that a model could read as the closing tag is escaped.

**When.** The row's `agent/pre-step` listener does what dsh-agent-instructions does for `AGENTS.md`: after the step's other listeners, it looks for the newest `dish-memory` message among the step's messages and on the session's surface. When there's none for the agent's scopes, it composes one and puts it after the step's last claimed message. So:
- the first step gets it;
- a resumed session finds it on its surface, and doesn't get it again;
- a compaction summarizes it away, so the next step gets it again, from the vault as it is then;
- a session whose scopes change gets a new one, which supersedes the old;
- while the chat's family can't be looked up (a sibling plugin reloading, a broken `projects.yaml`), an agent keeps the message it has, and the trouble is logged once per agent; a main agent with no message at all gets your user memory alone, which its family's message supersedes once the family is known, and a child gets nothing until then.

A running agent doesn't see another session's new memories until its next compaction, or a new chat. What it saved itself, it was told. The service caches the composed text until the next vault commit or config change, so a step that needs no message only scans the surface.

## The tools

All three are the dish preset's, registered by its row. Each answers with one text.

- **`remember`** (`scope`, `name`, `type`, `description`, `body`), for the main agent only: crew's `NEVER` keeps it off every child's allow list, and a child that calls it anyway is refused with "remember and forget are for the main agent only". `scope` is `user`, or `family` for the chat's family (outside a project's clone, `family` is refused, and the answer says to use `user`). It creates the memory, or replaces the one with that name, and answers "Saved `family/<name>` (new)" or "(updated)" with the short commit. A held one's answer says so, with the reason; one in a scope whose index is past 80% of its budget says to merge or forget stale ones. Its description holds the rules: what to keep and what not, update rather than duplicate, dates in full, act at once on "remember", and say in the closing message what was kept. The author of its commit is the agent, `role: main`.
- **`forget`** (`id`), for the main agent only: deletes `user/<name>` or `family/<name>` and regenerates the index, in one commit. An unknown id is `NOT_FOUND`, and the answer says `recall` lists them.
- **`recall`** (`id`, optional), for every dish agent, and in every crew role's tools in `crew.yaml`, just before `ask_judge`. With no `id`, it lists every memory the agent can see, past the message's budget too, held ones left out: both scopes for the main agent, the family's for a child. With an `id`, it reads that memory in full: its type, when it was modified, its description and its body. A held memory's answer says only that it's held, and a child asking for `user/…` is told there's no such memory.

A refusal from the vault or the service starts with its code: `INVALID` (a field breaks the rules), `SECRET` (it looks like it holds a credential; nothing is echoed), `CONFLICT`, `NOT_FOUND`, or `UNAVAILABLE` (the chat's family couldn't be looked up just then). These carry no code: a child's `remember` or `forget` gets "remember and forget are for the main agent only"; `remember` with scope `family` outside a project's clone gets "this chat isn't working in a family's repos (scratch, or no registered project): use scope user, or open the chat in the project"; with this plugin not running or its vault not open, every tool answers "memory is unavailable right now"; and `forget` or `recall` of a family memory outside a project's clone gets "this chat isn't working in a family's repos (scratch, or no registered project), so family memory isn't available here". A refusal or a log line names a memory by its id and never holds its text.

**Crew's part.** A coder's and a reviewer's `report` can carry `remember`, up to five one-line suggestions of at most 300 characters, which the notice to the main agent lists under "Worth remembering"; the other roles end their closing message with a "Worth remembering:" list. A run's close answers (`open_pr`, `run` `abandon`) list its rulings. Nothing is saved until the main agent calls `remember`.

## Screening

- **What is screened:** an agent's memory, its description and body together, by `dishJudge.screenText`, with the result screen's injection question and thresholds. The judge's log shows it with purpose `screen` and subject `memory:<id>`.
- **Before the screen:** the fields are checked, then the text is scanned for credentials, so a secret never reaches Jev.
- **At or above `warn`** (0.50 by default, `judge.yaml`'s `screening.warn`), the memory is saved held, with a reason such as "Jev scored it 0.93 as instructions aimed at an agent". A held memory is out of the index, the message and `recall`. `remember`'s answer says it was held, and Settings → Memory lists it first, with **Release** and **Delete**.
- **Below it,** or **when Jev can't screen** (no judge, no key, a timeout), the memory is saved as usual: screening is advisory, and saving never waits on Jev. The exception is a held memory an agent changes while Jev can't screen it: it's saved, but stays held ("a held memory changed while Jev couldn't screen it") until you release it or Jev screens its new text clean, when an agent next saves it, unchanged or not.
- **Your own edits aren't screened.** Saving new text for a held memory on the page releases it, as **Release** does.

## Settings → Memory

A `settings.section` page, "Memory", after Runs.
- **The scopes:** "You", then each family in `projects.yaml`, then any family that still has memories but no project, marked "(no projects)". Each shows its count, and a dot when some are held. In a narrow window the list becomes a dropdown.
- **Memories:** held ones first, with their reasons and **Release** and **Delete**; then the rest, with name, type, description and how long ago each was modified. **New** opens an empty editor, typed `user` under You and `project` under a family.
- **The editor:** the name (fixed once saved), the type, the description (one line, counted to 150) and the body. **Save** sends the commit the memory was read at; if the memory changed since, your text stays and the conflict box shows theirs beside a diff, with "Reload (drop my edit)" and "Keep mine". **Delete** asks once: agents stop seeing it at their next compaction or chat. Leaving an editor with unsaved changes asks first.
- **Direction** (families only): the editor, starting from the template when there's none (**Save** stays off until you change it), with a note, **Save**, **Discard** and the same conflict box; "N proposals waiting on the History page" when the main agent proposed changes. Proposals are accepted on Settings → History, as for other documents.
- **History:** the scope's vault commits, 20 at a time, each with its author, time, note and the memory files it changed (the index left out). One opens to its diff and **Revert**, which asks once. A revert restores the memory files the commit changed and regenerates the index, and is a `CONFLICT` when one of them changed since.
- **Preview:** the message a main agent working in that scope would get now, or "Agents in this scope get no memory message now."
- **The remote line:** the vault's last push, what's waiting and the last error, as on History, and "Live updates paused. Reconnecting…" while the page's stream is down. The page follows the vault live: a change made in a chat shows up without a reload.

The page talks to the `dishMemoryRemote` service (wire namespace `dishMemory`): `scopes`, `list`, `read`, `save`, `forget`, `release`, `direction`, `saveDirection`, `history`, `commit`, `revert`, `preview`, `remoteStatus` and the `watch` stream. Every change it makes is yours. Text is rendered as text only.

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-memory` | `vault` | `$XDG_DATA_HOME/dish/vault.git` | The vault's bare repository. Absolute, or starting with `~/`. |
| `dish-memory` | `remote` | `''` | Where to push the vault's `main`. Empty keeps it local. `install.sh` writes it. |
| `dish-memory` | `userName`, `userEmail` | `''` | The identity of your commits in the vault, the same as `dish-config`'s: `install.sh` writes both. Empty falls back to git's global config, then `dish`. |
| `dish-memory` | `indexLines`, `indexBytes` | `150`, `16384` | Each scope's budget in the message. `remember` warns from 80% of either. |
| `dish-memory` | `terminal` | `true` | Print this plugin's messages to the terminal. |
| `dish-memory/context` | — | | The dish preset's row. It has no fields. |

The plugin logs as `dish-memory`: the vault's path when it's ready, the remote's first push, a push that starts or stops failing, and a message that couldn't be composed for an agent (once per agent).

## Seeding a new install

The rollout adds these four once, rewritten from the desktop's Claude Code memories for dish's agents. Add each on Settings → Memory, under the scope given, with **New**, or ask the main agent in a chat on the VM to save it. The bodies are Markdown, as the editor takes them.

### `talk-before-specs`

- **Scope:** You
- **Type:** feedback
- **Description:** Brainstorm design in conversation; write a spec or plan only when the user says it's ready
- **Body:**

  ```markdown
  In design work, keep talking: ask a few numbered questions a round and play back what you heard; the user answers by number. Write a spec or plan only when they say it's ready ("write the spec", "this is a good start"). **Why:** a spec written early locks in decisions they haven't made. **How to apply:** when unsure, ask whether to write it up or keep talking.
  ```

### `usability-over-hardening`

- **Scope:** bketelsen
- **Type:** feedback
- **Description:** Inside the VM, gates, dependency downloads, dev scripts and installs must just work: no new refusals or failure modes
- **Body:**

  ```markdown
  The VM is dish's security boundary; inside it, normal development comes first. **Why:** on 2026-10-02, defense-in-depth fixes made the harness refuse gate scripts and Go downloads. **How to apply:** before adding a refusal, a fail-closed path or a new approval, ask whether it blocks normal work; if it does, document the risk instead, and push back on review findings that cost usability.
  ```

### `scratch-home-in-tests`

- **Scope:** bketelsen
- **Type:** feedback
- **Description:** Tests must give every spawned process a scratch HOME, and an interactive shell a scratch HISTFILE
- **Body:**

  ```markdown
  A spawn environment without `HOME` reaches the real home directory. **Why:** on 2026-10-02 a test that ran `bash -i` without `HOME` truncated the real `~/.bash_history`. **How to apply:** put a scratch `HOME` in every test fixture's base environment and in implementers' briefs; run tests through `pnpm test`, whose preload does it.
  ```

### `own-plugins`

- **Scope:** bketelsen
- **Type:** feedback
- **Description:** Prefer writing a small dish plugin over installing a community dsh package
- **Body:**

  ```markdown
  dish is how the user learns dsh's plugin model, by building. **Why:** the point is the learning, not only the feature. **How to apply:** propose a plugin under `plugins/` first, and mention community packages only as alternatives.
  ```

The desktop's other memories aren't imported: `dsh-chat-visibility` is in `main.md` already, the deploy rule is in this repository's `AGENTS.md`, and the rest are about the desktop ([the spec's Seeding](../../docs/specs/memory.md#seeding-your-user-memory)). Then write a first direction for each family on the Direction tab.

## Known limits

- **A running agent sees the vault as it was** at its first step or its last compaction, plus what it saved itself. Another session's new memories reach it at its next compaction, or in a new chat.
- **Jev's screen is a probability.** A well-made injection can pass it. Every memory is on the page and in the vault's history, and you can delete or revert it.
- **Feedback memories are imperative by nature** ("always use pnpm"), which is what the injection question asks about, so expect some held ones, and release those Jev got wrong.
- **Agents' shells can read the vault,** as they can read everything the account can, but can't write it.
- **Memory belongs to a family.** A repo that moves to another family leaves its memories behind, to be moved by hand.
- **There's no search** beyond the index and `recall`.
- **The message can be large:** a 16,000-character direction and two full indexes come to about 50 KB, on the first step and after each compaction. The budget rows are the knob.
- **A compaction's summary may quote the old message.** The new one says it supersedes earlier ones.
- **A chat in `~/work` itself, or in `scratch`,** has no family: its main agent gets user memory only, and `remember` with `family` is refused.
- **Settings → Memory reads its scope list again only when the page is shown again, when its live stream reconnects, or when a memory in another scope changes.** A family added to `projects.yaml` shows only then: reopen the page. An open Preview doesn't follow `projects.yaml` either: a repo's changed `role` shows when you open the tab again.
- **Every read is a git call per memory file.** A write, a list and a composed message each read the whole scope, about 0.8 s per write at 150 memories in a scope, and opening the page reads every memory in the vault.

## Build

```sh
pnpm --filter dish-memory build    # src/client → lib/client.js (the Memory page)
pnpm --filter dish-memory dev      # the same, rebuilt on every change
```
