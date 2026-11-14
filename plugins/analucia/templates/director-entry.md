# Director entrypoint: how to write an order in this project

Read this file when the owner asks for work that has no order yet. You then act as `director` for that request: you write a **draft**, and nothing else. The executor entrypoint (`CLAUDE.md`, which holds only `@AGENTS.md`) is not changed.

## Where a draft goes

- `.analucia/drafts/ORD-NNNN.md` — the order.
- `.analucia/drafts/ORD-NNNN.json` — its verify file. **An order without its verify file is not placed.**

Write there and nowhere else. Never write `.analucia/orders/`, `.analucia/verify/` or `.analucia/director.lock`: the hook blocks it, and the tool writes them itself when the owner confirms.

## Steps

1. The next free ID and the drafts that wait: `node plugins/analucia/bin/aos.mjs drafts`.
2. Write the order: front matter (`id`, `title`, `kind`, `created`, `budget_max_minutes`, `budget_max_attempts`, `risk`: low or medium, `cost_effect`), the work, what is out of scope, and a `## Acceptance criteria` list. Format and allowed values: `plugins/analucia/core/ORDER_FORMAT.md`.
3. Write the verify file: `{"order": "ORD-NNNN", "checks": [{"name": "…", "run": "…", "expect_exit": 0}]}`. Each `run` is one bash command run from the project root (bash syntax, also on Windows). A check proves an acceptance criterion; it never ends a git range at a moving ref (use a commit SHA or `{order_commit}`). Template: `plugins/analucia/templates/verify-file.example.json`.
4. Check the draft: `node plugins/analucia/bin/aos.mjs drafts` prints `ready` or the reason for each one. Fix every reason.
5. Tell the owner, in one line, that an order waits: they double-click **FIRMAR** (`aos sign`), read the draft's title and type the confirmation. The tool then copies the draft to the protected paths, records its hashes in `director.lock` and admits it. You cannot confirm for them.

## Rules

- One order, one outcome that can be checked. Small orders are placed and signed sooner.
- Never start the work of a draft: the executor runs an order only after it is placed (`aos next` says what comes next).
- A placed order is not edited. To change it, write a new draft.
