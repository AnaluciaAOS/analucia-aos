# E_PROTECTED_PUSH

Who acts: `executor`

## What happened

A `git push` made inside an agent session would update a protected branch (`protected_branches` of `.analucia/project.json`; `main` and `master` when the key is absent). The push guard (`aos check-push`) refused it: nothing left the computer. This is the second lock behind the permission profile of `aos permissions write`, which asks before such a push.

## What to do next

**Push the branch of your order instead; only the owner brings work to a protected branch, with the step to main of aos sign, at their own terminal.** (executor)

1. `git push -u origin <the branch of the order>`.
2. Tell the owner, in the report, that the work is ready to bring to the protected branch: `aos sign` offers the step.

## Patterns

- A push that names a branch that is not protected does not ask the owner for a permission and is not refused here; account, trailers and secrets are still checked.
- The owner's own pushes (the sign-off and the step to main, run by `aos sign` at the owner's terminal) are not affected.

## Trade-offs

- The guard tells an agent session by the environment Claude Code gives the commands it runs. A push made by hand from the owner's own terminal is not an agent session.

## Gotchas

- Force pushes are denied by the permission profile before they get here.
