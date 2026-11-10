# E_TRANSITION

Who acts: `executor`

## What happened

A state change or lifecycle command is not allowed now: the transition is not drawn in SPEC-0001 §4 / SPEC-0002 §3, `from` is not the current state, the actor may not make it (`closed` = owner, `verified` = system), `delivered` lacks a `done` run, `blocked` lacks a reason, or a run is not open.

## What to do next

**Read the order state with aos history ORD-NNNN and use the command or transition allowed from that state.** (executor)

1. See the state: `node plugins/analucia/bin/aos.mjs history ORD-NNNN` or `node plugins/analucia/bin/aos.mjs derive` then `.analucia/views/resume.md`.
2. `run start` needs `queued`; `run finish` needs an open run; `verify` moves only `delivered`; `close` needs `verified`.
3. Nothing was written: fix the command and run it again.

## Patterns

- Use the lifecycle commands instead of raw `event append`; they choose valid transitions.

## Trade-offs

- Refusing illegal moves can feel rigid; it keeps executed ≠ delivered ≠ closed.

## Gotchas

- Rejected, superseded and cancelled are reachable only before delivery.
