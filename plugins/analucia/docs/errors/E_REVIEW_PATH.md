# E_REVIEW_PATH

Who acts: `executor`

## What happened

`aos review request` was given a path outside the project. A document for review must be a file of the project so its content can be hashed and read back (AMD-0007 §1).

## What to do next

**Register a document that lives inside the project, with a path relative to its root, then run aos review request again.** (executor)

1. Move or write the document inside the project, for example under `.analucia/artifacts/<ORDER>/`.
2. Run `node plugins/analucia/bin/aos.mjs review request <path> --order ORD-NNNN` again.

## Patterns

- QRSPI orders keep their documents in `.analucia/artifacts/<ORDER>/` (see plugins/analucia/templates/workflow-qrspi.md).

## Trade-offs

- Only files inside the project can be reviewed, so the owner and the agent see the same bytes.

## Gotchas

- Nothing was written: the log is unchanged.
