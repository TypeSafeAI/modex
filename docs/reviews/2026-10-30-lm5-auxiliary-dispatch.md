# LM-5 auxiliary dispatch regression coverage — 2026-10-30

Issue #380 remains open. This test-only change extends the Runner boundary evidence on main `a34edc75e34c9eaba2b18eccecfeff417b2cd887`; it does not admit product local execution or qualify a native runtime as offline.

The fixture uses the real Router, Decisions service and approval gate with an injected recording Jev transport. A cloud exact-rule approval reaches that transport once, proving the control is connected. A local exact-rule approval answers deterministically with its persisted receipt and sends zero Jev requests. A local natural-language-only rule waits for a human, sends zero Jev requests and forwards the person's denial to the local backend.

Four local failure fixtures cover insufficient credits, out of memory, context overflow and a thrown disconnect. Each retains the selected local target, reports an error, offers no automatic follow-up and records one local dispatch with zero cloud, title, knowledge/pages or Jev dispatches. These fixtures exercise Runner outcomes; they do not reproduce native OOM or context handling and do not establish every auxiliary path or failure combination.

## Verification

The focused suite passed 13 tests with no failures or skips. A temporary mutation of the compiled Runner removed the local approval guard: both local-approval regressions failed on one unexpected Jev request. The cloud control passed. The original compiled file was restored byte-for-byte (SHA-256 `6ef9e534bfc8c8d55871937b9e3fe571ad56fa03c80b72f69b00eed386958a54`), and all 13 cases passed again. Production source is unchanged.

Initial focused runs failed because the cloud control inherited the local fixture's deliberately refusing tool adapters, then an invalid undefined knowledge lease. The final control omits those unrelated adapters; failure-path fixtures retain the adapter counters. An overlapping initial full run observed that same fixture failure and is not clean-baseline evidence. Final `pnpm build && pnpm test` completed with exit 0: 2,251 passes, 26 skips and zero failures. Independent read-only review found no actionable findings. This change does not alter UI or production behavior; no new desktop E2E run was needed for this test-only slice. Protected delivery remains pending.

Logs and the mutation receipt are preserved outside the worktree under `~/Documents/Codex/artifacts/modex-land-and-prune/lm5-auxiliary-*`. The native offline canary, full auxiliary network-spy matrix, shared-service capacity/subagent qualification, entry-point policy, context provenance and human acceptance remain separate LM-5 gates. No issue closure or native acceptance is claimed.
