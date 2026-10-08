# Modex account sign-in

Settings → General → Modex account signs in with the existing GitHub OAuth App through
WorkOS. This first slice establishes Modex identity. It does not connect repositories,
change CLI credentials, grant model access, or sync workspace data.

Electron main starts a loopback listener on an ephemeral `127.0.0.1` port and opens the
system browser. Authorization uses hosted `authkit`, a fresh state and S256 PKCE challenge.
GitHub is enabled in WorkOS; the hosted flow completes required email verification before
returning to Modex. Direct `GitHubOAuth` skips that hosted challenge handling and is not used.
The listener checks the path, HTTP method, loopback peer, Host header, state, duplicate
parameters and single-use callback. Cancel, window unmount, timeout and shutdown end the
pending sign-in. The five-minute limit includes token exchange.

Main exchanges the code directly with the fixed HTTPS WorkOS authentication endpoint.
The desktop contains a public client ID, never a WorkOS API key or GitHub client secret.
The token endpoint's HTTPS response is the authority for user identity. Main decodes
only its freshly returned access token to check subject consistency and obtain expiry
and session ID; it does not accept external JWTs as identity proof. Access tokens and
GitHub provider tokens are discarded. No prompts, source files or model requests are
sent to WorkOS.

The renewable session is encrypted with Electron safeStorage, with private file
permissions and atomic writes. Linux `basic_text` is rejected. The status IPC returns
only user ID, email, environment, expiry and a fixed detail; every account command is
local to the trusted desktop frame and excluded from Companion's command map. Opening
the account card refreshes a session near expiry. Concurrent refreshes share one request,
and renewal must preserve the WorkOS user ID.

Sign-out clears the encrypted local session before opening WorkOS's remote logout URL.
The UI asks the user to complete browser logout; opening that URL is not proof that
remote revocation completed. A browser failure leaves local sign-out complete.

## Environments and recovery

Production is the default public client `client_01M4DWGC09T282ZJHMZCX395ZP`.
`MODEX_WORKOS_ENV=staging` selects `client_01M4B32N0CQBCPPMZ5WA4NM5P4` and visibly
labels the card **Staging**. Both environments allow
`http://127.0.0.1:*/auth/workos/callback`; the fixed default callback is
`http://127.0.0.1:43821/auth/workos/callback`. GitHub OAuth provider configuration and
credentials stay in WorkOS, not in the desktop or environment variables.

Credentials live in `<MODEX_HOME>/app/workos-production.enc` or `workos-staging.enc`,
bound to their client ID. Unique process claims in the adjacent `.lock` directory
prevent shared-home instances from rotating the same refresh token. Graceful shutdown
removes its owned claim; a new instance reclaims a crashed owner's unique claim only
when the operating system confirms its PID no longer exists. Live, inaccessible or
unknown owners fail closed. PID reuse can require manual recovery: verify no other
Modex process uses that home before removing an obsolete `.owner` file. Never delete
a live process's claim. Restore OS keychain access before retrying a storage failure;
unreadable credentials are preserved.

## Verification and release gate

Unit tests exercise real loopback callbacks, state/host/method rejection, PKCE, protected
storage failure, environment isolation, cancellation, refresh identity and sign-out.
The offline Electron test exercises Settings, local IPC and persistence with fixture
browser/token responses. Neither proves a real GitHub/WorkOS sign-in.

Before release, verify production sign-in and repeat sign-in with the existing GitHub
OAuth App, restart persistence, refresh after expiry, cancellation, and local plus remote
sign-out in the signed app. Confirm coding tool accounts are unchanged. Release remains
held until this live acceptance and the repository's build, unit, E2E, signed/notarized
artifact and hosted checks pass.

Protocol references: [WorkOS PKCE support](https://github.com/workos/workos-node/blob/main/docs/V8_MIGRATION_GUIDE.md),
[public-client refresh and logout](https://github.com/workos/workos-node/blob/main/src/user-management/user-management.ts),
[authorization URL](https://workos.com/docs/reference/authkit/authentication/get-authorization-url).

The Store front end, browser development and Companion do not receive account authority
in this slice. Use the full Modex desktop app for sign-in.
