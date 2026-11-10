# E_ANSWER_VALUE

Who acts: `owner`

## What happened

`aos init` got an onboarding answer it cannot use: a value outside the allowed list (for example `in_use: maybe`), a number where a whole number is needed, an invalid GitHub account name, or an unsupported locale (SPEC-0005 §3). Nothing was written.

## What to do next

**Fix the named answer to one of the allowed values (or write unknown to use the safe default) and run aos init again.** (owner)

1. Owner: edit the answers file (or answer again in the interview); allowed values are in the message and in `node plugins/analucia/bin/aos.mjs init` help lines.
2. `unknown` is always accepted except for `purpose`: the safe value is used and the plan says so.
3. Check first with `node plugins/analucia/bin/aos.mjs init --answers <file> --dry-run`.

## Patterns

- Let an agent prepare the answers file; the owner reviews the dry run, then applies it from their own terminal.

## Trade-offs

- Strict values keep the configuration mechanical; free text belongs in `purpose`, `delivered_when` and `never_leaves`.

## Gotchas

- Values are English even when the interview is in another language (`yes`, not `sí`).
