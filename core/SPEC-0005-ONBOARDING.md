---
id: SPEC-0005
title: Analucia AOS — Guided onboarding (aos init) and setup checks
status: approved            # owner decisions Q-04, Q-05, Q-06, Q-71, Q-72, Q-91, Q-92, Q-94, Q-96, Q-97, Q-98, Q-99, Q-102, "Estructura del arranque", "Arranque en tres momentos"
version: 0.1.0
language: en
extends: SPEC-0004
---

# Guided onboarding and setup checks

## 1. Principles (owner decisions)

- The onboarding asks **only what changes a mechanism** (Q-04). When the owner does not know, the **safest value** is used (Q-06) and said so.
- A re-run asks **only what changed** or is still missing. It never wipes an earlier answer without saying so.
- **"Ready" is proven by checks, not declared** (Q-04). Each check prints PASS, WARN or FAIL, and every WARN and FAIL comes with a `next (<who>)` line.
- The interview texts are **localized**: `en` (native), `pt`, `zh-Hans`, `hi`, `es` (Q-71, Q-72). Everything written to disk (keys, values, files, events) is English. The `pt`, `zh-Hans` and `hi` catalogs are marked `"reviewed": false` until a human reviews them.
- **Adopting an existing project** never deletes or rewrites anything outside the Analucia block and the Analucia files. A conflict, such as a CLAUDE.md with director instructions, is a FAIL with its next step, never an automatic edit.

## 2. Command

- `aos init [--locale en|pt|zh-Hans|hi|es]`: **owner TTY** (`E_OWNER_TTY` otherwise). An interactive interview in three moments, then the configuration, then the checks.
- `aos init --answers <file.json> [--dry-run]`: no TTY needed for `--dry-run`. Without `--dry-run` it needs the owner TTY and `CONFIRM`. This lets an agent prepare the answers, and the owner confirms them.
- `aos init --check`: runs only the checks of section 5 and prints the report. It exits 0 when there is no FAIL (WARN allowed) and 1 when there is at least one FAIL.
- The answers are saved to `.analucia/onboarding.json` (English keys, the locale used, a timestamp per answer). Applying them appends `operation.logged` `{"operation": "onboarding", "changed": [<keys>]}` with actor `owner`.

## 3. The interview

**Moment 1 — What project are you working on?**
| Key | Question (meaning) | Mechanism it sets | Safe default |
|---|---|---|---|
| `purpose` | What is it for, in one line | Shown in `resume.md` | — (required) |
| `in_use` | Is it already used by real people? (`no` / `yes`) | `yes` makes production work `high` risk | `yes` |
| `end_user_input` | Do its users send text that reaches an AI model? (`no` / `yes` / `unsure`) | `yes`/`unsure`: orders touching that flow are `high` and need an injection test (Q-97) | `unsure` |
| `how_verified` | How do you check it works? (tests / a page to look at / a person checks) | The default verify checks for new orders | `a person checks` |
| `never_leaves` | Data or files that must never leave this machine (free text) | Added to the protected and deny lists | — |
| `delivered_when` | When is a job delivered? | Text added to every order template | "when the checks pass and the owner looked at it" |
| `wip_limit` | How many jobs at once? | `project.json.wip_limit` | `1` |
| `external_artifacts` | Are there documents or code made by another AI, another person or a vendor? (list paths) | Recorded as `hypothesis` (Q-96); a credential found among them triggers the rotation advice | none |

**Moment 2 — How do you want to work?**
| Key | Question | Mechanism | Safe default |
|---|---|---|---|
| `github_owner` | Which GitHub account owns this repo? | `project.json.github_owner`, used by `check-push` | from the remote URL, confirmed |
| `cloud_sessions` | Will you run sessions in the cloud while your computer is off? (`no` / `yes`) | Adds the cloud-access check (Q-92) | `no` |
| `executor_tool` | Which AI is the executor? | Recorded in `role.declared` | `claude-code` |
| `approve_from` | Where do you sign? (`terminal` / `sheet`) | `sheet`: `aos ceo export` and `import` become the channel | `sheet` |
| `owner_locale` | Language for your views | `project.json.locale` (sheet texts, onboarding) | the locale of the interview |

**Moment 3 — Going live**
| Key | Question | Mechanism | Safe default |
|---|---|---|---|
| `deploy_target` | Where does it go live? (none / platform name) | Orders with deploy are `high` | `none` |
| `domain` | Domain, if any | Shown in `resume.md` | — |
| `budget_monthly_usd` | Monthly budget for infrastructure and AI, in USD | `project.json.budget_monthly_usd`; alerts at 50/80/100 % (Q-91) | ask; if unknown, `0` with the alert disabled, and say so |
| `risk_default` | Default risk for new orders | Used by the director when writing orders; also selects the permission profile (Q-99) | `medium` |

## 4. Configuration written

All idempotent, and each one is reported as created / unchanged / updated:
1. `.analucia/project.json` with the keys above. Existing keys that the interview does not own are kept.
2. The `.analucia/` folders of SPEC-0001 §9.
3. `aos agents-md sync`, and a `CLAUDE.md` containing `@AGENTS.md`. When CLAUDE.md already has other content, the import line is **added on top** and nothing else is touched.
4. `aos permissions write`, with the profile chosen by `risk_default`. `high` adds `ask` for any write outside the repo.
5. `aos install-git-hooks`.
6. `.gitattributes` with `.analucia/** text eol=lf`.
7. `aos role declare director --scope <director paths>` (Q-102).

## 5. Checks (`aos init --check` and the end of `aos init`)

| Check | PASS when | Otherwise |
|---|---|---|
| `tools` | `node` ≥ 20 and `git` found; the Claude Code CLI found on PATH or in `$HOME/.local/bin` | FAIL (node/git); WARN (Claude CLI), with where to install it |
| `repo` | Inside a git work tree with an `origin` remote | FAIL |
| `account` | The remote URL user and `credential.https://github.com.username` equal `github_owner` (Q-90) | FAIL, with the two commands that bind them |
| `remote_https` | The remote uses HTTPS (SSH needs keys most owners lack; lesson of 2026-10-21) | WARN, with the HTTPS command |
| `reachable` | `git ls-remote origin` succeeds within 30 s, using stored credentials only (no prompt: `GIT_TERMINAL_PROMPT=0`) | FAIL, with "sign in once with your credential manager" |
| `plugin_active` | A `role.declared` with `"source": "startup"` exists in the log, so a session ran with the hooks | WARN, with the exact HTTPS install commands: `claude plugin marketplace add https://<owner>@github.com/<owner>/<repo>.git` and `claude plugin install analucia@<marketplace> --scope project` |
| `branch_protection` | Not detectable without a token, so this is always WARN on private repos: "if your plan allows branch protection, require the `aos verify` check; otherwise the control is the pre-push guard + `aos verify`" (Q-98) | WARN |
| `cloud_access` | Only when `cloud_sessions = yes`: always WARN, with the steps to grant the cloud GitHub connector access to this repo (Q-92) | WARN |
| `secrets_tracked` | No tracked file matches `secret-patterns.json` (file and line printed, never the value) | FAIL, with "rotate first (high order), then remove" (Q-101) |
| `env_ignored` | Any `.env*` file present is git-ignored | FAIL |
| `inventory` | Always PASS. It records what exists (README, package manifests, CLAUDE.md/AGENTS.md blocks, existing orders, commit count, languages by file extension) as `operation.logged` `{"operation": "inventory", "level": "observed", ...}` (Q-94) | — |

The report is printed and saved to `.analucia/views/onboarding.md`.
