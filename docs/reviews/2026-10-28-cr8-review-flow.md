# CR-8 integrated native-review and write-recovery fixture

The CR-8 journey had no single test connecting populated remote diff content, a native review finding, the review draft, explicit submission and restart reconciliation. This addition extends the existing Code Review agent spec with the existing synthetic Claude CLI and GitHub transport. No product code, default capability or external-service configuration changes.

The fixture declares a complete two-file diff. Through real Electron controls, it opens that diff, starts one synthetic Claude review, adds an anchored finding to the review draft, fills a summary and previews the account, repository, PR, head and inline destination. The synthetic GitHub server records the confirmed review and withholds its response. Restarting the full app must show an unknown outcome. Explicit Check GitHub resolves it from a read-back while both provider-start and POST counts remain exactly one. The submitted review pins the expected head and inline path/side/line. No actual provider inference or real GitHub mutation occurs.

## Validation

The working test was extended after its earlier case completed in session `49837`: it now visits a complete activity fixture, scrolls the unknown-outcome control into the capture viewport, and checks that a later head change disables promotion of the recovered finding. The extended focused run passed: one test in 8.0 seconds, with a 7.7-second test body. Its artifacts are preserved in `cr8-review-flow-extended-focused-passed/`, with SHA-256 hashes for the captures. The earlier results and first capture inspection below apply to the preserved pre-extension source (`cr8-review-flow-pre-extension.spec.ts` and its SHA-256 receipt), not to the new assertions. The extended full validation also passed: build, 2,242 unit passes with 26 skips and zero failures or cancellations, 475 desktop passes with 7 skips, and 7 site passes (exit 0). The integrated case passed in 8.1 seconds; the transcript latency median was 131.3 ms. Results and artifacts are in `cr8-review-flow-extended-validation.log` and `cr8-review-flow-extended-full-passed/`.

Baseline product source is main `33a782039c0bbb49c622915520dc7ecf9b86a7b7`. Build passed. The first focused run passed: one integrated Electron test in 9.0 seconds, with an 8.7-second test body. Captures were then added at the populated split, submission preview and restarted unknown-outcome states for the full validation run. The full validation chain passed build and unit tests (2,242 passed, 26 skipped, zero failed or cancelled). The integrated test passed within the ongoing full E2E suite in 6.4 seconds; that earlier full E2E run completed with 475 desktop passes, 7 skips and 7 site passes (exit 0). Its transcript latency median was 114.5 ms. Those results apply to the pre-extension source.

Logs and artifacts are preserved outside the worktree under `~/Documents/Codex/artifacts/modex-land-and-prune/`, including `cr8-review-flow-build.log`, `cr8-review-flow-focused-first.log` and `cr8-review-flow-focused-passed/`.

After validation, the branch fast-forwarded to main `d1cc80a15925cdcad529e199bc5b7fc4e955a7f3` (#440). The incoming diff contains only the R2/R3 journey spec and documentation; application source and dependencies are unchanged. The validated working changes reapplied without conflicts. Both the full agent spec and updated journey spec passed together on this integrated tree: seven tests in 40.1 seconds (integrated review 8.5 seconds; R1–R4 journey 6.2 seconds). The result is preserved in `cr8-review-flow-main-integration-focused.log` and `cr8-review-flow-main-integration-passed/`. The pre-integration stash `13084a91263dbc2c0cdb12993d6ab284a57e9eae` remains preserved.

## Reproduction environment

The current environment is Mac17,6, Apple M5 Max (18 cores), macOS 27.0.1, Node 24.22.0, pnpm 10.34.5, Electron 44.4.5 and Playwright 1.63.0. Installed versions and the extended spec SHA-256 are preserved in `cr8-review-flow-environment.json`. The synthetic Claude version response is 2.1.312; it does not identify an installed live provider. From the owned worktree, run `pnpm build && pnpm test` and `pnpm test:e2e`. For a focused rerun after building, use `pnpm --filter @modex/desktop exec playwright test e2e/code-review-agent.spec.ts -g "integrated review:"`. Run only one local desktop E2E process at a time.

## Capture inspection

The populated split capture visibly shows the remote text patch and binary-file entry. The submission preview visibly shows the fixture account, repository, pinned head, inline finding and explicit Submit review action. After restart, the captured viewport shows the persisted completed review and finding; the unknown-outcome control is outside that viewport, so this image alone does not establish its presentation. The test separately asserts that control is visible and resolves it through Check GitHub. Missing activity, stack, checks and deployment fixtures render unavailable states; these captures do not establish those surfaces. The three PNGs were copied and SHA-256 verified under `cr8-review-flow-captures/manifest.json` in the external artifact directory.

The extended focused capture was also inspected: the unknown-outcome warning, pinned head, Check GitHub and Stop tracking controls are now visible. Activity and deployments are refreshing in that restart capture; their loading state is not treated as a completed activity snapshot.

## Mapping to the CR-8 contract

This is a scoped supplement to the historical `2026-10-22-cr8-acceptance-matrix.md`, checked against the live #327 requirements. Its evidence is from real Electron over production main/IPC services with synthetic GitHub and a synthetic native CLI. It supplies no new authenticated-read, live-provider, live-write or human acceptance evidence.

| Requirement or control | Evidence supplied here | Remaining boundary |
| --- | --- | --- |
| C27 native review entry | Explicit Review with Claude and Start review dispatch one synthetic CLI run; an anchored finding reaches the local draft. | Other provider choices and live inference retain their separate evidence gates. |
| C64 file header; C68 diff lines | The remote file is selected and New line 2 is visible before review; the captured split shows the populated text patch. | This test does not exercise context expansion, every diff control or original-reference fidelity. |
| #327 complete fixture journey | Inbox row → overview/activity → populated split/file → native CLI fixture → current anchored finding → draft → preview → confirmed mocked review → full restart → read-back reconciliation → later head change and disabled stale finding. | The stale transition occurs after reconciliation; this test does not claim a stale finding was submitted or exercise every context-selection control. |
| #327 AC3 recovery | The server records acceptance while withholding its response; restart exposes an unknown outcome; explicit reconciliation finishes with one provider start and one POST. The POST includes the pinned head and exact inline destination/body. | This covers one lost-response path, not every identity, injection, pagination or transport adversary. |
| #327 AC4 existing regressions | Build, unit and the full E2E suite passed for the extended test. | All seven combined agent and journey tests passed after integrating #440; hosted validation remains pending. |
| #327 AC6 evidence separation | Product baseline, focused/full-run distinction, synthetic transports and external capture hashes are recorded above. | No current authenticated, live-provider, disposable-target-write or human result is claimed. |

## Acceptance limits

This supplies integrated fixture evidence across CR-5, CR-6 and CR-7 for #327. It does not replace the separate adversarial tests or prove authenticated/native/live-write acceptance. R1–R4 original-reference comparison, human VoiceOver and any unrun live gates remain open. The synthetic CLI is a native child-process fixture, not a real model or paid provider. The server accepts a review before withholding the reply; it does not simulate every transport or remote failure mode.
