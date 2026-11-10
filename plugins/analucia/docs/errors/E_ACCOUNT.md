# E_ACCOUNT

Who acts: `owner`

## What happened

The push guard (`aos check-push`, run by the `pre-push` git hook) found that the user in the remote URL or the stored credential user is not the project `github_owner`. The push was refused before anything left the machine.

## What to do next

**Point the remote URL user and credential.https://github.com.username at the github_owner of .analucia/project.json, then push again.** (owner)

1. The owner runs, in the repo, the commands the refusal printed: they carry the real account and repository, and only what differs is listed (`git remote set-url origin …` when the URL user differs, `git config credential.https://github.com.username …` when the stored credential user differs).
2. `node plugins/analucia/bin/aos.mjs init --check` prints the same commands, plus one `git -c credential.https://github.com.username=… ls-remote …` line that signs in with that account when the machine keeps another GitHub sign-in.
3. Check with `node plugins/analucia/bin/aos.mjs check-push` (exit 0), then `git push` again.
4. Agents: stop with outcome `blocked` and report the message; never pick an account.

## Patterns

- Bind each repo to one account with the user name in the remote URL; the credential manager then picks that account without a chooser.

## Trade-offs

- SSH remotes (`git@github.com:…`) always fail this check, because their user is `git`. Use HTTPS remotes with the owner user.

## Gotchas

- If `github_owner` is missing from project.json, every push is refused until the owner sets it.
- An account chooser or login window means the binding is wrong: stop, do not choose.
