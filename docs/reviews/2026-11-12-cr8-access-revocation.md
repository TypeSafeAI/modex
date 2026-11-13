# CR-8 accessible-to-revoked integration evidence

## Requirement and boundary

The full #327 adversarial step includes revoked access, unsafe paths and no secret leakage. Existing service units covered revocation, but the Electron inaccessible-repository case began with access already denied. This slice adds the accessible-to-revoked transition and a direct unsafe context-path IPC case through the production renderer/preload/IPC/read service/gh transport. Only the external gh executable is synthetic; no IPC handler is replaced.

The development app uses a private synthetic profile, repository and gh configuration. CLI provider recorders verify zero provider starts; mutation logs and method records verify zero writes. No personal account, real token, live inference, GitHub mutation, installed-release or human/device acceptance is exercised. The full #327 criterion remains unchecked pending the complete clause audit and actual protected delivery.

## Source and environment

The original revocation-evidence source base is protected main `30a56557cb09512396a7d0334bd1046cf0fba609`. That original slice had no permanent application-code change; the later hosted-failure follow-up below includes a title-editing repair. The temporary negative-control mutation was restored byte-for-byte before clean validation. Post-review correction test source identities are:

- `apps/desktop/e2e/code-review-regressions.spec.ts`: SHA-256 `de1cb28cdc8ac45ce69625ab2df94908abd82292644fdc2708324b7d71be7ab6`.
- `apps/desktop/test/fixtures/code-review-gh-world.ts`: SHA-256 `66bd389996fafea154bc2c2f351d245d99fb6dbf974b0e65da580096f1f7c5f1`.

The host is macOS 27.2.1 arm64, Node 24.22.0 and pinned pnpm 10.34.5. The installed Electron package is 44.4.5; tests use its development-app launch with no packaged-app override. Package identity is distinct from a separate installed-release acceptance claim.

## Cases and first failures

The original nine regression cases passed in 19.5 seconds after a fresh build. The immediately preceding full-unit baseline is reusable because comparison with qualified `435721d` differs only in two human documentation files; all runtime/build/test/dependency inputs are identical. The fresh final qualification below supersedes that baseline for this slice.

For each 403, 404 and 410 case, the visible private body and six overview/resolve/context/activity/checks/files reads begin ready. A different repository first demonstrates a real stale/offline fallback under the same synthetic identity. The real inbox Refresh then observes revocation, hides the private body and shows an error. Later offline reads must all remain unavailable for the revoked PR, while the unrelated repository retains its legitimate fallback. Retry waits for the actual network failure rather than merely the previous denial notice. Synthetic CLI diagnostics do not appear in replies or rendered content.

The fourth case holds a real context transport response, observes a denial through a separate overview read, releases the held response and requires it to remain unavailable without the private payload. These are actual Electron/IPC transitions over a scripted external CLI, not live GitHub permission changes.

Before the new fixture branch existed, the offline positive control failed in all three table cases: the response was ready instead of stale/offline. The held-response case already passed. This first RED and its traces are retained; it is evidence of a missing test-fixture capability, not a demonstrated product bug. Adding optional `GhWorld.offline` made the four focused revocation cases pass in 9.9 seconds, leaving default fixture behavior unchanged.

A deliberate temporary production mutation classified ordinary 403 as offline. The 403 integration case failed because the private body remained visible and no denial notice appeared. Its trace and source backup are retained. Restoring the exact original production bytes, rebuilding main and running the whole regression file passed thirteen cases in 31.9 seconds. This proves test sensitivity; no production repair is claimed.

A further clause audit identified unsafe context paths as a second integration gap. The fifth case proves one real valid context read, then asks the real IPC handler for literal absolute, parent-traversal, dot/empty-segment, control, bidi, zero-width and lone-surrogate paths. Each must reject before an additional gh call; provider starts and mutations stay zero. The focused unsafe-path case passed in 2.0 seconds, with eight rejected path inputs and no further gh calls. The pre-review full E2E also passed this case.

