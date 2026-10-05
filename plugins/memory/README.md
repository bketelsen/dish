# dish-memory

Memory and direction for dish's agents:
- **the vault,** a bare git repository of user and family memories, in Claude Code's format;
- **each family's direction,** `families/<family>/direction.md` in the config store;
- **the `dish-memory` message,** delivered the way dsh delivers `AGENTS.md`, with `remember`, `forget` and `recall`;
- **Settings → Memory.**

The design is in the [spec](../../docs/specs/memory.md) and the [plan](../../docs/plans/2026-10-05-memory.md). This README is a stub until the plan's last task.

## Build

```sh
pnpm --filter dish-memory build    # src/client → lib/client.js (the Memory page)
```
