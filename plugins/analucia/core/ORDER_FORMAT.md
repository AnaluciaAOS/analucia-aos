# Order file format

Specification: `core/NOMENCLATURE.md` (SPEC-0001). Closed lists: `plugins/analucia/core/enums.json`.
Checked by `node plugins/analucia/bin/aos.mjs validate [path]`.

An order file is a **definition**, never state. Its state (`draft`, `queued`, `active`, …) is derived from `.analucia/events.jsonl` (SPEC-0001 §6) and never written into the file.

## Location and name

`.analucia/orders/<ID>.md`, where `<ID>` matches `^ORD-\d{4}(\.[A-Z])?$` (`ORD-0001`, phase `ORD-0042.A`). The `id` key must equal the file name without `.md`.

**Project code (AMD-0015 §1).** When `project.json` has `project_code` (2 to 5 capital letters, never `ORD`, `AMD`, `ASK`, `DEC`, `OBS` or `SPEC`), new orders are `<CODE>-NNNN` (`SHOP-0042`, phase `SHOP-0042.A`), new amendments `<CODE>-AMD-NNNN` and new asks `<CODE>-ASK-NNNN`; verify files, rollback plans, evidence folders and the commit trailer use the same ID. Each counter continues from the highest number the project already has. Every existing ID stays as it is and stays valid; a new record with the old prefix, or with the prefix of another project, is refused (`E_ID_PREFIX`). `aos ids` prints the map and the next free IDs.

## Front matter

The file starts with a line `---` and the front matter ends at the next line `---`. Between them, only:

- flat lines `key: value` (a value may be wrapped in `"…"` or `'…'`);
- inline lists `key: [a, b]` (`[]` is an empty list);
- blank lines.

Nested keys, block lists (`- item`), multi-line values and comments are not accepted.

| Key | Required | Value |
|---|---|---|
| `id` | yes | Order ID, equal to the file name |
| `title` | yes | Text |
| `kind` | yes | One of `order_kinds` in enums.json |
| `created` | yes | Date `YYYY-MM-DD` |
| `budget_max_minutes` | yes | Positive integer |
| `budget_max_attempts` | yes | Positive integer |
| `aliases` | no | Inline list of former titles or IDs (renaming keeps the old name here) |
| `depends_on` | no | Inline list of record IDs |
| `absorbs` | no | Inline list of record IDs |
| `parent` | no | One order ID (for phases) |
| `amends`, `supersedes`, `reverts` | no | A record ID, or an inline list of them |
| `due` | no | Date `YYYY-MM-DD` |
| `notes` | no | Free text (the only free-text key) |
| `risk` | for orders admitted with SPEC-0003 pins | One of `risk_levels`: `low`, `medium`, `high` (SPEC-0003 §4) |
| `cost_effect` | for orders admitted with SPEC-0003 pins | One of `cost_effects`, or an inline list of them |
| `rollback` | when `risk: high` | Path of the rollback plan, `.analucia/rollback/ORD-NNNN.md` (a director file listed in `director.lock`) |
| `continues` | no | One line of free text naming the earlier record of the project this order continues, in the project's own numbering (AMD-0015 §2). A reference for people: it creates no relation in the log |
| `replaces` | no (asked by `aos drafts` in a draft of kind `build`) | Inline list of paths of the project that the work of the order replaces and that must be gone when it is delivered; `[]` says, on purpose, that it replaces nothing. `aos replaced check <ID>` checks it at the commit of the order (ORD-0042 part 7) |
| `decision` | no | One line of free text: the decision of the owner this order carries out. When the owner places the draft (`PLACE` in `aos sign`) the tool records it as a `decision.recorded` event, the first link of the chain of the order (ORD-0042 part 6) |
| `workflow` | no | `qrspi`: the order follows the template `plugins/analucia/templates/workflow-qrspi.md` (AMD-0007 §3). A template, not a lifecycle |

Orders admitted before SPEC-0003 (no `pins` in their `record.created`, ORD-0001..ORD-0007) may omit `risk` and `cost_effect` (SPEC-0003 §7).

Any other key is an error. A `state` key is a specific error, because state never lives in a definition.

## Body

The body must contain a heading line `## Acceptance criteria` followed, before the next `#` or `##` heading, by at least one list item (`- `, `* `, `+ ` or `1. `; checkboxes `- [ ]` count).

## Business rules

An order may carry the body section `## Business rules` (asked by `aos drafts` in a draft of kind `build`): one rule per list item, each with one example with numbers; an order with none writes the single item `- none`. `aos sign` prints the rules of a draft before the owner's typed confirmation, and the placement records them in the `decision.recorded` event (`payload.business_rules`). Orders already placed never need the section (ORD-0042 part 10).

## Verify file

`.analucia/verify/ORD-NNNN.json` (director file): `{"order": "ORD-NNNN", "checks": [{"name", "run", "expect_exit"}]}`; `aos verify` runs each `run` with bash from the repository root. Template: `plugins/analucia/templates/verify-file.example.json`.

**Form and substance (ORD-0043 part 2).** A check may carry `"class": "form"`; a check without the key is a check of substance. Form is only what does not change what was built or how safely: a trailer on a commit that touches only evidence, a label or a heading of the report, the name of the branch the signature is made from. The owner may waive a failed check of form at the signature, with a written reason; a check of substance is never waived. `aos validate` refuses (`E_FORM_CLASS`) the class form on a check that runs the test suite, `aos verify-log`, `aos validate`, `aos check-roles` or the release guard.

