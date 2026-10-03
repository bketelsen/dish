---
name: changing-infrastructure
description: Use when you're asked to inspect or change a machine, container, VM, service, network, or their configuration.
metadata:
  roles: [ops]
---

# Changing infrastructure

Look before you touch, change as little as you can, and make every change undoable. Infrastructure is shared, so a mistake reaches people who never saw the task. Nothing that can't be taken back runs until the main agent has seen the exact command.

## When to use

Not for application code in a repo, which is a coder's task, unless that repo is the GitOps definition of the infrastructure.

## Steps

1. Look first. Read the config, the status and the recent logs: the service manager's status, the journal, the container or VM list, the health endpoint. Say what you found before proposing anything.
2. Find where it's defined. If a GitOps repo defines it (the homelab's is `fleet`), change it there: commit on a branch and hand back the diff. Don't push: in a registered project, the main agent opens the pull request with `open_pr`; elsewhere the user pushes. The apply waits for the main agent's go-ahead. Humans merge. Don't hand-edit the machine instead: it drifts from the repo, and the next apply undoes it.
3. Plan the smallest change that does the job, and how you'd undo it. Use a dry run or a diff when the tool has one.
4. Back up before you change: copy a file before editing it, export a config, snapshot a VM before a large change.
5. Before anything irreversible or disruptive, stop. That means deleting data, restarting a shared service, changing access, the firewall or DNS, or rebooting. Report the exact command, what it affects and how to undo it, and don't run it until the main agent tells you to.
6. Make the change, one step at a time, checking each.
7. Verify. Show the status, health check or output that proves it worked, next to what you saw in step 1. For a GitOps change, verify what you can before the apply (the repo's checks, a dry run) and say what to check after it. If it didn't work, undo it, then debug (load `systematic-debugging`).

## Secrets

- Never put a secret in a repo, a commit, a log, a command line others can see, or your report.
- Never print one: no `env`, no `printenv`, no reading a credentials file, no shell tracing around one.
- If a change needs a secret, say which and where it belongs, and leave it for a human to put there.
- If you find one exposed, say where it is, not what it is.

## Rules

- Read-only commands first. Anything that writes is a change.
- No `--force`, `-y` or other skip-the-question flags on anything destructive.
- Don't fix what you weren't asked to. Note it in your report.
- If you're blocked or need a decision, ask the main agent with `send_message`.

## Hand back

What you found, what you changed (files, commands, commits), how you verified it (the output), and how to undo it. Anything left for a human, with the exact command.
