# Launch-day checklist

The repository is made public only when every owner item is ticked. The tool items were run by ORD-0022, and their output is in `.analucia/evidence/ORD-0022/report.md`. Run them again on launch day, on the commit that will be tagged.

## Owner decisions (the tool cannot check these)

- [ ] **Product name.** "Analucia" is provisional. On the site it is one line in `site/style.css` (`--product-name`). The plugin, marketplace and repository names (`analucia`, `analucia-aos`) change only through an order.
- [ ] **Domain** for the site, if any.
- [ ] **Keys and `.env` values in a password manager.** Every key, token and `.env` value lives in the owner's password manager; none exists only on a laptop.
- [ ] **One encrypted copy of the reserved files** (the files kept outside the repository) in a personal cloud folder, with its password stored in the password manager.
- [ ] **The recovery recipe was read once** (`docs/RECOVERY.md`), so the owner knows how to rebuild the project on a new computer.
- [ ] **Licence.** Today `LICENSE` reads "All rights reserved", and the core is to be free and public at launch (Q-113). The owner decides the licence with the lawyer (ORD-0013), and it is committed through an order.
- [ ] **Keys rotated.** Every credential that was ever in a chat, a screenshot or the git history is rotated at its provider by the owner, through a `high` order (SPEC-0004, SPEC-0006). Run `aos adopt` and check that no `AD-SECRET-*` finding is open.
- [ ] **Contact address.** The site uses `hello@analuciaaos.com` (ORD-0025): the owner sends one test message to it and gets it.
- [ ] **Content signed.** The owner reads the rendered site (ORD-0021 report) and this README, and signs them (Q-84).
- [ ] **Director files committed.** Every order, amendment and verify file that the tests or the log refer to is committed with `.analucia/director.lock` (for example AMD-0006, which the drift test reads). A fresh clone fails without them.
- [ ] **Repository visibility** switched to public by the owner, on GitHub, after all the items above.
- [ ] **Tag.** `v0.2.0` (the version in `plugins/analucia/.claude-plugin/plugin.json`) on the signed commit. The owner creates and pushes it.

## Owner configuration (kept out of the public tree)

The owner's real values live in owner configuration, never in code, tests or docs (ORD-0030):

- `.analucia/project.json` holds `github_owner`, the GitHub account the push guard compares with the remote URL user and the credential user. It is listed as private in `.analucia/release/manifest.txt`. The public tree carries `.analucia/project.example.json` instead, with neutral values; a new owner copies it to `.analucia/project.json` (or runs `aos init`) and sets their own account.
- The credential user (`git config credential.https://github.com.username`) and the remote URL user are set on each computer from that value (see step 4 of `docs/RECOVERY.md`).
- Tests and evaluations use the placeholder account `example` in temporary folders. They never read the owner's value, except the site check that the owner's account is not shown, which runs only where `.analucia/project.json` exists.

## Checked by the tool (re-run on launch day)

- [ ] Fresh clone into an empty folder: `node --test plugins/analucia/tests` passes with nothing outside the clone.
- [ ] `aos validate`, `aos verify-log` and `aos check-roles` exit 0.
- [ ] `aos init --check --dry-run` has no FAIL.
- [ ] `node scripts/release-guard.mjs <denylist>` exits 0. It scans every tracked file, `site/` included.
- [ ] `aos adopt` on the clone: every finding is listed, none is `high`, and no secret value is printed.
- [ ] `claude plugin validate ./plugins/analucia` and `claude plugin validate .` pass.
- [ ] `git status` is clean, and `HEAD` equals `origin/main` after the push through the pre-push guard.
