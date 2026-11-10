# Recovery: from a new computer to a working project

Goal: if this computer is lost, a new one with nothing installed is working again in about one hour. No computer is indispensable: the code, the orders, the log and the latest backup live on GitHub; the secrets live in the owner's password manager.

## What the repository alone cannot rebuild

- **Secrets:** keys, tokens and `.env` values. They are never committed and never in a backup. They come from the password manager (step 5).
- **Reserved files kept outside the repository** (for example the owner's sheet and the release denylist). They come from their encrypted copy in the owner's personal cloud (step 5).
- **Settings of this computer:** the git credential user and the push guard (`core.hooksPath`) are local git settings, so step 4 sets them again. The sign-in to the Claude app and to GitHub is done again by the owner.
- **Work never saved:** anything that was neither committed nor saved with `aos backup` before the computer was lost.

## 1. Install the tools (about 20 minutes)

Install, from each project's official installer: **Git**, **Node.js 20 or later**, and the **Claude app** (Claude Code). Then check, in a new terminal:

```
git --version
node --version
claude --version
```

## 2. Get the project (about 5 minutes)

```
git clone https://github.com/AnaluciaAOS/analucia-aos.git
cd analucia-aos
```

The repository belongs to the GitHub organization `AnaluciaAOS`. The first clone may ask the owner to sign in to GitHub with the owner account that has access to it. That account, and no other. Its name is owner configuration: the `github_owner` value in `.analucia/project.json`, which stays out of the public tree (see "Owner configuration" in `docs/RELEASE-CHECKLIST.md`). Step 4 reads it from there.

## 3. Use the latest backup if it is newer than `main`

```
git fetch origin "refs/heads/backup/*:refs/remotes/origin/backup/*"
git for-each-ref --sort=-committerdate --format="%(committerdate:iso8601) %(refname:short)" refs/remotes/origin/main refs/remotes/origin/backup/
```

The first line is the newest. If it is an `origin/backup/YYYY-MM-DD` branch, continue from it in a branch of its own (main is not changed; the director brings it into main through an order):

```
git switch -c restore-YYYY-MM-DD origin/backup/YYYY-MM-DD
```

If the first line is `origin/main`, stay on `main`.

## 4. Set this computer's guards (about 2 minutes)

```
git config credential.https://github.com.username "$(node -p "require('./.analucia/project.json').github_owner")"
git remote set-url origin "https://$(node -p "require('./.analucia/project.json').github_owner")@github.com/AnaluciaAOS/analucia-aos.git"
node plugins/analucia/bin/aos.mjs install-git-hooks
claude plugin marketplace add AnaluciaAOS/analucia-aos
claude plugin install analucia@analucia-aos --scope project
```

## 5. Bring the secrets and reserved files back (about 10 minutes)

- From the password manager, write each `.env` file the project needs. They are ignored by git and never leave this computer.
- From the personal cloud, open the encrypted copy of the reserved files (its password is in the password manager) and put them back where they were.

## 6. Check that everything works (about 10 minutes)

```
node plugins/analucia/bin/aos.mjs init --check
node --test plugins/analucia/tests
node plugins/analucia/bin/aos.mjs verify-log
```

`init --check` must show no FAIL, the tests must all pass, and `verify-log` must say "hash chain intact". Then open a Claude Code session in the folder: its first context starts with `Status: …`.

## Keep it working

At the end of each working session, save the current work, including what is not committed yet, to `backup/<today>` on GitHub, without changing the work in progress:

```
node plugins/analucia/bin/aos.mjs backup
```

`aos backup --restore-hint` prints how to bring the latest backup back.
