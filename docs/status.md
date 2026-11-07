# Where things stand

The living map of what has shipped, what is on `main` but unreleased, what is in flight, and
what is next. Update it in the same PR that changes any of those; a reader should be able to
plan the next session from this page alone. Release evidence lives in [`reviews/`](reviews/); finished plans and older entries live in [`archive/`](archive/README.md).

_Last updated 2026-11-04 UTC._

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
| v0.4.0 | 2026-10-30 UTC | #409, #442 | Saved task context, native plans, question/replay continuity, OpenCode and MiMo Code backends, and delivered reliability repairs. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.4.0). [Review](reviews/2026-10-24-v0.4.0-release-review.md#published--2026-10-30-utc). |
| v0.4.1 | 2026-10-31 UTC | #452 | Commands that may have changed unlisted files retain uncertainty, including failed writes; new thread titles end at a word boundary. [Release](https://github.com/TypeSafeAI/modex/releases/tag/v0.4.1). [Review](reviews/2026-10-30-v0.4.1-release-review.md#published--2026-10-31-utc). |

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
GitHub feed, with a published release's verified URLs (`apps/site/release.json`, currently v0.4.0) as the
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

The published application source is `6a97d23aaea315b29008890f25dde2d7ea07f1d0` (v0.4.1). v0.4.2 is in preparation with Code Review hidden ([review](reviews/2026-11-03-v0.4.2-release-review.md)). Later source deliveries remain unreleased: #462 records local-model context provenance; #461 enforces local-only auxiliary dispatch; #465 refuses known cloud-routed and non-generative models; #463 (`32f1cb4`) defers Markdown far from the view so long threads open fast. Main still does not construct `LocalExecution`; native qualification and product admission remain separate gates. #459, #460 and #464 (`3d72c6e`, the CR-3 acceptance re-run) are evidence/documentation deliveries after the release source.

Also unreleased, since that summary: #467 (`8a28df3`) adds the Claude account pool with OrcaRouter keys; #477 (`49aa449`) keeps Code Review links right after a repository rename; #487 (`b785054`) adds CF-3 draft and YOLO regressions; #488 (`68fe543`) adds owner-authorized worktree retirement; #490 (`a4f2f70`) adds the Code Review setting and its gates, and turned Code Review on by default. #492 (`4297235`) turned that default off, because Val chose v0.4.2 with Code Review hidden on 2026-11-03. #468, #470, #472, #473, #474, #476 and #483 are evidence or documentation only.

## v0.4.1 publication and remaining acceptance

