// Minimal bootstrap: verify the installed files before importing maintenance code.
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';

try {
  const manifestPath = process.argv[2];
  if (await fs.realpath(manifestPath) !== path.resolve(manifestPath)) throw new Error('Runtime manifest was redirected');
  const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
  const runtime = path.dirname(manifestPath);
  const required = ['worktree-maintenance.mjs', 'worktree-scheduled.mjs', 'lib/worktree-maintenance.mjs', 'lib/worktree-schedule.mjs'];
  if (manifest.version !== 1 || !path.isAbsolute(manifest.primary) || !path.isAbsolute(manifest.commonDir)) throw new Error('Invalid runtime manifest');
  if (!/^[a-f0-9]{24}$/.test(path.relative(path.join(manifest.commonDir, 'modex-maintenance/schedule/runtime'), runtime))) throw new Error('Runtime is outside the installed schedule directory');
  for (const file of required) {
    const location = path.join(runtime, file);
    if (await fs.realpath(location) !== path.resolve(location)) throw new Error(`Runtime file was redirected: ${file}`);
    const digest = createHash('sha256').update(await fs.readFile(location)).digest('hex');
    if (digest !== manifest.files?.[file]) throw new Error(`Runtime checksum changed: ${file}`);
  }
  const { WorktreeMaintenance } = await import(pathToFileURL(path.join(runtime, 'lib/worktree-maintenance.mjs')));
  for (const name of ['git', 'gh', 'lsof']) if (!path.isAbsolute(manifest.executables?.[name] ?? '')) throw new Error(`Missing pinned executable: ${name}`);
  const core = new WorktreeMaintenance({ cwd: manifest.primary, executables: manifest.executables });
  const info = await core.info();
  if (info.primary !== manifest.primary || info.commonDir !== manifest.commonDir || info.repo !== manifest.repo) throw new Error('Scheduled repository identity changed; reinstall after reviewing the new location');
  const report = await core.prune({ apply: true });
  const directory = path.join(info.stateDir, 'schedule/reports');
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}.json`);
  const contents = `${JSON.stringify(report, null, 2)}\n`;
  await fs.writeFile(`${target}.tmp`, contents, { flag: 'wx', mode: 0o600 });
  await fs.rename(`${target}.tmp`, target);
  console.log(JSON.stringify({ at: new Date().toISOString(), report: target, removed: report.results.filter((row) => row.status === 'removed').length, eligible: report.branches.filter((row) => row.eligible).length, errors: report.errors }));
  process.exitCode = report.errors.length ? 1 : 0;
} catch (error) {
  console.error(`${new Date().toISOString()} maintenance failed: ${error.message}. Inspect reports and archives for any partial results.`);
  process.exitCode = 1;
}
