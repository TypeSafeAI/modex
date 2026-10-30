# CF-7 close-out evidence, 2026-10-29

Issue: #280 (parent #273). This receipt gathers what landed for CF-7, re-runs its checks on current
`main`, and prepares the one thing the issue lists as separate acceptance evidence: a real task and its
saved Note, for Val's review. Nothing here is ticked on Val's behalf.

## Candidate and scope

- `main` at `eca2bd98e2621bc795e3f8a46b1f109f2d73ca01` (#441), fetched on 2026-10-29. CI on that commit
  is green (`unit + e2e (macOS)`, iPhone companion, Code Quality).
- Owned worktree/branch: `cf7-closeout`, cut from that commit; `scripts/worktree.sh check` passed.
- Machine: Mac17,6 (Apple M5 Max, 18 cores, 128 GiB), macOS 27.0.1 (26A434), Node v24.22.0, pnpm 10.34.5.
- CLIs on the machine: Claude Code 2.1.312 (`~/.local/bin/claude`), codex-cli 0.164.0 (`/opt/homebrew/bin/codex`,
  signed in with ChatGPT).
- This PR changes documentation only. No source, test or fixture changed.

## What landed, by PR

Every CF-7 slice is on `main`, signed and through the merge queue. None is released.

| PR | Merged | What |
| --- | --- | --- |
| #289 | `f6976df`, 2026-10-18 | Plan card from Codex `turn/plan/updated` and Claude `TodoWrite`; the turn task record (`shared/task-context.ts`); Save to Notes through the project-scoped writer; `e2e/task-to-notes.spec.ts`; `docs/task-context.md` |
| #312 | `f4cd67f`, 2026-10-19 | Clarifications in the record and the note, secrets hidden, unanswered ones said; `e2e/plan-clarification.spec.ts` |
| #351 | `d1902d2`, 2026-10-20 | Verification: a known check after the last change, stale after later edits; never model prose |
| #355 | `3e416ab`, 2026-10-21 | Files touched (the context map), at most 20 shown with an overflow count, outside paths counted not named |
| #360 | `44524dc`, 2026-10-21 | Context paths resolved from command cwd; project boundary normalization |
| #363 | `462927b`, 2026-10-21 | Task Notes moved across projects are preserved; a replacement is saved in the originating project |
| #368 | `0e674e7`, 2026-10-21 | Unambiguous shell receipts only: masked failures, mixed writes and dynamic expansion cannot verify |
| #370 | `68860a0`, 2026-10-23 | Step linking retired by Val (neither CLI reports the link; nothing is inferred) |
| #375 | `71446cd`, 2026-10-23 | A saved task note reopens as a read-only task view; edits and moves since the save are said |
| #387 | `584aa1a`, 2026-10-23 | Claude plans decision after `TodoWrite` left Claude Code 2.1.308 |
| #390 | `2824ed7`, 2026-10-23 | Live codex-cli 0.163.0 captures as fixtures; questions asked in a reply; turns Codex never ends |
| #391 | `203a350`, 2026-10-23 | A turn says when its CLI reported no plan |
| #394 | `70123b9`, 2026-10-24 | Claude's `TaskCreate`/`TaskUpdate` and Codex's plan-mode `plan` item from live captures; Stop never recorded as completed |

## Checks on `main` at `eca2bd9`, this session

Focused, before anything else, from the built `dist/test` and `e2e`:

| Suite | Result |
| --- | --- |
| `test/task-context.test.ts`, `test/claude-live-capture.test.ts`, `test/codex-live-capture.test.ts` | 40 passed, 0 failed |
| `test/codex-native-plan.test.ts` | 6 passed, 0 failed |
| `e2e/task-to-notes.spec.ts` (6), `e2e/plan-clarification.spec.ts` (1), `e2e/codex-native-plan.spec.ts` (1) | 8 passed, 0 failed, 21.3 s |

Full workspace run, `pnpm build && pnpm test` then `pnpm test:e2e`, first pass: see
[Full run](#full-run-pnpm-test-and-pnpm-teste2e) below.

## Acceptance criteria, with evidence

| AC | Evidence | State |
| --- | --- | --- |
| 1. One request shows a plan with bounded file/test references, explicit provenance and stable plan/step IDs where supplied | Plan card and record (#289); files touched at most 20 with an overflow count, "as the CLI reported them", outside paths counted (#355, #360); step IDs only where the CLI gives them: Claude `TaskCreate` ids (#394); Codex plan steps carry positions only, and the record says so. Unit: "plan updates are revisions of one plan…", "the context map lists the files a turn changed, read and searched…", "the note lists at most the first files…". E2E: `task-to-notes` cases 1 and 4 | Verified (fixtures and live captures) |
| 2. Unsupported native plan capability has a readable honest fallback; viewing or approving a plan does not bypass execution policies | "Claude Code / Codex reported no plan for this turn" in the footer and the note (#391); Codex plan-mode `plan` is a proposal in Markdown and the turn stays read-only (#385, #394); a plan revision never changes approval state. Unit: "a finished turn that did work without a plan says which CLI reported none…". Live today: both CLIs offered no plan tool, and both turns said so, see below | Verified |
| 3. A relevant passing check at the recorded revision can support verification; failed/unrelated checks, missing results and later edits cannot | #351 and #368. Unit: "a turn is verified only when every check after its last change passed", "model prose and an unrelated exit-zero command do not verify anything", "a failed, denied, stopped or unreported check does not verify…", "a later edit… makes earlier checks stale…", "shell control flow cannot hide a failed check…". E2E: `task-to-notes` cases 3 and 5. Live today: the first `npm test` failed, the edit made it stale, the second passed, and both turns read "Verified: `npm test` passed after the last change" | Verified |
| 4. Save creates/updates exactly the intended Note with revision checks; conflicts, repeated clicks, rename/move and project removal never overwrite unrelated notes or cross project boundaries | #289 (same note on repeat, an edited note is kept and the save becomes a new note "saved again"), #363 (moves across projects, Finder moves that keep the revision). Unit: "Save task to Notes writes the turn's record into its project's notes; saving again updates it, and a note edited since is kept". E2E: `task-to-notes` case 2; `plan-clarification` (a secret answer is in no file under `MODEX_HOME`) | Verified |
| 5. Reopen/replay performs zero coding turns, tool execution or implicit Note writes; continuation is an explicit user action | #375. Unit: "a saved task note reopens as the record it saved… with no turn, no CLI call and no write", the edited-after and moved cases. E2E: `task-to-notes` case 6 counts CLI starts (stays 1) and compares the note and transcript before and after. Live today: the transcript was identical after reopening, and the task view had no editable control | Verified |
| 6. No file bodies/context map are disclosed to Jev, no secrets/hidden reasoning enter exported notes; existing read-only Plan/Manage notes tests remain valid | Jev's state (`routing/judge.ts` `stateFor`) carries the request text, user text clipped to 300 characters, "[assistant turn]" for replies and tool titles only; it reads nothing from the task record or files touched (`test/routing.test.ts` "stateFor digests the transcript without file contents…"). The note leaves out reasoning, command output and any path outside the project (`taskRecord`; unit "a task record summarises… without reasoning, logs or private paths"); a secret clarification reads "(hidden)". `e2e/pages-agents.spec.ts` (Manage notes through MCP, draft recovery) and `e2e/codex-native-plan.spec.ts` (read-only plan mode) are in the full run | Verified |
| 7. Existing Notes migration, asset references and scoped tools continue to work; no new graph infrastructure or autonomous scheduler | `test/notes-migration`, `notes-store`, `notes-tree`, `notes-files`, `notes-projects` and `e2e/notes*.spec.ts`, `pages-agents.spec.ts` in the full run. The context map reads only what the CLI reported in the turn (`task-context.md#context-map`: "Nothing is indexed or inferred"); CF-7 added no indexer, graph store or scheduler, and its only background timer is the five-minute quiet end for a turn Codex never finishes (#390) | Verified |

Separate acceptance evidence named by the issue: **one supported native task, and human review of its saved
Note.** The native task is below, twice. The human review is Val's.

## The real task and its saved Note (human-review candidate)

One real turn per CLI, through the app, the main process and the native adapter, on the signed-in
accounts, in Chat mode so the CLI asks before every edit and command. Probe:
`apps/desktop/.probes/cf7-live-note.spec.ts` (git-ignored, derived from the CF-8 live golden path),
run by `.probes/run-cf7-live.sh <backend>` from a shell with every `CLAUDE*`/`ANTHROPIC*` variable
removed. The seeded project is `cf7-review-repo`: `greeting.txt` = `hello`, and `npm test` runs
`check.js`, which exits 1 unless the greeting says `hello, live`.

The request, verbatim, is the first line of each saved note. It asks the CLI to record a three-step
plan only if it has a plan tool and not to search for one, then: run `npm test` and expect it to fail,
replace `hello` with `hello, live`, run `npm test` again, and say in one sentence whether it passed.

Unlike the CF-8 probe, this one **keeps** the seeded home and repository, so the saved Note can be
opened in the app:

| Backend | Launch for review (from `.worktrees/cf7-closeout/apps/desktop`) |
| --- | --- |
| Claude | `MODEX_HOME=$PWD/.probes/cf7-human/claude/home npx electron .` |
| Codex | `MODEX_HOME=$PWD/.probes/cf7-human/codex/home npx electron .` |

In each, open **Space → Personal → cf7-review-repo → Task: If you have a task-list…**, then **Task view**.
The thread is in the sidebar. `~/.modex` is never touched.

### Claude Code 2.1.312 (`claude -p`, Haiku, Chat mode): passed, 2026-10-29 22:54 UTC

Report `live-claude-report.json`, note `live-claude-note.md`, record `live-claude-task-record.json`,
screenshot `screenshots/live-claude-task-view.png`, run log `live-claude-run.log`. 17.6 s, first start.

| Step | Observed |
| --- | --- |
| Approvals | 3: `npm test`, the edit, `npm test` |
| Plan | No plan tool offered or called (zero `TodoWrite`/`TaskCreate`/`TaskUpdate`), as documented for 2.1.308 and later. Footer and note: "Claude Code reported no plan for this turn" |
| Work | `npm test` failed (exit 1, "greeting.txt does not say hello, live"); `Read greeting.txt`; `printf 'hello, live\n' > greeting.txt && cat greeting.txt` (Chat mode disallows Claude's `Edit`, so it used Bash); `npm test` succeeded |
| Verification | Footer: "Verified: `npm test` passed after the last change". Note: the first `npm test` is marked "ran before a later change", the second passed |
| Files touched | `greeting.txt — read`. See observation 1 |
| Save to Notes | `Task: If you have a task-list or todo planning tool available (for`, revision 1, in `Personal/cf7-review-repo`; record file written beside it; the note names no absolute path |
| Open → Task view | Read-only, "nothing here runs again"; request, files, verification and answer as saved; no editable control; the transcript was identical afterwards |

### codex-cli 0.164.0 (`codex app-server`, `gpt-6.1-sol`, ChatGPT account, Chat mode): passed, 2026-10-29 22:54 UTC

Report `live-codex-report.json`, note `live-codex-note.md`, record `live-codex-task-record.json`,
screenshot `screenshots/live-codex-task-view.png`, run log `live-codex-run.log`. 24.8 s, first start.
The model is from Codex's own rollout for this project directory (`turn_context.payload.model`,
default collaboration mode, medium reasoning).

| Step | Observed |
| --- | --- |
| Approvals | 4: `npm test`, the `perl -pi` edit twice (Codex ran the same command again), `npm test` |
| Plan | No `turn/plan/updated` and no plan item. Footer and note: "Codex reported no plan for this turn". This is the first default-mode turn on 0.164.0 and the sixth on this machine with no plan tool offered |
| Work | `npm test` failed, exit 1; `perl -pi -e 's/\bhello\b/hello, live/g' greeting.txt` succeeded, exit 0, twice; `npm test` succeeded, exit 0 |
| Verification | Footer: "Verified: `npm test` passed after the last change". Note: first check stale, second passed, exit codes recorded |
| Files touched | None listed: Codex parsed the `perl` command as an unknown action, so the note has no files section. See observation 2 |
| Save to Notes | Same title shape, revision 1, in `Personal/cf7-review-repo`; record written; no absolute path in the note |
| Open → Task view | Read-only, as above; the transcript was identical afterwards |

### Observations for Val (not defects by the documented rules; worth a decision)

1. **A file written through a shell redirect is listed as read, not changed, for Claude.** Claude's
   CLI reports no file change for a Bash command, and Modex does not parse Claude's commands, so
   `greeting.txt` shows as `read` although `printf … > greeting.txt` overwrote it. Verification
   does treat the redirect as a write (the earlier check went stale), so the verified state is right.
   `task-context.md#context-map` documents "as the CLI reported them"; the gap is that a reader of the
   note may take `read` for "unchanged".
2. **Codex's `perl -pi -e` edit lists no file.** Codex's own parse of that command is `unknown`, so
   the note has no "Files the turn touched" section even though the turn edited one file. Same rule,
   same gap.
3. **The note title cuts the request mid-word** ("…tool available (for"). The note is named after the
   thread, and a thread is named after the first 60 characters of its request until it gets a better
   name, so a long request makes an unhelpful title. A human can rename the note; a later save keeps it.
4. **No live `turn/plan/updated` step plan, still.** Six default-mode Codex turns on this machine
   (0.163.0 and 0.164.0, `gpt-6.1-sol` and `gpt-6-astra`) have not been offered the plan tool. The
   path stays tested with schema-shaped fixtures, as `task-context.md#not-done-yet` says.

### Human review

| Item | Result | Reported by Val |
| --- | --- | --- |
| Claude Note reads as a true, complete and portable record of the turn | open | |
| Codex Note reads as a true, complete and portable record of the turn | open | |
| Task view matches the saved Note and runs nothing | open | |
| Observations 1–3: accept as documented, or open follow-ups | open | |

Val posts the result on #280. It is copied here exactly as reported, in a docs-only signed PR. #280
closes when every row has Val's result or Val's written deferral.

## Full run: `pnpm test` and `pnpm test:e2e`

One first pass on `eca2bd9`, started 2026-10-29 22:49 UTC in the worktree after `pnpm build`, with the
live probes above running during the e2e stage (`full-run.log` beside this receipt, trailing spaces
removed).

| Stage | Result |
| --- | --- |
| `pnpm test` | worktree scripts 117/117; core 16/16; desktop 2,062 passed, 20 skipped, 0 failed (2,082), plus scripts 21 passed, 6 skipped; site 10/10; store-desktop 16/16 |
| `pnpm test:e2e` | desktop 475 passed, 7 skipped (the opt-in `live-smoke`, `claude-live-stop` and `knowledge` cases), 0 failed, 21.4 min; site 7/7. Ended 23:16 UTC, exit 0 |

## Documented limits that stay

From `docs/task-context.md`:

- **Not done yet:** a Claude plan with Modex's own launch arguments (2.1.308+ offer no plan tool
  without `CLAUDE_CODE_ENABLE_TODO_TOOLS`, which Modex does not set, Val's option 1); a live Codex
  `turn/plan/updated` step plan; model-proposed or user-confirmed context relations (every relation
  shown is one the CLI reported).
- **Retired:** linking a check to the plan step it verifies (Val, 2026-10-23).

## Worktrees left from CF-7 sessions

`cf7-path-repair` (#360, merged `44524dc`) and `cf7-reopen` (local commit `1f0d282`, never pushed;
superseded by #375) are still checked out under `.worktrees/`, owned by their sessions. This session
did not touch them; only their owners may release them, per `AGENTS.md`.
