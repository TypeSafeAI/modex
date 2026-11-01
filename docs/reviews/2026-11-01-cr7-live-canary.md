# CR-7 live-write canary: procedure (not run), 2026-11-01

Issue: [#326](https://github.com/TypeSafeAI/modex/issues/326) AC6, under [#319](https://github.com/TypeSafeAI/modex/issues/319).
Product: `main` at `0a8c513` or later. Writes, Merge and decisions 2–4 landed through #410 (`deb373a`) and #416
(`b3aad0d`, 2026-10-27).

**Status: not run.** Every write so far went to a synthetic `gh`. This page is the procedure for the one live
canary that the [2026-10-25 approval in AGENTS.md](../../AGENTS.md) allows: through the person's own `gh` login,
against a **disposable repository Val names**, and only after Val says go on #326. No repository has been named.
Never run it against `TypeSafeAI/modex` or any real pull request.

## What the canary may touch

Only the fixed endpoints main builds (AGENTS.md, 2026-10-25):

| Step | Endpoint main sends |
| --- | --- |
| Top-level comment | `POST repos/{o}/{r}/issues/{n}/comments` |
| Submitted review with one line comment | `POST repos/{o}/{r}/pulls/{n}/reviews` (`commit_id` = reviewed head) |
| Close / reopen | `PATCH repos/{o}/{r}/pulls/{n}` with only `state` |
| Convert to draft / ready for review | `POST graphql`, GitHub's `convertPullRequestToDraft` / `markPullRequestReadyForReview`, node id only |
| Edit title | `PATCH repos/{o}/{r}/pulls/{n}` with only `title` (refused if GitHub's title changed) |
| Request a reviewer | `POST repos/{o}/{r}/pulls/{n}/requested_reviewers` with only `reviewers` |
| Squash-merge | `PUT repos/{o}/{r}/pulls/{n}/merge` with `merge_method: squash` and `sha` = reviewed head |

No DELETE, no other GraphQL, no automatic resend. Anything else in the argv log below fails the canary.

## Preconditions (Val)

1. Name the disposable repository on #326, `<owner>/<disposable>`, and say go. It should be private, hold
   nothing of value, have no required checks or merge queue, and allow squash merges.
2. Create a throwaway PR there yourself (this is your own `gh`, outside the app):
   ```sh
   gh repo clone <owner>/<disposable> /tmp/cr7-canary-repo && cd /tmp/cr7-canary-repo
   git switch -c canary && printf 'one\ntwo\nthree\n' > canary.txt && git add canary.txt
   git commit -m "canary" && git push -u origin canary
   gh pr create --title "CR-7 canary" --body "Disposable PR for the Modex CR-7 canary."
   ```
3. For the reviewer step, a second account with read access to the repository. Without one, skip that step
   and record it as not run.

## Setup (agent or Val, about 5 minutes)

From `apps/desktop` in a worktree at the SHA under test, after `pnpm build`:

```sh
SHA=$(git rev-parse HEAD)
CANARY=~/.claude/task-evidence/cr7-canary-$(date -u +%Y-%m-%d); mkdir -p "$CANARY/bin" "$CANARY/home"
REAL_GH=$(command -v gh)
# A pass-through gh that logs each argv (no environment, no token) and then runs the real gh.
cat > "$CANARY/bin/gh" <<SH
#!/bin/sh
printf '%s\t%s\n' "\$(date -u +%FT%TZ)" "\$*" >> "$CANARY/gh-argv.log"
exec "$REAL_GH" "\$@"
SH
chmod 755 "$CANARY/bin/gh"
gh api user --jq .login > "$CANARY/login-before.txt"; gh auth status > "$CANARY/auth-before.txt" 2>&1
env -u MODEX_E2E -u MODEX_DEMO MODEX_HOME="$CANARY/home" MODEX_NO_LOGIN_PATH=1 \
  PATH="$CANARY/bin:$PATH" npx electron . 2> "$CANARY/electron-stderr.log"
```

In the app: `localStorage["modex.codeReview"] = "on"` from the developer tools of this throwaway home only
(it is a per-home setting, so the person's real home is unchanged), then Code Review → paste the throwaway
PR's link.

## Steps

For **each** step, record four things in `$CANARY/steps.md`: the preview text (screenshot of the confirmation:
account, destination, head and frozen body), main's re-check (the step's intent in
`$CANARY/home/review-actions/state.json` moving to sent or confirmed), exactly one new mutating line in
`gh-argv.log`, and the read-back (the app's state after it reads the PR again, plus one independent
`gh api` GET from a terminal).

| # | Action in the app | Independent read-back |
| --- | --- | --- |
| 1 | Comment composer → "Canary comment 1" → preview → send | `gh api repos/<o>/<r>/issues/<n>/comments --jq '.[].body'` |
| 2 | Changes → line 2 of `canary.txt` → line comment → submit review as Comment | `gh api repos/<o>/<r>/pulls/<n>/reviews --jq '.[] \| [.state,.commit_id]'` and `…/pulls/<n>/comments --jq '.[] \| [.path,.line]'` |
| 3 | State menu → Close | `gh api repos/<o>/<r>/pulls/<n> --jq .state` → `closed` |
| 4 | State menu → Reopen | → `open` |
| 5 | State menu → Convert to draft | `--jq .draft` → `true` |
| 6 | State menu → Ready for review | `--jq .draft` → `false` |
| 7 | Edit pull request → title "CR-7 canary (edited)" | `--jq .title` |
| 8 | Reviewers + → the second account (or record "not run") | `gh api repos/<o>/<r>/pulls/<n>/requested_reviewers --jq '.users[].login'` |
| 9 | Merge → Squash → preview names the head → confirm | `--jq '[.merged, .merge_commit_sha, .head.sha]'`; `.head.sha` equals the previewed head |

Double-click each confirm button once on purpose (step 1 and step 9 at least): `gh-argv.log` must still show
one send. If any outcome reads unknown, do not send again: use *Check GitHub*, and record what the read-back
proved. A step that fails is recorded as failed with its screenshot; the canary stops there.

## Closing checks

```sh
gh api user --jq .login | diff - "$CANARY/login-before.txt" && echo login-unchanged
grep -E -- '--method (POST|PUT|PATCH|DELETE)' "$CANARY/gh-argv.log"   # main's argv form; expect 9 lines (8 if step 8 was skipped), each matching the table above
grep -cE -- '--method DELETE' "$CANARY/gh-argv.log"                     # must be 0
# The token must appear nowhere Modex wrote (prints file names only, never the token):
gh auth token | grep -rlF -f - "$CANARY/home" "$CANARY/electron-stderr.log" "$CANARY/steps.md" && echo TOKEN-FOUND || echo token-absent
```

Then copy `$CANARY/steps.md`, the screenshots and the argv log (they contain only the disposable repository's
text) into a dated receipt under `docs/reviews/`, record the SHA, `gh --version`, macOS version, and mark #326
AC6 and the matrix's live-write cells with what actually ran. Delete the disposable repository afterwards if
Val wants (that is Val's own action; Modex has no DELETE).

## Limits this canary does not remove

- The intent marker stays visible in the posted Markdown.
- A review's read-back matches its body, author and head, not each line comment.
- GitHub has no precondition on PATCH: an edit made on GitHub between main's check and its PATCH is overwritten.
- A merge queue set by classic branch protection is invisible to the rules read; the disposable repository
  should have none.
