# E_FILE_TYPE

Who acts: `executor`

## What happened

`aos validate <path>` was given a file it does not know how to validate.

## What to do next

**Run aos validate on a project directory or on an order, verify file, director.lock, project.json or events.jsonl.** (executor)

1. Validate the whole project: `node plugins/analucia/bin/aos.mjs validate` (from the repo root).

## Patterns

- Validate the directory, not single files, unless you debug one file.

## Trade-offs

- Unknown files are reported instead of skipped, so a typo in a path is visible.

## Gotchas

- Verify files must be named `ORD-NNNN.json`.
