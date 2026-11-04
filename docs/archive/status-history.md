# Status history through 2026-11-04

Moved word for word from [`docs/status.md`](../status.md) on 2026-11-04 so that page stays a map. Nothing here is current: each entry is true as of when it was written. Only relative links were adjusted. [Reviews](../reviews/) hold the evidence, and [status](../status.md) holds what is still open.

## Review repair delivery

Three review-found repairs landed before v0.4.0 and shipped in it; their evidence stays in their reviews and PRs.

- **ACP refusals and failed initialization** (#436, `469c612`). A refused explicit model fails before prompt submission, and a failed initialization releases the server so the next turn starts fresh. Hosted run 40764795777 failed the 500 ms transcript median gate with a 2019.2 ms median and timed out; the cause was never reproduced locally (234.2 ms cold open, 132.8 ms five-launch median) and stays unexplained.
- **LM-5 reroute repair** (#424 into #423, `c23e6be`). A rerouted local turn can no longer be reported completed by the quiet-final timer before interruption is confirmed. CodeQL alert #28 (regex escaping in a test assertion) was fixed in the same delivery. Local-runtime qualification and product admission remain open.
- **CR-6 exit ownership and disclosure** (#426, `d0482a0`). Unconfirmed child exit keeps ownership instead of reading as stopped, and provider-bound questions are no longer described as staying on the Mac. Native and live acceptance remain separate.

## v0.4.0 source delivery

- **v0.4.0 published.** Signed tag `v0.4.0` at `2eda138` is public and confirmed by GitHub's latest-release endpoint. Protected Release run `40985927886`, independent downloaded-asset checks and downloaded-app E2E passed. The source deliveries below are included in this release; feature exposure and acceptance limits remain as stated. See the [publication record](../reviews/2026-10-24-v0.4.0-release-review.md#published--2026-10-30-utc).

- **OpenCode and MiMo Code backends** ([#408](https://github.com/TypeSafeAI/modex/issues/408)).
  Two new thread backends drive the OpenCode CLI and Xiaomi's MiMo Code fork through their Agent
  Client Protocol server (`opencode acp --pure`, `mimo acp --pure`), the way Codex runs through
  `codex app-server`: one shared server per backend, a session per thread as the resume handle,
  `session/request_permission` answered through Modex's approval cards, rules and policies, Stop as
  `session/cancel`. Modex's modes are agents injected inline (`OPENCODE_CONFIG_CONTENT`): Chat denies
  edits, Agent allows them, Full access asks nothing, Plan pins the built-in plan agent; a refused
  mode fails the turn. Settings gets cards, executable overrides (verified by `--version`) and
  default models for both; health is `auth list`'s credential count and the model list is
  `<cli> models`. Not there: confined Code Review turns (refused), Modex's knowledge, Space and
  image tools, question cards, efforts in the model list. Accepted live on OpenCode 1.19.5 and
  MiMo Code 0.1.16 (`docs/opencode.md`, [ACP probes](../reviews/2026-10-28-opencode-acp.json),
  [MiMo](../reviews/2026-10-28-mimo-acp.json), [backend live run](../reviews/2026-10-28-opencode-backend-live.json)); AGENTS.md's CLI-only rule now names all four CLIs.
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
  [Review](../reviews/2026-10-22-lm2-connections-discovery.md).

- **CF-3 temporary VoiceOver deferral (2026-11-01).** Val said “skip voiceover for now and just proceed”. V1–V3 and P5 are deferred for now, not run or passed; D1–D5, P1–P4 and P6 remain open. Continue the non-VoiceOver acceptance run. #276 stays open. [Decision and current row status](../reviews/2026-10-22-cf3-question-acceptance.md#vals-temporary-voiceover-deferral-2026-11-01).
- **CF-8 integrated candidate `b643617`** (#281, 2026-10-28). The [acceptance receipt](../reviews/2026-10-18-conversation-fidelity-acceptance.md#integrated-candidate-2026-10-28-b643617)
  pins `main` at `b643617`, which carries every CF-1 to CF-7 slice (#394 and the CF-4 close-out via #404
  included). First pass, no reruns: install, build and typecheck passed; unit 2,011 passed and 17 skipped
  (desktop) with every other suite green; desktop e2e 470 passed and 7 opt-in skips; site 7/7; iPhone UI 23/23
  and 20/20 on a dedicated iOS 27.0 simulator. Live Claude Code 2.1.312 (Haiku, Chat mode) passed the golden
  path through the app: one approval, the edit and check, "Claude Code reported no plan for this turn" (the CLI
  offers Modex no plan tool), Save to Notes, Open, restart, and Stop (interrupted in 0.8 s, the file never
  written). Live codex-cli 0.164.0 (`gpt-6.1-sol`, ChatGPT account, Chat mode) passed the same path: two approvals, `apply_patch` and the check with exit code 0, a `final` answer, "Codex reported no plan for this turn", Save to Notes, Open, restart, and Stop (interrupted in 0.1 s, the file never written). The 2026-10-22 candidates `0e674e7` and `ec7be57` are kept as history beside it.
  **Human gates:** A1–A8 and B1–B7 await Val; C1–C5 were deferred by Val on 2026-10-30, not run. For CF-3, D1–D5, P1–P4 and P6 remain open; Val deferred V1–V3 and P5 for now on 2026-11-01. Phone rows still require the appropriate Companion build and physical-device evidence. No row is marked passed on Val's behalf; #281 stays open until each has Val's result or written deferral. On 2026-11-01 the receipt recorded the C1–C5 deferral, and that #450, #453 and #463 landed after `b643617`. The 2026-10-28 seeded build is gone, so the home was seeded again on `b643617` in `.worktrees/cf8-voiceover-b643617`. Val chooses whether A1–A8 and B1–B7 run on `b643617` or on a new candidate from current `main`.
- **Conversation acceptance history and human review kit.** The [acceptance receipt](../reviews/2026-10-18-conversation-fidelity-acceptance.md)
  preserves the October 20 early candidate results separately from later live-provider evidence.
  The [keyboard/VoiceOver checklist](../reviews/2026-10-20-keyboard-voiceover/checklist.md) includes
  an offline seed scenario. Human acceptance remains open; the integrated candidate is above.
  The full-log and patch-state E2E fixtures wait for the completed turn before inspecting its
  work, avoiding the initial idle state racing the fixture startup; their content and execution
  count assertions remain unchanged.

- **A saved task note reopens as the task it saved** (CF-7 #280). A task note in Notes has a
  **Task view** button that shows the request, clarifications, plan, files touched and verification
  as Save to Notes recorded them, read-only. It says when the note was edited after the save, moved
  to another project's notes (#363), trashed or saved again elsewhere. Opening it runs nothing, asks
  no CLI and writes nothing; continuing is a new message in the thread. Notes saved before this
  change have no task view. [Reopening a saved note](../task-context.md#reopening-a-saved-note).
- **A turn lists the files it touched** (CF-7 #280). A finished turn's footer has **Files touched**,
  which lists what its tools changed, read and searched, as the CLI reported them. For Codex, that
  includes its own parse of each command, resolved from the command working directory. Dot
  segments are normalized before checking the project boundary. At most 20 are shown, and paths outside the project are
  only counted. The saved note gets the same list. Nothing is indexed or inferred.
  [Context map](../task-context.md#context-map).
- **A turn says whether a check verified its last change** (CF-7 #280). Beside Save to Notes, a
  finished turn reads "Verified: `pnpm test` passed after the last change". If the check failed,
  did not say how it ended, ran before a later edit, or never ran, it says that instead. Only a known
  test, build, typecheck or lint command counts, never the model's word or an unrelated command. The
  saved note lists the checks and marks stale ones. Shell receipts that mask failures, mix checks
  with writes, or only parse a script cannot mark changes verified. Dynamic expansion and
  write-capable commands also invalidate earlier checks. [Verification](../task-context.md#verification),
  [shell-receipt repair evidence](../reviews/2026-10-20-cf7-shell-receipts.md).
  Task Note updates also recheck current project ownership: notes moved across projects are
  preserved, with a replacement saved under the originating project, even when a folder move
  or Finder move retained the old revision.
  The full-log regression now waits for the completed turn’s disclosure button before opening
  its history, avoiding a race with the live label and automatic folding at completion.
- **A Codex web search shows what it searched for and what it found** (CF-5 #278). The row reads
  "search *query*" with how many results there were, instead of "search " while the query had not
  arrived yet. Expanded, the results Codex reported are links with their snippets, labelled as
  unchecked. Results without an http(s) link are counted, not shown. The shape comes from a live
  codex-cli 0.163.0 capture. [Evidence guide](../conversation-evidence.md).
- **Answering, stopping or jumping to the latest from the keyboard keeps your place** (CF-8 #281
  keyboard walkthrough). The answer buttons go away once pressed, and a finished turn hides its
  folded work; either used to drop focus onto the page body. Focus now moves to the card's answer
  ("Approved", "Denied"), then to the turn's "Worked for" toggle when that work folds. Stop and
  Jump to latest, pressed from the keyboard, hand focus to the message box once they go away.
  Focus elsewhere, such as the composer, stays where it is.
- **Jump to latest stays at the bottom** (CF-8 #281, from #352). After a jump, the transcript used
  to stop short of the bottom when the message box grew, as when a suggested follow-up appeared,
  or when a Page Up was still scrolling. It now stays at the bottom until you scroll yourself.
  [How it was found](../reviews/2026-10-18-resolved-rough-edges.md#jump-to-latest-from-the-keyboard-on-ci-runners-handled-2026-10-20).
- **Stopping a Codex turn ends its background commands, or says it could not** (CF-8 #281 live
  smoke). Codex keeps a long command running in a background terminal after its turn is
  interrupted. Stop now ends the stopped turn's own terminals through the app-server and calls a
  command interrupted only once Codex no longer lists it. Otherwise the command reads unknown, with a
  notice. [Live smoke review](../reviews/2026-10-19-live-smoke.md).
- **An answer whose save fails is not taken** (CF-6 #279, from #336). When Modex cannot save an
  approval or question answer, as on a full disk, the card stays open and answering again reaches the
  CLI, instead of the request reading answered while the CLI never hears it.
  [Across replay and reconnect](../human-requests.md#across-replay-and-reconnect).
- **Questions across replay and reconnect** (CF-6 #279). A phone or paired desktop that was away
  while a question was answered, withdrawn or stopped finds the card closed on its next delta or
  reload. Taps it queued are refused, and Codex hears one reply. An older phone is now told when a
  question was answered on the phone, and phones get an answer's native phase, so Codex's plan is
  marked. New tests cover cursors, a crash inside the journal's batch window, the 8 MB slow-stream
  drop, v0.3.0 history, older paired desktops, and the iPhone app closing cards closed on the Mac.
  Live Codex and Claude turns with the journal on agreed on every path, also in the app through the live
  smoke. The journal suites pass on Windows and Linux CI. Val deferred the Windows and Linux app sessions and
  a real power cut (2026-10-23), and then the physical iPhone gate, so #279 closed.
  [Across replay and reconnect](../human-requests.md#across-replay-and-reconnect), [gates](../reviews/2026-10-22-cf6-gates.md).

- **Native question drafts survive thread navigation** (CF-3 #276, PR #348). Unsent choices
  and text stay in window memory and clear when their request closes or thread is removed.
  Sensitive answers stay out of persisted recovery. [Verification and native capability limits](../reviews/2026-10-20-cf3-drafts.md).
- **Answer an agent's questions from the iPhone** (CF-3 #276, coordinated with CF-6 #279). The Mac
  sends a native question card to a Companion build that names the `question` kind. The phone
  answers through the same broker as the desktop, with the same refusals and a 409 when another
  client answered first. A secret is typed into a secure field, held only in the phone's memory, and
  never logged or saved on either side. Older Companion builds keep the text notice. The phone half
  reaches people with the next Companion build, which Val uploads to TestFlight.
  [Phone](../human-requests.md#clients).

- **Plan mode on Codex runs in Codex's own plan mode** (CF-3 #276). A Plan turn on Codex can ask
  its clarifying questions on the question card with no feature flag. Codex's proposed plan is the
  turn's answer, in Markdown. The picked model and effort still apply, and the turn is still
  read-only. A Codex that refuses the mode falls back to the old prompt, with a notice.
  [Decision and live capture](../reviews/2026-10-22-cf3-plan-mode-decision.md).

- **CF-7 step linking is retired** (#280). Val retired linking a check to a plan step: neither CLI
  reports that link, and Modex does not infer it. Steps stay "Reported done", and verification stays
  per turn. [Decision](../reviews/2026-10-22-cf7-step-linking-decision.md).
- **Codex questions asked in a reply, and turns Codex never ends** (CF-7 #280, from live captures).
  When Codex asks in its reply (`agentMessage.questions`), the reply shows the options, and pressing one
  sends it as the next message. When Codex gives its final answer but never reports the turn finished,
  Modex ends the turn after five quiet minutes and says so. Live codex-cli 0.163.0 turns are replayed
  as fixtures; none sent a plan. [Live captures](../task-context.md#live-codex-captures).
- **A turn says when its CLI reported no plan** (CF-7 #280). A finished Claude Code or Codex turn that
  changed files or ran commands without a plan says "Claude Code reported no plan for this turn" in
  its footer and saved note. Claude Code 2.1.308 and later offer Modex no `TodoWrite`.
  [Plans](../task-context.md#plans).
- **Claude's task tools and Codex's proposed plans** (CF-7 #280, from live captures). When Claude Code
  2.1.309 offers `TaskCreate`/`TaskUpdate`, the tasks it creates and updates are the turn's plan,
  counted once the CLI confirms each call. Codex's plan-mode `plan` item is kept as the turn's
  proposed plan, so that turn does not say "no plan", and a plan-mode turn Codex never ends is ended
  like one after a final answer. [Plans](../task-context.md#plans).
- **CF-7 close-out and human-review candidate** (#280, 2026-10-29). The
  [close-out receipt](../reviews/2026-10-29-cf7-closeout/checkpoint.md) maps each acceptance criterion
  to the PR and tests behind it on `main` at `eca2bd9`, where the CF-7 unit tests (46) and e2e specs
  (8) pass. One real task ran per CLI through the app in Chat mode: Claude Code 2.1.312 (Haiku) and
  codex-cli 0.164.0 (`gpt-6.1-sol`) each ran the failing `npm test`, edited `greeting.txt` after
  approval, passed the check, read "Verified: `npm test` passed after the last change", saved a Task
  Note and reopened it read-only. Neither was offered a plan tool, and both said so. The seeded homes
  are kept for Val's review. **Still open, Val's:** the human review of the two saved Notes, and
  three observations in the receipt (a shell-written file listed as read, a `perl -pi` edit listing
  no file, a title cut mid-word). #280 stays open until Val records a result or a written deferral.

## In flight entries, as of 2026-11-04

- **v0.5.0 candidate: Code Review on by default** (#319, #327; branch `cr-v050`, full run clean on `370db33`). Carries #481, #484 and #485, a11y coverage of the CR-4 to CR-7 controls (C76), performance budgets as gates, the CR-7 sign-out and CF-3 question-card regressions, and a default-on setting with a rollback in Settings → General that replaces the `modex.codeReview` switch. It stays a candidate: nothing is merged, tagged or released, and no live or human gate has run on it. [Candidate review](../reviews/2026-11-02-v0.5.0-candidate.md); [Val's one session](../reviews/2026-11-02-v0.5.0-val-session.md). The C61 clearance test beside CR-6's inline section is on the stacked branch `cr-v050-followups`, whose own full run passed on `7e45440`.
- **Unmerged-work retirement safety repair (#486):** signed candidate `783898a` is pushed on `retire-safety-repair`; it requires matching ownership, archives index and working state separately, verifies raw working/ignored recovery, and retains the original checkout indefinitely instead of deleting files. Focused disposable-fixture results and design are in [the repair review](../reviews/2026-11-02-retirement-safety-repair.md). Pinned installation, build, full unit tests (2,325 passed, 26 skipped), typecheck and independent follow-up review passed; protected CI and landing remain pending. No real worktree retirement or repair-specific Electron e2e has been exercised.

- **Claude account pool with OrcaRouter keys.** Settings → Coding CLIs → Claude Code adds separate Claude Code profiles (each with its own `CLAUDE_CONFIG_DIR` and browser login), OrcaRouter gateway keys in OS-encrypted storage, an account for new conversations, and opt-in rotation when an account hits its usage limit. Threads bind to their first account; a turn that had not started work retries once on the next account. Unit and E2E coverage use a synthetic `claude`; no live OrcaRouter turn, second subscription or real limit message has been run. OmniRouter was evaluated and not integrated. [Design and limits](../claude-accounts.md).

Claude account pool review repairs passed build, full unit validation and the account Electron E2E test on a separate candidate based on #467: inherited profile credentials are removed, gateway transcript output is redacted before delivery, and a limited retry account cools down without another retry. The original PR remains pending; its AGENTS.md records the OrcaRouter destination approval, while live provider acceptance remains unrun. [Repair evidence](../reviews/2026-11-01-claude-pool-repair.md).

- **Current Code Review repository identity.** A reproduced C22 gap kept the inbox's repository name in the PR header and links after the overview returned a new name. The candidate adopts the overview locator after the existing PR-key check and retains it across an unavailable refresh. The Electron regression failed before the fix and passed afterward; independent review found no blockers, and the full unit retry passed (2,277 passes, 26 skips). Full E2E passed (479 desktop tests, 7 skips; 7 site tests). [Evidence](../reviews/2026-11-01-cr4-current-locator.md).

- **CF-3 question regressions (#276).** Local regression work adds native-question YOLO timing cases and a composer draft/attachment preservation fixture. Current-main build, typechecks, full unit validation (2,300 passes, 26 skips), four focused Electron cases and full E2E (481 desktop passes, seven skips; seven site passes) pass after host recovery and a fixture setup correction. Post-answer focus, approval interactions and human/native acceptance remain open. See the [validation receipt](../reviews/2026-11-01-cf3-question-regressions.md).

Code Review C50/C51 behavioral coverage is ready for review: an Electron fixture asserts the opening row and the comment menu’s exact copied URL, status, closure and keyboard focus return. Independent review found no blockers; build and unit validation passed (2,277 passes, 26 skips), and full E2E passed (479 desktop passes, 7 skips; 7 site passes). Reference comparison and VoiceOver remain open. [Evidence](../reviews/2026-11-01-cr-activity-controls.md).

- **Deferred Markdown for long threads (hosted cold-open budget).** Hosted CI's approved 500 ms cold-open gate failed on runner variance alone: 33 hosted runs on 2026-10-30 had a 377.7 ms median and a 781.9 ms failure on application code identical to a 436.1 ms pass. Val chose on 2026-10-30 to defer offscreen answers. Turns before the newest eight show their Markdown as written until it nears the view, then parse once; scroll anchoring keeps the reader's place. Locally the five-launch median fell from about 190 to 88 ms, and 3× CPU throttling cut it from 806–870 to 312–340 ms. The gate is unchanged. The first hosted run had a 129.9 ms median (481 desktop E2E passes). It landed through #463 (`32f1cb4`) on 2026-10-31 UTC and is unreleased. [Evidence](../reviews/2026-10-30-deferred-markdown.md).

Desktop CI memory diagnostics landed through #458 after #456’s cold transcript budget failure. The workflow reuses the existing resource sampler and retains its log as a separate CI artifact; it does not establish the cause of the earlier failure or change the 500 ms gate. The #458 queue passed desktop and site E2E and retained its memory log. See [the diagnostic review](../reviews/2026-10-30-desktop-ci-memory.md).

- **CF-7 failed-command follow-up (#280, 2026-10-30).** A separate correction to #450 preserves possible-writer commands even when they exit unsuccessfully: earlier writes are not rolled back by a failure. The new regression first failed on the proposed source; all 39 task-context tests now pass. Full build and unit validation passed (2,252 passed, 26 skipped); full E2E passed (476 desktop, 7 skipped, and 7 site). Independent review found no blocking issues. It landed through #453 (`f51ef7e`) and shipped in v0.4.1. No additional native or human acceptance is claimed.

- **LM-5 auxiliary dispatch regressions.** Candidate tests exercise deterministic local approvals, human approval fallback and four local failure outcomes with a recording Jev transport and cloud positive control. Thirteen focused cases passed; removing the local approval guard made both local approval cases fail on unexpected dispatch. Build and full unit validation passed (2,251 passes, 26 skips); independent review found no actionable findings. Protected delivery landed through #447; native offline acceptance and the remaining #380 criteria stay open. [Evidence](../reviews/2026-10-30-lm5-auxiliary-dispatch.md).
- **LM-5 context-window evidence (#380 AC6).** A local child's context window keeps its sources apart: the person's explicit setting, the effective value Codex reports, the runtime's last advertised maximum (or "not checked") and an unknown loaded size. A window above the advertised maximum is refused before any process starts. Disabling each of the four new guards made its regression fail. Product admission, the native offline canary and real-runtime overflow handling stay open. [Evidence](../reviews/2026-10-30-lm5-context-evidence.md).
- **LM-5 known cloud-routed models refused by main (#380).** `LocalExecution.validate` refuses a model the connection's last listing marked cloud-routed, embedding-only or not generative. On an Ollama connection it also refuses a `…:cloud`/`…-cloud` name without any listing. Nothing is spawned. Unmarked models stay unverified rather than local. Disabling each of the four guards made its regression fail. [Evidence](../reviews/2026-10-30-lm5-cloud-routed-models.md).

- **Canvas Escape harness readiness.** Repeated hosted failures showed the main pane still hidden after guest Escape. A controlled delayed-IPC diagnostic proved that renderer full-view state can precede native readiness. The test-only candidate waits for the native guest to become visible at the expanded preview bounds before sending one Escape, retaining all security and lifecycle assertions. Five candidate repetitions and full local validation passed; the implementation also passed hosted macOS validation. The Windows first failure, passing retry and original CodeQL upload failure remain recorded. It landed through #446 (`2ce777c`) on 2026-10-30, after v0.4.0. [Evidence](../reviews/2026-10-30-canvas-native-readiness.md).

- **Notes history identity repair.** History toggles could duplicate revision rows because the history and editor siblings shared a React key; the repair landed through #429 (`7a01df2`) and shipped in v0.4.0. [Repair evidence](../reviews/2026-10-28-notes-history-identity.md).

- **LM-5 effective subagent admission.** A reproduced policy gap accepted enabled native subagent flags despite disabled launch settings. The repair requires both effective values to be false; ten regressions failed before the fix, and 26 focused policy/execution tests now pass, including refusal before a native thread opens. A configuration-only CLI 0.166.0 probe confirms the explicit false report shape. Build and full unit validation passed (2,254 passes, 26 skips); independent review found no blocking findings. It landed through #448 (`ba8f289`) on 2026-10-30, after v0.4.0, and shipped in v0.4.1; native qualification stays separate. [Evidence](../reviews/2026-10-30-lm5-subagent-policy.md).

- **LM-5 local-only rule at each auxiliary chokepoint (#380).** `localOnly(thread)` is now enforced where each auxiliary call is made, not only by its callers. A Jev question naming a local thread gets no connection before any key is resolved; credit fallback, thread naming and unattended (routine) turns refuse a local thread, and the routine turn is not rerouted. One regression calls each chokepoint directly, with cloud controls; disabling each of the five guards made it fail. Product admission of `LocalExecution`, the native offline canary, runtime context evidence and real-runtime failure handling stay open. Delivered through #461. [Evidence](../reviews/2026-10-30-lm5-local-only-chokepoints.md).

- **v0.4.0 post-publication acceptance and Companion 0.4.0 (9).** Desktop publication is complete. v0.3.0's two post-publication gates (the banner upgrade of the release Mac and the Companion 0.3.0 (8) upload) are superseded: the installed Mac reports signed 0.4.0, and Companion build 9 replaces build 8. The v0.3.0-to-v0.4.0 background upgrade remains unverified: the installed Mac already reports signed 0.4.0 and was left unchanged. Companion build 9 has not been delivered by this release session; its TestFlight upload and physical-device checks remain separate. Human accessibility, real-provider and native-platform account/session checks retain their existing gates. [Publication evidence and limits](../reviews/2026-10-24-v0.4.0-release-review.md#published--2026-10-30-utc).

- **Local execution through Codex, in main only and not yet admitted** (LM-3 [#379](https://github.com/TypeSafeAI/modex/issues/379),
  [PR #423](https://github.com/TypeSafeAI/modex/pull/423), branch `lm3-signed-delivery`). A thread with a `localTarget` runs on its own `codex app-server` child: a private
  empty home, an environment allowlist, the connection token in one shell-excluded variable, the provider
  and model pinned and confirmed by Codex on every open, no stale-sign-in retry, and a resume handle refused
  unless that child opened it. Local turns bypass cloud accounts, Auto, Jev, titles, follow-ups and the
  credit fallback; Plan, images and Modex's note and knowledge tools are refused. One turn at a time per
  loopback port; force-stop ends only the thread's child. No UI (LM-4). After Val's 2026-10-26 review, main
  does not construct `LocalExecution`, so a built app refuses every local selection and persisted target
  until LM-5 qualifies Codex's redirect handling and managed-policy precedence (AC6), and a local child asks
  for no reasoning summaries. Fixture and real-CLI evidence are in the
  [LM-3 review](../reviews/2026-10-26-lm3-local-codex.md); the live turn against a real local server (AC1),
  offline operation and the AC6 qualification are open gates. #401 and the stacked draft #407 were closed as
  superseded; their main-side design is carried here, and #418 landed the inherited LM-2 credential fixes.
  [How it works](../local-models.md#lm-3-local-execution-through-codex).

- **LM-5 slice 1: effective destination and managed-policy admission** ([#380](https://github.com/TypeSafeAI/modex/issues/380),
  [PR #424](https://github.com/TypeSafeAI/modex/pull/424), merged into `lm3-signed-delivery` and delivered to main through #423 at `c23e6be`). Before a local child opens a thread, main reads the child's own
  `config/read` and `configRequirements/read` and admits it only when every governed key comes from Modex's
  session flags, no project layer or managed requirement applies, the private home is empty and the effective
  destination, model context and tools are the ones Modex passed; otherwise the turn fails naming the layer and
  key. A model reroute fails the turn. Real-CLI evidence shows codex-cli 0.164.0 follows a 307 from the
  configured loopback server with the full body and never with the token; this is recorded, not preventable.
  This is the refusal boundary #417's review asked for; wiring local execution into the product remains Val's
  decision. [Evidence](../reviews/2026-10-27-lm5-destination-policy.md).

- **Companion network acceptance (#109).** The [two-LAN evidence map](../reviews/2026-10-28-companion-two-lan-acceptance.md) ties each of the four #109 requirements to the tests that prove it, adds the last race (the interface list changes while Forget paired phones or Turn off runs, and no listener survives with the old token; both shown red against a mutation, green on `main`), and holds the physical two-subnet procedure. Two gates remain with Val: running that procedure, and deciding whether VPN tunnels and virtual bridges with private addresses get a listener ([question](https://github.com/TypeSafeAI/modex/issues/109#issuecomment-6464762470)). The filter is unchanged until Val answers.

- **Integrated review candidate `e25a554`.** CF-4 keyboard/performance, CR-5 remote diffs, CR-8 acceptance checks and the unwired CR-7 intent foundation were reconciled on this signed candidate, which landed through #404 (`e3527f4`) and shipped in v0.4.0. [The integration receipt](../reviews/2026-10-24-integrated-review.md) preserves the first failures, their repairs, source ancestry and the remaining human, policy and provider gates.

- **Revision-bound remote diffs** (CR-5 [#324](https://github.com/TypeSafeAI/modex/issues/324), [PR #395](https://github.com/TypeSafeAI/modex/pull/395)). The integration repair distinguishes the proven three-dot diff base from the target tip in file pages, context, anchors and labels. Four failing-first regressions and a real GitHub read confirmed the defect and correction; full build, unit, typecheck and E2E checks passed (430 desktop passes, seven skips, seven site passes). The original candidate's resource bounds remain in place. Original R4 comparison, human acceptance and the Viewed decision remain open. [Repair evidence](../reviews/2026-10-24-cr5-merge-base.md); [original candidate evidence](../reviews/2026-10-23-cr5-remote-diffs.md).

- **LM-1 local-model contract and native feasibility (#377 / #376).** Val accepted narrow Gate A on 2026-10-24 for the producer at main `bb0e1a4`, including the shared identity/runtime mapping from #400, and the recorded Codex 0.163.0/0.164.0 + Strata 0.1.47 tool/Stop/continuation evidence. The loopback metadata boundary is separately approved; no local execution feature is enabled. LM-2 consumes it through #403. Val explicitly deferred the additional Ollama/LM Studio app-server probe until a local coding model exists: Ollama has no models, and this Mac has only an LM Studio embedding model; linked-device LLMs are outside scope. [Contract/source map](../local-models.md), [native feasibility](../reviews/2026-10-22-lm1-feasibility.md) and [acceptance/availability](../reviews/2026-10-24-lm1-acceptance.md).

- **CF-4 Markdown closeout (#277), closed 2026-10-30.** The `cf4-closeout` candidate (named keyboard stops for table/code overflow, reference-viewport captures, the approved 500 ms median cold-open gate, and Markdown rows C1–C5 in the shared #281 human checklist) landed through #404 (`e3527f4`) and shipped in v0.4.0; the human review candidate record landed through #427. On 2026-10-30 Val deferred rows C1–C5 in writing; no row was run or passed, the rows stay in the shared checklist for a later build, and #277 closed with that deferral (#444, #449). A first-pass full suite on `main` at `907ba08` passed locally (#454). The former `cf4-voiceover` worktree was removed; its Git bundle preserves committed source, and the seeded home and built app need rebuilding and reseeding. [Closeout evidence](../reviews/2026-10-22-cf4-closeout/checkpoint.md).

- **Native conversation fidelity** ([tracker #273](https://github.com/TypeSafeAI/modex/issues/273)).
  The slices that landed through #335 and #333 shipped in v0.3.0; the
  [v0.3.0 review](../reviews/2026-10-20-v0.3.0-release-review.md#what-shipped) lists them with what is
  still open. The tracker keeps the dependency order and each slice's evidence, and its child issues
  link their open PRs.

- **Code Review inbox integration repair.** The renderer labels independently stale groups and
  pages, retains per-page failure/retry notices, and deduplicates first and later pages using the
  producer contract helper. The [authenticated integration check](../reviews/2026-10-21-cr3-read-integration.md)
  passed with CR-2 through the real Electron IPC/service path. The CR-3 acceptance follow-up closes
  #349's re-review items (inbox pages must agree on their total before the merged list reads
  complete; a read refused for a moved gh sign-in is retried once, then shown, while newer reads and
  cancellation remain authoritative across attempts) and proves, with the
  overview and remote diff now in the panes, that the list, overview, diff and file tree scroll alone
  and keep focus at 1440×900 and 900×600 ([acceptance record](../reviews/2026-10-28-cr3-acceptance.md)).
  On 2026-10-30 the automated half was re-run on `main` at `f51ef7e` and the read-only authenticated
  navigation probe passed six of six there again ([resume record](../reviews/2026-10-30-cr3-acceptance-resume.md), landed through #464, `3d72c6e`, on 2026-10-31 UTC);
  the journey spec's R1 and R4 captures, which had shown an empty Changes pane and no checks, now carry
  populated content for the comparison.
  Original reference comparison waits for Val to name the references (deferred on 2026-10-28); human
  keyboard/VoiceOver acceptance waits for Val's pass with the
  [checklist](../reviews/2026-10-22-cr8-voiceover/checklist.md).

- **Remote diff control regression coverage** (#324, #327). Four Electron cases now cover wrap/highlight rendering, per-file horizontal scrolling, keyboard and pointer divider resizing with reload persistence, file-menu copy-path IPC and link destination, and revision-bound context requests. [Evidence and limits](../reviews/2026-11-01-cr5-diff-controls.md) retain the first test-navigation failure and four negative controls. Build and unit validation passed. The first full desktop E2E run had 481 passes, 7 skips and one Canvas full-view failure; its site stage did not run. The unchanged full retry passed 482 desktop cases with 7 skips and 7 site cases. The original failure remains preserved and unexplained. Reference comparison, authenticated behavior and human accessibility remain open.

- **CR-6 agent review and questions** (#325). Phase 1's native proof ([isolation evidence](../reviews/2026-10-23-cr6-isolation.md)) showed Claude Code's restricted Read-only palette rejects injected shell, write, fetch, MCP and outside reads while Codex's read-only sandbox does not. Phase 2 builds on it: main's local `code-review:agent` channel starts the installed Claude Code CLI, under the person's own login, on a snapshot of the PR's diff that main reads itself through `gh`, with the shipped argv `--safe-mode --restricted --tools Read` and no permission tool, and an environment stripped of `gh`, GitHub and Modex variables. Each run is recorded before it starts, bound to the head it read, marked outdated when the head moves, stopped explicitly, and read as unknown after a crash; a finding reaches GitHub only through CR-7's review draft. Review instructions are one versioned text per Mac whose scope the popover states, and each run records the version it used. Unit, native-fixture (opt-in, production argv) and E2E evidence over a synthetic `claude` and `gh` are in [the review evidence](../reviews/2026-10-28-cr6-native-review.md); an authenticated live run and C82 remain open gates. On 2026-11-01 the unit and opt-in native denial tests were re-run on the installed Claude Code 2.1.316 and codex-cli 0.166.0 (6/6 native cases passed), and the live-smoke procedure was written down; it waits for a repository Val names.

- **CR-7 Code Review writes** (#326). Val decided on 2026-10-25: writes go through the person's `gh` login, and decisions 2–4 are in scope. The foundation stores scoped drafts and revision-bound intents, consumes confirmations once after durable admission, and recovers interrupted dispatches as unknown without resend. The first write increment adds main's separate `code-review:write` channel for top-level comments and submitted reviews (line comments from Changes included). Each is previewed with its exact destination, account and head, re-checked in main before sending, sent at most once, and reconciled by read-back when its outcome is unclear ([evidence](../reviews/2026-10-25-cr7-write-submit.md)). Mock and synthetic-`gh` only: the live write waits for a disposable repository Val names. A second increment adds Merge: main reads push permission, the repository's allowed methods, GitHub's merge state and the target branch's rules fresh. It offers only what `mergePreflight` ([preflight evidence](../reviews/2026-10-24-cr7-merge-preflight.md)) allows, sends the reviewed head as the merge's `sha`, and reconciles an unclear merge from the PR's own record ([evidence](../reviews/2026-10-25-cr7-merge.md)). A third increment adds decisions 2–4 the same way: the state menu (close, reopen, convert to draft, ready for review), title and description edits that are refused if GitHub's text changed, and reviewer requests ([evidence](../reviews/2026-10-25-cr7-pr-actions.md)). CR-6 isolation and C82 remain unchanged. See [the preparation evidence](../reviews/2026-10-23-cr7-intents.md). A follow-up binds the model to CR-5's shared `LineAnchor`, diff commit included, and records the check of CR-4's action slots ([evidence](../reviews/2026-10-24-cr7-anchors.md)). The integration repair fences queued and in-flight submits against document invalidation, verifies inline destinations against fresh complete patch evidence, preserves pending composer edits across navigation, and shows frozen inline details before submission ([repair evidence](../reviews/2026-10-26-cr7-write-repair.md)). All of it landed through #416 (`b3aad0d`, 2026-10-27). The live-write [canary procedure](../reviews/2026-11-01-cr7-live-canary.md) (comment, review, state, edit, reviewer, squash-merge on a throwaway PR) is written and not run; it waits for a disposable repository Val names.

- **Code Review workspace** ([tracker #319](https://github.com/TypeSafeAI/modex/issues/319)). A PR inbox, an overview with activity and checks, and a revision-bound remote diff in Modex desktop, rebuilt from four reference screenshots. Every slice's code is on `main` and shipped in v0.4.0 and v0.4.1 (CR-4 `6c40547`, CR-5 `e3527f4`, CR-6 `b643617`/`d0482a0`, CR-7 `b3aad0d`); what remains is acceptance, and no live, human or original-reference gate has run. CR-1 (#320) defines the account- and revision-scoped read contract and synthetic fixtures, and its [design page](../design/code-review.md) maps every reference control to an owner. CR-2 (#321) adds main's read service on the `code-review:read` channel: GET-only reads through the person's `gh` login, keyed by account, repository id and revision. The separate `cr2-cache-denial` follow-up invalidates retained PR data after visibility loss, including reads already in flight; it covers pending inbox searches, sibling file slices and denial during identity confirmation, while preserving unrelated repositories and ordinary offline/rate-limit fallback. [AC1 Electron evidence](../reviews/2026-10-21-cr2-electron-ipc.md) adds inbox → overview → files coverage through the production preload/IPC/service with a synthetic GitHub executable. The CR-3 development flag exposes the integrated inbox and workspace host. CR-4 (#323) adds the PR description, paginated activity, checks, inferred branch stack and provider/comment preview provenance through that host; validation and delivery evidence is recorded in [the CR-4 review](../reviews/2026-10-23-cr4-overview.md). Remote diffs (#324), agent review (#325) and GitHub writes (#326) are built; their live and human gates are listed below. Original-reference comparison and human accessibility remain open. Packaged builds still hide the destination unless `localStorage["modex.codeReview"]` is `"on"`; when that switch goes is Val's call.

  CR-8 (#327) keeps the [acceptance matrix](../reviews/2026-10-22-cr8-acceptance-matrix.md). It has one row per control C01–C82 and per AC of #321–#326, with fixture, authenticated, live-provider, live-write and human evidence kept apart. It adds Electron journeys and cross-slice regressions through the production read path with a synthetic `gh`: inbox → R1 → R4, identity, head moves, incomplete data, hostile links, no dispatch, and local Discard. It also adds keyboard/contrast checks and stress measurements, and a [VoiceOver checklist](../reviews/2026-10-22-cr8-voiceover/checklist.md) for Val. The read-only authenticated service smoke and the navigation probe were re-run on `main` at `0e674e7`, and both passed. That 2026-10-22 matrix is a historical baseline; the [2026-11-01 refresh](../reviews/2026-11-01-cr8-acceptance-matrix.md) maps every control and AC of #321–#326 to evidence on `main` `0a8c513`, with no "not started" rows, and lists Val's hand-off in one place. The original-reference comparison remains blocked because Val confirmed the original R1–R4 files are gone; the human VoiceOver pass and remaining integrated acceptance gates stay open.

  **Code Review gate corrections.** A candidate marks the C58/C59 omissions as unresolved acceptance gates and replaces the CR-6/CR-7 false-clean token pipelines with a fail-closed scanner. Nine synthetic regressions and build pass; independent review found no blockers. Full unit validation passed: 2,277 passes, 26 skips, zero failures. [Evidence](../reviews/2026-11-01-cr-gate-corrections.md).

  The [CR-8 journey refresh](../reviews/2026-10-28-cr8-journey-refresh.md) adds R2 activity scrolling and R3 instructions focus/Escape coverage to the existing production-read fixture journey, with captures and no provider starts or external writes. Focused validation and the full local suite passed (474 desktop, seven skipped, seven site); PR #440 and its merge queue passed hosted validation (477 desktop, four skipped, seven site), and the change is on main. Original-reference, human and live-provider/write acceptance remain open.

  The [integrated CR-8 review-flow fixture](../reviews/2026-10-28-cr8-review-flow.md) connects a populated remote diff, synthetic native review, anchored draft, explicit submission and restart reconciliation, requiring exactly one provider run and one synthetic write. The extended fixture passed build/unit validation and full E2E (475 desktop passes, 7 skips and 7 site passes). All seven combined agent and journey tests passed after integrating #440; it landed through #441 (`eca2bd9`) and is in v0.4.0. Human, original-reference and live-service acceptance remain open.

- **Mac App Store edition.** A sandboxed Store front end with a separately installed signed
  host, as Val chose. [Investigation and parity matrix](../mac-app-store.md).
  - **Development preview** (#119, approved by Val): an opt-in loopback host and a sandboxed
    MAS client that reuses the desktop renderer. Since #166, Store recovery pauses on
    certificate and host-protocol failures, keeps saved access and the mounted draft, and
    retries only when asked. [Preview ledger](../mac-store-preview-plan.md),
    [run instructions](../../apps/store-desktop/README.md),
    [recovery verification](../reviews/2026-10-11-store-recovery.md).
  - **Apple:** Mac Store 0.0.8 is beta approved in TestFlight (October 11 readback). Its
    production draft has the build and review notes selected, and still needs screenshots,
    description, keywords, support and privacy-policy URLs, and copyright; screenshots and
    listing text are prepared locally. [Apple receipt](../reviews/2026-10-11-apple-status.md),
    [review access](../reviews/2026-10-06-review-demo-access.md).
  - **Accepted** on signed current-account candidates: host discovery, real Codex and Claude
    turns, code comparison and denial, matching-code approval, credentials after relaunch,
    Stop of a real Claude background task, host-restart reconnect with the unsent draft, and
    revocation. [Signed acceptance](../reviews/2026-10-11-store-signed-acceptance.md#status-summary).
  - **Open:** the full parity matrix, graceful host shutdown, fresh-user setup, installed-host
    auto-launch, sleep/wake, the full welcome Open sequence and its Cancel check, a macOS
    TestFlight install, and App Review. [Readiness](../reviews/2026-10-11-store-readiness.md).

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
  acceptance remain open. [Physical evidence](../reviews/2026-10-11-iphone-acceptance.md).
  The first connection target is the same local network; [the companion guide](../ios-companion.md)
  records the pairing and release path.

- **Provider feasibility (#78/#79).** [Gemini](../gemini-feasibility.md) and
  [Grok](../grok-feasibility.md) are explicitly deferred after the 2026-10-11 macOS refresh.
  Gemini 0.63.0 completed a text turn, resume, and cancellation, but the negative permission
  probe timed out during initialization. Grok 1.0.46 accepted cached auth and session RPCs,
  then its text turn timed out; native plan/sandbox also has documented permission limits.
  Neither provider is enabled. Both decisions include reproducible probes and distinguish
  observed failures from unverified capabilities; coding execution remains CLI-only. OpenCode
  and MiMo Code, probed over ACP on 2026-10-28, passed the same gates and shipped as backends
  ([#408](https://github.com/TypeSafeAI/modex/issues/408), [opencode.md](../opencode.md)).
- **Approval rules (Jev-gated).** Part 1 (#54) merged with the gate off and no UI: every
  backend's approval request carries an action, `engine/approvals/digest.ts` builds the
  scrubbed state Jev sees, and `engine/approvals/gate.ts` decides allow, ask or never. Part 2
  (PR #107, merged) adds a Settings draft editor, project-scoped Try it previews, compact persisted
  receipts, the `(rule: …)` deny reason, `e2e/approvals.spec.ts`, and [usage docs](../approval-rules.md).
  The gate remains off: saved rules can be previewed but do not decide live approvals.
  Reconciliation with the merged companion passed build, typecheck, 15 core and 248 desktop
  tests plus the browser bridge test, and all 94 desktop e2e checks. This integration follows
  v0.0.6. The [2026-10-11 readiness review](../reviews/2026-10-11-approval-provider-readiness.md)
  expanded evaluation to 62 checks: 56 expected results and six false allows (quoted test
  names and truncated destructive suffixes, three repeats each). Human acceptance is prepared
  but not performed; native escalation normalization also needs proof. The gate stays off.
  The
  [reconstructed spec](../specs/2026-10-01-modex-jev-approval-rules-spec.md) records the part 2 decisions.
  By default a new rule covers the current project, and rules that need Jev show as inactive
  without it rather than being hidden.
  A follow-up makes an allow ask when the command chains or redirects commands or is longer
  than the text Jev sees, and makes receipts say when Jev was not consulted. That closes the
  truncated-suffix false allow; the quoted-test-name case remains open.
  [Recovery verification](../reviews/2026-10-12-approval-recovery.md) passed 1,376 unit tests
  (15 skipped), 271 desktop E2E cases and seven site cases. The gate remains off by default.

## In flight entries retired after #492

- **Code Review setting and its gates** (#490, #491; #319, #327). A persisted setting in Settings → General replaces the `modex.codeReview` switch, off by default as Val chose on 2026-11-03, on in development builds. Adds a11y coverage of the CR-4 to CR-7 controls (C76), performance budgets as gates, CR-7 sign-out and CF-3 question-card regressions, C61 clearance beside CR-6's inline section, and theme colours for the diff's plain buttons. No live or human gate has run. [v0.4.2 review](../reviews/2026-11-03-v0.4.2-release-review.md); [Val's session](../reviews/2026-11-02-v0.5.0-val-session.md).
- **Unmerged-work retirement safety repair (#486):** signed candidate `783898a` is pushed on `retire-safety-repair`; it requires matching ownership, archives index and working state separately, verifies raw working/ignored recovery, and retains the original checkout indefinitely instead of deleting files. Focused disposable-fixture results and design are in [the repair review](../reviews/2026-11-02-retirement-safety-repair.md). Pinned installation, build, full unit tests (2,325 passed, 26 skipped), typecheck and independent follow-up review passed; protected CI and landing remain pending. No real worktree retirement or repair-specific Electron e2e has been exercised.
