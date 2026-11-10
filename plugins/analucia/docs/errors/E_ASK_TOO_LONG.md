# E_ASK_TOO_LONG

Who acts: `director`

## What happened

The body of `.analucia/asks/ASK-NNNN.md` (the question in plain words) is longer than 600 characters (SPEC-0004 §1).

## What to do next

**Shorten the question in the ask file to at most 600 characters and move details to refs.** (director)

1. Director: rewrite the question; put background in a referenced record (`refs: [OBS-NNNN]`); check with `node plugins/analucia/bin/aos.mjs validate`.

## Patterns

- One question, one decision: what is asked, the recommendation, and what each option causes.

## Trade-offs

- A hard limit forces clarity; long context lives in the referenced records.

## Gotchas

- The limit counts characters of the body only, not the front matter.
