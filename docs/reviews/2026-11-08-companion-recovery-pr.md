# COMP-CMD-2: Companion command recovery

Locally qualified on 2026-11-08 from main `d7650e4c54cdd15e4ee4f14b9f4dec3455ba1e77` in the owned `companion-recovery-pr` worktree. A timed-out command-list request now keeps its error inside the skills picker, preserves search and the exact new-thread draft, and offers an explicit Try again action. Pairing-link and secret-answer fields provide Done actions to dismiss their keyboards before explicit Connect or Send answer. [Interruption checkpoint](2026-11-08-companion-recovery-pr/checkpoint.md).

## Scope and provenance

The repair preserves project/provider scoping, cancellation and stale-response guards, revocation recovery, secret handling and explicit submission. The fixture stalls exactly one armed command GET while other traffic uses the real CompanionServer. The paired test checks inline failure, retained search, explicit retry and the exact `Start from phone $mobile-check ` draft before creating the thread. No existing assertion, request timeout or wait deadline was removed or increased; no unconditional retry was added.

The original qualified `companion-skill-flow` worktree and COMP-CMD-1 manifest remain intact. Six verified iOS source/test/fixture files were ported after confirming main had not modified those inputs. Current-main docs were updated separately; older status/checkpoint files and already-merged CF-3 changes were not copied. External `port-provenance.json` records the source hashes.

## PR #496 and project selection

PR #496 head `59e54f6f9ed5cb609b72559eb2478f7e0bad4d5f` has an eight-file merge-base diff from `49ff1e1d214b50adff54799e148669a147f96f7e`, but its current-main tree difference contains only one request-ID identity line and two UI assertion lines across two iPhone files. Its project-selection diagnosis remains separate from the recorded command GET timeout, where the correct project was already selected.

The project-specific action supplies its project ID. A global action supplies an empty ID; NewThreadSheet chooses a valid requested project or the first snapshot project. CompanionServer preserves project order. The fixture exposes that actual first project's name so the new test verifies the contract without forcing a project to expose a skill.

The independent regression alternates project-specific empty-project and global requests three times, cancelling between them and retaining an exact model-owned unsent draft. Baseline `context-baseline-20261108T203304Z` passed one test with zero failures/skips without `.id(request.id)`. The same test passed in all three complete paired runs. The reset is therefore not included; the independent failure was not reproduced. This result does not establish that every possible sheet-identity failure is impossible. PR #496 was not modified or closed.

## Local qualification

Evidence root: `/Users/buns/Documents/Codex/2026-11-08/comp-cmd-2`. Complete local run: `local-20261108T204030Z`; qualification patch SHA-256 `f3270812abc83873c7b8223697413f1acecce914a2602e5bab8f1cbb2c33e5ad`. Its nine-file manifest matched before and after every phase. Final receipt documentation changed afterward; `delivery-candidate-manifest.json` binds the final files and proves all six qualified iOS inputs stayed unchanged.

| Gate | Result |
| --- | --- |
| `pnpm install --frozen-lockfile --offline` | Passed |
| `pnpm build` | Passed |
| `pnpm typecheck` | Passed across workspaces |
| `pnpm run test:coverage` | 2,327 passed, 26 skipped, zero failures; Cobertura retained |
| Native iPhone unit suite | 63 passed, zero failures/skips |
| Complete paired run 1 | 44 passed, zero failures/skips |
| Complete paired run 2 | 44 passed, zero failures/skips |
| Complete paired run 3 | 44 passed, zero failures/skips |
| `env CI=1 MODEX_TEST_OPEN_KNOWLEDGE=1 MODEX_SITE_TEST_PORT=55082 pnpm test:e2e` | 505 desktop passed, four live-provider tests skipped; seven site passed; zero failures |
| Exact candidate verification | Passed; runner exit zero |

Native checks used dedicated iPhone Duo simulator `9C6CF8B1-AC2B-4C6B-9355-F89CA60DF4C5`, iOS 27.2, Xcode 27.2, `MODEX_UI_TIMEOUT_SCALE=4` and separate derived-data/result bundles. XCTest metrics and both named scenario summaries were extracted from each finalized bundle; counts were not inferred from process exit alone. All three runs were consecutive on identical source. The dedicated simulator was shut down before desktop E2E; a second EXIT cleanup logged that it was already shut down.

First-run screenshots were inspected for inline timeout recovery, the retained skill draft, global project selection and the secret-answer screen with its keyboard dismissed and Send answer visible. Secret content was not visible. Exact trailing-space preservation and secure-field completeness are asserted by XCTest rather than inferred from pixels. `visual-inspection.json` and hashed attachments retain these observations.

The earlier unexplained three-pixel Code Review scroll failure and unchanged focused/full confirmations remain historical COMP-CMD-1 evidence. The unchanged scroll test passed at both 1440×900 and 900×600 in this complete run. No Code Review repair or causal explanation is claimed.

## Delivery and acceptance limits

The user authorized signed commits, push of only the owned branch and exactly one draft PR after local qualification. GitHub authentication/push permission, registered SSH signing key and an actual git-namespace sign/verify preflight passed. The exact signed commit/tree, draft PR and hosted macOS/iPhone checks are recorded in external `delivery.json`, `hosted-latest.json` and the draft PR description; read those receipts for publication state. No merge, tag, release or TestFlight upload is part of this goal.

For #276, the automated model/paired receipts support question, draft, secret and focus behavior; they do not complete Val's D/P rows or deferred VoiceOver rows. For #281, three complete paired simulator runs strengthen the automation receipt but do not supply human, physical-device, live-provider or release acceptance. Issue checklist counts and human rows remain unchanged. Four desktop live-provider tests and 26 coverage tests remain explicitly skipped.
