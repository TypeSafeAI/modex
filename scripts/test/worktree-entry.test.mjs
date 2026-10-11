import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const entry = fileURLToPath(new URL('../worktree.sh', import.meta.url));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modex-entry-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const primary = path.join(dir, 'repo'); fs.mkdirSync(primary);
  const remote = path.join(dir, 'remote.git'); git(dir, 'init', '--bare', remote);
  git(primary, 'init', '-b', 'main');
  git(primary, 'config', 'user.name', 'Test'); git(primary, 'config', 'user.email', 'test@example.invalid');
  git(primary, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(primary, '.gitignore'), '.worktrees/\n');
  git(primary, 'add', '.'); git(primary, 'commit', '-m', 'initial');
  git(primary, 'remote', 'add', 'origin', 'https://github.com/example/modex.git');
  git(primary, 'config', `url.${remote}.insteadOf`, 'https://github.com/example/modex.git');
  git(primary, 'push', '-u', 'origin', 'main');
  const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\necho "offline fixture" >&2\nexit 1\n', { mode: 0o700 });
  const invoke = (cwd, ...args) => spawnSync('bash', [entry, ...args], { cwd, encoding: 'utf8', timeout: 20000, env: { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH}` } });
  return { primary, invoke, bin };
}

test('remove never removes an unmerged checkout before proving delivery', (t) => {
  const { primary, invoke } = fixture(t);
  const dest = path.join(primary, '.worktrees', 'pending');
  git(primary, 'worktree', 'add', '-b', 'pending', dest, 'main');
  fs.writeFileSync(path.join(dest, 'work.txt'), 'unlanded work\n');
  git(dest, 'add', '.'); git(dest, 'commit', '-m', 'unmerged');
  const result = invoke(primary, 'remove', 'pending');
  assert.notEqual(result.status, 0, result.stdout + result.stderr);
  assert.ok(fs.existsSync(dest), 'the checkout must survive failed merge proof');
  assert.equal(git(primary, 'rev-parse', 'pending'), git(dest, 'rev-parse', 'HEAD'));
});

test('new claims ownership; release disables check until explicitly reclaimed', (t) => {
  const { primary, invoke } = fixture(t);
  const created = invoke(primary, 'new', 'owned', '--no-install');
  assert.equal(created.status, 0, created.stderr);
  const dest = created.stdout.trim().split('\n').at(-1);
  assert.equal(dest, path.join(fs.realpathSync(primary), '.worktrees', 'owned'));
  assert.equal(invoke(dest, 'check').status, 0);
  const head = git(dest, 'rev-parse', 'HEAD');
  const release = invoke(primary, 'release', 'owned', '--expect-head', head);
  assert.equal(release.status, 0, release.stderr);
  assert.notEqual(invoke(dest, 'check').status, 0);
  assert.equal(invoke(primary, 'claim', 'owned', '--owner', 'resumed-session').status, 0);
  assert.equal(invoke(dest, 'check').status, 0);
  assert.notEqual(invoke(primary, 'check').status, 0);
});

test('unknown options and unsafe names fail before creating anything', (t) => {
  const { primary, invoke } = fixture(t);
  assert.notEqual(invoke(primary, 'new', '../escape', '--no-install').status, 0);
  assert.notEqual(invoke(primary, 'new', 'valid', '--force').status, 0);
  assert.equal(fs.existsSync(path.join(primary, '.worktrees', 'valid')), false);
});

test('remove refuses a directory whose branch no longer matches its session name', (t) => {
  const { primary, invoke } = fixture(t);
  const created = invoke(primary, 'new', 'named', '--no-install');
  assert.equal(created.status, 0, created.stderr);
  const dest = created.stdout.trim();
  git(dest, 'switch', '-c', 'replacement');
  const result = invoke(primary, 'remove', 'named');
  assert.notEqual(result.status, 0);
  const records = fs.readdirSync(path.join(primary, '.git/modex-maintenance/owners')).map((file) => JSON.parse(fs.readFileSync(path.join(primary, '.git/modex-maintenance/owners', file), 'utf8')));
  assert.equal(records.find((row) => row.branch === 'named').status, 'claimed', 'a mismatched directory must not release an unrelated branch');
  assert.ok(fs.existsSync(dest));
});

for (const observationFails of [false, true]) {
  test(`remove completes the real CLI archive flow${observationFails ? ' but reports a failed final observation' : ''}`, (t) => {
    const { primary, invoke, bin } = fixture(t);
    const created = invoke(primary, 'new', 'done', '--no-install');
    assert.equal(created.status, 0, created.stderr);
    fs.writeFileSync(path.join(bin, 'gh'), '#!/bin/sh\ncase "$*" in *"/pulls?"*) echo "[]";; *) echo \'{"full_name":"example/modex","default_branch":"main"}\';; esac\n', { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'lsof'), '#!/bin/sh\nexit 1\n', { mode: 0o700 });
    if (observationFails) {
      const actualGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
      const quotedGit = `'${actualGit.replaceAll("'", "'\\''")}'`;
      fs.writeFileSync(path.join(bin, 'git'), `#!/bin/sh\nif [ "$1" = show-ref ]; then echo 'observation unavailable' >&2; exit 129; fi\nexec ${quotedGit} "$@"\n`, { mode: 0o700 });
    }
    const result = invoke(primary, 'remove', 'done');
    if (observationFails) assert.notEqual(result.status, 0, 'uncertain completion must not be reported as success');
    else assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.equal(fs.existsSync(created.stdout.trim()), false);
    const archives = path.join(primary, '.git/modex-maintenance/archives');
    assert.ok(fs.readdirSync(archives).some((run) => fs.existsSync(path.join(archives, run, 'archive.bundle'))));
  });
}
