# Where things stand

The living map of what has shipped, what is on `main` but unreleased, what is in flight, and
what is next. Update it in the same PR that changes any of those; a reader should be able to
plan the next session from this page alone. Release evidence lives in [`reviews/`](reviews/).

_Last updated 2026-10-07._

## Shipped

| Release | Date | Merge | Headline |
| --- | --- | --- | --- |
| v0.0.1 | 2026-09-26 | — | First macOS build: two backends, Auto routing, worktree threads, Changes panel. |
| v0.0.2 | 2026-09-28 | #33 | Desktop lifecycle races, Changes safety, streaming performance, layout persistence. [Review](reviews/2026-09-28-release-review.md). |
| v0.0.3 | 2026-09-28 | #34 | Embedded terminal panel ships; unsent text stays with its thread; inactive test window. [Review](reviews/2026-09-28-v0.0.3-release-review.md). |
| v0.0.4 | 2026-09-29 | #37 | Threads name themselves; one suggested next step after each turn. [Review](reviews/2026-09-29-v0.0.4-release-review.md). |
| v0.0.5 | 2026-10-03 | #69 | First Developer ID signed and notarized build, from the protected `Release` workflow; the Modex app icon; Jev settings and routing limits (#51); terminals no longer leak a PTY each. [Review](reviews/2026-10-03-v0.0.5-release-review.md). |
| v0.0.6 | 2026-10-05 | #106, #110 | Jev-inspired near-black blue/pink workspace, Claude/ChatGPT sign-in, Retry, Streamer Mode and the paired iPhone service. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.6). |
| v0.0.7 | 2026-10-05 | #117 | Official pink identity, persistent Companion pairing, update banner, OpenCoven theme, verified CLI discovery, polished connections and full-width website walkthrough. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.7). |
| v0.0.8 | 2026-10-06 | #126, #127 | Per-thread provider/model, live branch and PR state; tabbed workspace, empty-screen polish and failure recovery. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.8). |

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

