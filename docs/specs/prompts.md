# Spec: role prompts (`dish-prompts`)

Status: draft, 2026-10-01. Implements roadmap step 3. Builds on the [design](../design.md) (every agent's prompt editable in the web UI, stored and versioned) and the [config store](config-store.md).

## Summary

`dish-prompts` keeps the persona text of each dish agent in the config store and gives it to agents when they start.
- One document per role: `main`, plus the crew roles `architect`, `coder`, `researcher`, `ops`, `writer` and `reviewer`. `common.md` holds rules for every role.
- You edit them on **Settings → Prompts**: save with conflict checks, see what the model sees, compare with the shipped default, and reset.
- A **persona row**, mountable in any agent preset, gives that preset's agents a role's prompt as it stands when the agent starts. A **"dish" preset** shipped with the plugin uses it for the main agent. `crew` (step 4) gives delegated children their roles through the `dishPrompts` service.

## Decisions (from the 2026-10-01 discussion)

| Topic | Decision |
|---|---|
| What you edit | The **persona** part of the prompt only. dsh keeps writing its identity line, tool and skill guidance, and runtime context, so they stay correct as tools change. |
| Shared rules | `prompts/common.md` goes into every role. You have no `~/.dsh/AGENTS.md`, and none is needed: global rules live here. A repo's own `AGENTS.md`/`CLAUDE.md` stay as dsh loads them. |
| Main agent before `orchestrator` | A **"dish" preset** shipped now, which you set as your default. dsh's stock presets stay available. |
| Agent edits | Crew prompts: `config_write` when you ask. `main.md` and `common.md`: **proposal only**, so the agent never rewrites its own instructions without your click. |
| Editor extras | A "what the model sees" preview, a diff against the shipped default with reset, and the list of prompt variables. |
| Defaults | Drafted by Claude in the superpowers style, seeded once, then yours to revise. |
| When edits apply | At the next agent start. A running agent keeps the prompt it started with. |
| Roles | The seven seeded roles. Adding or removing crew roles belongs to `crew` (`crew.yaml`), later. |

## Non-goals

- Editing dsh's own prompt sections (identity line, tool docs, skills list, runtime context).
- Per-family or per-repo prompt overrides (family conventions, later).
- Skills (roadmap 3a).
- The judge's questions, which live in code.

## Documents and namespaces

| Path | Holds | Agent policy |
|---|---|---|
| `prompts/common.md` | rules for every role | `propose` |
| `prompts/main.md` | the main agent | `propose` |
| `prompts/crew/<role>.md` | one crew role each; `<role>` is `[a-z][a-z0-9-]*` | `write` |

Three claims, because the store's agent policy is per namespace and namespaces can't overlap. This refines the config-store spec's default of `write` for all of `prompts/`.

**Validation** (the namespaces' `validate`):
- A prompt may not be empty or only whitespace. To go back to the default, use **Reset**.
- Under `prompts/crew/`, only `<role>.md` directly, no subdirectories.

**Variables.** A prompt may use dsh's prompt variables, `{{model}}`, `{{cwd}}` and any a plugin registers. dsh renders them strictly: an unknown name, or one with no value, fails the agent's step. A prompt is edited text that outlives the plugins it mentions, so dish-prompts renders its own sections itself, leniently:
- each known name with a value is replaced;
- anything else is left as written and logged once per agent;
- the section is then handed to dsh with `interpolate: false`.

The editor warns about names it doesn't know, but doesn't refuse them.

## How a role's prompt is built

For role `r`, the persona is:
- **prefix** (dsh order 0, right after the identity line): `prompts/main.md` or `prompts/crew/<r>.md`;
- **suffix** (dsh order 10200, the end of the prompt): `prompts/common.md`.

Putting the shared rules last gives them weight, and keeps the role text's early position stable. Editing `common.md` changes only the end of every prompt, so providers' prompt caches keep reusing everything before it.

A missing document (deleted by hand or by a revert) falls back to the shipped default, and the plugin logs it once.

## How agents get it

### Constraints (checked in dsh 0.2.0-rc.2's code)

- **Section text must be synchronous.** dsh asks every section for its text on every model step (`assemble()` in the loop's `preStep`), with no `await`. The store is async, so a section can only return text already loaded.
- **A preset row is applied once per preset, not once per agent.** Every agent bound to the preset shares the row's registrations. Delegated children share them too, because they're composed from their parent.
- **The `system-prompt/assemble` waterfall can be async.** A listener registered by a preset row hears the assembly of every agent under that preset, children included, and can rewrite sections by name.
- **dsh compares each step's rendered prompt with the one it logged.** Any difference is recorded as a new system message. So the text an agent gets must not change during its life, including across a dsh restart (`agent/created` with `source: 'resume'`).
- **A subagent's `persona` is a string** that dsh registers as the child's own `deployment:persona-prefix`, which shadows the preset's. It's stored in the child's descriptor and reapplied on resume, so it's already a snapshot.
- **Presets have no inheritance.** A new preset lists its whole plugin list. A user override of a preset replaces that preset's entire child list.

### The service and the store

`dish-prompts` provides `dishPrompts` whether or not the store is up: `dishConfig` is an optional dependency. When `dishConfig` appears, the plugin claims its three namespaces and seeds the defaults. While it's absent, every read answers with the shipped defaults.

### The snapshot

The `dishPrompts` service takes a **snapshot** the first time it's asked for an agent: the store's `main` commit at that moment.
- The snapshot is the commit id, not the text. The texts are read at that commit, and a commit in the store never changes.
- It's persisted in `$XDG_STATE_HOME/dish/prompts/agents/<sha256(agent id)>.json` as `{ role, commit, takenAt }`. A resumed session after a restart gets the same prompt it started with.
- `agent/created` with `source: 'clear'` (`/clear`) drops the snapshot, so the cleared session starts on current prompts. `compact` keeps it.
- Snapshot files not read for 180 days are pruned at startup.
- If the store isn't available (`dishConfig` missing, e.g. `LOCKED`), the shipped defaults are used and the snapshot records `commit: null`. Defaults are the plugin's, so a later restart on the same plugin version gives the same text.

### The persona row: `dish-prompts/persona`

A plugin row for preset compositions, the counterpart of `@deepseek-ai/dsh-persona`, configured with `{ role }` (`main` in the dish preset). It registers no sections. It registers one `system-prompt/assemble` listener that, for each agent under the preset:

1. awaits the agent's snapshot (instant after the first step). For a delegated child, only `common` is used from it;
2. finds the assembled `deployment:persona-prefix` and `deployment:persona-suffix` sections by name, and sets their text, interpolated leniently, with `interpolate: false`:
   - **a top-level agent:** the prefix is the row's role document, the suffix is `common.md`;
   - **a delegated child** (`delegationDepth` above zero): the prefix is left as the child's own persona (crew's role text) and only interpolated leniently; the suffix is `common.md`.

   The global persona sections always exist (`dsh-system-prompt` registers them unconditionally), so there's always something to set.

A `complete` section isn't marked in the assembly, and dsh restores it after the waterfall anyway, so a preset that uses one gets exactly that section, as dsh intends.

The row needs the `dishPrompts` service. If the `dish-prompts` plugin isn't loaded, the row logs once and leaves the assembly unchanged, so the agent still works, on dsh's empty global persona.

### The dish preset

The bundle inserts a `@deepseek-ai/dsh-agent-preset` row, `id: preset-dish`, with `config.id: dish` and a display name, so the Agent presets page lists it as a custom preset.
- Its plugin list is a copy of the web app's `standard` preset, with the stock `persona` row replaced by `dish-prompts/persona` (`role: main`).
- You make it the default once on **Settings → Agent presets**, which dsh stores in your profile. The bundle doesn't touch `agent-preset-registry`.
- **Drift check:** a test reads the installed `dsh-web-app` `presets/standard.patch.yml` and fails when its list, minus `persona`, differs from the copy. A dsh upgrade then says what to update, instead of silently giving the dish preset an old tool set.
- `orchestrator` (step 7) takes this preset over later. Until then it lives here.

### Delegated children (for `crew`, step 4)

`crew` asks `dishPrompts.persona(role)` at delegation time and passes `prefix` as the child's `persona`. dsh stores it in the child's descriptor, so the child keeps that text for its life. Under the dish preset, the row adds `common.md` as the child's suffix and renders the child's prefix leniently. Under another preset, children get the role text but not `common.md`. That's crew's concern, and noted here only so it isn't a surprise.

## Service: `dishPrompts`

```ts
interface DishPrompts {
  /** 'common', 'main', then the crew roles under prompts/crew/, sorted. */
  roles(): Promise<string[]>
  /** The texts on main right now, defaults filled in for missing documents. */
  persona(role: string): Promise<{ prefix: string, suffix: string, commit: string | null }>
  /** The agent's snapshot: taken on the first call for that agent, the same for its whole life. */
  snapshot(agent: { id: string }, role: string): Promise<{ prefix: string, suffix: string, commit: string | null }>
  /** Forget the agent's snapshot (on `/clear`); its next call takes a new one. */
  drop(agent: { id: string }): Promise<void>
  /** The shipped default for a role, or undefined for a role with none. */
  defaultText(role: string): string | undefined
}
```

`persona` and `snapshot` return raw text; interpolation happens where the agent's variables are known (the row).

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-prompts` | `stateDirectory` | `$XDG_STATE_HOME/dish/prompts` | Where snapshots are kept. Absolute, or starting with `~/`. |
| `dish-prompts` | `terminal` | `true` | Print this plugin's messages to the terminal. |
| `dish-prompts/persona` | `role` | required | `main`, or a crew role, for a preset built around one. |

## Defaults

Shipped as files in `plugins/prompts/defaults/` (laid out like the store: `common.md`, `main.md`, `crew/<role>.md`), seeded with `dishConfig.seed` (only what doesn't exist, so your edits survive an upgrade). Short and direct; each role says what it is for, what it hands back, and what it never does.

| Role | Covers |
|---|---|
| `common` | Ends with the stock suffix, "Your working directory is {{cwd}}." Humans merge. Never store or echo secrets. Ask before irreversible or outward-facing actions. Report results faithfully, including failures. Prefer small, verifiable steps. |
| `main` | Opens like the stock persona: "You are dish's main agent, powered by the {{model}} model." You're the controller: keep the conversation open and delegate about 90% of the work to the crew with `delegate`; do small things and judgment calls yourself. When `delegate` isn't available, do the work yourself. Record rulings (`what — why — cost if wrong`). Changes to your own prompt or `common` go through proposals. |
| `architect` | Turn a goal into a spec and a plan of small tasks a mid-tier model can do, each with files, tests and a done condition. |
| `coder` | Test first. Stay inside the task. Run the repo's gate before saying done. Report what changed and anything left undone. |
| `researcher` | Find, read and cite sources. Separate what the sources say from inference. Say when the answer is unknown. |
| `ops` | Read before changing. Smallest reversible change. Say what you'd run before anything irreversible. |
| `writer` | Write for the reader named in the task. Plain, short, accurate. |
| `reviewer` | Review against the spec and the task, not taste. Findings ranked by severity, each with a concrete failure. No edits. |

## Web UI: Settings → Prompts

A `settings.section` page, like History.

- **List:** Common, Main, then the crew roles found under `prompts/crew/`. Each shows a dot when it differs from its default, and a count of pending (open or stale) proposals for it.
- **Editor:** a monospace text area with an optional note (it becomes the commit's `Dish-Note`).
  - **Save** writes as you with `base` set to the commit the page loaded. On `CONFLICT`, your text stays in the editor, and a notice shows what changed underneath and offers **Reload**.
  - **Discard** goes back to what's saved.
- **Default** tab: a diff from the shipped default to what's saved, and **Reset to default** (a normal commit, so it can be reverted).
- **Preview** tab: the full system prompt a new agent in this role would get now.
  - Built the way dsh builds it: lease the dish preset's scope (`agentPresets.acquireScope('dish')`), `systemPrompt.assemble({ scope })`, then the row's listener with the current texts instead of a snapshot, then `renderPrompt`.
  - Variables that only exist per agent (`model`, `provider`, `cwd`) show as `‹model›` and so on.
  - Labeled as an approximation. Runtime context (sandbox and approval policy, `AGENTS.md`) reaches the model as separate messages and isn't shown. For a crew role, the child's own persona is shown in place of `main`'s.
  - Nothing shipped in dsh assembles without an agent, so this path is the first thing the plan checks. If it fails, the preview shows the persona sections in place between labeled markers for dsh's sections.
- **Variables:** the prompt variables available now, with their current values where they have one (`model`, `cwd`, ...).
- **History** tab: this document's commits, each with its diff and **Revert**, through `dish-config`'s remote (`history`, `commit`, `revert`). A settings section can't open another one (dsh gives a section only `close`), so the page shows the document's history itself rather than linking to Settings → History. The diff view moves from `dish-config`'s client into `dish-kit` so both pages use it.
- Proposals for `main` and `common` are accepted or rejected on the History page, as now. The editor shows how many are open.

The page talks to a Typert remote, Cordis service `dishPromptsRemote`, wire namespace `dishPrompts`, built like `dish-config`'s (hand-written client descriptors, `Outcome<T>` results carrying the store's error codes, `''` meaning absent). It follows `dishConfig.watch` from `dish-config`'s remote for live updates, instead of a stream of its own.

| Method | Returns |
|---|---|
| `roles()` | `Outcome<RoleInfo[]>`: `{ role, path, agent, differsFromDefault, missing, pendingProposals }`; `pendingProposals` counts open and stale proposals that change the role's document |
| `read(role)` | `Outcome<{ text, commit, defaultText, missing }>`: `missing` when the document is absent and `text` is the default |
| `save(role, text, base, note)` | `Outcome<CommitInfo \| null>`: `null` when nothing changed |
| `reset(role, base, note)` | `Outcome<CommitInfo \| null>`: writes the shipped default |
| `preview(role)` | `Outcome<{ text, approximate, fallback, unknownVariables }>`: `fallback` when dsh's assembly couldn't be used and the text has markers in place of dsh's sections; `unknownVariables` is then always `[]` |
| `variables()` | `Outcome<{ variables: { name, value }[], fallback }>`: the variables visible to the dish preset, `value` empty for per-agent ones. With `fallback` (dsh's assembly unusable) the list is empty, and the page doesn't warn about unknown names. |

## Testing

`node --test`, with a real store in a temporary directory:
- namespace claims and their policies (crew `write`, main and common `propose`)
- validation: empty, nested paths
- the editor's unknown-variable warning
- seeding, and a missing document falling back to the default
- prefix and suffix composition, lenient interpolation (known, unknown, valueless)
- snapshots: an edit after the first step doesn't change that agent's prompt; the next agent gets it; a restart gives the same text; `/clear` takes a new one; store missing gives defaults
- the row's listener on a top-level agent, a delegated child, and an assembly with a `complete` section
- the drift check against the installed `standard` preset

By hand in the browser: the preview path first (see the open items), then the editor, conflict, reset, variables and the History tab. Live: start a chat on the dish preset and check the trajectory's "Initial System Prompt" shows `main.md` after the identity line and `common.md` at the end.

## Open items for the plan

- ~~Package subpath as a row name.~~ Works: `dish-copilot/catalog` already loads that way. A preset's rows go through the same loader; the live check confirms it.
- ~~`interpolate: false` on an assembled section.~~ Works: `AssembledSection` carries `interpolate`, `renderPrompt` honors it, and the waterfall's `assembly.variables` holds the resolved values the lenient interpolation needs.
- The preview path (above): checked live first.
