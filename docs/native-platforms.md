# Native Windows and Linux candidates

Development commands: `npm run dist:windows -w @modex/desktop` and
`npm run dist:linux -w @modex/desktop`. Each requires its native x64 host. Windows
also needs an MSVC x64 tools environment. The commands build core and desktop,
write candidates under `apps/desktop/release/native-{win32,linux}`, and never publish.

Windows NSIS installers are unsigned, per-user, do not launch automatically after
installation, and retain application data on uninstall. Linux targets are AppImage
and Debian (`modex`). macOS release-signing rules remain unchanged.

The Native platform builds workflow tests CLI arguments and Windows process ownership,
then builds candidate installers. Artifacts expire after three days. A manifest records
SHA-256 hashes, sizes, source commit/run identity, and installer acceptance as pending.
The [Windows cleanup run](https://github.com/TypeSafeAI/modex/actions/runs/38137332864)
passed all fourteen native checks: CLI arguments/npm launchers, owned descendant cleanup,
PTY input/OS resize/Ctrl-C, and six repeated shutdown cycles. The fixture owner exited
naturally with zero output workers and owned consoles; pipe handles returned to baseline.
It produced `Modex-0.0.10-windows-x64.exe` (116,976,509 bytes), whose downloaded SHA-256
matches the manifest and whose PE certificate directory is empty, confirming it is unsigned.

Earlier runs exposed a node-pty leak and stale Node stdout dimensions. A version/hash-checked
patch now closes the owned console, destroys input and disposes the output worker while
preserving exit status across output EOF ordering. Windows builds rebuild the addon against
pinned Electron headers; build and runtime guards reject unpatched prebuild fallback.
Resize acceptance reads a fresh child OS sample instead of cached stdout fields.

The [Windows installed acceptance run](https://github.com/TypeSafeAI/modex/actions/runs/38138212616)
passed verified NSIS installation, two launches of the real packaged app, terminal
input/output/cleanup with explicit cmd.exe selection, and production SecretStore DPAPI
encryption read across restart without changing ciphertext. The real NSIS uninstaller
removed the application and registration while preserving recorded threads, probe
ciphertext, default app-data markers and unrelated data. The downloaded evidence archive
matches GitHub's artifact digest. Forced process cleanup fails acceptance; existing
installations and local/self-hosted execution are refused.

Default Windows shell selection now treats environment names case-insensitively.
Regressions reproduce and fix the incorrect PowerShell fallback for `ComSpec`/`comspec`.
The next installed smoke supplies ordinary `ComSpec` to exercise this fix in packaged
Electron; the completed run above used uppercase `COMSPEC`. The first follow-up
run stopped before packaging: Ctrl-C reached the test child, but the subsequent shell
command timed out. The fixture now waits for child exit and a unique PowerShell prompt
before sending that command; a delayed child exit exercises this handoff. Native
verification of that change and the packaged mixed-case check remain pending.

Linux GCC rejected unchecked terminal receipt writes in the
[initial run](https://github.com/TypeSafeAI/modex/actions/runs/38134189896).
After the helper handled partial writes, interruption and errors, the second run compiled
and produced AppImage and Debian candidates. Downloaded sizes and SHA-256 hashes match
their manifest, whose source is the PR merge of Canvas `05efc984` and platform `3de10de5`.
The third run also passed seven Linux terminal cleanup/job-control tests; two require
unavailable zsh or macOS. The [installed smoke run](https://github.com/TypeSafeAI/modex/actions/runs/38136494798)
then passed for Debian and extracted AppImage: verified hashes, packaged Electron 44.4.5
and ASAR startup, real terminal input/output/cleanup, graceful app close, and Debian
uninstall preserving recorded threads and unrelated data. Screenshots and runtime
identity are retained in the `native-installed-linux` artifact. The runner reported
`basic_text` with encryption unavailable. The next harness revision starts an owned
GNOME Secret Service in a fresh D-Bus session and tests real libsecret encryption across
restart and package formats. A separate `basic_text` launch must refuse new and overwrite
writes, return no plaintext and preserve existing ciphertext. This revision is prepared;
its hosted execution remains pending, as does KWallet acceptance. It explicitly selects
libsecret with one keyring process across app restarts; automatic backend selection and
keyring/session restart persistence are separate checks.
Extracted AppImage execution does not establish FUSE startup. Encrypted credential persistence,
distinct-version upgrades and full CLI/account acceptance remain required. The harness
refuses local and self-hosted execution and fails acceptance if app shutdown needs forced
termination.

Before release, collect native evidence for installed startup, packaged Electron addon
and helper loading, CLI arguments and account/login launches, PTY input/resize/Ctrl-C,
natural exit/close/disposal/owner-death cleanup of detached descendants, DPAPI and
libsecret/KWallet behavior (including unavailable-backend refusal), manual upgrade with
preserved data, and uninstall without unrelated data loss. Windows/Linux updates remain
manual. Candidate artifacts and cross-compilation do not satisfy these gates.

Windows job ownership covers ordinarily created descendants, not service/WMI execution.
Custom batch launchers are refused; recognized plain npm Node wrappers launch the real
Node entrypoint with unchanged arguments. Linux credentials require an encrypted storage
backend and preserve existing files when storage is unavailable.

Local verification for the isolated platform change: full monorepo build, 489 passing
tests, desktop typecheck, configuration validation and workflow lint. Twelve tests are
skipped: eleven require Windows and one is the existing opt-in live Knowledge test. Strict
Windows cross-compilation passes; the hosted results above provide the limited native
evidence gathered so far.
The Codex process-cleanup fixture also now waits for a valid PID; a deliberately delayed
PID write reproduces the earlier false process-survival assertion before the fix.

The packaged-demo test now uses the test process PATH instead of reading the user's
login profile. A controlled nine-second login shell reproduced its eight-second
approval timeout; the same test passes with profile lookup disabled through the existing
test seam. Production demo deadlines are unchanged.
