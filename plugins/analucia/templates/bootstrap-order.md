---
id: ORD-0001
title: Bring the commits that predate the Loop under an order and make the first push through the guard
kind: migration
created: {created}
budget_max_minutes: 60
budget_max_attempts: 2
risk: medium
cost_effect: none
---

# ORD-0001 — First order of a project that already runs

**Role:** `executor`. This order was written by `aos init` (the bootstrap template of the plugin) because the project had commits before the Loop started. The owner placed it with `aos sign`.

**Why.** The push guard refuses every pushed commit that changes code and has no `Analucia-Order: ORD-NNNN` trailer. The commits made before the Loop have none, so the first push would be refused. This order brings them under an order once, and proves that the guard lets the project through.

## Steps

1. Read the state: `git status`, `git log --oneline`, `git remote -v` (never print a credential), and which commits are not on the remote yet: `git log --oneline HEAD --not --remotes`.
2. If the project has no remote, stop: finish with `blocked` and tell the owner that the first push needs one (`aos init --check` names the commands).
3. Commit the files that `aos init` wrote (AGENTS.md, CLAUDE.md, `.claude/settings.json`, `.githooks/`, `.gitattributes`, `.gitignore`, the launchers and `.analucia/`), with the trailer `Analucia-Order: ORD-0001`. Commit no secret and no `.env` file.
4. Commits that are **already on the remote** stay as they are: the guard does not look at them. Never rewrite a pushed commit.
5. Commits that are **not on the remote yet** and have no trailer: first make a safety copy (`git branch before-ORD-0001`), then add the trailer `Analucia-Order: ORD-0001` to each of them without changing their content, and check that `git diff before-ORD-0001 HEAD` is empty for the files they touched.
6. Push through the guard (`git push`; the pre-push hook runs `aos check-push`). If the guard refuses, do what its `next` line says; never push with `--no-verify`, never force.
7. Write the report `.analucia/evidence/ORD-0001/report.md` (template: `plugins/analucia/templates/report.md`): how many commits predated the Loop, how many were already on the remote, how many received the trailer, and the result of the push.

## Out of scope

Any change to the code of the project; rewriting commits that are already on the remote; changing the remote or the account.

## Acceptance criteria

- [ ] The files written by `aos init` are committed with the trailer of this order.
- [ ] Every commit of the branch is on the remote, pushed through the guard (no `--no-verify`, no force).
- [ ] No pushed commit was rewritten; a safety branch exists if any commit message was changed.
- [ ] The report gives the counts and ends with `OUTCOME: <outcome>`.
