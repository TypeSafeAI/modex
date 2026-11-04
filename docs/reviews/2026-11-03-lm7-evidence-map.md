# LM-7 criterion-to-evidence map, 2026-11-03

Draft for #383, against `main` at `b785054e88836ac9df5ca917425031ab697d4d30`. **This is a map, not acceptance.** No LM-7 criterion is met today. The integrated workflow doesn't exist yet: `main/index.ts` constructs no `LocalExecution`, LM-4 (#381) and LM-6 (#382) are not built, and no real local model has run.

Evidence named "in #475" or "on `lm-ready`" is not on `main`:
- **#475:** rebased as `lm5-fixtures-rebased`.
- **`lm-ready`:** the `~/.codex/config.toml` byte check and the token records.

## Evidence by level (LM-7 AC2)

| Producer | Protocol / unit | App fixture | Real Electron | Real runtime | Network-denied | Human |
| --- | --- | --- | --- | --- | --- | --- |
| LM-1 #377 (accepted) | `test/local-model-contract.test.ts` | Not applicable | Not applicable | Strata combination only: `docs/reviews/2026-10-24-lm1-acceptance.md` | Not run | Val's Gate A, same record |
| LM-2 #378 | `test/local-model-connections`, `-discovery`, `-endpoint`, `-ipc` | Same suites over loopback fixtures; token records on `lm-ready` | `e2e/local-models-ipc.spec.ts` | Not run: no local generative model | Not applicable | Acceptance not recorded |
| LM-3 #379 | `test/local-model-execution`, `local-run-policy` | `test/runner-local-models.test.ts`; byte check on `lm-ready` | Not run: no UI, unadmitted | Installed Codex with a scripted server only: `docs/reviews/2026-10-26-lm3-local-codex.md`. Live AC1 not run | Not run | Managed-Mac AC6 not run |
| LM-5 #380 | `test/local-run-policy`, `local-model-execution` | `test/runner-local-models.test.ts`; `docs/reviews/2026-10-30-lm5-*.md`; more in #475 | Not run | Installed Codex with a scripted server, in #475. Real-runtime AC4 not run | AC2 canary not run | Admission decision open |
| LM-4 #381 | Not run: not started | Not run | Not run | Not run | Not applicable | Screen-reader checks not run |
| LM-6 #382 | Not run: not started | Not run | Not run | Not run | Not run | Not run |

"Installed Codex with a scripted server" proves the harness path, not a model. It belongs in no "real runtime" claim about inference.

## Implementation steps

| # | Criterion (short) | Existing receipt | Missing | Owner |
| --- | --- | --- | --- | --- |
| S1 | Golden and negative fixtures; every producer criterion mapped | This map; `docs/reviews/2026-11-01-issue-checkbox-reconciliation.md` holds per-producer rows | The golden fixture design; refresh once #475 and `lm-ready` land | LM-7 |
| S2 | Settings → model → plan/read → approved edit → test → diff → Stop/continue → restart, on known bytes | **Missing.** Partial pieces: the scripted shell read in `test/local-codex-native.test.ts` | The whole flow. Needs LM-4, admission and a model. `e2e/local-model-acceptance.spec.ts` does not exist | LM-7, after LM-4 |
| S3 | Adversarial cases with action counts and file bytes | Same model on two connections and late answers: `local-model-discovery`. Profile and token changes: `local-model-execution`. Corrupt targets: `local-model-contract`, `runner-local-models`. Queue cancellation: `local-model-execution`. Overflow, OOM, server loss, one tool run: in #475. Images refused: `local-model-execution` | Truncated arguments, invalid schemas, duplicate or late frames on a local turn; stale capability evidence through the app; everything on a real runtime | LM-7, LM-5 |
| S4 | Paired desktop, Store and iPhone: provenance, denial, Stop, reconnect | Paired desktop can't select a target: `runner-local-models`. The allow-list for every other client is in #475 | **Missing:** inference-host display, stale controls and old-client fallback. Needs LM-4 | LM-4, then LM-7 |
| S5 | PR CI stays offline and GPU-free; native, network-denied and human gates stay separate | Native tests skip unless `MODEX_LM3_WIRE` or `MODEX_LM3_LIVE` is set: `test/local-codex-native.test.ts` | The written gate list for the acceptance spec | LM-7 |
| S6 | Record OS, SHA, CLI, runtime, model, parser, context; measure cold and warm turns | Partial: codex-cli versions in the LM-3 and LM-5 receipts; LM-1's Strata inventory | **Missing:** any measurement on named hardware | LM-7, real runtime |
| S7 | Setup, coverage, caveats, remedies, migration, rollback docs; disable preserves profiles and history | Engineering doc only: `docs/local-models.md` | **Missing:** setup and rollback docs, and a disable test. The site makes no local-model claim today, so nothing there needs correcting yet | LM-7 |
| S8 | Cloud, account, approval, worktree, Changes, Notes and recovery regressions on a pinned candidate | Per-PR full suites only | **Missing:** an integrated candidate | LM-7 |

## Acceptance criteria

| AC | Criterion (short) | Existing receipt | Missing | Waits on |
| --- | --- | --- | --- | --- |
| AC1 | Golden workflow through real Electron, main and native, with observed file and test evidence | None | All of it | Admission, LM-4, a model |
| AC2 | Separate columns per evidence level | The table above is the first draft | Filled cells | LM-4, LM-6, native gates |
| AC3 | Each advertised combination has versioned native evidence | Only LM-1's Strata combination, with no coding-turn evidence through Modex | All of it. Nothing is advertised yet | LM-6, a model |
| AC4 | Fresh build, test and E2E results name the candidate SHA | Producer runs only: the `Validation` sections of the review records above | A candidate SHA and its run | Integration |
| AC5 | No silent cloud fallback, action replay, profile bleed or misleading offline claim | Cloud fallback: `runner-local-models` ("a failed local turn stays failed", "a forged, stale or unloadable persisted target"). Auxiliary calls: `docs/reviews/2026-10-30-lm5-local-only-chokepoints.md`, `2026-10-30-lm5-auxiliary-dispatch.md`. Cloud-routed models: `2026-10-30-lm5-cloud-routed-models.md`. Profile bleed: `local-model-execution`. Replay: in #475 | Network-denied proof; a redirect is recorded, not prevented (`2026-10-27-lm5-destination-policy.md`); no offline claim can be made yet | AC2 canary on #380, Val's reading of the redirect limit |
| AC6 | Paired clients preserve target, provenance and authority; older clients can't alter local controls | Refusal at main: `runner-local-models`, plus #475's allow-list | **Missing:** client display and any older-client test | LM-4 |
| AC7 | Reproducible setup and rollback; no cloud regression; docs match evidence | Removing the one wiring line restores refusal: branch `lm5-admission`, not on `main` | **Missing:** user setup and rollback docs, disable behaviour, integrated regression | LM-4, LM-7 |

## Next action

Once Val answers the admission brief, LM-4 starts. LM-7 can design `e2e/local-model-acceptance.spec.ts` against fixtures at any time, using `test.skip` with the gate named for anything that needs admission or UI.
