import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const schedule = await import('../lib/worktree-schedule.mjs').catch(() => ({}));
function fixture(t) {
  assert.equal(typeof schedule.installSchedule, 'function', 'schedule API must exist');
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modex-schedule-')));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const primary = path.join(dir, 'repo & space'); fs.mkdirSync(primary);
  const info = { primary, commonDir: path.join(primary, '.git'), stateDir: path.join(primary, '.git/modex-maintenance'), repo: 'example/modex' };
  const source = path.join(dir, 'disposable-worktree', 'scripts'); fs.mkdirSync(path.join(source, 'lib'), { recursive: true });
  for (const file of ['worktree-maintenance.mjs', 'worktree-scheduled.mjs', 'lib/worktree-maintenance.mjs', 'lib/worktree-schedule.mjs']) fs.writeFileSync(path.join(source, file), `// ${file}\n`);
  const calls = []; let loaded = false;
  const options = { home: path.join(dir, 'home'), source, platform: 'darwin', executables: { node: process.execPath, git: process.execPath, gh: process.execPath, lsof: process.execPath },
    launchctl: (args) => { calls.push(args); if (args[0] === 'print') return { status: loaded ? 0 : 113, stdout: loaded ? 'state = waiting' : '', stderr: '' }; loaded = args[0] === 'bootstrap'; return { status: 0, stdout: '', stderr: '' }; } };
  return { dir, info, source, calls, options };
}

test('installs a daily login job with escaped absolute paths and an independent verified runtime', async (t) => {
  const f = fixture(t);
  const receipt = await schedule.installSchedule(f.info, f.options);
  const plist = fs.readFileSync(receipt.plist, 'utf8');
  assert.match(plist, /<key>StartInterval<\/key><integer>86400<\/integer>/);
  assert.match(plist, /<key>RunAtLoad<\/key><true\/>/);
  assert.match(plist, /repo &amp; space/);
  assert.ok(plist.includes(process.execPath));
  assert.ok(!plist.includes(f.source), 'no disposable checkout in launch arguments');
  fs.rmSync(path.dirname(f.source), { recursive: true });
  const verified = await schedule.verifyRuntime(receipt.manifest);
  assert.equal(verified.primary, f.info.primary);
  assert.equal(verified.repo, 'example/modex');
  assert.ok(f.calls.some((args) => args[0] === 'bootstrap'));
  const status = await schedule.scheduleStatus(f.info, f.options);
  assert.equal(status.loaded, true); assert.equal(status.verified, true);
  assert.equal(status.state, 'waiting'); assert.equal(status.launchctl, undefined);
  await schedule.uninstallSchedule(f.info, f.options);
  assert.equal(fs.existsSync(receipt.plist), false);
  assert.ok(fs.existsSync(receipt.manifest), 'runtime and recovery evidence survive uninstall');
  assert.equal((await schedule.scheduleStatus(f.info, f.options)).installed, false);
});

test('tampered or missing runtime refuses verification', async (t) => {
  const f = fixture(t); const receipt = await schedule.installSchedule(f.info, f.options);
  const manifest = JSON.parse(fs.readFileSync(receipt.manifest, 'utf8'));
  fs.appendFileSync(path.join(path.dirname(receipt.manifest), 'lib/worktree-maintenance.mjs'), 'tampered');
  await assert.rejects(schedule.verifyRuntime(receipt.manifest), /checksum|changed/i);
  assert.equal((await schedule.scheduleStatus(f.info, f.options)).verified, false);
  assert.equal(manifest.commonDir, f.info.commonDir);
});

test('launch failure is reported, and unsupported hosts cannot install', async (t) => {
  const f = fixture(t);
  await assert.rejects(schedule.installSchedule(f.info, { ...f.options, platform: 'linux' }), /macOS/i);
  await assert.rejects(schedule.installSchedule(f.info, { ...f.options, launchctl: () => ({ status: 5, stderr: 'denied' }) }), /denied|launchctl/i);
});

test('preparation can finish under the maintenance lock before RunAtLoad activation', async (t) => {
  const f = fixture(t);
  const receipt = await schedule.installSchedule(f.info, { ...f.options, activate: false });
  assert.equal(f.calls.some((args) => args[0] === 'bootstrap'), false);
  await schedule.activateSchedule(receipt, f.options);
  assert.equal(f.calls.filter((args) => args[0] === 'bootstrap').length, 1);
});

test('installation refuses a schedule directory redirected into a disposable checkout', async (t) => {
  const f = fixture(t);
  const redirected = path.join(f.dir, 'checkout-cache'); fs.mkdirSync(redirected);
  fs.mkdirSync(f.info.stateDir, { recursive: true });
  fs.symlinkSync(redirected, path.join(f.info.stateDir, 'schedule'));
  await assert.rejects(schedule.installSchedule(f.info, f.options), /symlink|physical|canonical|redirect/i);
  assert.equal(f.calls.some((args) => args[0] === 'bootstrap'), false);
});

for (const changed of ['checksum', 'identity']) {
  test(`scheduled bootstrap refuses ${changed} changes before pruning`, async (t) => {
    const f = fixture(t);
    const marker = path.join(f.dir, 'prune-called');
    fs.copyFileSync(fileURLToPath(new URL('../worktree-scheduled.mjs', import.meta.url)), path.join(f.source, 'worktree-scheduled.mjs'));
    fs.writeFileSync(path.join(f.source, 'lib/worktree-maintenance.mjs'), `import fs from 'node:fs';
export class WorktreeMaintenance {
  async info() { return ${JSON.stringify({ ...f.info, repo: 'wrong/repository' })}; }
  async prune() { fs.writeFileSync(${JSON.stringify(marker)}, 'called'); }
}`);
    const receipt = await schedule.installSchedule(f.info, f.options);
    const runtime = path.dirname(receipt.manifest);
    if (changed === 'checksum') fs.appendFileSync(path.join(runtime, 'lib/worktree-maintenance.mjs'), '\n// changed');
    const result = spawnSync(process.execPath, [path.join(runtime, 'worktree-scheduled.mjs'), receipt.manifest], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, changed === 'checksum' ? /checksum changed/ : /identity changed/);
    assert.equal(fs.existsSync(marker), false);
  });
}
