# Rules detail — read on demand

The always-loaded rules block of `AGENTS.md` is kept at or under 8192 bytes (SPEC-0003 §1). The detail of the topics below lives here; the block keeps one pointer line for each, written `RULES-DETAIL "<heading>"`. Read a section when your work touches its topic. The specs win over this page, as they win over the block.

## Contributor

- `contributor` (third-party human): delivers on a branch for review; never merges to a protected branch, never closes.
- The other roles (`owner`, `director`, `executor`, `system`) are in the rules block.

## Orders without pins

- `aos admit` (director) pins the plugin and spec versions; the order follows them until it closes.
- Orders without pins (ORD-0001..0007) follow SPEC-0002.
- The risk levels, the rollback plan and who may close apply to orders admitted with SPEC-0003 pins.

## Risk and versions

Orders admitted with SPEC-0003 pins.

- `risk`: low | medium | high. high → `run start` needs `.analucia/rollback/ORD-NNNN.md` in director.lock (`E_NO_ROLLBACK`) and `aos verify` runs every check once; a check that fails is run again, once, and its second result counts (the evidence marks a check that passed on the second run; ORD-0043 part 17). Only low may be closed by the director (`aos close --as director`).
- `aos admit` (director) pins the plugin and spec versions; the order follows them until it closes.

## Copies of real data

- A copy of real data: record it (`aos scratch add ORD-NNNN --path <folder> [--pid <n>]`), delete only what the order names, and leave none before `done` (`aos scratch check ORD-NNNN`).

## Derived state

- State is derived: `aos derive` → `.analucia/views/` (never edited); `aos history ORD-NNNN` queries one record.
- `AGENTS.md` and `CLAUDE.md` hold rules only, never state; `CLAUDE.md` is `@AGENTS.md`.

## Cost

- `aos cost record` / `aos cost status`: alerts at 50/80/100% inform the owner and never stop work.
- `aos cost record --usd <n> --source "<text>" [--order ORD-NNNN] [--month YYYY-MM]` is the director's (or the owner's); `aos cost status [--month YYYY-MM]` is for any role: budget, spend, percent, alerts and cost per closed order.

## Push guard and permission profile

- Push only through the `pre-push` guard (`aos check-push`): the remote URL user and the credential user must equal `github_owner` in `.analucia/project.json`; no credential in the URL (`E_SECRET_IN_URL`), no secret in added lines (`E_SECRET`). Never print or type a secret.
- Every commit that changes code carries the trailer of its order; without it the guard refuses the push (`E_NO_ORDER_TRAILER`). A commit made after `aos run finish` is refused too (`E_COMMIT_AFTER_FINISH`).
- Second lock: inside an agent session `aos check-push` refuses a protected branch as destination (`E_PROTECTED_PUSH`); the owner's own pushes from `aos sign` are not affected.
- `aos install-git-hooks` installs the guard; each error code has its page (`aos explain <CODE>`).
- No git command waits for ever (OBS-192): `aos install-git-hooks` also writes, in the repository's own configuration, `credential.interactive=false`, `credential.guiPrompt=false` and a low-speed limit, so git fails at once instead of waiting for a typed password or an account window; the plugin's own network calls (the step to main, the backup) and the guard's git calls have a time limit of two minutes and never prompt. A git command of an executor that does not end in two minutes is stopped, and the run finishes `blocked` naming that command; ESTADO shows it to the owner.
- One trailer rule: `aos trailer check <ID> --from <commit>` judges the commits of an order with the function the guard uses; a verify file runs it instead of a check written by hand.
- Every preflight (`aos preflight`, `aos admit`, `aos run start`) checks the guard itself (`push guard installed`): the `pre-push` hook is where git looks for it, calls `aos check-push` and names no plugin version. `aos install-git-hooks` fixes it.
- `.claude/settings.json` (`aos permissions write`; `--local` writes `.claude/settings.local.json` instead; `--permissions-only` leaves the plugin keys alone) carries the permission profile of ORD-0044 part 7 (OBS-193): allow every shell command (`Bash`, `PowerShell`) and every edit and write (`Edit`, `Write`); deny, and nothing else: force pushes in every form, a push to a protected branch (`protected_branches` of `project.json`; `main` and `master` when absent; by name, `HEAD:main`, refspec), `git reset --hard`, mass deletes (`rm -rf`, `rm -r`, `Remove-Item -Recurse`, `del /s`, `rmdir /s`), reading `.env`, `.env.*`, `*.pem`, `*.key` (also through `cat`, `type`, `Get-Content`), and writing to a real database (`psql`, `pg_restore`, `mysql` and the migrate or push commands of the ORMs). The ask list is empty: nothing asks. Deny wins over allow (Claude Code permissions documentation: "Rules are evaluated in order: deny, then ask, then allow. The first match in that order determines the outcome"). The deny list is one constant in `lib/permissions.mjs`, tested by `permissions-profile.test.mjs`. `aos permissions apply` (the PERMISOS button) is owner-only (`E_OWNER_TTY`): it shows what changes, asks for a typed word and then calls `aos permissions write`; an executor or the dispatcher never runs it (AMD-0026).
- The executor never waits for an approval: a denied command is not retried or worked around. It does the work another allowed way, or, when the work needs the command, finishes the run `blocked` naming it.

