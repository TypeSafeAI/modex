import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const module = await import('../lib/worktree-maintenance.mjs').catch(() => ({}));
const git = (cwd, ...args) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

function fixture(t) {
  assert.equal(typeof module.WorktreeMaintenance, 'function', 'maintenance safety API must exist');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'modex-hygiene-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const primary = path.join(dir, 'repo with spaces');
  const origin = path.join(dir, 'origin.git');
  fs.mkdirSync(primary);
  git(dir, 'init', '--bare', origin);
  git(primary, 'init', '-b', 'main');
  git(primary, 'config', 'user.name', 'Maintenance Test');
  git(primary, 'config', 'user.email', 'maintenance@example.invalid');
  git(primary, 'config', 'commit.gpgsign', 'false');
  fs.writeFileSync(path.join(primary, '.gitignore'), '.worktrees/\nnode_modules/\ndist/\ntest-results/\n.env\n.codex/\n.probes/\n');
  fs.writeFileSync(path.join(primary, 'code.txt'), 'initial\n');
  git(primary, 'add', '.');
  git(primary, 'commit', '-m', 'initial');
  git(primary, 'remote', 'add', 'origin', 'https://github.com/example/modex.git');
  git(primary, 'config', `url.${origin}.insteadOf`, 'https://github.com/example/modex.git');
  git(primary, 'push', '-u', 'origin', 'main');
  const f = { dir, primary, origin, pulls: [], active: false, activityCalls: 0 };
  f.github = async ({ kind }) => {
    if (f.apiError) throw new Error('API unavailable');
    return kind === 'repo' ? { full_name: 'example/modex', default_branch: 'main' } : f.pulls;
  };
  f.activity = async (location) => { f.activityCalls++; await f.onActivity?.(location); return f.active; };
  f.core = new module.WorktreeMaintenance({ cwd: primary, github: f.github, activity: f.activity });
  f.create = (name = 'done') => {
    const location = path.join(primary, '.worktrees', name);
    git(primary, 'worktree', 'add', '-b', name, location, 'main');
    fs.writeFileSync(path.join(location, 'code.txt'), `${name} work\n`);
    git(location, 'add', '.');
    git(location, 'commit', '-m', name);
    return { name, location, head: git(location, 'rev-parse', 'HEAD') };
  };
  f.merge = (w, squash = false) => {
    git(primary, 'merge', ...(squash ? ['--squash'] : ['--no-ff']), w.name, ...(squash ? [] : ['-m', 'merge']));
    if (squash) git(primary, 'commit', '-m', 'squash');
    git(primary, 'push', 'origin', 'main');
    if (squash) f.pulls = [{ number: 1, state: 'closed', merged_at: '2026-10-11T00:00:00Z', head: { ref: w.name, sha: w.head, repo: { full_name: 'example/modex' } }, base: { ref: 'main', repo: { full_name: 'example/modex' } }, merge_commit_sha: git(primary, 'rev-parse', 'HEAD') }];
  };
  f.release = (w) => f.core.release(w.name, { expectedHead: w.head });
  f.row = async (name = 'done') => (await f.core.audit()).branches.find((row) => row.branch === name);
  f.exists = (w) => fs.existsSync(w.location) && git(primary, 'rev-parse', `refs/heads/${w.name}`) === w.head;
  return f;
}

test('unreleased branches, primary and main are preserved', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w);
  const report = await f.core.prune({ apply: true });
  assert.equal(f.exists(w), true);
  assert.equal(report.branches.find((r) => r.branch === 'main').eligible, false);
  assert.ok((await f.row()).reasons.includes('unreleased'));
});

