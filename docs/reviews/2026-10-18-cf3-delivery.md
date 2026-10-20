# CF-3 answer delivery repair

An accepted answer now stays `sending` until the backend reports its local write receipt.
Withdrawal, Stop, stale authority, or transport failure before that receipt produces an inert
`uncertain` card. Modex never retries that decision automatically. A successful write does not
prove remote execution.

This repairs [#293](https://github.com/TypeSafeAI/modex/pull/293), for
[#276](https://github.com/TypeSafeAI/modex/issues/276). The repair branch is based on current main
`b804e9c6`, after #293, CF-6 request journal/reconnect, and CF-7 clarification landed.
It preserves their `sending` delivery state and `answeredBy` receipts.

## Evidence by requirement

| Requirement | Evidence |
| --- | --- |
| Acceptance is distinct from delivery | `human-requests-runner.test.ts`: acceptance followed synchronously by native withdrawal or Stop writes no answer and records uncertainty. Native approval receipts wait for the write callback. |
| Stale identity and actions cannot authorize work | Runner tests change backend, account, action, approval rules, standing automatic policy, and mode before handoff. Broker tests reject wrong thread, turn, attempt, backend, account, item, runtime, and native request ID. Requests and accepted answers are cloned. |
| One local answer and one write attempt | Broker duplicate-client tests; identical native replay retains its card/controller, changed replay withdraws it, and a held write callback cannot admit a second delivery. Both Codex and Claude ingress are covered. |
| Transport failures remain uncertain | Failed callback, actual Writable error, and close before callback fixtures. Restart E2E converts saved `sending` cards to inert `uncertain` cards. No reconnect or restart path resends the decision. |
| Sensitive answers stay private and unchanged | Question E2E sends a password value with surrounding whitespace unchanged, stores only `(hidden)`, and scans every file under the test home. Runner tests scan persisted items and emitted events. Companion tests omit question answers entirely. |
| Policies and compatibility remain intact | Existing Ask/Always/YOLO, explicit Never, escalation, routine refusal, and permission-profile tests remain the required regression gates. Manual Ask-to-YOLO resolution remains supported. Phones receive sending/uncertain approvals as notices they can render without approving them. The offline backend acknowledges local consumption explicitly. |

The regression tests were observed failing before their corresponding repairs. These are protocol
fixtures and automated app tests. They are not human keyboard-only or VoiceOver acceptance.

## Installed native schema

On 2026-10-18, `codex --version` reported `codex-cli 0.163.0`; `claude --version` on this
session's PATH reported `2.1.289 (Claude Code)`. No live coding turn was run for this repair.
The earlier CF-2 live receipt for Claude Code 2.1.302 remains separate evidence.

Both stable and experimental output from `codex app-server generate-json-schema` contain the
`item/tool/requestUserInput` schema, whose description marks it experimental. The generated
request has required `threadId`, `turnId`, `itemId`, `isBlocking`, and `questions`. Its response
requires `answers`. `serverRequest/resolved` requires `threadId` and `requestId`.

Generated schema SHA-256 values:

- Request: `fda15b62e7446105b59c8ed85c908abed2a47db70653e57c92c47a2f204fa77a`.
- Response: `5073b245f741fa8ce62ec52e4dd1809b7831f9c4284c279a78abc9b171f8e3f2`.
- Resolution notification: `4f03d586a5af04edd912cad08cc97eceb658e7e06744565e6d41a93e04a55966`.

Schema generation establishes the installed protocol shape. Actual native question acceptance,
human accessibility acceptance and phone question entry remain open
in #276. The preview approval gate remains off by default.

## Verification status

Current-main verification:

- `pnpm build`: passed.
- `pnpm typecheck`: passed across all workspace packages.
- Focused runner, broker, journal and companion tests: 61 passed.
- Full root `pnpm test`, with test files serialized through a local ignored Node launcher:
  1,789 passed, 16 skipped, no failures. No tests were filtered or timeouts changed.
- Full `MODEX_TEST_OPEN_KNOWLEDGE=1 pnpm test:e2e`: desktop 347 passed, 1 skipped,
  4 failed, plus an `afterAll` shutdown hook error. Site tests did not start in that command.
- Retried the complete app, approval and Markdown narrow specs on unchanged source: 19 passed.
  This covers all four failed cases and their shutdown hooks. The full-run failures remain recorded;
  the first app stall occurred before an approval existed, and process sampling showed a native
  modal. Disk space repeatedly fell below 400 MB during the run. These observations do not prove
  disk pressure caused every failure.
- Separate site E2E: 7 passed.

The image override and denial regressions were both observed failing before repair. Independent
source review identified the denial receipt omission; the fixed case now passes. The preview gate remains off by default. No native question or human accessibility acceptance is claimed.
