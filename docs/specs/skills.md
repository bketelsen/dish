# Spec: dish skills (`dish-skills`)

Status: built 2026-10-02 on branch `skills` (not merged; live checks pending). Implements roadmap step 3a. Builds on the [design](../design.md), the [config store](config-store.md), [prompts](prompts.md) and [crew](crew.md).

## Summary

`dish-skills` keeps dish's own skills in the config store and offers each agent the skills its role needs, through dsh's skill mechanism.
- **Store layout:** one document per skill, `skills/<name>/SKILL.md`. The format is the usual one: YAML frontmatter with `name` and `description`, then the instructions.
- **Defaults:** the shipped set is the [obra/superpowers](https://github.com/obra/superpowers) pipeline, adapted to dish's crew, plus a skill for each crew role that superpowers has no counterpart for.
- **Per-role filtering:** each skill names the roles it's for. A dish agent is offered only its role's skills: the main agent gets the controller's skills, and a coder gets test-first, debugging and so on.
- **Editing:** on **Settings → Skills**, like Settings → Prompts. Edit with conflict checks and live validation, compare a shipped skill with its default and reset it, add your own skills, delete them, and see a skill's history.
- **Prompts:** every role's prompt now names the skills that role should load. The main agent's prompt and the house rules say when to load one.
- **Upgrades:** a store that still has an old, unedited default prompt or skill is moved to the new default when dish starts. Edited documents are left alone.

## Decisions (made 2026-10-02 without you; please review)

You asked for this to be built while you were away, so I decided the shape. Each row says what I chose and what it costs if you'd rather have it otherwise.

| # | Topic | Decision | Cost if wrong |
|---|---|---|---|
| 1 | How skills reach dsh | A **skill provider** (`ctx.skills.registerProvider`) that reads the store directly. Nothing is written to disk. dsh's catalog, the `skill` tool and the `/` menu work unchanged. | Low: the provider is about 100 lines. |
| 2 | Who sees what | **Per role.** Each skill's frontmatter lists its roles in `metadata.roles`. For agents on the dish preset, a provider is registered in each agent's own layer, offering that role's skills. Everywhere else, dish skills appear in the `/` menu only, never in a model's catalog. | Medium: if you'd rather every agent saw every skill, set every skill's `roles` to all seven roles, or drop the agent-layer part. |
| 3 | Finding an agent's role | The top-level agent of a configured preset gets the role configured for that preset (`dish` → `main`). A crew child gets the role in crew's record of it. No new preset row, so the dish preset doesn't depend on this plugin. | Low. |
| 4 | Skill format | Single-file skills only: `skills/<name>/SKILL.md` and nothing else beside it. Superpowers' supporting files (prompt templates, scripts) are folded into the skill text or into the crew prompts. Resources can come later. | Low: allowing other files later is additive. |
| 5 | Shipped skills | 18 skills, listed below. The names follow superpowers wherever the idea carries over unchanged. Written in our own words for dish, with an MIT attribution notice. | Content is easy to revise on the Skills page. |
| 6 | Agent edits | `skills/` is `propose` for agents, like `main.md`: an agent never changes its own instructions without your click. The `writing-skills` skill tells the main agent to use `config_propose`. | Low. |
| 7 | Turning a shipped skill off | Shipped skills can't be deleted, because the next start would seed them back. To turn one off, set `roles: []`, or add `user-invocable: false` to hide it from `/` as well. Skills you add yourself can be deleted. | Low. A tombstone list could come later. |
| 8 | When edits apply | Right away, as dsh intends for skills. A changed name or description puts a new catalog in front of the agent at its next step. A changed body applies the next time the skill is loaded. Unlike prompts, there are no per-agent snapshots: the catalog is a message, not the system prompt, so a change doesn't disturb the prompt cache. | Low. |
| 9 | Updating seeded defaults | `dishConfig.seed` gains a `replace` option: the sha256 hashes of earlier shipped versions of each path. If the document in the store still matches one of them, it's replaced with the current default. Prompts and skills both use it. This is how the new prompt texts reach the VM's store. | Medium: an unedited prompt changes without a click. Edited documents are never touched. |
| 10 | Prompt changes | Every role prompt gets a "Skills" line naming its skills. `common.md` gets one rule: load a matching skill before starting. | Text, editable. |
| 11 | Settings page | **Settings → Skills**, order 47, after Judge and before History. Tabs: Edit, Default (shipped skills only) and History. Plus New and Delete (for skills you added). | Low. |
| 12 | Backlog item | The prompts remote's `reset` now defaults its note to "Reset to the default", while that code is open anyway. | None. |

## Non-goals

- Skill resources: scripts and extra files beside `SKILL.md`.
- Per-repo or per-family skills (later, with `projects` and `families`).
- Pressure-testing the skills with subagents, as superpowers' `writing-skills` asks. That's a follow-up once the set has been used.
- Changing dsh's catalog wording or the `skill` tool.
- `using-superpowers`'s "invoke before every response" rule. The role prompts and `common.md` carry a lighter version (decision 10).

## Documents and namespace

| Path | Holds | Agent policy |
|---|---|---|
| `skills/<name>/SKILL.md` | one skill | `propose` |

One claim, the `skills/` subtree.

**Name:** `<name>` uses dsh's skill-name grammar, `^[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 64 characters.

**Validation** (the namespace's `validate`). A document is refused (`INVALID`) when:
- its path isn't `skills/<name>/SKILL.md` with a valid `<name>`;
- the frontmatter is missing, isn't YAML, or isn't a mapping;
- `name` isn't equal to `<name>`;
- `description` is missing, blank, or over 1024 characters;
- the body is empty;
- it uses one of dsh's legacy camelCase keys (`disableModelInvocation`, `modelInvocable`, `userInvocable`), which dsh's own loader drops;
- `disable-model-invocation` or `user-invocable` is present and isn't a boolean;
- `metadata` is present and isn't a mapping;
- `metadata.roles` is present and isn't a list of role names (`[a-z][a-z0-9-]*`).

**Warnings** don't refuse a save. The editor shows them:
- the document is over 8000 characters (dsh's tool-result pruner in the dish preset trims longer results under context pressure);
- a role in `metadata.roles` isn't a role dish knows (`main` plus the roles in `crew.yaml`).

**Frontmatter** follows dsh's filesystem loader, plus dish's roles:

```markdown
---
name: test-driven-development
description: Use when you're about to write or change code — a feature, a bug fix, a behavior change — before writing the implementation.
metadata:
  roles: [coder, main]
---
```

| Key | Meaning |
|---|---|
| `name`, `description` | required, as dsh |
| `disable-model-invocation` | `true` keeps it out of every catalog (`/` only) |
| `user-invocable` | `false` keeps it out of the `/` menu |
| `metadata.roles` | the roles offered it. Absent means every role; `[]` means none. |
| other keys | kept, ignored |

## How agents get skills

### Constraints (checked in dsh 0.2.0-rc.2's code)

- **Layers.** `ctx.skills` merges the global layer, then the preset layer, then the agent's own layer. A later layer's entry replaces an earlier one with the same name (`dsh-skill` `collectFresh`).
  - A provider registered through `agent.ctx.skills` lands in that agent's layer.
  - A provider registered by a host plugin lands in the global layer.
- **The catalog.** `dsh-tool-skill` lists the model-invocable skills, name and description only, as a durable message at each `agent/pre-step`. It does this only when that agent can see the `skill` tool. A change to names or descriptions appends a replacement catalog.
- **Loading.** The `skill` tool checks that the skill is model-invocable for the calling agent, then calls `get()`. The registry caches catalogs per scope chain and revision. `control.invalidate()` clears the cache for every scope.
- **Provider contract.** A provider reads only `cwd` and `signal` from the lookup options, never `scope`. That's why per-role filtering is done by where a provider is registered, not inside one provider.
- **Order of events.** `agent/created` is a serial event. Each agent is bound to its preset before it's announced, and the announcement comes before its first step. So `agentPresets.composedPreset(agent.ctx)` names the preset in a listener, and a provider registered there is in place for the first catalog.
- **Crew children.** Crew records each child (`id`, `role`) before it starts the child, so `dishCrew.records.lookup(agent.id)` finds the role by the child's first step. A child's agent layer belongs to the child alone, and its chain is the preset's, not its parent agent's.
- **No crew prompt filtering.** Crew already gives every role the `skill` tool (`crew.yaml`).

### The providers

**Global provider `dish`** (host plugin, when `skills` is present):
- Rank 350, source `dish-config`, or `dish-default` while the store is absent.
- Lists every valid skill with `invocation: { modelInvocable: false, userInvocable: <the skill's own> }`.
- Its job is the `/` menu everywhere, including cold sessions whose lookup scope is a preset. It never lists a skill for a model.

**Agent provider `dish-role`** (one per agent of a configured preset, registered in `agent/created`):
- Resolves the agent's role once, lazily, in its first `list()`.
  - A top-level agent gets `presets[presetId]`.
  - A child gets crew's record role. A failed lookup returns `{ candidates: [], complete: false }`, so the registry retries at the next step.
  - Anything else has no role and lists nothing.
- Lists the skills whose roles include the agent's role, with the skill's own invocation flags. Rank 250.
- A skill outside the role falls through to the global entry: user-invocable, not model-invocable. The `skill` tool refuses it for the model.
- `get()` returns the body from the catalog the candidate came from (its `locator` is `{ commit, name }`).

**Refresh:** every registered provider's `control.invalidate` is added to the service's change listeners. The service calls them when:
- `dish-config/changed` names a path under `skills/`;
- the store appears or goes away.

One call clears the registry's whole cache. Each provider still subscribes, so a disposed global provider doesn't leave agents stale.

**Precedence with skills on disk:** a dish-role skill wins over a same-named project or user skill on disk, because the agent layer is nearest. For everything outside dish roles, the disk skill wins over dish's global, menu-only entry.

## Service: `dishSkills`

```ts
interface SkillDoc {
  name: string
  path: string                     // skills/<name>/SKILL.md
  description: string
  roles: string[] | null           // null: every role
  modelInvocable: boolean
  userInvocable: boolean
  metadata: Record<string, unknown>
  body: string                     // instructions, frontmatter removed, trimmed
  text: string                     // the whole document
}
interface Catalog {
  commit: string | null            // null: shipped defaults, store absent
  skills: SkillDoc[]               // valid ones, sorted by name
  problems: { path: string, message: string }[]   // documents that didn't parse (hand edits in git)
}
interface DishSkills {
  catalog(): Promise<Catalog>                       // main now; memoized per commit
  forRole(role: string): Promise<SkillDoc[]>        // catalog() filtered by role
  defaultText(name: string): string | undefined
  shipped(): string[]                               // names with a default, sorted
  onChange(listener: () => void): () => void
}
```

`parseSkill(path, text)` and `checkSkill(path, text, knownRoles)` are plain functions in `src/skill.ts`, shared by the validator, the service and the remote.

## Upgrading seeded defaults (`dish-config`)

`seed(defaults, owner, options?: { replace?: Record<string, readonly string[]> })`
- `replace[path]` lists the lowercase hex sha256 hashes of a path's earlier shipped texts.
- A path that's missing is written, as now.
- A path that exists and whose text hashes to one of its `replace` entries is overwritten with the default.
- Everything goes in one `system` commit. The subject is `<paths>: <owner> defaults`. When anything was replaced, the commit also gets the note `updated to the new defaults`.
- A path in `replace` that isn't in `defaults` is `INVALID`.

Each plugin keeps `defaults/previous.json`, mapping each store path to its earlier hashes.
- It's generated from git history by `packages/dish-kit/scripts/previous-defaults.mjs <plugin dir> <store prefix>`: every committed version of every default file, minus the current one.
- A test fails when a default file has changed since the last commit and its old text's hash isn't in `previous.json`, so a default can't change without leaving the old one replaceable.
- **prompts:** generated in this step, before its defaults change. That makes the VM's seeded prompts upgradable.
- **skills:** starts as `{}`.

## Shipped skills

Written for dish: the controller is the main agent, the subagents are the crew roles reached with `delegate`, a reviewer is always a different model family, humans merge, rulings are recorded as `Ruling: what — why — cost if wrong`, a gate means the repo's gate command, and specs and plans go in `docs/specs/` and `docs/plans/`. Each skill is at most about 500 words, except `subagent-driven-development`, `writing-plans` and `brainstorming`, which are at most about 900. Descriptions say *when* to load a skill, never how the procedure goes (superpowers found that agents follow a summary in the description and skip the body).

| Skill | Roles | Adapted from | Core |
|---|---|---|---|
| `brainstorming` | main | brainstorming | Talk before specs. Explore context, a few numbered questions per round, with a playback, offer 2–3 approaches with a recommendation, agree section by section. Write or delegate the spec only when the user says go. Spike, bounded and architectural paths. |
| `writing-specs` | architect, main | brainstorming (spec part) | dish's spec shape: status, summary, decisions table, non-goals, design with constraints checked in code, testing, open items. Self-review for placeholders and contradictions. |
| `writing-plans` | architect, main | writing-plans | `docs/plans/YYYY-MM-DD-<topic>.md`: header, global constraints, review focus, file map. Tasks a fresh coder can do from the task text alone: files, interfaces, failing test first, gate, done condition, commit. No placeholders. Self-review. |
| `subagent-driven-development` | main | subagent-driven-development | Run a plan with the crew. Ledger, pre-flight conflict scan, BASE per task, a self-contained brief to a fresh coder, gate, cross-family reviewer (`reviews`). Fix rounds: 1–3 `to` the same coder, 4 a fresh stronger coder, 5 you rule. Then a final whole-branch review. Don't ask to continue; stop only for the four stop conditions; list rulings at the end. |
| `executing-plans` | main | executing-plans | Without `delegate`, or for a two-task plan: the same ledger, test-first, gate, review and rulings, done yourself. |
| `dispatching-parallel-agents` | main | dispatching-parallel-agents | Independent questions go to parallel researchers and reviewers. Crew allows one writing child at a time, so coders run one after another. One brief per child; check the results for conflicts. |
| `requesting-code-review` | main | requesting-code-review | Delegate to `reviewer` with `reviews` set. The brief has the spec, the task, BASE..HEAD, the gate command and the review focus, never the chat. Then sort the findings by severity. |
| `receiving-code-review` | main, coder, architect, ops, writer | receiving-code-review | Restate each finding, check it against the code, fix test-first or push back with evidence. No performative agreement. Report `Fixed: …` per finding. |
| `reviewing-work` | reviewer | the code-reviewer and task-reviewer prompts | Treat the report as claims. Run the gate yourself. Two verdicts: spec compliance and quality. Each finding has a severity, file:line and a concrete failure. Re-review mode marks each finding ADDRESSED or NOT ADDRESSED. Read-only. |
| `test-driven-development` | coder, main | test-driven-development | The iron law. Red → green → refactor. Expected values derived by hand. Name the change that would break each test. |
| `systematic-debugging` | coder, ops, main | systematic-debugging | Root cause before any fix, in four phases. After three failed fixes, stop and report. Wait on conditions instead of sleeping. |
| `verification-before-completion` | every role | verification-before-completion | No claim without fresh evidence: claim → command → full output and exit code. Never trust a child's report or a piped `| tail`. |
| `using-git-worktrees` | main, coder | using-git-worktrees | One worktree per task, under a git-ignored directory. Baseline gate first. Never work on the default branch. |
| `finishing-a-development-branch` | main | finishing-a-development-branch | Run the gate on the final tree, then the final review. Push the branch and open a PR only after asking. Humans merge; merge only when the user says so. Clean up only your own worktrees. |
| `writing-skills` | main | writing-skills | Skills live in `skills/<name>/SKILL.md` and change through `config_propose`. Frontmatter rules, "Use when…" descriptions, word budgets. Test a change on a fresh child before proposing it. |
| `researching` | researcher | (new) | Primary sources, version and date, a citation for every claim, inference labeled. "Unknown" is an answer. Answer first, then evidence, then open questions. |
| `writing-for-readers` | writer | (new) | Name the reader, lead with what they need, plain words, the form the place calls for. Check every fact, name and command against its source. |
| `changing-infrastructure` | ops | (new) | Look before touching. GitOps repos over hand edits. Smallest reversible change, backed up. The exact command before anything irreversible. Verify, and say how to undo. Secrets stay out of repos. |

`plugins/skills/defaults/NOTICE.md` credits obra/superpowers (MIT, © 2025 Jesse Vincent) and includes its license. It isn't a skill, and it isn't seeded.

### Prompt changes

| Document | Adds |
|---|---|
| `common.md` | "When a task matches a skill in your skills list, load it with the `skill` tool before you start, and follow it. Your role's skills are named below your role." |
| `main.md` | A "Skills" section naming its skills by stage: brainstorming → writing-specs/writing-plans (or delegate them to the architect) → subagent-driven-development (or executing-plans) → requesting-code-review → finishing-a-development-branch; plus dispatching-parallel-agents, verification-before-completion, writing-skills. |
| each crew role | One "Skills:" line with that role's skills, per the table. |

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-skills` | `presets` | `{ dish: main }` | Preset id → the role of its top-level agents. Only agents on these presets get role skills. |
| `dish-skills` | `terminal` | `true` | Print this plugin's messages to the terminal. |

## Web UI: Settings → Skills

A `settings.section` page (order 47) built like Settings → Prompts: a framework-free controller, hand-written remote descriptors, live updates from `dishConfig.watch`.

**List:** every skill, sorted by name. Each entry shows:
- its role chips, or "all roles" or "off";
- a dot when it differs from its default;
- a "yours" badge when it isn't shipped;
- a problem marker when the stored document doesn't parse;
- the number of pending proposals.

**New skill:** asks for a name, checks it locally against the grammar, refuses a name already taken, then opens the editor on a template (frontmatter with `roles: [main]` and a "Use when…" description to fill in). Nothing is written until **Save**.

**Edit tab:**
- A monospace text area, an optional note, **Save** (Ctrl/Cmd+S) and **Discard**.
- `check` runs about 300 ms after typing stops. It shows problems, which disable Save, warnings, and a summary line: description length, roles, model and user invocable, and character count.
- On `CONFLICT`, your text is kept and a notice offers **Reload**. Same behavior as Prompts.
- **Delete** (yours only) asks to confirm, then writes a deletion.

**Default tab** (shipped skills only): a diff from the shipped default to what's saved, and **Reset to default** with a confirm step.

**History tab:** the document's commits, each with its diff and **Revert**, through `dish-config`'s remote. Same as Prompts.

Remote: Cordis service `dishSkillsRemote`, wire namespace `dishSkills`. Results are `Outcome<T>` with the store's error codes plus `UNAVAILABLE`. `''` means absent.

| Method | Returns |
|---|---|
| `skills()` | `Outcome<{ commit, skills: SkillInfo[], roles }>`. `SkillInfo` is `{ name, path, description, roles, modelInvocable, userInvocable, shipped, differsFromDefault, missing, problem, pendingProposals }`, where `problem` is `''` when the document is valid. `roles` is the role names dish knows. `commit` is `''` without a store. |
| `read(name)` | `Outcome<{ text, commit, defaultText, missing }>`. `defaultText` is `''` for skills you added. |
| `check(name, text)` | `Outcome<{ problems: string[], warnings: string[], summary }>`. `summary` is `null` when there are problems. |
| `save(name, text, base, note)` | `Outcome<CommitInfo \| null>`. It creates the skill when the path doesn't exist. `base` is the commit the page loaded. |
| `reset(name, base, note)` | `Outcome<CommitInfo \| null>`. Writes the shipped default; the note defaults to "Reset to the default". `INVALID` for a skill you added. |
| `deleteSkill(name, base, note)` | `Outcome<CommitInfo \| null>`. `INVALID` for a shipped skill: "turn it off with `roles: []` instead". Not called `remove`: the browser mounts a namespace's methods on a service that already has a `remove`, and refuses the clash, which stops the whole plugin from loading. |

## Packaging

- **The package:** `plugins/skills`, `dish-skills`.
  - Exports: `.` and `./client`.
  - Its `cordis.patch.yml` inserts the host row.
  - Peer and dev dependencies on `@deepseek-ai/dsh-skill` and `dsh-agent`, plus the client packages Prompts uses.
- **Deploy:**
  - `deploy/install.sh` links `skills` after `prompts`.
  - The install test's bundle list and `deploy/README.md` include it.
- **Dish preset:** no change.

## Testing

`node --test`, with a real store in a temporary directory and dsh's real `@deepseek-ai/dsh-skill` registry:
- **`parseSkill` and `checkSkill`:** every refusal and warning above.
- **The namespace:** the claim and its `propose` policy, plus seeding.
- **`seed` with `replace`:**
  - replaced when the hash matches;
  - kept when the document was edited;
  - written when missing;
  - one commit, with the note;
  - `INVALID` for a stray path.
- **`previous-defaults.mjs`** against a temporary git repo, and the drift test.
- **Service:**
  - the catalog per commit;
  - problems for hand-broken documents;
  - role filtering;
  - defaults without a store;
  - change listeners on `dish-config/changed` and on the store appearing or going.
- **Providers, against the real registry with scoped contexts (`createScope`, `bindScopeParent`):**
  - The global entry is menu-only.
  - An agent layer offers its role's skills to the model and leaves the rest menu-only.
  - A child's role comes from a stub `dishCrew`.
  - A failed lookup is incomplete and retried.
  - An invalidate refreshes.
  - `get` returns the body.
  - Agents on other presets get nothing in the agent layer.
- **Remote:** every method, with and without a store, including the `Outcome` codes.
- **Client:**
  - the remote descriptors match the server;
  - the controller, against fake APIs: list, select, new, check debounce, save, conflict, reset, delete, history and live events.
- **Default skills:** every shipped skill parses and passes `checkSkill` with no warnings, and its roles are known roles. Every role has at least one skill.
- **Prompts:** every shipped role prompt names only skills that exist, and each crew prompt names exactly its role's skills from the table. The prompts `reset` note default.

By hand, in a scratch `DSH_HOME` with fake credentials: `dsh plugin add`, then check that the page loads and saves.

Live (needs you):
- start a dish-preset chat and check the skills catalog lists main's skills;
- delegate to a coder and check that its catalog shows the coder's;
- `/brainstorming` from the menu.

## Open items

- Should every agent see every skill instead (decision 2)?
- Should shipped skills be deletable, which needs a tombstone list (decision 7)?
- Pressure tests for the discipline skills (TDD, verification, debugging), following `writing-skills`.
- `orchestrator` (step 7) may take over the main agent's pipeline skills and the ledger.

## Notes from the build

- **`agent.ctx.skills` throws in real dsh.** The agent loop doesn't inject `skills` into an agent's context, so a property read fails. The role provider registers through `agent.ctx.get('skills')`, which returns the service bound to the agent's own context, so the provider still lands in the agent's layer.
- **One malformed candidate would break the catalog for every provider.** `dsh-skill` runs `validateCandidate` outside the provider's own `try`, so a candidate it dislikes rejects the whole lookup. The providers drop any document that isn't fit (and log it) before they list.
- **The preset is read again on every lookup.** Switching the preset on a blank session rebinds the agent without a new `agent/created`. So the role provider is registered on every agent, not only those that start on a configured preset, and it checks the agent's preset when it lists.
- **Parsing is stricter than the spec's list.**
  - A YAML alias or anchor that reuses a value is refused ("write it out"), because a few hundred bytes of aliases can say a cyclic value, or one that is a billion entries once written out.
  - Booleans are strict: only `true` and `false`, never `yes` or a string.
  - The description is trimmed, then must be at most 1024 characters. The name is at most 64.
- **A pathological document can't take the catalog or the page down.** The service builds the catalog one document at a time, and the remote isolates each document too. A document that throws becomes a problem of its own, and the rest still serves.
- **Ruling: a store with no skill documents (and no problems) serves the shipped defaults,** at commit `null` — so agents are never left without skills for want of a seed, which covers a store before its first seed and one whose seed failed. A store whose documents are all problems doesn't: that is an answer, and the page shows the problems. The cost if wrong is low: agents see the shipped skills where the store would show none.
- **Seeding.** `seed(..., { replace })` and `defaults/previous.json` are as above. The content commits were squashed before `previous.json` was generated, so it lists only texts that shipped, not drafts. Prompts' `previous.json` lists the earlier shipped prompt texts, so the VM's unedited prompts move to the new ones at its next start.
- **`dish-skills/skill` is exported** (`package.json` exports `./skill`) for dish-prompts' test of skill mentions. It parses the shipped skills, checks their roles, and finds their directory through this export, without loading the plugin.
- **The prompts reset note** now defaults to "Reset to the default", and the backlog item is closed.
- **The ledger lives in the working directory.** `subagent-driven-development` and `executing-plans` keep it at a git-ignored `.worktrees/<plan file name>-ledger.md`. Under dsh's sandbox a write outside the workspace asks for approval every time, so a ledger kept elsewhere would interrupt every task.
- **`common.md`'s skill rule yields to the brief:** "load it … unless your brief says not to". A pressure-test child, as `writing-skills` runs them, can then be told not to load the skill under test.