test('ownership is local, exact and resets release; lock is exclusive and safely nested', async (t) => {
  const f = fixture(t); const w = f.create(); f.apiError = true;
  const info = await f.core.info();
  assert.equal(info.primary, fs.realpathSync(f.primary));
  await assert.rejects(f.core.release(w.name, { expectedHead: w.head.slice(0, 8) }), /full|exact|SHA/i);
  await f.release(w);
  await f.core.withLock(async () => {
    const other = new module.WorktreeMaintenance({ cwd: f.primary });
    await assert.rejects(other.withLock(async () => {}), /lock/i);
    await f.core.claim(w.name, { owner: 'session-test' });
  });
  f.apiError = false;
  assert.ok((await f.row()).reasons.includes('unreleased'));
});

for (const kind of ['dirty', 'staged', 'untracked', 'ignored', 'codex', 'probes', 'locked', 'active', 'open-pr', 'api-failure', 'fetch-failure', 'changed-head', 'missing']) {
  test(`preserves released work when ${kind}`, async (t) => {
    const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
    if (kind === 'dirty' || kind === 'staged') { fs.appendFileSync(path.join(w.location, 'code.txt'), 'new work\n'); if (kind === 'staged') git(w.location, 'add', '.'); }
    if (kind === 'untracked') fs.writeFileSync(path.join(w.location, 'notes.txt'), 'user data');
    if (kind === 'ignored') fs.writeFileSync(path.join(w.location, '.env'), 'secret');
    if (kind === 'codex' || kind === 'probes') { fs.mkdirSync(path.join(w.location, `.${kind}`)); fs.writeFileSync(path.join(w.location, `.${kind}`, 'data'), 'user data'); }
    if (kind === 'locked') git(f.primary, 'worktree', 'lock', w.location);
    if (kind === 'active') f.active = true;
    if (kind === 'open-pr') f.pulls = [{ state: 'open', head: { ref: w.name, sha: w.head, repo: { full_name: 'example/modex' } }, base: { ref: 'other' } }];
    if (kind === 'api-failure') f.apiError = true;
    if (kind === 'fetch-failure') fs.renameSync(f.origin, `${f.origin}.unavailable`);
    if (kind === 'changed-head') { fs.appendFileSync(path.join(w.location, 'code.txt'), 'new commit\n'); git(w.location, 'commit', '-am', 'later'); }
    if (kind === 'missing') fs.renameSync(w.location, `${w.location}.moved`);
    await f.core.prune({ apply: true });
    assert.ok(git(f.primary, 'rev-parse', `refs/heads/${w.name}`));
    if (kind !== 'missing') assert.ok(fs.existsSync(w.location));
  });
}

test('activity observation failure preserves candidates', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
  f.onActivity = () => { throw new Error('lsof failed'); };
  await f.core.prune({ apply: true }); assert.equal(f.exists(w), true);
});

for (const squash of [false, true]) {
  test(`${squash ? 'exact squash' : 'direct merge'} archives a standalone recoverable tip before removing local work`, async (t) => {
    const f = fixture(t); const w = f.create(); f.merge(w, squash); await f.release(w);
    git(f.primary, 'push', 'origin', w.name);
    fs.mkdirSync(path.join(w.location, 'node_modules')); fs.writeFileSync(path.join(w.location, 'node_modules', 'cached'), 'generated');
    const dry = await f.core.prune(); assert.equal(dry.branches.find((r) => r.branch === w.name).eligible, true); assert.equal(f.exists(w), true);
    const result = await f.core.prune({ apply: true });
    assert.equal(fs.existsSync(w.location), false);
    assert.throws(() => git(f.primary, 'rev-parse', '--verify', `refs/heads/${w.name}`));
    assert.equal(git(f.origin, 'rev-parse', `refs/heads/${w.name}`), w.head, 'remote branch retained');
    assert.ok(result.run?.bundle);
    const restored = path.join(f.dir, 'restored.git'); git(f.dir, 'init', '--bare', restored);
    git(restored, 'fetch', result.run.bundle, '+refs/tags/*:refs/tags/*');
    assert.equal(git(restored, 'rev-parse', result.run.entries[0].archiveRef), w.head);
    git(restored, 'fsck', '--full');
    assert.ok(fs.existsSync(result.run.manifest));
  });
}

