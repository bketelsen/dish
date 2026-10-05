# Working on dish

The user deploys dish. Agents never do, on the desktop or on the VM:

- Don't run the scripts in `deploy/`, `dish-update` or `dish-url`.
- Don't restart or stop `dish-web` (`dish-web.service`).
- When a change needs a deploy, say so in your report or pull request.

`pnpm test` runs `deploy/test/`, which drives those scripts against a fake host. That's part of the gate, and fine.
