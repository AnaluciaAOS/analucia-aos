# Director entrypoint: how to write an order in this project

Read this file when the owner asks for work that has no order yet. You then act as `director` for that request: you write a **draft**, and nothing else. The executor entrypoint (`CLAUDE.md`, which holds only `@AGENTS.md`) is not changed.

## First step: say that you are the director

Run `node plugins/analucia/bin/aos.mjs role declare director --scope ".analucia/drafts/**"` once in this session. From the next message the plugin names the session `DIRECTOR` (an executor session is named `EJECUTOR <project>`); if the window shows another name, rename it to that one. The session of an outside advisor is not a role of the plugin: name it by hand `DT <topic>`.

## Where a draft goes

- `.analucia/drafts/ORD-NNNN.md` — the order.
- `.analucia/drafts/ORD-NNNN.json` — its verify file. **An order without its verify file is not placed.**

Write there and nowhere else. Never write `.analucia/orders/`, `.analucia/verify/` or `.analucia/director.lock`: the hook blocks it, and the tool writes them itself when the owner confirms.

## Steps

1. The next free ID and the drafts that wait: `node plugins/analucia/bin/aos.mjs drafts`. When the project has a code, the ID carries it (`<CODE>-NNNN`; `node plugins/analucia/bin/aos.mjs ids` prints the map); an old-prefix ID for a new order is refused.
2. Write the order: front matter (`id`, `title`, `kind`, `created`, `budget_max_minutes`, `budget_max_attempts`, `risk`: low or medium, `cost_effect`), the work, what is out of scope, and a `## Acceptance criteria` list. Format and allowed values: `plugins/analucia/core/ORDER_FORMAT.md`.
3. Write the verify file: `{"order": "ORD-NNNN", "checks": [{"name": "…", "run": "…", "expect_exit": 0}]}`. Each `run` is one bash command run from the project root (bash syntax, also on Windows). A check proves an acceptance criterion; it never ends a git range at a moving ref (use a commit SHA or `{order_commit}`). Template: `plugins/analucia/templates/verify-file.example.json`.
4. Write the start conditions with the order: the key `"preflight"` of the verify file is a list of checks with the same shape, meant to pass on the untouched tree (the tools, the files, the test baseline the order needs). Run `node plugins/analucia/bin/aos.mjs preflight <ID>` on the draft before asking the owner to place anything: an order whose preflight fails is not placed, and a failing preflight later stops `run start` without costing an attempt.
5. Check the draft: `node plugins/analucia/bin/aos.mjs drafts` prints `ready` or the reason for each one. Fix every reason.
6. Tell the owner, in one line, that an order waits: they double-click **FIRMAR** (`aos sign`), read the draft's title and type the confirmation. The tool then copies the draft to the protected paths, records its hashes in `director.lock` and admits it. You cannot confirm for them.

## Rules

- A data file of the owner (prices, costs, rates, expected values) has one writer, and an order never overwrites it without comparing first: name the writer in the order, and use `plugins/analucia/templates/owner-data-file.md` to say what each number means, where it comes from and its unit.
- An expected value says which rule must produce it: a control file carries, per item, the rule expected to win and the unit, not only the number.
- A control calls the function it controls: a guard, a check or a test of a computation builds its input with the same function the product uses, never with a copy; say so in the order and check it in its verify file.

- In a project that was already running, first look for the earlier record the work continues (`aos adopt` lists the folders of earlier records), declare it in the order with `continues:`, and write in the existing document or under `.analucia/`, never one more document next to the old ones; `node plugins/analucia/bin/aos.mjs docs check <ID>` in the verify file checks it.

- One order, one outcome that can be checked. Small orders are placed and signed sooner.
- Never start the work of a draft: the executor runs an order only after it is placed (`aos next` says what comes next).
- A placed order is not edited. To change it, write a new draft.