for (const kind of ['wrong-head', 'wrong-base', 'patch-mismatch']) {
  test(`rejects squash proof with ${kind}`, async (t) => {
    const f = fixture(t); const w = f.create(); f.merge(w, true); await f.release(w);
    if (kind === 'wrong-head') f.pulls[0].head.sha = '1'.repeat(40);
    if (kind === 'wrong-base') f.pulls[0].base.ref = 'other';
    if (kind === 'patch-mismatch') { fs.appendFileSync(path.join(f.primary, 'code.txt'), 'extra patch\n'); git(f.primary, 'commit', '-am', 'different squash', '--amend'); git(f.primary, 'push', '--force', 'origin', 'main'); f.pulls[0].merge_commit_sha = git(f.primary, 'rev-parse', 'HEAD'); }
    await f.core.prune({ apply: true }); assert.equal(f.exists(w), true);
  });
}

test('changed head after audit is preserved by apply', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
  assert.equal((await f.row()).eligible, true);
  fs.appendFileSync(path.join(w.location, 'code.txt'), 'later\n'); git(w.location, 'commit', '-am', 'later');
  await f.core.prune({ apply: true }); assert.ok(fs.existsSync(w.location));
});

test('bundle corruption during revalidation aborts removals', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
  f.onActivity = () => {
    const archives = path.join(f.primary, '.git', 'modex-maintenance', 'archives');
    if (!fs.existsSync(archives)) return;
    for (const run of fs.readdirSync(archives)) {
      const bundle = path.join(archives, run, 'archive.bundle');
      if (fs.existsSync(bundle)) fs.appendFileSync(bundle, 'corruption');
    }
  };
  await f.core.prune({ apply: true }); assert.equal(f.exists(w), true);
});

test('registered outside managed directory is preserved', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
  git(f.primary, 'worktree', 'move', w.location, path.join(f.dir, 'outside'));
  await f.core.prune({ apply: true }); assert.equal(git(f.primary, 'rev-parse', `refs/heads/${w.name}`), w.head);
});

test('branch newly checked out after release is preserved', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w);
  git(f.primary, 'worktree', 'remove', w.location); await f.release(w);
  git(f.primary, 'worktree', 'add', path.join(f.dir, 'new-checkout'), w.name);
  await f.core.prune({ apply: true }); assert.equal(git(f.primary, 'rev-parse', `refs/heads/${w.name}`), w.head);
});

test('released local branch without any checkout is archived and removed', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w);
  git(f.primary, 'worktree', 'remove', w.location); await f.release(w);
  const report = await f.core.prune({ apply: true });
  assert.equal(report.results[0].status, 'removed');
  assert.equal(report.run.entries[0].path, null);
  assert.throws(() => git(f.primary, 'rev-parse', '--verify', `refs/heads/${w.name}`));
});

for (const kind of ['head', 'dirty', 'locked', 'checkout']) {
  test(`rechecks ${kind} after asynchronous activity observations`, async (t) => {
    const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
    f.onActivity = () => {
      if (f.activityCalls !== 2) return;
      if (kind === 'head' || kind === 'dirty') fs.appendFileSync(path.join(w.location, 'code.txt'), 'racing work\n');
      if (kind === 'head') git(w.location, 'commit', '-am', 'race');
      if (kind === 'locked') git(f.primary, 'worktree', 'lock', w.location);
      if (kind === 'checkout') git(f.primary, 'worktree', 'add', '--force', path.join(f.dir, 'concurrent'), w.name);
    };
    await f.core.prune({ apply: true });
    assert.ok(fs.existsSync(w.location));
    assert.ok(git(f.primary, 'rev-parse', `refs/heads/${w.name}`));
  });
}

