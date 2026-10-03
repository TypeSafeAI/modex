# Where things stand

The living map of what has shipped, what is on `main` but unreleased, what is in flight, and
what is next. Update it in the same PR that changes any of those; a reader should be able to
plan the next session from this page alone. Release evidence lives in [`reviews/`](reviews/).

_Last updated 2026-10-03._

## Shipped

| Release | Date | Merge | Headline |
| --- | --- | --- | --- |
| v0.0.1 | 2026-09-26 | — | First macOS build: two backends, Auto routing, worktree threads, Changes panel. |
| v0.0.2 | 2026-09-28 | #33 | Desktop lifecycle races, Changes safety, streaming performance, layout persistence. [Review](reviews/2026-09-28-release-review.md). |
| v0.0.3 | 2026-09-28 | #34 | Embedded terminal panel ships; unsent text stays with its thread; inactive test window. [Review](reviews/2026-09-28-v0.0.3-release-review.md). |
| v0.0.4 | 2026-09-29 | #37 | Threads name themselves; one suggested next step after each turn. [Review](reviews/2026-09-29-v0.0.4-release-review.md). |
| v0.0.5 | 2026-10-03 | #69 | First Developer ID signed and notarized build, from the protected `Release` workflow; the Modex app icon; Jev settings and routing limits (#51); terminals no longer leak a PTY each. [Review](reviews/2026-10-03-v0.0.5-release-review.md). |

Every release so far is macOS Apple Silicon. v0.0.1–v0.0.4 were ad-hoc signed; from v0.0.5
releases are Developer ID signed (Soul Protocol LLC), notarized and stapled. The release
sequence (worktree → review doc → signed build + packaged e2e → guarded merge → signed tag →
the `Release` workflow, behind the `release-signing` reviewer → GitHub release with
`SHA256SUMS.txt`) is in [release-signing.md](release-signing.md#cutting-a-release).

## On `main`, not yet released

- **Panel layout (#74).** Hiding the sidebar keeps the draft and thread centered in the
  remaining main pane. Optional sidebar and Changes panes have fixed grid positions;
  geometry e2e checks cover toggles, narrower windows, relaunch, and the open terminal.
- Changes can discard intent-to-add files and staged additions with further edits, including
  before a repository's first commit (#72).
- The terminal cleanup EPIPE test now drains its fixture's PTY output before blocking the
  event loop and reports the supervisor's process state if `SIGKILL` still stalls (#64).
- Rename diffs handle a rewritten destination beginning with `-`; Git failures now appear
  as errors in Changes rather than as empty diffs (#60).
- The desktop shell uses a cooler graphite palette with clearer secondary text and subtle
  depth across navigation, transcript, and composer. The follow-up suggestion no longer
  overlaps the composer placeholder. Offline screenshot capture uses an isolated heuristic
  route and writes to the requested directory.

## In flight

- **Approval rules (Jev-gated).** Part 1 (#54) merged with the gate off and no UI: every
  backend's approval request carries an action, `engine/approvals/digest.ts` builds the
  scrubbed state Jev sees, and `engine/approvals/gate.ts` decides allow, ask or never. Part 2
  adds Settings → Approval rules with a "Try it" box, receipts on approval cards, the
  `(rule: …)` deny reason, `e2e/approvals.spec.ts`, and the docs, then turns the gate on. It
  targets v0.0.6; v0.0.5 shipped without it. Its Settings UI builds on #51, which has
  landed. Receipts, the deny reason and the docs can start now. The spec
  (`2026-10-01-modex-jev-approval-rules-spec.md`, named in #54) records the part 2 decisions.
  By default a new rule covers the current project, and rules that need Jev show as inactive
  without it rather than being hidden.
- **Worktrees with no PR yet.** Each should become a PR or be deleted.
  - `auth-retry` (uncommitted): a failed turn ends in a card with Retry, a fix and Copy
    details. When Codex's sign-in goes stale, Modex restarts `codex app-server` and retries.
  - `pr-review-browser` (uncommitted): runs the renderer in a browser, connected to the real
    engine over a localhost bridge.
  - `livestream-redaction` (one unpushed commit, 2026-09-29): Streamer Mode, an opaque cover
    over chats, paths, terminals and diffs while work continues underneath.

## Known rough edges

- **node-pty is a pre-release.** v0.0.5 ships `node-pty@1.2.0-beta.15` (#65), because 1.1.0
  leaks one `/dev/ptmx` per terminal on macOS. The beta passed the unit suite and the packaged
  e2e, including a test that counts the shipped app's PTY handles, with library validation
  on. Move to 1.2.0 stable when it ships.
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

1. **Auto-update.** Unblocked now that builds are notarized.
2. **Image attachments** in the composer (both CLIs accept them).
3. **Windows and Linux installers.** The terminal supervisor and login-shell PATH probing are
   the platform-specific pieces to audit first.
4. **Codex Cloud tasks and scheduled automations.** Out of scope until the local story is
   complete; Modex stays CLI-only for coding turns (no API execution mode — see `AGENTS.md`).

## Conventions that keep this page true

- One worktree per session (`scripts/worktree.sh new <slug>`), removed after the merge. A
  branch that is not being worked on is either extracted into a PR or deleted; nothing parks.
- PRs merge through `~/.claude/scripts/gh-merge-when-green.sh <pr> --squash` after CI, with
  signed commits only.
- A PR that changes scope updates this page and, for user-facing behaviour, the README.
