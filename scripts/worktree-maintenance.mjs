#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { WorktreeMaintenance, gitEnvironment } from './lib/worktree-maintenance.mjs';
import { installSchedule, activateSchedule, scheduleStatus, uninstallSchedule } from './lib/worktree-schedule.mjs';

const usage = `Usage: scripts/worktree.sh <command>
  new <name> [--no-install]          create and claim a session worktree
  check                            require an active managed worktree
  claim <name> [--owner <session>]  resume ownership (cancel release)
  release <branch> --expect-head <full-SHA>
                                   release this exact clean tip for later pruning
  list                             list registered worktrees
  audit [--json]                   report fresh eligibility, never delete
  prune [--apply] [--branch <name>] [--json]
                                   archive and prune eligible local work
  remove <name>                    release, archive, and prune one merged worktree
  schedule install|status|uninstall install a daily macOS user job or inspect it
See docs/worktree-hygiene.md for preservation rules and recovery.`;

function parse(args, flags = {}) {
  const positional = []; const options = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!arg.startsWith('-')) { positional.push(arg); continue; }
    if (!(arg in flags) || arg in options) throw new Error(`Unknown or repeated option: ${arg}`);
    options[arg] = flags[arg] ? args[++i] : true;
    if (flags[arg] && (!options[arg] || options[arg].startsWith('-'))) throw new Error(`Missing value for ${arg}`);
  }
  return { positional, options };
}
function count(args, length) { if (args.length !== length) throw new Error(usage); }
function slug(name) { if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name ?? '')) throw new Error('name must be a simple slug (letters, digits, - _)'); return name; }
function command(program, args, cwd, allowFailure = false) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', env: program === 'git' ? gitEnvironment() : process.env, timeout: 600_000, maxBuffer: 8 * 1024 * 1024 });
  if (!allowFailure && (result.error || result.status !== 0)) throw new Error(`${program} failed: ${result.error?.message ?? result.stderr}`);
  return result;
}
function report(value, json) {
  if (json) { console.log(JSON.stringify(value, null, 2)); return; }
  for (const row of value.branches ?? []) console.log(`${row.eligible ? 'eligible' : 'keep'} ${row.branch}: ${row.eligible ? row.proof.kind : row.reasons.join(', ')}`);
  for (const result of value.results ?? []) console.log(JSON.stringify(result));
  for (const error of value.errors ?? []) console.error(`preserved: ${error}`);
  if (value.run) console.log(`Recovery manifest: ${value.run.manifest}`);
}

