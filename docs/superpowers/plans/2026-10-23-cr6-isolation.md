# CR-6 Phase 1 isolation proof

**Status (2026-10-30): delivered** in #396 (`03ce71a`); Phase 2 followed in #422 (`b643617`) and the exit-ownership repair #426, all shipped in v0.4.0. Evidence: [isolation](../../reviews/2026-10-23-cr6-isolation.md), [native review](../../reviews/2026-10-28-cr6-native-review.md). An authenticated live run and C82 remain open on #325.

Investigate installed native CLI controls without enabling review or starting inference. Keep CR-6 capability gates unchanged, preserve C82, and leave Phase 2 gated on #393/#395 landing.

1. Inspect current contracts, backend launches, approvals and journal semantics. Record installed versions and current official controls, separating documentation from observed enforcement.
2. Use disposable synthetic repositories, homes, credentials and loopback listeners. Probe the installed Codex sandbox with positive read/network controls and negative writes/network/secret/symlink checks; also record allowed shell and environment access as counterexamples to treating read-only as confinement.
3. Probe Claude with disposable configuration, a cloned installed executable and an outer home/credential-service/network guard. Use init-only for the positive hook control and a scripted loopback provider for actual injected tool calls and the MCP control. Require working controls before interpreting absent markers. Treat timeout or parse failure as unverified, never denial. Do not start live inference or use real authentication.
4. Commit an opt-in native proof suite and a criterion-level report. Record exact invocation, versions, original failed invocations, counterexamples, residual controls requiring a live authorized canary and one next action. Keep candidate controls separate from production support.
5. Run full build/unit checks and focused proof tests, obtain independent security review, sign and open a reviewable PR. No merge or release. Any live inference requires separate explicit authorization and a cost limit.
