# Spec: fixes from the nsl session (2026-10-05)

Status: agreed 2026-10-06. The user took each recommendation below, as one pull request. It covers crew, the judge and the shipped prompts. There's no separate plan: the [tasks](#tasks) are short.

## What the session showed

A chat in `frostyard/nsl` began on 2026-10-03 with "do a read-only review of the documentation site", and the user ran `/permission read-only` for it. Two days later, in the same chat, the user asked it to bring pull request [frostyard/nsl#50](https://github.com/frostyard/nsl/pull/50) up to date with `main`. It couldn't, and the user updated and merged the PR by hand. Four things went wrong:

1. **The chat was still read-only.**
   - The coder the main agent delegated to inherited the read-only sandbox. It could write neither the worktree's files nor its git metadata (`.git/worktrees/…/ORIG_HEAD.lock`).
   - The main agent's runtime context said "file policy: read-only", but it didn't tell the user. It escalated one call at a time instead.
2. **The judge judged against the first request.**
   - A main agent's task always holds its first prompt ([friction decision 1](friction.md#decisions)), here "do a *read-only* review".
   - So committing the merge scored `serves_task` 0.29, then 0.27, under the VM's 0.40 bar, and the gate asked.
3. **"Never" turned the gate's asks into false rejections.**
   - The user then set the chat to full access with approval policy **never**. With no one to ask, dsh rejected each ask within a millisecond.
   - dsh tells the agent "the user rejected tool bash", so the agent reported that the user had stopped it. The user hadn't.
4. **The pull request wasn't dish's.**
   - PR 50's branch, `docs/site-review-fixes`, was the user's own.
   - Agents' git can't push, and `open_pr` pushes only a run's branch, `dish/<slug>`. So even a committed merge could only have gone out as a second pull request.
   - The main agent planned to "update the pull request" without knowing that.

## Decisions

| # | Topic | Decision |
|---|---|---|
| 1 | `delegate` in a read-only chat | When the delegating agent's sandbox mode is `read-only`, `delegate` refuses a role with `writes: true` in `crew.yaml` (today the architect, coder, writer and ops). That covers a new child and a follow-up to one (`to`). Read-only roles still run. The refusal says why and how to fix it (below). Nothing starts. A child keeps the sandbox mode it started with: dsh copies the parent's mode once, at start. So a follow-up to a writing child that started read-only is refused too, even after the chat switches, with the advice to delegate a new one. |
| 2 | The main agent and a read-only chat | `main.md` gains one bullet: when the chat is read-only and the user asks for a change, say so before starting, and how to switch (`/permission workspace-write`). |
| 3 | The judge's view of a main agent's task | The newest prompt is the request. The earlier ones, the first included, go along as context. The task text labels them: `Earlier in this chat:` above the earlier ones (with the gap line, as now), and `Your user's latest request:` above the newest. With one prompt, it's that prompt alone, as now. The serves-task question names the latest request and says an earlier one doesn't rule out what a later one asks for. A child's task (its brief and latest instruction) doesn't change. |
| 4 | Approval policy `never` | For a top-level agent whose effective approval policy is `never`, the command gate never answers `ask`: no one would see it. It decides alone. It **allows** what passes the effect bar (read-only, or reversible enough), whatever `serves_task` says. It **refuses** the rest with the judge's reason, worded for the main agent: the chat's approval policy is never, so there's no one to ask; tell your user, who can run it or set the policy back to ask. An unavailable judge, and a command it can't read (opaque), are refused the same way instead of asked. Under `ask`, nothing changes. |
| 5 | A pull request dish didn't open | `main.md` gains one bullet. dish updates only the pull requests it opened, whose branch is a run's `dish/<slug>`. For one opened elsewhere, say so before starting. It can bring the changes into a new run and open a new pull request, or leave the push to the user. Pushing to a branch dish didn't open goes to ROADMAP's backlog, next to PR watching (step 9). |
| 6 | Upgrading stored prompts | `plugins/prompts/defaults/previous.json` is regenerated the documented way, so a `main.md` that is still the previous default is replaced at the next start. |

**The refusal's text (decision 1):**

> This chat is read-only (`/permission read-only`), so <a role> couldn't write its worktree. Ask your user to switch the chat to workspace-write (`/permission workspace-write`), then delegate again. Read-only roles (researcher, reviewer) still run.

Its first sentence names the role. The read-only roles listed are the ones `crew.yaml` gives `writes: false`.

**A follow-up to a child that started read-only:**

> This coder started while the chat was read-only, and keeps that sandbox: it can't write its worktree. Delegate a new coder (without `to`) instead.

## Tasks

Each task is one commit with tests, run through `pnpm typecheck && pnpm test`. No two tasks edit the same file.

1. **crew** (`plugins/crew`): decision 1.
   - `delegate` reads the delegating agent's sandbox mode the way the judge's gate does (`sandboxPolicy`'s `resolve({ session }).mode`, through `ctx.get` on each call). An unknown mode is no refusal.
   - Tests: a writing role refused in a read-only chat, for a new child and for a follow-up; a read-only role started; workspace-write and full access unchanged; no `sandboxPolicy` means no refusal.
   - Docs: `docs/specs/crew.md` and `plugins/crew/README.md`.
2. **judge** (`plugins/judge`): decisions 3 and 4.
   - **Decision 3:** in `gate.ts`, `topLevelTask` labels the parts, and `SERVES_TASK_QUESTION` changes. The existing task tests change with it.
   - **Decision 4:** the gate reads the agent's effective policy as the approval answerer reads a parent's (`overrideOf(session) ?? config.policy ?? 'ask'`). `decideCommand` turns each top-level `ask` into allow or deny when it's `never`.
   - **Tests:** the labelled task; each `never` case (allowed off-task when reversible, refused when not, unavailable, opaque); `ask` unchanged; a child unchanged.
   - **Docs:** `docs/specs/judge.md` (the command gate) and `plugins/judge/README.md`.
3. **prompts** (`plugins/prompts`): decisions 2, 5 and 6.
   - Two bullets in `main.md`, within the 9 KiB cap.
   - `previous.json` regenerated.
   - A test that pins both bullets.
   - `docs/specs/prompts.md`'s Defaults row for main.

The controller adds the backlog row to `ROADMAP.md`, and after the merge updates `HANDOFF.md` and adds this spec's Notes from the build. Nothing needs fleet. The change needs a deploy, which is the user's.
