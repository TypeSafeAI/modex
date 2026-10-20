# Where things stand

The living map of what has shipped, what is on `main` but unreleased, what is in flight, and
what is next. Update it in the same PR that changes any of those; a reader should be able to
plan the next session from this page alone. Release evidence lives in [`reviews/`](reviews/).

_Last updated 2026-10-18._

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

- **Assistant turns keep their native identity, phase and outcome** (CF-1 #282, CF-4 #284, CF-6
  first half #285, CF-5 first part, tracker #273). Codex and Claude report every message, reasoning
  block and tool through one typed path that names the native item. The [conversation-event
  contract](conversation-events.md) folds them into transcript items carrying origin, phase
  (commentary, final), reasoning (summary, provider text, not shared) and outcome (succeeded,
  failed, denied, stopped, unknown).
  - **Final answers.** A turn's final answer comes from its `final` message, not the last reply.
    Every running item is live, and a retry shows as Attempt 2.
  - **Visible work.** Only work that succeeded folds away; a dropped stream reads "Status
    unavailable", never "Done" or "Failed". Interleaved messages no longer merge, and summaries no
    longer absorb reasoning text. Jump to latest appears once you scroll away from new output.
  - **Replay and clients.** Journal replay, paired desktops and the phone agree on the same items;
    a duplicated frame no longer doubles an item. On the phone, a failed or denied tool says so in its
    title. Work a crashed Modex left running is saved and sent as unknown instead of spinning forever.
  - **Journal faults (CF-6 #279).** These apply with `MODEX_EVENT_JOURNAL=1`.
    - A write that fails while a client reads turns the journal off, and clients reload. Before, that
      batch was lost silently.
    - A journal a crash or a failed write left open takes a new identity. Cursors from before then
      reload instead of resuming past the gap, so an answered card no longer looks open on a paired
      desktop after a crash, and a card nobody answered reads closed on the phone's first poll.
    - A paired desktop reloads after a frame over 1 MB instead of reconnecting forever.
    - The phone gets a notice for an item kind its Mac doesn't know, instead of rejecting the
      snapshot.

    [Faults and rollback](event-journal.md#compatibility-and-rollback).
  - **Evidence (CF-5 #278, first part).** A command shows exactly what ran, where, and its exit code
    as the CLI reported it. Tool output keeps its last 256 KB with a visible note. A patch is labelled
    as this turn's. Codex memory citations show as citations, and a "Sources:" list the model wrote
    is labelled as links in the reply. [Evidence](conversation-evidence.md).
  - **Plans and task records (CF-7 #280, first part).** A plan reported by Codex or Claude's
    TodoWrite shows each step in the CLI's own status: "Reported done", never "verified". Under
    each finished turn, Save to Notes writes the turn's request, plan, changed files, commands and
    loose ends into the project's notes; saving again updates the note unless you edited it.
    [Task plans and records](task-context.md).
  - **Truthful Claude Stop (CF-2 #275, #286).** Stop sends the CLI's native interrupt, drains
    its final output and waits for exit, escalating through SIGTERM and SIGKILL. An unconfirmed
    process keeps its thread and worktree; a failure just before Stop keeps its error and process
    ownership. Withdrawn permission cards become inert. Split output and final diagnostics survive
    draining without exposing MCP credentials. Live macOS checks cover pending approval, running
    command, resume and mid-stream Stop; Windows/Linux escalation remains unproven.
    [Evidence and limits](reviews/2026-10-18-claude-lifecycle.md).
  - **Approvals and questions, answered once (CF-3 #276).** Each request is bound to its turn,
    attempt and the CLI's own request id. The first answer is taken; any other is refused with a
    reason, and the phone gets a 409. Codex questions (`item/tool/requestUserInput`, experimental in
    codex-cli 0.163.0) are cards with a control for each question, and a secret answer goes to the
    CLI only. Stop sends Codex an error, never an empty answer. A request Codex settles itself closes
    as withdrawn, and cards a restarted Modex left open close as ended everywhere. Phones show
    questions as text to answer on the Mac. Scripted fixtures only. [Human requests](human-requests.md).
  - **Older paired desktops read questions (CF-6 #279).** A Store build from before CF-3, such as
    TestFlight Store 0.0.8, showed nothing for a Codex question or a plan, so the thread looked stuck.
    Current clients name the item kinds they draw, and the host sends a client that names none those
    two as notices with the question text and its state. [Older paired desktops](human-requests.md).
  - **Requests across replay and reconnect (CF-6 #279, request half).** A card records who answered
    (this Mac's window, a paired desktop or the phone) and whether the answer reached the CLI, and the
    journal, snapshots, paired desktops and the phone carry it. Switching a thread to YOLO answers what
    is waiting as whoever switched it. Replay and reconnect show answered and withdrawn cards inert and
    never send an answer again. An answer Modex took but could not confirm before a crash says so after
    the restart. An answer whose save fails, as on a full disk, is not taken: the card stays open and
    answering again reaches the CLI. A secret answer reaches no file, even with the journal on.
    [Across replay and reconnect](human-requests.md#across-replay-and-reconnect).
  - **The phone acts on threads started on the Mac again.** Since v0.0.12, answering, sending, setting
    the approval policy or archiving from the phone failed on any thread created from a Mac draft.
  - **A refused answer refreshes the phone (CF-6 #279).** When the Mac refuses an approval, most often
    because it was settled elsewhere, the iPhone app reads the thread again at once instead of leaving
    the card actionable until its next poll. It reaches phones in the next Companion build.
  - **Old transcripts** read unchanged, with no invented provenance.
  - **Acceptance (CF-8 #281).** A fixture Claude CLI drives the real app through a plan, an
    approval, a real edit, a check, the answer and Save to Notes, then a restart that re-runs
    nothing. Denial, a failing check and Stop are covered too, and so are a native withdrawal, the
    Mac and the phone answering at once, a phone reconnecting after the decision, and a clarifying
    question inside the path. The path's states have reference captures in every theme at 900×600
    and 1440×900, and a long transcript and a 3 MiB log are measured on a named Mac. [Fidelity](conversation-fidelity.md),
    [review](reviews/2026-10-18-conversation-fidelity-acceptance.md).
  - **Fixes those checks found.** Opening a thread for the first time no longer resends and rewrites
    every item in it, which cost a 1,400-item transcript about 55 ms. An approval card in a narrow
    window wraps its text and buttons instead of pushing Deny out of view.
  - **Clarifications in the task record (CF-7 #280, second part).** A question Codex asks while it
    plans is answered on its card, and the turn's record and Save to Notes list it with its answer,
    a secret hidden. One nobody answered reads "not answered" with why, and is never filled in.
  - **Still open:** live Codex question capture (CF-3 #276), the remaining Markdown checks (CF-4
    #277), structured web-search results (CF-5 #278), the remaining replay findings (CF-6 #279),
    verified steps and the read-only task view (CF-7 #280), and live-provider acceptance with human
    keyboard and VoiceOver checks (CF-8 #281).

- **Updates install over the air on macOS** (#317). A check that finds a newer release downloads and
  verifies it in the background; nobody has to click Download. The banner then offers Restart to
  update, and an update nobody restarted into installs the next time you quit, without reopening
  Modex. The release page is only a "What’s new" link. A cancelled download stays cancelled for
  that version, and a failed one retries an hour later. Windows and Linux still install by hand.
  The first release that has this still updates from v0.2.0 with the Download click.
  [Download and restart](update-recovery.md#download-and-restart).

- **Replies render full Markdown** (part of #277). Replies, reasoning and fetched pages in the
  transcript render CommonMark with GitHub's extensions (micromark): tables, task lists, block
  quotes, nested lists, strikethrough, footnotes and reference links. A code block names its
  language and has Copy, which only puts the code on the clipboard; it shows its code while the
  fence is still streaming. Raw HTML stays text, only http(s) links
  are links, and an image becomes a link to it instead of being fetched. While a reply streams, only
  its last block is parsed again, and the whole reply once it rests for 300 ms. Opening a long
  thread for the first time parses each message once (about 160 ms for 200 messages, 239 KB, against
  about 40 ms before); reopening it reuses the result.
- **Codex memory citations can be read in place** (part of #278). A reply's "From Codex memory"
  citation has **Show lines** and **Copy**. Main reads only the cited lines, and only inside
  Codex's memories folder: absolute paths, `..`, and symlinks that lead out are refused. It runs
  and opens nothing. It works on the Mac only, never from a paired desktop.
- **A turn's patch can be compared with the working tree** (part of #278). A patch the CLI
  reported as applied has **Compare with working tree**. Each file it touched reads as left by the
  turn, still holding its edit, changed since, deleted since, or not compared, with the reason.
  Main reads only the named files inside the thread's folder and returns verdicts, never contents.
  Codex file changes now keep their per-file paths beside the patch. Edits that only removed text
  and notebook cells (replaced, inserted or deleted) are compared too.
- **Codex web searches fold away again when a turn finishes.** Since #284, work whose result is
  unknown stays in view, and every Codex web search read as unknown: codex-cli 0.163.0 gives a
  search no status or error field. Its completion is its only report, so a completed search now
  reads as done and folds like other finished work (#277).
- **A project can move to a new workspace from the chat sidebar.** Its menu has **Move to new
  workspace…**, which names a workspace and moves the project into it in one step, even while there
  is only the default workspace. Before, a new workspace had to be made in Space first.
- **A long command's full log can be read** (part of #278). A command whose output passed the 256 KB
  preview has **Show full log**: Modex keeps its output from the first line, up to 10 MB, and reads it
  back a page at a time. Codex streams every chunk; Claude Code itself keeps at most 30,000
  characters of a result by default, so Claude output never needs it.

## In flight

- **v0.2.0 after publication.** v0.2.0 was published on 2026-10-18 from the signed tag on
  `01b1b8a`. Two release gates need Val at the Mac: upgrading the release Mac from v0.1.0 through
  its own update banner, and uploading Companion 0.2.0 (7) to TestFlight, which carries thread
  archiving from the phone. [Review](reviews/2026-10-18-v0.2.0-release-review.md).

- **Native conversation fidelity** ([tracker #273](https://github.com/TypeSafeAI/modex/issues/273)).
  Slices that landed are under "On main, unreleased". The tracker keeps the dependency order and
  each slice's evidence, and its child issues link their open PRs.

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
  signed commits only.
- A PR that changes scope updates this page and, for user-facing behaviour, the README.
- A release's details and evidence go in its review under [`reviews/`](reviews/). This page
  keeps one Shipped row that links it, and the release leaves "In flight".
