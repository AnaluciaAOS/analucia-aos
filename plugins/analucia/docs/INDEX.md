analucia docs for plugin version 0.5.0

# Analucia AOS docs — plugin `analucia` 0.5.0

Read the docs of this version, not what you remember. Run commands as `node plugins/analucia/bin/aos.mjs <command>` from the repo root.

## Specifications

- `core/NOMENCLATURE.md` — SPEC-0001 version 0.1.0
- `core/SPEC-0002-VERIFY-AND-GUARDS.md` — SPEC-0002 version 0.1.0
- `core/SPEC-0003-RULES-ERRORS-RISK-COST.md` — SPEC-0003 version 0.1.0
- `core/SPEC-0004-OWNER-SHEET-AND-SELF-GOVERNANCE.md` — SPEC-0004 version 0.1.0
- `core/SPEC-0005-ONBOARDING.md` — SPEC-0005 version 0.1.0
- `core/SPEC-0006-ADOPTION-AUDIT.md` — SPEC-0006 version 0.1.0
- `plugins/analucia/core/ORDER_FORMAT.md` — order file format and validator codes
- `plugins/analucia/core/enums.json` — every closed list (machine source)

## Commands

Every command the owner runs ends with exactly one closing line: `OK: <what is now true>` on success, or the error with its `next` line (ORD-0041 part 6). Commands read by a program or a hook (`check-writeback`, `hook …`, `next`, `check-push`) print no such line.

