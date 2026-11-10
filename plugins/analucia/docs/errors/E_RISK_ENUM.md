# E_RISK_ENUM

Who acts: `director`

## What happened

The order `risk` key is not one of the closed list `risk_levels` (SPEC-0003 §3–§4).

## What to do next

**Set risk in the order to low, medium or high (risk_levels in plugins/analucia/core/enums.json).** (director)

1. Director: fix the key (production, data, money and secrets are always `high`); check with `node plugins/analucia/bin/aos.mjs validate`.
2. Executor: report with outcome `needs_decision`; never edit the order.

## Patterns

- Choose by blast radius: low = docs and reversible tooling, medium = normal code, high = production, data, money, secrets.

## Trade-offs

- high costs a rollback plan and two verify samples; low lets the director close without the owner.

## Gotchas

- A pinned order without `risk` is treated as `high` (SPEC-0003 §7).
