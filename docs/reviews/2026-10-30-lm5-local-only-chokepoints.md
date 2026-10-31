# LM-5 local-only chokepoints (#380), 2026-10-30

Issue #380 remains open. This slice moves the no-cloud-fallback rule for local threads from each caller to the
point where each auxiliary call is made. It is cut from `main` at `f51ef7e`. It does not admit product local
execution: `main` still constructs no `LocalExecution`. It also qualifies no native runtime as offline.

## What changed

- **Predicate.** `localOnly(thread)` in `engine/local-models/run-policy.ts` is true for any persisted local
  target, valid or not.
- **Jev.** `Decisions.guardThreads` lets the runner register that predicate. `Decisions.connect` then returns
  `{ transport: null }` for any question naming a local thread, and returns before key resolution or CLI
  detection. This covers routing, follow-up and approval.
- **Credit fallback.** `creditFallback` and `recentCreditFallback` return nothing for a local thread.
- **Naming.** `nameThread` returns before any title model is asked.
- **Unattended turns.** `sendUnattended` refuses a local thread with "A routine can't run on a local model".
  It neither runs nor reroutes the turn.

The callers' existing guards are unchanged.

## Verification

New regression: `runner-local-models.test.ts`, "main's local-only rule holds where each auxiliary call is made,
whichever caller reaches it". It calls each chokepoint directly, bypassing the runner's caller checks:

| Chokepoint | Control (cloud) | Local thread |
| --- | --- | --- |
| `Decisions.connect` (`routing`) | transport returned | no transport, 0 Jev requests |
| `Decisions.connect` (`follow_up`, `approval`) | not run | no transport, 0 Jev requests |
| `Router.route` / `Router.followUp` called directly | not run | 0 Jev requests |
| `creditFallback` (Fable, "requires usage credits") | `opus` | none |
| `recentCreditFallback` (Fable refused within the hour) | `opus` | none |
| `nameThread` with a backend that can name | not run | 0 title calls, title unchanged |
| `sendUnattended` in Chat | not run | rejected; 0 local, 0 cloud, 0 Jev |

**Negative controls.** Each guard was disabled in turn in the compiled `dist` output, and the regression failed
each time:

- Decisions guard: `AssertionError: routing`.
- `creditFallback`: strict-equal failure.
- `recentCreditFallback`: strict-equal failure.
- Naming: strict-equal failure.
- Unattended: `Missing expected rejection`.

The original files were then restored, verified byte for byte with `cmp`, and the case passed again.

**Results:**

- Focused suites (`runner-local-models`, `local-run-policy`, `routing`): 56/56.
- Full-check results are recorded in the PR.

## Still open on #380

- the native network-denied offline canary (AC2), which needs Val's authorization and an installed local coding
  model;
- runtime effective-context evidence (AC6);
- OOM, overflow and restart behaviour against a real runtime (AC4);
- product admission of `LocalExecution`, which is Val's decision.
