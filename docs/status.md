# Where things stand

The living map of what has shipped, what is on `main` but unreleased, what is in flight, and
what is next. Update it in the same PR that changes any of those; a reader should be able to
plan the next session from this page alone. Release evidence lives in [`reviews/`](reviews/).

_Last updated 2026-09-29._

## Shipped

| Release | Date | Merge | Headline |
| --- | --- | --- | --- |
| v0.0.1 | 2026-09-26 | — | First macOS build: two backends, Auto routing, worktree threads, Changes panel. |
| v0.0.2 | 2026-09-28 | #33 | Desktop lifecycle races, Changes safety, streaming performance, layout persistence. [Review](reviews/2026-09-28-release-review.md). |
| v0.0.3 | 2026-09-28 | #34 | Embedded terminal panel ships; unsent text stays with its thread; inactive test window. [Review](reviews/2026-09-28-v0.0.3-release-review.md). |

Every release so far is macOS Apple Silicon, ad-hoc signed, not notarized. The release
sequence (worktree → review doc → dist + packaged e2e → guarded merge → signed tag → GitHub
release with `SHA256SUMS.txt`) is spelled out in the v0.0.3 review.

## On `main`, not yet released

- **Threads name themselves** (#35, 2026-09-29). After the first completed turn the same CLI
  is asked, in a throwaway chat conversation, for a 3–8 word title. Manual rename, deletion
  and quit cancel it. The mock backend has no naming, so demos and e2e are unchanged.
- **One suggested next step** (#36, 2026-09-29). A single follow-up
  prompt offered in the composer after a turn; Jev picks from a fixed list on Auto threads
  using typed completion facts, the heuristic otherwise. Extracted from the parked
  `chat-workspace` branch, whose other two pieces (terminal panel, unsent text) had already
  landed via #32 and #34. See [auto-routing.md](auto-routing.md#the-follow-up-question).

These two are the candidates for **v0.0.4**. Both add behaviour rather than fix it, so the
next release note should present them as features, with the usual review doc.

## In flight

Nothing beyond the follow-up PR above. As of 2026-09-29 the repository has no parked
branches: `chat-workspace` (extracted, see above), `livestream-privacy` (created empty, never
used), `release-0-0-3` and `docs/discovery-and-sharing-2026-09-26` (both merged) were
removed, and the two Copilot CI PRs (#30, #31) were closed as superseded — they predated the
terminal panel and would have removed it, and the failure they targeted no longer reproduces.

## Known rough edges

- **Layout e2e can measure the terminal panel before xterm's fit settles.** CI saw a 2 px
  transient on one of two runs of the same commit (PR #35). The assertion now polls for the
  settled bottom edge; watch for other sub-pixel checks in `e2e/layout.spec.ts` doing the same.
- **Local e2e on a machine in use.** The test window is shown inactive under `MODEX_E2E`
  (v0.0.3); if a run still garbles terminal input, nothing else should be typed while it runs.
- **Auto-titles run a real CLI turn.** It is a separate, non-resumed conversation with tools
  refused, but it does consume one small model call per new thread on Claude and Codex.

## Next

Roughly in the order they earn their place; none is scheduled.

1. **v0.0.4** with the two items above, once the follow-up PR has soaked on `main`.
2. **Notarized macOS build and a custom app icon.** Every release note has carried "ad-hoc
   signed, not notarized"; Gatekeeper friction is the first thing a new user meets.
3. **Auto-update**, once builds are notarized.
4. **Image attachments** in the composer (both CLIs accept them).
5. **Windows and Linux installers.** The terminal supervisor and login-shell PATH probing are
   the platform-specific pieces to audit first.
6. **Codex Cloud tasks and scheduled automations.** Out of scope until the local story is
   complete; Modex stays CLI-only for coding turns (no API execution mode — see `AGENTS.md`).

## Conventions that keep this page true

- One worktree per session (`scripts/worktree.sh new <slug>`), removed after the merge. A
  branch that is not being worked on is either extracted into a PR or deleted; nothing parks.
- PRs merge through `~/.claude/scripts/gh-merge-when-green.sh <pr> --squash` after CI, with
  signed commits only.
- A PR that changes scope updates this page and, for user-facing behaviour, the README.
