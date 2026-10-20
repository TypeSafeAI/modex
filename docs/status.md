# Where things stand

The living map of what has shipped, what is on `main` but unreleased, what is in flight, and
what is next. Update it in the same PR that changes any of those; a reader should be able to
plan the next session from this page alone. Release evidence lives in [`reviews/`](reviews/).

_Last updated 2026-10-20._

## Shipped

Each release's review holds its details and evidence; the table links it.

| Release | Date | Merge | Headline |
| --- | --- | --- | --- |
| v0.0.1 | 2026-09-26 | — | First macOS build: two backends, Auto routing, worktree threads, Changes panel. |
| v0.0.2 | 2026-09-28 | #33 | Desktop lifecycle races, Changes safety, streaming performance, layout persistence. [Review](reviews/2026-09-28-release-review.md). |
| v0.0.3 | 2026-09-28 | #34 | Embedded terminal panel ships; unsent text stays with its thread; inactive test window. [Review](reviews/2026-09-28-v0.0.3-release-review.md). |
| v0.0.4 | 2026-09-29 | #37 | Threads name themselves; one suggested next step after each turn. [Review](reviews/2026-09-29-v0.0.4-release-review.md). |
| v0.0.5 | 2026-10-03 | #69 | First Developer ID signed and notarized build, from the protected `Release` workflow; the Modex app icon; Jev settings and routing limits (#51); terminals no longer leak a PTY each. [Review](reviews/2026-10-03-v0.0.5-release-review.md). |
| v0.0.6 | 2026-10-05 | #106, #110 | Jev-inspired near-black blue/pink workspace, Claude/ChatGPT sign-in, Retry, Streamer Mode and the paired iPhone service. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.6). [Review](reviews/2026-10-03-v0.0.6-release-review.md). |
| v0.0.7 | 2026-10-05 | #117 | Official pink identity, persistent Companion pairing, update banner, OpenCoven theme, verified CLI discovery, polished connections and full-width website walkthrough. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.7). [Review](reviews/2026-10-05-v0.0.7-release-review.md). |
| v0.0.8 | 2026-10-06 | #126, #127 | Per-thread provider/model, live branch and PR state; tabbed workspace, empty-screen polish and failure recovery. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.8). [Review](reviews/2026-10-06-v0.0.8-release-review.md). |
| v0.0.9 | 2026-10-08 | #137, #139, #144, #141, #142 | Graphite shell, Settings privacy, Pages/Knowledge, Sources, background turns and separate GitHub identity. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.9). [Review](reviews/2026-10-08-v0.0.9-release-review.md). |
| v0.0.10 | 2026-10-09 | #148, #149, #150, #154, #151 | Agent-maintained Knowledge and Pages, compact resizable panels, approval policies, task retirement and shutdown recovery. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.10). [Review](reviews/2026-10-09-v0.0.10-release-review.md). |
| v0.0.11 | 2026-10-13 | #152, #164, #166, #178, #180, #183, #184 | Sticky Auto routing, composer attachments, Canvas previews, browser extensions with 1Password filling, minimal review rail, multi-network Companion. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.11). [Review](reviews/2026-10-12-v0.0.11-release-review.md). |
| v0.0.12 | 2026-10-13 | #181, #185, #193, #195, #199, #200, #201 | First self-updating macOS release: verified download and restart with draft recovery; held-model effort; Claude fast-mode receipts; Space reference layout. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.0.12). [Review](reviews/2026-10-13-v0.0.12-release-review.md). |
| v0.1.0 | 2026-10-15 | #208, #219, #222, #226, #227, #236, #243, #246 | Notes as Markdown files in workspaces and projects, with per-project agent scope and files; Images and native Plugins; Analytics; thread archiving; first Windows and Linux installers. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.1.0). [Review](reviews/2026-10-15-v0.1.0-release-review.md). |
| v0.2.0 | 2026-10-18 | #253, #257, #266, #267, #269, #248, #272 | Read-only routines on a timer, on one decision service for Jev; the notes fixes from v0.1.0's review (#241); Copy details and Retry on every inline error; Analytics restyled; new image jobs no longer stuck at "queued". [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.2.0). [Review](reviews/2026-10-18-v0.2.0-release-review.md). |
| v0.3.0 | 2026-10-20 | #282, #284, #286, #293, #317, #333, #335, #337 | Native conversation fidelity: typed items and honest outcomes, evidence, plans and task records, approvals and questions answered once, a truthful Claude Stop; macOS updates over the air with install on quit; full Markdown in replies. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.3.0). [Review](reviews/2026-10-20-v0.3.0-release-review.md). |

