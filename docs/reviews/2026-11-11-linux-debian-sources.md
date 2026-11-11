# Signed sources through Debian dependency installation

## Observed failure

Latest published candidate `188af741834512d2e9d1f73994167301dabbb1f8` completed all four signed Noble pocket updates (35.8 MB) and installed 114 host packages (38.5 MB), then failed its first baseline Debian install because `libnotify4` was not installable. `libappindicator3-1` was also unavailable as a recommendation. Installed application acceptance did not begin. The immutable job130703562477 raw log and `linux-188-dependency-failure-audit.json` are retained in `/Users/buns/Documents/Codex/2026-11-11/modex-closeout/`.

The later installer invoked default-source APT after the preparation helper removed its private source configuration. That boundary is demonstrated by source and the actual failing command. The runner's APT policy and exact default-index state were not retained, so the source/index mismatch remains a hypothesis; successful host preparation does not prove Debian dependency resolution or installed application acceptance.

## Candidate

The existing helper adds a CI-only `noble --install-deb <artifact>` mode. It accepts exactly one existing absolute regular nonsymlink `.deb` path, updates strict official signed sources, then installs that artifact through the same temporary source configuration before cleanup. It accepts no arbitrary APT flags or commands. Default host preparation still requests the same nine packages. All four Noble pockets, Ubuntu keyring, acquisition bounds and failure behavior remain.

A small Node wrapper connects both baseline and upgrade acceptance to this mode after existing manifest/hash verification. The direct helper invocation retains the original 180,000 ms command timeout, caught as missing during initial review and restored before delivery. This deadline does not prove atomic APT descendant termination. The workflow includes the wrapper in its native PR path filter. Installed-app, credential, KWallet, FUSE, CLI and final cleanup checks, the six-minute preparation limit and seven-minute installed-acceptance limit remain unchanged. No global source configuration, resolver or trust setting is rewritten. Each installer invocation performs its own bounded signed index acquisition.

## Verification and limits

The old helper plus empty Node wrapper failed two new regression cases, with eight existing cases passing. The corrected installation path passed ten cases; input/failure controls brought that to 13 passes. Tests execute the real shell and Node wrapper with synthetic sudo/APT; configuration creation, argument boundaries, failure handling and cleanup are real. A separate old-helper control confirms that malformed installer arguments were previously ignored. These tests do not resolve real packages or prove Linux installation.

The first full build/typecheck/unit run passed with 2,465 passes, 36 skips and zero failures/cancellations. It used the initial source before the restored wrapper timeout, so it is retained as superseded evidence. Final corrected-source build, workspace typechecks and units also passed with 2,465 passes, 36 explicit skips, zero failures and zero cancellations across 2,501 tests; source hashes remained unchanged. Commands, exit codes and retained logs are tracked separately in `linux-deb-sources-final-validation.json`. Independent final source review found no Critical, Important or Minor finding. Actual dependency resolution, installed acceptance, timing and fresh exact-head hosted qualification remain open. No Linux acceptance or local-model admission is claimed.
