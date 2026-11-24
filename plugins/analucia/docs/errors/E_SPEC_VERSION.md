# E_SPEC_VERSION

Who acts: `director`

## What happened

`aos validate` compared each core spec (`core/NOMENCLATURE.md`, `core/SPEC-NNNN-*.md`) with the copy on the local branch `main`. The text differs but the `version:` line is the same. Specs were once changed with no new version, because the docs index test pinned the version (OBS-187). The message names the spec.

## What to do next

**Change the version: line of the core spec named in the message (and its version_approved when the owner approves it) so it differs from the one on main, then run aos validate again.** (director)

1. Open the spec named; raise `version:` (for example 0.1.0 to 0.1.1).
2. The owner approves the new version in `aos sign` as for any spec change.
3. Run `aos validate`.

## Patterns

- Line endings (CRLF or LF) are not a change.
- On `main` itself, or where `main` has no copy of the spec, nothing is judged.

## Trade-offs

- The docs index no longer pins versions: it lists each spec and the test reads the version from the spec.

## Gotchas

- An executor never edits a core spec: it finishes the run with `needs_decision`.
