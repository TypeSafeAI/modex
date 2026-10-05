# Mac App Store preview execution ledger

Val requested a runnable desktop Store preview on 2026-10-05, following approval of the
separate signed-host direction. Reuse the existing desktop React interface and CLI-owned
engine. The iPhone-on-Mac Companion is not this desktop target.

## Implementation

- [x] Add a dedicated, opt-in loopback HTTPS host transport over the existing desktop command handlers.
- [x] Pair each desktop installation with a short-lived, single-use host invitation; persist hashed grants and support revocation.
- [x] Add a client that pins host identity before sending credentials, keeps credentials outside the renderer, and reconnects safely.
- [x] Build a separate sandboxed Electron MAS target using the existing renderer and official branding; exclude the execution engine and PTY modules.
- [x] Show connection/recovery states, preserve the workspace while disconnected, and use Store-owned updates.
- [ ] Verify auth boundaries, revocation, real host/client commands, streaming and terminal behavior.
- [x] Sign and open the local preview, verifying actual App Sandbox and displayed UI.

## Delivery limits

The published v0.0.7 Developer ID app and Companion build 4 stay unchanged. This work is
an isolated development preview until the full parity matrix in `mac-app-store.md` passes.
Mac App Store eligibility, a macOS App Store Connect record, distribution provisioning,
TestFlight processing and physical acceptance remain shipping gates. Do not label a normal
darwin Electron bundle or the iPhone compatibility app as a Mac App Store build.

A first local preview may use Developer ID signing for the MAS binary; it must still
actually run with App Sandbox. If proper local provisioning is required, prepare the
complete build before requesting the specific missing Apple setup.

## Local evidence, 2026-10-05

The new `apps/store-desktop` workspace builds and typechecks. Three transport tests passed
(pair-once, saved access after host restart, events/revocation, wrong pin and URI boundaries).
A real host/client Playwright flow passed approval and a repository edit, a terminal command,
reconnection while preserving an unsent draft, and revocation. These tests use the existing
offline scripted engine; they are not live Claude/Codex or full parity proof.

An arm64 Electron MAS bundle was built and Developer ID signed with the existing Soul
Protocol identity. Strict deep signature verification passed. Its parent entitlements are
App Sandbox, outgoing network access and the product application group; child executables
inherit the sandbox. The opened `works.jev.modex.desktop` window displayed the official
pink identity and connection screen. An external sandbox check on the running process
returned `control=0 target=1 errno=0`. The private diagnostic is not included in the product.
The signed client has not yet been paired with a production host; full sandboxed acceptance
and Store distribution remain pending.

During the broader local regression run the Mac ran low on disk space. Three checksum-
verified duplicate v0.0.7 download files were removed from this session's temporary directory;
source, verification logs, published artifacts and the installed app were preserved.

The final source build and typecheck passed, as did 279 core/desktop/bridge unit tests.
The complete desktop end-to-end rerun passed all 101 tests (including the new real host/client
flow). The preceding run had 99 passes, a 90-second shutdown-hook timeout and a 30-second
window-startup timeout during local resource pressure. Both passed on the unchanged-source
rerun after disk space recovered; no timeout or assertion was relaxed. This records the
local infrastructure limitation without claiming it was fixed in application code.
