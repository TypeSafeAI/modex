# Where things stand

The living map of what has shipped, what is on `main` but unreleased, what is in flight, and
what is next. Update it in the same PR that changes any of those; a reader should be able to
plan the next session from this page alone. Release evidence lives in [`reviews/`](reviews/).

_Last updated 2026-10-01._

## Shipped

| Release | Date | Merge | Headline |
| --- | --- | --- | --- |
| v0.0.1 | 2026-09-26 | — | First macOS build: two backends, Auto routing, worktree threads, Changes panel. |
| v0.0.2 | 2026-09-28 | #33 | Desktop lifecycle races, Changes safety, streaming performance, layout persistence. [Review](reviews/2026-09-28-release-review.md). |
| v0.0.3 | 2026-09-28 | #34 | Embedded terminal panel ships; unsent text stays with its thread; inactive test window. [Review](reviews/2026-09-28-v0.0.3-release-review.md). |
| v0.0.4 | 2026-09-29 | #37 | Threads name themselves; one suggested next step after each turn. [Review](reviews/2026-09-29-v0.0.4-release-review.md). |

Every release so far is macOS Apple Silicon. v0.0.1–v0.0.4 are ad-hoc signed; from v0.0.5
they are Developer ID signed and notarized. The release
sequence (worktree → review doc → dist + packaged e2e → guarded merge → signed tag → GitHub
release with `SHA256SUMS.txt`) is spelled out in the v0.0.3 review.

## On `main`, not yet released

- **Signed and notarized macOS builds** (`notarize`, 2026-10-01). Developer ID signature,
  hardened runtime with library validation kept on, notarized and stapled, verified by
  `scripts/release-mac.sh`, which also runs in the new `Release` workflow on a `v*` tag and
  fails closed without secrets. First release to carry it will be v0.0.5. See
  [release-signing.md](release-signing.md). Since #53 the script builds only in a worktree and
  checks its dependencies before asking for credentials.
- **Terminals no longer leak a PTY each** (`fix-pty-leak`, 2026-10-01). node-pty 1.1.0's macOS
  spawn opened a placeholder `/dev/ptmx` and never closed it, so every terminal session held
  one until Modex quit; macOS allows 511 machine-wide (`kern.tty.ptmx_max`). node-pty is now
  pinned to `1.2.0-beta.15`, where upstream closes it (and a per-spawn `kqueue`). Move to 1.2.0
  stable when it ships.

## In flight

- **Approval rules (Jev-gated).** Part 1 (#54) merged with the gate off and no UI: every
  backend's approval request carries an action, `engine/approvals/digest.ts` builds the
  scrubbed state Jev sees, and `engine/approvals/gate.ts` decides allow, ask or never. Part 2
  adds Settings → Approval rules with a "Try it" box, receipts on approval cards, the
  `(rule: …)` deny reason, `e2e/approvals.spec.ts`, and the docs, then turns the gate on. It
  targets v0.0.6 and merges only after the v0.0.5 tag. Its Settings UI builds on #51, so it
  waits for #51 to land. Receipts, the deny reason and the docs can start now. The spec
  (`2026-10-01-modex-jev-approval-rules-spec.md`, named in #54) records the part 2 decisions.
  By default a new rule covers the current project, and rules that need Jev show as inactive
  without it rather than being hidden.
- **Open contributor PRs.**
  - #51 `jev-integration`: Jev settings, routing limits, and settings save transactions.
    It conflicts with `main` and needs a rebase before review.
  - #60 (rename diffs in Changes), #61 (early `runner.send` rejections reach `thread:send`),
    #62 (`worktree.sh` falls back to the local `origin/main` when offline). These are fork
    PRs, so their CI runs wait for a maintainer's approval.
  - #39: logo, banner and icon concepts under `docs/branding/`, placed in the README. It may
    supply the app icon for v0.0.5.
- **Worktrees with no PR yet.** Each should become a PR or be deleted.
  - `auth-retry` (uncommitted): a failed turn ends in a card with Retry, a fix and Copy
    details. When Codex's sign-in goes stale, Modex restarts `codex app-server` and retries.
  - `pr-review-browser` (uncommitted): runs the renderer in a browser, connected to the real
    engine over a localhost bridge.
  - `livestream-redaction` (one unpushed commit, 2026-09-29): Streamer Mode, an opaque cover
    over chats, paths, terminals and diffs while work continues underneath.

## Known rough edges

- **Layout e2e can measure the terminal panel mid-animation.** The panel rises 6 px over
  180 ms on entry; CI saw 2–3 px of offset on one of two runs of the same commit (PR #35). The
  assertion now polls for the settled bottom edge; other sub-pixel checks in
  `e2e/layout.spec.ts` that follow a transition may need the same.
- **Local e2e on a machine in use.** The test window is shown inactive under `MODEX_E2E`
  (v0.0.3); if a run still garbles terminal input, nothing else should be typed while it runs.
- **Auto-titles run a real CLI turn.** It is a separate, non-resumed conversation with tools
  refused, but it does consume one small model call per new thread on Claude and Codex.
- **Title quality and Jev's follow-up picks are unproven by the suite.** The mock backend does
  not name threads and e2e runs without a key; only the heuristic path is exercised.
- **The cleanup-timeout test failed once on CI, cause unknown.** *cleanup timeout retains
  ownership and a later close can retry* (`test/terminal-cleanup.test.ts`) failed on #63, a
  docs-only change: the supervisor it froze with `SIGSTOP` was gone, exited and reaped, within
  56 ms. It has not reproduced locally in over 1,300 attempts on macOS 26, including runs under
  CPU load and alongside the full suite. The test now reports how `close()` settled and the
  supervisor's exit instead of failing on its `SIGCONT` cleanup. If it fails again, exit code
  143 means the `SIGSTOP` never held, signal 9 that something killed the supervisor, and 125
  that it failed at startup.

## Next

Roughly in the order they earn their place; none is scheduled.

1. **v0.0.5** with the notarized build, plus a custom app icon (the one visible gap left in
   the first-run experience; #39 has a candidate). Populate the `release-signing` CI
   environment first so the tag push produces the artifacts.
2. **Auto-update.** Unblocked now that builds are notarized.
3. **Image attachments** in the composer (both CLIs accept them).
4. **Windows and Linux installers.** The terminal supervisor and login-shell PATH probing are
   the platform-specific pieces to audit first.
5. **Codex Cloud tasks and scheduled automations.** Out of scope until the local story is
   complete; Modex stays CLI-only for coding turns (no API execution mode — see `AGENTS.md`).

## Conventions that keep this page true

- One worktree per session (`scripts/worktree.sh new <slug>`), removed after the merge. A
  branch that is not being worked on is either extracted into a PR or deleted; nothing parks.
- PRs merge through `~/.claude/scripts/gh-merge-when-green.sh <pr> --squash` after CI, with
  signed commits only.
- A PR that changes scope updates this page and, for user-facing behaviour, the README.
