# Modex OAuth sign-in implementation plan

> **For agentic workers:** Use the executing-plans workflow for the tasks below.

**Goal:** Authenticate Modex with the existing GitHub OAuth App through WorkOS, then release only after live acceptance and the repository release gates.

**Architecture:** Native public-client PKCE in Electron main, loopback callback with state validation, encrypted per-profile credentials, narrow local-only IPC. No API key or GitHub client secret in desktop. GitHub provider tokens are not exposed to renderer or used for repository actions in this first sign-in slice. Staging acceptance precedes production configuration.

**Tech Stack:** TypeScript, Node HTTP/crypto, Electron safeStorage, React, Node tests, Playwright.

- [x] Inspect main, PR #137, existing auth patterns, WorkOS configuration and official PKCE documentation.
- [x] Rebase reference-shell onto origin/main, preserving the Copilot iPhone test change.
- [ ] Verify and publish the rebased branch with an exact force-with-lease.
- [x] Implement main-process WorkOS authentication and protected persistence in `apps/desktop/src/main/engine/workos-auth.ts`.
- [x] Test state rejection, PKCE, cancellation, persistence, credential failure, identity-bound refresh and sign-out.
- [x] Add local-only commands and a Settings account card; keep cloud auth independent of model accounts.
- [ ] Configure staging loopback callback and prove real sign-in, repeat sign-in, refresh and sign-out.
- [ ] Configure production or explicitly scope the release to exclude unfinished auth.
- [ ] Run build, unit and E2E gates; review PRs and merge only verified changes.
- [ ] Prepare release version/review, signed/notarized local rehearsal and packaged E2E.
- [ ] Publish signed tag through Release workflow; verify downloaded artifacts before publishing.

## Live dependencies

Production and staging are configured with the same existing GitHub OAuth App
`Ov23lihy1IWAJ8owVfJ5`, with provider state Valid and sign-in enabled. Production
client is `client_01M4DWGC09T282ZJHMZCX395ZP`, environment
`environment_01M4DWGBT2RXZ82EM19W7GQD9K`. The production GitHub provider callback is
`https://auth.workos.com/sso/oauth/github/4Nn81zHXg0W765dsyUu1mwkL5/callback`; Val
reported saving provider credentials and updating the existing OAuth App callback.
Both environments have the fixed and wildcard localhost callbacks and the logout
return URL `https://modex.codes`. Provider tokens remain enabled in WorkOS but desktop
explicitly discards them for this identity-only slice.

Release is held for verified production sign-in, repeat sign-in, restart persistence,
refresh and sign-out. The reference-shell broad E2E run was interrupted under system
load over 370; its focused 16 shell/layout tests passed after focus and hover fixes.
Local commit signing through 1Password is being restored by the parent session.
