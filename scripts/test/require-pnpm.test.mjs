import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const guard = fileURLToPath(new URL('../require-pnpm.mjs', import.meta.url));
const root = fileURLToPath(new URL('../..', import.meta.url));
const run = (agent) => {
  const env = { ...process.env };
  delete env.npm_config_user_agent;
  if (agent !== undefined) env.npm_config_user_agent = agent;
  return spawnSync(process.execPath, [guard], { env, encoding: 'utf8' });
};

test('preinstall guard admits pnpm', () => {
  const result = run('pnpm/10.34.5 npm/? node/v24.18.1 darwin arm64');
  assert.equal(result.status, 0, result.stderr);
});

test('preinstall guard refuses other installers and names them', () => {
  for (const agent of ['npm/10.8.2 node/v20.18.0 darwin arm64', 'yarn/1.22.22 npm/? node/v24.18.1 darwin arm64', 'bun/1.2.15 npm/? node/v24.18.1 darwin arm64']) {
    const result = run(agent);
    assert.equal(result.status, 1, agent);
    assert.ok(result.stderr.includes(`not ${agent.split(' ')[0]}`), result.stderr);
  }
  const unknown = run(undefined);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /not an unknown installer/);
});

test('root manifest pins pnpm for Corepack, devEngines and the guard', () => {
  const pkg = JSON.parse(fs.readFileSync(`${root}/package.json`, 'utf8'));
  assert.match(pkg.packageManager, /^pnpm@\d+\.\d+\.\d+$/);
  // Vercel picks its pnpm from devEngines; an open range (>=) handed it pnpm 12, which
  // rejected this lockfile. Both ranges must stay on the pinned major.
  const major = pkg.packageManager.split('@')[1].split('.')[0];
  assert.ok(pkg.devEngines.packageManager.version.startsWith(`^${major}.`), pkg.devEngines.packageManager.version);
  assert.ok(pkg.engines.pnpm.startsWith(`^${major}.`), pkg.engines.pnpm);
  assert.equal(pkg.devEngines.packageManager.name, 'pnpm');
  assert.equal(pkg.devEngines.packageManager.onFail, 'error');
  assert.equal(pkg.scripts.preinstall, 'node scripts/require-pnpm.mjs');
  assert.equal(pkg.workspaces, undefined, 'workspaces live in pnpm-workspace.yaml');
  assert.ok(!fs.existsSync(`${root}/package-lock.json`), 'package-lock.json must not return');
});
