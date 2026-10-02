# Spec: friction fixes from the first local-model session

Status: built on branch `friction`, 2026-10-02; awaiting review and the rollout (the plan is [docs/plans/2026-10-02-friction.md](../plans/2026-10-02-friction.md); what differed from this spec is under [Notes from the build](#notes-from-the-build)). **Task 5 did not run:** [question 2](#questions-for-you) was settled on option C, `main.md`'s rule, which is built. Option A, crew's own `send_message`, is on the roadmap's backlog for after 6b merges. Option B, the 600-character guard, was not taken and is **not done**; you can still ask for it. It comes from a review of the 2026-10-02 session in which `qwen3.8-flash-next` (provider `selfie`) ran as dish's main agent and built an Astro blog with five crew children. You approved items 1–4 of the review's proposal; this spec fixes them, corrected by the [Checks](#checks-2026-10-02) against dsh 0.2.0-rc.2's sources. It changes `dish-judge`, `dish-prompts` and `dish-crew`, and nothing outside them.

The review (the "friction report") numbers its findings A1–A5, B6–B10, C11–C14, D15–D19 and E20–E24, and its recommendations 1–13. They are cited that way below.

## What the session showed

The work got done: 9 commits, every acceptance check passed, and a cross-family review with one fix round, in 47 minutes. About half of that time was spent waiting for approvals:
- **The judge's task was wrong** (A1–A3, A5; rec. 1).
  - For the main agent, the task was only your latest message. After you sent the site URL, commits scored `serves_task` 0.17–0.48, and 12 of the 25 approvals you gave were for that reason alone.
  - For a child, the task was the first 4,000 characters of its brief. Coder #1's brief was 5,853 characters, and its commit and report instructions fell past the cut. The judge refused 4 commits and a read-only check.
  - A fix round (`delegate` with `to`) arrives as an `agent-message`, which the gate never reads. So the fix round was judged against the old brief, and refused.
- **Nothing told the agents how this machine works** (B6–B9, C13, E20; recs 2, 3, 7).
  - With a read-only home, `mise install` failed. The agent moved mise's and XDG's directories into the repo, pasted a 450-character preamble into about 20 commands and 4 briefs, and left a pnpm store in the project.
  - It kept a `cd` across calls, ran 35 approval-gated commands itself, and wrote briefs of 4.1–6.4k characters with the commit instructions last.
- **Crew** (C11, C12; recs 4, 6).
  - `reviews: "main"` refused, because crew can't place a qwen model in a family.
  - 3 of the 5 children sent a "done" summary with `send_message` before their report. The researcher's summary woke the main agent early, and it went looking for the report in `/tmp`.
- **The prompt said the wrong model** (D15; rec. 5): `{{model}}` told qwen it was `gpt-6.1-sol`.
- **qwen's own slips** (E21–E23; recs 8, 9): it skipped the "wait for the go", claiming you were away 2 minutes after you answered. Children also failed 10 edits on files they had only `cat`ed (D18).

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | The main agent's task | Its prompts, the human-written messages (`source.kind: 'user'`), oldest first. **The first is always in, and so is the newest.** The ones before the newest are added newest first while the task stays within 8,000 characters. A gap is marked `[… N earlier messages left out]`. A message equal to the one before it (a resend) counts once. This keeps "the first prompt plus the latest" (rec. 1), and fixes the case it misses: in this very session the first prompt was "hello!", and the request came second. See [Questions](#questions-for-you), 1. |
| 2 | A child's task | Its brief plus the latest instruction after it. The brief is the first text block of its first `user` message: crew's closing note and dsh's return note are the blocks after it, and say nothing about the task. An instruction is a message from its parent (`source.kind: 'agent-message'` with `senderSessionId` equal to the header's `parentSession`), or one a person typed into the child (`source.kind: 'user'`). A message from anyone else, and every notice, never counts. |
| 3 | Clipping | Each message is cut to 4,000 characters by taking out its middle: about the first 2,000 and the last 2,000 stay, joined by `\n[…]\n`. Then the whole task is cut to its budget (decision 1). Nothing else changes: `servesTask` stays 0.50, and the questions stay as they are. |
| 4 | "This machine" | A new section of `common.md`, so every role reads it, with the exact escalation that dsh's `bash` offers: `sandbox_permissions: "danger-full-access"` plus a one-line `justification` (see [Checks](#checks-2026-10-02)). It's written for shell commands, so a role without `bash` passes over it. |
| 5 | Installs by children | The main agent leaves installs to a coder or ops child, as you asked, but a child's escalation goes to the judge, which reads an escalated `npm install` as partly irreversible and refuses it ([judge spec](judge.md#the-command-gate), measured live). So a refused child names the command and its `workdir` in its report, and the main agent runs it there escalated, with your approval, and sends the child on with `delegate` and `to`. Both prompts say so. |
| 6 | Smaller prompt fixes | In `main.md`: builds, installs and commits go to a coder or ops; the main agent runs only quick read-only checks and the steps its skills give it (a gate run to verify, a worktree, bringing commits onto the plan branch, a push); a child's `send_message` is never its report; briefs open with the goal and steps, commits included, and stay short; you're away only when you've said so. In `common.md`: one job per shell call; no `rm -rf` before a build. In `crew/coder.md`: `write`/`edit`, and `read` before `edit`. The texts are [below](#the-prompt-texts), word for word. |
| 7 | Upgrading stored prompts | `plugins/prompts/defaults/previous.json` is regenerated the documented way, in the same commit as the texts. A stored prompt that is still an earlier default is replaced at the next start, and an edited one is kept ([skills spec, decision 9](skills.md)). |
| 8 | Crew with any main model | `avoided()` treats a model that crew.yaml doesn't list, and whose id names no vendor it knows, as its own family: it excludes nothing, so the reviewer takes the first `reviewerFamilies` entry. `VENDORS` gains `alibaba` (qwen, qwq), `deepseek`, `moonshot` (kimi), `zhipu` (glm, chatglm), `meta` (llama) and `mistral` (mistral, mixtral, codestral, devstral, magistral, ministral, pixtral). The known vendors behave exactly as before. **Accepted risk:** an alias that hides its vendor (`sonnet-x` for a Claude model) can now get a reviewer of the same vendor. Listing it in a family in `crew.yaml` closes that, as before. |
| 9 | `{{model}}` | dish's own persona row, not dsh, was the cause (see [Checks](#checks-2026-10-02)). The row interpolates the persona texts **after** `next()`, from the variables that dsh's model selection has already set, and is registered with `prepend: true`. No variable is registered, and no dsh issue is needed for it. |
| 10 | Duplicate child summaries | No code change in this branch, beyond `main.md`'s rule. The only change that stops a short "done" summary is to keep dsh's note out of the child's task, which is bigger than a small task (see [Questions](#questions-for-you), 2). An optional small task lowers the report guard's limit. |

## The judge's task (`dish-judge`)

`taskOf(agent, topLevel)` in `plugins/judge/src/gate.ts` keeps its signature, and still never throws: anything it can't read is `''`.

```ts
/** One message is cut to this many characters, by taking out its middle. */
export const MAX_PART_CHARS = 4000
/** A message between the first and the newest is cut to this many, so that more of them fit. */
export const MAX_MIDDLE_CHARS = 1000
/** The task is kept within this many characters (the first and the newest message are always in). */
export const MAX_TASK_CHARS = 8000
/** `text` within `max` characters: its first and last halves, joined by `\n[…]\n`, with no half of a surrogate pair left at either cut. */
export function clipMiddle(text: string, max: number): string
```

- **A top-level agent.** Every `user/message` event whose `source.kind` is `user`, read as today (`promptText`: the text blocks, joined by `\n`, trimmed), oldest first. One equal to the one before it is dropped. The first and the newest are clipped to `MAX_PART_CHARS`, and the ones between to `MAX_MIDDLE_CHARS`. The task is the first, then a gap line if any were left out, then the newest ones that fit, oldest of them first, joined by a blank line. "Fit" counts the separators and the gap line: a middle message is added only while the whole stays within `MAX_TASK_CHARS`. Only the first and the newest can take it past that: a task is at most `MAX_TASK_CHARS` plus a gap line and two separators.
- **A child.** Its own events (from `inheritedEventCount`, as today):
  - the brief is the first `user/message` with `source.kind: 'user'`, and of it only the first non-empty text block;
  - the latest instruction is the last `user/message` after the brief that has `source.kind: 'agent-message'` and `source.senderSessionId === header.parentSession`, or `source.kind: 'user'` with a string `rpcId` (which dsh's `subagent.prompt` gives a prompt a person typed into the child). Its text blocks are joined, without dsh's leading block `Agent <id> sent a message: `. A child whose header has no `parentSession` reads no `agent-message`;
  - the task is the brief, clipped, and then, after a blank line, the latest instruction, clipped.
- **What never counts:** a child's `agent-message` to the main agent, `subagent-settled` notices, tool results, `goal`, `runtime-context`, `skill-catalog`, `agent-instructions`, `tool-jobs` and every other injected kind, and an `agent-message` from anyone but the parent. An instruction from the parent has the same standing as the brief it follows, which also came from the parent.
- **The spec's state line** (`docs/specs/judge.md`, "The command gate") becomes: `"task": "<the agent's task: the main agent's first and latest prompts, or a child's brief and its latest instruction; see below>"`, with a short "The task" paragraph that says the above.

## The prompt texts

These are the shipped defaults, word for word. Lines not shown are unchanged.

### `plugins/prompts/defaults/common.md`

The house rules stay as they are. A new section comes after them, and `Your working directory is {{cwd}}.` stays the last line (the preview test and `roles.test.ts` pin `{{cwd}}` as the file's only variable):

```markdown
## This machine

When you run shell commands:

- Each `bash` call is a fresh shell in your working directory: `cd` and `export` don't carry over. Pass `workdir` (or `git -C`) instead of a `cd` you expect to carry over, and give each call one job.
- A command can write only inside the workspace and its own `/tmp`, which starts empty on every call and is gone after it. Keep scratch files in a git-ignored directory of the workspace, such as `.worktrees/` when `git check-ignore -q .worktrees` succeeds (don't edit `.gitignore` for it), and never commit them.
- Your home directory is read-only. `mise install`, `mise trust`, `pnpm install`, `pnpm add`, `pnpm create` and `pnpm dlx` write there, so they fail with "Read-only file system". `sudo /usr/local/sbin/dish-apt-get install <package>` fails inside the sandbox too.
- For those, run the same command again with `sandbox_permissions: "danger-full-access"` and a one-line `justification`, and the user approves it. A crew child's request goes to the judge, which refuses most installs: then stop, and put the exact command and its `workdir` in your report.
- Never point `HOME`, `XDG_*` or `MISE_*` into the workspace to get around this.
- Don't add `2>&1`, `2>/dev/null` or a pipe into `tail`/`head`: dsh already shows stderr and keeps the tail of long output, and it spots a sandbox denial only by the exit code and "Read-only file system" on stderr, and only then offers the escalation.
- mise's shims aren't on `PATH`. Use `mise exec -- <tool>` or `mise run <task>`. On dish's VM a bare `node` or `pnpm` is dish's own (`/opt/dish/node/bin`), not your project's: use `mise exec -- pnpm …`.
- Don't `rm -rf` build output before a build: the build replaces it, and a delete needs approval.
- There's no browser and no `xmllint`. Say what you couldn't check.
```

### `plugins/prompts/defaults/main.md`

In **Delegate**, the bullet "Give every delegate a self-contained brief: …" is replaced, and three bullets are added. In order, after "Keep for yourself: …":

```markdown
- Leave the task's builds, installs and commits to a coder (or ops, for machines and services). Run yourself only quick read-only checks, such as `git status`, `git log` or reading a file, and the steps your skills give you (a gate run to verify, a worktree, bringing commits onto the plan branch, a push): each command you run may wait for the user's approval.
- Give every delegate a short, self-contained brief. Open with the goal and the steps, the commits included. Then give the files or links that matter, the constraints, and what done looks like. Point to the spec or plan instead of pasting all of it. Children can't see this conversation, and the judge reads a child's brief to decide which of its commands serve its task.
- After you delegate, end your turn. You're notified when each child finishes, so don't poll. Keep answering the user meanwhile.
- A child's `send_message` is a question or a heads-up, never its report. When one says the work is done, wait for the child's finished notice, which carries the report.
- A child can't approve its own install. When a child reports an install it couldn't run, run that exact command yourself, in the same `workdir`, escalated, so the user can approve it; then send the child on with `delegate` and `to`, saying the command ran.
```

(The "After you delegate" bullet is the existing one, unchanged; it is shown for the order.) In **Decide and record**, a bullet goes first:

```markdown
- The user is away only when they've said so. Until then, a question you asked waits for their answer: end your turn instead of answering it yourself.
```

### `plugins/prompts/defaults/crew/coder.md`

After "Read the task and the files it names …":

```markdown
- Change files with `write` and `edit`, not heredocs, `sed -i` or `echo >`. `read` a file before you `edit` it: `edit` refuses a file you've only seen through `cat`.
```

Only the coder gets it, as approved. The architect, the writer and ops also have `write` and `edit`: see the follow-ups.

## `{{model}}` (`dish-prompts`)

`plugins/prompts/src/persona.ts`, the listener:
- **Today** it patches the persona sections, interpolating from the assembly it was given, and then returns `next()`. That assembly's `model` is dsh-agent-loop's provider, `agent.options.model`: the global default when the agent was created or resumed. dsh-agent's model-selection listener replaces `model` and `provider` with the session's selection **after** its own `next()`, so the persona never sees it.
- **After:** `const result = await next()`, then `applyPersona(result, …)`, interpolating from `result.variables`, and `return result`. It's registered with `{ prepend: true }`, so it runs ahead of every listener registered without `prepend`, the selection's among them, and its `next()` returns after the selection's listener has run, whatever order the preset and the agent were set up in (see [Notes from the build](#notes-from-the-build)). dsh's own `dsh-session-reference` reads the selected model the same way.
- Everything else is unchanged: a step never fails because of the row, an assembly without an agent is passed through, the failure paths (no service, a snapshot that fails, a section it can't patch) still call `next()` exactly once, and a child's prefix is still rendered leniently.
- **Children** have no selection listener: their `model` stays `options.model`, which is crew's route model. That is already right.
- The preview calls `applyPersona` itself, without the listener, and is unaffected. `{{provider}}` follows the selection too.

## Crew with any main model (`dish-crew`)

`plugins/crew/src/models.ts`:
- `VENDORS` gains six rows. Tokens are matched as today (`TOKEN_BREAK`, every token, lower case):
  - `['alibaba', /^(?:alibaba$|qwen|qwq)/]`
  - `['deepseek', /^deepseek/]`
  - `['moonshot', /^(?:moonshot|kimi)/]`
  - `['zhipu', /^(?:zhipu$|glm|chatglm)/]`
  - `['meta', /^(?:meta$|llama)/]`
  - `['mistral', /^(?:mistral|mixtral|codestral|devstral|magistral|ministral|pixtral)/]`
- `avoided()`: where it returns `can't tell the family of model …` today (a model no family lists, whose id names no vendor, and no family given), it goes on instead. The work's label is the model id (`truncate`), its names and vendors are empty, and `excludes` is false for every family.
- `familyOf` keeps its meaning (`undefined` for a model with no vendor and no list). The header comment says the new rule.
- **Unchanged:** a known vendor's or a listed model's exclusions; an override is accepted only outside what the work excludes; a follow-up to a reviewer is re-checked against the main model as it is now; `reviews: "main"` with no model to read is still refused. So the fix-round ladder of `subagent-driven-development` (round 4's strong-tier coder, the final reviewer with `model` set to the strongest of its family) works with a qwen main agent.

## Non-goals

- Lowering `servesTask`, or changing the gate's questions or thresholds.
- Reading the task from a projection instead of `snapshotEvents` (already on the roadmap's backlog).
- Removing dsh's return note from a child's task ([Questions](#questions-for-you), 2).
- Everything in **Follow-ups**.

## Follow-ups (not in this branch)

- **VM tools, in fleet** (rec. 10): `libxml2-utils` and a headless chromium; a Node LTS and pnpm preinstalled with mise; a way to preview dev servers (B10). "This machine" changes when they land.
- **Preview ports** for `mise run preview` from your browser.
- **A placeholder key for `selfie`** (rec. 11), so a first turn and the title generator work: your model config, not dish's code.
- **dsh issues to file** (rec. 12), as corrected by the checks:
  - a keyless provider fails the first turn, and the title is never retried (D17);
  - no extra writable roots (`dsh-sandbox-policy` README: "extra writable roots are not part of `SandboxExecutionPolicy`");
  - a message typed mid-turn waits for the whole turn while child notices are spliced in (D16);
  - the child's return note can't be turned off (only shadowed);
  - dropped: `{{model}}` (dsh's own sections get the selection; dish's row read too early) and "EROFS lacks the marker" (dsh marks it; the agent's `2>&1 | tail` hid it).
- **Your Astro project** (rec. 13): the pnpm store in `astroapp/.mise/`, the commit hash in the spec (`9450db1`), the invented RSS email.
- **Two approvals for one escalated command?** For the main agent, the gate's own `ask` and then the tool's escalation request both look like they fall through to you (the answerer's `ask` row). The rollout checks it with one `mise install`; if it asks twice, the answerer could let your yes to the gate's ask cover that call's escalation.
- **A no-op escalation reads as one.** The GPT reviewer sent `sandbox_permissions: "workspace-write"` (its mode already) on 9 calls. dsh ignores it (`dsh-tool-bash` `lib/index.js:238`), but the gate puts the escalation question to the judge. The gate could drop a `sandbox_permissions` equal to the session's mode.
- **The `write`/`edit` bullet** for the architect, the writer and ops, which also edit files.
- **Crew's own `send_message`** (question 2, option A), after 6b merges, so that dsh's "send your result" note isn't appended to children.
- **A headless browser and `libxml2-utils` on the VM**, and **a way to open an agent's dev server from your browser** (a second `tailscale serve` port to a fixed local port, named in `common.md`). Both are asked for in the roadmap's backlog; the first is the VM-tools item above, the second the preview-ports item.

## Questions for you

1. **The main agent's task is wider than "first plus latest".** In this session the first prompt was "hello!" (sent twice), so first plus latest would still have missed the request. *Recommendation:* the rule in decision 1 (the first, then the newest back to 8,000 characters), which is planned.
2. **Duplicate summaries.** The note dsh adds to a child's task ("Before you finish, send your result to that agent with send_message …") is added only when the child's `send_message` is dsh's own tool, by an identity marker. Three ways:
   - **A.** Crew shadows `send_message` with its own unmarked tool (same arguments, the same `ctx.subagents.sendMessage`), and its closing note gives the parent's id. dsh's note goes away at its source. It means a tool, a change to the generated dish preset, and `delegate.ts`'s note, which 6b is changing.
   - **B.** Lower the report guard's default `messageLimit` from 1,200 to 600 characters. In this session it would have refused the 810- and 764-character summaries (the researcher's, which woke the main agent early), and let through the 241-character one and coder #1's 303-character question. A refused question goes into the closing message, as today.
   - **C.** `main.md`'s new rule only: the main agent waits for the finished notice.

   *Recommendation:* C (planned) and B now (Task 5, which runs only if you say yes), and A as a follow-up after 6b merges.

   *Outcome:* C is built. B (Task 5) did not run and is not done: say so if you want it. A is on the roadmap's backlog.

## Notes from the build

What differed from the spec as it was first written; the sections above now say the shipped thing.

- **Task 5 did not run** (see the status line). The report guard's `messageLimit` is still 1,200.
- **The judge's task** (Task 1's review):
  - The messages between the first and the newest are clipped to `MAX_MIDDLE_CHARS` (1,000), not 4,000. A trivial first prompt followed by the request and two long pastes pushed the request out of the task; clipped to 1,000, it stays in.
  - A child's later typed prompt (`source.kind: 'user'`) counts as an instruction only with a string `rpcId`, which dsh's `subagent.prompt` gives it; dsh's auto-review reads a human instruction the same way. Without one it isn't something a person typed.
  - The bound sentence was one separator short: a task is at most `MAX_TASK_CHARS` plus a gap line and two separators.
- **The prompt texts** (Task 2's review changed the texts in [The prompt texts](#the-prompt-texts), which now show what shipped):
  - `main.md` runs the steps its skills give the main agent (a gate run to verify, a worktree, bringing commits onto the plan branch, a push) itself, and keeps only the task's builds, installs and commits for a coder or ops. The carve-out was added so the main agent isn't told to delegate what a skill tells it to run.
  - A child's install report names the command and its `workdir`. The main agent runs it in that `workdir`, then resumes the child with `delegate` and `to`, saying the command ran.
  - The rule on hiding output is wider than `2>&1 | tail`: no `2>&1`, `2>/dev/null` or pipe into `tail` or `head`, because dsh already shows stderr and keeps the tail of long output.
  - `workdir` or `git -C`, not a `cd` that is expected to carry over.
  - The full path `sudo /usr/local/sbin/dish-apt-get`, which fails inside the sandbox too.
  - A bare `node` or `pnpm` on the VM is dish's own (`/opt/dish/node/bin`), so a project's is `mise exec -- pnpm …`.
  - Scratch files go only in a git-ignored directory of the workspace (`.worktrees/` when `git check-ignore -q .worktrees` succeeds), and are never committed.
- **The persona row** (Task 3): it is registered with `prepend: true` and calls `next()` once, as specified. A prepend listener registered before the row runs inside it, so the row is not outermost; what it does is run ahead of every listener registered without `prepend`, dsh-agent's model selection among them. That is what makes `{{model}}` right, and [the prompts spec](prompts.md#the-persona-row-dish-promptspersona) says it that way. `{{model}}` also changes mid-chat when you switch models: the prompt is assembled on every step.
- **Crew's alias risk** (Task 4): a model that `crew.yaml` doesn't list and whose id names no known vendor is its own family. Two sentences in the crew spec that said such a model can never get a same-vendor reviewer were reworded: an alias that hides its vendor can. Listing it in a family in `crew.yaml` closes that.

## Checks (2026-10-02)

Read in dsh 0.2.0-rc.2's shipped `lib/` files under `node_modules/.pnpm/@deepseek-ai+<package>@0.2.0-rc.2_*/node_modules/@deepseek-ai/<package>/`. Paths below are from there.

- **The escalation parameter is `sandbox_permissions`, with `justification`.**
  - `dsh-tool-bash/lib/index.js:513-523`: `sandbox_permissions`, a string with `enum: ESCALATION_TARGETS`, described as "The narrowest wider sandbox mode for a one-shot retry of the exact command the sandbox just denied; the retry asks the user for approval."; `justification`, "Required with sandbox_permissions: one sentence for the user …". `command` and `description` are required (`:491-499`).
  - `dsh-sandbox/lib/index.js:42`: `ESCALATION_TARGETS = ["workspace-write", "danger-full-access"]`. From `workspace-write`, only `danger-full-access` is wider, so the report's guess was right.
  - `dsh-tool-bash/lib/index.js:238`: a `sandbox_permissions` equal to the call's mode is a no-op, with no justification needed.
  - `dsh-sandbox/lib/index.js:99-123` (`approveEscalation`): the request's reason is `escalate sandbox to <mode>: <justification>`; a refusal throws "the user rejected escalating this command to …; it stays denied, so stop and explain instead of working around it" (`:118`).
  - `dsh-bash-sandbox/lib/index.js:68-74`: a call approved for `danger-full-access` runs plain `bash -c`, with no bwrap. That call only; the next is sandboxed again.
- **What the sandbox allows.** `dsh-sandbox-local/lib/index.js:30-38`: bwrap mounts `/` read-only and, for `workspace-write`, adds `--tmpfs /tmp` and a read-write bind of the workspace. So home is read-only, and each call gets an empty `/tmp` of its own. sudo can't raise privileges inside it (`NoNewPrivs: 1`, [ops spec, Checks](ops.md#checks-2026-10-02)), so `dish-apt-get` needs the escalation too. The `write` and `edit` tools may also write the host's `/tmp` (`dsh-sandbox/lib/index.js:166-173`), which `bash` doesn't see. No extra writable roots can be configured.
- **The denial marker needs stderr and an exit code.** `dsh-sandbox/lib/index.js:245-249` matches a non-zero exit and, in stderr only, bwrap's "read-only file system" (`dsh-sandbox-local/lib/index.js:207`). Then the result carries `[sandbox: file access denied under <mode> mode]` and the hint "retry this exact command once with sandbox_permissions … the approval prompt asks the user" (`dsh-sandbox/lib/index.js:64-78`). The session's `mise trust mise.toml 2>&1 | tail -2; mise install 2>&1 | tail -20; …; mise ls …` (main session, line 75) moved stderr and ended with exit 0, so no marker was shown: no `[sandbox:` appears in any of the six sessions.
- **Children and approvals.**
  - dsh pins every child to `never` (`dsh-subagent/lib/index.js:535`), and `never` is rejected before any answerer (`dsh-user-approval/lib/index.js:175`). Every child also reads "operations that require approval are rejected automatically … state the limitation in your reply" (`dsh-subagent/lib/index.js:487`).
  - dish-judge switches a crew child to `ask` when its parent is at `ask` (the VM's main agent is, and each child's log shows the switch right after dsh's `never`). Its answerer then approves a child's escalation only if the gate allowed that exact command with the escalation in view, and rejects everything else (`plugins/judge/src/answerer.ts:10-15`). The judge's live table reads an escalated `npm install` as partly irreversible, so a child's install is refused. Hence decision 5.
  - Roles with `bash` are the coder, the reviewer and ops; the architect, the researcher and the writer have none (`plugins/crew/defaults/crew.yaml`). The coder, ops, the architect and the writer have `write` and `edit`.
- **How a follow-up reaches a child, and who can send one.**
  - `delegate` with `to` calls `ctx.subagents.sendMessage` (`plugins/crew/src/delegate.ts:445`). With no `source`, dsh builds `createAgentMessage` (`dsh-subagent/lib/index.js:584-592`, used at `:1969-1970`): a first text block `Agent <sender id> sent a message: `, then the task, with `source: { kind: 'agent-message', form: 'relay', senderSessionId: <sender id> }`. The sender id is the live sender's, not the model's.
  - A child's header has `parentSession` (`dsh-subagent/lib/index.js:476`). Only the parent may send to a child: `authorizeLineage` throws "belongs to another parent session" otherwise (`:958`). dsh's own auto-review tells a parent's instruction the same way: `source.kind === "agent-message" && source.senderSessionId === parentSession` (`dsh-experimental-auto-review/lib/index.js:102-104`).
  - A `send_message` from the main agent produces the same message as a `delegate` follow-up. Both are the parent's, and both count.
  - The brief is queued with `source: { kind: "user" }` (`dsh-subagent/lib/index.js:1738-1742`), and its blocks are `[task, crew's CLOSING_NOTE, dsh's note]`. Crew's children are spawned, not forked, so `inheritedEventCount` is 0.
- **dsh's return note** (`dsh-subagent/lib/index.js:599-605`) is appended on `startContinuable` only (`:1738`), when `tools.get("send_message", <child>)` resolves to a tool carrying dsh's identity marker `Symbol.for("dsh.subagent.adjacentAgentSendMessageTool")`, which only `dsh-tool-subagent-control` sets. A scoped tool of the same name shadows it. There is no option to turn it off.
- **`{{model}}`.**
  - `dsh-agent-loop/lib/index.js:1564-1566` registers `provider`, `model` and `cwd` globally, from `agent.options` and the session header. These are the only variables dsh registers.
  - `agent.options.model` is the global default model when the agent was created or resumed (`dsh-api-session-controller/lib/index.js:460-461`), not the session's selection.
  - `dsh-agent/lib/index.js:166-180` (`installModelSelection`): an agent-scoped `system-prompt/assemble` listener returns `{ ...assembled, variables: { ...assembled.variables, provider, model } }` **after** `next()`, with the session's selection, which the step's request also uses. dsh's own sections are rendered after the waterfall, so they say the selected model.
  - dish's persona row interpolates before `next()` (`plugins/prompts/src/persona.ts:83`, `:175-194`), and is registered without `prepend` (`:219`). So it never saw the selection.
  - `dsh-session-reference/lib/index.js:457-467` reads `assembly.variables.model` after `next()`, prepended: the pattern decision 9 follows.
  - Registering `model` in dish was considered: a global registration throws (dsh-agent-loop owns the name); a preset-scoped one works but would re-derive the selection, web-only.
  - The prompt is assembled on every step (`dsh-agent-loop/lib/index.js:907`), so a model switch shows from the next step.
- **What pins the prompt texts.** `plugins/prompts/test/skills-mentioned.test.ts` (main.md's Skills section names exactly the skills offered to main; a crew prompt names no skill outside its `- Skills:` line, which comes before its `send_message` bullet; the `skill` house rule is under House rules and before the working-directory line), `preview.test.ts` (common.md ends with `Your working directory is ‹cwd›.`; no unknown variables), `roles.test.ts:203` (`{{cwd}}` is common.md's only variable) and `previous.test.ts` (the drift check). No dish-skills test reads the prompt texts.
- **Session numbers.** The duplicate summaries were 810 (architect), 764 (researcher) and 241 (coder #2) characters; coder #1's blocked question was 303. PATH inside the agents' shells, even under `mise exec`, was `/opt/dish/node/bin:/usr/local/bin:/usr/bin:/bin` (main session, line 118). The main agent's policy was `ask` (line 4).