## The STOP of the owner

- The owner's instruction to stop or to go on is obeyed at once. On a stop the agent ends what it is doing, starts nothing new and says in one line what is left open; an agent that cannot do what the owner asks says why in one line and stops, and does not go on with its own plan.
- A prompt that is only `STOP`, `ALTO`, `DETENER` or `PARA` (any case, with or without punctuation or spaces around it: `para.`, `¡Alto!`, `DETENER!!`) writes the halt of the project through the same function as `aos halt`, with the reason "the owner said <word> in the session <name>". Every session then only reads; only the owner resumes, with REANUDAR (`aos resume`, at a terminal).
- A longer prompt that starts with one of those words and says more (`para qué sirve…`, `alto el fuego en la prueba`) is not a stop: no halt, no record, no line of context. `AVANZA` follows the same rule: only a prompt that is just the word (punctuation allowed) is recorded (`operation.logged`: the word, the session, the time; never anything else) and the session gets one line: run `aos next` and do what it says, with no question unless there is a material technical risk.
- The first line of every session and `aos status` name the DETENER launcher and the stop word.

## Owner data and facts of git

- `owner_data` in `.analucia/project.json` lists the path patterns of the files only the owner writes (prices, costs, rates, control files). An agent never writes or deletes them (`E_OWNER_DATA`, from the PreToolUse hook): it tells the owner what should change and why. Reading stays free.
- Before stating that a file is or is not under version control, run `aos tracked <path>` and quote its line: under version control, ignored (by which rule of which file) or neither.

## Owner sheet and asks

SPEC-0004.

- The owner's channel is one spreadsheet (`aos ceo export`); only the owner imports it (`aos ceo import <file>`, own TTY, `CONFIRM`). Agents never edit it.
- Asks are director files (`.analucia/asks/ASK-NNNN.md`, `aos ask open`); only the owner resolves them, through the sheet.

## Click launchers

- `aos launchers install` (any role: it writes files only) puts the owner's click launchers in the project root: INICIAR (`aos init`), FIRMAR (`aos sign`), DETENER (`aos halt`), REANUDAR (`aos resume`), IMPORTAR (`aos ceo import`), REPARAR (`aos repair-log`), ACTUALIZAR (`aos update`), ESTADO (`aos status --owner`: reads only, any role), PERMISOS (`aos permissions apply`: owner only, a typed word; ORD-0046).
- One file per launcher: `.cmd` on Windows, `.sh` elsewhere (ORD-0046), so the owner sees one FIRMAR.
- `aos dispatch` (any role; no launcher): places and admits a draft of risk low or medium whose `decision:` equals a recorded decision of the owner, verifies delivered orders, and works out the next run (`--brief` prints its name, model, effort and brief). It opens nothing and calls no command line (AMD-0027): the executor that ends a run proposes the next session in the application's new-session card, and the owner clicks it.
- `aos update` is the one launcher command any role may run, an agent included: it changes no project file; the `claude` command-line tool does the update.
- Only the owner answers in them, at their own terminal; never run those commands yourself, `aos sign` included.
