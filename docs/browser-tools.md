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

1. Modex lists your Login items and keeps only those whose saved website is the page's
   exact origin (`https://example.com`, not a subdomain, parent domain, other port or `http:`).
   A website saved without a scheme is read as HTTPS.
2. You pick a login in a native dialog. Only then does Modex read that item.
3. The username and password are written into the page's visible top-frame login fields
   from an isolated script. The form is not submitted; you review and sign in.

If the tab navigates or closes at any step, nothing is filled. Credentials never enter the
renderer, IPC, thread transcripts or error messages; CLI failures surface as a short hint
without the CLI's output. Pages with several password fields, a `new-password` field, or no
unambiguous login field are left alone.

## Passkeys

Signed releases enable Electron's Touch ID authenticator for the browser session, backed by
the Secure Enclave through the `keychain-access-groups` entitlement in
`build/entitlements.mac.plist`. The dialog shows whether it is active. These passkeys are
created and used on this Mac only; they are not the passkeys synced by 1Password or iCloud
Keychain. When a site offers several accounts, Modex asks which to use in a native dialog
and cancels if the page changes meanwhile. Development builds and tests keep Touch ID off.

For a sign-in that needs an existing synced passkey, choose **Page options → Open in system
browser**. That session belongs to your browser and stays separate from Modex.
