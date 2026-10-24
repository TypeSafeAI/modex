# Strata integration

The user approved the recommendation to integrate Strata through its native Responses endpoint and Codex, with this session as shared integrator and PR #401 as the proposed connection foundation. This branch incorporates #401 at `59bb12b399f843fc2e4ba4fd30afab97e3764bcf` into main `21e50ba4bd7bfbad3b27af6dd13c183f67cb80a5`; prerequisite source branches remain untouched.

Use the existing native backend rather than an HTTP inference client or a protocol proxy. Bind an explicit schema-1 local target and effective context to a thread. A main-owned execution service resolves the connection revision and credentials, isolates Codex configuration and authentication, serializes work per local service, and remembers only the native sessions it owns. Missing or stale targets, unsupported inherited configuration, and persisted sessions from an earlier process fail closed. Local turns bypass cloud accounts, Auto, Jev, generated titles, follow-ups and credit fallback. Ordinary text/tools retain native approvals and Stop; Plan, images, external tools and restart resume remain unavailable pending qualification.

Expose connection setup and explicit model selection on an existing thread. The person supplies a loopback server, exact model identifier and effective context; Strata defaults are a convenience, not automatic runtime launch or discovery of weights. Show local selection and its unverified locality clearly. Switching target starts a fresh native conversation while preserving transcript history. Do not claim offline operation.

Alternatives considered: a new inference client conflicts with the repository's native-harness contract; a separate Strata backend duplicates events and approvals. The approved approach extends the shared Responses route and existing Codex event handling.

Verify exact RPC model/provider pinning, no auth retry, credential isolation, changed profiles, queued cancellation, Stop isolation and absence of auxiliary calls. Run required build/unit/type checks and UI E2E. Real Strata qualification is additional evidence and must preserve runtime ownership and global settings.
