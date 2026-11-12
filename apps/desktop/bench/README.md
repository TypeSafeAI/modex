# CF-8 retention reproduction

These opt-in benchmarks reproduce the reviewed history/log workloads for #281 through existing Electron/main/native-adapter fixtures. They are outside the ordinary E2E directory and do not run in routine CI. No real model or model server is used; the synthetic CLI reports command-shaped events without executing the displayed command. Installed apps and user profiles are not replaced.

From an owned worktree, install with the pinned pnpm and run:

```sh
node scripts/cf8-retention.mjs \
  --output /absolute/private/new-retention-directory \
  --baseline 89c98f280292b13fd9b1c7af1bf2fe65cd2fa0d1 \
  --current 44fb41eecf718cf6648b7c8ee95cab1e85e0e072
```

The output parent must exist; the final directory must be new. The CLI creates it privately, refuses existing files/directories and dangling symlinks, and never retries or deletes a failed run. Source exports and generated drivers stay in a new owned `apps/desktop/.probes/cf8-retention-*` directory. Each source’s seeded homes and repositories live under its private `fixtures/` directory, with locators written before further fixture setup. Worker exit cleanup is disabled only for this benchmark. The existing seeding helper uses that private root synchronously, then the ordinary runtime temporary-directory context is restored before app launch. All inputs, build logs, manifests, raw measurement logs and partial/final observations remain retained for review and guarded worktree cleanup.

Both full commit identities are mandatory. Sources are exported and verified against their Git blobs, built sequentially and rechecked before measurement. They share the driver's already-installed pinned dependencies and freshly built common core, so all three core source trees must match and the driver's core must be clean. Before building, the desktop’s installed core alias and resolved package entry must bind to that driver core; package metadata and the built entry are recorded and rechecked before launches. This compares rebuilt source, not historical shipped binaries or a recreation of the historical lockfile. These named-Mac workloads currently require macOS; offline hash verification is separate.

After both builds finish, current-source history/log cases run before baseline-source cases, serially, with one worker, no retries and a first-failure stop. Each source has three fresh-app history replicates (three 200-turn/1,400-item histories, three warm opens and 63 measured opens) and three fresh-app log replicates (one warm-up and 21 measured streams, each 3 MiB logical output in 48 deltas). Renderer GC is forced only at matched warm detached endpoints; intermediate renderer and all main snapshots use natural GC. The one/five-second detach samples are declared observation times, not readiness waits. The legacy-only shallow ASCII read and expected full-output violation remain explicit; current 256 KiB preview/IPC assertions are unchanged.

`--prepare-only` performs source/build/driver preparation without launching an app. Recheck retained inputs without executing a workload with:

```sh
node scripts/cf8-retention.mjs --verify /absolute/private/new-retention-directory/current-manifest.json
```

Verification binds source/build/common-core/dependency links, installed core package/entry identity and the original/generated driver files to their recorded hashes. Driver paths must remain regular, canonical paths under the declared driver root; matching-byte symlinks cannot redirect relative imports. Measurements separately report the target source and the diagnostic driver's checkout identity; the latter is never presented as the exported application's Git HEAD. The manifest records uncommitted driver bytes explicitly if preparation precedes an implementation commit.

Successful execution requires all twelve original cases to pass, all six observations per source to report complete state and returned app-close calls, and source/build/driver checks to remain valid afterwards. The receipts contain host/runtime identities, timestamps, load averages, per-replicate data and first failures. Local paths and process IDs remain private; public aggregates must omit them without changing numeric observations.

Numbers vary with host load, dependency/runtime versions and group ordering. Two animation frames are a sampling point rather than exhaustive settlement; sampled values are not operation high-water marks. There is no new memory or latency budget, universal ceiling, causal improvement, leak-freedom, real-provider, native-platform or human-accessibility claim. This tooling addresses the portable measurement procedure; #281's visual inventory and remaining native/device/human/child requirements remain separate.
