# Modex Store Preview

A development preview of the full desktop renderer inside an Electron **MAS** client.
Coding, terminal processes, projects, credentials and file operations remain owned by an
explicitly started Mac host. This does not establish App Review eligibility or complete the
[Store acceptance gates](../../docs/mac-app-store.md).

## Build and run from source

From the repository root:

```sh
npm install
npm run build
MODEX_HOME="$HOME/Library/Application Support/Modex Host Preview" npm run start -w @modex/desktop -- --desktop-host
```

In a second terminal:

```sh
npm run start -w @modex/store-desktop
```

The host above has an isolated workspace. Add the projects you want to use. In its
**Desktop access → Pair a desktop** menu, explicitly approve copying a connection link;
paste it into the Store client. The link works once for five minutes. Client pairing is
saved with macOS Keychain encryption in the client container; the host stores only token
hashes. **Manage connected desktops** revokes a client immediately. Pairing and unsent
renderer drafts survive a temporary disconnect; accepted work remains owned by the host.
Restarting the client preserves pairing and saved threads, while unsent drafts have the
same renderer lifetime as the regular desktop app.

The host binds a dedicated HTTPS port to `127.0.0.1`, rejects browser origins/Host changes,
pins its self-signed identity before credentials are sent, and shares no credentials or
administrative routes with the phone service. Its menu makes the full project, terminal,
settings and account authority explicit. The service is off without `--desktop-host`.
This preview currently keeps a persistent port; conflicts fail visibly instead of silently
changing endpoints. Certificate renewal, host upgrades, multiple-client coordination and
the complete parity matrix still need acceptance work.

## Local sandboxed MAS bundle

```sh
npm run dist:preview -w @modex/store-desktop
MODEX_STORE_SIGN_IDENTITY=<Developer-ID-certificate-SHA1> node apps/store-desktop/scripts/sign-preview.mjs
```

The bundle is `release/mas-dev-arm64/Modex Store Preview.app`. The first command deliberately
leaves it unsigned. The second signs the MAS runtime for a **local development preview**
with App Sandbox, outgoing network access and the configured Soul Protocol team/application
group. It has no execution engine, PTY dependency, incoming-network entitlement or file
access grants outside its container. The ordinary `electron .` source run does not prove
Apple App Sandbox behavior.

Distribution needs the distinct `works.jev.modex.desktop` App Store Connect record,
appropriate Apple provisioning/signing, a processed TestFlight build and the documented
App Review/parity gates. The Developer ID preview is not such a build. Store client update
checks return no GitHub update; Store distribution must use Apple-owned updates.

## Verification

- `npm test` includes host pairing, pinning, persistence, event transport and revocation tests.
- The desktop Playwright suite includes a real host/client flow using the offline scripted
  engine: approval and file edit, terminal command, restart/reconnect with an unsent draft,
  and revocation. This source-mode test does not prove sandboxed execution or live model access.
- The packaged preview and a separate host were signed locally on 2026-10-05. Strict deep
  signature verification passed, and the running client was confirmed sandboxed. A native
  smoke test covered explicit pairing, OS-encrypted saved access, an approved scripted edit,
  its diff, terminal execution, recovery after an abrupt host restart with the draft preserved,
  client relaunch and revocation that removes saved access. The test used an isolated project
  and offline engine. Graceful host shutdown, fresh-user/sleep/upgrade behavior, live CLI
  accounts and the complete parity matrix remain acceptance work; see the
  [evidence and limitations](../../docs/mac-store-preview-plan.md).