- `aos validate [path]` — any: check orders, verify files, director.lock, project.json and events.jsonl
- `aos event append --type <t> --actor <role> --subject <id> --payload <json>` — any: the low-level writer of the event log (prefer the lifecycle commands)
- `aos verify-log` — any: recompute the hash chain; names the first broken line
- `aos derive` — any: write .analucia/views/state.json and resume.md
- `aos history <ID>` — any: print the events of one record
- `aos run start ORD-NNNN` — executor: queued → active, run.started with the budget
- `aos run finish ORD-NNNN --outcome <o> --evidence <path>` — executor: run.finished + evidence; done → delivered, blocked/needs_decision → blocked, budget_exhausted/failed → queued
- `aos verify ORD-NNNN` — system (director runs it): director lock + verify-file checks; delivered → verified
- Verify files (director): a check never ends a git diff/log range at a moving ref (HEAD, a branch, origin/…); use a commit SHA or `{order_commit}`, which `aos verify` resolves to the newest commit with the trailer `Analucia-Order: ORD-NNNN` (E_MOVING_REF, E_NO_ORDER_COMMIT; ORD-0034). Template: `templates/verify-file.example.json`.
- `aos close ORD-NNNN [ORD-…]` — owner, own TTY: verified → closed after typing CLOSE
- `aos close ORD-NNNN --as director` — director, risk: low only: verified → closed without a TTY (SPEC-0003 §4)
- `aos ask open ASK-NNNN` — director: record.created + ask.opened for a locked .analucia/asks/ASK-NNNN.md (SPEC-0004 §1)
- `aos ceo export [--out <path>] [--locale en|es]` — any: write the owner sheet (.xlsx): How to use, Asks, Orders, States (SPEC-0004 §2)
- `aos ceo import [<path>]` — owner, own TTY (without a path it is asked in the window: IMPORTAR): record the sheet: ask decisions and close sign-offs, after typing CONFIRM; all-or-nothing
- `aos init [--locale en|pt|zh-Hans|hi|es] [--answers <file> [--dry-run]]` — owner, own TTY (dry run: anyone): guided onboarding: three moments, safe defaults, then the configuration of SPEC-0005 §4 after CONFIRM
- `aos init --hosting managed|own-server|"already: <where>"|later [--dry-run]` — owner, own TTY (dry run: anyone): change only the hosting answer: project.json hosting, a hosting.chosen event; the plan shows the dated cost table (AMD-0006)
- `aos init --check` — any: the setup checks of SPEC-0005 §5 (PASS/WARN/FAIL, each WARN/FAIL with next); records the inventory; saves .analucia/views/onboarding.md; exit 1 on any FAIL
- `aos permissions write` — owner or director: write .claude/settings.json: permission profile (allow / ask git push / deny force push) and the plugin enabled for this repo (SPEC-0004 §3, §7)
- `aos role declare director --scope "<paths>"` — director: role.declared with the director write scope (SPEC-0004 §6)
- `aos admit ORD-NNNN` — director: lists the open orders (addendum before new order, AMD-0007 §4), then record.created with version pins, draft → ready → queued (SPEC-0003 §5)
- `aos cost record --usd <n> --source "<text>" [--order ORD-NNNN] [--month YYYY-MM]` — director (or owner): log a cost; threshold alerts at 50/80/100% inform the owner and never block
- `aos cost status [--month YYYY-MM]` — any: budget, spend, percent, alerts and cost per closed order
- `aos halt --reason "<text>" / aos resume` — owner, own TTY: the off switch (.analucia/HALT); without --reason, at a terminal, the reason is asked in the window (DETENER)
- `aos check-writeback` — hook (Stop, PreCompact): exit 2 while the chain is broken, or while a run is open that this session owns (`run.started` records the session that started it; another session, and a session that declared the role director, end freely and are told which order has a run open; with no session in the hook input, or a run with no recorded owner, every session is blocked; ORD-0041 part 5)
- `aos hook session-start` — hook (SessionStart): derive, print resume.md, record role.declared and session.start
- `aos hook pre-tool-use` — hook (PreToolUse): block tools under HALT and writes to protected paths
- `aos agents-md sync` — any: refresh only the analucia block of AGENTS.md
- `aos check-roles` — any: one analucia block; CLAUDE.md is @AGENTS.md
- `aos check-push [remote] [url]` — git pre-push hook: remote user and credential user = github_owner; no credential in the URL; every pushed commit outside owner/director paths carries Analucia-Order; no secret pattern in added lines; no commit that carries the trailer of an order and is dated after the last run.finished of that order while no run of it is open (E_COMMIT_AFTER_FINISH, ORD-0041 part 8)
- `aos install-git-hooks` — owner or director: set core.hooksPath to .githooks (pre-push)
- `aos eval run` — any: deterministic evaluations of the mechanisms (no model calls): PASS/FAIL per scenario, .analucia/views/evals.md, an eval.run event; exit 0 only if all pass
- `aos adopt [--locale en|es|pt|zh-Hans|hi]` — owner or director: read-only adoption audit (SPEC-0006): findings, not verified, proposed orders in .analucia/views/adoption.md; one adoption.audited event; exit 0 / 1 (high) / 2 (cannot run); never shows a secret
- `aos metrics first-hour` — any: the owner first hour from the log only (AMD-0004): started, first_closed, elapsed, status; refreshes .analucia/views/first-hour.md (also written by aos derive)
- `aos pause ORD-NNNN --reason "<why>"` — executor: close the open run as blocked and move active -> paused (AMD-0005 §2)
- `aos resume-order ORD-NNNN` — executor: paused -> active with a new run, within the attempt budget
- `aos sign` — owner, own TTY: draft orders waiting to be placed first (PLACE; ORD-0040), then documents waiting for review (approve, comment, reject, open; AMD-0007), then verify every delivered order, show results and evidence, close what passed after typing CLOSE, record owner.signed, commit and push the sign-off (AMD-0005 §3)
- Step to main (ORD-0041 part 7, AMD-0015 §7): when `aos sign` closed at least one order on a branch that is not the default branch and its sign-off is pushed, it shows the branch, the number of commits and that it will be a fast-forward, and asks for the typed word `MERGE`; then it switches to the default branch, merges fast-forward only and pushes through the guard. If a fast-forward is not possible or a step fails, it changes nothing further and says so. Never a force, never a merge commit, never from an agent
- `aos sign --install-launcher` — owner: write FIRMAR.cmd and FIRMAR.sh in the project root: double-click to sign
- `aos next` — any: exactly one line: the single thing that comes next and who does it, in the project language, with the click or the command as it exists on this machine; works in a folder with no .analucia/; writes nothing; the SessionStart hook shows the same line (ORD-0040)
- `aos launchers install` — any role, an agent included (files only): write the owner click launchers INICIAR (`aos init`), FIRMAR (`aos sign`), DETENER (`aos halt`), REANUDAR (`aos resume`) and IMPORTAR (`aos ceo import`) as .cmd and .sh in the project root; each finds the plugin through CLAUDE_CONFIG_DIR and takes the installed version by numeric order (ORD-0040)
- `aos preflight <order ID>` — any: run the `preflight` checks of the order's verify file (same shape as `checks`, meant to pass on the untouched tree) for a placed order or a draft; prints each result and one final line, writes its output under the order's evidence folder, changes no state. `aos admit` runs it and refuses when a check fails; `aos run start` runs it again and then starts nothing: no run.started, no attempt consumed (E_PREFLIGHT_FAILED; ORD-0041 part 4, AMD-0015 §4)
- `aos docs check <order ID>` — any (verify files): for the commits of that order, every file added inside a folder of earlier records of the project must be named, by its path, in the order or one of its amendments; exit 1 with the list; exit 0 and one line when the project has no such folder (ORD-0041 part 2, AMD-0015 §3)
- Earlier records (ORD-0041 part 2): `aos adopt` lists the folders of earlier orders, reports and decisions of the project (by folder and file names only, with counts and the numbering found) under their own heading; an order may carry `continues:`, free text naming the earlier record it continues, shown next to its ID in the queue, in `aos next` and in the owner sheet
- `aos ids` — any: the map of record IDs for people: each existing record, its ID and the same number under the project code (nothing is renamed), and the next free ID of each kind; one line when the project has no code yet (ORD-0041 part 1)
- Project code (ORD-0041 part 1, AMD-0015): `project_code` in project.json, 2 to 5 capital letters, never a type word, chosen by the owner at `aos init` and unique on the computer (list in the configuration folder, `CLAUDE_CONFIG_DIR` honoured). New records are `<CODE>-NNNN`, `<CODE>-AMD-NNNN`, `<CODE>-ASK-NNNN`; every existing ID stays valid; a new record with the old prefix is refused (E_ID_PREFIX)
- `aos drafts` — any: the draft orders in .analucia/drafts/ (ORD-NNNN.md with its verify file ORD-NNNN.json), whether each can be placed and why not, and the next free ID; exit 1 while one is not ready. The owner places the ready ones in `aos sign` by typing PLACE: the tool copies them to the protected paths, writes their hashes in director.lock and admits them (ORD-0040)
- `aos review request <path> --order ORD-NNNN` — executor: register a document (plan, design, mockup) for the owner: review.requested with its sha256 (AMD-0007 §1)
- `aos workflow check ORD-NNNN` — any (verify files): exit 0 when design.md and plan.md of a workflow: qrspi order have a current approve (AMD-0007 §3)
- `aos hook session-name` — hook (SessionStart, UserPromptSubmit): names the session by its role without the user doing it: `DIRECTOR` for a session that declared that role, `EJECUTOR <project code or folder name>` otherwise (hook output `sessionTitle`); a name a person gave is never replaced; it writes nothing. The session of an outside advisor is named by hand `DT <topic>` (ORD-0041 part 3)
- `aos hook session-end` — hook (SessionEnd): session.end with the session id and reason; never blocks (AMD-0007 §2)
- `aos backup [--remote origin]` — executor or owner: push a snapshot of the working tree (uncommitted and untracked, not ignored) to backup/<YYYY-MM-DD>; never touches the branch, index, tree or main; refuses on a secret (ORD-0024)
- `aos backup --restore-hint` — any: the latest backup branch and the commands to restore it in a new folder
- `aos explain <CODE>` — any: print the page of an error code

