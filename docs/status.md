# Where things stand

The living map of what has shipped, what is on `main` but unreleased, what is in flight, and
what is next. Update it in the same PR that changes any of those; a reader should be able to
plan the next session from this page alone. Release evidence lives in [`reviews/`](reviews/).

_Last updated 2026-10-15._

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
| v0.0.9 | 2026-10-08 | #137, #139, #144, #141, #142 | Graphite shell, Settings privacy, Pages/Knowledge, Sources, background turns and separate GitHub identity. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.9). |
| v0.0.10 | 2026-10-09 | #148, #149, #150, #154, #151 | Agent-maintained Knowledge and Pages, compact resizable panels, approval policies, task retirement and shutdown recovery. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.10). |
| v0.0.11 | 2026-10-13 | #152, #164, #166, #178, #180, #183, #184 | Sticky Auto routing, composer attachments, Canvas previews, browser extensions with 1Password filling, minimal review rail, multi-network Companion. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.11). |
| v0.0.12 | 2026-10-13 | #181, #185, #193, #195, #199, #200, #201 | First self-updating macOS release: verified download and restart with draft recovery; held-model effort; Claude fast-mode receipts; Space reference layout. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.12). |

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

The download site lives in `apps/site`, deployed to Vercel project `modex`. The new
landing design keeps the near-black blue/pink identity and follows a concrete task through
request, proposed patch and approved result with manually selected real app captures.
The page scrolls through agent choice, parallel worktrees, Pages/Knowledge, setup, optional
iPhone Companion and inline FAQ. Mobile retains the product explanation and platform
requirements; screenshot enlargement, keyboard controls and no-JavaScript links remain usable.

Mac links update to the latest stable Apple Silicon release through the cached public
GitHub feed, with verified v0.0.11 URLs as the static fallback. Signing, release and MIT
license links sit beside the main download; community counts move to the footer. Missing
counts remain hidden and cached counts are labeled after a failed refresh. The optional
Companion links to Val's [public TestFlight invitation](https://testflight.apple.com/join/Qr14JKCh),
with same-local-network and awake-Mac requirements alongside it. Apple controls enrollment.

