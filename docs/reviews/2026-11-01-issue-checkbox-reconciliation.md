# Issue checkbox reconciliation — 2026-11-01

Every checkbox in the open tracked issues (#273, #276, #280, #281; #319, #322–#327; #376, #378–#384) was
checked against `origin/main` at `9ecccc9`, plus issue comments and PRs, read over REST. A box was ticked
only when its full text is met by on-main evidence. Open PRs (#472, #475, #476, #477, #481, #482) did not
count. Human, live-provider, live-write and native rows stay unticked unless a receipt records them as run
and passed. A written deferral is not a pass. No box was unticked: every box that was already ticked had
evidence behind it.

**Applied on 2026-11-01:** 112 boxes ticked. Rows below marked *proposed* `[x]` were applied, **except
the five marked "Borderline"**. Those stay unticked until someone settles them: #322 item 16, #323 AC6,
#324 item 19, #327 item 15 and #327 AC4. Rows that turn on Val's decisions (for example, whether
`b643617` stays the CF-8 candidate) also stay unticked.

How to use this page: issue checkmarks summarize evidence; they are not evidence themselves. When code or
receipts change, re-check the rows below against the linked receipts instead of trusting a checkmark.
The status map is in [`status.md`](../status.md#open-issue-checklists).

## CF checkbox reconciliation proposal, 2026-11-01

Read-only pass. `origin/main` at `9ecccc9` (#474). Issue bodies and comments were read over REST at about 15:40 UTC.
Nothing was written to GitHub or to the checkout.

Conventions:
- **Prefix** is the first 60 characters after `- [ ] ` / `- [x] `, verbatim. Trailing spaces are trimmed, and `|` is escaped as `\|` only inside the table. Match it with `startswith`.
- **Cur / Prop**: `x` means checked, blank means unchecked. **FLIP** marks a proposed change.
- Fixture or unit evidence on main counts for engineering rows. It never counts for human or live rows. A deferral by Val is not a pass.
- Open PRs that do **not** count: #476 (CF-3 VoiceOver deferral record, docs only, unmerged, awaiting Val) and #482 (stacked on #476's branch `cf3-deferral-sync`, docs only, unmerged). Neither changes any row's evidence. They only record the V1–V3/P5 deferral, which keeps those rows unchecked anyway.

Abbreviations: **FA** is `docs/reviews/2026-10-18-conversation-fidelity-acceptance.md`, **HR** is `docs/human-requests.md`, **TC** is `docs/task-context.md`, **CF7R** is `docs/reviews/2026-10-29-cf7-closeout/checkpoint.md`, and **CF3D** is `docs/reviews/2026-10-18-cf3-delivery.md`.

---

### #273 — Tracker

| # | Prefix | Cur | Prop | Evidence / reason |
|---|---|---|---|---|
| 1 | `#274 — **CF-1 / P1:** Preserve native turn/item identity, me` | x | x | #274 closed. Keep. |
| 2 | `#275 — **CF-2 / P1:** Harden Claude Stop, late-message drain` | x | x | #275 closed. Keep. |
| 3 | `#276 — **CF-3 / P1:** Add a main-owned human-request lifecyc` | | | #276 open. Human rows D1–D5, P1–P4 and P6 have no result. Keep. |
| 4 | `#277 — **CF-4 / P1:** Render typed turns with safe Markdown,` | x | x | #277 closed on Val's written C1–C5 deferral (#444, #449). Keep. |
| 5 | `#278 — **CF-5 / P1:** Connect trustworthy source annotations` | x | x | #278 closed. Keep. |
| 6 | `#279 — **CF-6 / P1:** Preserve the richer event contract thr` | x | x | #279 closed 2026-10-23 on Val's written deferral of the remaining gates. Keep. |
| 7 | `#280 — **CF-7 / P2:** Link a bounded task plan to project fi` | | | #280 open. Val's review of the saved Notes (4 rows in CF7R "Human review") is open. Keep. |
| 8 | `#281 — **CF-8 / P1:** Prove the complete experience with E2E` | | | #281 open. Human rows A/B, D and P are open. Keep. |
| 9 | `Each child links its implementation PR and a criterion-by-cr` | | | Not met. CF-3 has requirement-level receipts (CF3D, HR) but no criterion-by-criterion receipt for its 7 ACs. CF-8's receipt is not final. Keep. |
| 10 | `Native message identity survives adapters, UI, persistence,` | | **x FLIP** | #274 and #279 closed. `test/journal-resume.test.ts` replays one typed turn, including a failed attempt and its retry, through live projection, saved files, both journals, a paired desktop and both phone kinds, and all agree (HR "Tests"). FA matrix on `b643617`: "Outcomes, reasoning and provenance match recorded events" is Verified, and "Paired-client reconnect" is Verified (fixture, unit). |
| 11 | `Stop/denial/stale questions and simultaneous answers do not` | | **x FLIP** | FA matrix on `b643617`: Denial, Stop while executing, Native request withdrawal, Simultaneous desktop and phone answers, and Reconnect after a decision send are all Verified (fixture) with execution counts. Live Claude and Codex Stop passed on `b643617` (FA "Live gates"). CF3D: transport failures stay uncertain and nothing is resent. |
| 12 | `A small real coding task has an inspectable plan, actual dif` | | | Partial. Live real tasks with diff, check and a saved Note exist (CF7R live runs, FA live gates on `b643617`), but every live turn read "reported no plan". No real task produced an inspectable plan together with a saved Note. Val's Note review is open. Keep. |
| 13 | `Legacy history and unsupported clients retain a safe readabl` | | **x FLIP** | `test/conversation-migration.test.ts` covers v0.3.0 history and older paired desktops (FA matrix, "Old snapshot migration", Verified (unit)). `test/companion.test.ts` checks the question fallback text for a phone that names no kinds. `test/question-replay.test.ts` covers a notice for a phone that does not draw questions and refuses an older paired desktop (HR "Tests"). `docs/conversation-fidelity.md` "Migration and rollback". The human P6 check on a real old Companion remains a separate open row on #281. |
| 14 | `Fresh \`pnpm build\`, \`pnpm typecheck\`, \`pnpm test\`, and \`pnpm` | | | Met for `b643617` (FA "First pass": all commands, SHA, skips listed; human and native gates separate). But #450, #453 and #463 landed after it, and #463 changes `ThreadView.tsx`/`Markdown.tsx`. Val has an open question on #281 ([comment](https://github.com/TypeSafeAI/modex/issues/281#issuecomment-6558541083)) about repinning. Keep unchecked. **Flip only if Val keeps `b643617` as the candidate.** |
| 15 | `Supported behavior and reference screenshots are versioned;` | | **x FLIP** | `docs/screenshots/conversation-fidelity/manifest.json` holds 33 references with state, theme, viewport, source build and hash. `docs/conversation-fidelity.md` has the supported matrix and states "None of them is a provider screenshot or a pixel baseline". The CF-4 reference-viewport captures landed in #404. |

**Flips: 4 (rows 10, 11, 13, 15 → checked). No unchecks.**

**Current state.** Five of eight children are closed: CF-1, CF-2, CF-4 (C1–C5 deferred), CF-5 and CF-6 (gates deferred). The three open children have no code left. Each waits on Val's human rows:
- CF-3 needs D1–D5, P1–P4 and P6, and P1–P6 first need Companion 0.4.0 (9) on TestFlight, which is unconfirmed.
- CF-7 needs Val's 4-row review of the saved Notes.
- CF-8 needs A1–A8, B1–B7 and the CF-3 rows, plus Val's decision on repinning past #463.

Definition-of-done rows backed by fixture, unit or live evidence on main can be ticked now (rows 10, 11, 13, 15). Rows 9, 12 and 14 stay open: 9 needs criterion-level receipts, 12 needs a real task with a plan and Val's Note review, and 14 waits on the candidate choice. **Next action:** Val answers the `b643617`-vs-new-candidate question on #281 and runs D1–D5 on the prepared Mac build.

---

### #276 — CF-3

| # | Prefix | Cur | Prop | Evidence / reason |
|---|---|---|---|---|
| 1 | `Record installed CLI capabilities and actual request/respons` | | **x FLIP** | CF3D "Installed native schema" records the CLI versions and schema SHA-256s. `shared/human-requests.ts` has `HUMAN_REQUEST_SCHEMA = 1`, an approval/question union and a separate `Resolution` kind (HR "Contract"). Unsupported methods get `-32601`, and malformed ones get `-32602` plus a notice (HR "Native mappings"). Claude's lack of question support is documented. Landed in #293 (`57e7607`). |
| 2 | `Add a main-owned request record bound to local thread/turn/a` | | **x FLIP** | `RequestBinding` covers thread, turn, attempt, backend, account, runtime, nativeRequestId and item. Main snapshots the request and the accepted answer, and the digest is distinct from authority (HR "Contract", "Binding"). CF3D row "Stale identity and actions cannot authorize work". |
| 3 | `Implement validated broker operations \`register\`, \`resolve\`,` | | **x FLIP** | The broker functions and `RequestState` pending/resolving/resolved/withdrawn/uncertain are in HR. Revalidation happens at acceptance and before the write. A changed action withdraws the card and needs a new ID. The doc says "not an exactly-once remote guarantee". CF3D (#335 repair). |
| 4 | `Render native questions as accessible cards using only forms` | | | Partial. Cards, validation, the secure field and question-draft survival are evidenced (#293, #348, `e2e/human-requests.spec.ts`). YOLO auto-answers only approvals, per source at `runner.ts:1206`, with no dedicated test. No test or receipt shows that the **composer draft and attachments** survive card interaction. Accessibility awaits human D1, and V1–V3 is deferred. Keep. |
| 5 | `Route desktop and supported companion answers through the sa` | | **x FLIP** | #373 routes phone answers through the same broker. `test/companion.test.ts` returns a 409 to the loser and a fallback notice to old phones. `test/question-replay.test.ts` refuses an older paired desktop's approve/deny on a question (`invalid`) and resends nothing after an uncertain send. After a restart, open cards are inert (`human-requests-runner.test.ts`, HR "Tests"). |
| 6 | `Keep the preview approval gate off by default, retain permis` | | **x FLIP** | HR "Repair verification": preview gate off by default, and permission-profile validation keeps its decisions. Secrets are redacted to "(hidden)". Docs and status were updated in #293 and later PRs. RED-first is recorded in CF3D and `2026-10-20-cf3-drafts.md`. |
| 7 | `Two clients answer one request: one local resolution wins; t` | | **x FLIP** | `test/human-requests.test.ts` (two clients) and `test/request-journal.test.ts` (desktop/phone race on a real Codex question, 409 for the loser, Codex hears one answer). FA matrix: "Simultaneous desktop and phone answers" Verified (fixture). |
| 8 | `Wrong thread/account/item/generation, a modified action, or` | | **x FLIP** | CF3D: broker tests reject a wrong thread, turn, attempt, backend, account, item, runtime and native request ID. Changed-action and unknown refusals (HR "Refusal"). |
| 9 | `Stop or native withdrawal during answer submission leaves a` | | **x FLIP** | CF3D row "Acceptance is distinct from delivery": withdrawal or Stop after acceptance records uncertain. A restart E2E turns `sending` into inert `uncertain`, and nothing is resent (`e2e/human-requests.spec.ts`). FA matrix: "Native request withdrawal" Verified. |
| 10 | `Native request ID and full supported response shape are pres` | | **x FLIP** | HR "Native mappings": approvals carry `native {runtime, request, item}`, Codex answer shape `{answers:{[id]:{answers}}}`, and string and numeric IDs are kept distinct. CF3D fixed and tested the denial-receipt omission. Permission-profile and turn-scoped grant tests are retained (CF3D "Policies and compatibility"). |
| 11 | `Required answers, choice IDs, malformed payloads, and unsupp` | | **x FLIP** | `validateAnswers` requires every question answered and choices from the options. `codexQuestions` returns null for a malformed request (`-32602`), and unsupported methods get `-32601` (HR). Companion tests: malformed bodies reach nothing, and `invalid` returns a 400. |
| 12 | `Draft/attachment content and focus survive question/approval` | | | Partial. Question-card drafts survive navigation (#348), approval keyboard focus is covered (`e2e/keyboard-answers.spec.ts`, #342/#352), and secrets stay out of every file, event and export (HR "Secrets"). No evidence that **composer draft and attachments** survive a question or approval. Keep. |
| 13 | `Existing Ask/Always/YOLO and read-only routine refusal tests` | | **x FLIP** | HR "Repair verification" and CF3D "Policies and compatibility": Ask/Always/YOLO, Never, escalation, routine refusal and permission-profile tests remain the required gates. The preview gate stays off. Full suites passed on `b643617` (FA "First pass"). |

**Flips: 11 (rows 1–3, 5–11, 13 → checked). Rows 4 and 12 stay unchecked. No unchecks.**

**Current state.** All CF-3 code is on main and unchanged on the question path since `6c9000f` (#276 [comment](https://github.com/TypeSafeAI/modex/issues/276#issuecomment-6558359725)):
- #293, #335, #348, #357/#358, #373, #369 and #385;
- #389 under CF-6.

The issue's engineering ACs have fixture and unit evidence. Two gaps remain: no test shows that the composer draft and attachments survive card interaction (steps 4 and 12), and no test shows that YOLO never auto-answers a question. A small e2e would close both.

Human acceptance is untouched: 0 rows passed. Val deferred V1–V3 and P5 on 2026-11-01, but that deferral is recorded only on #276 and #281 and in unmerged #476/#482. D1–D5, P1–P4 and P6 are open, and the TestFlight upload of Companion 0.4.0 (9) is unconfirmed. **Next action:** Val runs D1–D5 on the prepared 0.4.1 ad-hoc build (`.worktrees/cf3-vo-deferral`) and gives the go-ahead to merge #476. An agent could add the composer-draft/attachment regression.

---

### #280 — CF-7

| # | Prefix | Cur | Prop | Evidence / reason |
|---|---|---|---|---|
| 1 | `Define a serializable task record using CF-1 IDs: project/re` | | | Partial. The task record exists (#289, `shared/task-context.ts`, saved as `notes/.modex/tasks/<id>.json`). TC "Not done yet" lists "Model-proposed or user-confirmed context relations" as not done, so only "observed" exists. No file revisions or hashes are recorded. Keep. |
| 2 | `Build context on demand from the selected project, explicit` | | | Partial. The context map holds only files the CLI reported, at most 20 with an overflow count, and no graph (#355, #360; TC "Context map"). Context from **explicit selections and existing project notes** is not evidenced. The read-only Plan rule is covered (`e2e/codex-native-plan.spec.ts`). Keep. |
| 3 | `Ingest native plan updates only when supported by the instal` | | **x FLIP** | #289 (Codex `turn/plan/updated`, Claude `TodoWrite`) and #394 (Claude `TaskCreate`/`TaskUpdate`, Codex plan-mode `plan` item as a proposal). #391 adds the honest "reported no plan" line, and the Markdown is never parsed back (TC). Clarifications come through question cards (#312, #385). CF7R AC1 and AC2 are Verified. |
| 4 | `Render plan steps next to linked files/tests and actual comm` | | | Not met as written. Step-to-file and step-to-check linking was **retired by Val** on 2026-10-23 (#370; TC "Retired"), and steps stay "Reported done". Turn-level verification exists (#351, #368). A retirement is not a pass. Keep. |
| 5 | `Add explicit Save task record to Notes using the existing pr` | | **x FLIP** | #289 and #363 (TC "Save to Notes"): saving again updates the same note, an edited note is kept and the save becomes a new note, moves across projects are handled, nothing auto-saves, and agents cannot use it. The note leaves out reasoning, logs and outside paths. CF7R AC4 and AC6 are Verified. |
| 6 | `Reopen the saved Note into a read-only task view. Continuing` | | **x FLIP** | #375 (TC "Reopening a saved note"): read-only, no turn, CLI call or write. It reports edited, moved, no linked notes and in Trash. Continuing is a new message. Manage notes is covered (`e2e/pages-agents.spec.ts`). CF7R AC5 is Verified, live 2026-10-29. Caveat: it shows the saved record rather than re-resolving missing files, which reads as "safe". |
| 7 | `Add the end-to-end fixture, update status and \`docs/task-con` | | **x FLIP** | `e2e/task-to-notes.spec.ts`, `e2e/plan-clarification.spec.ts` and `e2e/codex-native-plan.spec.ts`. TC and `docs/status.md` were updated, and every slice landed signed through the queue (CF7R "What landed, by PR"). |
| 8 | `One request shows a plan with bounded relevant file/test ref` | x | x | CF7R AC1 Verified. Keep. |
| 9 | `Unsupported native plan capability has a readable honest fal` | x | x | CF7R AC2 Verified. Keep. |
| 10 | `A relevant passing check at the recorded revision can suppor` | x | x | CF7R AC3 Verified. Keep. |
| 11 | `Save creates/updates exactly the intended project Note with` | x | x | CF7R AC4 Verified. Keep. |
| 12 | `Reopen/replay performs zero coding turns, tool execution or` | x | x | CF7R AC5 Verified. Keep. |
| 13 | `No file bodies/context map are disclosed to Jev, no secrets/` | x | x | CF7R AC6 Verified. Keep. |
| 14 | `Existing Notes migration, asset references and scoped tools` | x | x | CF7R AC7 Verified. Keep. |

**Flips: 4 (steps 3, 5, 6, 7 → checked). Steps 1, 2 and 4 stay unchecked. No unchecks. All 7 ACs keep their current ticks, which the evidence supports.**

**Current state.** All CF-7 slices are on main: #289 through #394, the close-out receipt #443, the observation fixes #450 and #453 (shipped in v0.4.1), and the kit restore #473. All seven ACs are evidenced in CF7R, with live Claude 2.1.312 and Codex 0.164.0 tasks on 2026-10-29.

Three gaps remain:
- **Steps 1, 2 and 4.** Model-proposed or user-confirmed relations, file hashes, and context from explicit selections or notes are not built. Step-level linking was retired by Val.
- **Live plan.** No live `turn/plan/updated` step plan has been seen.
- **Val's review.** Val's 4-row review of the two saved Notes is open. The kit is at `.worktrees/cf7-review-kit`.

**Next action:** Val reviews the two Notes, or defers in writing. Separately, Val decides whether steps 1, 2 and 4 are deferred or retired, so they can be recorded as such rather than left ambiguous.

---

### #281 — CF-8

| # | Prefix | Cur | Prop | Evidence / reason |
|---|---|---|---|---|
| 1 | `Refresh main, all seven child PRs and release status. Reconc` | | **x FLIP** | `b643617` was pinned with all CF-1 to CF-7 slices reconciled (FA "Integrated candidate", #428). It was re-reconciled on 2026-11-01 (#474). Caveat: if Val repins past #463, this repeats. |
| 2 | `Build the golden fixture: open project → request a small cha` | | **x FLIP** | `e2e/conversation-fidelity.spec.ts` "golden path" asserts bytes, execution counts, plan, outcomes and note revisions across a restart. "A clarifying question in the path" and "a phone that reconnects after the decision was sent" complete it. FA matrix rows 1–3 are Verified on `b643617`. |
| 3 | `Add negative variants: denial with unchanged file; command f` | | **x FLIP** | All 12 named variants have Verified fixture or unit rows on `b643617`, with execution counts (FA "Matrix on `b643617`": denial, command failure, unknown, Stop, withdrawal, simultaneous answers, reconnect, migration, journal off, expired cursor, stale Note, missing artifact). |
| 4 | `Capture live/waiting/failed/completed/restored states in Gra` | | | Partial. The captures exist in 3 themes at 900×600 and 1440×900, and the keyboard and reduced-motion fixtures pass. The step also requires "obtain human VoiceOver acceptance": B1–B7 is open, and CF-3 V1–V3 is deferred, not passed. Keep. |
| 5 | `Measure long transcript and log-heavy streaming on a named e` | | | Mostly met: before/after on a named Mac, output and event-size bounds, and the 500 ms open budget (FA "Measurements"). No **memory** measurement is recorded. Keep. Flip if Val accepts output bounds in place of memory. |
| 6 | `Run supported native Codex and Claude smoke scenarios with a` | | | Live Claude 2.1.312 and Codex 0.164.0 passed on `b643617`, with versions, models and limits (FA "Live gates"). There is no recorded verification that "app-owned ChatGPT multi-agent restrictions are not accidentally weakened". Keep. |
| 7 | `Complete compatibility/rollback documentation and a staged r` | | | Partial. `docs/conversation-fidelity.md` "Migration and rollback" exists. **No staged release recommendation** was found. Criterion-level links to every child are incomplete because CF-3 has no AC-level receipt. Keep. |
| 8 | `Golden fixture passes through the actual Electron/main/nativ` | | **x FLIP** | FA matrix: golden path through the real app, main and `claude -p` adapter (fixture CLI) persists diff, check and Note. The live Claude and Codex golden path also passed on `b643617`. |
| 9 | `Every negative variant has a deterministic assertion, includ` | | **x FLIP** | Same as step 3. Zero-execution counts on denial and restart (`{}` / unchanged counts) in FA. |
| 10 | `Final item/turn outcomes, reasoning representation and sourc` | | **x FLIP** | FA matrix "Outcomes, reasoning and provenance match recorded events": Verified on captures, including the CF-7 live captures, with live outcomes recorded on `b643617`. |
| 11 | `Legacy and supported paired-client recovery converge with sa` | | **x FLIP** | FA matrix: "Old snapshot migration" (v0.3.0 history and older paired desktops) and "Paired-client reconnect" Verified. `test/journal-resume.test.ts` shows all clients converge. `question-replay`/`companion` tests give a non-actionable notice to non-drawing phones and refuse an older desktop (HR). The human P6 row stays separate. |
| 12 | `Fresh \`pnpm build\`, \`pnpm typecheck\`, \`pnpm test\`, and \`pnpm` | | | Met for `b643617` (FA "First pass", iPhone simulator UDID and skips listed). Later commits #450, #453 and #463 are not in it, and Val's repin decision is pending. Keep. **Flip if Val keeps `b643617`.** |
| 13 | `Live Codex/Claude acceptance and human keyboard/VoiceOver ev` | | | Live is done. Human A1–A8 and B1–B7 are open (FA "What is open"). Keep. |
| 14 | `Reference/candidate captures and measured performance are re` | | | Captures and measurement are reproducible (`MODEX_SCREENSHOTS`, `MODEX_MEASURE`, manifest hashes). There is **no list of remaining visual differences**, and the human visual review is open ("human visual review: Val"). Keep. |
| 15 | `Privacy documentation accurately describes Streamer Mode's v` | | **x FLIP** | `docs/conversation-fidelity.md` "Privacy limits" states that Streamer Mode masks only the window, not the clipboard, accessibility text or images. Each receipt records "No tag, release, merge-queue entry or policy default changes", and the journal and preview gate are off by default. |
| 16 | `D1 Desktop, keyboard only: the card is reachable and labelle` | | | Human. Not run (#276 comment 2026-11-01 14:14: 0 passed). Keep. |
| 17 | `D2 Desktop: an incomplete answer is refused on the card, and` | | | Human. Not run. Keep. |
| 18 | `D3 Desktop: choices and text survive switching threads.` | | | Human. Not run. Keep. |
| 19 | `D4 Desktop: submit from the keyboard. The card shows "(hidde` | | | Human. Not run. Keep. |
| 20 | `D5 Desktop: Stop withdraws the card; nothing more reaches Co` | | | Human. Not run. Keep. |
| 21 | `V1–V3 Desktop VoiceOver: question, options, selected state a` | | | Deferred by Val 2026-11-01, not passed. Keep. |
| 22 | `P1 iPhone: a native card, not the text notice.` | | | Human. Not run, and TestFlight is unconfirmed. Keep. |
| 23 | `P2 iPhone: an incomplete answer is refused on the card.` | | | Human. Not run. Keep. |
| 24 | `P3 iPhone: answer from the phone. The Mac shows "Answered on` | | | Human. Not run. Keep. |
| 25 | `P4 iPhone: when the Mac answers first, the phone shows "This` | | | Human. Not run. Keep. |
| 26 | `P5 iPhone VoiceOver: options, selected state, secure field a` | | | Deferred by Val 2026-11-01, not passed. Keep. |
| 27 | `P6 Older Companion (0.3.0 (8) or earlier): text notice, no b` | | | Human. Not run, and needs an older Companion. Keep. |

**Flips: 8 (steps 1, 2, 3; ACs 8, 9, 10, 11, 15 → checked). No unchecks. The 12 human rows stay unchecked.**

**Current state.** Integrated candidate `b643617` (#428) passed a first pass with no reruns: build, typecheck, unit, e2e and iPhone simulator. Live Claude and Codex golden paths with Stop passed. Every fixture and unit matrix row is Verified, and #474 reconciled the receipt on 2026-11-01.

Still open:
- **Human rows.** Keyboard A1–A8 and VoiceOver B1–B7 are open. C1–C5 are deferred. CF-3 D1–D5, P1–P4 and P6 are open, and V1–V3 and P5 are deferred.
- **Engineering steps:** no memory measurement, no multi-agent restriction check, no staged release recommendation, and no list of visual differences.
- **Candidate.** `b643617` predates #450, #453 and #463. #476 and #482 (docs, unmerged) only record the VoiceOver deferral.

**Next action:** Val decides whether A/B runs on `b643617` or on a new candidate pinned from current main. Choosing a new candidate also refreshes rows 12 and 14 on the tracker and here. Then Val runs A1–A8 and D1–D5.

---

### Totals

| Issue | Rows | Flips to checked | Flips to unchecked |
|---|---|---|---|
| #273 | 15 | 4 | 0 |
| #276 | 13 | 11 | 0 |
| #280 | 14 | 4 | 0 |
| #281 | 27 | 8 | 0 |
| **All** | **69** | **27** | **0** |

Conditional flips that depend on Val's decision, not on new work: #273 row 14 and #281 AC 12 (if `b643617` stays the candidate), and #281 step 5 (if output bounds are accepted in place of memory).

## Code Review checkbox reconciliation proposal (2026-11-01)

Basis: `origin/main` at `9ecccc9`. Evidence comes only from merged PRs, files on origin/main and issue comments. Open PRs #472 (CR-8 matrix refresh, CR-6/CR-7 live procedures), #477 (links after repo rename) and #481 (activity link controls) are **not** counted. Every box is currently unchecked on all seven issues. Nothing was written to GitHub.

Policy used: a box is proposed `[x]` only when its text is fully met by on-main evidence. If the owner's own receipt lists a still-open gate under that AC (original-reference comparison, human VoiceOver, live provider, live write), it stays `[ ]`. Rows marked *Borderline* are judgement calls worth a second look.

Total proposed flips: 66.

### #319 Tracker

**Current state:** CR-1 (#320) and CR-2 (#321) are closed and on main. Every CR slice's code is on main: CR-3 #367/#438/#464, CR-4 #393, CR-5 #395 via #404, CR-6 #396/#422/#426, CR-7 #410/#416, CR-8 test/doc PRs #372/#440/#441/#430. What's left is acceptance gates, all waiting on Val: the R1-R4 comparison (the originals are gone; re-captures need Val's decision), the VoiceOver pass, a repo for CR-6's live smoke, a disposable repo for CR-7's live canary, decisions 1/5/6/7 (C16/C81, C65, C07, C82), and when to remove the `modex.codeReview` packaged-build switch. Next action: land #472 (matrix refresh plus the live procedures), then Val answers the batched ask ([comment](https://github.com/TypeSafeAI/modex/issues/319#issuecomment-6558837152)).

Proposed flips: 2 of 10 to `[x]`; no unchecks (nothing is checked today).

| # | Checkbox (first 60 chars, verbatim) | Current | Proposed | Evidence / reason |
| --- | --- | --- | --- | --- |
| 1 | `#320 — scope/reference contract and fixtures accepted.` | [ ] | [x] | #320 closed `completed` 2026-10-20; contract+fixtures on main via #334 (`43d5b9c`); Val's decisions recorded on #320 ([comment](https://github.com/TypeSafeAI/modex/issues/320#issuecomment-6278869439)). Note: #320's own boxes are all still unchecked; closure is the acceptance evidence. |
| 2 | `#321 — authenticated read service accepted.` | [ ] | [x] | #321 closed `completed` 2026-10-21; read service on main via #366 (`eb93287`) + #354/#361; authenticated AC5 smoke `docs/reviews/2026-10-20-cr2-read-smoke.md`, re-run `A-main` (`docs/reviews/2026-10-22-cr8-acceptance-matrix.md` Environments). |
| 3 | `#322 — inbox/workspace accepted.` | [ ] | [ ] | #322 is open; AC1 reference comparison and AC4 human keyboard/VoiceOver remain open (`docs/reviews/2026-10-30-cr3-acceptance-resume.md` 'Still open'). |
| 4 | `#323 — overview/activity/sidebar accepted.` | [ ] | [ ] | #323 open; R1/R2 original comparison and human VoiceOver open (`docs/reviews/2026-10-23-cr4-overview.md` Acceptance mapping). |
| 5 | `#324 — revision-bound remote diffs accepted.` | [ ] | [ ] | #324 open; original R4 comparison, human VoiceOver, C65 Viewed decision open (`docs/status.md` CR-5 entry). |
| 6 | `#325 — native review and instructions accepted.` | [ ] | [ ] | #325 open; AC6 live native smoke not run (`docs/reviews/2026-10-28-cr6-native-review.md` 'Live evidence: None'); C82 undecided. |
| 7 | `#326 — explicit external actions accepted.` | [ ] | [ ] | #326 open; AC6 disposable-repo live canary not run (all CR-7 receipts: 'No live write was run'). |
| 8 | `#327 — integrated evidence and remaining manual gates review` | [ ] | [ ] | #327 open; refreshed matrix only in open PR #472; main's matrix is the 2026-10-22 historical baseline. |
| 9 | `R1–R4 reconstructed through real interactive states, with re` | [ ] | [ ] | Originals gone (Val, 2026-10-22, [#320 comment](https://github.com/TypeSafeAI/modex/issues/320#issuecomment-6352671890)); comparison deferred by Val 2026-10-28 (`docs/reviews/2026-10-28-cr3-acceptance.md` Step 3). No reviewed D-rows. |
| 10 | `Reviewer can reproduce the result; live, native, write and h` | [ ] | [ ] | Gates are honestly marked open in receipts, but the reconciled current matrix/reproduction page is only in open PR #472; main's matrix still says overview/diffs/review/writes 'not built'. |

### #322 CR-3 inbox/workspace

**Current state:** The host is on main (#367), as are the #349 re-review fixes, populated-pane scrolling (#438) and the populated journey captures (#464). The automated suites and the authenticated probe (6/6 on `f51ef7e`) pass. Still open: the original R1/R4 geometry comparison (AC1; Val deferred it on 2026-10-28), Val's human keyboard/VoiceOver run of the checklist (AC4), and a check of floating-composer clearance now that CR-6's composer exists (item 18). The sign-in retry has never been exercised live. Next action: Val runs `docs/reviews/2026-10-22-cr8-voiceover/checklist.md`.

Proposed flips: 11 of 14 to `[x]`; no unchecks (nothing is checked today).

| # | Checkbox (first 60 chars, verbatim) | Current | Proposed | Evidence / reason |
| --- | --- | --- | --- | --- |
| 1 | `Write failing navigation tests for authored/review-requested` | [ ] | [x] | #367 (`af49881`); `e2e/code-review-navigation.spec.ts` covers groups, search, link input, selection, tabs, back/forward/return (12 tests, AC2 cases named). |
| 2 | `Add the Code Review destination to the existing navigation. ` | [ ] | [x] | #367; navigation spec test 'no gh, signed out, offline, empty, denied and failed reads each say what happened, never an empty inbox (#322 item 2)'. |
| 3 | `Bind selection and pending responses to account + stable rep` | [ ] | [x] | #367; navigation spec AC2 tests (identical numbers across repos, slow search debounce, account switch drops answer); `e2e/code-review-regressions.spec.ts` identity x3; #438 retry ordering (`docs/reviews/2026-10-28-cr3-retry-repair.md`). |
| 4 | `Implement overview, Changes and split modes within existing ` | [ ] | [x] | #367 host + #393/#404 content; split geometry within crop offsets ([CR-3 checkpoint](https://github.com/TypeSafeAI/modex/issues/322#issuecomment-6290204541)); #438 scroll spec proves independent scroll containers populated. |
| 5 | `Support pointer and keyboard resizing with minimum usable wi` | [ ] | [x] | Reuses `PanelResizeHandle` (pointer, existing panel-resize spec); navigation keyboard test: Shift+Arrow resize persists across reload, 900x600 folds split and keeps every primary control inside the window. Borderline: monitor change only approximated by window resize. |
| 6 | `Wire local pin/unpin, copy canonical PR link and validated O` | [ ] | [x] | Navigation spec 'pin, copy and Open in GitHub use the canonical link ... nothing reaches local Discard (C24-C26, AC5)'; unavailable controls via `capabilities()`. |
| 7 | `Preserve logical focus across navigation and menu/popover di` | [ ] | [ ] | Focus/Escape/visible focus/reduced motion are evidenced (navigation spec emulates reducedMotion; a11y spec), but floating-composer clearance was never re-verified after CR-6's composer landed (#422), and the human keyboard/VoiceOver pass is open. |
| 8 | `Connect #321's real main-process read path and test cancella` | [ ] | [x] | #367 integrated CR-2 path; navigation account-switch test; `docs/reviews/2026-10-21-cr3-read-integration.md` (renderer receives no credentials); `A-main` probe. |
| 9 | `AC1: users reach the R1 and R4 workspace arrangements throug` | [ ] | [ ] | Fixture + authenticated evidence met, but the owners map the original R1/R4 geometry comparison to AC1 and mark it open (`docs/reviews/2026-10-30-cr3-acceptance-resume.md` AC table, Human column). |
| 10 | `AC2: rapid search/PR/account switching cannot reveal a stale` | [ ] | [x] | Navigation + regressions specs (identity, slow search, account switch, back/forward without re-read); authenticated probe check 3 on `f51ef7e` (`docs/reviews/2026-10-30-cr3-acceptance-resume.md`). |
| 11 | `AC3: list, overview, diff and file-tree scroll regions do no` | [ ] | [x] | #438 (`afec85b`) `e2e/code-review-scroll.spec.ts` at 1440x900 and 900x600 with populated panes; navigation keyboard test (persisted panes stay in window). |
| 12 | `AC4: keyboard-only operation works at 900×600 and 1440×900; ` | [ ] | [ ] | Automated keyboard half passes, but the human keyboard/VoiceOver pass (checklist `docs/reviews/2026-10-22-cr8-voiceover/checklist.md`) has no result row; original-reference captures cannot be calibrated (originals gone). |
| 13 | `AC5: existing local Changes, threads, tab persistence and ot` | [ ] | [x] | Regressions 'local Changes stay local'; full `pnpm test` + `pnpm test:e2e` exit 0 on `f51ef7e` (476 passed) in `docs/reviews/2026-10-30-cr3-acceptance-resume.md`. |
| 14 | `AC6: fixtures and an authenticated read-only navigation smok` | [ ] | [x] | Reported separately: fixture column vs authenticated probe 6/6 on `f51ef7e` (`docs/reviews/2026-10-30-cr3-acceptance-resume.md`); sign-in retry stated as synthetic-only. |

### #323 CR-4 overview/activity

**Current state:** The overview, activity, checks, stack and deployment provenance are on main (#393, provenance fixes in #404). The write slots are wired to CR-7 (#416). The fixture, adversarial and authenticated service evidence is in `docs/reviews/2026-10-23-cr4-overview.md`. Still open: the original R1/R2 comparison, human VoiceOver, an authenticated Electron render, and composer clearance with CR-6's composer. Avatars (C16/C81, decision 1) stay with Val. Open PR #481 (activity opening/comment link controls) and #477 (links after a repository rename) touch this surface. Next action: re-check composer clearance with CR-6's composer and land #481.

Proposed flips: 11 of 14 to `[x]`; no unchecks (nothing is checked today).

| # | Checkbox (first 60 chars, verbatim) | Current | Proposed | Evidence / reason |
| --- | --- | --- | --- | --- |
| 1 | `Add failing tests for R1/R2: title/status/author/branch meta` | [ ] | [x] | #393 (`6c40547`); `e2e/code-review-overview.spec.ts` (9 tests incl. stale/unavailable/partial variants); `docs/reviews/2026-10-23-cr4-overview.md`. |
| 2 | `Render PR descriptions/comments with the existing safe Markd` | [ ] | [x] | #393 reuses `Markdown.tsx`; overview spec 'hostile Markdown is inert'; regressions 'hostile content: PR text renders inert, and unsafe or look-alike links never resolve, open or navigate'. |
| 3 | `Build a paginated activity timeline with stable event IDs, e` | [ ] | [x] | #393: stable ids, generation fencing, dedupe, per-page retry, focus/scroll preserved on refresh (overview spec refresh/retry/bleed tests; evidence doc Implementation). |
| 4 | `Match the compact right sidebar and expandable check rows. S` | [ ] | [x] | #393: compact expandable checks via `summarizeChecks`; overview spec 'stale checks and unavailable collections do not become empty or current evidence'. |
| 5 | `Render a numbered PR stack only from an accepted, documented` | [ ] | [x] | #393: stack labelled inferred from equal base/head branches over a bounded complete list; branching/cycles/missing roots/capped reads refused; no mutation (evidence doc Implementation). |
| 6 | `Show deployment previews with provenance: a provider deploym` | [ ] | [x] | #393 deployments via fixed GitHub deployment/status GET endpoints, comment URLs labelled; #404 provenance fixes (`docs/status.md` integrated candidate entry). |
| 7 | `Place the activity comment composer and header edit/reviewer` | [ ] | [x] | #393 explicit callback slots, unavailable via capabilities; later wired by CR-7 (#416) and CR-6 (#422); design page 'Producer check (2026-10-24)'. |
| 8 | `Match the measured text width, whitespace, card density and ` | [ ] | [ ] | Measured against accepted numeric geometry only; originals gone so 'measured' density/width can't be confirmed; floating-composer clearance pre-dated CR-6's composer (evidence doc AC5: 'CR-6's future floating composer is not yet present'). |
| 9 | `AC1: R1 and R2 are reached by selecting and scrolling the sa` | [ ] | [ ] | Fixture journey reaches R1->R2 (#440, `docs/reviews/2026-10-28-cr8-journey-refresh.md`), but owner maps original R1/R2 comparison to AC1 as remaining (`docs/reviews/2026-10-23-cr4-overview.md` Acceptance mapping). |
| 10 | `AC2: pagination/refresh produces no duplicate activity, lost` | [ ] | [x] | Overview spec delayed page, partial refresh, page retry, focus/scroll, cross-PR bleed tests; model dedupe/completeness tests (evidence doc AC2). Live account switch not exercised (not required by AC text). |
| 11 | `AC3: stale/unknown checks, inferred stack links and comment-` | [ ] | [x] | Overview spec stale/unavailable variants; stack ambiguity/cycle service tests; provider vs comment-derived deployment tests (evidence doc AC3) + #404 provenance fix. |
| 12 | `AC4: hostile Markdown/HTML, unsafe URL schemes and misleadin` | [ ] | [x] | Overview spec hostile Markdown; regressions spec 'hostile content'; strict destination unit tests (evidence doc AC4). |
| 13 | `AC5: long titles, large descriptions and narrow windows rema` | [ ] | [ ] | Captures at 1766x1057 and 900x600 exist, but human VoiceOver remains open and composer clearance wasn't re-checked with CR-6's composer (evidence doc AC5 'Remaining'). |
| 14 | `AC6: all visible write controls are either connected to a ve` | [ ] | [x] | #393 shipped them unavailable; now connected to CR-7 capabilities (#416) with synthetic-gh Electron coverage (`e2e/code-review-actions.spec.ts` 14 tests). Borderline: 'verified' CR-7 capability is mock-verified only; live canary open on #326. |

### #324 CR-5 remote diffs

**Current state:** Revision-bound remote diffs are on main via #404 (from #395), with the merge-base repair. Parser, anchor, race, coverage, Discard-isolation and stress-bound tests all pass. An authenticated GET service smoke passed on #393. Only AC1 is unmet: it needs comparison against the original R4, which is missing. Human VoiceOver and the Viewed toggle (C65, decision 5) also stay open. Next action: Val decides on R4 references or re-captures, and on C65.

Proposed flips: 13 of 14 to `[x]`; no unchecks (nothing is checked today).

| # | Checkbox (first 60 chars, verbatim) | Current | Proposed | Evidence / reason |
| --- | --- | --- | --- | --- |
| 1 | `Write failing parser/model tests for multiple hunks, added/d` | [ ] | [x] | #395 via #404 (`e3527f4`); pure parser/anchor tests (multi-hunk, add/delete/rename, empty, no-newline, Unicode/space paths, binary/omitted/truncated) - `docs/reviews/2026-10-23-cr5-remote-diffs.md` Verification ledger. |
| 2 | `Define a revision-bound file identity and line anchor using ` | [ ] | [x] | Anchors = PrKey+PrRevision+path+side+line(+commitSha via #410); diff spec 'head change ... keeps the old anchor outdated'; merge-base repair `docs/reviews/2026-10-24-cr5-merge-base.md`. |
| 3 | `Extract or adapt the smallest pure rendering layer from the ` | [ ] | [x] | `Diff`/`FileIcon` moved to pure module, ChangesPanel re-exports; local keyboard/confirm/cancel Discard regressions before and after extraction (evidence doc). |
| 4 | `Render multiple file sections with compact headers, addition` | [ ] | [x] | Diff spec 'grouped diffs, both gutters, hierarchy, filter and keyboard selection', 'returning from Overview preserves ... overall scroll position'; #438 scroll spec. |
| 5 | `Fetch bounded extra context at the exact remote base/head re` | [ ] | [x] | Diff spec 'expanding context asks the exact remote revision and never a local file', cancellation/refund, wrong-commit refusal; production IPC test with unchanged checkout. |
| 6 | `Represent binary, unavailable, oversized and provider-trunca` | [ ] | [x] | Diff spec 'binary, omitted, oversized and truncated patches disclose missing coverage and provider counts'; GitHub fallback on caps (evidence doc Product bounds). |
| 7 | `Bound fetching, parsing and mounted content. Begin with lazy` | [ ] | [x] | Lazy per-file loading, 4 mounted bodies, enforced bounds in diff spec 1,000-file/3 MiB/token-dense tests with named-environment metrics (evidence doc 'Final local gate receipt'). |
| 8 | `Keep filenames/code inert and path-direction handling unders` | [ ] | [x] | Text rendered as React text, LTR isolation; diff spec 'line anchors have one keyboard entry per file' with 'New line N' labels; keyboard tree nav. Borderline: color-independence not separately asserted; VoiceOver is #327's gate. |
| 9 | `AC1: R4's overview-plus-grouped-diff arrangement, file tree,` | [ ] | [ ] | AC text requires 'match approved reference geometry'; original R4 missing (evidence doc 'Original R4 fidelity remains unverified'; `docs/status.md` CR-5 entry). |
| 10 | `AC2: parser and anchor fixtures prove correct old/new line r` | [ ] | [x] | Parser fixtures + Electron 'deleted ranges and renamed paths retain base anchors after context expansion', 'old-line anchors name the merge base' (#404). |
| 11 | `AC3: changing PR/account/head during a delayed patch request` | [ ] | [x] | Diff spec 'a new head cannot be overwritten by a delayed file page', 'changing PR during a delayed patch request drops the previous PR response', sign-out race; outdated anchors. |
| 12 | `AC4: no remote diff action can call local Discard, read an a` | [ ] | [x] | Local Discard regressions; remote trap handlers; regressions 'local Changes stay local'; production IPC test with unchanged checkout (evidence doc AC4). |
| 13 | `AC5: binary/omitted/oversized/truncated responses remain dis` | [ ] | [x] | Diff spec binary/omitted/oversized/truncated + closed-file omission + aggregate retention tests (evidence doc AC5). |
| 14 | `AC6: keyboard and narrow-window navigation work; measured st` | [ ] | [x] | Diff spec narrow/keyboard tests; enforced bounds (10 requests, 4 bodies, <25k nodes, heap <256 MiB, selection <3 s) with metrics on named M5 Max env (evidence doc final receipt). |

### #325 CR-6 native AI review

**Current state:** Phase 1 isolation (#396) and Phase 2 (#422) are on main, along with the exit-ownership repair (#426). Review is Claude-only under `--safe-mode --restricted --tools Read`, and the native denial fixture passes 6/6 (re-run on 2.1.316 per the 11-01 comment). Still open: AC6's authorized live native smoke, C82 (decision 7), and VoiceOver for R3. Next action: Val names `owner/repo#n` and says go, then the smoke runs per the procedure in #472.

Proposed flips: 13 of 14 to `[x]`; no unchecks (nothing is checked today).

| # | Checkbox (first 60 chars, verbatim) | Current | Proposed | Evidence / reason |
| --- | --- | --- | --- | --- |
| 1 | `Write failing tests for main-owned review context: account/r` | [ ] | [x] | #422 (`b643617`): `test/code-review-agent.test.ts` (15) covers account/repo/revision identity, coverage limits, instructions version, head moved, refusals (`docs/reviews/2026-10-28-cr6-native-review.md` Mock evidence). |
| 2 | `Recreate R3's keyboard-accessible popover using existing men` | [ ] | [x] | #422 R3 popover: agent spec 'instructions popover states its scope, saves a version on this Mac only'; each run records instruction version; journey R3 focus/Escape (#440). |
| 3 | `Build bounded context in main only after validating the requ` | [ ] | [x] | #422: main confirms account, reads repo/PR/files via GET transport, re-reads head/target, snapshot with omissions listed and untrusted framing (evidence doc 'What was built'). |
| 4 | `Feature-detect the installed native backend and verify its a` | [ ] | [x] | #396 isolation proof (`docs/reviews/2026-10-23-cr6-isolation.md`) + #422 fixed `REVIEW_CONFINEMENT_ARGS`, stripped env; native fixture 6/6 with production argv; Codex refused for review. |
| 5 | `Require an explicit user start with visible backend, context` | [ ] | [x] | #422: Start is the only trigger (agent spec 2), busy refusal, Stop, crash->unknown with no replay; #426 retains ownership until exit confirmed; provider disclosure added. |
| 6 | `Render findings through the existing conversation/evidence c` | [ ] | [x] | #422: findings bound to CR-5 `LineAnchor` only where in included head-side diff, else unverified; outdated on head move (agent spec 3). |
| 7 | `Scope PR questions and drafts to the correct account/PR conv` | [ ] | [x] | #422 agent spec 4 (question as own run, 'Add to chat'); records reload without second start (spec 2/5). |
| 8 | `Provide an explicit handoff of selected findings as a draft ` | [ ] | [x] | #422 'Add to review draft' -> CR-7 draft only; #441 integrated flow requires explicit preview/submit (`docs/reviews/2026-10-28-cr8-review-flow.md`). |
| 9 | `AC1: R3 popover opens/closes accessibly, clearly states inst` | [ ] | [x] | Agent spec 1 + journey R3 (focus on open, Escape returns focus, versioned save survives reload). Human VoiceOver for R3 tracked under #327. |
| 10 | `AC2: the context builder excludes wrong-account/repository d` | [ ] | [x] | Unit refusals for account change, head moved before/during reads, target change; agent spec 3 'Outdated · made for head ...' with no second start. |
| 11 | `AC3: adversarial PR content attempting tool execution, secre` | [ ] | [x] | Native fixture 6/6 with shipped argv: Bash/Write/WebFetch/MCP 'No such tool available', outside/symlink reads refused (evidence doc Native fixture); Codex disabled because its boundary failed. |
| 12 | `AC4: explicit start, streaming, stop, failure, unknown compl` | [ ] | [x] | Agent spec 5 (Stop, busy, SIGKILL relaunch -> unknown, two starts total); #426 unconfirmed-exit repair. |
| 13 | `AC5: omitted files and unsupported references are visible; n` | [ ] | [x] | Agent spec 2 coverage 'file list cut short'; unverified findings; 'A completed native turn is not proof' kept (design page CR-6 section). |
| 14 | `AC6: native-CLI fixture tests through the real app pass. Sep` | [ ] | [ ] | Fixture/native-fixture half passes, but no authorized live native-provider smoke has run (evidence doc 'Live evidence: None recorded'); procedure only in open PR #472. |

### #326 CR-7 review actions/merge

**Current state:** All three CR-7 increments (submit, merge, decisions 2-4) are on main via #416, with #410 anchors and the intents foundation via #404. They are mock and synthetic-gh tested, including at-most-once and unknown-outcome recovery. Still open: AC6's live canary on a disposable repo, and on-main evidence of draft visibility after sign-out. The canary procedure is in open PR #472. Next action: Val names a disposable repo and says go.

Proposed flips: 12 of 14 to `[x]`; no unchecks (nothing is checked today).

| # | Checkbox (first 60 chars, verbatim) | Current | Proposed | Evidence / reason |
| --- | --- | --- | --- | --- |
| 1 | `Write failing tests for explicit write intents scoped to cur` | [ ] | [x] | Intent model (#399 foundation, landed via #404) + #410 anchors + #416: `code-review-intents`/`-writes` tests; main re-reads account/permission/PR before preview and send (`docs/reviews/2026-10-25-cr7-write-submit.md`). |
| 2 | `Implement account/PR-scoped local drafts and an explicit pre` | [ ] | [x] | #416: account/PR-scoped drafts, preview/submit for comment and review, inline via LineAnchor, drafts kept on denial (actions spec 1-4). |
| 3 | `Wire title/body edits and reviewer requests only if included` | [ ] | [x] | #416 (incl. #415): edits refused if GitHub text changed, reviewer requests, permission/self-review refusals, no DELETE (`docs/reviews/2026-10-25-cr7-pr-actions.md`). |
| 4 | `Show the exact destination, account and requested action bef` | [ ] | [x] | Preview names account/destination/head (+frozen inline details, `docs/reviews/2026-10-26-cr7-write-repair.md`); moved head/target/permission spends the preview (actions spec, unit). |
| 5 | `Implement merge preflight from fresh GitHub state and server` | [ ] | [x] | #416 merge: fresh permission/methods/mergeable/rules read; blocked/unknown/queue -> unavailable with Open on GitHub (`docs/reviews/2026-10-25-cr7-merge.md`, `docs/reviews/2026-10-24-cr7-merge-preflight.md`). |
| 6 | `Send the expected head SHA with a supported merge request an` | [ ] | [x] | PUT carries `sha`=reviewed head; non-atomic limit documented (`docs/reviews/2026-10-24-cr7-merge-preflight.md` Limits); no queue enrollment/auto-merge (design page). |
| 7 | `Prevent duplicate local attempts with one in-flight intent a` | [ ] | [x] | Durable receipts, one in-flight intent, unknown after crash/timeout, no resend; actions spec double-click, SIGKILL, 502 'Check GitHub'/'Stop tracking'; GraphQL uncertainty repair. |
| 8 | `Reconcile the resulting comment/review/merge state with #321` | [ ] | [ ] | Reconcile/read-back and account-fenced replies are evidenced, but no on-main test of draft visibility after sign-out (intents receipt: 'Sign-out UI remains a future gate'); token-leak check script only in open PR #472. |
| 9 | `AC1: comments/reviews remain local until an explicit user su` | [ ] | [x] | Actions spec: drafts local until submit; 403 shown with fixed text, draft kept; main-side permission checks (write-submit receipt). |
| 10 | `AC2: two rapid clicks dispatch at most one request for the s` | [ ] | [x] | Actions spec double-click posts/merges once; SIGKILL mid-send restarts in doubt and sends nothing (write-submit, merge receipts). |
| 11 | `AC3: wrong-account/repository intents, stale heads, changed ` | [ ] | [x] | Unit: account/head/target rechecks, login change mid-submit, outdated base anchor; repair: inline destinations verified against fresh patch evidence. |
| 12 | `AC4: merge passes the reviewed head SHA, offers only support` | [ ] | [x] | Merge passes reviewed head as `sha`, only allowed methods, blocked rules -> Open on GitHub (actions spec merge tests). Classic-protection queue shows as GitHub refusal (merge receipt 'Open'). |
| 13 | `AC5: drafts survive recoverable errors, remain isolated acro` | [ ] | [x] | Draft-buffer tests (newer edit during held save, account clearing); unit 'no token text in any reply'; static guard: no `process.env`/token in write path. |
| 14 | `AC6: mock main/IPC and Electron tests cover success, rejecti` | [ ] | [ ] | Mock/IPC/Electron half met, but the separately authorized disposable-repo canary has not run (all CR-7 receipts; procedure only in open PR #472). |

### #327 CR-8 acceptance

**Current state:** On main: the 2026-10-22 matrix (historical baseline), the journey through R1-R4 (#372, #440, #464), cross-slice regressions, a11y/measure specs, the integrated review-flow fixture (#441) and the packaged-app harness (#430). The current matrix, staged enablement/rollback text and live procedures are only in open PR #472. Still open: reference comparison, VoiceOver, agreed perf budgets, a11y coverage of CR-4 to CR-7 controls (C76), seven controls without an asserting spec, and live provider/write evidence. Next action: land #472, then the test-only a11y fold-in (C76).

Proposed flips: 4 of 17 to `[x]`; no unchecks (nothing is checked today).

| # | Checkbox (first 60 chars, verbatim) | Current | Proposed | Evidence / reason |
| --- | --- | --- | --- | --- |
| 1 | `Build an acceptance matrix mapping every R1–R4 region/contro` | [ ] | [ ] | Main has only the 2026-10-22 historical matrix with 'pending/not started' rows for #323-#326; the refreshed matrix is in open PR #472. |
| 2 | `Make deterministic captures through the actual Electron appl` | [ ] | [ ] | Journey captures with manifest exist (#372/#440/#464) but original crop/scale calibration impossible (originals gone); not fully met. |
| 3 | `Reach R1 by navigation, R2 by scrolling, R3 by opening the i` | [ ] | [ ] | R1-R4 reached by real controls (journey after #440/#464), but no reference comparison or human review of differences (originals gone). |
| 4 | `Exercise a complete fixture journey: inbox → overview/activi` | [ ] | [x] | #441 (`eca2bd9`) `docs/reviews/2026-10-28-cr8-review-flow.md`: inbox -> overview/activity -> populated diff -> native fixture -> anchored finding -> draft -> preview -> mocked write -> restart reconciliation, one provider start, one POST. Borderline: context expansion not in that journey. |
| 5 | `Add integrated adversarial/race cases: wrong-account delayed` | [ ] | [ ] | Most cases exist across regressions/agent/actions specs, but #327 asks for an integrated set and the review-flow receipt says it 'does not replace the separate adversarial tests'; no on-main matrix shows every listed case covered. |
| 6 | `Verify keyboard navigation, visible focus, accessible labels` | [ ] | [ ] | Automated keyboard/contrast exist (a11y spec covers only CR-3 controls per [11-01 checkpoint](https://github.com/TypeSafeAI/modex/issues/327#issuecomment-6558836325)); human screen-reader pass not recorded. |
| 7 | `Measure representative and stress fixtures on a named enviro` | [ ] | [ ] | Measured (matrix Measurements; diff-spec bounds) but numerical regression budgets not agreed: `code-review-measure.spec.ts` 'No budget is enforced yet'. |
| 8 | `Run existing local Changes/discard, shell/tab, conversation,` | [ ] | [x] | Full `pnpm build && pnpm test && pnpm test:e2e` green on #441 and on `f51ef7e` (`docs/reviews/2026-10-30-cr3-acceptance-resume.md`); defects routed to owners (e.g. #464 populated-capture fix). |
| 9 | `Produce an evidence matrix with separate columns for Node/mo` | [ ] | [ ] | Column structure exists in main's matrix but it is historical (product `0e674e7`); current-SHA matrix only in open PR #472. |
| 10 | `Document staged enablement: read-only navigation/overview/di` | [ ] | [ ] | Staged enablement/rollback text exists only in open PR #472 (main matrix gate 8: 'waits until a capability beyond reads exists'). |
| 11 | `AC1: R1–R4 are reproduced by an interactive test journey in ` | [ ] | [ ] | Journey reaches R1-R4 in real Electron, but no approved visual differences/reference provenance recorded (originals gone). |
| 12 | `AC2: every in-scope visible control has behavioral evidence ` | [ ] | [ ] | [11-01 checkpoint](https://github.com/TypeSafeAI/modex/issues/327#issuecomment-6558836325): seven built controls have no asserting spec; matrix refresh in open #472. |
| 13 | `AC3: identity/revision isolation, injection resistance, inco` | [ ] | [x] | Regressions spec (identity x3, revision, incomplete data, hostile content, local Changes); agent spec integrated review + crash/unknown; actions spec at-most-once/unknown recovery - all on main. |
| 14 | `AC4: local Changes, navigation and native conversation/appro` | [ ] | [x] | Hosted `unit + e2e (macOS)` required check gates every main merge; local full green on `f51ef7e`; no open Code Review regression. Borderline: 11-01 local full e2e exit 1 (non-CR `app.spec.ts:729`). |
| 15 | `AC5: measured performance and keyboard/contrast checks have ` | [ ] | [ ] | Keyboard/contrast evidence only for CR-3 controls; measurements on `0e674e7` predate built overview/diff; screen-reader gate is open (allowed) but the rest is partial. |
| 16 | `AC6: the final matrix separates fixture, authenticated, live` | [ ] | [ ] | 'Final matrix' not on main (open PR #472). |
| 17 | `AC7: a reviewer can reproduce the result from the documented` | [ ] | [ ] | Main's matrix readiness statement is stale ('Overview, diffs, review and writes are not built'); reproducible readiness page only in open PR #472. |

## Local models (#376) checkbox reconciliation proposal — 2026-11-01

Evidence baseline: `origin/main` at `9ecccc9bcea42ec99cd76092b1fe3bec15d05775` (fetched 2026-11-01).
LM deliveries on main: #397/#400/#405 (LM-1), #403 `e17aebd` (LM-2, carries #398/#402), #418 (LM-2 credential repair),
#423 `c23e6be` (LM-3 + LM-5 slice 1 / #424), #447 `eb025e8`, #448 `ba8f289`, #461 `4d12737`, #462 `7eec3bf`, #465 `8412ce4`.

**Not on main:** PR #475 (`lm5-fixtures`, open, head `7cc5713`: LM-5 fixture AC1 compaction, AC3, AC4, AC5, `stream_max_retries=0`,
allow-list entry filter). PR #480 merged **into `lm5-fixtures`**, not into main, so it is also not on main. #417 and #419 were closed
unmerged; their content reached main through #423.

Main still does not construct `LocalExecution` (status.md line 74; `test/local-execution-wiring.test.ts`), there is no LM-4 UI,
and no real local generative model has been run (Ollama has none; LM Studio has only an embedding model).

Every box in scope is currently unchecked except #376's `#377` row. **No currently-checked box needs unchecking.**

---

### #376 — Tracker

| Checkbox (first ~60 chars) | Current | Proposed | Evidence / reason |
|---|---|---|---|
| #377 — contract and real native feasibility accepted. | [x] | [x] | #377 closed; Gate A accepted https://github.com/TypeSafeAI/modex/issues/377#issuecomment-6382280214; `docs/reviews/2026-10-24-lm1-acceptance.md`; status.md line 287 |
| #378 — secure connections/discovery accepted. | [ ] | [ ] | Code on main (#403), but #378 open and not accepted; real-runtime discovery never run (#378 comment 6387862044) |
| #379 — native local execution and profile/session isolation accepte | [ ] | [ ] | #423 on main but AC1 live, AC4 and AC6 (managed Mac) open; not admitted |
| #380 — no-cloud-fallback, context/capacity and recovery accepted. | [ ] | [ ] | AC1/AC3/AC4/AC5 fixture work only in open #475; AC2 not run |
| #381 — integrated UI and supported paired-client behavior accepted. | [ ] | [ ] | LM-4 not started |
| #382 — broad-runtime compatibility evidence accepted. | [ ] | [ ] | LM-6 not started |
| #383 — integrated evidence, documentation and supported-scope readi | [ ] | [ ] | LM-7 not started |
| Every core child links its implementation PR and criterion-level evid | [ ] | [ ] | #381/#382/#383 have no implementation PR |
| A real local edit/test task preserves native authority, actual diff/c | [ ] | [ ] | Only scripted loopback server runs (LM-3 review); no real local model |
| Connection/model identity remains safe through persistence, endpoint | [ ] | [ ] | Main-side fixtures exist (#403, #423), but "supported paired clients" part is LM-4/LM-7, not done |
| No implicit cloud inference or auxiliary disclosure occurs in the qua | [ ] | [ ] | Partial: #461/#447 on main; compaction/failure-path evidence only in #475; no qualified local policy exists yet |
| Runtime/model/tool-parser/context/native-CLI versions and unsupported | [ ] | [ ] | Only LM-1 Strata combination recorded; no LM-6/LM-7 matrix |
| Existing cloud/native regressions pass; native/hardware/human gaps re | [ ] | [ ] | Per-PR suites pass, but no integrated candidate run (LM-7) |
| Documentation and site claims match the tested scope. Rollback preser | [ ] | [ ] | No user-facing/site docs or rollback evidence (LM-7) |

**Current state.** LM-1 is accepted and closed. LM-2 (#403), LM-3 (#423) and four LM-5 slices (#447, #448, #461, #462, #465) are on
main as main-only code with no UI, and product admission is still off (`LocalExecution` is not constructed). LM-4, LM-6, LM-7 and LM-8
have not started. Gate B needs LM-4 plus live evidence, and no local coding model is installed. **Next action:** Val reviews #475
(LM-5 fixtures, now including #480) and answers the LM-5 admission brief on #380
(https://github.com/TypeSafeAI/modex/issues/380#issuecomment-6558687340), including whether a local coding model will be installed
for the live gates.

---

### #378 — LM-2 secure connections and bounded discovery

| Checkbox (first ~60 chars) | Current | Proposed | Evidence / reason |
|---|---|---|---|
| Add explicit Ollama, LM Studio and Custom Responses connection settin | [ ] | **[x]** | #403 `e17aebd`: `engine/local-models/connections.ts` (profiles in `app/local-connections.json`), loopback only; `docs/reviews/2026-10-22-lm2-connections-discovery.md` "What was built". (The UI for these settings is LM-4 scope.) |
| Validate IPC sender, request schema, connection ownership/revision an | [ ] | **[x]** | #403: `endpoint-policy.ts`, `service.ts` (`localOnly` channel); LM-2 review AC2 (IPv4/IPv6 forms, credentials in URL, injection, redirects, DNS re-check with zero fixture hits, forged IPC shapes); env-proxy regression ("LM-1 adoption" section) |
| Store optional local-server credentials with the existing encrypted s | [ ] | **[x]** | #403 versioned `SecretStore` entries; LM-2 review AC3 + "Review fixes" P1/P2; #402 hardening (token in label/manual ID refused); #418 `docs/reviews/2026-10-26-lm2-credential-repair.md` |
| Fetch bounded runtime metadata with deadlines, cancellation, bounded | [ ] | **[x]** | #403 `discovery.ts`; LM-2 review AC1 (delayed/timeout/oversized), AC4 (stale/cancelled); whole-discovery deadline fix (#402, carried in #403; #378 comment 6381184104); manual IDs AC5 |
| Represent generative, embedding, decision and other model types accur | [ ] | **[x]** | LM-2 review AC5 (embedding-only, `other`, Ollama cloud-routed unselectable); `shared/local-connections.ts` `locality: "cloud" \| "unverified"`; advertised ≠ qualification; main-side refusal #465 |
| Opening Settings or refreshing must not install a runtime, download w | [ ] | [ ] | No-install/no-load part is met (LM-2 review AC6, exact request lists). The second sentence ("Explain separately that an explicit user-started inference turn may cause … cold load") has no text on main: `git grep -i 'cold.?load'` finds nothing in apps/ or docs/. Partial. |
| Define profile edit/delete behavior: revision changes invalidate stal | [ ] | **[x]** | LM-2 review AC4/AC6 (stale results, tombstones keep history); #462 clears advertised context on edit/delete; #423: `LocalExecution.backend()` snapshots the thread and `validate` runs on every send requiring the exact revision (`docs/local-models.md` §LM-3 Admission) |
| AC1: normal, empty, malformed, unavailable, authenticated and delayed | [ ] | **[x]** | LM-2 review AC1: `test/local-model-discovery.test.ts`, `local-model-endpoint.test.ts`, `local-model-ipc.test.ts`, `e2e/local-models-ipc.spec.ts`; exact request lists show no inference routes |
| AC2: non-loopback, URL injection, IPv4/IPv6 normalization, DNS/redire | [ ] | **[x]** | LM-2 review AC2 (fixtures + forged IPC shapes; channel kept off the paired-desktop map) |
| AC3: tokens are absent from renderer state, URLs, diagnostics, snapsh | [ ] | [ ] (borderline) | Evidence covers IPC replies, profiles file, secrets plaintext, failure text, labels/manual IDs, reflected IDs (LM-2 review AC3, #402, #418) and "cloud credentials never forwarded" (`typesafe_api_key` fixture). No recorded test for **diagnostics, snapshots or exported records** surfaces. Check only if the maintainer accepts that no such surface carries local-connection data today. |
| AC4: identical model IDs on different connections remain distinct tar | [ ] | **[x]** | LM-2 review AC4 (distinct `{connection, id}`; superseded/cancelled/post-edit reads return `stale`); #402 stale checks after every edit kind |
| AC5: custom/manual IDs remain available for explicit compatibility te | [ ] | **[x]** | LM-2 review AC5; #465 also refuses embedding/non-generative in `LocalExecution.validate` |
| AC6: discovery causes zero installs/downloads/model loads/port scans; | [ ] | **[x]** | LM-2 review AC6 (every fixture asserts exact request list; no pull/load/unload routes; old revisions never resolve; tombstones); existing-run snapshot via #423 (`execution.ts` `backend()` structuredClone + per-send validate) |

**Current state.** All of LM-2's main-side code landed in #403 (plus #418's credential repair) with fixture and real-Electron IPC
evidence. Accepted contract consumed; AGENTS.md metadata approval recorded. Remaining: the cold-load explanation text (likely
belongs with LM-4 Settings copy), explicit evidence for diagnostics/export surfaces for AC3, listing-only discovery against a real
Ollama/LM Studio with a generative model (needs an installed model and Val's authorization), and Val's acceptance of #378.
**Next action:** when a local generative model exists, run listing-only discovery against it and record it in
`docs/reviews/2026-10-22-lm2-connections-discovery.md`; meanwhile, decide whether AC3 needs an export/diagnostics regression.

---

### #379 — LM-3 isolated native Codex profiles

| Checkbox (first ~60 chars) | Current | Proposed | Evidence / reason |
|---|---|---|---|
| Generate validated per-child Codex configuration through the existing | [ ] | **[x]** | #423: `execution.ts` builds child args/env, provider `modex_local` (nonreserved), token only in `MODEX_LOCAL_TOKEN`; effective config read back via `config/read` and gated (#424, `run-policy.ts`); `docs/local-models.md` §LM-3 Isolation, §LM-5 slice 1 |
| Keep coding execution in `codex app-server`. Modex may discover bound | [ ] | **[x]** | #423: turns run only through `CodexBackend`/`codex app-server`; no catalogue needed (wire receipt: model "unlisted, no catalogue"); `docs/reviews/2026-10-26-lm3-local-codex.md` "Real CLI, scripted server" |
| Replace singleton assumptions only where necessary with lazy native i | [ ] | **[x]** | #423: one child per thread keyed by connection revision (moves with token/address), model, context, cwd; service-keyed slot for capacity (`execution.ts` `acquire`); `docs/local-models.md` §LM-3 Isolation |
| Bind each turn and resume handle to immutable connection/model/runtim | [ ] | **[x]** | #423: handle refused unless the child opened it, fresh native conversation on target change, no prompt re-send; LM-3 review AC3 row |
| Audit inherited configuration, managed policies, auth, redirects and | [ ] | **[x]** | #423/#424: private home, env allowlist, `NO_PROXY=*`, project `.codex` refused, managed/project layers refused by name; redirect behavior audited and recorded (`docs/reviews/2026-10-27-lm5-destination-policy.md`). The live managed-Mac run is an AC6 gate, not this step. |
| Preserve native approvals, sandbox modes, observations, tool results, | [ ] | **[x]** | #423: native approvals/questions/Stop kept; force-stop ends only the thread's child (LM-3 review AC2 row); `docs/local-models.md` "What a local turn does not get" |
| Send effort, reasoning-summary, fast-tier, vision and tool settings o | [ ] | **[x]** | #423: effort/fast/service tier/reasoning summary not sent, Plan and images refused, no cloud login required, no cloud fallback (LM-3 review AC5 row, "Review repair 2026-10-27") |
| AC1: a selected local model completes a real tool/edit/test fixture t | [ ] | [ ] | Human/live gate not run: only a scripted loopback server (LM-3 review AC1 row "Human gate"); no local coding model installed |
| AC2: simultaneous cloud/local profiles share neither credentials nor | [ ] | **[x]** | LM-3 review AC2 row (fixtures: private home, env allowlist, no `OPENAI_API_KEY`/proxy, force-stop reaches one child; runner: local turn binds no account) |
| AC3: profile edits, credential rotation and process restart cannot re | [ ] | **[x]** | LM-3 review AC3 row (rotation moves revision; new `LocalExecution` refuses persisted handle; no path re-sends a prompt) |
| AC4: existing cloud/native regression tests pass and global user conf | [ ] | [ ] | Regressions pass (LM-3 review "Checks"), but "global configuration unchanged" is asserted by design only ("nothing writes `~/.codex`"); no recorded before/after byte comparison of the user's global config |
| AC5: unsupported options are omitted or explicitly rejected; tool suc | [ ] | **[x]** | LM-3 review AC5 row (fixtures + wire receipt; tool outcome from Codex item status) |
| AC6: inherited config, proxy/redirect and native-plan override cases | [ ] | [ ] | LM-3 review AC6 "Partly"; #424 adds refusal, but managed-policy precedence was never exercised on a managed Mac (#380 admission brief "Not run") and redirects are recorded, not prevented; product admission closed pending this |

**Current state.** LM-3's implementation landed through #423 (`c23e6be`) with fixture and real-CLI (scripted server, codex 0.164.0;
0.166.0 re-run only in #475) evidence; it is not wired into the product. Remaining: the live AC1 turn on a real local model, a
recorded global-config byte check (AC4), a managed-Mac policy run and Val's decision on redirect risk (AC6), and product admission.
**Next action:** add a before/after byte check of `~/.codex/config.toml` to the wire/native test (cheap AC4 closure), then the live
AC1 run once Val names a server and model.

---

### #380 — LM-5 privacy, capacity/context and recovery

| Checkbox (first ~60 chars) | Current | Proposed | Evidence / reason |
|---|---|---|---|
| Make no-cloud-inference-fallback a main-process invariant covering ti | [ ] | [ ] | Mostly on main: #423 (no cloud routing on failure), #461 (credit fallback, naming, routines), #448 (subagents off). **Compaction** governance and its wire evidence, and `stream_max_retries=0`, are only in open #475. Partial. |
| Keep Jev network routing/approval calls off for local-only runs; reta | [ ] | **[x]** | #461 (`Decisions.connect` refuses local thread), #447 (deterministic local approvals, human fallback); #423 private home loads no MCP/plugins, web search off; #424 governs tools/plugins via `config/read`. Reviews: `2026-10-30-lm5-local-only-chokepoints.md`, `2026-10-30-lm5-auxiliary-dispatch.md` |
| Distinguish approved loopback endpoint, locally executed inference an | [ ] | **[x]** | `shared/local-models.ts:99` locality `unverified \| local-inference-observed \| offline-verified`; #465 refuses known cloud-routed models; unmarked stays unverified (`docs/local-models.md` §known cloud-routed); AGENTS.md lists update/account traffic separately; loopback-not-locality documented (§LM-3 Evidence, §LM-5 slice 1) |
| Use runtime effective context where available. Show advertised maximu | [ ] | [ ] | #462 keeps configured/effective/advertised/loaded apart and refuses above advertised max. But "Show" has no UI (LM-4), and "native compaction must stay local" evidence is only in #475. Partial. |
| Default to one active Modex inference run per normalized local servic | [ ] | [ ] | Slot per loopback port (#423 `execution.ts` `acquire`), cancellable wait, subagents disabled (#448). Missing: "explicit status" while queued (the wait emits nothing, only an abort error), and the two-profile/zero-request evidence is in #475. Partial. |
| Handle cold start, missing model, OOM, context overflow, invalid tool | [ ] | [ ] | Failure-mode wire evidence and the 500-message/retry repairs are only in open #475; real-runtime outcomes not run |
| Enforce the same policy at desktop IPC, paired-desktop/phone, routine | [ ] | [ ] | Routine refusal on main (#461); full entry-point trace and allow-list filter are only in #475; remote-send policy is an open Val decision (admission brief Q3) |
| AC1: network spies/fixture sinks observe no cloud inference, Jev, rem | [ ] | [ ] | #447/#461 spies on main; compaction (remote-compaction part) evidence only in #475 |
| AC2: each combination claimed offline completes a pre-provisioned net | [ ] | [ ] | Not run; needs authorization and an installed coding model |
| AC3: two profiles addressing the same service honor Modex capacity; c | [ ] | [ ] | Fixture evidence only in #475; subagent half on main (#448) |
| AC4: overflow/OOM/restart/Stop yields truthful failed/interrupted/unk | [ ] | [ ] | Wire evidence only in #475; real-runtime run not done |
| AC5: main validates local-only policy for companion/routine/backgroun | [ ] | [ ] | Only in #475 (allow-list for this Mac's window) |
| AC6: effective-context evidence/override is recorded; unknown values | [ ] | **[x]** | #462 `7eec3bf`: provenance `{configured, source:"person", effective, advertised\|"not-checked", loaded:"unknown"}`, four guards with negative controls (`docs/reviews/2026-10-30-lm5-context-evidence.md`, which does not list AC6 as open); network-locality limits explicit (redirect recorded in #424 review; unverified locality #465) |

**Current state.** On main: destination/managed-policy admission (#424 via #423), auxiliary chokepoints (#461, #447), subagent
admission (#448), context provenance (#462) and cloud-routed refusal (#465). PR #475 (with #480 folded in) holds fixture-level AC1
compaction, AC3, AC4, AC5 and the retry repairs, and is in review. Not run: AC2 offline canary, real-runtime AC4, AC1 live.
**Next action:** Val reviews and merges #475 and answers the admission brief; after merge, re-run this reconciliation, since several
rows (step 1, step 6, AC1, AC3, AC4, AC5) could then move to fixture-complete. AC2 and real-runtime AC4 stay human/native gates.

---

### #381 — LM-4 capability-aware interface

| Checkbox (first ~60 chars) | Current | Proposed | Evidence / reason |
|---|---|---|---|
| Add Settings → Local models: connect, refresh, inspect connection/m | [ ] | [ ] | Not started; status.md says "No UI (LM-4)" |
| Extend the current model menu with connection grouping, search and ex | [ ] | [ ] | Not started |
| Render unverified, tested-for-recorded-configuration and unsupported | [ ] | [ ] | Not started |
| Display inference location separately from the existing Local/Worktre | [ ] | [ ] | Not started |
| Enable images, reasoning, structured controls and other options only | [ ] | [ ] | Not started (main refuses images/Plan for local, but no UI gating) |
| Retain existing themes, minimum-window behavior, accessible labels, f | [ ] | [ ] | Not started |
| Paired desktops/phones display the host doing inference rather than i | [ ] | [ ] | Not started |
| AC1: through actual controls, a user adds a connection, discovers/sel | [ ] | [ ] | Not started |
| AC2: unsupported actions have explanations; failed tests, unreachable | [ ] | [ ] | Not started |
| AC3: switching threads/profiles during delayed refresh preserves draf | [ ] | [ ] | Not started |
| AC4: keyboard/minimum-window flows work in real Electron; screenshots | [ ] | [ ] | Not started |
| AC5: desktop and supported paired clients agree on host/model provena | [ ] | [ ] | Not started |
| AC6: existing cloud model selection, Local/Worktree controls and conv | [ ] | [ ] | Not started |

**Current state.** Nothing landed; the only comment is the 2026-10-23 prompt refresh. The main-side backends it needs (LM-2
discovery IPC, LM-3 `localTarget` patch, LM-5 refusals) are on main, but `LocalExecution` is not constructed, so a UI could not run a
turn yet. **Next action:** after Val's admission decision on #380, start fixture-driven Settings → Local models against the existing
`local-models:command` channel.

---

### #382 — LM-6 broader Responses-runtime qualification

| Checkbox (first ~60 chars) | Current | Proposed | Evidence / reason |
|---|---|---|---|
| Add lightweight llama.cpp/vLLM presets and retain the manual Custom R | [ ] | [ ] | Not started; LM-2 review explicitly leaves llama.cpp/vLLM presets to LM-6 |
| Verify the actual Responses endpoint and native harness tool forms: s | [ ] | [ ] | Not started |
| Record model revision/build or digest where exposed, quantization, te | [ ] | [ ] | Not started |
| Document server-side prerequisites and actionable remedies without do | [ ] | [ ] | Not started |
| Let other runtime-served models qualify through the same contract wit | [ ] | [ ] | Not started |
| When a concrete upstream defect blocks an otherwise supported route, | [ ] | [ ] | Not started |
| AC1: at least one exact combination for every runtime advertised as s | [ ] | [ ] | Not started |
| AC2: a chat-only API, embedding model and missing-tool model are clas | [ ] | [ ] | Embedding classification exists (LM-2 AC5, #465), but chat-only/missing-tool classification not done |
| AC3: arbitrary custom model IDs work without code edits when the endp | [ ] | [ ] | Manual IDs selectable (LM-2), but no endpoint/tool contract qualification |
| AC4: no new coding SDK, inference protocol bridge, engine-specific to | [ ] | [ ] | True of main so far, but it is an LM-6 completion property; check at LM-6 delivery |
| AC5: template/parser/context/model/runtime/CLI changes make previous | [ ] | [ ] | Not started |

**Current state.** Not started (one 2026-10-23 refresh comment). Blocked on #380 acceptance and on having real runtimes/models.
**Next action:** none until LM-5 lands and a runtime/model is available; presets could be prepared as fixture-only work.

---

### #383 — LM-7 integrated evidence and compatibility matrix

| Checkbox (first ~60 chars) | Current | Proposed | Evidence / reason |
|---|---|---|---|
| Design the golden and negative fixtures once #377 is accepted. Map ev | [ ] | [ ] | Not started (#377 accepted 2026-10-24, so this is now unblocked) |
| Exercise Settings → choose local connection/model → native plan/r | [ ] | [ ] | Not started; needs LM-4 |
| Cover same model name on different endpoints, credential/profile chan | [ ] | [ ] | Producer-level fixtures exist (LM-2/LM-3) but no integrated suite |
| Exercise supported paired desktop/Store/iPhone display and main admis | [ ] | [ ] | Not started |
| Keep normal PR CI offline and GPU-free through existing fake-CLI/loop | [ ] | [ ] | Producer tests are loopback-only and native tests opt-in (`MODEX_LM3_WIRE/LIVE`), but there is no LM-7 suite to hold to this |
| Record OS/architecture, app SHA, native CLI/runtime/model versions, t | [ ] | [ ] | Not started |
| Document setup, tested coverage, no-cloud-fallback scope, network/off | [ ] | [ ] | Not started (`docs/local-models.md` is the developer contract, not setup/rollback docs) |
| Run existing cloud/native, account, approval, worktree, Changes, Note | [ ] | [ ] | Not started; no pinned integrated candidate |
| AC1: the golden workflow is verified through real Electron/main/nativ | [ ] | [ ] | Not started |
| AC2: protocol/unit, app fixtures, real runtime, network-denied and hu | [ ] | [ ] | Not started |
| AC3: each advertised supported combination has versioned native evide | [ ] | [ ] | Not started |
| AC4: fresh required build/test/E2E results name the candidate SHA, wi | [ ] | [ ] | Not started |
| AC5: no silent cloud fallback, unintended action replay, cross-profil | [ ] | [ ] | Not started |
| AC6: supported paired clients preserve target/provenance/authority an | [ ] | [ ] | Not started |
| AC7: setup and rollback are reproducible, existing cloud behavior reg | [ ] | [ ] | Not started |

**Current state.** Not started (one 2026-10-23 refresh comment). Fixture/test design is unblocked since #377 was accepted.
**Next action:** draft the criterion-to-evidence map (fixture / app / real-runtime / network-denied / human columns) for #378–#382
from the existing review receipts.

---

### #384 — LM-8 optional experimental Claude local route

| Checkbox (first ~60 chars) | Current | Proposed | Evidence / reason |
|---|---|---|---|
| Recheck [Anthropic gateway support boundaries](https://code.claude.co | [ ] | [ ] (borderline) | misterespresso's Slice 1 finding (https://github.com/TypeSafeAI/modex/issues/384#issuecomment-6390965181) rechecks Anthropic, Ollama and LM Studio docs with retrieval date, CLI/Ollama versions and a disagreement table. It meets the step's wording, but it is an unreviewed contributor comment, not on main, and the scope question in 6390714922 has no maintainer answer. Check only if the maintainer accepts the comment as the record. |
| Before exposing execution, prove a real native stream-json/tool/appro | [ ] | [ ] | Slice 2 proposed only; not run |
| Audit every model destination, including helper, title, follow-up, de | [ ] | [ ] | Desk analysis only (F3/F4 in the comment); no network capture |
| Remove conflicting inherited endpoint switches/provider credentials f | [ ] | [ ] | Not implemented (F1/F2 identify the gap in `health.ts` `cliEnvironment`) |
| Reuse current Stop, permission requests, event identity/mapping and r | [ ] | [ ] | Not started |
| Keep default cloud Claude sessions unchanged and scope process/sessio | [ ] | [ ] | Not started |
| AC1: the route is explicitly experimental and records the exact teste | [ ] | [ ] | No route exists |
| AC2: native tool/approval/Stop behavior and every auxiliary model des | [ ] | [ ] | Not run |
| AC3: unsupported or unverified configurations cannot appear productio | [ ] | [ ] | No route exists |
| AC4: this issue's state does not block #383 or the core release; it r | [ ] | [ ] | True by policy (#376 "Optional, not part of core closure"), but "retains independent evidence and activation decision" has no deliverable yet |
| AC5: credentials do not enter renderer/logs/exports; cloud account se | [ ] | [ ] | No route exists; F1 shows the current env would not satisfy it |

**Current state.** Optional, off the critical path. An external contributor (misterespresso) posted a Slice 1 documentation finding
and asked whether the scope works; nobody has answered (also flagged as decision 5 in the #380 admission brief). Nothing is on main.
**Next action:** Val or a maintainer answers misterespresso's scope question (6390714922) and decides whether Slice 1 counts as the
recorded recheck.

---

### Summary of proposed flips

- #376: none (keep the #377 row checked).
- #378: check 11 of 13: steps 1, 2, 3, 4, 5, 7 and AC1, AC2, AC4, AC5, AC6. Keep unchecked: step 6 (no cold-load explanation) and AC3 (borderline: no diagnostics/export evidence).
- #379: check 10 of 13: steps 1–7 and AC2, AC3, AC5. Keep unchecked: AC1 (live), AC4 (no global-config byte check), AC6 (managed-Mac/redirect).
- #380: check 3 of 13: step 2 (Jev/MCP/plugins off), step 3 (locality distinctions), AC6 (context provenance, #462). The rest wait on #475 or are native/human gates.
- #381, #382, #383: none (not started).
- #384: none (step 1 borderline via misterespresso's comment).
- No unchecks proposed.

