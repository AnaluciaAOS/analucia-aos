# E_NO_ACCEPTANCE

Who acts: `director`

## What happened

The order body has no `## Acceptance criteria` heading, or the section has no list item before the next heading.

## What to do next

**Add a ## Acceptance criteria section with at least one list item to the order.** (director)

1. Director: add the section (`- [ ] …` items); check with `node plugins/analucia/bin/aos.mjs validate`.

## Patterns

- Write criteria that a verify-file check can test.

## Trade-offs

- No criteria, no order: the cost is writing them first.

## Gotchas

- The heading text must match exactly, at level 2.
