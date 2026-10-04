# Where things stand

The living map of what has shipped, what is on `main` but unreleased, what is in flight, and
what is next. Update it in the same PR that changes any of those; a reader should be able to
plan the next session from this page alone. Release evidence lives in [`reviews/`](reviews/).

_Last updated 2026-10-04._

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

- **v0.0.6 is being recut before publication.** The first signed tag points to PR #97's
  verified tree, but its release run was cancelled before approval. PR #106 adds the
  Jev-inspired near-black blue and pink palette plus the merged iPhone companion service.
  The combined Developer ID sign-only rehearsal and all 91 packaged e2e tests passed.
  Local notarization, a new signed candidate, and the
  protected release run are required before publication.
  [Review](reviews/2026-10-03-v0.0.6-release-review.md).
- **Claude sign-in (#77, PR #91).** Settings launches the saved Claude CLI's browser login,
  cancels its own attempt, and verifies structured account status afterward. Credentials
  remain CLI-owned. Apple Silicon authorization acceptance passed on 2026-10-04 using
  Claude Code 2.1.273 and the documented Terminal fallback. A later live Haiku turn through
  Modex's backend and Claude Code 2.1.288 completed with tools disabled and no tool requests.
  This verifies that account/model pair; other models and live tool execution remain unverified.
- **ChatGPT sign-in (#76, PR #92).** [Design and recovery](chatgpt-signin.md) cover
  OAuth, protected storage, account-isolated Codex processes and identity-bound resumes.
  Real Apple Silicon acceptance passed for authorization, completed Codex turns, rotating
  renewal, bound resumes, two-registration process isolation, and scoped revocation.
- **Auth recovery and retry (PR #104).** Failed turns carry persisted failure cards,
  remedies, Copy details and Retry without duplicating the user message. Codex retries a
  stale login once while preserving concurrent turns. The signed head passed both required
  macOS CI runs; draft PR #68 was closed after #104 landed.
- **Browser review (PR #105).** The renderer can connect to a separate localhost development
  bridge for reviewing real project and thread flows in Chromium. The bridge is excluded from
  packaged releases. Its browser flow and macOS CI passed before merge.
- **iPhone companion service (#103).** An opt-in paired HTTPS service and native SwiftUI app
  support same-network threads, follow-ups, and single approvals while coding stays on the
  Mac's CLIs. Both desktop and iPhone CI jobs passed on both runs before merge. The service
  is included in the replacement v0.0.6 candidate; iPhone distribution is tracked below.

## In flight

- **Modex Companion TestFlight.** The native iPhone MVP merged in #103. A phone can view
  threads, send follow-ups, and answer approvals while the Mac keeps CLI execution.
  Simulator and paired API verification passed; a signed IPA using `works.jev.modex`
  passed Apple validation, uploaded, and reached `VALID` processing in App Store Connect.
  Build 2 fixes first-run Mac TLS compatibility, pending-request revocation, stale responses,
  thread draft isolation, and disconnect confirmation. All 91 desktop e2e tests, 10 native
  tests, and the paired simulator flow passed; iPhone tests now also run in CI.
  The signed build 2 distribution IPA also passed strict signature and ZIP verification.
  Build 2 upload, internal tester access, and physical iPhone acceptance remain open.
  The first connection target is the same local network; [the companion guide](ios-companion.md)
  records the pairing and release path.

- **Provider feasibility (#78/#79).** [Gemini](gemini-feasibility.md) and
  [Grok](grok-feasibility.md) have conditional CLI/ACP integration decisions backed by
  installed-version initialization probes. Neither is enabled. Read-only permission,
  authentication and macOS acceptance evidence remain gates for future implementation.
- **Approval rules (Jev-gated).** Part 1 (#54) merged with the gate off and no UI: every
  backend's approval request carries an action, `engine/approvals/digest.ts` builds the
  scrubbed state Jev sees, and `engine/approvals/gate.ts` decides allow, ask or never. Part 2
  (PR #107) adds a Settings draft editor, project-scoped Try it previews, compact persisted
  receipts, the `(rule: …)` deny reason, `e2e/approvals.spec.ts`, and [usage docs](approval-rules.md).
  The gate remains off: saved rules can be previewed but do not decide live approvals.
  Reconciliation with the merged companion passed build, typecheck, 15 core and 248 desktop
  tests plus the browser bridge test, and all 94 desktop e2e checks. This integration follows
  v0.0.6; live Jev and human approval acceptance remain open. The
  [reconstructed spec](specs/2026-10-01-modex-jev-approval-rules-spec.md) records the part 2 decisions.
  By default a new rule covers the current project, and rules that need Jev show as inactive
  without it rather than being hidden.
- **Unmerged worktrees.** Each needs a reviewed PR or an explicit disposition.
  - `auth-retry` (uncommitted): retained as recovery data after the reconciled fix merged in #104.
  - `finish-auth-approvals` (uncommitted approval UI and receipts): reconciled in #107; preserve the original until its lifecycle is resolved.
  - `approval-receipts` (uncommitted, overlapping `finish-auth-approvals`): preserve until the
    approval work is reconciled.
  - `pr-review-browser` (uncommitted): the reconciled browser bridge merged in #105; preserve
    this original until its lifecycle is resolved.
  - `status-reviews` (uncommitted docs snapshot): compare with current status before retiring.
  - `livestream-redaction` (clean local-only commit): superseded by merged #100; preserve the
    original branch until its lifecycle is explicitly resolved.

## Known rough edges

- **node-pty is a pre-release.** v0.0.6 still ships `node-pty@1.2.0-beta.15` (#65), because 1.1.0
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
