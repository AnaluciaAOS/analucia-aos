# Moving a project to another repository

For the owner. Use this when a project moves to a new place on GitHub, for example from a personal account to an organization (as this repository did on 2026-10-28). Plan about 30 minutes. The automatic `aos migrate --check` does not exist yet; this page is the manual way.

## Before the move

1. **Save the current work.** Commit what is finished, then run a backup of the rest:
   ```
   node plugins/analucia/bin/aos.mjs backup
   ```
2. **Check the log.** It must say "hash chain intact":
   ```
   node plugins/analucia/bin/aos.mjs verify-log
   ```
3. **Look for secrets by hand.** Open the files that could hold a password, key or token (`.env` files, settings, scripts that call other services) and make sure none of them is tracked by git. `git ls-files` lists every tracked file. A secret must never travel with the repository: if you find one, stop and ask the director for a rotation order first.

## The move

4. **Move the repository** on GitHub (repository settings, "Transfer"), or create the new one and push to it. Only the owner does this.

## After the move

5. **Point this computer at the new address.** Keep the same account in the address, and never put a password or token in it:
   ```
   git remote set-url origin https://<your-account>@github.com/<new-owner>/<repository>.git
   git ls-remote origin
   ```
   `git ls-remote` must answer without asking you to choose an account.
6. **Check again:**
   ```
   node plugins/analucia/bin/aos.mjs verify-log
   node plugins/analucia/bin/aos.mjs check-push
   ```
7. **Update the places that name the old address:** the install commands in `README.md` and on the site, and the project settings that name the marketplace (`node plugins/analucia/bin/aos.mjs permissions write` rewrites them from the new address). The director does this through an order.
8. **Rotate any token that stops working.** If a deploy key, an app or a service lost access after the move, create a new token at that service, store it in your password manager, and put it where it is needed outside the repository. Never commit it.

## If something fails

After this repository's transfer, the old address still answered `git ls-remote` with the same commit (checked on 2026-10-28), so a failed step loses nothing. Go back to step 5, and if `git ls-remote` still fails, stop and tell the director exactly what it printed.
