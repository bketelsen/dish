# dish-crew

A fixed crew of specialists the main agent hands work to, with the conversation staying open while they run.
- **One tool, `delegate`.** It starts a child in a role, or sends a fix round to a child it already started. Each child gets its role's prompt from `dish-prompts`, its role's tools, and a model from its role's tier.
- **Reviewers run on another family.** The reviewer always runs on a different model family, and vendor, from the work it reviews. The harness enforces this.
- **`crew.yaml`** in the config store holds the roles, tiers, models and limits.
- **Crew keeps its own record.** It saves every child's final report, and finish notices name the child's role and model.
- **This bundle ships the dish preset:** the main agent's preset, with `delegate`, and with dsh's own delegation tools turned off.

The design and its reasoning are in the [spec](../../docs/specs/crew.md). Why this builds on dsh's subagents directly rather than its experimental agent teams is in the [research note](../../docs/research/2026-10-01-dsh-agent-team.md).

## Install

```sh
pnpm dsh plugin --profile web add ./plugins/crew
```

It needs `dish-config` and `dish-prompts` in the same profile. On its first start with the store, it seeds `crew.yaml`.

**Choose the preset:** on **Settings → Agent presets**, use **Set as new task default** on **dish**. The mode picker on a new chat switches per chat.

## Using it

Talk to the main agent as usual. It delegates by itself, as its prompt (`prompts/main.md`) tells it to:

> delegate a researcher to find …
> delegate a coder to …, then have a reviewer check it

- **The main agent ends its turn after delegating.** You can keep talking. When a child finishes, its notice wakes the main agent.
- **The session header's subagent list** shows each child as `role · model · title`, with its status. Click a child to open its session.
- **Fix rounds:** `delegate` again with `to` set to the same child. It continues with its history.
- **Reviews:** the `reviewer` role with `reviews` set to the child whose work it checks, or `main` for the main agent's own work.

## crew.yaml

Edit it by asking the main agent, which writes it with `config_write`, and review the change on Settings → History. The shipped file:

```yaml
provider: github-copilot
families:
  anthropic: { strong: claude-opus-5.5, mid: claude-sonnet-5.5 }
  openai:    { strong: gpt-6.1-sol,     mid: gpt-5.6-sol }
reviewerFamilies: [openai, anthropic]
limits: { running: 4, writers: 1, perSession: 30 }
roles:
  architect:  { tier: strong, family: anthropic, writes: true,  tools: [...] }
  coder:      { tier: mid,    family: anthropic, writes: true,  tools: [...] }
  reviewer:   { tier: mid,    reviews: true,                    tools: [...] }
  researcher: { tier: mid,    family: anthropic,                tools: [...] }
  ops:        { tier: mid,    family: anthropic, writes: true,  tools: [...] }
  writer:     { tier: mid,    family: anthropic, writes: true,  tools: [...] }
```

For direct API keys, with Claude through an `anthropic` provider and GPT through an `openai` one, give each family its provider and keep the rest of the file (`limits` and `roles` as above). Use the model ids the provider's API names:

```yaml
provider: anthropic       # required: the provider of any family that doesn't have its own
families:
  anthropic: { provider: anthropic, strong: claude-opus-5.5, mid: claude-sonnet-5.5 }
  openai:    { provider: openai,    strong: gpt-6.1-sol,     mid: gpt-5.6-sol }
reviewerFamilies: [openai, anthropic]
```

- **A broken file can't be saved.** It is checked when written: unknown keys, model ids padded with spaces, a model listed in two families, a role with no tools, and more are refused, each with the path at fault.
- **Families and tiers.** Each role uses its family's model at its tier. The main agent may pass `model` to pick another model listed in `families`.
- **A provider per family.** `provider` at the top is where every family runs, and it is required. A family may add its own `provider` next to its tiers, for direct API keys, where Claude and GPT come through different providers (the example above). A model override runs on the provider of the family its model is in. When a refusal lists the models, a family with its own provider shows them as `provider/model`, and either form is accepted back as `model`. A model id that equals another model's `provider/model` name is refused when the file is saved.
- **The reviewer** has no `family`. It takes the first `reviewerFamilies` entry that isn't the reviewed work's family, and that lists no model of the same vendor. That is told by model ids, never by provider names, and it runs on the provider of the family it lands in.
- **Limits.**
  - At most `running` children run at once, and at most `writers` of the roles marked `writes: true`. Until per-task worktrees exist (roadmap step 6), children share one directory, so one writer at a time.
  - A session can start `perSession` children in all. Follow-ups don't count toward it.
- **Tools.**
  - A role's `tools` are an allow list. Tools the main agent can't pass on are dropped when the child starts; those are the ones on its own scope, not the preset's.
  - Whatever the file says, a child never gets `delegate`, dsh's delegation and workflow tools, the goal or plan tools, `ask_user_question` or `present`.

A role also needs a prompt: `prompts/crew/<role>.md`, or a shipped default.

## What crew records

In `$XDG_DATA_HOME/dish/crew/`:
- `sessions/<hash of the session>/children.json` holds each child's role, model, family, what it reviews, its follow-ups and its runs.
- `<n>-<role>-<run>.md` in the same folder holds each run's closing message, the child's report.
- `by-child/` holds pointers, so a child resumed after a restart is filed under the right session.

Records not touched for 180 days are pruned at startup. A finish notice gives its run's report path. Copy reports worth keeping into a repo's docs.

## The dish preset

`presets/dish.patch.yml` is **generated** from the `standard` preset of the dsh you have installed. It differs in three ways:
- the stock persona row is replaced by `dish-prompts/persona`;
- the `dish-crew/delegate` row is added;
- dsh's own delegation rows (`subagent`, `subagent_fork` and the workflow engine) are disabled.

Any row from dsh's delegation packages left enabled fails the generator. The `subagent` row would otherwise install its tool into every agent on the preset, children included, where no filter reaches.

After a dsh upgrade, a test fails if `standard` changed. Run:

```sh
pnpm --filter dish-crew sync-preset
```

## Configuration

| Row | Field | Default | |
|---|---|---|---|
| `dish-crew` | `dataDirectory` | `$XDG_DATA_HOME/dish/crew` | Where records and reports go. Absolute, or starting with `~/`. |
| `dish-crew` | `subagentProvider` | `spawn` | The `ctx.subagents` provider for children. |
| `dish-crew` | `terminal` | `true` | Print this plugin's messages, and the preset row's, to the terminal. |

## Caveats

- **A start that fails still counts** toward `perSession`, a cancelled one included.
- **`send_message` isn't checked against the limits.** It can still wake a finished child, and the woken child counts as running from then on. Fix rounds should go through `delegate` with `to`.
- **Children share the main agent's working directory.** dsh 0.2.0-rc.2 has no per-child `cwd`.
- **Children can't ask you anything.** dsh runs them with approval policy `never`.
- **Without `dish-prompts`,** the persona row logs once and `delegate` refuses every call, naming the missing plugin. Nothing refuses at load.
- **Claude Sonnet 5.5 comes from `dish-copilot`'s catalog,** which copies settings from the nearest catalog model of the same generation. An older copy rejected every request from crew children (Task 9's live check found it).
