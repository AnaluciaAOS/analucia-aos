# E_SECRET

Who acts: `owner`

## What happened

`aos check-push` found an added line in a pushed commit that matches a pattern of `plugins/analucia/core/secret-patterns.json` (GitHub token, Anthropic key, AWS access key, private key block, Resend key). The message names the commit, the file, the line and the pattern, never the value (SPEC-0004 §5).

## What to do next

**Remove the secret from the listed commit and file, rotate it at its provider, then push again.** (owner)

1. Executor: stop with outcome `blocked` and report the listed file and line; do not print the value.
2. Owner: rotate the credential at its provider first (it may already be exposed locally), through a `high` order.
3. Then remove it from the commit (amend, or a new commit that removes it if the commit is not the last; history rewrite needs the owner) and keep the real value in a secret store, never in the repo.

## Patterns

- Read secrets from the environment or a vault at run time; tests build fake tokens at run time.

## Trade-offs

- Pattern matching can miss unusual secrets and can flag a look-alike; a false positive costs a review, a miss costs a rotation.

## Gotchas

- Evidence reports with raw command output are scanned too.
- Deleting the line in a later commit is not enough: the old commit still carries it.
