# E_STATE_ENUM

Who acts: `executor`

## What happened

A value for `payload.from` or `payload.to` of `order.state_changed` is not in the closed list `order_states` of `plugins/analucia/core/enums.json`. Closed lists are enums: tooling rejects any other value, and free text belongs in `notes` or in payload fields that are not enums.

## What to do next

**Use one of the order_states values from plugins/analucia/core/enums.json and write the event again with aos event append.** (executor)

1. Read the allowed values: `node -e "console.log(require('./plugins/analucia/core/enums.json').order_states)"`.
2. Write the state change again with one of them (`node plugins/analucia/bin/aos.mjs event append … --payload '{…}'`).

## Patterns

- Copy the value from enums.json instead of typing it from memory.
- Put any nuance in a free-text payload field (`reason`, `note`), never in the enum field.

## Trade-offs

- A closed list makes reports and derivation reliable; adding a value needs a spec change by the director, which is slow on purpose.

## Gotchas

- Values are case-sensitive and use underscores (`needs_decision`, not `needs-decision`).
- Nothing was written: the log is unchanged.
