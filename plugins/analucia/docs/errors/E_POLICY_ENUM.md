# E_POLICY_ENUM

Who acts: `owner`

## What happened

`project.json` has a `deploy.policy` outside the closed list `deploy_policies`.

## What to do next

**Set deploy.policy in .analucia/project.json to one of the deploy_policies (batch or continuous).** (owner)

1. Owner: edit `.analucia/project.json`; check with `node plugins/analucia/bin/aos.mjs validate`.

## Patterns

- Use the `aos` commands for every state change; they apply the rules for you.

## Trade-offs

- `batch` groups deploys for review; `continuous` ships each change.

## Gotchas

- Nothing was written when this error appeared; fix the cause and run the command again.
