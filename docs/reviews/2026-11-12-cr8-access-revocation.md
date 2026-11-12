# CR-8 accessible-to-revoked integration evidence

## Requirement and boundary

The full #327 adversarial step includes revoked access, unsafe paths and no secret leakage. Existing service units covered revocation, but the Electron inaccessible-repository case began with access already denied. This slice adds the accessible-to-revoked transition and a direct unsafe context-path IPC case through the production renderer/preload/IPC/read service/gh transport. Only the external gh executable is synthetic; no IPC handler is replaced.

The development app uses a private synthetic profile, repository and gh configuration. CLI provider recorders verify zero provider starts; mutation logs and method records verify zero writes. No personal account, real token, live inference, GitHub mutation, installed-release or human/device acceptance is exercised. The full #327 criterion remains unchecked pending the complete clause audit and actual protected delivery.

## Source and environment

The source base is protected main `30a56557cb09512396a7d0334bd1046cf0fba609`. There is no permanent application-code change. The temporary negative-control mutation was restored byte-for-byte before clean validation. Test source identities are:

- `apps/desktop/e2e/code-review-regressions.spec.ts`: SHA-256 `53b9d30be948ad542cfa0092f285752c2dda76c790b6fbc8e3519859af721c06`.
- `apps/desktop/test/fixtures/code-review-gh-world.ts`: SHA-256 `66bd389996fafea154bc2c2f351d245d99fb6dbf974b0e65da580096f1f7c5f1`.

The host is macOS 27.2.1 arm64, Node 24.22.0 and pinned pnpm 10.34.5. The installed Electron package is 44.4.5; tests use its development-app launch with no packaged-app override. Package identity is distinct from a separate installed-release acceptance claim.

## Cases and first failures

The original nine regression cases passed in 19.5 seconds after a fresh build. The immediately preceding full-unit baseline is reusable because comparison with qualified `435721d` differs only in two human documentation files; all runtime/build/test/dependency inputs are identical. The fresh final qualification below supersedes that baseline for this slice.

For each 403, 404 and 410 case, the visible private body and six overview/resolve/context/activity/checks/files reads begin ready. A different repository first demonstrates a real stale/offline fallback under the same synthetic identity. The real inbox Refresh then observes revocation, hides the private body and shows an error. Later offline reads must all remain unavailable for the revoked PR, while the unrelated repository retains its legitimate fallback. Retry waits for the actual network failure rather than merely the previous denial notice. Synthetic CLI diagnostics do not appear in replies or rendered content.

The fourth case holds a real context transport response, observes a denial through a separate overview read, releases the held response and requires it to remain unavailable without the private payload. These are actual Electron/IPC transitions over a scripted external CLI, not live GitHub permission changes.

Before the new fixture branch existed, the offline positive control failed in all three table cases: the response was ready instead of stale/offline. The held-response case already passed. This first RED and its traces are retained; it is evidence of a missing test-fixture capability, not a demonstrated product bug. Adding optional `GhWorld.offline` made the four focused revocation cases pass in 9.9 seconds, leaving default fixture behavior unchanged.

A deliberate temporary production mutation classified ordinary 403 as offline. The 403 integration case failed because the private body remained visible and no denial notice appeared. Its trace and source backup are retained. Restoring the exact original production bytes, rebuilding main and running the whole regression file passed thirteen cases in 31.9 seconds. This proves test sensitivity; no production repair is claimed.

A further clause audit identified unsafe context paths as a second integration gap. The fifth case proves one real valid context read, then asks the real IPC handler for literal absolute, parent-traversal, dot/empty-segment, control, bidi, zero-width and lone-surrogate paths. Each must reject before an additional gh call; provider starts and mutations stay zero. The focused unsafe-path case passed in 2.0 seconds, with eight rejected path inputs and no further gh calls. The final full E2E run also passes this case.

## Reproduction and qualification

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm --filter @modex/desktop exec playwright test e2e/code-review-regressions.spec.ts --retries=0
pnpm typecheck
pnpm test
pnpm test:e2e
```

Fresh build, typecheck and full units passed: 2,570 unit passes, 36 explicit skips and zero failures/cancellations. The added path case changed only E2E inputs, and the qualification driver stopped at its source-freeze guard before E2E. Reconstructing the exact pre-addition source patch reproduced its recorded SHA-256, independently proving every non-E2E runtime/build/typecheck/unit/dependency producer unchanged. Those passed stages remain valid. Final full E2E passed on the unchanged five-case source snapshot: 525 desktop cases with eleven explicit skips in 22.1 minutes, eight site cases in 7.8 seconds and four web cases in 2.6 seconds. All fourteen cases in the modified regression file passed; no framework retry markers were observed. The eleven skips are four live-provider cases, four native local-model cases and three Open Knowledge opt-in cases; they are not acceptance passes. Independent review, hosted source checks and protected delivery remain pending.

## Acceptance limits

These fixtures establish bounded no-fallback/no-late-payload and IPC-validation behavior under named synthetic failures. They do not prove live provider quality, a real GitHub revocation, real-write canaries, human accessibility, physical-device behavior, a fresh release candidate or the entire adversarial clause. Code Review stays hidden by default and no release or execution-admission policy changes.

The complete local logs are retained privately with these SHA-256 identities:

| Command | Raw log SHA-256 |
| --- | --- |
| `pnpm build` | `26603cc8baa6abf4da8709d44e73eaa6f9caecc9c13c7218e27d7a668b9db4f6` |
| `pnpm typecheck` | `5a4f48927c40e455183c8d566825aecafa1e3f2c6ae89f4d0d142a6852bdd80c` |
| `pnpm test` | `165404057e24c511e8885c48ca785c8fda9792ceb9c3b608de741be4b41b96be` |
| `pnpm test:e2e` | `d68960f12a9f3c1412ba79fca0f2619aca055fdd5b8f104eb6153b857cf156b6` |