export async function run(args = process.argv.slice(2), cwd = process.cwd()) {
  const [action, ...rest] = args;
  if (!action || ['help', '-h', '--help'].includes(action)) { console.log(usage); return 0; }
  const core = new WorktreeMaintenance({ cwd });
  if (action === 'audit' || action === 'prune') {
    const { positional, options } = parse(rest, action === 'audit' ? { '--json': false } : { '--json': false, '--apply': false, '--branch': true }); count(positional, 0);
    const value = action === 'audit' ? await core.audit() : await core.prune({ apply: !!options['--apply'], branch: options['--branch'] });
    report(value, options['--json']);
    return value.errors.length ? 1 : 0;
  }
  const info = await core.info();
  if (action === 'list') { count(rest, 0); console.log(command('git', ['worktree', 'list'], info.primary).stdout.trim()); return 0; }
  if (action === 'new') {
    const { positional, options } = parse(rest, { '--no-install': false }); count(positional, 1);
    const name = slug(positional[0]); const dest = path.join(info.primary, '.worktrees', name);
    await core.withLock(async () => {
      if (fs.existsSync(dest)) throw new Error(`${dest} already exists; use claim to resume it`);
      if (command('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], info.primary, true).status === 0) throw new Error(`Branch ${name} already exists; use a new session name`);
      const fetched = command('git', ['fetch', '--no-prune', '--no-tags', 'origin', `+refs/heads/${info.defaultBranch}:refs/remotes/origin/${info.defaultBranch}`], info.primary, true);
      if (fetched.status !== 0) console.error(`note: fetch failed; creating from local origin/${info.defaultBranch}`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      command('git', ['worktree', 'add', '-q', '-b', name, dest, `refs/remotes/origin/${info.defaultBranch}`], info.primary);
      await core.claim(name, { owner: process.env.CODEX_THREAD_ID ?? `session:${name}` });
    });
    if (!options['--no-install'] && fs.existsSync(path.join(dest, 'package.json'))) {
      const install = command('npm', ['ci', '--no-audit', '--no-fund', '--loglevel=error'], dest, true);
      if (install.status !== 0 || command('npm', ['run', 'build', '-w', '@modex/core'], dest, true).status !== 0) console.error('note: dependency setup failed; run npm ci && npm run build inside the worktree');
    }
    console.log(dest); return 0;
  }
  if (action === 'check') {
    count(rest, 0);
    const root = fs.realpathSync(command('git', ['rev-parse', '--show-toplevel'], cwd).stdout.trim());
    const name = path.relative(path.join(info.primary, '.worktrees'), root);
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) throw new Error(`Work in an isolated checkout: scripts/worktree.sh new <name> (primary: ${info.primary})`);
    const branch = command('git', ['branch', '--show-current'], cwd).stdout.trim();
    const record = await core.getRecord(branch);
    if (branch !== name || record?.status !== 'claimed' || record.path !== root) throw new Error(`Worktree is unclaimed or released. Resume it explicitly: scripts/worktree.sh claim ${name}`);
    console.log(`ok: ${root} on ${branch}`); return 0;
  }
  if (action === 'claim') {
    const { positional, options } = parse(rest, { '--owner': true }); count(positional, 1);
    const name = slug(positional[0]); await core.claim(name, { owner: options['--owner'] ?? process.env.CODEX_THREAD_ID ?? `session:${name}` });
    console.log(`claimed ${name}`); return 0;
  }
  if (action === 'release') {
    const { positional, options } = parse(rest, { '--expect-head': true }); count(positional, 1);
    const record = await core.release(positional[0], { expectedHead: options['--expect-head'] });
    console.log(`released ${record.branch} at ${record.head}; fresh merge, activity, and archive checks still required`); return 0;
  }
  if (action === 'remove') {
    count(rest, 1); const name = slug(rest[0]);
    const dest = path.join(info.primary, '.worktrees', name);
    await core.withLock(async () => {
      if (!fs.existsSync(dest)) throw new Error(`No worktree at ${dest}`);
      if (command('git', ['branch', '--show-current'], dest).stdout.trim() !== name) throw new Error(`Worktree branch does not match ${name}; reconcile its ownership before cleanup`);
      const head = command('git', ['rev-parse', '--verify', `refs/heads/${name}`], info.primary).stdout.trim();
      await core.release(name, { expectedHead: head, expectedPath: dest });
      const value = await core.prune({ apply: true, branch: name }); report(value, false);
      const removed = value.results.some((result) => result.branch === name && result.status === 'removed');
      const absent = command('git', ['show-ref', '--verify', '--quiet', `refs/heads/${name}`], info.primary, true).status === 1;
      if (!removed || fs.existsSync(dest) || !absent) throw new Error(`Cleanup of ${name} was not fully confirmed; inspect the report and any recovery manifest above. Claim retained work before resuming it`);
    });
    console.log(`removed worktree and archived local branch ${name}`); return 0;
  }
  if (action === 'schedule') {
    count(rest, 1);
    if (rest[0] === 'install') {
      const receipt = await core.withLock(() => installSchedule(info, { activate: false }));
      await activateSchedule(receipt);
      console.log(JSON.stringify(receipt, null, 2)); return 0;
    }
    const operation = { install: installSchedule, status: scheduleStatus, uninstall: uninstallSchedule }[rest[0]];
    if (!operation) throw new Error(usage);
    const value = rest[0] === 'status' ? await operation(info) : await core.withLock(() => operation(info));
    console.log(JSON.stringify(value, null, 2)); return 0;
  }
  throw new Error(usage);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await run(); } catch (error) { console.error(`refusing: ${error.message}`); process.exitCode = 1; }
}