- **v0.4.1 published (2026-10-31).** Signed tag `v0.4.1` names protected merge `6a97d23`. Release run `41163487821` passed signed packaged E2E (479 desktop passed, 4 skipped; 7 site passed), three native updater scenarios, Windows/Linux checks and artifact attachment. All five downloaded installers match the release manifest; macOS signature, Gatekeeper and stapler checks passed. The initial download-failure job stopped before updater execution because its fixture manifest was missing; one retry passed on the unchanged candidate. Original failures and acceptance limits remain in the [publication review](reviews/2026-10-30-v0.4.1-release-review.md#published--2026-10-31-utc).
- **CF-7 close-out follow-ups (#280, #450, #453).** The file-evidence and title fixes shipped in v0.4.1. Val's human review of the saved Notes remains open on #280; publication does not complete that acceptance. The review homes moved to the `cf7-review-kit` worktree on 2026-11-01, after the original worktree was pruned. Both saved Notes still reopen read-only on a build of `0a8c513`. See the [close-out receipt](reviews/2026-10-29-cf7-closeout/checkpoint.md#the-real-task-and-its-saved-note-human-review-candidate) for the launch commands.

## Open acceptance gates

Open human, native and live gates on work that has already shipped. Earlier release sections and landed "In flight" entries moved to [status history](archive/status-history.md).

- **CF-3 temporary VoiceOver deferral (2026-11-01).** Val said “skip voiceover for now and just proceed”. V1–V3 and P5 are deferred for now, not run or passed; D1–D5, P1–P4 and P6 remain open. Continue the non-VoiceOver acceptance run. #276 stays open. [Decision and current row status](reviews/2026-10-22-cf3-question-acceptance.md#vals-temporary-voiceover-deferral-2026-11-01).
- **CF-8 integrated candidate `b643617`** (#281, 2026-10-28). The [acceptance receipt](reviews/2026-10-18-conversation-fidelity-acceptance.md#integrated-candidate-2026-10-28-b643617)
  pins `main` at `b643617`, which carries every CF-1 to CF-7 slice (#394 and the CF-4 close-out via #404
  included). First pass, no reruns: install, build and typecheck passed; unit 2,011 passed and 17 skipped
  (desktop) with every other suite green; desktop e2e 470 passed and 7 opt-in skips; site 7/7; iPhone UI 23/23
  and 20/20 on a dedicated iOS 27.0 simulator. Live Claude Code 2.1.312 (Haiku, Chat mode) passed the golden
  path through the app: one approval, the edit and check, "Claude Code reported no plan for this turn" (the CLI
  offers Modex no plan tool), Save to Notes, Open, restart, and Stop (interrupted in 0.8 s, the file never
  written). Live codex-cli 0.164.0 (`gpt-6.1-sol`, ChatGPT account, Chat mode) passed the same path: two approvals, `apply_patch` and the check with exit code 0, a `final` answer, "Codex reported no plan for this turn", Save to Notes, Open, restart, and Stop (interrupted in 0.1 s, the file never written). The 2026-10-22 candidates `0e674e7` and `ec7be57` are kept as history beside it.
  **Human gates:** A1–A8 and B1–B7 await Val; C1–C5 were deferred by Val on 2026-10-30, not run. For CF-3, D1–D5, P1–P4 and P6 remain open; Val deferred V1–V3 and P5 for now on 2026-11-01. Phone rows still require the appropriate Companion build and physical-device evidence. No row is marked passed on Val's behalf; #281 stays open until each has Val's result or written deferral. On 2026-11-01 the receipt recorded the C1–C5 deferral, and that #450, #453 and #463 landed after `b643617`. The 2026-10-28 seeded build is gone, so the home was seeded again on `b643617` in `.worktrees/cf8-voiceover-b643617`. Val chooses whether A1–A8 and B1–B7 run on `b643617` or on a new candidate from current `main`.
- **Conversation acceptance history and human review kit.** The [acceptance receipt](reviews/2026-10-18-conversation-fidelity-acceptance.md)
  preserves the October 20 early candidate results separately from later live-provider evidence.
  The [keyboard/VoiceOver checklist](reviews/2026-10-20-keyboard-voiceover/checklist.md) includes
  an offline seed scenario. Human acceptance remains open; the integrated candidate is above.
  The full-log and patch-state E2E fixtures wait for the completed turn before inspecting its
  work, avoiding the initial idle state racing the fixture startup; their content and execution
  count assertions remain unchanged.

## Open issue checklists

The checkboxes in every open tracked issue were reconciled against `main` at `9ecccc9` on
2026-11-01, then re-checked at `a4f2f70` on 2026-11-04 ([record](reviews/2026-11-04-docs-reconciliation.md)). A box is ticked only when on-main evidence meets its full text. Open PRs, deferrals
and unrun human, live or native rows stay unticked. The row-by-row evidence is in the
[reconciliation record](reviews/2026-11-01-issue-checkbox-reconciliation.md). A checkmark
summarizes a receipt; it does not replace one. When code or receipts change, re-check the rows
before relying on a tick.

| Issue | Ticked | What is left | Next action |
| --- | --- | --- | --- |
| [#273](https://github.com/TypeSafeAI/modex/issues/273) CF tracker | 9/15 | CF-3, CF-7 and CF-8 are open; their code is on `main`. Fresh full checks name candidate `b643617`, which predates #450, #453 and #463 | Val decides whether to keep `b643617` or pin a new candidate |
| [#276](https://github.com/TypeSafeAI/modex/issues/276) CF-3 | 11/13 | Draft, attachment and YOLO regressions landed (#487, #490); focus after answering is in open #489. Human D/P rows live on #281 | Land #489; Val runs D1–D5 |
| [#280](https://github.com/TypeSafeAI/modex/issues/280) CF-7 | 11/14 | Steps 1, 2 and 4: model-proposed relations, file hashes and selection/notes context are not built; step-level linking was retired | Val reviews the two saved Notes and records steps 1, 2 and 4 as deferred or retired |
| [#281](https://github.com/TypeSafeAI/modex/issues/281) CF-8 | 8/27 | Keyboard A1–A8, VoiceOver B1–B7, CF-3 D1–D5, P1–P4 and P6; memory measurement; ChatGPT multi-agent restriction check; staged release recommendation; list of remaining visual differences. C1–C5, V1–V3 and P5 are deferred | Val chooses the candidate, then runs A1–A8 and D1–D5 |
| [#319](https://github.com/TypeSafeAI/modex/issues/319) CR tracker | 2/10 | CR-3 to CR-8 acceptance; R1–R4 reconstruction comparison | Val's [one session](reviews/2026-11-02-v0.5.0-val-session.md) |
| [#322](https://github.com/TypeSafeAI/modex/issues/322) CR-3 | 10/14 | Original-reference comparison (AC1), keyboard/VoiceOver (AC4); clearance beside CR-6's inline section is measured on `main` (#491), but these boxes also need the person-run checks | Val runs the [CR-8 VoiceOver checklist](reviews/2026-10-22-cr8-voiceover/checklist.md) |
| [#323](https://github.com/TypeSafeAI/modex/issues/323) CR-4 | 10/14 | Original R1/R2 comparison, VoiceOver; clearance beside CR-6's inline section is measured on `main` (#491), but these boxes also need the person-run checks; avatars wait on decision 1 | Val decides on references |
| [#324](https://github.com/TypeSafeAI/modex/issues/324) CR-5 | 12/14 | Original R4 comparison (AC1); the Viewed toggle waits on decision 5 | Val decides on R4 references or re-captures |
| [#325](https://github.com/TypeSafeAI/modex/issues/325) CR-6 | 13/14 | Authorized live native smoke (AC6) | Val names `owner/repo#n` for the smoke |
| [#326](https://github.com/TypeSafeAI/modex/issues/326) CR-7 | 13/14 | Live canary on a disposable repository (AC6) | Val names a disposable repository |
| [#327](https://github.com/TypeSafeAI/modex/issues/327) CR-8 | 5/17 | Reference comparison, VoiceOver and the live gates. Budgets and C76 landed in #490; re-check item 18 and AC5 once Val confirms the budget numbers | Val's [one session](reviews/2026-11-02-v0.5.0-val-session.md) |
| [#376](https://github.com/TypeSafeAI/modex/issues/376) LM tracker | 1/14 | LM-2 to LM-8 acceptance; `LocalExecution` is not constructed, so the product refuses local turns | Val answers the five questions in `docs/reviews/2026-11-03-lm5-val-decision.md` on branch `lm-ready` |
| [#378](https://github.com/TypeSafeAI/modex/issues/378) LM-2 | 11/13 | Cold-load explanation text (step 6); token regression for diagnostics and exports (AC3) exists only on branch `lm-ready` | Land `lm-ready`; listing-only discovery once a local generative model exists |
| [#379](https://github.com/TypeSafeAI/modex/issues/379) LM-3 | 10/13 | Live turn against a real local server (AC1); global Codex config byte check (AC4), only on branch `lm-ready`; managed-Mac policy run (AC6) | Land `lm-ready` |
| [#380](https://github.com/TypeSafeAI/modex/issues/380) LM-5 | 3/13 | Fixture work for AC1, AC3, AC4 and AC5 is in open #475 (with #480), rebased on `lm5-fixtures-rebased`; offline canary (AC2) and real-runtime AC4 are native gates | Val's five answers, then land the rebased fixtures and re-reconcile #380 |
| [#381](https://github.com/TypeSafeAI/modex/issues/381) LM-4 | 0/13 | Connection UI and gated selection are implemented in the `lm-v1-workflow` candidate; rendered acceptance is blocked by Electron startup | Resolve launch prerequisites, then run the candidate journeys |
| [#382](https://github.com/TypeSafeAI/modex/issues/382) LM-6 | 0/11 | Not started; needs LM-5 and real runtimes | None until LM-5 lands |
| [#383](https://github.com/TypeSafeAI/modex/issues/383) LM-7 | 0/15 | Criterion-to-evidence map drafted on branch `lm-ready` (`docs/reviews/2026-11-03-lm7-evidence-map.md`) | Land `lm-ready` |
| [#384](https://github.com/TypeSafeAI/modex/issues/384) LM-8 | 0/11 | Optional; an outside contributor's scope question is unanswered | A maintainer answers the [scope question](https://github.com/TypeSafeAI/modex/issues/384#issuecomment-6390714922) |

## In flight

- **v0.4.2 release.** #492 (`4297235`) prepared it with Code Review hidden by default. It is not tagged or published. [Review](reviews/2026-11-03-v0.4.2-release-review.md).
- **Code Review acceptance** (#319). Every slice's code is on `main` (design and history: [design page](design/code-review.md), [CR-8 matrix](reviews/2026-11-01-cr8-acceptance-matrix.md)). Built apps hide it by default (#492); Settings → General can show it. #490 added that setting, C76 accessibility coverage, performance budgets as gates and the CR-7 sign-out and CF-3 question-card regressions; it also carries #481, #484, #485 and #491. No live provider run, live GitHub write, VoiceOver pass or reference comparison has happened. Those, plus decisions 1, 5, 6 and 7 and the C58/C59 omissions, are listed in [Val's one session](reviews/2026-11-02-v0.5.0-val-session.md).
- **Conversation fidelity** ([tracker #273](https://github.com/TypeSafeAI/modex/issues/273)). CF-3, CF-7 and CF-8 stay open; their code is on `main`. #489 (open) repairs keyboard focus after answering a native question. The human gates are under [Open acceptance gates](#open-acceptance-gates).
- **Local models** ([tracker #376](https://github.com/TypeSafeAI/modex/issues/376)). Main holds LM-1's contract, LM-2's loopback discovery, LM-3's Codex execution and LM-5's refusal boundaries, but does not construct `LocalExecution`, so a built app refuses every local selection. There is no UI (LM-4), and no real local generative runtime has been exercised. The next step is Val's five LM-5 answers: the decision record is `docs/reviews/2026-11-03-lm5-val-decision.md` on the unmerged branch `lm-ready` (`01101cb`), next to the LM-7 evidence map and the LM-4 design brief. `lm5-fixtures-rebased` (`7a38090`) rebases open #475, and `lm5-admission` (`1276a29`) is the unmerged admission branch. [How it works](local-models.md#lm-3-local-execution-through-codex).

  The `lm-v1-workflow` integration candidate carries the producer repairs and, with Val's explicit permission, frozen snapshots of `lmstudio-support` UI and `local-model-e2e` destination recovery. It adds connection editing/cancellation, revision-aware selection, host display, main-owned paired-send refusal, cloud-return confirmation, native read/edit/test qualification and scripted Electron journeys. Val approved and completed the `qwen3-coder:30b` download. The offline canary compares its owned server's exact model digest before and after the task; scripted regressions do not establish native inference. The original agent process has a dead Mach bootstrap port, but an existing, host-key-pinned local SSH service now provides a healthy execution context: native configuration reads and Electron startup pass without restarting the shared daemon. The first healthy run passed the previously failing Notes watcher tests and reached rendered workflow assertions. It exposed a restrictive launcher umask and an obsolete server-error assertion; both qualification details are corrected for the next pinned run. Full canonical, rendered and native acceptance remains in progress. Product execution stays unadmitted, issue boxes remain unchanged, and the full goal is open. [Candidate audit, setup and evidence boundaries](reviews/2026-11-04-local-models-v1-workflow.md).

  Follow-up review fixed stale profile-list and Cancel-response ordering, with five regressions first observed failing and then passing. Two further controls now require each offline canary to use a fresh empty evidence directory, preserving previous receipts. These repairs establish window-state and artifact behavior; native and rendered gates remain open.

  A further privacy review reproduced credential fragments crossing renderer events when a tool preview or stderr limit cut through a token split across chunks. The candidate now redacts accumulated text before those existing limits. The two failing-first regressions use the real runner with a scripted CLI and inspect readable records; they do not qualify a native model or admit product execution.

  The ordinary native `qwen3-coder:30b` smoke passed at `93fd820`, including a real read, exact approved edit, independent test and unchanged personal configuration. All four local Electron journeys passed at `368235b`, and the entire unit command was green at `bf7c915`. The first offline attempt exposed macOS's refusal to nest sandbox profiles. Its replacement verifies an enforced host network/filesystem boundary before selecting Codex's documented external-sandbox policy; approval rules, managed admission and ordinary product sandbox policy remain in place. Integrated offline and final whole-suite qualification remain pending, and no activation or publication is authorized by these results.
- **Claude account pool live acceptance.** The pool landed in #467. No live OrcaRouter turn, second subscription or real usage-limit message has run. [Design and limits](claude-accounts.md), [repair evidence](reviews/2026-11-01-claude-pool-repair.md).
- **Open PRs to close or rebase** (owners' call; nothing here was changed). #490 carries the content of #481, #484 and #485, and #488 replaced #486 with a safer `retire`. #475 still has its pre-rebase head.
- **Companion network acceptance (#109).** The [two-LAN evidence map](reviews/2026-10-28-companion-two-lan-acceptance.md) ties each of the four #109 requirements to the tests that prove it, adds the last race (the interface list changes while Forget paired phones or Turn off runs, and no listener survives with the old token; both shown red against a mutation, green on `main`), and holds the physical two-subnet procedure. Two gates remain with Val: running that procedure, and deciding whether VPN tunnels and virtual bridges with private addresses get a listener ([question](https://github.com/TypeSafeAI/modex/issues/109#issuecomment-6464762470)). The filter is unchanged until Val answers.
- **v0.4.0 post-publication acceptance and Companion 0.4.0 (9).** Desktop publication is complete. v0.3.0's two post-publication gates (the banner upgrade of the release Mac and the Companion 0.3.0 (8) upload) are superseded: the installed Mac reports signed 0.4.0, and Companion build 9 replaces build 8. The v0.3.0-to-v0.4.0 background upgrade remains unverified: the installed Mac already reports signed 0.4.0 and was left unchanged. Companion build 9 has not been delivered by this release session; its TestFlight upload and physical-device checks remain separate. Human accessibility, real-provider and native-platform account/session checks retain their existing gates. [Publication evidence and limits](reviews/2026-10-24-v0.4.0-release-review.md#published--2026-10-30-utc).
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

- **Modex Companion TestFlight.** The native iPhone app views threads, starts Local or Worktree threads, sends follow-ups, answers approvals and native questions while the Mac keeps CLI execution. Build 6 (v0.0.11 source) entered external testing on 2026-10-13, the last upload recorded here. Source is at 0.4.0 (9), and its native-question answers reach people only after Val's TestFlight upload. Physical installation from TestFlight, first-use permission diagnosis and final candidate acceptance remain open. [Physical evidence](reviews/2026-10-11-iphone-acceptance.md), [companion guide](ios-companion.md).
- **Provider feasibility (#78/#79).** [Gemini](gemini-feasibility.md) and
  [Grok](grok-feasibility.md) are explicitly deferred after the 2026-10-11 macOS refresh.
  Gemini 0.63.0 completed a text turn, resume, and cancellation, but the negative permission
  probe timed out during initialization. Grok 1.0.46 accepted cached auth and session RPCs,
  then its text turn timed out; native plan/sandbox also has documented permission limits.
  Neither provider is enabled. Both decisions include reproducible probes and distinguish
  observed failures from unverified capabilities; coding execution remains CLI-only. OpenCode
  and MiMo Code, probed over ACP on 2026-10-28, passed the same gates and shipped as backends
  ([#408](https://github.com/TypeSafeAI/modex/issues/408), [opencode.md](opencode.md)).
- **Approval rules (Jev-gated).** Parts 1 and 2 are on `main` with the gate off: saved rules can be previewed but do not decide live approvals. The quoted-test-name false allow, native escalation normalization and human acceptance keep it off. [Usage](approval-rules.md), [spec](specs/2026-10-01-modex-jev-approval-rules-spec.md), [readiness review](reviews/2026-10-11-approval-provider-readiness.md).

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

1. **Windows and Linux acceptance.** Their installers shipped with v0.1.0. Provider-account acceptance, KWallet6 and full graphical sessions, and historical schema migration remain unproven; see [native-platforms.md](native-platforms.md). The KWallet5 acceptance harness is pinned to its qualified Ubuntu 24.04 baseline (#456, `727e022`) after the moving runner label selected Ubuntu 26/KWallet6 without the expected daemon; Ubuntu 26/KWallet6 stays unverified. [Evidence](reviews/2026-10-30-linux-wallet-baseline.md).
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
- PRs land through `main`'s merge queue after CI (`gh pr merge <pr> --squash --auto`), with
  signed commits only.
- A PR that changes scope updates this page and, for user-facing behaviour, the README.
- A release's details and evidence go in its review under [`reviews/`](reviews/). This page
  keeps one Shipped row that links it, and the release leaves "In flight".
