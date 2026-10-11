# Workspace browser extensions and sign-in

The workspace browser (a browser tab beside the chat) keeps its own persistent session,
separate from the app, the Knowledge view and your system browser. Nothing a page does
reaches Modex's bridge: guest pages get no preload, no Node, no app storage, and every
permission prompt is denied. Three additions build on that boundary. None of them makes a
network request on its own.

## Custom extensions

Open **Browser extensions and sign-in** (the gear in the browser toolbar) and choose
**Add extension**. Pick an unpacked extension folder; Modex reads it once, shows the sites it
can touch, and installs an approved copy under `~/.modex/browser/extensions/<id>/`. Later
edits to the source folder change nothing; if the approved copy changes on disk, the
extension is disabled on the next launch and must be removed and added again.

What is accepted, and why the set is small:

- Manifest V3 with a name and numeric version.
- `content_scripts` only: page scripts and stylesheets matched to HTTPS sites, or an exact
  `localhost` / `127.0.0.1` / `[::1]` HTTP host. `file:` and `http://` hosts are refused.
- The `storage` permission only. `background`, `action`, `host_permissions`,
  `nativeMessaging`, `cookies`, `tabs` and every other key are refused up front, so an
  extension cannot run outside a matched page, talk to a native helper or read other sites.
- At most 12 extensions, 1,000 files and 20 MB each, no symbolic links.

Extensions load only into the workspace browser's session. The app window and the Knowledge
view never see them. An extension that matches a login page can read what is typed or filled
there; the install dialog says so, and the extension list shows each one's sites.

## 1Password

Filling uses the [1Password CLI](https://developer.1password.com/docs/cli/get-started/) and the
desktop app's **Integrate with 1Password CLI** setting, so the vault stays unlocked by 1Password
itself (Touch ID or your account password), never by Modex. On an HTTPS page choose
**Page options → Fill with 1Password**:

1. After the main page finishes loading, Modex binds the request to that document, then
   lists your Login items and keeps only those whose saved website is the page's
   exact origin (`https://example.com`, not a subdomain, parent domain, other port or `http:`).
   A website saved without a scheme is read as HTTPS.
2. You pick a login in a native dialog. Only then does Modex read that item.
3. The username and password are written into the page's visible top-frame login fields
   from an isolated script. The form is not submitted; you review and sign in.

Navigation, reload, entry into the back/forward cache, tab closure, or renderer loss
cancels the request. Changing the URL and returning to it cannot revive a request. The isolated script validates and
consumes its document token in the same synchronous operation that fills the fields; a
queued script cannot fill a replacement document. Browsers without the required Navigation
API refuse filling. The selected guest renderer receives the username and password for
filling, and approved extensions matching that page can read the fields. Credentials are
not returned through Modex app-bridge IPC or stored in the app renderer, thread transcripts,
or error messages. CLI failures surface as a short hint without the CLI's output. Pages
with several password fields, a `new-password` field, or no unambiguous login field are
left alone.

## Passkeys

Device Touch ID passkeys are disabled in this release, including signed builds. A signed
binary alone does not authorize the restricted `keychain-access-groups` entitlement.
No matching standalone Developer ID provisioning profile is available; the Store profile
is for a different app and distribution channel. The default artifact omits the deferred
WebAuthn group, and browser tools report `touchID: false`.

For passkeys, choose **Page options → Open in system browser**. That session belongs to your
browser and stays separate from Modex. The native account chooser remains available for
supported browser authentication flows. Navigating the initiating frame or any ancestor
permanently cancels its pending selection; navigation in an unrelated sibling does not.

Streamer Mode masks recognized secrets in Modex's native login, passkey-account, and
extension-approval dialog labels. Each dialog uses the current mode when it is presented;
unreadable mode state keeps those labels masked. Selections, filled credentials, installed
extension bytes, and site permissions stay unchanged.

## Acceptance still required

Automated tests use controlled HTTPS pages and a fake `op` executable. They cover fill and
cancellation behavior, extension isolation, and absence of credentials from the app DOM and
saved state. They do not prove real 1Password unlock or human biometric acceptance.

A controlled check of the final integrated development build through installed
1Password CLI 2.39.0 passed actual native Login selection, production filling without
submission, scoped leak checks, and exact temporary Login cleanup. Source and build
hashes remained unchanged from the verified build, including BrowserTools and its shared
Streamer matcher. The check used intercepted HTTPS and did not establish public TLS,
real-site compatibility, normal signed-app behavior, live cancellation, or a fresh
biometric gesture.
See the [acceptance report](reviews/2026-10-11-browser-credential-acceptance.md) for the exact
evidence and limits.

Before releasing 1Password filling, use a disposable Login for a controlled HTTPS site in
a signed app launched normally. Verify real unlock, selection, filling without submission,
cancellation during listing and item reads, navigation and close cancellation, and absence
of credentials from app state, logs, and error surfaces. Enable the CLI integration in
1Password and select the intended account first if you use several accounts.

Enabling device Touch ID requires a separate change with a valid Developer ID profile that
matches the app, team, keychain group, expiry, and signing certificate. Embed that profile
before signing. Then verify actual signed WebAuthn create/get, restart and reuse, account
selection, cancellation, and session separation on supported hardware without `MODEX_E2E`.
See [release signing](release-signing.md) for the provisioning boundary.