**Fixed refs only (ORD-0034).** A check must not depend on a ref that moves. `aos validate` rejects (`E_MOVING_REF`) a check that ends a git range at a moving ref: the right side of `A..B` / `A...B` (an empty right side means `HEAD`) in `git diff`, `log`, `rev-list` and the other range commands, or the last of two or more revisions of `git diff` / `git diff-tree`. Moving refs are `HEAD` in any form (`HEAD~N`, `HEAD^`, `@`, `@{…}`, `FETCH_HEAD`, `ORIG_HEAD`, `MERGE_HEAD`), `main`, `master`, anything under `origin/`, `upstream/`, `refs/heads/`, `refs/remotes/`, and any local or remote-tracking branch of the repository. Use a commit SHA (7+ hex, optionally `^`, `^N`, `~N`) or the placeholder `{order_commit}`, which `aos verify` resolves to the newest commit whose message has the trailer `Analucia-Order: ORD-NNNN` (`E_NO_ORDER_COMMIT` when none; the evidence shows the check as written and as resolved). Single revisions stay allowed, for example `--ref HEAD` to build the current tree and `git merge-base --is-ancestor <sha> HEAD`. The rule is an error for orders not yet admitted and for orders admitted with `pins.plugin` 0.3.0 or later; for orders admitted earlier it is a warning and the exit code does not change. `aos admit` refuses a verify file with the error.

- Wrong: `git diff --quiet 8ea118d HEAD -- core`
- Right: `git diff --quiet 8ea118d {order_commit} -- core`

## Error codes

Each error is printed as `file:line: CODE message`. The command exits 0 when everything is valid and 1 otherwise (2 for a usage error or a missing path).

| Code | Where | Meaning |
|---|---|---|
| `E_FRONT_MATTER` | order | Missing or unclosed front matter, or a line that is not flat `key: value` |
| `E_UNKNOWN_KEY` | order, project, event | Key not allowed |
| `E_DUPLICATE_KEY` | order | Same key twice |
| `E_STATE_IN_DEFINITION` | order | A `state` key in an order file |
| `E_MISSING_FIELD` | order, event | Required key missing or empty |
| `E_ID_FORMAT` | order, event | Order ID not `ORD-0000[.A]`; event `id` not a ULID |
| `E_ID_MISMATCH` | order | `id` differs from the file name |
| `E_ID_PREFIX` | order, verify, ask | The prefix of the ID is not this project's: a new record with the old prefix in a project with a code, or the code of another project |
| `E_KIND_ENUM` | order | `kind` not in `order_kinds` |
| `E_FIELD_TYPE` | order, project, event | Wrong value type (date, positive integer, list, object) |
| `E_REF_FORMAT` | order, event | A relation or `subject` that is not a record ID |
| `E_NO_ACCEPTANCE` | order | No `## Acceptance criteria` section, or it has no items |
| `E_JSON` | project, event | Not valid JSON, not one object per line, empty line, or unterminated last line |
| `E_POLICY_ENUM` | project | `deploy.policy` not in `deploy_policies` |
| `E_TS_FORMAT` | event | `ts` not ISO 8601 with an offset (`Z` or `±hh:mm`) |
| `E_TYPE_ENUM` | event | `type` not in `event_types` |
| `E_ACTOR_ENUM` | event | `actor` not in `actors` (the four roles plus `system`) |
| `E_STATE_ENUM` | event | `order.state_changed` `from` or `to` not in `order_states` |
| `E_PAUSED_NO_REASON` | event | `to: paused` without `reason` |
| `E_BLOCKED_NO_REF` | event | `to: blocked` without a `blocked_by` record ID |
| `E_SUPERSEDED_NO_REF` | event | `to: superseded` without a `superseded_by` record ID |
| `E_OUTCOME_ENUM` | event | `run.finished` `outcome` not in `run_outcomes` |
| `E_EVIDENCE_ENUM` | event | `evidence.attached` `level` not in `evidence_levels` |
| `E_DECISION_ENUM` | event | `order.admitted` `decision` not in `admission_decisions` |
| `E_ASK_KIND_ENUM` | event | `ask.opened` `kind` not in `ask_kinds` |
| `E_PREV_FORMAT` | event | `prev` neither `null` nor a sha256 hex string |
| `E_CHAIN` | event | `prev` does not equal the sha256 of the previous line's raw bytes (or is not `null` on line 1) |
| `E_FILE_MISSING` | tree | `.analucia/project.json` or `.analucia/events.jsonl` missing |
| `E_FILE_TYPE` | file | A path that is not an order, verify file, `director.lock`, `project.json` or `events.jsonl` |
| `E_RISK_ENUM` | order | `risk` not in `risk_levels` |
| `E_WORKFLOW_ENUM` | order | `workflow` is not `qrspi` |
| `E_COST_EFFECT_ENUM` | order | a `cost_effect` value not in `cost_effects`, or an empty list |
| `E_MOVING_REF` | verify | A check ends a git range at a moving ref (HEAD, a branch, a remote ref); a warning for orders admitted before plugin 0.3.0 |
| `E_NO_ORDER_COMMIT` | verify run | `{order_commit}` cannot be resolved: no commit has the trailer `Analucia-Order: ORD-NNNN` |

Every code, including those of the lifecycle and guard commands, has a page under `plugins/analucia/docs/errors/` (`aos explain <CODE>`).

## Event line (summary)

One JSON object per line, terminated by `\n`, with exactly these keys: `id` (ULID), `ts` (ISO 8601 with offset), `type`, `actor`, `subject` (record ID or `null`), `payload` (object), `prev` (sha256 hex of the previous line's raw bytes without its `\n`, or `null` on the first line). The log is kept LF-only by `.gitattributes`.
