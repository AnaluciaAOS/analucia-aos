---
id: SPEC-0006
title: Analucia AOS — Adoption audit (aos adopt) for projects already under way
status: approved-pending-owner
version: 0.1.0
language: en
extends: SPEC-0005
---

# Adoption audit

Status note: owner decision Q-107 is pending in the sheet. The executor builds this only after Q-107 is approved.

## 1. Why

`aos init` assumes a project that starts. Most owners arrive with a project that is already far along: committed secrets, files that should not be versioned, backups nobody checks, code that lives on one machine. The audit reads that project **before the first order** and gives the owner a baseline and a short list of orders to approve.

## 2. Principles

- **Read only.** The audit writes nothing except its own report and one event. It never edits, deletes, moves or rotates anything.
- **Never prints a secret.** A finding names the **kind**, the **file**, the **commit** and the **line number**, never the value, not even a masked part.
- **Says what it could not check.** A check that cannot run reports `not_verified`, never "clean".
- **Same facts, same result.** Running it twice on an unchanged project gives the same findings.
- **No judgment of people.** Findings describe files and facts, not who did them.

## 3. Command

`aos adopt [--root <dir>] [--locale en|es|pt|zh-Hans|hi]`

- `aos init` calls it when the repository has more than 20 commits or more than 50 tracked files. The owner may skip it (`--no-audit`); the skip is logged as an event.
- Exit 0: no finding of severity `high`. Exit 1: at least one `high` finding. Exit 2: the audit could not run.
- Output: `.analucia/views/adoption.md` (fixed texts in the project locale; ids and codes stay in English) and one event `adoption.audited` (level `observed`) with the counts per severity and the finding ids. The event holds no values and no paths outside the repo.

## 4. Checks

Each finding has an id `AD-NNN`, a severity (`high`, `medium`, `low`, `info`), a kind, a location and a `next (<who>)` line, as in SPEC-0005 section 5.

| Id | Check | Severity |
|---|---|---|
| AD-SECRET-TREE | A secret pattern in a tracked file (key formats of the common providers, private key blocks, password assignments in `.env`-like files, credentials in URLs). | high |
| AD-SECRET-HISTORY | The same patterns anywhere in the git history, including deleted files. Reports the first commit that introduced it. Deleting the file does not remove it from history. | high |
| AD-ENV | `.env`-like files tracked, or not ignored. | high |
| AD-HYGIENE | Binary or archive files larger than 5 MB tracked (zip, rar, bak, sql dumps); non-code files inside code folders; duplicated migration prefixes. | medium |
| AD-DOCS | Documents that name files, commands or ports that do not exist in the tree. | medium |
| AD-BACKUP | A backup or deploy script exists and has recent output. A scheduled job whose latest output is older than 48 hours, or whose recent runs all failed: `high`. Not visible from the repo: `not_verified`. | medium |
| AD-SPOF | Code only on one machine: no remote, unpushed commits, or large untracked source files. | high |
| AD-TESTS | A test command exists and runs. Without one: `medium`. | medium |
| AD-DEPS | A lockfile exists; packages declared with no version. | low |
| AD-BRANCH | Protected branch is not verifiable from the repo: always `not_verified`, as in SPEC-0005. | info |

The secret patterns live in one file, `plugins/analucia/lib/secret-patterns.mjs`, shared with the secret guard of SPEC-0004, so both always agree.

## 5. Report and proposals

The report has four parts: **baseline** (commits, tracked files, languages by extension, tests found, last commit date), **findings** sorted by severity, **not verified**, and **proposed orders**.

- Each `high` secret finding proposes **one order to rotate the credential**, risk `high`, **owner only**, under the rule of Q-96. The order text lists the service and the place, never the value. Rotation is done by the owner at the provider. History cleaning is a second order and comes after rotating.
- Other findings propose `fix` orders of risk `low` or `medium`.
- Proposals are text. The audit does **not** create order files; the director writes them after the owner reads the report.

## 6. Baseline

The baseline is the reference for later measurement (AMD-0004, first hour). It is stored as the payload of the event, as numbers only.

## 7. Tests

Temporary repositories built at run time. Fake secrets are assembled from parts so the test files themselves pass the secret guard.

- a secret in the working tree gives `AD-SECRET-TREE` without printing it;
- a secret added and deleted in an old commit gives `AD-SECRET-HISTORY` with the first commit and nothing else;
- a tracked `.env` gives `AD-ENV`;
- a 6 MB tracked zip gives `AD-HYGIENE`;
- a repository with no remote gives `AD-SPOF`;
- a clean repository exits 0 and reports `not_verified` for what it cannot check;
- two runs give the same findings;
- the output and the event never contain the fake secret, in any part;
- all earlier tests still pass.
