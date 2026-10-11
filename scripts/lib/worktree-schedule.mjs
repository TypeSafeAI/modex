import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertStatePath } from './worktree-maintenance.mjs';

const runtimeFiles = ['worktree-maintenance.mjs', 'worktree-scheduled.mjs', 'lib/worktree-maintenance.mjs', 'lib/worktree-schedule.mjs'];
const hash = (value) => createHash('sha256').update(value).digest('hex');
const xml = (value) => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
const ctl = (args) => spawnSync('/bin/launchctl', args, { encoding: 'utf8', timeout: 15000 });
const domain = () => `gui/${process.getuid()}`;
function paths(info, home = os.homedir()) {
  const label = `ai.typesafe.modex.worktrees.${hash(info.commonDir).slice(0, 16)}`;
  return { label, plist: path.join(home, 'Library/LaunchAgents', `${label}.plist`), receipt: path.join(info.stateDir, 'schedule/installed.json') };
}
function executable(name) {
  const result = spawnSync('/usr/bin/which', [name], { encoding: 'utf8' });
  const found = result.stdout?.trim();
  if (result.status !== 0 || !found || !path.isAbsolute(found)) throw new Error(`Cannot resolve ${name}; install it before scheduling maintenance`);
  return found;
}
function check(result, action) {
  if (result.status !== 0) throw new Error(`launchctl ${action} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
}

async function physicalDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  if (await fs.realpath(directory) !== path.resolve(directory)) throw new Error(`Refusing redirected schedule directory: ${directory}`);
}

export async function verifyRuntime(manifestPath) {
  if (await fs.realpath(manifestPath) !== path.resolve(manifestPath)) throw new Error('Refusing redirected runtime manifest');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  if (manifest.version !== 1 || !path.isAbsolute(manifest.primary) || !path.isAbsolute(manifest.commonDir) || typeof manifest.repo !== 'string') throw new Error('Invalid maintenance runtime manifest');
  const stateDir = path.join(manifest.commonDir, 'modex-maintenance');
  assertStatePath({ stateDir }, manifestPath);
  if (!/^[a-f0-9]{24}$/.test(path.relative(path.join(stateDir, 'schedule/runtime'), path.dirname(manifestPath)))) throw new Error('Runtime is outside the installed schedule directory');
  for (const file of runtimeFiles) {
    const location = path.join(path.dirname(manifestPath), file);
    if (await fs.realpath(location) !== path.resolve(location)) throw new Error(`Refusing redirected runtime file: ${file}`);
    if (hash(await fs.readFile(location)) !== manifest.files?.[file]) throw new Error(`Runtime checksum changed: ${file}; reinstall the schedule from reviewed code`);
  }
  return manifest;
}

export async function installSchedule(info, options = {}) {
  if ((options.platform ?? process.platform) !== 'darwin') throw new Error('Automatic installation requires macOS; run prune --apply from your scheduler on other systems');
  const target = paths(info, options.home);
  const source = options.source ?? fileURLToPath(new URL('..', import.meta.url));
  const executables = options.executables ?? { node: process.execPath, git: executable('git'), gh: executable('gh'), lsof: executable('lsof') };
  for (const [name, location] of Object.entries(executables)) {
    if (!path.isAbsolute(location)) throw new Error(`${name} executable must be absolute`);
    await fs.access(location, 1);
  }
  const contents = await Promise.all(runtimeFiles.map((file) => fs.readFile(path.join(source, file))));
  const files = Object.fromEntries(runtimeFiles.map((file, index) => [file, hash(contents[index])]));
  const version = hash(JSON.stringify({ files, executables, primary: info.primary, commonDir: info.commonDir, repo: info.repo })).slice(0, 24);
  const runtime = path.join(info.stateDir, 'schedule/runtime', version);
  for (const directory of [info.stateDir, path.join(info.stateDir, 'schedule'), path.join(info.stateDir, 'schedule/runtime'), runtime, path.join(runtime, 'lib')]) {
    assertStatePath(info, directory);
    await physicalDirectory(directory);
  }
  for (const [index, file] of runtimeFiles.entries()) {
    const dest = path.join(runtime, file);
    try { await fs.writeFile(dest, contents[index], { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const manifest = path.join(runtime, 'manifest.json');
  const metadata = { version: 1, primary: info.primary, commonDir: info.commonDir, repo: info.repo, files, executables };
  try { await fs.writeFile(manifest, `${JSON.stringify(metadata, null, 2)}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  await verifyRuntime(manifest);
  const logs = path.join(info.stateDir, 'schedule/logs');
  assertStatePath(info, logs);
  await physicalDirectory(logs);
  await fs.mkdir(path.dirname(target.plist), { recursive: true });
  // Only trusted executable directories are added. Never inherit a worktree-relative PATH.
  const environmentPath = [...new Set([...Object.values(executables).map((p) => path.dirname(p)), '/usr/bin', '/bin', '/usr/sbin', '/sbin'])].join(':');
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${xml(target.label)}</string>
<key>ProgramArguments</key><array>${[executables.node, path.join(runtime, 'worktree-scheduled.mjs'), manifest].map((arg) => `<string>${xml(arg)}</string>`).join('')}</array>
<key>WorkingDirectory</key><string>${xml(info.primary)}</string>
<key>EnvironmentVariables</key><dict><key>PATH</key><string>${xml(environmentPath)}</string></dict>
<key>StartInterval</key><integer>86400</integer>
<key>RunAtLoad</key><true/>
<key>ProcessType</key><string>Background</string>
<key>StandardOutPath</key><string>${xml(path.join(logs, 'stdout.log'))}</string>
<key>StandardErrorPath</key><string>${xml(path.join(logs, 'stderr.log'))}</string>
</dict></plist>\n`;
  const launchctl = options.launchctl ?? ctl;
  if (launchctl(['print', `${domain()}/${target.label}`]).status === 0) check(launchctl(['bootout', `${domain()}/${target.label}`]), 'bootout');
  await fs.writeFile(target.plist, plist, { mode: 0o600 });
  const receipt = { ...target, manifest, installedAt: new Date().toISOString(), intervalSeconds: 86400, logs };
  await fs.writeFile(target.receipt, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
  if (options.activate !== false) await activateSchedule(receipt, options);
  return receipt;
}

// Call after releasing the maintenance lock: RunAtLoad starts the pruning process.
export async function activateSchedule(receipt, options = {}) {
  await verifyRuntime(receipt.manifest);
  check((options.launchctl ?? ctl)(['bootstrap', domain(), receipt.plist]), 'bootstrap');
}

export async function scheduleStatus(info, options = {}) {
  const target = paths(info, options.home);
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(target.receipt, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return { installed: false, ...target }; throw error; }
  const result = (options.launchctl ?? ctl)(['print', `${domain()}/${target.label}`]);
  let verified = true; let error;
  try { await verifyRuntime(receipt.manifest); } catch (e) { verified = false; error = e.message; }
  // launchctl prints inherited environment values; expose only the useful status fields.
  const field = (name) => result.stdout?.match(new RegExp(`^\\s*${name} = (.+)$`, 'm'))?.[1];
  return { ...receipt, installed: true, loaded: result.status === 0, verified, error, state: field('state'), runs: field('runs'), lastExitCode: field('last exit code'), pid: field('pid') };
}

export async function uninstallSchedule(info, options = {}) {
  const target = paths(info, options.home);
  const launchctl = options.launchctl ?? ctl;
  if (launchctl(['print', `${domain()}/${target.label}`]).status === 0) check(launchctl(['bootout', `${domain()}/${target.label}`]), 'bootout');
  await fs.rm(target.plist, { force: true });
  await fs.rm(target.receipt, { force: true });
  return { installed: false, ...target };
}
