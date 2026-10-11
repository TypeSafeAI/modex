# Gemini CLI feasibility (#78)

## Current decision, 2026-10-11

**Defer the backend.** macOS ACP, a real text turn, resume, and cancellation now have live
evidence. Permission enforcement and account-source reporting still do not meet the release
contract. This is an acceptance deferral, not a claim that Gemini cannot support an adapter.

Gemini was absent from this Mac's PATH (`spawnSync gemini ENOENT`). An isolated npm install
of `@google/gemini-cli@0.63.0` under `apps/desktop/.probes/` supplied a pinned candidate without
changing the global CLI. On Darwin arm64/Node `24.18.1`, protocol 1 advertised `default`,
`autoEdit`, `yolo`, and `plan`; setting `plan` succeeded. The existing CLI-owned account
completed a synthetic `ACP_PROBE_OK` response without tools, reloaded the nonempty session,
and returned `stopReason: cancelled` for an interrupted second prompt.
[Wire summary](reviews/2026-10-11-gemini-acp.json).

No browser login, credential import, or direct inference API was used. API-key/Vertex
environment selectors were removed from the child environment. Cached configuration can
still affect credential precedence; successful inference does not establish which account,
subscription, or billing source was used. This CLI has no dedicated structured auth-status
command in its installed help. Do not show verified subscription/account status from this probe.

The [follow-up permission probe](reviews/2026-10-11-gemini-permission-probe.json)
failed at `initialize: timeout after 15000ms` before any
permission request or negative write test. The owned process exited on SIGTERM. The earlier
successful session required bounded SIGKILL escalation at shutdown. The failure establishes
a local acceptance gap, not an inherent protocol limitation or an authentication failure.
An [empty session reload](reviews/2026-10-11-gemini-empty-session.json) also returned
`-32603 Internal error`; nonempty resume succeeded,
so the empty-session error is not evidence that general resume is unsupported.

| Gate | Current evidence | Decision |
| --- | --- | --- |
| Authentication/model access | Existing CLI account completed a text turn | Model access works; identity/source/expiry/switching remain unverified |
| Read-only enforcement | `plan` advertised/accepted; negative permission run timed out before initialization | Blocked; no observed denied edit, shell, MCP, symlink, or outside-root attempt |
| Approvals | Probe rejects every client permission/tool request, but successful smoke turn made none | Allow-once/deny/always round trip not accepted |
| Cancellation | Interrupted prompt returned `cancelled` | Passed for this sample only |
| Resume | Reload after text turn succeeded | Same-process, same-account sample; cross-process/account ownership still open |
| macOS | Real protocol and model calls on arm64 | Native transport demonstrated; permission and cleanup acceptance incomplete |

Native plan mode is policy-driven. Google's [plan guide](https://geminicli.com/docs/cli/plan-mode/)
allows custom policy overrides, and the [policy engine](https://geminicli.com/docs/reference/policy-engine/)
applies rules without a mode restriction in every mode. The default
[macOS sandbox](https://geminicli.com/docs/cli/sandbox/) allows workspace writes.
Consequently, mapping Modex chat to `plan` alone does not prove an immutable read-only boundary
under inherited CLI policies. A candidate adapter needs controlled policy and filesystem,
shell, MCP, and canonical-root tests before selection is enabled.

Reproduce from the worktree root:

```sh
npm install --prefix apps/desktop/.probes/gemini-0.63.0 --no-audit --no-fund @google/gemini-cli@0.63.0
node apps/desktop/scripts/probe-provider-acp.mjs gemini apps/desktop/.probes/gemini-0.63.0/node_modules/.bin/gemini
MODEX_ACP_LIVE=1 MODEX_ACP_PERMISSIONS=1 node apps/desktop/scripts/probe-provider-acp.mjs gemini apps/desktop/.probes/gemini-0.63.0/node_modules/.bin/gemini
```

Without `MODEX_ACP_LIVE`, no prompt is sent. Live mode spends bounded model usage; permissions
mode additionally asks for writes only inside its disposable fixture, denies every incoming
permission request, and records whether a fixture file appeared. No request is approved.
Review `error`, `toolUpdates`, `rejectedRequests`, and `fileCreated`; a missing write with no
attempted tool does not prove enforcement. The CLI may retain its own synthetic session history.

Next action: run the negative permission probe under a controlled CLI policy and resolve the
initialization timeout if it recurs; then verify canonical roots/symlinks, MCP, restart-resume,
and account-source transitions. Do not retry account/model calls merely to turn this record green.
The additional-provider authorization covers gated implementation, but no backend has passed
all gates, so the production provider set remains unchanged.

## Historical Windows research (2026-10-03)

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
