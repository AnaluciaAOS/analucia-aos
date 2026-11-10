# E_VERIFY_FAILED

Who acts: `director`

## What happened

At least one check of `.analucia/verify/ORD-NNNN.json` did not exit with its `expect_exit`. The outputs were attached as evidence (`passed: false`); the order was not verified.

## What to do next

**Read the verify evidence file and send the order back for rework or amend it; the order stays delivered.** (director)

1. Director: read `.analucia/evidence/ORD-NNNN/verify-NN.txt`.
2. Rework: `node plugins/analucia/bin/aos.mjs event append --type order.state_changed --actor director --subject ORD-NNNN --payload '{"from":"delivered","to":"active","reason":"rework: <check>"}'`, or write an amendment.
3. Executor: never edit the verify file to make it pass.

## Patterns

- Verify checks are the grader; the executor does not grade itself (Q-82).

## Trade-offs

- None specific: the rule is cheap to follow and the check costs nothing at runtime.

## Gotchas

- Checks run in Git Bash from the repo root.