Val confirmed `https://modex.codes/` as the public domain. DNS, HTTPS and the binding to
Vercel project `modex` were verified on 2026-10-11. Canonical/social metadata, the README
homepage and generated brand artwork now use that address. The Vercel alias
[modex-0xbuns.vercel.app](https://modex-0xbuns.vercel.app) remains available. Vercel uses the
repository's site-only build and output configuration. See [site development and asset provenance](../apps/site/README.md)
and [landing verification](reviews/2026-10-11-landing-clarity.md).

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

## v0.0.9 release

Published on 2026-10-08 from signed tag `v0.0.9` at `82dfac9`. All open delivery PRs
were merged or handled before release. The protected workflow signed, notarized and
stapled the Apple Silicon DMG and ZIP, then passed 152 desktop and 7 site packaged tests.
Independent downloads passed Gatekeeper, signatures, ticket and checksum checks; all
311 DMG/ZIP app payload entries match. Their ASAR is byte-identical to the signed app
that passed the fresh production GitHub authentication lifecycle. Public unauthenticated
downloads match the verified artifacts, and GitHub's latest endpoint returns v0.0.9.
[Verification receipt](https://github.com/TypeSafeAI/modex/releases/download/v0.0.9/verification-v0.0.9.txt)
and [release ledger](reviews/2026-10-08-v0.0.9-release-review.md).
Mac App Store and iPhone distribution remain separate tracks.

**Space and local knowledge.** Space adds a section below Home with
nested pages, favorites, templates, searchable Markdown blocks, autosave, import/export,
and recoverable trash using `@create-markdown/core` and `@create-markdown/react` 2.0.3.
Creating a page preserves focus once typing starts in its content editor.
Knowledge base embeds a separately installed OpenKnowledge 0.83.2 local companion,
with folder selection, native-page copying, privacy hiding, and owned shutdown.
Existing project servers are verified and reused; Disconnect leaves those servers running.
The embedded editor follows Graphite, Jev, and OpenCoven, including live theme changes,
editor text and controls, and a matching background while loading or reloading.
Home panes retain their grid positions and full-view behavior when switching to Space and back.
Imported lists retain dedented items and keep checkbox edits aligned with their source text.
It requires Node.js 24+ and Git. The
[implementation review](reviews/2026-10-08-space-knowledge.md) records verification
and integration boundaries.

**Settings polish.** Settings navigation uses a quieter inset tab strip, consistent
icons and a raised selected state. Coding CLI account labels show the account name and
sign-in state without exposing OAuth registration identifiers; selection and authentication
still use the unchanged internal account IDs.

**Web answers and Sources.** Transcript Markdown renders web links in the system browser.
Trailing citation lists become numbered cards after streaming ends; annotations and additional
links preserve the full answer. WebSearch shows result links and its summary, while WebFetch
renders readable prose. Saved threads use the same parsers without a migration.

**Claude background turns.** A successful reply keeps stdin open while background tasks
run, so follow-up permission prompts can be answered. Task completion, errors, cancellation,
a 15-second idle window after work drains and a 30-minute cap bound the wait. Termination
escalates to SIGKILL when Claude ignores SIGTERM. Regression tests cover captured CLI events,
prompts after the first reply and Stop.

**Reference desktop shell (PR #137).** Graphite adds the neutral October 7
reference palette, a wider compact sidebar, a folder/title header with fixed right-edge
actions, and a responsive repository overview linked to the real workspace. New profiles
default to Graphite; saved Jev/OpenCoven preferences remain intact. Build, typecheck, unit, and UI
verification are recorded in [the review](reviews/2026-10-07-reference-shell.md).

**Workspace welcome and Companion recovery.** The desktop welcome uses responsive
project and work-mode cards, with **Open Project** as the primary action. Its logo tile
uses the theme's neutral surface; only the logo artwork changes to purple in Coven.
The iPhone groups threads into project cards, including empty projects. Each project's
New thread action selects that project, and the composer stays above the keyboard.
Disconnected workspaces offer **Scan pairing code** and **Try again**. Rescanning the
same pinned Mac preserves unsent drafts; pairing a different Mac clears them.
Unchanged polls preserve the current UI instead of rebuilding open menu actions; real
workspace changes and connection recovery continue to publish immediately.
[Verification and acceptance limits](reviews/2026-10-07-workspace-polish.md).

**Packaged demo recovery.** Demo startup resolves its script from Electron's bundled app
path, including ASAR packages. Missing mock scripts open Mock script settings instead of
suggesting a coding CLI installation.

**Usage dashboard preview.** A standalone React preview now follows
the TypeSafe UI palette and typography, with overview, activity, models, projects,
accounts, and coverage views. Collapsible navigation and an oversized Demo Data stamp
frame 471 synthetic calls across 11 sources, including GitHub Copilot. Filters,
call details, CSV export, and both appearances work against the same fictional
workspace; missing costs remain unpriced. This is not yet a desktop navigation entry
or live usage collector. Run and provenance details: [usage preview](analytics.md#the-standalone-preview).

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
changes and was approved for TestFlight beta testing on 2026-10-07. The v0.0.9 standalone
desktop now supplies these endpoints for real paired use.

**Chat title quality.** The title request now includes a bounded final reply and asks for a
short action-and-subject title in the user's language. Validation normalizes plain text and
rejects malformed output; persisted title ownership prevents a retry from replacing a manual
rename. Electron tests exercise Claude and Codex CLI adapters through naming, relaunch,
cancellation and fallback.

**Streamer Mode startup privacy.** The privacy cover now stays mounted while the workspace
loads and if startup fails. Error details remain hidden from the window and accessibility
tree until you choose **Show workspace**. Electron regression tests cover delayed startup,
startup errors, and explicit reveal after a relaunch.

**Modex GitHub identity.** Native WorkOS public-client PKCE, encrypted renewable
sessions and a separate Settings account card landed through #141 on main `d2d6671`.
Production is the default; staging is explicitly selected and isolated. Hosted AuthKit
handles required email verification before the desktop exchanges the PKCE code. No repository
integration or model account changes are included. Live signed production sign-in,
repeat sign-in, restart, renewal after expiry, cancellation, and local plus confirmed
remote sign-out passed; coding CLI accounts were unchanged. [Design and acceptance](modex-signin.md).

## v0.0.10 release

Published on 2026-10-09 from signed tag `ebcf9f9` at merge `dbbb33e` (#151).
Protected Release run `37988118995` passed signing, notarization, stapling and all
164 desktop plus 7 website packaged E2E tests. Independently downloaded DMG and ZIP
passed checksums, signatures, Gatekeeper, tickets, version and archive checks; their
app payloads match. [Release ledger](reviews/2026-10-09-v0.0.10-release-review.md).
The release also includes Codex ChatGPT-plan recovery (#148) and a targeted fix for
late Electron visibility notifications that could block quitting after window destruction.

- **Slim Knowledge chrome and resizable panels.**
  The entire Knowledge Properties block collapses under a full-width header, defaults closed,
  and retains the companion’s saved choice. Knowledge uses one 36px toolbar with an inline
  maintenance toggle. Both panel edges support
  dragging, arrow keys (Shift for larger steps), Home/End, and double-click/Enter to reset.
  Slim defaults are 240px left and 360px right. Widths persist across launches, are shared
  with Space, and adapt to keep at least 350px
  for chat at the minimum window size. Native browser/Knowledge views suspend during dragging.
  Local validation and the intermittent navigation test are recorded in the
  [review](reviews/2026-10-09-slim-panels.md).

**Approval policy, full skill text, and task retirement** (#149).
A thread can be set to **Always allow** or **YOLO** from the composer's access menu, the
approval card, or the iPhone; the [approval rules](approval-rules.md#thread-policy-always-allow-and-yolo)
page has the exact semantics. The iPhone skill picker now shows each skill's whole description
instead of clipped one-liners. A worktree thread whose pull request merged is retired
automatically (worktree and branch removed, transcript kept read-only) when nothing in it
would be lost; checkout state is checked again after terminals close, and automatic removal
refuses new uncommitted changes; Settings → General turns this off. Not yet exercised against a physical iPhone
or a live merged PR; the sweep and removal are covered by unit tests with a real git worktree.


- **Agent notes through Pages MCP.** Modex includes its own
  local Pages server for Claude/Codex: opt-in notes access per project, revision-checked
  editing and organization, recoverable trash, attributed version history, and native
  page links in thread receipts. Space refreshes agent edits and preserves conflicting
  human drafts as recoverable copies. Locally verified with 455 unit, 159 desktop E2E
  and 7 site E2E tests, plus actual Claude/Codex resumed-session writes.
  [Usage](pages-maintenance.md) · [Verification](reviews/2026-10-09-pages-agents.md).
  Shipped in v0.0.10.

- **Agent knowledge maintenance.** Claude and Codex turns connect to the selected OpenKnowledge folder through a scoped local MCP adapter.
  Space offers per-project automatic maintenance; chat and plan turns stay read-only.
  Successful writes carry persisted page links, and OpenKnowledge retains collaborative
  history and recovery. Locally verified with both installed CLIs, 432 unit tests,
  156 desktop E2E tests and 7 site E2E tests; shipped in v0.0.10.
  See [usage and integration boundaries](knowledge-maintenance.md) and
  [verification](reviews/2026-10-09-knowledge-agents.md).

## v0.0.11 release

Published on 2026-10-13 from signed tag `v0.0.11` on release commit `fb267e7` (base #183),
cut before #181 so automatic update installation is not included. Protected Release run
`38345912131` passed signing, notarization, stapling and all 245 desktop plus 7 website
packaged E2E tests. Independently downloaded DMG and ZIP passed checksums, signatures,
Gatekeeper, tickets, version and archive checks; their app payloads match, and the packaged
suite passed again against the download. iPhone companion build 6, cut from the same source,
uploaded on 2026-10-13, passed processing and was approved for external TestFlight testing.
[Release ledger](reviews/2026-10-12-v0.0.11-release-review.md).

- **Sticky Auto routing.** Auto keeps a thread's model while its prompt cache is warm, because
  a switch re-reads the whole history uncached. It still chooses freely on a thread's first turn,
  after an hour idle, on small threads, and after you pick a model; while warm it moves up only on
  a two-tier jump or a self-contained deep-reasoning request. Held routes read "Auto kept" with
  the cache size and idle time. Claude and Codex turns now report cache usage, kept on the thread
  and in Auto's routing records. A probe showed effort changes keep the cache on both CLIs, so
  effort still adapts per turn on the same model. [Spec](specs/2026-10-12-sticky-auto-routing-spec.md).

- **Minimal right workspace.** Review opens with a compact toolbar and keeps selection,
  filters, display options and scroll position when switching tools or hiding the rail.
  Files sit above full-width code at narrow widths and beside it when expanded. Pointer
  and keyboard resizing remain available; tab closure restores focus without changing
  an inactive tab's selection. Large totals fit the 280 px minimum width, with exact
  counts in tooltips. Integrated verification passed 834 unit tests (12 Windows-only
  skips), all 245 desktop and seven site E2E tests with real OpenKnowledge enabled and
  no E2E skips. [Review and acceptance limits](reviews/2026-10-11-minimal-right-rail.md).

- **Companion on multiple networks.** One HTTPS listener and credential-free Bonjour
  advertisement per supported private IPv4 address; pairing offers a code/link for each
  active network. DHCP changes remove only affected listeners, preserving other connections
  and the saved certificate/token. Updated iPhone clients rotate through discovered endpoints
  and the saved endpoint. Shutdown also closes connections still in the TLS handshake.
  Initial iPhone pairing has its own connectivity-waiting request; recovery keeps ordinary
  request behavior. All 41 native unit tests passed after a regression repair to the
  asynchronous test fixture; the earlier paired physical flow also passed. A final fresh-install
  permission prompt was not observed, so first-use consent remains unaccepted. Physical
  secondary-LAN acceptance remains open: this Mac currently has one supported LAN.
  [Implementation and acceptance ledger](reviews/2026-10-11-companion-apple-readiness.md).

- **Windows and Linux installer candidates** (#173). The source supports x64 Windows
  NSIS and Linux AppImage/Debian packages, portable CLI/PTY supervision, and OS-encrypted
  credential storage. Candidate Actions artifacts have native install/restart/uninstall
  evidence; public release publication remains pending. Windows installers are unsigned,
  and Windows/Linux updates remain manual. [Native verification and limits](native-platforms.md).

- **Knowledge CLI diagnostics.** Connecting to an existing local editor parses successful
  status JSON from stdout, so a warning on stderr cannot corrupt the response. Failed
  commands still report bounded stdout/stderr diagnostics, and malformed stdout still
  fails verification. The reload privacy test waits for the intercepted navigation and
  its new document and editor before removing the network handler.

- **Worktree hygiene.** Local pruning requires an explicit release of an exact commit,
  fresh merged-work proof, no active or dirty state, and a verified recovery bundle.
  The shared command supports a daily macOS user job and keeps unknown legacy worktrees
  and remote branches. Desktop retirement respects project-script retention. Maintenance
  regression tests run in the standard test suite. [Procedure and recovery](worktree-hygiene.md)
  and [verification](reviews/2026-10-11-worktree-hygiene.md).

**Canvas previews.** The workspace launcher adds an interactive Canvas for checkout HTML,
SVG and Markdown. Local document/asset changes refresh the isolated preview; full view,
manual reload and deletion recovery are supported. Each guest has a temporary session,
no app bridge or Node access, bounded root-confined resource reads and no network access.
The Store edition and development browser bridge report Canvas unavailable.
Streamer Mode covers the preview without resetting it or blocking the workspace; filename
labels are masked while selected paths remain original. Late reload responses cannot
overwrite state after the selection changes.
Integration passed 703 unit tests, all workspace typechecks, 233 desktop E2E tests and
seven site tests, with real OpenKnowledge enabled and no skips.
[Usage and limits](canvas.md). Roadmap acceptance and release evidence remain tracked in
[the execution ledger](reviews/2026-10-11-desktop-roadmap-audit.md).
- **Composer attachments.** Desktop and browser-development drafts accept files from Attach files,
  drag/drop, and image paste, with removable chips, copy errors, and attachment-only send.
  Drafts stay with their thread or project through switches and failed sends. Main keeps
  byte-exact private copies and enforces 5 MiB per image, 25 MiB per other file, and 20 files
  per message. Both coding CLIs receive local attachments through their existing backends;
  clicking a sent attachment reveals it in Finder. The composer is up to 960 px wide with
  a 109 px resting height. Store attachments remain unavailable, including connected-host
  mode. Authenticated browser development uploads one bounded file at a time; regular
  commands retain their 1 MiB limit. Raster thumbnails are identity-checked and never execute
  attached HTML or SVG. Persisted ownership and transactional claims preserve retries across
  restarts. [Live CLI acceptance and integration evidence](reviews/2026-10-11-attachment-live-acceptance.md).
  Verified with a fresh build, typecheck, 621 unit tests (one existing skip), all 199 desktop
  E2E tests with real OpenKnowledge enabled, all 7 site tests, and both installed coding CLIs.

- **Usable Streamer Mode.** Recognized credentials are masked at display surfaces while
  the workspace stays usable. Editable fields containing a match mask the whole field
  but retain original native values, clipboard, undo, formatting, persistence, and CLI
  payloads. Terminal redaction paints the original buffer without replaying it through
  a second parser. Comment excerpts are masked in full, including public quotes, since
  a selection can omit a secret's label; comment drafts and saved values stay original.
  Only embedded Browser/Knowledge content is covered; pairing QR codes
  are hidden. This supersedes the v0.0.9 full-window cover described above. Matching is
  heuristic, and raw clipboard/accessibility text and arbitrary image content remain
  original. See the [recovery evidence](reviews/2026-10-11-streamer-recovery.md).
- **Space editor selection.** Adding a block and applying formatting focus the committed
  textarea before the next user edit. A deferred focus callback can no longer collapse
  a newer selection and turn a replacement such as `Second` into `/Second`. Toolbar
  Code insertion places the caret inside the fences, ready for typing.
  [Regression evidence](reviews/2026-10-11-space-focus.md).
- **Jev documentation.** The README identifies the optional Jev CLI as unofficial.
- **iPhone CI keyboard.** The hosted simulator disables its hardware keyboard before first
  boot and verifies the preference, so the software keyboard can confirm input focus.
- **Model picker.** #156 names `claude-sonnet-5-5` as the newest Sonnet.
- **PR #163 CI follow-up.** Attachment lifecycle tests wait until the
  composer accepts dragover before dispatching a single drop. iPhone test input queries
  use exact accessibility identifiers on text fields, avoiding the keyboard placeholder
  lookup that crashed XCTest after dismissing the skills sheet. Streamer quote assertions
  skip detached highlight ranges before checking full coverage; a deterministic regression
  reproduces the prior exception. Production behavior and assertion coverage are unchanged.
  The integration after #166 passed build/typecheck, 834 unit tests (12 Windows-only
  skips), 241 desktop and seven site E2E tests, 11 offline approval checks, and 41 native
  unit plus 28 UI tests. Approval rules remain disabled and both providers remain deferred;
  fresh checks on the published integrated commit are still required.
  [Failure evidence and verification](reviews/2026-10-11-pr163-ci.md).
- **Desktop CI synchronization.** Layout tests wait for native and renderer dimensions
  to settle at the requested size. The real OpenKnowledge test retries file visibility when
  responsive layout changes its sidebar toggle. The packaged-demo unit fixture skips
  login-profile PATH probing, which could outlast its approval deadline. Exact capture
  geometry and real editor assertions remain required.
  [Failure evidence and verification](reviews/2026-10-11-queue-reconciliation.md).
- **Codex additional permissions.** Permission approvals return the requested profile and
  an explicit turn scope, matching the installed Codex 0.162.1 app-server contract.
  Deny and unexpected answers grant nothing; malformed or unsupported profiles are denied
  without prompting. The approval detail includes the complete profile. Validation covers
  wire responses and the installed protocol schema; a model-generated live approval has
  not been exercised. [Recovery evidence](reviews/2026-10-11-permission-response.md).
- **Companion server shutdown.** Turning the iPhone companion off, quitting, or rebinding
  after a network change destroys every accepted socket, including one whose TLS handshake
  never finished. Before, `close()` waited for Node's 120 s handshake timeout on such a socket;
  the paused-Mac step of the iPhone CI flow hit that wait (see Known rough edges). A unit test
  holds a half-open connection and requires `dispose()` to return promptly.
- **Browser extensions and document-bound 1Password filling.** The workspace browser
  installs approved copies of restricted Manifest V3 page scripts/styles in its own
  persistent session; tampered copies fail closed. **Page options → Fill with 1Password**
  lists exact-origin Logins through the local CLI, reads only the selected item, and fills
  visible top-frame fields without submitting. Requests are bound to the initiating
  document; loading, navigation, replacement, cache entry, and closure cancel them.
  Native passkey selection tracks the initiating frame and ancestors, while sibling
  navigation stays independent. Streamer Mode masks recognized secrets in native
  login/passkey/extension labels without changing selections, credentials, package bytes,
  sites, or digests. The selected guest and matching approved extensions can read filled
  fields; credentials are not returned through Modex app-bridge IPC or stored in the app
  renderer, transcripts, or errors.
  Browser integration passed SPEC/QUALITY, **221 desktop E2E tests and seven site tests**.
  A later iPhone-only confirmation-helper repair passed **16 native tests**, fresh build,
  all-workspace typecheck, and **700 unit tests (zero skips)** with real OpenKnowledge
  enabled. Desktop/product source, all 424 build artifacts, and 13 live-check hashes remain
  unchanged, carrying forward the desktop/site and live evidence. A controlled real
  1Password CLI 2.39.0 check on that unchanged
  development build passed actual native selection, no-submit filling, scoped leak checks,
  and exact temporary Login cleanup. Normal signed-app unlock/cancellation, public TLS,
  real-site compatibility, and fresh biometric acceptance remain release gates. Device
  Touch ID stays disabled and its restricted keychain group is absent from default
  artifacts; enablement needs a separate provisioned patch and real signed create/get
  acceptance. Passkeys can use **Open in system browser**.
  [Acceptance evidence](reviews/2026-10-11-browser-credential-acceptance.md) and
  [usage and gates](browser-tools.md).

- **Chats and Space reference layout.** Graphite uses a 280 px default sidebar and
  fixed 30 px chat rows. Hover or press Right Arrow on a chat to inspect its project,
  model, branch, and PR without moving the list. Space has compact navigation, a page
  toolbar, an insert menu, local comments with per-page drafts, and a floating view of
  the current CLI chat. Share copies or exports Markdown; Sites and Images filter
  pages containing those references. Visualize prepares a chat prompt for review
  before sending. Comments stay in the local Space store and do not alter page
  revisions. [Layout and interaction verification](reviews/2026-10-11-chats-spaces.md).

## v0.0.12 release

Published on 2026-10-13 from signed tag `v0.0.12` on `8b6adb6` (#201), macOS installers only, by
Val's decision. [Release run 38465731604](https://github.com/TypeSafeAI/modex/actions/runs/38465731604)
passed signing, notarization, stapling and the full packaged E2E suite. It also passed all
three signed native updater scenarios on separate GitHub-hosted Macs, each using the published
ZIP: upgrade with automatic relaunch, a failed native download, and an interrupted download.
The independently downloaded DMG and ZIP passed checksum, signature, Gatekeeper, ticket,
version and architecture checks. Their app payloads match, and the packaged suite passed again
against the download. GitHub's latest release reports v0.0.12, and the shipped updater's own
parser finds its ZIP and digest. The run's Windows and Linux candidates passed their native
checks but were removed from the draft before publication.
[Release ledger](reviews/2026-10-13-v0.0.12-release-review.md#publication).

- **Automatic updates and durable drafts** (#181, #200, #201). Packaged Macs offer Download
  update, verify the ZIP and its notarized Developer ID publisher, and restart with drafts
  preserved; failed or uncertain restarts open saved drafts read-only. Earlier tagged runs
  found that Electron could not stage an update's `app.asar` (#200), and that two harness
  checks did not match real recovery behavior (#201). Users on v0.0.11 or earlier install
  v0.0.12 manually once. The first published-to-published upgrade will be v0.0.12 to a later
  release. [Behavior and limits](update-recovery.md).
- **Approval rules** (#185). Complete commands are inspected before a rule can allow them;
  compound and incomplete matches stay on Ask.
- **Verified release candidates** (#186). The protected workflow binds every installer to the
  signed tag, source and run, and verifies native reports before attaching to a draft. Its first
  approved tagged execution is the run above.
- **Space reference layout.** Knowledge guest bounds account for shell
  zoom, and maintenance controls wrap within the available pane. Pages reserves room for
  comments, keeps comment entry at the top and chat reachable, adds contextual selection
  actions and inline Generate/Visualize prompts, and tightens menus, templates and page
  lists to the supplied reference. The compact composer and generation cards retain drafts
  per page; selection supports links and block conversion. Completed transcript work folds
  behind its duration while failures and pending approvals remain visible. Generation stages
  a page-aware request in the existing CLI chat. Contextual insertion follows the active
  block; rendered selections support keyboard formatting. The overview adds sorting,
  a page guide and feedback template. [Verification](reviews/2026-10-13-space-reference-fit.md).

- **Held models get the pick's effort.** When a warm cache keeps a thread on a model one tier
  below Auto's pick, the turn runs at the effort the pick would have had, because an effort
  change keeps the cache. A model kept above its pick runs at the pick's lower effort. Held
  turns do not reuse the thread's last effort, so a raise does not carry into later held turns.
  The ceiling and the budget's high cap still apply. [Auto routing, step 7](auto-routing.md).
- **Claude fast mode reports what ran.** The Claude CLI says in `system/init` whether fast
  mode is serving, and if not, why. On this account it was off because usage credits are off
  (`extra_usage_disabled`), which is why `usage.speed` read `standard` on 2026-10-12. Modex now
  records the fast mode a Claude turn actually ran with, and an Auto receipt that asked for fast mode
  says why it did not apply. Only Opus offers fast mode on Claude, matching Claude Code, so Auto
  no longer asks for it on Haiku or Sonnet. [Auto routing, step 6](auto-routing.md).
- **Worktree merge proof** (#188). A squash-merged tip whose tree matches the landed commit
  counts as proof, so branches that merged `main` in before landing can be pruned.
- **Haiku alias label.** The model picker now names `claude-haiku-5-5` as the current
  Haiku, matching what Claude Code 2.1.296 runs for `--model haiku`; it previously said 4-5.

The [local recovery record](reviews/2026-10-13-local-recovery.md) ties the recovered
permission, Streamer Mode, Space/Knowledge, and readiness work to its delivery PRs. It
retains the integrated candidate's CI and native evidence separately from the published
v0.0.11 artifacts, including the original CI failures and remaining acceptance limits.

## On main, unreleased

- **Analytics export and recovery.** The native dashboard permits its own CSV
  export through a save dialog while other downloads remain refused. A torn
  usage-ledger tail no longer consumes the next recorded turn, and dashboard
  asset requests reject directory symlinks as well as linked files.

- **Analytics visibility during loading.** A delayed dashboard load cannot reopen
  Analytics after Streamer Mode, a dialog, or navigation hides it. The latest
  requested bounds win, and closing the window invalidates pending show requests.

- **Paired iPhone menu recovery.** The paired-flow test retries an ignored Workspace
  options tap once within its existing deadline, only while the menu is absent.
  It still requires the real Forget paired Mac item before proceeding.

- **Notes hierarchy recovery.** Folder-title changes reserve names against their
  children; restored folders stay separate from newer same-named folders while
  retaining attachments. Interrupted restores use the same placement rules, and
  migration resumes under already-published parents without overwriting them.
  Migration also reserves each folder note’s name before placing its children.
  Folder settlement records durable intent so interrupted directory and note
  renames finish before a read derives the hierarchy.
- **Images and native Plugins.** Full desktop adds owned image assets, Chat/Space reuse,
  plugin inventory/discovery/local sources and supported native CLI lifecycle commands.
  Generation and revisions use an explicitly selected plugin skill through the normal CLI
  runner, approvals and byte-validated registration. Drafts, cancellation and interrupted
  jobs survive restart without automatic replay. Shutdown drains plugin commands and
  ordinary close protects unacknowledged image prompts. Store/iPhone access stays gated.
  [Feature guide](images-plugins.md) and [implementation/verification ledger](superpowers/plans/2026-10-15-images-plugins.md).
  Live provider/plugin acceptance, human keyboard/VoiceOver acceptance and signed/notarized
  release verification remain open; offline fixtures do not establish those outcomes.

- **Coverage source inventory.** Unit coverage includes unexecuted production files
  across core, desktop, site, Store desktop, and the release endpoint. Reports use
  original source paths, omit generated duplicates, and do not claim browser or
  native E2E coverage.

- **Carriage-return title pastes.** Space accepts CR-only and mixed line endings
  when splitting pasted titles from their body, avoiding a lost paste and parser
  error while preserving the body text’s existing line endings.

- **Pasting a chat report into Space.** Pasting several lines into a page title keeps the
  first line, without its heading marker, as the title and moves the rest to the top of the
  page. The title field used to flatten the lines into one and cut it at 200 characters.
  Pasting into a block or importing a Markdown file drops ChatGPT's citation markers. Their
  source IDs resolve only inside that ChatGPT conversation, and pages showed them as boxes.
  Entity markers keep their visible name.

- **Delete selected Space text.** Backspace/Delete now removes a safely mapped
  selection in rendered page text and places the editing caret at the deletion.
  Plain paragraphs use DOM offsets so repeated words and spaces delete the exact
  selected occurrence. Source editing retains native textarea behavior.

- **Knowledge editor spacing.** The running editor shares the window titlebar
  and fills its content area without the surrounding sheet frame.
  The editor fills the area beside the navigation rail and collapses the outer Space
  sidebar when ready, avoiding two file navigators beside the document and chat.
  The sidebar toggle can reopen it temporarily; returning to pages or Home restores
  the saved sidebar preference. Setup and maintenance remain available.

- **E2E launch waits for the native show.** The desktop e2e launch helper waits for each
  window's `show` event, recorded from a listener installed before the window exists, instead
  of `isVisible()`, which on macOS turns true as soon as the window is ordered front and before
  the window server has displayed it. The v0.0.7 release-run failure resized the window inside
  that gap; its cause is now recorded in the
  [release review](reviews/2026-10-05-v0.0.7-release-review.md#hosted-candidate-checks).
  The update-banner spec's resize also goes through `resizeWindow`.
- **pnpm only** (#196). The workspace installs with pnpm 10 from `pnpm-lock.yaml`, which
  carries the same 417 resolved packages as the retired npm lockfile. npm and Yarn refuse
  through `devEngines` and `packageManager`; a root `preinstall` guard stops other installers.
  `nodeLinker: hoisted` keeps the flat `node_modules` that electron-builder packages.
- **Update failures say why.** When preparing an update fails, the banner adds the failure's
  own reason under its generic message and the main process logs the full error. In v0.0.12's
  first signed run the generic message alone hid Electron's `Invalid package …/app.asar`.
  [Behavior](update-recovery.md#download-and-restart).
- **Event journal, opt-in** (Routines Phase 0). With `MODEX_EVENT_JOURNAL=1`, Modex records every
  thread event in `app/events.sqlite` (`node:sqlite`) with a durable cursor. It writes alongside
  the state files, which stay authoritative. A real session replays from the journal to its exact
  saved transcript. The resume endpoint and retention come next. [Event journal](event-journal.md).
- **Analytics in the rail.** The rail's Analytics icon opens the usage dashboard on what this Mac
  actually used. Each turn that calls a model, Auto or not, records its tokens, cache reads and
  writes, and output in `app/usage.jsonl`, by model, project, thread and account. Prompts, files
  and replies are never recorded, and costs stay unpriced. The dashboard is its own document in a
  native view served from `modex-analytics://`, without the desktop bridge; Settings → General can
  hide the icon. The standalone preview keeps its Demo Data. [Analytics](analytics.md).
- **Thread archiving on Mac and iPhone.** A thread can be put away from the Mac (sidebar row
  menu, title bar ⋯ menu) or the phone (hold a thread, or the transcript's ⋯ menu). Archived
  threads leave the working list: the Mac keeps them under **Archived (n)** per project, where
  search still finds them; the phone hides them until **Show archived** is chosen, and forgets
  that choice with the workspace. The transcript stays, a new message brings the thread back,
  and a thread that is working or waiting for an approval cannot be archived. The paired API
  adds `POST /v1/threads/:id/archive` and an `archived` flag on snapshot threads; an older Mac
  answers the phone with 501. Companion build 6 does not include the phone side; it ships with
  the next iPhone build.
- **One CI run per PR push.** `CI` runs on `push` only for `main`; every other branch is tested by
  its pull request's run, which reports the required `unit + e2e (macOS)` check. Before, each
  push to a PR branch queued two identical macOS runs, and on 2026-10-15 about 30 runs waited
  for 2–3 hosted macOS runners. A branch pushed without a PR gets no CI until one is opened.

- **Fable falls back to Opus when out of usage credits.** When Claude Code refuses Fable for
  usage credits before anything ran, Modex reruns the turn on Opus in the same session, posts
  a warning that says so, and starts Fable turns on Opus for the next hour. A refusal after a
  reply, tool or reasoning keeps its failure card, so no work runs twice. The CLI's synthetic
  refusal reply no longer shows as an assistant bubble, and the card now reads "out of usage
  credits" instead of "unknown". Empty fallback replies retain a Retry card, and Auto
  records the model that actually ran without learning a user override. Settings → General turns the fallback off; it is on by default.
- **Notes are Markdown files** (first slice of notes in folders). Space pages now live under
  `MODEX_HOME/notes/` as one Markdown file per page, in Personal › Notes; a page with child pages
  is a folder holding a note of the same name. Ids, revisions, history, trash, comments and the
  Pages tools behave as before. Edits, moves and new files made outside Modex (Finder, an editor,
  Open Knowledge) show in Space and in the page's history as "Outside Modex". The first launch
  moves `app/space.json` into the folder and never writes it again. A file is renamed to match its
  title when the title loses focus. [Notes folder](notes.md).
- **Workspaces, projects and folders in Space.** Space's sidebar shows the notes folder as
  Workspace › Project › Folder › pages and files. Create a workspace from Space options, and a
  project, folder or page from a row's menu; rename, move (Move to…), reveal in Finder, and delete
  what is empty. Folder moves reserve names against their children and replay interrupted folder-note
  renames without overwriting intervening external edits; default page creation follows renamed or
  moved default containers even if their index write was interrupted. Creating a project or
  folder expands its container to show the editor. Each is a real folder on disk.
- **Each project has its own notes.** Adding a project to Modex gives it a notes project in the
  default workspace (existing projects get one when notes first open). The project's menu in the
  chat sidebar offers **Open notes**, and with more than one workspace the sidebar groups projects
  under them, with **Move to <workspace>**. Removing a project keeps its notes; adding the same
  folder again links them back. The thread's right-hand panel is now called the **side panel**
  ("Show side panel ⌘J"), so "workspace" means one thing.
- **Agents work in their own project's notes.** With **Manage notes** on, a project's agents see and
  change only that project's notes; another project's are not listed, read or changed. New
  `modex_pages` tools list a folder, create folders, move notes within the project, and read text
  files. Scope lookup failures keep the turn running while refusing Pages access, even when the
  failure has no message. **Open notes** reveals its project once per request, including across
  search and filter changes.
- **The knowledge base can be your notes.** Space → Knowledge base offers **Use your Modex notes**:
  Open Knowledge then opens the notes folder, and a page's menu offers **Open in knowledge base**
  instead of copying it. Knowledge tools stay inside each project's notes there too.
- **Files in your notes.** A project's or folder's menu offers **Import files…**, and files dragged
  in from Finder onto a project or folder are copied there (up to 50 at a time, 100 MB each;
  same names get a number). Clicking a file previews it: images and text files show in Space,
  and anything else offers Open and Reveal in Finder. Drag a row onto a folder, project or
  workspace to move it there. A page shows images beside it by relative path
  (`![](assets/diagram.png)`, as Open Knowledge writes them), from inside its own project only.
  Modex watches the notes folder, so Space's polls skip the walk while nothing changed.

- **Reliable native-window acceptance.** E2E launches retain distinct show and first-paint
  observations in main before a test connects. Inactive windows also require visible,
  matching native/renderer geometry unchanged for 200 ms; visibility alone never passes.
  Failed setup closes the owned app without masking the original error.

- **Thread/project deletion during active turns.** A dedicated runner admission hold
  lets deletion stop and drain its own turns while unrelated turns continue, without
  weakening restart checks or the native draft preparation/adoption transaction.
  Deletion now briefly drains requests already in progress instead of refusing a click
  that races a background request; a bounded timeout preserves all owners.
  Stop requests remain admitted during deletion for CLI force-stop recovery. Internal
  routing and title updates from admitted turns also finish while new edits stay fenced.

## In flight

- **Claude Agent SDK ([fork PR #1](https://github.com/snowopsdev/modex/pull/1)).** Claude
  turns use pinned `@anthropic-ai/claude-agent-sdk` (`query()`) with the user's installed
  `claude`, preserving CLI login, CLAUDE.md, hooks, MCP servers, skills and background
  work. Stop allows a graceful interrupt before signals and waits for process close.
  Deferred launches inherit the SDK's cancellation signal so they cannot outlive Stop.
  Withdrawn approvals dismiss their cards and cancel rule evaluation. CLI failures retain
  stderr and exit codes. Offline tests exercise the real SDK handshake, permissions,
  cancellation and shutdown. Packaged builds omit bundled native CLI packages. The
  [review evidence](reviews/2026-10-15-claude-sdk-review.md) records checks and the installed
  Claude smoke limit; this migration has not landed on main.

- **Desktop v0.1.0 preparation.** The first minor release ships everything under "On main,
  unreleased": Markdown notes in workspaces and projects with per-project agent scope, files in
  notes, Images and native Plugins (Val's decision), Analytics and thread archiving. It is the
  first published-to-published automatic update, from v0.0.12. A signed rehearsal and the full
  test suite passed locally. Notarization, the packaged E2E on the signed tag, the hosted native
  updater scenarios, independent download checks and publication remain.
  [Candidate review](reviews/2026-10-15-v0.1.0-release-review.md).

- **Verified multiplatform release candidates.** The release workflow now joins native
  Windows/Linux checks with signed macOS acceptance, binds installer bytes and receipts
  to the exact tag/source/run, and prepares a draft with five installers, checksums and
  an acceptance manifest. The combined recovery source passed local build/typechecks and
  1,405 unit tests (15 skipped). Native reports and all three installer hashes were verified
  on [the release-patch run](https://github.com/TypeSafeAI/modex/actions/runs/38230412498).
  The combined workflow first ran on an approved signed tag for v0.0.12 (run 38465731604);
  its Windows and Linux candidates passed native checks but were not published. Windows
  signing stays deferred; account/session and historical migration gaps remain.
  [Attachment checks](release-signing.md#candidate-attachment-checks).

- **Local work recovery (October 11).** The seven Space/Knowledge snapshots have
  no remaining product or test patch beyond #144, #150, and #154. The
  [recovery audit](reviews/2026-10-11-space-recovery-audit.md) records exact
  comparison results and corrects historical runs left marked in progress.
  On 2026-10-14 Val approved removing those dirty source trees with the other unmerged
  worktrees. Each is archived outside the repository with its commit bundle, uncommitted patch,
  and untracked and ignored files. Each archive folder's README gives the restore steps. The recovered
  [October 7 GitHub architecture review](reviews/2026-10-07-workos-github-integration.md)
  is a historical proposal: native identity-only sign-in shipped separately in
  #141. Repository authorization still needs a dedicated GitHub App owner and
  hosted service destination before implementation and live acceptance.

- **Mac App Store edition.** Val selected investigation of a sandboxed Store front end
  with a separately installed signed host to retain full desktop functionality. Apple's
  sandbox and standalone-app rules require an architecture and review gate. The
  [investigation and parity matrix](mac-app-store.md) records the proposed ownership and
  end-to-end acceptance gates. A fail-closed MAS packaging and App Store Connect validation
  command is documented. The authenticated October 11 readback confirms approved beta
  reviews for Mac Store 0.0.8 and Companion 0.1.0 (5): the Mac is `BETA_APPROVED`,
  and Companion is in external `IN_BETA_TESTING`. Both latest builds are assigned to
  internal and public-link-enabled external groups. [Current Apple receipt](reviews/2026-10-11-apple-status.md).
  The [current parity matrix and listing packet](reviews/2026-10-11-store-readiness.md)
  records implemented host discovery/launch, signed/live acceptance gaps, and Store exclusions. Both beta review records contain
  offline demo instructions, and both reviewer replies are posted; the iOS reply includes
  the reusable QR. The [review access ledger](reviews/2026-10-06-review-demo-access.md)
  records build IDs and verification. The production Mac draft is 0.0.8 with its build
  and review notes selected, but still needs screenshots, description, keywords, and
  support URL, privacy-policy URL, and copyright. Three source-built Store screenshots and
  listing text are prepared locally. Current-account signed candidates passed running-host
  discovery, real Codex and Claude turns, native code comparison/denial, and credential persistence
  after relaunch using an isolated runtime keychain name. Store Stop ended a real Claude
  background task. A later bounded native run passed host-restart reconnect with the same
  Store process and unsent draft, matching-code approval, and revocation with credential
  removal. All disposable grants were revoked and test apps stopped. Fresh-user setup,
  installed-host auto-launch and sleep/wake remain unaccepted.
  Sandboxed lookup could not read the Documents fixture; an unchanged copy in Applications
  passed exact-host selection from both original and relocated Store apps. A later Open
  action launched the isolated Preview, and the user confirmed clicking Allow; native
  revocation removed that grant. The intended Cancel observation was missed. This also
  exposed a regular-host activation gap: App Sandbox discards launch arguments, while the
  Preview starts its service automatically. A URL activation handoff is implemented with
  an additive signed capability check; focused startup, capability and authorization tests
  pass. The main `312a138` integration passed build/typecheck, 488 unit tests plus one
  expected skip, and 177 desktop plus seven site UI tests. The signed sandbox helper then
  launched regular Modex through that URL without flags and reused the same process,
  port, and certificate with zero grants. This used an explicit candidate path; the full
  welcome Open sequence remains unaccepted. The subsequent GUI Connect acquired a grant
  before native confirmation capture, so its Cancel check stopped. That grant was revoked
  and complete credential/process/profile cleanup passed; attribution is awaiting Val's
  response. The temporary applications were unregistered and moved back into private
  artifacts. The `edf52fc` main integration retains the Companion and Store recovery
  changes alongside Canvas, native platform support, Knowledge and worktree maintenance.
  Browser-tools recovery preserves keyboard access to connection controls, and native
  Workspace commands pause while browser tools are open. Both regressions failed before
  the guards and passed afterward. Fresh build/typecheck passed, with 834 unit passes and
  12 native Windows cases skipped on macOS, plus all 241 desktop and seven site UI tests
  with OpenKnowledge enabled. An isolated iPhone simulator passed all 41 native unit and
  28 UI tests with zero skips. The complete tested source matched the actual-main
  integration; subsequent changes only record this verification. Earlier upstream iPhone
  CI action failures remain separately recorded and undiagnosed. Fresh hosted checks,
  protected landing and the remaining native acceptance gates stay open.
  [Signed acceptance evidence and limits](reviews/2026-10-11-store-signed-acceptance.md).
  Beta approval covers the October 6 builds; production
  approval and acceptance of this branch's changes remain open.

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
  `IN_BETA_TESTING` in the existing Internal group with one tester. The source plist records the system-encryption
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
  October 11 readback confirms build 5's beta review is approved and external testing is
  active. Two isolated signed-development physical iPhone flows passed pairing persistence,
  reconnect/revocation, persistent approvals, complete skill descriptions, and retirement
  against a real merged PR. On 2026-10-13, build 6 (v0.0.11 source, adding multi-network
  reachability) passed processing and entered external testing, with beta review approved at
  submission. Physical installation of build 6 from TestFlight was not performed.
  First-use permission diagnosis and final TestFlight candidate
  acceptance remain open. [Physical evidence](reviews/2026-10-11-iphone-acceptance.md).
  The first connection target is the same local network; [the companion guide](ios-companion.md)
  records the pairing and release path.

- **Provider feasibility (#78/#79).** [Gemini](gemini-feasibility.md) and
  [Grok](grok-feasibility.md) are explicitly deferred after the 2026-10-11 macOS refresh.
  Gemini 0.63.0 completed a text turn, resume, and cancellation, but the negative permission
  probe timed out during initialization. Grok 1.0.46 accepted cached auth and session RPCs,
  then its text turn timed out; native plan/sandbox also has documented permission limits.
  Neither provider is enabled. Both decisions include reproducible probes and distinguish
  observed failures from unverified capabilities; coding execution remains CLI-only.
- **Approval rules (Jev-gated).** Part 1 (#54) merged with the gate off and no UI: every
  backend's approval request carries an action, `engine/approvals/digest.ts` builds the
  scrubbed state Jev sees, and `engine/approvals/gate.ts` decides allow, ask or never. Part 2
  (PR #107, merged) adds a Settings draft editor, project-scoped Try it previews, compact persisted
  receipts, the `(rule: …)` deny reason, `e2e/approvals.spec.ts`, and [usage docs](approval-rules.md).
  The gate remains off: saved rules can be previewed but do not decide live approvals.
  Reconciliation with the merged companion passed build, typecheck, 15 core and 248 desktop
  tests plus the browser bridge test, and all 94 desktop e2e checks. This integration follows
  v0.0.6. The [2026-10-11 readiness review](reviews/2026-10-11-approval-provider-readiness.md)
  expanded evaluation to 62 checks: 56 expected results and six false allows (quoted test
  names and truncated destructive suffixes, three repeats each). Human acceptance is prepared
  but not performed; native escalation normalization also needs proof. The gate stays off.
  The
  [reconstructed spec](specs/2026-10-01-modex-jev-approval-rules-spec.md) records the part 2 decisions.
  By default a new rule covers the current project, and rules that need Jev show as inactive
  without it rather than being hidden.
  A follow-up makes an allow ask when the command chains or redirects commands or is longer
  than the text Jev sees, and makes receipts say when Jev was not consulted. That closes the
  truncated-suffix false allow; the quoted-test-name case remains open.
  [Recovery verification](reviews/2026-10-12-approval-recovery.md) passed 1,376 unit tests
  (15 skipped), 271 desktop E2E cases and seven site cases. The gate remains off by default.
- **Retired worktrees.** None from this list awaits a disposition. All six were retired after
  their work landed, and their uncommitted work or unique commits were saved as patches outside
  the repository first. On 2026-10-14, the guard pruned every merged worktree and branch, keeping
  its recovery bundles. With Val's approval, 32 unmerged or dirty worktrees and 8 branches were
  archived and then removed. These included recovered snapshots, closed PRs #145, #174, #177
  and #182, and the `backup/*` branches. Each archive was verified before removal: bundle
  verify, a patch reverse-applied on the live tree, and tar member counts. Only open-PR and
  in-use worktrees remain.
  - `auth-retry` (2026-10-09): the retry and auth recovery work is on `main` via #104.
  - `finish-auth-approvals` (2026-10-09): reconciled in #107, with the auth fix in #104. Its
    remote branch stays because closed PR #68 references it.
  - `approval-receipts` (2026-10-07): superseded by #107.
  - `pr-review-browser` (2026-10-07): the browser bridge merged in #105.
  - `status-reviews` (2026-10-07): its 2026-10-01 docs snapshot was outdated by later status
    rewrites.
  - `livestream-redaction` (2026-10-07): superseded by #100.

## Known rough edges

- **node-pty is a pre-release.** v0.0.6 still ships `node-pty@1.2.0-beta.15` (#65), because 1.1.0
  leaks one `/dev/ptmx` per terminal on macOS. The beta passed the unit suite and the packaged
  e2e, including a test that counts the shipped app's PTY handles, with library validation
  on. Move to 1.2.0 stable when it ships.
- **Layout e2e can measure the terminal panel mid-animation.** The panel rises 6 px over
  180 ms on entry; CI saw 2–3 px of offset on one of two runs of the same commit (PR #35). The
  assertion now polls for the settled bottom edge; other sub-pixel checks in
  `e2e/layout.spec.ts` that follow a transition may need the same.
- **`iPhone companion` CI flakes, handled 2026-10-09.** The job failed five times in two days on
  five different lines (#133, #141, #148, and twice on #149's branch). The runner's `.xcresult`
  bundles showed three causes, none in the app. (1) The tap helper waited on an
  `XCTNSPredicateExpectation` over `hittable`; XCTest answers that by fetching the element's
  frame in a nested wait, and when the outer wait timed out it interrupted the fetch, so the
  element reported a null frame and "Failed to determine hittability" failed the test while
  the button sat on screen (run 37927792976; one evaluation took 10 s there, snapshots 2–3 s
  each). (2) `typeText` returned while keystrokes were still in flight, so the next tap sent
  "Sh" and left "ip it" in the draft, and a tap during a sheet's animation never focused the
  field. (3) A SpringBoard prompt appeared two minutes into the paired flow; the app stops
  polling while its scene is inactive, so the state the test waited for never came. The
  helpers in `apps/ios/ModexCompanion/UITests/XCUIElement+Ready.swift` now poll in plain
  loops (no evaluation can be interrupted), wait for a settled, finite frame before asking
  `isHittable`, retry the tap until the field has keyboard focus, wait for the typed value,
  and answer system prompts during actions and long waits. Timeouts alone (#147) did not
  remove any of the three. (4) Found after those landed (run 37983100896, `main` at #154): the
  paired flow's `/resume` call timed out while the runner was healthy (its 10 s wait expired
  on schedule). The fixture answers only after `CompanionServer.dispose()` finishes, and
  `https.Server.close()` waits for a socket the phone opened but never carried through the
  TLS handshake, because `closeAllConnections()` only knows sockets that completed TLS; Node's
  handshake timeout is 120 s. A slow simulator stretched the outage step to 66 s, so the resume
  landed inside that window (green runs finished the step in 10 s). Reproduced locally with the
  real fixture and one half-open connection: no reply in 15 s before the fix, 204 in 6 ms after.
  `close()` now destroys every accepted socket. The fix's own commit then split its two CI runs:
  the pull_request run passed the whole paired flow (resume answered in under a second) while
  the push run (38012518622) failed earlier, at the first follow-up. The phone's log shows one
  request hitting its 8 s timeout ten seconds before the send tap, no later request failing, and
  the reply never showing within 20 s. The fixture writes no log, so that run stays unexplained;
  if it recurs, make `fixture.mjs` log each request with a timestamp before anything else.
  The CI job also turns off the simulator's hardware keyboard before the first boot, so the
  software keyboard appears and the helper's fallback focus check (`app.keyboards`) can see it;
  local Simulator settings are left alone.
- **A resumed Claude session could end a turn with no reply (fixed 2026-10-13).** When Modex
  stops a turn while a background task is still running (Stop, or the 30-minute cap), the next
  message's `claude --resume` first replays that stopped task as a turn of its own: a
  `task_notification`, an `init`, and a success `result` with `num_turns` 0 and no text, and only
  then the `init` of the turn that answers the message. Modex ended the turn on that result. The
  message and its routing were persisted and nothing else; the thread went idle; the CLI did the
  real work unheard, for an hour on 2026-10-09 (thread `52868298`). Reproduced outside Modex by
  stopping a `claude -p` turn mid-background-task and resuming it (claude 2.1.296). The backend now
  holds a result from a turn that never called the model until the real turn answers, or the idle
  window passes; and a turn that ends with no items at all becomes a failure card with Retry.
- **`iPhone companion` CI flakes, root cause (2026-10-13).** Eight failures in three days (runs
  38370101202 and 38216764305 on `main`, six on branches) each named a different line: a
  screenshot timeout, "not ready to tap within 30 s; last frame none" three times, typed text cut
  off at "Please su", a failed app termination, and two ignored-first-tap assertions. The Session
  logs of three red runs and the green run from the same morning (38386254082) tell one story:
  GitHub's shared `macos-latest` runners spend 5–30× longer than a developer Mac on every XCTest
  round trip, red or green. Single steps reached 15–28 s for "wait for app to idle" (100–135 of
  them per run), 25–34 s per app launch, 16–22 s for the SpringBoard "interrupting elements"
  check before a tap, and 5–9 s per accessibility snapshot. A run went red whenever one such step
  crossed one of the suite's fixed 10, 20 or 30 s budgets; today's `main` failure was a screenshot
  attachment hitting XCTest's own 30 s after every assertion in the test had passed. The earlier
  rounds (above) each fixed the step that failed last and the failure moved. Now every budget is
  `UITestBudget.seconds(base)`, multiplied by `MODEX_UI_TIMEOUT_SCALE` (×4 in CI, forwarded with
  xcodebuild's `TEST_RUNNER_` prefix in `Scripts/test-e2e.sh`), screenshots are best-effort
  evidence (`attachScreenshot`, an expected failure when the simulator cannot deliver one), and
  `Scripts/xctest-activity-times.py` totals a Session log's XCTest steps so the next report starts
  from the same numbers. A green run is unchanged by the scale: a budget only matters once it is
  exceeded. Steps XCTest bounds itself (launch, terminate, event synthesis) are outside the scale;
  one of the eight (a 2026-10-12 "Failed to terminate") was of that kind. A loaded developer Mac
  (load 577 on 16 cores during the run) shows a different bottleneck: snapshots stayed at 0.2 s,
  but single "wait for app to idle" steps inside `tap()` reached 86 s while the app's 2.5 s
  polling and spinner kept it busy, and the unscaled demo test still passed in 187 s because
  those waits never touch the suite's budgets. The CI runners are slow in the snapshot path,
  which is the one the budgets measure.
- **Local e2e on a machine in use.** The test window is shown inactive under `MODEX_E2E`
  (v0.0.3); if a run still garbles terminal input, nothing else should be typed while it runs.
- **Native picker test readiness.** The attachment test waits for the recovery file before
  reading persisted drafts. A delayed file reproduced the `ENOENT` from macOS job
  `114881524305`; the corrected test passed three focused runs and the full 274 desktop
  and seven site cases. Count, unique-ID, file-content and reload assertions remain;
  permanently missing or malformed persistence still fails. App behavior is unchanged.
- **Owner-removal test readiness.** The fixture waits for the displayed branch after launch
  and each project switch. Draft persistence alone does not prove the asynchronous branch
  lookup has left restart admission. Holding that lookup reproduced the refusal from
  macOS job `114750352400`; the corrected test passed three times with the same delay.
  That CI run did not record its pending channel. Production admission and refusal behavior
  are unchanged.
- **Demo thread navigation in iPhone tests.** Opening the demo thread uses the same bounded
  destination check as Back: at most one retry while the original row remains ready, and no
  further tap after the thread appears. The native regression deliberately ignores the first
  opening and Back actions. In job `114763678754`, the initial row tap left the dashboard
  visible; native evidence does not establish why. This is a test correction, with hosted
  native verification required before merge; app navigation is unchanged.
  The destination check first requires the original row to disappear: job `114806660312`
  repeatedly inspected the absent Back button and exhausted the retry budget without a
  real thread tap. Both destination conditions and the two-attempt, 30-second budget remain.
- **Native and renderer sizing in desktop tests.** The layout helper can make one native
  size transition when the renderer stays at different dimensions despite correct native
  bounds. It observes the intermediate dimensions before restoring the target and still
  requires both sizes to settle. The original 15-second budget and permanent-clamp refusal
  remain. This addresses a locally reproduced test failure from job `114782323496`; the
  underlying cause of the native/renderer divergence is unproven. App sizing is unchanged.
- **Auto-titles run a real CLI turn.** It is a separate, non-resumed conversation with tools
  refused, but it does consume one small model call per new thread on Claude and Codex.
- **Title quality and Jev's follow-up picks are unproven by the suite.** The mock backend does
  not name threads and e2e runs without a key; only the heuristic path is exercised.
- **ChatGPT-plan Codex threads poisoned by multi-agent items.** Until the fix on `main`
  (2026-10-09), a Codex 0.160+ child signed in through the app-owned ChatGPT plan could call
  `spawn_agent`; OpenAI's subscription-sharing endpoint rejects the resulting `agent_message`
  items (`subscription_sharing_unsupported_capability`) and the rejection itself lands in the
  parent thread's history, so the thread fails every turn afterwards. Plan children now run
  with `features.multi_agent` off and the failure card says to start a new thread. Threads
  poisoned before the fix stay poisoned in Modex; see [chatgpt-signin.md](chatgpt-signin.md).

## Next

Roughly in the order they earn their place; none is scheduled.

1. **Publish Windows and Linux installers.** The protected pipeline built and verified them for
   v0.0.12 (run 38465731604), but Val chose macOS-only publication. Publish them from a
   later signed tag after release review. Candidate Actions artifacts are not releases. Provider-account acceptance,
   KWallet6/full graphical sessions, and historical schema migration remain unproven;
   see [native-platforms.md](native-platforms.md) for candidate evidence and its limits.
2. **Routines.** Read-only routines come next: Chat or Plan turns on a timer, with the
   result written to a Space page. They follow a groundwork phase (a shared decision service
   and an event journal), and routines that change code wait for the approval gate decision.
   See the [routines specification](specs/2026-10-11-modex-routines-spec.md).
3. **Codex Cloud tasks and other scheduled automation.** Out of scope; Modex stays CLI-only
   for coding turns (no API execution mode — see `AGENTS.md`).

## Conventions that keep this page true

- One worktree per session (`scripts/worktree.sh new <slug>`), removed after the merge. A
  branch that is not being worked on is either extracted into a PR or deleted; nothing parks.
- PRs merge through `~/.claude/scripts/gh-merge-when-green.sh <pr> --squash` after CI, with
  signed commits only.
- A PR that changes scope updates this page and, for user-facing behaviour, the README.


## Local Mac Store development preview (unreleased)

Store recovery now pauses on certificate identity/date/hostname failures and incompatible
host protocols while retaining saved access and the mounted draft. Explicit retry rechecks
the saved pin and stream without replaying commands. Discovery refreshes installed-host
availability and retries failed group-directory lookup. The Store owns unavailable Modex
account responses and a native Workspace menu through the existing shortcut pipeline.
See the [recovery verification](reviews/2026-10-11-store-recovery.md) and
[Store readiness audit](reviews/2026-10-11-store-readiness.md) for evidence and remaining gates.


PR #119 adds a dedicated opt-in loopback host and a sandboxed Electron MAS client that
reuses the desktop renderer. Val approved integrating this development preview. Transport
boundary/revocation tests and a signed native smoke test cover explicit pairing, encrypted
saved access, an approved scripted edit, terminal execution, restart recovery and revocation.
App Sandbox was verified on the running client. Graceful host shutdown, full parity and
real CLI acceptance, provisioning and App Review eligibility remain pending. Store 0.0.8
was approved for macOS TestFlight beta testing on 2026-10-07; this is not an App Store
release. See [the preview ledger](mac-store-preview-plan.md) and
[run instructions](../apps/store-desktop/README.md).

The shared Mac connection settings now recognize existing system CLI sign-ins and recheck
them on return from Terminal or a browser. Authenticated Claude no longer asks for another
login; an authenticated Codex CLI account remains selected unless the user chooses another
account. Executable overrides still require verification before saving. Read-only checks on
this Mac confirmed Claude Code 2.1.289 and Codex 0.160.1 are already authenticated; this is
account-detection evidence, not a new live coding-turn or Store distribution acceptance.
