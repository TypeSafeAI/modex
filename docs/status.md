# Where things stand

The living map of what has shipped, what is on `main` but unreleased, what is in flight, and
what is next. Update it in the same PR that changes any of those; a reader should be able to
plan the next session from this page alone. Release evidence lives in [`reviews/`](reviews/).

_Last updated 2026-10-05._

## Shipped

| Release | Date | Merge | Headline |
| --- | --- | --- | --- |
| v0.0.1 | 2026-09-26 | — | First macOS build: two backends, Auto routing, worktree threads, Changes panel. |
| v0.0.2 | 2026-09-28 | #33 | Desktop lifecycle races, Changes safety, streaming performance, layout persistence. [Review](reviews/2026-09-28-release-review.md). |
| v0.0.3 | 2026-09-28 | #34 | Embedded terminal panel ships; unsent text stays with its thread; inactive test window. [Review](reviews/2026-09-28-v0.0.3-release-review.md). |
| v0.0.4 | 2026-09-29 | #37 | Threads name themselves; one suggested next step after each turn. [Review](reviews/2026-09-29-v0.0.4-release-review.md). |
| v0.0.5 | 2026-10-03 | #69 | First Developer ID signed and notarized build, from the protected `Release` workflow; the Modex app icon; Jev settings and routing limits (#51); terminals no longer leak a PTY each. [Review](reviews/2026-10-03-v0.0.5-release-review.md). |
| v0.0.6 | 2026-10-05 | #106, #110 | Jev-inspired near-black blue/pink workspace, Claude/ChatGPT sign-in, Retry, Streamer Mode and the paired iPhone service. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.6). |

Every release so far is macOS Apple Silicon. v0.0.1–v0.0.4 were ad-hoc signed; from v0.0.5
releases are Developer ID signed (Soul Protocol LLC), notarized and stapled. The release
sequence (worktree → review doc → signed build + packaged e2e → guarded merge → signed tag →
the `Release` workflow, behind the `release-signing` reviewer → GitHub release with
`SHA256SUMS.txt`) is in [release-signing.md](release-signing.md#cutting-a-release).

## v0.0.6 release

Published on 2026-10-05 from signed tag `53d4760` at commit `3498616`. Protected
Release run `37300304273` passed signing, notarization, stapling and all 91 e2e checks.
Downloaded DMG and ZIP passed checksum, strict signature, native Mach-O, Gatekeeper,
notarization-ticket, version, icon and container checks. Their app payloads match.
The release includes [the verification log](https://github.com/TypeSafeAI/modex/releases/download/v0.0.6/verification-v0.0.6.txt).
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
  is included in v0.0.6; iPhone distribution is tracked below.

## Landing page

The static download site lives in `apps/site`, deployed to Vercel project `modex` for
`modex.jev.works`. It uses the Jev near-black blue/pink palette and a three-stage CSS 3D
walkthrough with real demo captures. Mac links point to the published signed/notarized
v0.0.6 Apple Silicon release; iPhone is explicitly **Coming soon**, with no public beta link.
The public preview is [modex-0xbuns.vercel.app](https://modex-0xbuns.vercel.app); custom-domain
DNS is pending. Build and deployment commands and asset provenance are in [the site README](../apps/site/README.md).

## On `main`, not yet released

- **Automatic CLI discovery and verified overrides.** Claude and Codex resolve an executable
  from the hydrated login PATH, native installs, Homebrew and common version managers before
  launching. Settings shows the selected path; blank overrides keep discovery automatic.
  Explicit overrides must be executable files and pass the correct CLI's bounded `--version`
  check before any settings are saved. Command strings (including permission flags) are
  rejected; paths containing spaces are supported. Override changes apply after restart so
  active Codex app-server sessions remain intact. This fixes the v0.0.6 `spawn claude
  --dangerously-skip-permissions ENOENT` configuration failure; clear that override in Settings.
  Build, typecheck, 15 core/259 desktop/1 bridge tests and all 98 desktop e2e checks passed
  locally. Live executable verification passed for Claude Code 2.1.288 and Codex 0.160.0.

- **Release notification banner.** Installed Mac builds check public GitHub release
  metadata at launch and hourly, and show a dismissible banner for a newer stable release
  with an installer for the current architecture. View update opens its release page.
  Dismissal survives relaunch; later versions appear again. Offline checks stay quiet,
  and downloads/installation remain manual. Build, typecheck, 15 core/253 desktop/1 bridge
  tests and all 97 e2e checks passed locally, including both themes. The live release feed
  correctly offers v0.0.6 to v0.0.5 and nothing to v0.0.6. This follows v0.0.6.
- **OpenCoven desktop theme.** Settings → General → Theme adds Cave's charcoal/black
  surfaces and lavender purple accent alongside the default Jev palette. Save/Cancel,
  keyboard selection, relaunch persistence, the native window and an already-open terminal
  share the choice. Local build, typecheck, unit tests and all 95 e2e checks passed,
  including terminal-session continuity and contrast checks. This follows v0.0.6.
- **Approval rules editor (#107).** Settings drafts, project-scoped previews and decision
  receipts merged after v0.0.6. Both desktop and iPhone jobs passed on both final CI runs.
  The production gate remains off; human acceptance before enabling it is tracked below.

## In flight

- **Modex Companion TestFlight.** The native iPhone MVP merged in #103. A phone can view
  threads, send follow-ups, and answer approvals while the Mac keeps CLI execution.
  Simulator and paired API verification passed; a signed IPA using `works.jev.modex`
  passed Apple validation, uploaded, and reached `VALID` processing in App Store Connect.
  Build 2 fixes first-run Mac TLS compatibility, pending-request revocation, stale responses,
  thread draft isolation, and disconnect confirmation. All 91 desktop e2e tests, 10 native
  tests, and the paired simulator flow passed; iPhone tests now also run in CI.
  The signed build 2 distribution IPA also passed strict signature and ZIP verification.
  On 2026-10-05, build 2 passed Apple validation and upload, reached `VALID`, and entered
  `IN_BETA_TESTING` in the existing Internal group with one tester. Physical iPhone
  installation and acceptance remain open. The source plist now records the system-encryption
  exemption so future uploads retain it.
  The first connection target is the same local network; [the companion guide](ios-companion.md)
  records the pairing and release path.

- **Provider feasibility (#78/#79).** [Gemini](gemini-feasibility.md) and
  [Grok](grok-feasibility.md) have conditional CLI/ACP integration decisions backed by
  installed-version initialization probes. Neither is enabled. Read-only permission,
  authentication and macOS acceptance evidence remain gates for future implementation.
- **Approval rules (Jev-gated).** Part 1 (#54) merged with the gate off and no UI: every
  backend's approval request carries an action, `engine/approvals/digest.ts` builds the
  scrubbed state Jev sees, and `engine/approvals/gate.ts` decides allow, ask or never. Part 2
  (PR #107, merged) adds a Settings draft editor, project-scoped Try it previews, compact persisted
  receipts, the `(rule: …)` deny reason, `e2e/approvals.spec.ts`, and [usage docs](approval-rules.md).
  The gate remains off: saved rules can be previewed but do not decide live approvals.
  Reconciliation with the merged companion passed build, typecheck, 15 core and 248 desktop
  tests plus the browser bridge test, and all 94 desktop e2e checks. This integration follows
  v0.0.6. Three live Jev preview examples passed on 2026-10-05; human acceptance and
  broader judge evaluation remain open before enabling the gate. The
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

1. **Automatic installation of updates.** Release notifications are implemented; installation remains manual.
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
