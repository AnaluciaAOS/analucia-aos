# E_FILE_MISSING

Who acts: `executor`

## What happened

A required file does not exist: an evidence path given to `run finish`, `.analucia/project.json`, `.analucia/events.jsonl`, a verify file, the director lock, or the git repo for `install-git-hooks`.

## What to do next

**Create or point to the file named in the message; if it is a director file, finish the run with needs_decision.** (executor)

1. Executor: write the evidence report first, then pass its exact path to `--evidence`.
2. Verify file, lock or order missing: `node plugins/analucia/bin/aos.mjs run finish ORD-NNNN --outcome needs_decision --evidence <report>` and ask the director.
3. project.json or events.jsonl missing: the director initializes the project.

## Patterns

- Evidence paths are relative to the repo root: `.analucia/evidence/ORD-NNNN/report.md`.

## Trade-offs

- Refusing a missing evidence file prevents "done" without proof.

## Gotchas

- Paths are case-sensitive in git even on Windows.
