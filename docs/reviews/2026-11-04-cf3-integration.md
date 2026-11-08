# CF-3 current-main integration — validation in progress

The owned `cf3-integration` worktree starts at main `49ff1e1d214b50adff54799e148669a147f96f7e` and integrates #489 head `4f964fa5d267b966617a6f6b1288653d6047ad9e`. Only `docs/status.md` conflicted; current main's status and release records were retained. The original question-focus and approval-draft claims and worktrees remain untouched pending handoff. No merge or release is claimed.

Prepared approval/draft changes were recovered from `cf3-approval-draft` after an external backup. The cases now cover Approve, Deny, Stop and native withdrawal. All four assert the independent multiline draft, attachment identity and bytes, and reload recovery. Approve and Deny expect one native decision; Stop and withdrawal expect zero, including after a stale answer. These assertions are not yet runtime-validated.

| Check | Result |
| --- | --- |
| Offline frozen pnpm installation | Exit 0, pinned pnpm 10.34.5 |
| `pnpm build` | Exit 0 |
| `pnpm typecheck` | Exit 0 |
| Strict E2E TypeScript check including renderer bridge | Exit 0 after Stop/withdraw additions |
| Baseline focused Electron run | Exit 1: all nine tests failed during Electron launch with SIGABRT, before assertion execution |
| `pnpm test` | Exit 1: maintenance 147/147 and core 16/16 passed; desktop 2,115 passed, 20 skipped, 2 failed (Notes watcher settling) |
| Remaining desktop native/utility suite, run separately after chain stopped | Exit 0: 21 passed, 6 skipped |
| Site unit suite, run separately | Exit 0: 10 passed |
| Store desktop unit suite, run separately | Exit 0: 16 passed |
| Four-case approval runtime coverage | Pending working Electron launch |
| Deliberately corrupted attachment negative control | Not run |
| Full E2E and protected delivery | Not run |

The baseline Electron failure preceded the Stop/withdraw test additions. Its logs and all traces were preserved outside the checkout at `/Users/buns/Documents/Codex/artifacts/modex-cf3-finish-2026-11-04/`. Do not interpret launch failures as product-regression evidence or retry silently. Git fetch also failed DNS resolution; GitHub connector main inspection matched the local base before integration.

#276 remains open. Desktop keyboard/native D1-D5 and physical-phone P1-P4/P6 remain with Val. VoiceOver V1-V3/P5 retain Val's temporary deferral, with no pass claimed. Release inclusion needs coordination with the v0.4.2 owner after delivery; publication remains outside this goal.

A second diagnostic invocation targeted only the new Stop case with `DEBUG=pw:browser` and stopped at the first failure. Electron again aborted during launch (SIGABRT); no test assertion ran. Electron 44.4.5 executes successfully in Node mode. Both local Electron bundles inspected fail strict code-signature verification; the causal relationship to the GUI abort is unproven. No signature or application security settings were changed.

The two desktop failures are `a watched notes folder shows a detached project at once, and links a linked project without walking` and `a watched folder is walked again only after something changes, or every 10 seconds`. Both failed their settling assertions. An independent recursive `fs.watch` probe also emitted `EMFILE: too many open files, watch`; `NotesStore.watch()` disables its watcher on error and therefore does not reuse a watched cache. Notes source and these two tests are unchanged from the integration base. This supports an environment limitation; the full unit gate remains failed. The separately executed downstream suites are supplemental results, not a passing rerun of `pnpm test`.

The local SSH agent connection is refused, and Git transport still cannot resolve github.com. No signed commit or push has been attempted. The attachment corruption control, rendered validation, full E2E, protected merge, delivered-main matrix, release-owner coordination and guarded cleanup remain outstanding.

## Runtime access recovered — 2026-11-08

GitHub transport, the loaded SSH signing key and the Aqua session are available again. Fresh fetch confirms origin/main remains `49ff1e1d214b50adff54799e148669a147f96f7e`; #489 remains open at `4f964fa5d267b966617a6f6b1288653d6047ad9e`. GitHub still reports v0.4.1 as the latest published release.

The integrated focused Electron run passed all 11 cases in 31.5 seconds, exit 0, without retries. This includes Approve, Deny, Stop and native withdrawal with draft/attachment recovery and focus assertions, both question-focus paths, sensitive-answer coverage, and uncertain delivery after restart. This is synthetic CLI evidence in the rendered Electron app; the human and live-provider rows remain open.

