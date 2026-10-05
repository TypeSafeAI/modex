# Grok Build feasibility (#79)

Reviewed 2026-10-03 against Modex main e2c2fbc and Grok CLI 0.2.118
(stable, build 1e1687c1cf) on Windows.

**Decision: conditional go for a CLI-owned ACP backend; no-go for a public Modex-owned
OAuth implementation or an enabled backend today.** This PR adds research only. A future
backend requires an explicit amendment to AGENTS.md's Claude/Codex-only rule and review
of the adapter's permission guarantees.

## Supported access paths

[Grok's CLI reference](https://docs.x.ai/build/cli/reference) and
[enterprise guide](https://docs.x.ai/build/enterprise) describe CLI login, device login,
and enterprise configuration. Installed `grok login --help` confirms `--oauth` and
`--device-auth`. Let the official CLI own credentials and renewal. Enterprise OIDC and
API-key billing are separate from personal subscription access.

[The Grok Build announcement](https://x.ai/news/grok-build-cli) documents subscription
access and ACP; [the official Warp integration](https://x.ai/news/grok-warp) demonstrates
subscription use in a third-party client. Neither establishes a generally available
registration/token contract for a new public Modex OAuth client. That path remains
unverified, rather than declared impossible. No private endpoints or credential scraping.

## Observed wire evidence and documentation drift

An owned `grok --no-auto-update agent --no-leader stdio` process accepted JSON-RPC
`initialize` with protocolVersion 1 and empty client capabilities. It advertised
loadSession, embedded context and HTTP/SSE MCP support; image/audio were false. Its only
auth method was **`grok.com`** and defaultAuthMethodId was null. It advertised session
listing and vendor filesystem/hook extensions. A model catalogue appeared in vendor
metadata; it is not evidence of sign-in, billing plan or inference entitlement.
The process was terminated after initialization; no authenticate, session creation,
browser login or prompt was sent. Personal identifiers and paths from vendor metadata
are omitted here.

[The headless ACP example](https://docs.x.ai/build/cli/headless-scripting) uses
`cached_token` or `xai.api_key` authentication IDs. **Those IDs were not advertised by
this installed version.** Copying the example would fail. Negotiate authMethods and
version-test supported behavior; do not invent a cached-token request or silently choose
API billing. `--no-leader` avoids accidentally joining an existing user's controller.
The docs demonstrate prompt completion metadata and streamed session/update text.

| Modex contract | Candidate implementation | Unverified blocker |
| --- | --- | --- |
| streaming turns/tool/thinking | ACP session/prompt + session/update | Full typed event coverage and final/error ordering |
| approvals | ACP permission requests, possibly vendor hooks | Prove deny/allow-once/always semantics; unknown requests denied |
| chat and plan read-only | negotiated modes and policy enforcement | No proven plan/read-only wire behavior; never substitute --always-approve |
| cwd/worktree/addDirs | session/new cwd, client filesystem/terminal gates | Constrain every command/write, symlinks, MCP and vendor fs notifications |
| resume | loadSession advertised | session/load round-trip, ownership and account change fixtures |
| models/effort | vendor model metadata and configured model | Versioned extension, quota failures, no entitlement inference |
| cancel/dispose | ACP session/cancel and own child shutdown | Bounded acknowledgment, subprocess cleanup, no shared leader shutdown |
| authentication/status | negotiated grok.com method, CLI login | Noninteractive cached account check, no browser on settings open |
| title/follow-up | bounded separate CLI conversation | Match execution/approval policy, avoid hidden readiness spending |

## Bounded next step and release gates

Pin 0.2.118 as the first candidate tested version; an earliest supported release has not
been established. First build a fixture-backed ACP transport shared with a proposed Gemini
adapter, with provider-specific capability parsing. Confirm the effective subscription,
enterprise or API source without reading credentials. Unknown remains unknown.

Before enabling a selector: verify real negotiated authentication with user participation,
a completed subscription-backed turn, rejected edit/command in chat and plan, worktree
isolation, resume, cancel, concurrent turns, token expiry, quota failure and source
precedence. Reproduce on macOS Apple Silicon; Windows initialize is the only local live
platform evidence. Linux/Windows product support needs separate native testing.

Keep direct API adapters and app-owned OAuth out of that first implementation. The
public OAuth registration question can be revisited with an official documented contract.
The research issue is complete with this conditional decision; the backend remains disabled.
