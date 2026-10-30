# Worktree and branch pruning

Release finished work explicitly. The daily job removes only clean, inactive local work
whose exact commit has landed and has a verified recovery bundle.

```sh
scripts/worktree.sh new fix-scroll
cd .worktrees/fix-scroll
scripts/worktree.sh check
# Work, verify, commit, push, and merge through a PR.
released_tip="$(git rev-parse HEAD)"
cd ../..
scripts/worktree.sh release fix-scroll --expect-head "$released_tip"
scripts/worktree.sh audit
scripts/worktree.sh prune --apply --branch fix-scroll
```

The final two commands are optional when the daily job is installed. `release` records
your intent for one exact tip; it does not delete anything or assert that the PR merged.
Run it only after saving your evidence outside the worktree and ending its session.
Close terminals, editors, and agents using the worktree. An open process preserves it.

## Ownership and enforcement

`new` claims the new branch and checkout under `.worktrees/<name>`. It refuses to reuse
an existing branch and installs dependencies with `pnpm install --frozen-lockfile`. Use
`--no-install` when you only need a checkout. `check` requires the matching branch, managed path, and active
claim. Before resuming a released or legacy worktree, run:

```sh
scripts/worktree.sh claim fix-scroll --owner my-session
```

Claims never expire by age. A release stops being eligible if the branch tip or registered
path changes. Existing worktrees without lifecycle records stay protected until their
owner explicitly releases them. A branch with no checkout can also be released by full
SHA; a missing or moved registered checkout is preserved for inspection.
Owner labels coordinate sessions; they are not authentication credentials. Each person or
agent must honor the owner-only release rule in `AGENTS.md`.

Use `scripts/worktree.sh remove <name>` for immediate cleanup after merge. It records
release intent and runs the same guard as scheduled pruning. If proof fails, it returns
an error and preserves the work. Reclaim it before resuming edits.

Modex's project-managed threads call this entry point. The app cannot override its
branch-retention decision or fall back to unmanaged removal when the script is missing.
Do not use `git branch -D`, `git worktree remove --force`, manual directory deletion, or
age-based sweeps to bypass the procedure. The maintenance lock coordinates these commands;
it cannot prevent another process from running raw Git commands.

## Required deletion evidence

Each run fetches the GitHub default branch without pruning refs and reads PRs through
`gh api` REST. Immediately before deletion it repeats the checks:

- The exact branch SHA and worktree path still have an explicit release record.
- The target is neither the primary checkout nor the default branch or `main`.
- The checkout is managed, registered, unlocked, attached, and clean, including untracked
  files. Hidden index flags, interrupted Git operations, Git locks, and unknown ignored
  data preserve it.
- `lsof` reports no process using the checkout. Missing tools, failed observations, and
  malformed GitHub responses preserve work. Any open PR for the branch blocks pruning.
- The exact tip is an ancestor of the freshly fetched default branch, or a merged PR has
  that exact repository, branch, and tip, and its reachable single-parent squash commit
  matches in one of three ways:
  - **Identical tree** (every path, mode, blob, and gitlink). This also covers branches that
    merged the default branch in before landing.
  - **Clean merge onto the squash's parent.** Git's own merge of the tip onto the squash's
    parent finishes without conflicts and gives the identical tree. This covers a merge queue
    squashing the branch onto a newer default branch than the one it last merged. A
    configured `merge.<name>.driver` turns this check off, because a driver can drop either
    side's changes and still report a clean merge.
  - **Identical complete binary diff.**

  Without a match, ambiguous merge histories stay preserved.
- A PR stacked on another branch counts only through that branch's own merged PR. The tip
  must pass the checks above against the merged head of the branch it targeted, and that
  head must in turn pass them against the default branch. The chain follows at most three
  branches. If any branch in it never merged, or merged a head without the stacked work,
  the tip is preserved.
- Archive refs and a self-contained bundle have been created, restored into an empty
  bare repository, checked for exact tip equality, and passed `git fsck --full`.

Git removes the worktree without force. Another fresh check precedes local branch deletion,
which compares the expected SHA. If that final check fails, the branch and archive remain.
These tools never delete remote branches. GitHub deletes a PR's head branch when the PR
merges (repository setting `delete_branch_on_merge`, on since 2026-10-15); merge proof reads
the merged PR over REST, so it never needs that branch. Stale registrations, locks, stashes,
and archives are never swept automatically.

The generated-data allowlist covers root `node_modules/` and `node_modules/`, `dist/`,
`test-results/`, and `playwright-report/` under the known app and core package directories.
Ignored `.env`, `.codex`, `.probes`, logs, release artifacts, and other unknown files
preserve the checkout. Move evidence you want to keep to durable storage yourself.

## Daily automation

On macOS, install the user LaunchAgent from reviewed code:

```sh
scripts/worktree.sh schedule install
scripts/worktree.sh schedule status
```

It runs at load/login and every 24 hours while your Mac is available, using your existing
GitHub CLI authentication. It performs `prune --apply` with the guards above. Its verified
runtime, repository identity, ownership records, logs, reports, and archives live under
the shared Git directory at `modex-maintenance/`, outside disposable worktrees. Installation
pins the runtime to its checksums and the repository's path and identity. Reinstall after
reviewing script changes, moving the repository, or changing executable locations.

`schedule status` reports the plist, runtime manifest, load state, and checksum verification.
Per-run JSON reports are in `modex-maintenance/schedule/reports/`; stdout and errors are in
`modex-maintenance/schedule/logs/`. A run with unavailable evidence preserves work and logs
the reason. Check these reports regularly, including for candidates that remain blocked.

```sh
pnpm worktrees:audit --json
pnpm worktrees:prune --apply
scripts/worktree.sh schedule uninstall
```

Uninstall unloads the job and removes its plist. It retains ownership records, reports,
runtime copies, and recovery archives. On other hosts, schedule the explicit pruning
command yourself. No remote or hosted workflow can inspect your local dirty state.

## Recover removed work

Each deletion batch prints a recovery manifest under
`modex-maintenance/archives/<run>/manifest.json`. It contains the original branch, tip,
path, merge proof, archive ref, bundle checksum, deletion outcome, and a shell-quoted
`restore` command. Run that exact command from a repository where you want the recovered
branch. It fetches the archived tip under a new `restored-…` branch name.

For an independent integrity check, compare the bundle's SHA-256 with `bundleSha256` in
the manifest, then restore its recorded tag into an empty bare repository and run
`git fsck --full`. Archives include history and can consume disk space; retain them until
you deliberately review their recovery value. The scheduler never ages them out.

A crashed maintenance process may leave `modex-maintenance/lock/owner.json`. Inspect its
PID and verify that no maintenance process or writer remains before removing that exact
lock directory. The job never steals a lock based on its age.

## Regression coverage

`pnpm test:worktrees` uses temporary Git repositories to verify preservation, exact merge
proof, archive restoration, concurrent changes, and schedule installation. It runs as part
of the normal `pnpm test` command and the protected CI check. Desktop retirement tests cover
project-script retention and missing-script refusal.
