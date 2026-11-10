# E_WIP_LIMIT

Who acts: `executor`

## What happened

Entering `active` would exceed `wip_limit` of `.analucia/project.json` (default 1).

## What to do next

**Finish the active order first with aos run finish, or wait; only the owner raises wip_limit.** (executor)

1. See the active order: `node plugins/analucia/bin/aos.mjs derive`, then `.analucia/views/resume.md`.
2. Finish it: `node plugins/analucia/bin/aos.mjs run finish ORD-NNNN --outcome <o> --evidence <report>`.

## Patterns

- One active order at a time keeps evidence attributable.

## Trade-offs

- Lower throughput, higher focus.

## Gotchas

- `blocked` and `paused` orders do not count.
