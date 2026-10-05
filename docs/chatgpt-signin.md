# App-owned ChatGPT sign-in through Codex (#76)

Settings → Coding CLIs offers **Continue with ChatGPT**, account selection,
reauthorization and sign-out. Actions apply immediately. Existing Codex CLI authentication
remains available. Each saved account label includes its issued registration so two
workspaces with the same email remain distinguishable.

Modex opens the system browser after binding an ephemeral `127.0.0.1` listener at exactly
`/auth/callback`. Each attempt has independent PKCE S256, state and nonce values. New
registrations start with `dynamic_agent_client`, stable host identity and `agent_name_hint=modex`;
token exchange and subsequent authorization use the issued client ID. ID-token signature,
issuer, audience, expiry, nonce and subject are verified before activation. Returning
authorization cannot replace a different subject or issued registration.

Credentials live in `app/chatgpt.enc`, encrypted by Electron safeStorage (DPAPI or macOS
Keychain). Linux `basic_text` storage is rejected. There is no plaintext fallback or
renderer token IPC. A host-wide credential lock prevents separate Modex instances from
racing rotating refresh tokens; within the owning process refreshes are serialized.
Encrypted updates are written to a unique private temporary file, flushed and renamed.

Codex gets the access token only in its own child environment as `ACCESS_TOKEN`. The
Responses provider is configured by documented non-secret CLI overrides; Modex makes no
inference HTTP calls. `initialize` attributes the client as modex with the real app version.
Credential strings are redacted from protocol text and process-exit diagnostics.
Codex's shell environment filters exclude ACCESS_TOKEN, with an empty explicit override
to prevent an inherited user `set` value from carrying the app token into shell tools.

There is one shared Codex process **per registration**, plus the original CLI-auth process.
A turn's lease begins before asynchronous initialization. Resume handles and background
titles stay with the original identity, including after account selection changes; old
unbound handles are assigned to CLI auth. A token renewal drains that registration before
replacing its child and resuming on the next request. New turns fail with a retry message
while an old turn prevents renewal; no tool execution is replayed. Reauthorization and
sign-out refuse active/initializing consumers and block new ones during the operation.
An explicit second Stop is limited to the thread's account process.

The app requires returned plan scopes before execution. Model catalogues and successful
identity checks are not entitlement tests. Failed and interrupted turns do not verify
model access; only a completed request does. An identity-only grant cannot run a turn.

Sign-out revokes the refresh token at the endpoint discovered from OpenAI metadata,
retries a failed request once with backoff, then clears local credentials. If remote
revocation is unconfirmed, the UI says so and points to ChatGPT Settings. Registration and
host identity remain for reauthorization; the ID-token hint is cleared after sign-out.

## Recovery and acceptance limits

If another app instance owns the credential lock, use that instance or close it normally.
After a crash, the lock is deliberately retained: verify the recorded PID has exited and
that no Modex process is using the same home before removing **only** `chatgpt.enc.lock`.
Never remove the encrypted credential file as a routine unlock operation. This conservative
recovery prevents accidental concurrent refresh on a shared home.

Fixture tests cover public/returning flows, identity validation, state/path rejection,
encryption, insufficient scopes, refresh serialization, local/remote sign-out and separate
Codex child ownership. They do not establish a real OpenAI grant or subscription entitlement.
Before landing: complete a real user-controlled new registration, returning authorization,
Codex turn, refresh/resume, multi-account selection and sign-out on macOS Apple Silicon.
Apple Silicon acceptance completed on 2026-10-04: real registration and returning
authorization, completed Codex turns, rotating refresh and process replacement,
identity-bound resume, separate processes and tokens for two registrations, and scoped
revocation all passed. The surviving registration completed another resumed turn after
the other was revoked. Two distinct human account subjects were not established.
The evidence is recorded in [PR #92](https://github.com/TypeSafeAI/modex/pull/92).
No existing CLI credential is imported.

Official contract sources, checked 2026-10-03:

- [Registration and sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
- [Accounts and renewable sessions](https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions)
- [Codex app-server provider configuration](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
- [Token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
- [Codex shell environment policy](https://developers.openai.com/codex/config-reference)