## Pages for the owner

- [CLOSING-TEST.md](CLOSING-TEST.md) — one page of clicks: from a new empty folder to a signed order, without typing a command (ORD-0040)
- `plugins/analucia/templates/report.md` — the order report, with its fixed section `## Evidencia` (ORD-0040 part 5)
- `plugins/analucia/templates/director-entry.md`, `bootstrap-order.md`, `bootstrap-verify.json` — what `aos init` leaves for the director: `.analucia/DIRECTOR.md`, and the first order as a draft when commits predate the Loop (ORD-0040 part 2)
- `plugins/analucia/templates/owner-data-file.md` — a data file of the owner: its one writer, never overwritten without comparing first, what each number means, where it comes from and its unit; expected values with the rule that must produce them; a control calls the function it controls (ORD-0041 part 9)
- [HUMAN-LAYER.md](HUMAN-LAYER.md) — reviewing documents in aos sign, interrupted sessions, QRSPI orders, open orders before a new one (AMD-0007)
- [hosting/VPS-CHECKLIST.md](hosting/VPS-CHECKLIST.md) — own server: the checklist (AMD-0006)
- `plugins/analucia/templates/workflow-qrspi.md` — the QRSPI template (AMD-0007 §3)
- `plugins/analucia/templates/decision-brief.md` and `decision-brief.es.md` — the one-page decision brief (ORD-0024)
- `docs/RECOVERY.md` (repository root) — from a new computer to a working project (ORD-0024)

