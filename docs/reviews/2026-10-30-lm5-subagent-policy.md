# LM-5 effective subagent admission — 2026-10-30

Issue #380 requires unqualified native subagents to stay disabled. LocalExecution already passes `features.multi_agent=false` and `features.multi_agent_v2=false`, but admission verified only the effective image flag. A pure-policy probe using a modified historical receipt admitted either subagent flag as true. This establishes a missing effective-value check, not observed native subagent execution.

Admission now requires both effective subagent flags to be explicitly false. True, missing, null, string and object values are refused by key before a native thread opens. Existing layer/provenance, destination and credential checks remain in force. A CLI that omits either flag is refused rather than treated as qualified; product local execution remains unadmitted.

A configuration-only probe of installed codex-cli 0.166.0 in a temporary empty home reported both flags false and their origins as session flags. `features list` also reported both stable and false. The probe created no thread, sent no prompts and ran no inference. Its [trimmed receipt](2026-10-30-lm5-subagent-policy/config-receipt.json) supports the reported configuration shape, not offline execution or qualification of older CLI versions.

## Verification

The clean baseline passed build and full unit checks (2,244 passes, 26 skips). Ten new pure-policy cases first failed because no exception was thrown. After the two effective-value checks, the focused policy/execution suites passed 26 tests with no failures or skips. Execution fixtures also verify that enabled and missing values produce a failed turn with no `thread/start`, no `turn/start` and no admitted provenance. Final `pnpm build && pnpm test` completed with exit 0: 2,254 passes, 26 skips and zero failures. Independent read-only review found no blocking findings. Protected delivery remains pending.

Logs are preserved outside the worktree under `~/Documents/Codex/artifacts/modex-land-and-prune/lm5-subagent-*`. This repair addresses an admission invariant only. The native offline canary, full auxiliary matrix, capacity/runtime qualification, entry-point policy, context evidence and human acceptance remain open; #380 is not complete.
