# E_COST_EFFECT_ENUM

Who acts: `director`

## What happened

The order `cost_effect` (a value or an inline list) holds a value outside the closed list `cost_effects`, or the list is empty.

## What to do next

**Set cost_effect to one or more of none, build, deploy, service, data (cost_effects in plugins/analucia/core/enums.json).** (director)

1. Director: fix the key, for example `cost_effect: [build, deploy]`; check with `node plugins/analucia/bin/aos.mjs validate`.

## Patterns

- Use `none` for orders that change no paid resource.

## Trade-offs

- None specific: the rule is cheap to follow and the check costs nothing at runtime.

## Gotchas

- An empty list `[]` is rejected; write `none`.
