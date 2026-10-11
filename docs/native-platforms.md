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
The first hosted run compiled the Windows helper with MSVC and passed twelve CLI and
process-ownership checks. Its interactive PTY case failed while observing resize, then
left the test runner alive. Adding cursor-moving console writes did not repair that
observation.
The [second native run](https://github.com/TypeSafeAI/modex/actions/runs/38134994369)
still failed the Windows resize observation (80×24 after requesting 96×32) and timed out
with the worker alive. The [third run](https://github.com/TypeSafeAI/modex/actions/runs/38135685702)
confirmed the OS console reached 96×32 while Node retained cached 80×24 fields. Three
worker MessagePorts remained after teardown. A version/hash-checked node-pty patch now
closes the owned console on natural exit, destroys the input socket and disposes the
output worker. Windows builds must rebuild the addon against the pinned Electron headers;
build and runtime guards reject fallback to an unpatched prebuild. Native regression
coverage repeats natural/close/supervisor-failure cleanup and requires the owner to exit
without forced termination. The resize assertion now uses the fresh child OS sample.
These fixes still require native verification.

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
`basic_text` with encryption unavailable; encrypted credential acceptance remains open.
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

Local verification for the isolated platform change: full monorepo build, 486 passing
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