Releases through v0.0.12 are macOS Apple Silicon only; v0.1.0 adds unsigned Windows x64 and
Linux x64 installers, which update manually. v0.0.1–v0.0.4 were ad-hoc signed; from v0.0.5
releases are Developer ID signed (Soul Protocol LLC), notarized and stapled. The release
sequence (worktree → review doc → signed build + packaged e2e → guarded merge → signed tag →
the `Release` workflow, behind the `release-signing` reviewer → GitHub release with
`SHA256SUMS.txt`) is in [release-signing.md](release-signing.md#cutting-a-release).

## Landing page

The download site lives in `apps/site`, deployed to Vercel project `modex`. The new
landing design keeps the near-black blue/pink identity and follows a concrete task through
request, proposed patch and approved result with manually selected real app captures.
The page scrolls through agent choice, parallel worktrees, Pages/Knowledge, setup, optional
iPhone Companion and inline FAQ. Mobile retains the product explanation and platform
requirements; screenshot enlargement, keyboard controls and no-JavaScript links remain usable.

Mac links update to the latest stable Apple Silicon release through the cached public
GitHub feed, with the last published release's verified URLs (`apps/site/release.json`) as the
static fallback. Signing, release and MIT
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

## On main, unreleased

- **Stopping a Codex turn ends its background commands, or says it could not** (CF-8 #281 live
  smoke). Codex keeps a long command running in a background terminal after its turn is
  interrupted. Stop now ends the stopped turn's own terminals through the app-server and calls a
  command interrupted only once Codex no longer lists it. Otherwise the command reads unknown, with a
  notice. [Live smoke review](reviews/2026-10-19-live-smoke.md).
- **An answer whose save fails is not taken** (CF-6 #279, from #336). When Modex cannot save an
  approval or question answer, as on a full disk, the card stays open and answering again reaches the
  CLI, instead of the request reading answered while the CLI never hears it.
  [Across replay and reconnect](human-requests.md#across-replay-and-reconnect).

## In flight

- **v0.3.0 after publication.** v0.3.0 was published on 2026-10-20 from the signed tag on
  `30ee279`. Two release gates need Val at the Mac: upgrading the release Mac from v0.2.0 through
  its own update banner, and uploading Companion 0.3.0 (8) to TestFlight. Build 8 is cut from the
  same tag, so it also carries thread archiving from the phone, which Companion 0.2.0 (7) was cut
  for. v0.2.0's gates, its banner upgrade from v0.1.0 and the build 7 upload, are superseded:
  v0.1.0 is now offered v0.3.0. [Review](reviews/2026-10-20-v0.3.0-release-review.md).

- **Native conversation fidelity** ([tracker #273](https://github.com/TypeSafeAI/modex/issues/273)).
  The slices that landed through #335 and #333 shipped in v0.3.0; the
  [v0.3.0 review](reviews/2026-10-20-v0.3.0-release-review.md#what-shipped) lists them with what is
  still open. The tracker keeps the dependency order and each slice's evidence, and its child issues
  link their open PRs.

- **Code Review workspace** ([tracker #319](https://github.com/TypeSafeAI/modex/issues/319)). A PR
  inbox, an overview with activity and checks, and a revision-bound remote diff in Modex desktop,
  rebuilt from four reference screenshots. Gate A, the read-only workspace (#320–#324), is under way.
  CR-1 (#320) defines the account- and revision-scoped read contract and synthetic fixtures, and
  its [design page](design/code-review.md) maps every reference control to an owner. Nothing is
  visible in the app yet. AI review (#325) and GitHub writes (#326) are later gates.

- **Mac App Store edition.** A sandboxed Store front end with a separately installed signed
  host, as Val chose. [Investigation and parity matrix](mac-app-store.md).
  - **Development preview** (#119, approved by Val): an opt-in loopback host and a sandboxed
    MAS client that reuses the desktop renderer. Since #166, Store recovery pauses on
    certificate and host-protocol failures, keeps saved access and the mounted draft, and
    retries only when asked. [Preview ledger](mac-store-preview-plan.md),
    [run instructions](../apps/store-desktop/README.md),
    [recovery verification](reviews/2026-10-11-store-recovery.md).
  - **Apple:** Mac Store 0.0.8 is beta approved in TestFlight (October 11 readback). Its
    production draft has the build and review notes selected, and still needs screenshots,
    description, keywords, support and privacy-policy URLs, and copyright; screenshots and
    listing text are prepared locally. [Apple receipt](reviews/2026-10-11-apple-status.md),
    [review access](reviews/2026-10-06-review-demo-access.md).
  - **Accepted** on signed current-account candidates: host discovery, real Codex and Claude
    turns, code comparison and denial, matching-code approval, credentials after relaunch,
    Stop of a real Claude background task, host-restart reconnect with the unsent draft, and
    revocation. [Signed acceptance](reviews/2026-10-11-store-signed-acceptance.md#status-summary).
  - **Open:** the full parity matrix, graceful host shutdown, fresh-user setup, installed-host
    auto-launch, sleep/wake, the full welcome Open sequence and its Cancel check, a macOS
    TestFlight install, and App Review. [Readiness](reviews/2026-10-11-store-readiness.md).

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

## Known rough edges

Fixed ones move to [resolved rough edges](reviews/2026-10-18-resolved-rough-edges.md), with the PR
that fixed each.

- **node-pty is a pre-release.** Modex still ships `node-pty@1.2.0-beta.15` (#65), because 1.1.0
  leaks one `/dev/ptmx` per terminal on macOS. The beta passed the unit suite and the packaged
  e2e, including a test that counts the shipped app's PTY handles, with library validation
  on. Move to 1.2.0 stable when it ships.
- **Layout e2e can measure the terminal panel mid-animation.** The panel rises 6 px over
  180 ms on entry; CI saw 2–3 px of offset on one of two runs of the same commit (PR #35). The
  assertion now polls for the settled bottom edge; other sub-pixel checks in
  `e2e/layout.spec.ts` that follow a transition may need the same.
- **Local e2e on a machine in use.** The test window is shown inactive under `MODEX_E2E`
  (v0.0.3); if a run still garbles terminal input, nothing else should be typed while it runs.
- **Demo thread navigation in iPhone tests.** Opening the demo thread uses the same bounded
  destination check as Back: at most one retry while the original row remains ready, and no
  further tap after the thread appears. The native regression deliberately ignores the first
  opening and Back actions. In job `114763678754`, the initial row tap left the dashboard
  visible; native evidence does not establish why. This is a test correction (#189); app
  navigation is unchanged.
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

1. **Windows and Linux acceptance.** Their installers shipped with v0.1.0. Provider-account
   acceptance, KWallet6 and full graphical sessions, and historical schema migration remain
   unproven; see [native-platforms.md](native-platforms.md).
2. **Routines that change code** (Routines Phase 2). Read-only routines shipped in v0.2.0. Agent-mode
   routines in a claimed worktree wait for the approval gate decision. See the
   [routines specification](specs/2026-10-11-modex-routines-spec.md).
3. **Repository authorization through a GitHub App.** Modex sign-in is identity-only (#141). Acting
   on repositories needs a dedicated GitHub App owner and a hosted service destination before
   implementation and live acceptance. The
   [October 7 GitHub architecture review](reviews/2026-10-07-workos-github-integration.md) is the
   historical proposal.
4. **Codex Cloud tasks and other scheduled automation.** Out of scope; Modex stays CLI-only
   for coding turns (no API execution mode — see `AGENTS.md`).

## Conventions that keep this page true

- One worktree per session (`scripts/worktree.sh new <slug>`), removed after the merge. A
  branch that is not being worked on is either extracted into a PR or deleted; nothing parks.
- PRs merge through `~/.claude/scripts/gh-merge-when-green.sh <pr> --squash` after CI, with
  signed commits only. The guard adds each one to `main`'s merge queue and waits until it lands.
- A PR that changes scope updates this page and, for user-facing behaviour, the README.
- A release's details and evidence go in its review under [`reviews/`](reviews/). This page
  keeps one Shipped row that links it, and the release leaves "In flight".
