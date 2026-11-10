# E_BUDGET

Who acts: `director`

## What happened

`aos run start` was refused because the order already used `budget_max_attempts` runs. The refusal is logged as a `run.finished` with outcome `budget_exhausted` and `refused_start: true`.

## What to do next

**Decide what happens to the order (amend its budget or issue a new order); the executor stops.** (director)

1. Executor: stop and report; do not retry.
2. Director: read `aos history ORD-NNNN` and the evidence, then write an amendment (new budget or scope) or a new order.

## Patterns

- Activity without progress ends in `budget_exhausted` instead of looping (Q-58).

## Trade-offs

- A hard attempt limit can stop an order that was one fix away; that cost is accepted to prevent loops.

## Gotchas

- The order stays `queued`; it does not move by itself.
- Minutes over budget do not refuse anything: `run finish` only records `over_budget: true`.