test('failed archive creation allows zero removals', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
  fs.writeFileSync(path.join(f.primary, '.git', 'modex-maintenance', 'archives'), 'cannot archive here');
  const report = await f.core.prune({ apply: true });
  assert.ok(report.errors.some((error) => error.startsWith('archive-failed:')));
  assert.equal(f.exists(w), true);
});

test('malformed PR evidence is uncertainty even for an ancestor tip', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
  f.pulls = [{ state: 'open' }];
  await f.core.prune({ apply: true });
  assert.equal(f.exists(w), true);
});

test('new open PR after worktree removal preserves the local branch', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
  const github = f.github;
  f.core.github = async (query) => {
    if (query.kind === 'pulls' && !fs.existsSync(w.location)) return [{ state: 'open', head: { ref: w.name, sha: w.head, repo: { full_name: 'example/modex' } } }];
    return github(query);
  };
  await f.core.prune({ apply: true });
  assert.equal(fs.existsSync(w.location), false);
  assert.equal(git(f.primary, 'rev-parse', `refs/heads/${w.name}`), w.head);
});

test('Git replacement objects cannot manufacture merge ancestry', async (t) => {
  const f = fixture(t); const w = f.create(); await f.release(w);
  git(f.primary, 'replace', git(f.primary, 'rev-parse', 'main'), w.head);
  await f.core.prune({ apply: true });
  assert.equal(f.exists(w), true);
});

for (const flag of ['--assume-unchanged', '--skip-worktree']) {
  test(`preserves hidden tracked edits using ${flag}`, async (t) => {
    const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
    git(w.location, 'update-index', flag, 'code.txt');
    fs.appendFileSync(path.join(w.location, 'code.txt'), 'hidden user work\n');
    assert.equal(git(w.location, 'status', '--porcelain'), '');
    await f.core.prune({ apply: true });
    assert.equal(f.exists(w), true);
  });
}

test('binary squash commits retain exact restorable file contents', async (t) => {
  const f = fixture(t); const w = f.create();
  const bytes = Buffer.from([0, 255, 12, 3, 88, 0, 42]);
  fs.writeFileSync(path.join(w.location, 'payload.bin'), bytes);
  git(w.location, 'add', '.'); git(w.location, 'commit', '-m', 'binary data');
  w.head = git(w.location, 'rev-parse', 'HEAD');
  f.merge(w, true); await f.release(w);
  const report = await f.core.prune({ apply: true });
  assert.equal(report.results[0].status, 'removed');
  const contents = execFileSync('git', ['-C', f.primary, 'show', `${report.run.entries[0].archiveRef}:payload.bin`]);
  assert.deepEqual(contents, bytes);
});

test('a unique commit appearing after worktree removal survives expected-SHA deletion', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
  let unique;
  const github = f.github;
  f.core.github = async (query) => {
    if (query.kind === 'pulls' && !fs.existsSync(w.location) && !unique) {
      unique = git(f.primary, 'commit-tree', `${w.head}^{tree}`, '-p', w.head, '-m', 'concurrent unique commit');
      git(f.primary, 'update-ref', `refs/heads/${w.name}`, unique, w.head);
    }
    return github(query);
  };
  const report = await f.core.prune({ apply: true });
  assert.equal(fs.existsSync(w.location), false);
  assert.equal(git(f.primary, 'rev-parse', `refs/heads/${w.name}`), unique);
  assert.equal(report.results[0].status, 'preserved');
  assert.equal(report.run.entries[0].head, w.head);
});

test('a clean interrupted merge remains active after release', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
  git(w.location, 'switch', '-c', 'empty-merge-source');
  git(w.location, 'commit', '--allow-empty', '-m', 'merge still in progress');
  git(w.location, 'switch', w.name);
  git(w.location, 'merge', '--no-ff', '--no-commit', 'empty-merge-source');
  assert.equal(git(w.location, 'status', '--porcelain'), '');
  await f.core.prune({ apply: true });
  assert.equal(f.exists(w), true);
});