The download site lives in `apps/site`, deployed to Vercel project `modex` for
`modex.build`. It uses the Jev near-black blue/pink palette and a three-stage CSS 3D
carousel with real demo captures. Mac links point to the published signed/notarized
latest stable Apple Silicon release automatically through a cached public GitHub feed,
with independently verified v0.0.8 links as the static fallback. The page shows GitHub
stars, forks and total stable Mac installer downloads; missing counts remain hidden and
cached counts are labeled after a failed refresh. The iPhone buttons now use Val's
[public TestFlight invitation](https://testflight.apple.com/join/Qr14JKCh).
Apple reported that the beta was not accepting new testers during the 2026-10-05 browser
check; the CTA links to TestFlight to check availability.
The homepage link, canonical URL and social metadata target `https://modex.build/`.
Val handles custom-domain and DNS setup in Vercel manually; the public preview is
[modex-0xbuns.vercel.app](https://modex-0xbuns.vercel.app). Build and deployment commands and
asset provenance are in [the site README](../apps/site/README.md).
The repository now pins Vercel to the site-only build and output directory, so Git
deployments do not attempt to compile the native desktop helper on Linux.

The headerless landing view fills the browser width and dynamic height without page
scrolling. The carousel loops through three steps every four seconds until a visitor selects
a step; reduced motion keeps it still. All step controls and download actions remain visible
on portrait and landscape screens. About Modex opens iPhone, installation and FAQ details in
a dismissible dialog. [Viewport verification](reviews/2026-10-05-landing-viewport.md).

## v0.0.7 release

Published on 2026-10-05 from signed tag `954bad3` at verified merge commit `7c6c76b`
(PR #117). Protected Release run `37361438192` passed signing, notarization, stapling and
all 100 packaged e2e tests. Downloaded artifacts passed independent checksum, certificate,
strict signature, native module, Gatekeeper, ticket, icon, version and container checks;
all 310 files/symlinks in the DMG and ZIP app payloads match. The unauthenticated public
DMG download matches the verified CI artifact. The release includes
[the verification log](https://github.com/TypeSafeAI/modex/releases/download/v0.0.7/verification-v0.0.7.txt).

The patch includes the changes below and a polished update banner: clearer release/download
copy, larger controls, keyboard focus, reduced-motion support and a fresh check when the app regains focus. Requests remain
cached and coalesced in the main process. v0.0.6 predates the banner and needs one manual
update; v0.0.7 enables notifications for subsequent releases.
The companion gains persistent reconnection with pinned Bonjour discovery, recovery from
Mac address/port changes, explicit revocation handling and Copy pairing link. The official
pink mark now spans desktop and companion icons, in-app branding, website
navigation, social artwork and documentation. Play walkthrough opens a full-width
presentation with pause/resume, replay and keyboard dismissal.
Coding CLI connections use separate provider cards, account-state badges, cancellable
browser sign-in, and copyable terminal recovery commands for the resolved executable.
Missing CLIs have an install/path remedy, and overrides remain verified before saving.
Product attribution identifies Modex as independent; the site credits **Powered by Jev**
and exposes GitHub in the main navigation on desktop and mobile.
[Release ledger](reviews/2026-10-05-v0.0.7-release-review.md).

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
  correctly offers v0.0.6 to v0.0.5 and nothing to v0.0.6. This ships in v0.0.7.
- **OpenCoven desktop theme.** Settings → General → Theme adds Cave's charcoal/black
  surfaces and lavender purple accent alongside the default Jev palette. Save/Cancel,
  keyboard selection, relaunch persistence, the native window and an already-open terminal
  share the choice. Local build, typecheck, unit tests and all 95 e2e checks passed,
  including terminal-session continuity and contrast checks. This ships in v0.0.7.
- **Approval rules editor (#107).** Settings drafts, project-scoped previews and decision
  receipts merged after v0.0.6. Both desktop and iPhone jobs passed on both final CI runs.
  The production gate remains off; human acceptance before enabling it is tracked below.

## v0.0.8 release

Published on 2026-10-06 from signed tag `2d55c3f` at verified merge commit `3dc6b84`
(#126, release setup recovery #127). Protected Release run `37436514563` passed signing,
notarization, stapling and **114 desktop + 7 website packaged e2e tests**. Downloaded
artifacts passed independent checksum, certificate, strict signature, native code,
Gatekeeper, ticket, icon, version and container checks. All 311 files/symlinks in
the DMG and ZIP app payloads match; the unauthenticated public DMG matches the verified
CI artifact. [Verification log](https://github.com/TypeSafeAI/modex/releases/download/v0.0.8/verification-v0.0.8.txt).
[Release ledger](reviews/2026-10-06-v0.0.8-release-review.md).

- **Thread details in the left sidebar.** Each thread shows its provider/model, current
  checkout branch and linked draft/open/merged/closed GitHub PR state. Missing GitHub CLI
  access and absent PRs remain explicit. Metadata requests are bounded and cached.
- **Right workspace replacement.** The right workspace replaces the stacked Changes
  panel with the reference tab strip, new-tab launcher, full view, and a side-by-side review
  with numbered diffs and a filterable file tree. Files previews, the existing per-thread
  terminal, and isolated browser pages run inside tabs. [Design and verification](reviews/2026-10-05-right-workspace.md).
- **Workspace polish and failure recovery.** A clearer empty workspace makes new projects
  and chats easier to start; coding CLI failures expose Retry and connection controls.
- **Update banner verified in the published app.** v0.0.8 retains the launch, hourly, and
  focus checks from v0.0.7. The live feed offers v0.0.8 to v0.0.7 and no update to v0.0.8.
  A newer stable release with a matching installer triggers the dismissible banner.
  The Mac App Store client leaves updates to the Store; it does not offer GitHub installers.

## On `main`, not yet released

**Usage dashboard preview.** A standalone React preview now follows
the TypeSafe UI palette and typography, with overview, activity, models, projects,
accounts, and coverage views. Collapsible navigation and an oversized Demo Data stamp
frame 471 synthetic calls across 11 sources, including GitHub Copilot. Filters,
call details, CSV export, and both appearances work against the same fictional
workspace; missing costs remain unpriced. This is not yet a desktop navigation entry
or live usage collector. Run and provenance details: [usage preview](usage-preview.md).

**Consistent themes and live agent activity.** The right workspace, review/browser controls,
menus, status colors and typography now share Jev/OpenCoven tokens with the chat and sidebar.
The logo itself uses lavender in OpenCoven, preserving its transparent silhouette and
the original pink artwork in other themes.
Tools fold into one line with summaries derived from their structured command/path/query when
needed; original arguments and results remain expandable. Individual Claude Agent/Task and
Codex child-agent activity appears in the sidebar immediately during the parent turn, across
thread selection and renderer reconnects. Launch receipts do not mark background work done;
a stream that ends without a final status records “Status unavailable.” The activity rail
opens the sidebar and focuses an active parent. Browser status refreshes preserve an address
being edited. [Acceptance](reviews/2026-10-07-ui-completion.md).

**Mobile thread creation and skills (#128).** The paired Mac service now supports starting
Local or Worktree threads and discovering provider-native commands. The iPhone demo also
exercises thread creation and skills without a Mac. Companion 0.1.0 (5) includes these
changes and is submitted for beta review. Real paired use still requires a new standalone
desktop release; the published v0.0.8 host predates these endpoints.

**Chat title quality.** The title request now includes a bounded final reply and asks for a
short action-and-subject title in the user's language. Validation normalizes plain text and
rejects malformed output; persisted title ownership prevents a retry from replacing a manual
rename. Electron tests exercise Claude and Codex CLI adapters through naming, relaunch,
cancellation and fallback.

## In flight

- **Mac App Store edition.** Val selected investigation of a sandboxed Store front end
  with a separately installed signed host to retain full desktop functionality. Apple's
  sandbox and standalone-app rules require an architecture and review gate. The
  [investigation and parity matrix](mac-app-store.md) records the proposed ownership and
  end-to-end acceptance gates. A fail-closed MAS packaging and App Store Connect validation
  command is documented. Mac Store 0.0.8 and Companion 0.1.0 (5) passed processing and
  are `WAITING_FOR_REVIEW` as of 2026-10-06 23:51 UTC. Both beta review records contain
  offline demo instructions, and both reviewer replies are posted; the iOS reply includes
  the reusable QR. The [review access ledger](reviews/2026-10-06-review-demo-access.md)
  records build IDs and verification. The production Mac draft is 0.0.8 with its build
  and review notes selected, but still needs screenshots, description, keywords, and
  support URL. Apple acceptance of demo access and the Store architecture remains pending.

- **Modex Companion TestFlight.** The native iPhone MVP merged in #103. A phone can view
  threads, start Local or Worktree threads, send follow-ups, and answer approvals while the
  Mac keeps CLI execution. A compact provider-aware picker exposes Claude skills and custom
  slash commands plus Codex skills discovered from the project and user skill directories;
  no paths or command bodies leave the Mac.
  Simulator and paired API verification passed; a signed IPA using `works.jev.modex`
  passed Apple validation, uploaded, and reached `VALID` processing in App Store Connect.
  Build 2 fixes first-run Mac TLS compatibility, pending-request revocation, stale responses,
  thread draft isolation, and disconnect confirmation. All 91 desktop e2e tests, 10 native
  tests, and the paired simulator flow passed; iPhone tests now also run in CI.
  The signed build 2 distribution IPA also passed strict signature and ZIP verification.
  On 2026-10-05, build 2 passed Apple validation and upload, reached `VALID`, and entered
  `IN_BETA_TESTING` in the existing Internal group with one tester. Physical iPhone
  installation and acceptance remain open. The source plist records the system-encryption
  exemption. Build 3 adds the official Modex icon and in-app branding; all 10 native tests
  and paired simulator flow passed. On 2026-10-05 its signed IPA passed validation and
  upload, reached `VALID`, and entered `IN_BETA_TESTING` in the same Internal group.
  Build 4 adds persistent pairing and automatic recovery after Mac address/port changes.
  All 14 native tests and the extended LAN simulator flow passed, including revocation
  across relaunches. On 2026-10-05 its signed IPA passed Apple validation and upload,
  reached `VALID`, and entered `IN_BETA_TESTING` in the existing Internal group.
  On 2026-10-06, build 5 combined the offline demo and #128 creation/skills flows,
  passed processing, and entered internal testing and external `WAITING_FOR_REVIEW`.
  Its updated notes and posted QR reply address the earlier review-access rejection.
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


## Local Mac Store development preview (unreleased)

PR #119 adds a dedicated opt-in loopback host and a sandboxed Electron MAS client that
reuses the desktop renderer. Val approved integrating this development preview. Transport
boundary/revocation tests and a signed native smoke test cover explicit pairing, encrypted
saved access, an approved scripted edit, terminal execution, restart recovery and revocation.
App Sandbox was verified on the running client. Graceful host shutdown, full parity and
real CLI acceptance, provisioning, App Review eligibility and macOS TestFlight remain
pending; this is not an App Store release. See [the preview ledger](mac-store-preview-plan.md) and
[run instructions](../apps/store-desktop/README.md).

The shared Mac connection settings now recognize existing system CLI sign-ins and recheck
them on return from Terminal or a browser. Authenticated Claude no longer asks for another
login; an authenticated Codex CLI account remains selected unless the user chooses another
account. Executable overrides still require verification before saving. Read-only checks on
this Mac confirmed Claude Code 2.1.289 and Codex 0.160.1 are already authenticated; this is
account-detection evidence, not a new live coding-turn or Store distribution acceptance.
