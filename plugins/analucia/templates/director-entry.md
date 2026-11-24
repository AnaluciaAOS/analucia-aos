# Director entrypoint: how to write an order in this project

Read this file when the owner asks for work that has no order yet. You then act as `director` for that request: you write a **draft**, and nothing else. The executor entrypoint (`CLAUDE.md`, which holds only `@AGENTS.md`) is not changed.

## First step: say that you are the director

Run `node plugins/analucia/bin/aos.mjs role declare director --scope ".analucia/drafts/**"` once in this session. From the next message the plugin names the session `DIRECTOR <project code or folder name>` (an executor session is named `EJECUTOR <project>`); if the window shows another name, rename it to that one. The session of an outside advisor is not a role of the plugin: name it by hand `DT <topic>`.

**Answer from the state, not from memory.** Before you answer anything about the state of the project (what waits, what is closed, where `main` is), run `node plugins/analucia/bin/aos.mjs status --director` and answer from what it prints. A session declared director runs it by itself when it starts or resumes.

## Where a draft goes

- **Name a draft by its topic, never by a number:** `.analucia/drafts/draft-<topic>.md` (lowercase letters, digits and dashes, for example `draft-banner-buscador`) is the order. Wherever the order needs its own ID (front matter `id: {id}`, the `order` of the verify file, evidence paths, the commit trailer, the branch name) write `{id}`: the number is given when the draft is placed, as the next free one, so numbers follow the real order. A decision of the owner before the number is recorded with `aos decision record --draft <topic> --text "…"`. A draft already named `ORD-NNNN` is still placed, with a warning.
- `.analucia/drafts/draft-<topic>.json` — its verify file. **An order without its verify file is not placed.**
- `.analucia/drafts/draft-<topic>.request.md` — the owner's request, one list line per point: `- <point> => <the part of the draft that answers it>` or `- <point> => left out: <why>`. `aos drafts` refuses a draft without it. Write the key `base:` (the commit you wrote on) and `assumes:` (`file:`, `command:`, `service:` the order takes as existing) when they apply; never ask the owner to paste, type or send a key, token, password or secret.

Write there and nowhere else. Never write `.analucia/orders/`, `.analucia/verify/` or `.analucia/director.lock`: the hook blocks it, and the tool writes them itself when the owner confirms.

## Steps

1. The drafts that wait, and the ID each ready one would get now (not yet given): `node plugins/analucia/bin/aos.mjs drafts`. When the project has a code, the ID carries it (`<CODE>-NNNN`; `node plugins/analucia/bin/aos.mjs ids` prints the map). The order in which queued orders run is yours to set: `node plugins/analucia/bin/aos.mjs queue set <ID> <ID> …` (an order not in it runs after, in the order of admission).
2. Write the order: front matter (`id`, `title`, `kind`, `created`, `budget_max_minutes`, `budget_max_attempts`, `risk`: low or medium, `cost_effect`), the work, what is out of scope, and a `## Acceptance criteria` list. Format and allowed values: `plugins/analucia/core/ORDER_FORMAT.md`.
3. Write the verify file: `{"order": "{id}", "checks": [{"name": "…", "run": "…", "expect_exit": 0}]}`. Each `run` is one bash command run from the project root (bash syntax, also on Windows). A check proves an acceptance criterion; it never ends a git range at a moving ref (use a commit SHA or `{order_commit}`). Template: `plugins/analucia/templates/verify-file.example.json`.
4. Write the start conditions with the order: the key `"preflight"` of the verify file is a list of checks with the same shape, meant to pass on the untouched tree (the tools, the files, the test baseline the order needs). Run `node plugins/analucia/bin/aos.mjs preflight <ID>` on the draft before asking the owner to place anything: an order whose preflight fails is not placed, and a failing preflight later stops `run start` without costing an attempt.
5. Check the draft: `node plugins/analucia/bin/aos.mjs drafts` prints `ready` or the reason for each one. Fix every reason. Then **try each check before placing**: `node plugins/analucia/bin/aos.mjs drafts --try <topic>` says, per check, whether its command parses, whether its patterns compile, and what the ones that need neither the order's commit nor its report give on the real tree (pass, fail, cannot run yet). Fix every check marked `FIX` (its own text cannot pass) and every failing `preflight` check.
6. Tell the owner, in one line, that an order waits: they double-click **FIRMAR** (`aos sign`), read the draft's title and type the confirmation. The tool then copies the draft to the protected paths, records its hashes in `director.lock` and admits it. You cannot confirm for them.

## No confirmation without material risk

> A decision the owner has approved becomes an instruction that can be executed and goes to the executor without a new confirmation. Ask only in two cases: a material technical risk (loss of data, something that cannot be undone, a secret, money, a change the public sees) or a real contradiction with a spec or with another approved decision. Then ask once, with the evidence and two options. A doubt that a default settles is settled by the default and said in one line, not asked.

The owner is still never asked more than three things in one answer.

## Rules

- **The STOP of the owner wins.** An instruction of the owner to stop or to go on is obeyed at once. On a stop the agent ends what it is doing, starts nothing new and says in one line what is left open. An agent that cannot do what the owner asks says why in one line and stops; it does not go on with its own plan. A prompt that is only `STOP`, `ALTO`, `DETENER` or `PARA` (any case, with or without punctuation around it) halts the project: every session only reads, and only the owner resumes it, with REANUDAR. A longer prompt that starts with one of those words (`para qué sirve…`) is an ordinary prompt: no halt, no record. A prompt that is only `AVANZA` is recorded and means: run `aos next` and do what it says, with no question unless there is a material technical risk.

