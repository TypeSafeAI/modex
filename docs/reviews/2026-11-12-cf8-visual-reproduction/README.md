# CF-8 visual reference/candidate inventory candidate

This evidence package preserves 33 unchanged candidate PNGs from canonical fixture capture at signed source `18aa43f689227ec7c20dae2751e2292026483dc4`, compared with the 33 hash-verified historical captures at `0e674e75237f393b8a1ba712061f5b303a61d5b4`. The tests passed fourteen cases with zero skips, retries or failures. Every filename and pixel dimension matches its historical counterpart. These are fixture captures, not model-provider or installed-release screenshots.

The manifest contains the exact reproduction command, source/tree identities, reference manifest digest, each candidate/reference image digest and explicit remaining differences. Waiting, completed, restored, failed and live states cover Graphite, Jev and OpenCoven at 900×600 and 1440×900; typed turns add one 900×600 capture per theme. The golden-path case verifies an actual synthetic-native edit/check, Save to Notes, Open and restart without rerunning it; it does not replace the separate saved-Note human review.

At 900×600, current approval content is narrower and has an inner horizontal JSON scrollbar. The initial waiting/live capture scroll position places part of the approval heading above the transcript viewport, while waiting actions remain visible. Completed/restored answers wrap differently and their plan/answer/Note stack positions shift. The Coven composer’s rounded outline/focus appearance differs. Synthetic temporary paths, repository suffixes and observed durations vary. Wider captures retain the plan/action/outcome structure; typed captures retain attempt, reasoning summary, denied command and final answer. These differences are listed rather than labelled universal pixel parity or approved on Val’s behalf.

The portable repeated-history/log tooling and the [current candidate performance receipt](../2026-11-12-cf8-reproduction-candidate.md) accompany this visual package in the same delivery. This evidence adds no acceptance checkbox before protected on-main delivery and a literal clause audit. All other CF-8 native/provider/device/human/child and rollout gates remain independent.

## Reproduce the pinned capture source

The following recipe was checked with driver `8771c3c2d7ef16de9ca12940eac2937119ae69b7`, the pinned installed dependencies and the same common core. It exports/builds capture source `18aa43f` inside the owned scratch area, leaving the worktree branch unchanged. The baseline build is part of the existing preparer; no retention workload runs under `--prepare-only`. Source/build/core/driver verification runs before and after capture. The source-export control passed fourteen cases and produced all 33 matching filenames/dimensions; all 792 exported desktop build files were byte-identical to the direct-checkout build at audit. The original inspected images and the second reproduction series have separate hashes; timestamps and temporary paths are expected to vary.

Run from an owned worktree containing the portable tooling after the pinned install. The output uses a new private directory. The common-core guard must pass; a later incompatible driver/core fails explicitly rather than changing the comparison. The wrapper clears inherited application/provider overrides, uses ordinary fixture cleanup, retains first logs/reports and stops on failure. It launches the source export through the existing synthetic fixtures and never replaces an installed app.

```sh
(
  set -eu
  capture_source=18aa43f689227ec7c20dae2751e2292026483dc4
  capture_root="$(mktemp -d "${TMPDIR:-/tmp}/modex-capture-XXXXXX")"
  printf 'Capture output: %s\n' "$capture_root"
  git fetch origin 89c98f280292b13fd9b1c7af1bf2fe65cd2fa0d1 "$capture_source"
  node scripts/cf8-retention.mjs --output "$capture_root/preparation" --baseline 89c98f280292b13fd9b1c7af1bf2fe65cd2fa0d1 --current "$capture_source" --prepare-only > "$capture_root/preparation-first.log" 2>&1
  mkdir "$capture_root/screenshots"
  node --input-type=module - "$capture_root" "$capture_source" <<'JS'
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { verifyManifest, workloadEnvironment } from './scripts/lib/cf8-retention.mjs';
const root = process.argv[2];
const preparation = JSON.parse(fs.readFileSync(path.join(root, 'preparation/preparation.json'), 'utf8'));
if (preparation.state !== 'prepared') throw new Error('Source preparation did not complete.');
const current = preparation.sources.find(source => source.role === 'current');
const manifest = verifyManifest(current.manifest, current.manifestSha256);
if (manifest.source.sha !== process.argv[3]) throw new Error('Unexpected capture source.');
const env = workloadEnvironment();
delete env.MODEX_KEEP_TEST_TMP;
env.MODEX_SCREENSHOTS = path.join(root, 'screenshots');
env.PLAYWRIGHT_JSON_OUTPUT_NAME = path.join(root, 'report.json');
const args = ['exec', 'playwright', 'test', 'e2e/conversation-fidelity.spec.ts', 'e2e/typed-turns.spec.ts', '--workers=1', '--retries=0', '--max-failures=1', '--output', path.join(root, 'artifacts'), '--reporter=json'];
const log = fs.openSync(path.join(root, 'capture-first.log'), 'wx', 0o600);
let result;
try {
  result = spawnSync('pnpm', args, { cwd: manifest.appDir, env, stdio: ['ignore', log, log] });
} finally {
  fs.closeSync(log);
  verifyManifest(current.manifest, current.manifestSha256);
}
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
const report = JSON.parse(fs.readFileSync(env.PLAYWRIGHT_JSON_OUTPUT_NAME, 'utf8'));
if (report.stats.expected !== 14 || ['unexpected', 'skipped', 'flaky'].some(key => report.stats[key] !== 0)) throw new Error('Incomplete capture report.');
if (fs.readdirSync(env.MODEX_SCREENSHOTS).filter(name => name.endsWith('.png')).length !== 33) throw new Error('Incomplete capture set.');
JS
)
```

The executed control uses the same preparer, full revisions, export app directory, cleared environment, fixed Playwright arguments, manifest checks and result gate. Its original command/phase receipts and first logs are retained privately; the sanitized reproduction control records their digests and all second-series image digests. The inline wrapper above is syntax-checked and mapped to that executed command sequence; it is not claimed as an additional third capture run.

The same source-export recipe was also executed against the historical reference commit `0e674e75237f393b8a1ba712061f5b303a61d5b4`: its unchanged fourteen cases passed once, producing all 33 matching filenames/dimensions, with before/after verification of 928 source files and 628 desktop build files. To select that source, change only `capture_source` to its full SHA and let the recipe allocate a new output directory. The [historical reference reproduction control](reference-reproduction-control.json) preserves those separate raw-receipt and image hashes. This rebuild used version 0.3.0 source with common current dependencies; the tool’s `current` operand selects a source for preparation and does not relabel the historical reference as current main. Neither source-control run requires pixel-identical output.
