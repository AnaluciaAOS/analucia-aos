# E_ROLES

Who acts: `director`

## What happened

`aos check-roles` (or `agents-md sync`) found: no analucia block, a duplicated or broken block, a block that differs from the plugin rules, a CLAUDE.md without `@AGENTS.md`, or director instructions in CLAUDE.md.

## What to do next

**Run aos agents-md sync and keep CLAUDE.md to the line @AGENTS.md, with director instructions moved to the director entrypoint.** (director)

1. `node plugins/analucia/bin/aos.mjs agents-md sync` (rewrites only the analucia block).
2. Duplicated block: delete the extra copy by hand, then sync.
3. Then `node plugins/analucia/bin/aos.mjs check-roles` must exit 0.

## Patterns

- Project rules go outside the analucia block; foreign blocks (e.g. Next.js) are kept.

## Trade-offs

- Editing inside the block is lost on the next sync.

## Gotchas

- Any line mentioning "director" in CLAUDE.md fails the check.