## Reproduction and qualification

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @modex/desktop exec playwright test e2e/code-review-regressions.spec.ts --retries=0
pnpm typecheck
pnpm test
pnpm test:e2e
```

Fresh build, typecheck and full units passed: 2,570 unit passes, 36 explicit skips and zero failures/cancellations. The added path case changed only E2E inputs, and the qualification driver stopped at its source-freeze guard before E2E. Reconstructing the exact pre-addition source patch reproduced its recorded SHA-256, independently proving every non-E2E runtime/build/typecheck/unit/dependency producer unchanged. Those passed stages remain valid. The pre-review full E2E at `51a7750` passed on its unchanged five-case source snapshot: 525 desktop cases with eleven explicit skips in 22.1 minutes, eight site cases in 7.8 seconds and four web cases in 2.6 seconds. All fourteen cases in the modified regression file passed; no framework retry markers were observed. The eleven skips are four live-provider cases, four native local-model cases and three Open Knowledge opt-in cases; they are not acceptance passes. One fresh whole-branch review of signed `51a7750` is complete; hosted source checks and protected delivery remain pending. The reviewer identified a diagnostic assertion gap graded Minor; the executor treated it as Important for the no-leak acceptance evidence and is completing one coalesced correction, without a second review. The original pre-review full-suite pass remains historical; it does not qualify changed assertions.

## Review correction

The table cases now check rendered content while the denial is still visible and independently check an actual denial reply before offline mode masks the diagnostic-emitting route. A temporary production mutation adds a synthetic diagnostic to the ordinary 403 public detail. The old assertions pass despite an explicit denial DOM capture containing that marker; the new immediate assertion fails under the same control. Production source is restored byte-for-byte and all fourteen regressions pass. This is an assertion correction, not a discovered production leak or product repair.

The first observation probe could not verify the DOM because the manually launched Electron trace contained test steps without frame snapshots. That attempt and its exact source restoration are retained; a temporary explicit DOM artifact supplied the missing observation and was removed before clean validation. No observation failure is hidden. The original fixture RED source was also recovered exactly from the source bytes embedded in its retained trace.

Only the E2E regression file changed after the verified source; the shared fixture and every non-E2E production/build/typecheck/unit/dependency input remain identical. Their passed results are reused with explicit name/hash guards. The corrected full E2E run passed on unchanged inputs: 525 desktop cases with eleven explicit skips in 22.1 minutes, eight site cases in 7.5 seconds and four web cases in 2.5 seconds, including all fourteen regressions and no framework retry markers. The local correction is qualified; no second review was requested. Source-hosted checks, protected delivery and the complete current-main criterion audit remain separate gates.

## Acceptance limits

These fixtures establish bounded no-fallback/no-late-payload and IPC-validation behavior under named synthetic failures. They do not prove live provider quality, a real GitHub revocation, real-write canaries, human accessibility, physical-device behavior, a fresh release candidate or the entire adversarial clause. Code Review stays hidden by default and no release or execution-admission policy changes.

The complete pre-review `51a7750` local logs are retained privately with these SHA-256 identities; the E2E row does not qualify the later assertion correction:

| Command | Raw log SHA-256 |
| --- | --- |
| `pnpm build` | `26603cc8baa6abf4da8709d44e73eaa6f9caecc9c13c7218e27d7a668b9db4f6` |
| `pnpm typecheck` | `5a4f48927c40e455183c8d566825aecafa1e3f2c6ae89f4d0d142a6852bdd80c` |
| `pnpm test` | `165404057e24c511e8885c48ca785c8fda9792ceb9c3b608de741be4b41b96be` |
| `pnpm test:e2e` | `d68960f12a9f3c1412ba79fca0f2619aca055fdd5b8f104eb6153b857cf156b6` |

The corrected full E2E log has SHA-256 `e58274a50c51a97ca3bb964037d1a4073ea14e7961859f3b6df8405dbf17b87b`. The two source identities above bind these post-review results; the earlier log table remains explicitly historical.

## First hosted failure and file-scan correction

The first source-hosted macOS job for signed `ec34bd8f0ecef825cedf16295ceb59ac6b72ac27` ([job 131506002482](https://github.com/TypeSafeAI/modex/actions/runs/43310778556/job/131506002482)) failed after 38.5 minutes of desktop E2E: 529 passed, 14 skipped and one existing human-question draft/focus test failed. All fourteen Code Review regression cases passed. The failing recursive privacy scan enumerated `update-recovery.json.<UUID>.tmp` while the private app was still writing, then received ENOENT after atomic rename. The first log and all four artifacts are preserved with matching API SHA-256 digests and verified ZIPs. Site and web were not reached by the failed chained command.

A deterministic control using the exact existing scanner reproduced the enumeration/read ENOENT when the temporary file was renamed between those operations; the unchanged scanner read the final file after writer quiescence. The correction adds only app closure and handle clearing after all UI assertions but before each of the two live-app privacy scans, matching the existing journal-enabled test. The scanner, all secret assertions and all account/focus/draft assertions remain unchanged; no filename is excluded, error ignored, retry added or product behavior changed. New full qualification is pending.

## Hosted-failure follow-up: associated cards and chat rename intent

The first local full validation of the file-scan correction passed build, typecheck and 2,570 units with 36 skips, then failed an existing accessibility assertion after 524 desktop passes and eleven skips. The assertion selected every Chat details dialog while pointer and keyboard targets could differ. The correction follows the focused chat button's actual `aria-controls` relation and preserves role, accessible name, content, focus, Escape and focus-return assertions. A deterministic two-chat regression reproduces the old global selector failure and verifies the associated card.

Two complete affected-suite attempts each ended with 20 passes and one failure; a read-only app-file diagnostic then ended with fourteen passes and one failure. Explicit fixture titles did not repair that failure. These retained attempts exposed a separate production defect: after a menu Rename, the title bar's persistent command counter caused every later keyed chat title to enter editing on mount. An initial New thread draft could then overwrite the later title on blur. Both renderer and main-process state captured the stale title as manual. A direct menu-Rename-then-create-chat regression fails on the original source because the later title is editable. The repair remembers the command counter on mount and enters editing only for a newly received command. It preserves ordinary menu, double-click and Enter rename behavior.

The first post-edit focused launch mistakenly reused the previously built renderer and failed; that observation and its artifacts remain retained and do not qualify the repair. After rebuilding the renderer, all three focused cases passed in 12.2 seconds: accessibility, menu rename isolation and keyboard-card association. The complete app and human-question suites then passed all 22 cases in 52.1 seconds, including the earlier menu-Rename sequence and all six question cases. Fresh current-main build, typecheck, unit and full E2E qualification remain pending. These first failures do not change any privacy assertion, add retries or establish human/native/release acceptance.

## Current-main integration and independent follow-up review

One fresh independent review of the new follow-up found no Critical or Important defects and two Minor coverage suggestions. Both were accepted: the regression now requires an existing saved later chat and preserves its exact title/provenance across blur, then exercises fresh menu Rename, double-click cancellation and focused Enter commit on that later keyed title. No minor is deferred. The review's other scope limits remain explicit acceptance or delivery gates; no second review was requested.

The signed fix checkpoint `cfbd8c3` was integrated without conflicts with protected main `b6e3026234cf39c51f5ad0dbb6183f3c5c5b0b83` in signed merge `23b22cd`. Relative to that main, the production title-bar delta is exactly the reviewed command-counter guard; current-main controls are preserved. After the two assertion improvements, the current-main build passed and the complete affected suites passed all 22 cases in 51.5 seconds. Fresh integrated typecheck and full units passed: 2,579 passes, 36 explicit skips and zero failures/cancellations across all six test groups. Full integrated E2E passed on that unchanged source: 529 desktop cases with 17 explicit skips in 20.6 minutes, eight site cases in 7.9 seconds and four web cases in 2.7 seconds, with zero failures or retry/flaky annotations. All fourteen Code Review regression cases passed. The 17 skips are four live-provider, four local-model native, three Open Knowledge and six opt-in installed-CLI Code Review checks; none is an acceptance pass. The complete output artifacts were archived and 185 files independently byte-compared before starting the separate native qualification. These current results qualify the integrated affected behavior; earlier 22-case and full-suite results remain historical. Source-hosted and actual protected delivery are pending.

## Fresh integrated installed-CLI qualification

After the complete E2E artifacts were preserved, the opt-in installed-CLI boundary suite passed on this same frozen integrated candidate with Claude Code 2.1.323, Electron 44.4.5, Chromium 152.0.7977.130 and embedded Node 24.21.0 on macOS arm64. The six checks took 18.9 seconds: four ordinary passes and two intentional expected-failure controls, with no unexpected failure or framework retry. They produced three native starts, one per exercised provider run. The actual CLI read the injected PR snapshot and allowed selected evidence while refusing outside-secret and symlink reads, shell, file write, WebFetch, MCP and the deferred placeholder. Effect markers remained absent.

All three native records retained their observations and inputs. The two fault controls retained the intended callback or app-close failure and verified their follow-up receipts. A root audit independently observed all three recorded native PIDs absent and all three provider ports refusing connections; these are sampled closure observations, not exhaustive descendant proof. All producer-file hashes still matched the full-suite input manifest. Fifty native output files and all three owned synthetic fixture trees were copied and independently byte-compared. Incoming GH_TOKEN was already absent, so this does not establish a supplied-token native scrub challenge; the separate unit evidence retains that scope. The provider and GitHub data were scripted, with no paid inference or live write. Native candidate qualification does not replace the final actual-main source-equivalence and literal-clause audit required before ticking #327's full adversarial criterion.

The fresh integrated full E2E log has SHA-256 `d7b14cc92194247c3a784fdaaf4149aa87846a7cd8a026450c0d8a032eb256b8`; the native log has SHA-256 `1d336688bf62f5e55b0a59d57a3e2768616b8c280a2b73f616cd3c353ed8065d`. The unchanged runtime/test source diff from protected main `b6e3026` has SHA-256 `6a7908adfb4c3fe8eea6f2b56e44c48973cabc31110fa1ac82f989f79b2ec200`. Build, typecheck, unit and E2E logs, full input manifest, first failures, native records and verified archives are retained privately. Source-hosted and actual protected delivery remain pending.