A deliberate attachment corruption in the Approve case failed exactly at the attachment-byte comparison: expected the original attachment text, received `deliberately corrupted`. The mutation was removed in a finally block; the restored test SHA-256 is `46106976de08bfc61735d69aa7b54e0236e4e8f160ceb0c2cf3c22c840ce4bc5`. Negative-control logs and traces are retained outside the worktree. The subsequent full E2E run uses the restored test.

Fresh full validation is running: build/unit/typecheck chain in exec session 19819, and full desktop/site E2E in session 96208. Their results remain pending. No signed commit, push or merge has occurred. Prior failed runs above remain part of this receipt.

## Candidate and remaining acceptance matrix

Signed candidate `2ef741d00211bfd85e1eadd99ca286786ac5b772` has tree `bb89681ab1783e2bf79e0dc51cbb1223037c6fec`. Its SSH signature was independently verified against the loaded public key. Fresh build, full unit and workspace typecheck commands completed with exit 0: 2,327 unit passes, 26 skips, zero failures. These supersede the earlier failed environment run for candidate qualification while retaining its first-failure evidence. Full E2E remains pending; delivered-main qualification is not yet established.

| Gate | Candidate evidence / remaining work | Owner |
| --- | --- | --- |
| Question validation and accepted-answer focus | Both rendered answer-focus and moved-focus cases passed; source repair comes from #489 | CF-3 delivery session: finish E2E and protected delivery |
| Approve and Deny | Rendered cases preserve exact multiline draft, attachment identity/bytes, reload recovery, answer/fold focus and one CLI decision | CF-3 delivery session: finish E2E and protected delivery |
| Stop and native withdrawal | Rendered cases preserve draft/attachment and focus; obsolete controls disappear; stale IPC answers send zero native decisions | CF-3 delivery session: finish E2E and protected delivery |
| Attachment corruption control | Expected byte assertion failed; restored test hash verified; subsequent full run uses restored test | CF-3 delivery session: retain receipts |
| Sensitive answers and uncertain delivery | Focused synthetic Codex cases passed, including journal/restart and inert uncertain delivery; real provider acceptance remains separate | Val for actual CLI/model acceptance |
| D1-D5 desktop keyboard/native | Open: labelled/reachable card, invalid submission, navigation retention, exact secret including spaces and storage scan, Stop | Val on the named delivered candidate |
| V1-V3 desktop VoiceOver | Temporarily deferred by Val on 2026-11-01; not run or passed | Val decides when to resume |
| P1-P4 physical phone | Open: native card, invalid input, answer and competing-client result; compatible TestFlight build and physical phone required | Val |
| P5 phone VoiceOver | Temporarily deferred by Val; not run or passed | Val |
| P6 older Companion | Open: verify compatible notice-only behavior with older client or record explicit deferral | Val |
| Protected delivery / delivered main | Local signed candidate exists; full E2E, push, hosted checks, queue and merged-tree proof pending | CF-3 delivery session |
| Release inclusion | v0.4.1 is still latest published; recommend considering this repair after exact delivered-main validation, with fresh release qualification if included in v0.4.2 | Coordinate with `release-v042` owner; publication outside this goal |
| Guarded cleanup | Only `cf3-integration` is currently owned by this session; older worktrees retain their claims. The task service rejected direct input to the former question-focus sub-agent, so no handoff is claimed | CF-3 delivery session, after delivery and recovery archive verification |

Another Playwright process was observed while full E2E ran. This receipt does not claim exclusive GUI access; any failed case will retain its original failure and require investigation before a retry. #276 remains open and no human acceptance box is changed by this matrix.

## Completed local qualification

Full `pnpm test:e2e` exited 0 on signed source candidate `2ef741d00211bfd85e1eadd99ca286786ac5b772`: desktop 502 passed and 7 opt-in skips in 23.9 minutes; site 7 passed in 8.8 seconds. No retry was used. Build, full unit suites (2,327 passed, 26 skipped), workspace typecheck and the prior strict E2E typecheck passed. The documentation added afterward changes no source or tests.

The earlier environment failures and the expected corruption-control failure remain preserved. This establishes local qualification; hosted PR/queue checks and delivered-main proof remain pending. Release inclusion recommendation: include this bounded CF-3 repair in v0.4.2 only after protected landing and fresh release-candidate qualification by the release owner. Otherwise retain the prepared release candidate and ship the repair in the next patch. The CF-3 human and live/native gates above remain open.
