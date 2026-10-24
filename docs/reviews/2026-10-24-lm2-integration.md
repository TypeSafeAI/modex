# LM-2 contract and credential integration

The integration includes LM-1 at `c30633d797a11e80046bc7f2b856f1053c094e5f` and LM-2 at `954cd5b7d0627333835db41f9b0dfb477b72176f`. It retains the earlier versioned credential commit ordering and token-reflection protections.

Independent review found that discovery emitted model references without the shared schema and that an unavailable configured credential silently became anonymous metadata access. The first regression reproduced an invalid local target for a discovered identity. The second reproduced an anonymous request instead of rejecting the missing credential. Both failures were preserved before production changes.

Discovery now uses the shared `ConnectionRef` and `LocalModelRef`, includes schema 1 for discovered and manual IDs, and preserves exact IDs. Connection resolution rejects an unreadable configured credential with a sanitized error; intentionally tokenless profiles still resolve and discover normally. Missing files, a locked cipher and corrupt ciphertext are covered through real store and loopback request paths.

Baseline `pnpm build` and `pnpm test` passed before repairs. The repaired focused local-model suite passes all 34 tests. Post-change `pnpm build`, `pnpm test` and `pnpm typecheck` also passed. The targeted Electron `local-models-ipc.spec.ts` passed 1/1 through the registered local-only service. Independent review approved both repairs, including fail-closed rejection if credentials become unreadable during a request. Hosted checks are pending. Logs are preserved outside the checkout under `Documents/Codex/artifacts/modex-land-and-prune/resume-2026-10-24/`.

This is fixture evidence for connection/discovery behavior. It does not establish real Ollama/LM Studio compatibility, enable inference, qualify runtime capabilities, or satisfy human/device acceptance.

PR #400 publishes a later producer helper/runtime mapping; adoption is pending the explicit Gate A and metadata-policy decisions. This repair remains a draft and makes no claim that those decisions have been accepted.
