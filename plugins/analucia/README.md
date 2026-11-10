# analucia (plugin)

Core plugin of Analucia AOS, version 0.3.0.

It implements the nomenclature in `core/NOMENCLATURE.md` (SPEC-0001): roles, orders, run outcomes, evidence levels and the append-only event log at `.analucia/events.jsonl`.

It contains the `aos` command line, the hooks that guard every Claude Code session (SessionStart, Stop, PreCompact, PreToolUse) and the owner texts in five languages. Every command and error page is listed in `docs/INDEX.md`.
