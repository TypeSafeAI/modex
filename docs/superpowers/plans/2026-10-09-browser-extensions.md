# Browser extensions and sign-in implementation plan

**Goal:** Add a restricted custom extension manager, 1Password login filling and native Touch ID passkeys to the workspace browser.

**Architecture:** Keep the app and Knowledge sessions separate from a persistent workspace browser session. Main owns extension packages, approval, CLI execution and credential selection. Web content never receives the app preload. Passwords are written only into the selected page's visible top-frame login fields after rechecking the origin and document. Existing synced passkeys remain in the system browser.

**Stack:** Electron 44, TypeScript, React, Node tests and Playwright Electron tests. No new runtime dependency.

- [ ] Add Node tests for extension manifest restrictions, symlink/size limits, approved-copy integrity, persistence and load failures. Implement `src/main/engine/browser-extensions.ts` against Electron's extension loader.
- [ ] Add Node tests for exact-origin 1Password matching, explicit selection, CLI failures and navigation cancellation. Implement `src/main/engine/browser-credentials.ts`, keeping passwords out of IPC and errors.
- [ ] Add a persistent browser partition and `browser:extensions`, `browser:extensionInstall`, `browser:extensionUpdate`, `browser:fillLogin`, `browser:external` local-only commands. Configure Touch ID with matching release entitlements and a native WebAuthn account chooser.
- [ ] Add a small browser tools dialog and page-menu actions, with pending/error states and keyboard focus handling. Update browser sign-in documentation and `docs/status.md`.
- [ ] Verify with `npm run build && npm test`, desktop typechecking, `npm run test:e2e`, and focused real-Electron tests of extension loading/isolation, 1Password filling without form submission and WebAuthn account cancellation.

Acceptance requires denial of native messaging, background execution, arbitrary host APIs, file URLs and unapproved package changes. Real 1Password unlock and signed Touch ID acceptance are documented separately from automated coverage.
