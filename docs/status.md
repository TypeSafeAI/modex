# Where things stand

The living map of what has shipped, what is on `main` but unreleased, what is in flight, and
what is next. Update it in the same PR that changes any of those; a reader should be able to
plan the next session from this page alone. Release evidence lives in [`reviews/`](reviews/).

_Last updated 2026-10-24._

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

## Review repairs in progress

PR #422's CR-6 review found two blockers: unconfirmed child exit was reported as stopped and released ownership, and provider-bound questions were described as staying on the Mac. The isolated `cr6-review-repair` worktree preserves unknown exit ownership and corrects that disclosure. PR #426 has passed independent repair review, build, unit tests (2,196 passed, 23 skipped), typecheck and full root E2E on diagnostic source `4c5eaee` (470 desktop passed, seven skipped; seven site passed). Earlier failures remain recorded, including unexplained Canvas and IPC failures that passed on later runs. Hosted checks and protected delivery remain pending. This is not merged or released, and native/live acceptance remains separate.

## On main, unreleased

- **Local model connections and discovery, in main only** (LM-2 [#378](https://github.com/TypeSafeAI/modex/issues/378),
  [tracker #376](https://github.com/TypeSafeAI/modex/issues/376)). Main keeps loopback-only
  connection profiles for Ollama, LM Studio and Responses-compatible servers in
  `app/local-connections.json`, with any token in the existing encrypted secret store, and reads
  bounded model metadata through one local-only IPC channel. There is no UI, no execution binding
  and no inference. Discovery never pulls, loads or unloads a model, and a loopback address is not a
  locality claim. Model identity is LM-1's accepted schema-1 contract, and AGENTS.md records Val's
  approval of this metadata traffic. The evidence is fixtures and real Electron IPC. LM-2's discovery
  has not yet run against a real runtime: an authorized CLI inventory found no local generative model
  (Ollama 0.40.10 has none; this Mac's only LM Studio model is an embedding model).
  [Review](reviews/2026-10-22-lm2-connections-discovery.md).

- **Conversation acceptance history and human review kit.** The [acceptance receipt](reviews/2026-10-18-conversation-fidelity-acceptance.md)
  preserves the October 20 early candidate results separately from later live-provider evidence.
  The [keyboard/VoiceOver checklist](reviews/2026-10-20-keyboard-voiceover/checklist.md) includes
  an offline seed scenario. Human acceptance and a final integrated candidate remain open.
  The full-log and patch-state E2E fixtures wait for the completed turn before inspecting its
  work, avoiding the initial idle state racing the fixture startup; their content and execution
  count assertions remain unchanged.

- **A saved task note reopens as the task it saved** (CF-7 #280). A task note in Notes has a
  **Task view** button that shows the request, clarifications, plan, files touched and verification
  as Save to Notes recorded them, read-only. It says when the note was edited after the save, moved
  to another project's notes (#363), trashed or saved again elsewhere. Opening it runs nothing, asks
  no CLI and writes nothing; continuing is a new message in the thread. Notes saved before this
  change have no task view. [Reopening a saved note](task-context.md#reopening-a-saved-note).
- **A turn lists the files it touched** (CF-7 #280). A finished turn's footer has **Files touched**,
  which lists what its tools changed, read and searched, as the CLI reported them. For Codex, that
  includes its own parse of each command, resolved from the command working directory. Dot
  segments are normalized before checking the project boundary. At most 20 are shown, and paths outside the project are
  only counted. The saved note gets the same list. Nothing is indexed or inferred.
  [Context map](task-context.md#context-map).
- **A turn says whether a check verified its last change** (CF-7 #280). Beside Save to Notes, a
  finished turn reads "Verified: `pnpm test` passed after the last change". If the check failed,
  did not say how it ended, ran before a later edit, or never ran, it says that instead. Only a known
  test, build, typecheck or lint command counts, never the model's word or an unrelated command. The
  saved note lists the checks and marks stale ones. Shell receipts that mask failures, mix checks
  with writes, or only parse a script cannot mark changes verified. Dynamic expansion and
  write-capable commands also invalidate earlier checks. [Verification](task-context.md#verification),
  [shell-receipt repair evidence](reviews/2026-10-20-cf7-shell-receipts.md).
  Task Note updates also recheck current project ownership: notes moved across projects are
  preserved, with a replacement saved under the originating project, even when a folder move
  or Finder move retained the old revision.
  The full-log regression now waits for the completed turn’s disclosure button before opening
  its history, avoiding a race with the live label and automatic folding at completion.
- **A Codex web search shows what it searched for and what it found** (CF-5 #278). The row reads
  "search *query*" with how many results there were, instead of "search " while the query had not
  arrived yet. Expanded, the results Codex reported are links with their snippets, labelled as
  unchecked. Results without an http(s) link are counted, not shown. The shape comes from a live
  codex-cli 0.163.0 capture. [Evidence guide](conversation-evidence.md).
- **Answering, stopping or jumping to the latest from the keyboard keeps your place** (CF-8 #281
  keyboard walkthrough). The answer buttons go away once pressed, and a finished turn hides its
  folded work; either used to drop focus onto the page body. Focus now moves to the card's answer
  ("Approved", "Denied"), then to the turn's "Worked for" toggle when that work folds. Stop and
  Jump to latest, pressed from the keyboard, hand focus to the message box once they go away.
  Focus elsewhere, such as the composer, stays where it is.
- **Jump to latest stays at the bottom** (CF-8 #281, from #352). After a jump, the transcript used
  to stop short of the bottom when the message box grew, as when a suggested follow-up appeared,
  or when a Page Up was still scrolling. It now stays at the bottom until you scroll yourself.
  [How it was found](reviews/2026-10-18-resolved-rough-edges.md#jump-to-latest-from-the-keyboard-on-ci-runners-handled-2026-10-20).
- **Stopping a Codex turn ends its background commands, or says it could not** (CF-8 #281 live
  smoke). Codex keeps a long command running in a background terminal after its turn is
  interrupted. Stop now ends the stopped turn's own terminals through the app-server and calls a
  command interrupted only once Codex no longer lists it. Otherwise the command reads unknown, with a
  notice. [Live smoke review](reviews/2026-10-19-live-smoke.md).
- **An answer whose save fails is not taken** (CF-6 #279, from #336). When Modex cannot save an
  approval or question answer, as on a full disk, the card stays open and answering again reaches the
  CLI, instead of the request reading answered while the CLI never hears it.
  [Across replay and reconnect](human-requests.md#across-replay-and-reconnect).
- **Questions across replay and reconnect** (CF-6 #279). A phone or paired desktop that was away
  while a question was answered, withdrawn or stopped finds the card closed on its next delta or
  reload. Taps it queued are refused, and Codex hears one reply. An older phone is now told when a
  question was answered on the phone, and phones get an answer's native phase, so Codex's plan is
  marked. New tests cover cursors, a crash inside the journal's batch window, the 8 MB slow-stream
  drop, v0.3.0 history, older paired desktops, and the iPhone app closing cards closed on the Mac.
  Live Codex and Claude turns with the journal on agreed on every path, also in the app through the live
  smoke. The journal suites pass on Windows and Linux CI. Val deferred the Windows and Linux app sessions and
  a real power cut (2026-10-23), and then the physical iPhone gate, so #279 closed.
  [Across replay and reconnect](human-requests.md#across-replay-and-reconnect), [gates](reviews/2026-10-22-cf6-gates.md).

- **Native question drafts survive thread navigation** (CF-3 #276, PR #348). Unsent choices
  and text stay in window memory and clear when their request closes or thread is removed.
  Sensitive answers stay out of persisted recovery. [Verification and native capability limits](reviews/2026-10-20-cf3-drafts.md).
- **Answer an agent's questions from the iPhone** (CF-3 #276, coordinated with CF-6 #279). The Mac
  sends a native question card to a Companion build that names the `question` kind. The phone
  answers through the same broker as the desktop, with the same refusals and a 409 when another
  client answered first. A secret is typed into a secure field, held only in the phone's memory, and
  never logged or saved on either side. Older Companion builds keep the text notice. The phone half
  reaches people with the next Companion build, which Val uploads to TestFlight.
  [Phone](human-requests.md#clients).

- **Plan mode on Codex runs in Codex's own plan mode** (CF-3 #276). A Plan turn on Codex can ask
  its clarifying questions on the question card with no feature flag. Codex's proposed plan is the
  turn's answer, in Markdown. The picked model and effort still apply, and the turn is still
  read-only. A Codex that refuses the mode falls back to the old prompt, with a notice.
  [Decision and live capture](reviews/2026-10-22-cf3-plan-mode-decision.md).

- **CF-7 step linking is retired** (#280). Val retired linking a check to a plan step: neither CLI
  reports that link, and Modex does not infer it. Steps stay "Reported done", and verification stays
  per turn. [Decision](reviews/2026-10-22-cf7-step-linking-decision.md).
- **Codex questions asked in a reply, and turns Codex never ends** (CF-7 #280, from live captures).
  When Codex asks in its reply (`agentMessage.questions`), the reply shows the options, and pressing one
  sends it as the next message. When Codex gives its final answer but never reports the turn finished,
  Modex ends the turn after five quiet minutes and says so. Live codex-cli 0.163.0 turns are replayed
  as fixtures; none sent a plan. [Live captures](task-context.md#live-codex-captures).
- **A turn says when its CLI reported no plan** (CF-7 #280). A finished Claude Code or Codex turn that
  changed files or ran commands without a plan says "Claude Code reported no plan for this turn" in
  its footer and saved note. Claude Code 2.1.308 and later offer Modex no `TodoWrite`.
  [Plans](task-context.md#plans).
- **Claude's task tools and Codex's proposed plans** (CF-7 #280, from live captures). When Claude Code
  2.1.309 offers `TaskCreate`/`TaskUpdate`, the tasks it creates and updates are the turn's plan,
  counted once the CLI confirms each call. Codex's plan-mode `plan` item is kept as the turn's
  proposed plan, so that turn does not say "no plan", and a plan-mode turn Codex never ends is ended
  like one after a final answer. [Plans](task-context.md#plans).

## In flight

- **LM-2 credential repair, in review.** The later credential-copy and stale-discovery fixes from closed #401 are not in main. The current-main `lm2-credential-repair` branch preserves the reviewed source/tests and prevents fake child PIDs from reaching OS signals. Build, full unit tests, typechecks and the Electron IPC journey passed; hosted checks and protected delivery are pending. [Reconciliation evidence](reviews/2026-10-26-lm2-credential-repair.md).

- **Desktop v0.4.0 and Companion 0.4.0 (9) preparation.** The release ships everything under "On
  main, unreleased":
  - task context: the task view, files touched and verification, and Claude's and Codex's plans;
  - answering an agent's questions from the iPhone, and across replay and reconnect;
  - Codex's own Plan mode;
  - the keyboard, Jump to latest and Codex Stop fixes;
  - Markdown overflow keyboard stops.

  The Code Review workspace stays hidden in built apps, and local-model discovery has no UI. Val
  asked for the next version. No rc rehearsal is needed, because the release workflow and updater
  are unchanged since v0.3.0. Companion build 9 supersedes the never-uploaded build 8. Remaining:
  - the signed `v0.4.0` tag, with a key the workflow allows;
  - the Release run;
  - independent download checks and publication;
  - the v0.3.0 → v0.4.0 background upgrade on the release Mac;
  - the TestFlight upload of build 9.

  [Candidate review](reviews/2026-10-24-v0.4.0-release-review.md).

- **Companion network acceptance (#109).** The [two-LAN evidence map](reviews/2026-10-28-companion-two-lan-acceptance.md) ties each of the four #109 requirements to the tests that prove it, adds the last race (the interface list changes while Forget paired phones or Turn off runs, and no listener survives with the old token; both shown red against a mutation, green on `main`), and holds the physical two-subnet procedure. Two gates remain with Val: running that procedure, and deciding whether VPN tunnels and virtual bridges with private addresses get a listener ([question](https://github.com/TypeSafeAI/modex/issues/109#issuecomment-6464762470)). The filter is unchanged until Val answers.

- **Integrated review candidate.** CF-4 keyboard/performance, CR-5 remote diffs, CR-8 acceptance checks and the unwired CR-7 intent foundation are reconciled on signed candidate `e25a554`. Full build, unit and typecheck passed; full E2E passed 450 desktop cases with seven skips and seven site cases. [The integration receipt](reviews/2026-10-24-integrated-review.md) preserves the first failures, their repairs, source ancestry and remaining human, policy and provider gates. Hosted validation and protected delivery are recorded separately. CF-8's missing-artifact matrix row now records the existing #328 unit evidence, reconfirmed in the CR-7 integration repair's full unit run; live and human acceptance remain separate.

- **Revision-bound remote diffs** (CR-5 [#324](https://github.com/TypeSafeAI/modex/issues/324), [PR #395](https://github.com/TypeSafeAI/modex/pull/395)). The integration repair distinguishes the proven three-dot diff base from the target tip in file pages, context, anchors and labels. Four failing-first regressions and a real GitHub read confirmed the defect and correction; full build, unit, typecheck and E2E checks passed (430 desktop passes, seven skips, seven site passes). The original candidate's resource bounds remain in place. Original R4 comparison, human acceptance and the Viewed decision remain open. [Repair evidence](reviews/2026-10-24-cr5-merge-base.md); [original candidate evidence](reviews/2026-10-23-cr5-remote-diffs.md).

- **LM-1 local-model contract and native feasibility (#377 / #376).** Val accepted narrow Gate A on 2026-10-24 for the producer at main `bb0e1a4`, including the shared identity/runtime mapping from #400, and the recorded Codex 0.163.0/0.164.0 + Strata 0.1.47 tool/Stop/continuation evidence. The loopback metadata boundary is separately approved; no local execution feature is enabled. LM-2 consumes it through #403. Val explicitly deferred the additional Ollama/LM Studio app-server probe until a local coding model exists: Ollama has no models, and this Mac has only an LM Studio embedding model; linked-device LLMs are outside scope. [Contract/source map](local-models.md), [native feasibility](reviews/2026-10-22-lm1-feasibility.md) and [acceptance/availability](reviews/2026-10-24-lm1-acceptance.md).

- **CF-4 Markdown closeout (#277).** The `cf4-closeout` candidate (named keyboard stops for table/code overflow, reference-viewport captures, the approved 500 ms median cold-open gate, and Markdown rows C1–C5 in the shared #281 human checklist) landed on `main` through #404 (`e3527f4`, 2026-10-24); #371 was closed as superseded. [The closeout evidence](reviews/2026-10-22-cf4-closeout/checkpoint.md) keeps the local, hosted and integrated measurements apart and records the human review candidate prepared on 2026-10-28: `main` at `b643617`, built and seeded in `.worktrees/cf4-voiceover`, with the focused rendering, keyboard and five-launch budget checks 11/11 and a 170 ms median. C1–C5 have no result; #277 stays open until Val records them or defers in writing.

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

- **Code Review inbox integration repair.** The renderer labels independently stale groups and
  pages, retains per-page failure/retry notices, and deduplicates first and later pages using the
  producer contract helper. The [authenticated integration check](reviews/2026-10-21-cr3-read-integration.md)
  passed with CR-2 through the real Electron IPC/service path. Overview and diff content, original
  reference comparison and human accessibility remain separate acceptance gates.

- **CR-6 agent review and questions** (#325). Phase 1's native proof ([isolation evidence](reviews/2026-10-23-cr6-isolation.md)) showed Claude Code's restricted Read-only palette rejects injected shell, write, fetch, MCP and outside reads while Codex's read-only sandbox does not. Phase 2 builds on it: main's local `code-review:agent` channel starts the installed Claude Code CLI, under the person's own login, on a snapshot of the PR's diff that main reads itself through `gh`, with the shipped argv `--safe-mode --restricted --tools Read` and no permission tool, and an environment stripped of `gh`, GitHub and Modex variables. Each run is recorded before it starts, bound to the head it read, marked outdated when the head moves, stopped explicitly, and read as unknown after a crash; a finding reaches GitHub only through CR-7's review draft. Review instructions are one versioned text per Mac whose scope the popover states, and each run records the version it used. Unit, native-fixture (opt-in, production argv) and E2E evidence over a synthetic `claude` and `gh` are in [the review evidence](reviews/2026-10-28-cr6-native-review.md); an authenticated live run and C82 remain open gates.

- **CR-7 Code Review writes** (#326). Val decided on 2026-10-25: writes go through the person's `gh` login, and decisions 2–4 are in scope. The foundation stores scoped drafts and revision-bound intents, consumes confirmations once after durable admission, and recovers interrupted dispatches as unknown without resend. The first write increment adds main's separate `code-review:write` channel for top-level comments and submitted reviews (line comments from Changes included). Each is previewed with its exact destination, account and head, re-checked in main before sending, sent at most once, and reconciled by read-back when its outcome is unclear ([evidence](reviews/2026-10-25-cr7-write-submit.md)). Mock and synthetic-`gh` only: the live write waits for a disposable repository Val names. A second increment adds Merge: main reads push permission, the repository's allowed methods, GitHub's merge state and the target branch's rules fresh. It offers only what `mergePreflight` ([preflight evidence](reviews/2026-10-24-cr7-merge-preflight.md)) allows, sends the reviewed head as the merge's `sha`, and reconciles an unclear merge from the PR's own record ([evidence](reviews/2026-10-25-cr7-merge.md)). A third increment adds decisions 2–4 the same way: the state menu (close, reopen, convert to draft, ready for review), title and description edits that are refused if GitHub's text changed, and reviewer requests ([evidence](reviews/2026-10-25-cr7-pr-actions.md)). CR-6 isolation and C82 remain unchanged. See [the preparation evidence](reviews/2026-10-23-cr7-intents.md). A follow-up binds the model to CR-5's shared `LineAnchor`, diff commit included, and records the check of CR-4's action slots ([evidence](reviews/2026-10-24-cr7-anchors.md)). The integration repair fences queued and in-flight submits against document invalidation, verifies inline destinations against fresh complete patch evidence, preserves pending composer edits across navigation, and shows frozen inline details before submission ([repair evidence](reviews/2026-10-26-cr7-write-repair.md)).

- **Code Review workspace** ([tracker #319](https://github.com/TypeSafeAI/modex/issues/319)). A PR inbox, an overview with activity and checks, and a revision-bound remote diff in Modex desktop, rebuilt from four reference screenshots. Gate A, the read-only workspace (#320–#324), is under way. CR-1 (#320) defines the account- and revision-scoped read contract and synthetic fixtures, and its [design page](design/code-review.md) maps every reference control to an owner. CR-2 (#321) adds main's read service on the `code-review:read` channel: GET-only reads through the person's `gh` login, keyed by account, repository id and revision. The separate `cr2-cache-denial` follow-up invalidates retained PR data after visibility loss, including reads already in flight; it covers pending inbox searches, sibling file slices and denial during identity confirmation, while preserving unrelated repositories and ordinary offline/rate-limit fallback. [AC1 Electron evidence](reviews/2026-10-21-cr2-electron-ipc.md) adds inbox → overview → files coverage through the production preload/IPC/service with a synthetic GitHub executable. The CR-3 development flag exposes the integrated inbox and workspace host. CR-4 (#323) adds the PR description, paginated activity, checks, inferred branch stack and provider/comment preview provenance through that host; validation and delivery evidence is recorded in [the CR-4 review](reviews/2026-10-23-cr4-overview.md). Remote diff content, AI review (#325) and GitHub writes (#326) retain their own gates. Original-reference comparison and human accessibility remain open.

  CR-8 (#327) keeps the [acceptance matrix](reviews/2026-10-22-cr8-acceptance-matrix.md). It has one row per control C01–C82 and per AC of #321–#326, with fixture, authenticated, live-provider, live-write and human evidence kept apart. It adds Electron journeys and cross-slice regressions through the production read path with a synthetic `gh`: inbox → R1 → R4, identity, head moves, incomplete data, hostile links, no dispatch, and local Discard. It also adds keyboard/contrast checks and stress measurements, and a [VoiceOver checklist](reviews/2026-10-22-cr8-voiceover/checklist.md) for Val. The read-only authenticated service smoke and the navigation probe were re-run on `main` at `0e674e7`, and both passed. That historical matrix predates the implemented R2 overview and remote diffs; R3 (#325), the original-reference comparison (blocked: Val confirmed the original R1–R4 files are gone), and the human VoiceOver pass remain open.

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

- **Codex asks questions on an ordinary turn only with a flag.** Plan turns on Codex now run in its
  native plan mode, where it offers its question tool. On an ordinary turn, codex-cli 0.163.0 offers
  the tool only with the opt-in `default_mode_request_user_input` flag; without it, a run has used the
  `request_user_input_async` form, which Modex does not answer. Plan mode's collaboration mode and
  Codex's `plan` item are experimental in the CLI. Human acceptance steps:
  [question acceptance](reviews/2026-10-22-cf3-question-acceptance.md). See
  [human-requests.md](human-requests.md#plan-mode-on-codex).

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
3. **Repository authorization through a GitHub App.** Modex sign-in is identity-only (#141). Code
   Review's writes use the person's own `gh` login instead (Val, 2026-10-25, #326); a GitHub App would
   still need a dedicated owner and a hosted service destination before implementation and live
   acceptance. The
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
