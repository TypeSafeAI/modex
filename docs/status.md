# Where things stand

The living map of what has shipped, what is on `main` but unreleased, what is in flight, and
what is next. Update it in the same PR that changes any of those; a reader should be able to
plan the next session from this page alone. Release evidence lives in [`reviews/`](reviews/).

_Last updated 2026-09-29 (v0.0.4)._

## Shipped

| Release | Date | Merge | Headline |
| --- | --- | --- | --- |
| v0.0.1 | 2026-09-26 | — | First macOS build: two backends, Auto routing, worktree threads, Changes panel. |
| v0.0.2 | 2026-09-28 | #33 | Desktop lifecycle races, Changes safety, streaming performance, layout persistence. [Review](reviews/2026-09-28-release-review.md). |
| v0.0.3 | 2026-09-28 | #34 | Embedded terminal panel ships; unsent text stays with its thread; inactive test window. [Review](reviews/2026-09-28-v0.0.3-release-review.md). |
| v0.0.4 | 2026-09-29 | #37 | Threads name themselves; one suggested next step after each turn. [Review](reviews/2026-09-29-v0.0.4-release-review.md). |

Every release so far is macOS Apple Silicon, ad-hoc signed, not notarized. The release
sequence (worktree → review doc → dist + packaged e2e → guarded merge → signed tag → GitHub
release with `SHA256SUMS.txt`) is spelled out in the v0.0.3 review.

## On `main`, not yet released

Nothing. v0.0.4 released everything that had landed since v0.0.3.

## In flight

Nothing. As of 2026-09-29 the repository has no parked
branches: `chat-workspace` (its follow-up work was extracted into #36), `livestream-privacy` (created empty, never
used), `release-0-0-3` and `docs/discovery-and-sharing-2026-09-26` (both merged) were
removed, and the two Copilot CI PRs (#30, #31) were closed as superseded — they predated the
terminal panel and would have removed it, and the failure they targeted no longer reproduces.

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

## Next

Roughly in the order they earn their place; none is scheduled.

1. **Notarized macOS build and a custom app icon.** Every release note has carried "ad-hoc
   signed, not notarized"; Gatekeeper friction is the first thing a new user meets.
2. **Auto-update**, once builds are notarized.
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