for (const marker of ['rebase-merge', 'rebase-apply', 'sequencer', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'BISECT_START', 'SQUASH_MSG', 'MERGE_AUTOSTASH', 'index.lock', 'HEAD.lock', 'config.worktree.lock']) {
  test(`preserves per-worktree operation state ${marker}`, async (t) => {
    const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
    const markerPath = path.resolve(w.location, git(w.location, 'rev-parse', '--git-path', marker));
    if (['rebase-merge', 'rebase-apply', 'sequencer'].includes(marker)) fs.mkdirSync(markerPath);
    else fs.writeFileSync(markerPath, `${w.head}\n`);
    await f.core.prune({ apply: true });
    assert.equal(f.exists(w), true);
  });
}

test('default external observers use the pinned executable paths', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
  const location = path.join(f.dir, 'pinned executable.mjs');
  const calls = path.join(f.dir, 'pinned-calls');
  fs.writeFileSync(location, `#!${process.execPath}\nimport fs from 'node:fs';\nfs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\nconst args = process.argv.slice(2);\nif(args[0] === 'api') console.log(JSON.stringify(args.some(a => a.includes('/pulls?')) ? [[]] : {full_name:'example/modex',default_branch:'main'}));\nelse process.exit(1);\n`, { mode: 0o700 });
  const core = new module.WorktreeMaintenance({ cwd: f.primary, executables: { gh: location, lsof: location } });
  const report = await core.audit();
  assert.equal(report.branches.find((r) => r.branch === w.name).eligible, true);
  const observed = fs.readFileSync(calls, 'utf8').trim().split('\n').map(JSON.parse);
  assert.ok(observed.some((args) => args.includes('+D')));
  assert.ok(observed.some((args) => args.includes('--hostname')));
  const brokenGit = new module.WorktreeMaintenance({ cwd: f.primary, executables: { git: path.join(f.dir, 'missing-git') } });
  await assert.rejects(brokenGit.info(), /ENOENT/);
});

for (const change of ['switched', 'moved']) {
  test(`explicit path-bound release rejects a ${change} worktree`, async (t) => {
    const f = fixture(t); const w = f.create();
    if (change === 'switched') git(w.location, 'switch', '-c', 'replacement');
    else git(f.primary, 'worktree', 'move', w.location, path.join(f.primary, '.worktrees', 'different'));
    await assert.rejects(f.core.release(w.name, { expectedHead: w.head, expectedPath: w.location }), /path|registration/i);
    assert.equal(await f.core.getRecord(w.name), null);
  });
}

test('symbolic local branches cannot release or delete their protected target', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w);
  git(f.primary, 'worktree', 'remove', w.location);
  git(f.primary, 'symbolic-ref', `refs/heads/${w.name}`, 'refs/heads/main');
  const main = git(f.primary, 'rev-parse', 'main');
  await assert.rejects(f.core.release(w.name, { expectedHead: main }), /symbolic/i);
  await f.core.prune({ apply: true });
  assert.equal(git(f.primary, 'rev-parse', 'main'), main);
});

test('Git ignoreSubmodules cannot hide an unlanded gitlink from squash proof', async (t) => {
  const f = fixture(t);
  const oldLink = git(f.primary, 'rev-parse', 'main');
  git(f.primary, 'update-index', '--add', '--cacheinfo', `160000,${oldLink},vendor`);
  git(f.primary, 'commit', '-m', 'base gitlink'); git(f.primary, 'push', 'origin', 'main');
  const w = f.create();
  const newLink = git(f.primary, 'commit-tree', `${oldLink}^{tree}`, '-p', oldLink, '-m', 'unique unlanded gitlink');
  git(w.location, 'update-index', '--cacheinfo', `160000,${newLink},vendor`);
  git(w.location, 'commit', '-m', 'unlanded gitlink change'); w.head = git(w.location, 'rev-parse', 'HEAD');
  f.merge(w, true);
  git(f.primary, 'update-index', '--cacheinfo', `160000,${oldLink},vendor`);
  git(f.primary, 'commit', '--amend', '-m', 'only normal file landed');
  git(f.primary, 'push', '--force', 'origin', 'main'); f.pulls[0].merge_commit_sha = git(f.primary, 'rev-parse', 'main');
  git(f.primary, 'worktree', 'remove', w.location); await f.release(w);
  git(f.primary, 'config', 'diff.ignoreSubmodules', 'all');
  await f.core.prune({ apply: true });
  assert.equal(git(f.primary, 'rev-parse', `refs/heads/${w.name}`), w.head);
});