## Adoption checks (aos explain AD-…)

- [AD-BACKUP](adopt/AD-BACKUP.md)
- [AD-BRANCH](adopt/AD-BRANCH.md)
- [AD-DEPS](adopt/AD-DEPS.md)
- [AD-DOCS](adopt/AD-DOCS.md)
- [AD-ENV](adopt/AD-ENV.md)
- [AD-HYGIENE](adopt/AD-HYGIENE.md)
- [AD-SECRET-HISTORY](adopt/AD-SECRET-HISTORY.md)
- [AD-SECRET-TREE](adopt/AD-SECRET-TREE.md)
- [AD-SPOF](adopt/AD-SPOF.md)
- [AD-TESTS](adopt/AD-TESTS.md)

## Error pages

- [E_ACCOUNT](errors/E_ACCOUNT.md) — next (owner): Point the remote URL user and credential.https://github.com.username at the github_owner of .analucia/project.json, then push again.
- [E_ACTOR_ENUM](errors/E_ACTOR_ENUM.md) — next (executor): Use one of the actors values from plugins/analucia/core/enums.json and write the event again with aos.
- [E_ADOPT_UNAVAILABLE](errors/E_ADOPT_UNAVAILABLE.md) — next (owner): Run aos adopt inside the git work tree of the project (it needs the repository and its history).
- [E_ANSWER_VALUE](errors/E_ANSWER_VALUE.md) — next (owner): Fix the named answer to one of the allowed values (or write unknown to use the safe default) and run aos init again.
- [E_ASK_KIND_ENUM](errors/E_ASK_KIND_ENUM.md) — next (director): Use one of the ask_kinds values from plugins/analucia/core/enums.json and write the event again with aos.
- [E_ASK_TOO_LONG](errors/E_ASK_TOO_LONG.md) — next (director): Shorten the question in the ask file to at most 600 characters and move details to refs.
- [E_BACKUP](errors/E_BACKUP.md) — next (executor): Read the git step named in the message, fix it (remote reachable, account, a git work tree), then run aos backup again.
- [E_BLOCKED_NO_REF](errors/E_BLOCKED_NO_REF.md) — next (executor): Give the blocked transition a blocked_by value (an ask, order or decision ID, or a reason) and record it again.
- [E_BUDGET](errors/E_BUDGET.md) — next (director): Decide what happens to the order (amend its budget or issue a new order); the executor stops.
- [E_CHAIN](errors/E_CHAIN.md) — next (director): Restore .analucia/events.jsonl from git and confirm with aos verify-log; nobody edits the log by hand.
- [E_CODE_TAKEN](errors/E_CODE_TAKEN.md) — next (owner): Choose another project code (2 to 5 capital letters) and answer the code question of aos init again; the message names the folder that already uses this one.
- [E_COMMIT_AFTER_FINISH](errors/E_COMMIT_AFTER_FINISH.md) — next (executor): Stop committing for that order: write what you found in the report as pending and tell the director, who opens a new run or a new order for it.
- [E_COST_EFFECT_ENUM](errors/E_COST_EFFECT_ENUM.md) — next (director): Set cost_effect to one or more of none, build, deploy, service, data (cost_effects in plugins/analucia/core/enums.json).
- [E_DECISION_ENUM](errors/E_DECISION_ENUM.md) — next (director): Use one of the admission_decisions values from plugins/analucia/core/enums.json and write the event again with aos.
- [E_DIRECTOR_RUN](errors/E_DIRECTOR_RUN.md) — next (director): Leave the run to an executor: the owner opens another session for it, and this session keeps writing drafts.
- [E_DIRECTOR_FILE_CHANGED](errors/E_DIRECTOR_FILE_CHANGED.md) — next (director): Restore the listed director files from git, or re-issue them and refresh .analucia/director.lock.
- [E_DUPLICATE_KEY](errors/E_DUPLICATE_KEY.md) — next (director): Remove the repeated key from the front matter so each key appears once.
- [E_EVIDENCE_ENUM](errors/E_EVIDENCE_ENUM.md) — next (executor): Use one of the evidence_levels values from plugins/analucia/core/enums.json and write the event again with aos.
- [E_FIELD_TYPE](errors/E_FIELD_TYPE.md) — next (director): Change the value named in the message to the stated type (date YYYY-MM-DD, positive integer, inline list, object or string).
- [E_FILE_MISSING](errors/E_FILE_MISSING.md) — next (executor): Create or point to the file named in the message; if it is a director file, finish the run with needs_decision.
- [E_FILE_TYPE](errors/E_FILE_TYPE.md) — next (executor): Run aos validate on a project directory or on an order, verify file, director.lock, project.json or events.jsonl.
- [E_FRONT_MATTER](errors/E_FRONT_MATTER.md) — next (director): Rewrite the order front matter as flat key: value lines between two --- lines.
- [E_ID_FORMAT](errors/E_ID_FORMAT.md) — next (director): Use an ID of the right format: ORD-0000 or ORD-0000.A for orders, a 26-character ULID for events.
- [E_ID_PREFIX](errors/E_ID_PREFIX.md) — next (director): Give the record the ID named in the message: new records carry the code of the project (aos ids prints the next free ID of each kind).
- [E_ID_MISMATCH](errors/E_ID_MISMATCH.md) — next (director): Make the id (or order) field equal the file name without its extension.
- [E_JSON](errors/E_JSON.md) — next (director): Fix the JSON syntax at the line named in the message (project.json, a verify file, the lock, or one event line).
- [E_KIND_ENUM](errors/E_KIND_ENUM.md) — next (director): Set kind to one of the order_kinds in plugins/analucia/core/enums.json.
- [E_LOG_BUSY](errors/E_LOG_BUSY.md) — next (executor): Run the same command again in a moment; if it still fails, check that no other aos command is running in this project and tell the director.
- [E_MISSING_FIELD](errors/E_MISSING_FIELD.md) — next (director): Add the required field named in the message and run aos validate again.
- [E_MOVING_REF](errors/E_MOVING_REF.md) — next (director): Replace the moving ref named in the message (HEAD, a branch or a remote ref) with a commit SHA or {order_commit} in the verify file, then run aos validate again.
- [E_NOT_CONFIRMED](errors/E_NOT_CONFIRMED.md) — next (owner): Run aos close again in your terminal and type CLOSE exactly to sign.
- [E_NOT_LOCKED](errors/E_NOT_LOCKED.md) — next (director): Add the order file and its sha256 (LF-normalized) to .analucia/director.lock, then run aos admit again.
- [E_NO_ACCEPTANCE](errors/E_NO_ACCEPTANCE.md) — next (director): Add a ## Acceptance criteria section with at least one list item to the order.
- [E_NO_ORDER](errors/E_NO_ORDER.md) — next (director): Write the order file .analucia/orders/ORD-NNNN.md; the executor does no work without it.
- [E_NO_ORDER_COMMIT](errors/E_NO_ORDER_COMMIT.md) — next (executor): Commit with the trailer Analucia-Order: ORD-NNNN of the order, then ask for verify.
- [E_NO_ORDER_TRAILER](errors/E_NO_ORDER_TRAILER.md) — next (executor): Amend the listed commit so its message ends with the trailer Analucia-Order: ORD-NNNN of the order you are running, then push again.
- [E_NO_ROLLBACK](errors/E_NO_ROLLBACK.md) — next (director): Write the rollback plan .analucia/rollback/ORD-NNNN.md, name it in the order rollback key and list it in director.lock.
- [E_OUTCOME_ENUM](errors/E_OUTCOME_ENUM.md) — next (executor): Use one of the run_outcomes values from plugins/analucia/core/enums.json and write the event again with aos.
- [E_OWNER_TTY](errors/E_OWNER_TTY.md) — next (owner): Run the command yourself in your own interactive terminal; agents stop here.
- [E_PAUSED_NO_REASON](errors/E_PAUSED_NO_REASON.md) — next (executor): Record the pause again with a reason in the payload.
- [E_POLICY_ENUM](errors/E_POLICY_ENUM.md) — next (owner): Set deploy.policy in .analucia/project.json to one of the deploy_policies (batch or continuous).
- [E_PREFLIGHT_FAILED](errors/E_PREFLIGHT_FAILED.md) — next (director): Put in place what the failing preflight checks name (a tool, a file, the test baseline), or correct the check in a new draft, then run aos preflight again; no attempt was consumed.
- [E_PREV_FORMAT](errors/E_PREV_FORMAT.md) — next (director): Restore .analucia/events.jsonl from git; prev values are written only by aos.
- [E_RECORD_EXISTS](errors/E_RECORD_EXISTS.md) — next (director): Use a new record ID; IDs are never created twice or reused.
- [E_REF_FORMAT](errors/E_REF_FORMAT.md) — next (director): Replace the reference with a valid record ID (ORD-0000, DEC-0000, SPEC-0000, OBS-0000, AMD-0000, ASK-0000).
- [E_REVIEW_DECISION](errors/E_REVIEW_DECISION.md) — next (owner): Type approve, comment or reject (comment and reject need a note) for a document that is waiting, in aos sign.
- [E_REVIEW_PATH](errors/E_REVIEW_PATH.md) — next (executor): Register a document that lives inside the project, with a path relative to its root, then run aos review request again.
- [E_RISK_CLOSE](errors/E_RISK_CLOSE.md) — next (owner): Close this order yourself from your own terminal with aos close ORD-NNNN; only risk: low orders may be closed with --as director.
- [E_RISK_ENUM](errors/E_RISK_ENUM.md) — next (director): Set risk in the order to low, medium or high (risk_levels in plugins/analucia/core/enums.json).
- [E_ROLES](errors/E_ROLES.md) — next (director): Run aos agents-md sync and keep CLAUDE.md to the line @AGENTS.md, with director instructions moved to the director entrypoint.
- [E_SECRET](errors/E_SECRET.md) — next (owner): Remove the secret from the listed commit and file, rotate it at its provider, then push again.
- [E_SECRET_IN_URL](errors/E_SECRET_IN_URL.md) — next (owner): Remove the credential from the remote URL with git remote set-url, rotate it, then push again.
- [E_SHEET_VALUE](errors/E_SHEET_VALUE.md) — next (owner): Fix the listed cells in the owner sheet (or export a fresh one with aos ceo export) and run aos ceo import again.
- [E_STATE_ENUM](errors/E_STATE_ENUM.md) — next (executor): Use one of the order_states values from plugins/analucia/core/enums.json and write the event again with aos.
- [E_STATE_IN_DEFINITION](errors/E_STATE_IN_DEFINITION.md) — next (director): Remove the state key from the order file; state is derived from the event log.
- [E_SUPERSEDED_NO_REF](errors/E_SUPERSEDED_NO_REF.md) — next (director): Record the transition to superseded with payload.superseded_by set to the replacing record ID.
- [E_TRANSITION](errors/E_TRANSITION.md) — next (executor): Read the order state with aos history ORD-NNNN and use the command or transition allowed from that state.
- [E_TS_FORMAT](errors/E_TS_FORMAT.md) — next (director): Restore .analucia/events.jsonl from git; timestamps are set by aos.
- [E_TYPE_ENUM](errors/E_TYPE_ENUM.md) — next (executor): Use one of the event_types values from plugins/analucia/core/enums.json and write the event again with aos.
- [E_UNKNOWN_CODE](errors/E_UNKNOWN_CODE.md) — next (executor): Run aos explain with one of the close matches it listed.
- [E_UNKNOWN_KEY](errors/E_UNKNOWN_KEY.md) — next (director): Remove the key named in the message or rename it to an allowed key.
- [E_VERIFY_FAILED](errors/E_VERIFY_FAILED.md) — next (director): Read the verify evidence file and send the order back for rework or amend it; the order stays delivered.
- [E_WIP_LIMIT](errors/E_WIP_LIMIT.md) — next (executor): Finish the active order first with aos run finish, or wait; only the owner raises wip_limit.
- [E_WORKFLOW_ENUM](errors/E_WORKFLOW_ENUM.md) — next (director): Remove the workflow key or set it to qrspi, then refresh director.lock.
