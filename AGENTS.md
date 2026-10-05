# Working on dish

The user deploys dish. Agents deploy it only when the user asks, on the desktop or on the VM:

- Unless asked, don't run the scripts in `deploy/`, `dish-update` or `dish-url`, and don't restart or stop `dish-web` (`dish-web.service`).
- When a change needs a deploy, say so in your report or pull request.

`pnpm test` runs `deploy/test/`, which drives those scripts against a fake host. That's part of the gate, and fine.
