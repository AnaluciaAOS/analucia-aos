# E_REVIEW_DECISIONS

Who acts: `executor`

## What happened

`aos review request` was given a text document that does not end the way a document for the owner must: it has no section `## Decisiones`, or that section is empty, or one of its decisions has fewer than two options. The owner cannot decide from such a document, so it was not registered. Nothing was written.

## What to do next

**Write the document with the template plugins/analucia/templates/owner-review-doc.md so that it ends with the section named in the message, then run aos review request again.** (executor)

1. Open the template: business language, one example with numbers for every rule, and the last section `## Decisiones`.
2. Write each thing the owner must decide as one question followed by its options, one per line: `- A) …`, `- B) …`. Nothing he needs to decide is left "out of scope".
3. If there is truly nothing to decide, the section holds the single line `Ninguna`.
4. `node plugins/analucia/bin/aos.mjs review request <path> --order <ID>` again.

## Patterns

- The owner reads the document in `aos sign` and answers approve, comment or reject; the decisions section is what he marks.

## Trade-offs

- Only text documents (`.md`, `.markdown`, `.txt`) are checked: a picture or a rendered page cannot carry the section and is registered as before.

## Gotchas

- Documents that were requested before this rule existed are not affected.
- A line that ends with a question mark is a decision and needs its options right under it.
