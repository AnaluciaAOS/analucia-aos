# E_SUPERSEDED_NO_REF

Who acts: `director`

## What happened

A change to `superseded` has no `superseded_by`.

## What to do next

**Record the transition to superseded with payload.superseded_by set to the replacing record ID.** (director)

1. `node plugins/analucia/bin/aos.mjs event append --type order.state_changed --actor director --subject ORD-NNNN --payload '{"from":"<state>","to":"superseded","superseded_by":"ORD-MMMM"}'`.

## Patterns

- Use the `aos` commands for every state change; they apply the rules for you.

## Trade-offs

- None specific: the rule is cheap to follow and the check costs nothing at runtime.

## Gotchas

- Only states before delivery can be superseded.
