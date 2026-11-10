# E_REVIEW_DECISION

Who acts: `owner`

## What happened

A review decision was refused: the choice is not `approve`, `comment` or `reject`, a `comment` or `reject` came without a note, or the document is not waiting for a review (it was already decided for this content, or it was never requested). Nothing was written (AMD-0007 §1).

## What to do next

**Type approve, comment or reject (comment and reject need a note) for a document that is waiting, in aos sign.** (owner)

1. The owner runs `aos sign` in their own terminal and answers the document again.
2. For `comment`, write what should change; for `reject`, write why.
3. Agents: a decision is never written by an agent; ask for the review with `aos review request <path> --order ORD-NNNN`.

## Patterns

- Keep notes short and concrete: they reach the agent through resume.md under "Corrections to apply".

## Trade-offs

- A decision belongs to the exact content reviewed: any change to the file sends it back to the waiting list.

## Gotchas

- Typing `open` shows the document with the system viewer and asks again; an empty answer leaves it for later.
