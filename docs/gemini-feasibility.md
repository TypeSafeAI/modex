# Gemini CLI feasibility (#78)

Reviewed 2026-10-03 against Modex main e2c2fbc and installed Gemini CLI 0.58.0.

**Decision: conditional go for a CLI-owned ACP backend; no-go for enabling it today.**
No provider selector, credential importer, direct inference API, or policy exception ships
with this research. AGENTS.md currently limits coding backends to Claude and Codex; a
future implementation PR must explicitly propose the additional CLI and receive review.

## Identity, subscription, and credential ownership

[Google's authentication guide](https://geminicli.com/docs/get-started/authentication/)
documents browser sign-in through Gemini CLI. Personal accounts can use the CLI's free
allowance; Google AI Pro/Ultra users sign in with their subscribed account. Organization
accounts may require a Cloud project. Gemini API keys and Vertex AI are distinct billing
paths. Modex must show the effective CLI auth source and must not silently change it.
Google website identity OAuth alone is not authorization to spend a consumer subscription;
[Gemini API OAuth](https://ai.google.dev/gemini-api/docs/oauth) is a separate API integration.
Leave credentials, refresh, login/logout and account selection with Gemini CLI.

The CLI's help exposes no dedicated structured auth-status subcommand. ACP initialization
advertises authentication methods but does not establish sign-in or entitlement. Report
unknown until a supported account check succeeds; never inspect cached token files.

## Local evidence and contract mapping

Windows 11, Node 24.18.0: `gemini --version` returned `0.58.0`; help advertises `--acp`,
`--approval-mode plan`, `--sandbox`, `--resume` and `--include-directories`.
An owned `gemini --acp` process accepted one JSON-RPC `initialize` request with
`protocolVersion: 1`, empty client capabilities, and Modex client attribution. It returned
agent version 0.58.0, `loadSession: true`, image/audio/embedded-context support, HTTP/SSE
MCP support and auth method IDs `oauth-personal`, `gemini-api-key`, `vertex-ai`, `gateway`.
The probe then terminated its own child. It sent no authenticate/session/prompt request,
opened no browser, and tested no account or paid model access.

[ACP documentation](https://geminicli.com/docs/cli/acp-mode/) establishes stdio JSON-RPC,
authentication, session creation/loading, streaming prompts, cancellation, mode/model
control and client-proxied file access. Its TypeScript method names are not sufficient
wire evidence: use negotiated ACP schemas and fixtures, not names copied from prose.

| Modex contract | Proposed mapping | Remaining release gate |
| --- | --- | --- |
| runTurn + text/thinking/tool callbacks | session/prompt + session/update | Correlate IDs, duplicate/final chunks, failure and interrupted stop reasons |
| approval(req) | session/request_permission | Map allow-once/always/reject; unknown kinds denied; never auto-approve |
| chat / plan / agent modes | session modes and explicit CLI policy | Prove read-only behavior for every edit/terminal/MCP path; fail closed if unavailable |
| cwd / worktree / addDirs | session/new cwd and explicit permitted roots | Canonicalize paths, symlinks and out-of-root writes; do not auto-trust new projects |
| resume | advertised loadSession | Actual session/load, cross-account ownership and missing-session fixtures |
| listModels / effort | negotiated session model configuration | Exact model wire extension/version, entitlement unknown, unsupported effort omitted |
| abort / dispose | session/cancel; owned process shutdown | Acknowledge cancellation, bounded escalation, preserve other sessions |
| title / follow-up | separate bounded CLI conversation | Respect provider policy; no hidden paid readiness probe |

## Bounded implementation plan

1. Pin 0.58.0 as the first **candidate tested version**, not a proven historical minimum.
   Detect executable/version and negotiate protocol 1/capabilities before exposing actions.
2. Add an ACP transport with bounded pending requests and strict schemas. Implement the
   Backend adapter and approval/file/terminal gates with adversarial fixtures first.
3. Add CLI-owned login recovery and account-source status using #75's typed model. Keep
   credentials out of renderer/state/logs; expose unsupported/unknown honestly.
4. Verify a sandboxed fixture project on macOS Apple Silicon (Modex's release platform),
   then Windows/Linux explicitly. Current live evidence covers Windows initialize only.
5. Before selection is enabled, capture one user-approved authenticated turn, denied edits
   in chat/plan, allowed worktree edit in agent mode, resume, cancel, concurrent sessions,
   model failure and account-change behavior. Record quota errors distinctly from sign-out.

This completes the feasibility decision. Actual integration is a separate scoped change;
the approval/read-only and account-status gaps are hard blockers to enabling it.