test('disabled filemode tracking cannot hide a user permission edit', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
  git(f.primary, 'config', 'core.filemode', 'false');
  fs.chmodSync(path.join(w.location, 'code.txt'), 0o755);
  assert.equal(git(w.location, 'status', '--porcelain'), '');
  await f.core.prune({ apply: true }); assert.equal(f.exists(w), true);
});

test('a late symbolic-ref substitution cannot delete main', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w);
  git(f.primary, 'reset', '--hard', w.head); git(f.primary, 'push', '--force', 'origin', 'main');
  await f.release(w);
  const github = f.github;
  f.core.github = async (query) => {
    if (query.kind === 'pulls' && !fs.existsSync(w.location)) git(f.primary, 'symbolic-ref', `refs/heads/${w.name}`, 'refs/heads/main');
    return github(query);
  };
  await f.core.prune({ apply: true });
  assert.equal(git(f.primary, 'rev-parse', 'refs/heads/main'), w.head);
  assert.equal(git(f.primary, 'symbolic-ref', `refs/heads/${w.name}`), 'refs/heads/main');
});

test('an inherited alternate index cannot hide unique staged user content', async (t) => {
  const f = fixture(t); const w = f.create(); f.merge(w); await f.release(w);
  fs.writeFileSync(path.join(w.location, 'code.txt'), 'unique staged work\n'); git(w.location, 'add', 'code.txt');
  fs.writeFileSync(path.join(w.location, 'code.txt'), 'done work\n');
  assert.match(git(w.location, 'status', '--porcelain'), /^MM code.txt$/);
  const source = `import { WorktreeMaintenance } from ${JSON.stringify(new URL('../lib/worktree-maintenance.mjs', import.meta.url).href)};
    try { await new WorktreeMaintenance({cwd:${JSON.stringify(f.primary)},github:async ({kind})=>kind==='repo'?{full_name:'example/modex',default_branch:'main'}:[],activity:async()=>false}).prune({apply:true}); console.log('unexpected success'); }
    catch(error) { console.log(error.message); }`;
  const output = execFileSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', env: { ...process.env, GIT_INDEX_FILE: path.join(f.primary, '.git', 'index') } });
  assert.ok(fs.existsSync(w.location), output);
  assert.match(output, /GIT_INDEX_FILE/);
  assert.equal(git(w.location, 'show', ':code.txt'), 'unique staged work');
});

for (const seam of ['state', 'archives', 'owners']) {
  test(`a symlinked ${seam} directory cannot move maintenance state into a removal target`, async (t) => {
    const f = fixture(t); const w = f.create(); f.merge(w);
    const state = path.join(f.primary, '.git', 'modex-maintenance');
    const sink = path.join(w.location, 'node_modules', 'maintenance'); fs.mkdirSync(sink, { recursive: true });
    if (seam === 'state') {
      fs.symlinkSync(sink, state);
      await assert.rejects(f.release(w), /symlink|canonical|state/i);
    } else if (seam === 'owners') {
      fs.mkdirSync(state); fs.symlinkSync(sink, path.join(state, 'owners'));
      await assert.rejects(f.release(w), /symlink|canonical|state/i);
    } else {
      await f.release(w); fs.symlinkSync(sink, path.join(state, 'archives'));
      await f.core.prune({ apply: true }).catch(() => {});
    }
    assert.equal(f.exists(w), true);
  });
}