- One gate per order, at the signature: a document or a result the owner must look at is asked with `aos review request` and the work goes on to `done`. An order stops for the owner in the middle only for a material technical risk, and then the order says where and why; anything else waits for the signature, where FIRMAR shows all the reviews of the order together.

- In a verify file, mark `"class": "form"` only on a check that does not change what was built or how safely: a trailer on a commit that touches only evidence, a label or a heading of the report, the name of the branch the signature is made from. The work, the tests, the log, secrets, the protected paths and the allowed paths are substance and never carry the class: the owner can waive a failed check of form at the signature, and nothing else.

- One session per order or per role: a long session is ended and a new one starts from `.analucia/views/resume.md`, which is the handoff on disk; a session kept open for hours spends the weekly limit of use on reading its own history.

- A rule of the business enters an order only in its section `## Business rules`, one list item per rule, each with one example with numbers and the question it answers ("for a cost of 8 and a reference price of 20 the price is 22"); an order with none writes `- none`. An explanation or an example of the owner is not a rule until he has confirmed it there: he sees every rule in FIRMAR before he types the confirmation, and the placement records them.

- A document for the owner (a plan, a design, a proposal) uses the template `plugins/analucia/templates/owner-review-doc.md`: business language, one example with numbers for every rule, and a last section `## Decisiones`; nothing the owner needs to decide is left "out of scope" without asking him: it goes there, as a question with its options.

- An executor needs no prompt: a placed order reaches it through `aos next`. When a prompt for an executor is needed at all, its first line is `Project: <code or folder name>`, so that it is never carried out in another project (the prompt hook warns the session when the project, or an order it names, is not this one).

- An order that builds a screen or a module lists what it replaces and what is deleted in its key `replaces:` (an inline list of paths; `replaces: []` when it replaces nothing), and its verify file runs `node plugins/analucia/bin/aos.mjs replaced check <ID>`: the new thing is not built next to the old one.
- The lines a report must carry go in `report_lines`, not in hand-written `grep` checks: the top-level key `report_lines` of the verify file, a list of `{"name": "…", "pattern": "<regular expression of one line>"}`. The executor sees them with `aos report template <ID>`, `aos run finish --outcome done` refuses while one is missing, and `aos verify` tries each as a check of form.
- The trailer of the commits is checked in a verify file with `aos trailer check <ID> --from <commit>` and never with a check written by hand: it is the rule of the push guard, by the same function (a commit that touches only the log, the evidence or the director paths needs no trailer).
- A data file of the owner (prices, costs, rates, expected values) has one writer, and an order never overwrites it without comparing first: name the writer in the order, and use `plugins/analucia/templates/owner-data-file.md` to say what each number means, where it comes from and its unit.
- An expected value says which rule must produce it: a control file carries, per item, the rule expected to win and the unit, not only the number.
- An order that copies real data lists the backups that are kept and the ones that may be deleted; nothing else is deleted. The executor records each copy with `aos scratch add <ID> --path <folder> [--pid <n>]`, and the verify file of the order runs `aos scratch check <ID>`.
- A control calls the function it controls: a guard, a check or a test of a computation builds its input with the same function the product uses, never with a copy; say so in the order and check it in its verify file.
- An order that promises something the owner will **see** on the published site lists it in `promises: [...]`, and its verify file runs one `node plugins/analucia/bin/aos.mjs live check <published address> --expect "<what he will see>" [--total <n> --base <n>]` per promise: the page is read, and a "not available" placeholder fails (add `--placeholder-ok` only when the order says a placeholder is expected). Nobody says "connected" without that check passing; `aos drafts` refuses a draft with promises and no check.
- An order of kind `build` or `ux` that adds or changes screens lists them in `screens: [<published address>|<button>|<button>, …]`, and its verify file runs `node plugins/analucia/bin/aos.mjs smoke check <ID>`: the executor presses each new button on the published site, saves a screenshot in the evidence folder and writes one line per button in `smoke.md`.
- The verify file of every order that has tests runs `node plugins/analucia/bin/aos.mjs tests compare <ID>` ("not worse than before": a test that passed in the baseline and fails now fails the check, wherever it is). The preflight records the baseline by itself when `project.json` has `"tests": {"command": "…", "report": "tap" | "junit:<path>"}`.
- A test that fails once and then passes is named: `node plugins/analucia/bin/aos.mjs tests run <ID>` runs the tests, runs them again when one fails, records every test that failed in `.analucia/evidence/<ID>/tests-run.json` and lists the unsteady ones; any unsteady test fails the run unless you accepted it in `.analucia/flaky.txt` (one line each: `<test name> | <reason>`).
- `aos admit` and `aos drafts` run the release list of forbidden names over the order, its verify file, its rollback plan and its request file, tracked or not, and refuse with the file and line (`E_DENYLIST_FILE`), never the word.
- A text check of a verify file is `node plugins/analucia/bin/aos.mjs text has <file> "<text>"` (or `text lacks`, with `-i` to ignore case), never `grep` over text with accents or non-ASCII letters: `aos validate` refuses it (`E_GREP_NON_ASCII`).

- In a project that was already running, first look for the earlier record the work continues (`aos adopt` lists the folders of earlier records), declare it in the order with `continues:`, and write in the existing document or under `.analucia/`, never one more document next to the old ones; `node plugins/analucia/bin/aos.mjs docs check <ID>` in the verify file checks it.

- One order, one outcome that can be checked. Small orders are placed and signed sooner.
- One director per project: the order of another project is written by the director of that project, in a session opened there (the plugin refuses a write inside the `.analucia/` folder of another project, `E_OTHER_PROJECT`).
- Never start the work of a draft: the executor runs an order only after it is placed (`aos next` says what comes next).
- A placed order is not edited. To change it, write a new draft.
