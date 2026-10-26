import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { spawnSync } from 'node:child_process';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const fullSha = (value) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value ?? '');
const slug = (value) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(value ?? '');
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export function gitEnvironment() {
  const unsafe = Object.keys(process.env).filter((name) => /^GIT_(?:DIR|COMMON_DIR|WORK_TREE|IMPLICIT_WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|NAMESPACE|SHALLOW_FILE|GRAFT_FILE|REPLACE_REF_BASE|PREFIX|INTERNAL_SUPER_PREFIX|CONFIG(?:_.*)?)$/.test(name));
  if (unsafe.length) throw new Error(`Refusing repository overrides in environment: ${unsafe.join(', ')}`);
  return { ...process.env };
}

/** Validate existing path components before creating or accessing shared state. */
export function assertStatePath(info, location) {
  if (!path.isAbsolute(location) || (location !== info.stateDir && !location.startsWith(`${info.stateDir}${path.sep}`))) throw new Error('maintenance state path escapes its common directory');
  for (let current = location; ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink() || fs.realpathSync(current) !== current) throw new Error(`maintenance state path is not canonical (symlink): ${current}`);
      return location;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
}

function command(program, args, cwd, allowFailure = false, env) {
  const result = spawnSync(program, args, { cwd, env, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, timeout: 120_000 });
  if (result.error || (!allowFailure && result.status !== 0)) throw new Error(`${program} ${args[0]} failed: ${result.error?.message ?? result.stderr.trim()}`);
  return result;
}

function atomicFile(file, contents) {
  const temp = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temp, 'wx', 0o600);
  try { fs.writeFileSync(fd, contents); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temp, file);
  // Windows can't flush a directory handle (fsync is FlushFileBuffers there, which fails with EPERM).
  if (process.platform === 'win32') return;
  const directory = fs.openSync(path.dirname(file), 'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}

function githubRepository(url) {
  const match = /^(?:https:\/\/github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(url);
  if (!match) throw new Error('origin must identify a GitHub repository using HTTPS or SSH');
  return match[1];
}

async function githubRest({ repo, kind, branch }, executable = 'gh') {
  const endpoint = kind === 'repo' ? `repos/${repo}` : `repos/${repo}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${repo.split('/')[0]}:${branch}`)}`;
  const args = ['api', '--hostname', 'github.com', endpoint];
  if (kind === 'pulls') args.push('--paginate', '--slurp');
  const value = JSON.parse(command(executable, args).stdout);
  return kind === 'pulls' ? value.flat() : value;
}

async function processActivity(location, executable = 'lsof') {
  // Recursive lsof includes process cwd, mapped executables and open files. Errors
  // (including permission/traversal warnings) are uncertainty, never inactivity.
  const result = command(executable, ['-n', '-P', '-F', 'pfn', '+D', location], undefined, true);
  if (result.stderr.trim() || ![0, 1].includes(result.status)) throw new Error(`activity observation failed: ${result.stderr.trim()}`);
  return result.stdout.trim().length > 0;
}

function regenerable(file) {
  return /^(?:node_modules\/|(?:apps\/(?:desktop|site|store-desktop)|packages\/core)\/(?:node_modules|dist|test-results|playwright-report)\/)/.test(file);
}

/** Conservative local cleanup. GitHub and process observations are the only seams. */
export class WorktreeMaintenance {
  constructor({ cwd = process.cwd(), github, activity, executables = {} } = {}) {
    gitEnvironment();
    this.cwd = cwd;
    this.executables = executables;
    this.github = github ?? ((query) => githubRest(query, executables.gh));
    this.activity = activity ?? ((location) => processActivity(location, executables.lsof));
    this.lockContext = new AsyncLocalStorage();
  }

  git(args, cwd = this.cwd, allowFailure = false) { return command(this.executables.git ?? 'git', ['--no-replace-objects', '-C', cwd, ...args], undefined, allowFailure, gitEnvironment()); }
  text(args, cwd = this.cwd) { return this.git(args, cwd).stdout.trim(); }

  worktrees() {
    const records = [];
    let record;
    for (const field of this.git(['worktree', 'list', '--porcelain', '-z']).stdout.split('\0')) {
      if (!field) { if (record) records.push(record); record = undefined; continue; }
      const space = field.indexOf(' ');
      const key = space < 0 ? field : field.slice(0, space);
      const value = space < 0 ? true : field.slice(space + 1);
      // Git for Windows reports C:/ paths; resolve them so they compare equal to realpathSync's C:\ form.
      if (key === 'worktree') record = { path: path.resolve(value) };
      else if (record) record[key] = value;
    }
    if (record) records.push(record);
    return records;
  }

  branches() {
    return this.git(['for-each-ref', '--format=%(refname)%00%(objectname)%00%(symref)', 'refs/heads/']).stdout.trim().split('\n').filter(Boolean).map((line) => {
      const [ref, head, symbolicTarget] = line.split('\0');
      return { branch: ref.slice('refs/heads/'.length), head, ...(symbolicTarget ? { symbolicTarget } : {}) };
    });
  }

  directBranch(branch) {
    const result = this.git(['symbolic-ref', '-q', `refs/heads/${branch}`], this.cwd, true);
    if (![0, 1].includes(result.status)) throw new Error('local ref type is unknown');
    return result.status === 1;
  }

  async info() {
    const commonDir = fs.realpathSync(this.text(['rev-parse', '--path-format=absolute', '--git-common-dir']));
    const trees = this.worktrees();
    if (!trees[0]?.path || trees[0].bare) throw new Error('a primary checkout is required');
    const primary = fs.realpathSync(trees[0].path);
    const remoteHead = this.git(['symbolic-ref', '-q', 'refs/remotes/origin/HEAD'], this.cwd, true);
    const defaultBranch = remoteHead.status === 0 ? remoteHead.stdout.trim().replace(/^refs\/remotes\/origin\//, '') : trees[0].branch?.replace(/^refs\/heads\//, '') ?? 'main';
    // Read the configured URL, not `remote get-url`, which expands local insteadOf rules.
    const repo = githubRepository(this.text(['config', '--get', 'remote.origin.url']));
    const info = { primary, commonDir, stateDir: path.join(commonDir, 'modex-maintenance'), repo, defaultBranch };
    if (commonDir.startsWith(`${path.join(primary, '.worktrees')}${path.sep}`)) throw new Error('common Git state is inside a managed worktree');
    assertStatePath(info, info.stateDir);
    return info;
  }

  async discover() {
    const info = await this.info();
    if (this.text(['for-each-ref', '--format=%(refname)', 'refs/replace/']) || fs.existsSync(path.join(info.commonDir, 'info', 'grafts'))) throw new Error('replacement objects or grafts make merge ancestry ambiguous');
    const metadata = await this.github({ repo: info.repo, kind: 'repo' });
    if (metadata?.full_name?.toLowerCase() !== info.repo.toLowerCase() || !metadata.default_branch) throw new Error('GitHub repository identity or default branch is unknown');
    this.git(['check-ref-format', `refs/heads/${metadata.default_branch}`]);
    info.defaultBranch = metadata.default_branch;
    this.git(['fetch', '--no-prune', '--no-tags', 'origin', `+refs/heads/${info.defaultBranch}:refs/remotes/origin/${info.defaultBranch}`]);
    info.defaultHead = this.text(['rev-parse', '--verify', `refs/remotes/origin/${info.defaultBranch}^{commit}`]);
    return info;
  }

  async withLock(callback) {
    if (this.lockContext.getStore() === this) return callback();
    const info = await this.info();
    fs.mkdirSync(info.stateDir, { recursive: true, mode: 0o700 });
    const lock = assertStatePath(info, path.join(info.stateDir, 'lock'));
    try { fs.mkdirSync(lock, { mode: 0o700 }); } catch (error) {
      if (error.code === 'EEXIST') throw new Error(`maintenance lock exists: ${lock}; never expire ownership by age`);
      throw error;
    }
    try {
      atomicFile(path.join(lock, 'owner.json'), `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
      return await this.lockContext.run(this, callback);
    } finally {
      fs.unlinkSync(path.join(lock, 'owner.json'));
      fs.rmdirSync(lock);
    }
  }

  recordPath(info, branch) { return assertStatePath(info, path.join(info.stateDir, 'owners', `${sha256(branch)}.json`)); }

  async getRecord(branch) {
    const info = await this.info();
    try { return JSON.parse(fs.readFileSync(this.recordPath(info, branch), 'utf8')); } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  }

  writeRecord(info, record) {
    fs.mkdirSync(assertStatePath(info, path.join(info.stateDir, 'owners')), { recursive: true, mode: 0o700 });
    atomicFile(this.recordPath(info, record.branch), `${JSON.stringify(record, null, 2)}\n`);
    return record;
  }

  managed(info, location) {
    const relative = path.relative(path.join(info.primary, '.worktrees'), location);
    if (!slug(relative)) return false;
    try { return fs.realpathSync(location) === location && fs.realpathSync(path.dirname(location)) === path.join(info.primary, '.worktrees'); } catch { return false; }
  }

  async claim(branch, { owner = `pid:${process.pid}` } = {}) {
    return this.withLock(async () => {
      const info = await this.info();
      const trees = this.worktrees().filter((tree) => tree.branch === `refs/heads/${branch}`);
      if (trees.length !== 1 || !this.managed(info, trees[0].path)) throw new Error('claim requires one existing managed worktree');
      return this.writeRecord(info, { version: 1, status: 'claimed', branch, path: trees[0].path, head: trees[0].HEAD, owner, updatedAt: new Date().toISOString() });
    });
  }

  async release(branch, { expectedHead, expectedPath } = {}) {
    return this.withLock(async () => {
      const info = await this.info();
      if (!fullSha(expectedHead)) throw new Error('release requires the full exact expected HEAD SHA');
      this.git(['check-ref-format', `refs/heads/${branch}`]);
      if (!this.directBranch(branch)) throw new Error('cannot release a symbolic local branch');
      const head = this.text(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`]);
      if (head !== expectedHead) throw new Error('release expected HEAD changed');
      const trees = this.worktrees().filter((tree) => tree.branch === `refs/heads/${branch}`);
      if (expectedPath !== undefined && (trees.length !== 1 || trees[0].path !== path.resolve(expectedPath) || !this.managed(info, trees[0].path) || path.basename(trees[0].path) !== branch)) throw new Error('release worktree path or branch registration changed');
      if (branch === 'main' || branch === info.defaultBranch || trees.some((tree) => tree.path === info.primary)) throw new Error('cannot release primary or default branch');
      if (trees.length > 1) throw new Error('branch is checked out in multiple worktrees');
      if (trees[0]) {
        const reasons = this.treeReasons(info, trees[0]);
        if (reasons.length) throw new Error(`cannot release worktree: ${reasons.join(', ')}`);
      }
      const old = await this.getRecord(branch);
      return this.writeRecord(info, { version: 1, status: 'released', branch, head, path: trees[0]?.path ?? null, owner: old?.owner ?? null, updatedAt: new Date().toISOString() });
    });
  }

  treeReasons(info, tree) {
    const reasons = [];
    if (tree.path === info.primary) reasons.push('primary');
    if (tree.locked !== undefined) reasons.push('locked');
    if (tree.prunable !== undefined) reasons.push('prunable');
    if (tree.detached || !tree.branch) reasons.push('detached');
    if (!fs.existsSync(tree.path)) { reasons.push('missing'); return reasons; }
    if (!this.managed(info, tree.path)) reasons.push('outside-managed');
    try {
      // Status can be clean during an empty merge, sequencer operation or bisect.
      // Resolve the worktree's own Git directory, not the primary's shared state.
      const mergeHead = this.text(['rev-parse', '--path-format=absolute', '--git-path', 'MERGE_HEAD'], tree.path);
      const metadata = fs.readdirSync(path.dirname(mergeHead));
      if (metadata.some((name) => /^(?:MERGE_|BISECT_)/.test(name) || ['rebase-merge', 'rebase-apply', 'sequencer', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'REBASE_HEAD', 'SQUASH_MSG', 'AUTO_MERGE'].includes(name))) reasons.push('git-operation-in-progress');
      if (metadata.some((name) => name.endsWith('.lock'))) reasons.push('git-lock-present');
      // Git status and even non-forced worktree removal respect these flags and
      // can silently discard hidden tracked edits. Preserve sparse/assumed state.
      const tracked = this.git(['ls-files', '-v', '-z'], tree.path).stdout.split('\0').filter(Boolean);
      if (tracked.some((file) => /^[a-zS] /.test(file))) reasons.push('hidden-index-entries');
      if (this.git(['-c', 'core.filemode=true', '-c', 'core.fsmonitor=false', 'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignore-submodules=none'], tree.path).stdout) reasons.push('dirty');
      const ignored = this.git(['ls-files', '--others', '--ignored', '--exclude-standard', '--directory', '-z'], tree.path).stdout.split('\0').filter(Boolean);
      if (ignored.some((file) => !regenerable(file))) reasons.push('unknown-ignored-data');
      if (this.text(['rev-parse', 'HEAD'], tree.path) !== tree.HEAD) reasons.push('head-changed');
    } catch (error) { reasons.push(`worktree-observation-failed: ${error.message}`); }
    return reasons;
  }

  ancestor(head, base) {
    const result = this.git(['merge-base', '--is-ancestor', head, base], this.cwd, true);
    if (![0, 1].includes(result.status)) throw new Error('ancestry observation failed');
    return result.status === 0;
  }

  proof(info, row, pulls) {
    if (this.ancestor(row.head, info.defaultHead)) return { kind: 'ancestor', defaultHead: info.defaultHead };
    for (const pr of pulls) {
      if (pr.state !== 'closed' || !pr.merged_at || pr.head?.ref !== row.branch || pr.head?.sha !== row.head || pr.head?.repo?.full_name?.toLowerCase() !== info.repo.toLowerCase() || pr.base?.ref !== info.defaultBranch || pr.base?.repo?.full_name?.toLowerCase() !== info.repo.toLowerCase() || !fullSha(pr.merge_commit_sha)) continue;
      const merge = pr.merge_commit_sha;
      if (!this.ancestor(merge, info.defaultHead)) continue;
      const parents = this.text(['rev-list', '--parents', '-n', '1', merge]).split(' ').slice(1);
      if (parents.length !== 1) continue; // Only unambiguous single-parent squash commits.
      // An identical tree (every path, mode, blob and gitlink) means the tip is exactly the snapshot
      // that landed, so merge commits on the branch cannot hold anything the default branch lacks.
      const tree = this.text(['rev-parse', '--verify', `${row.head}^{tree}`]);
      if (fullSha(tree) && tree === this.text(['rev-parse', '--verify', `${merge}^{tree}`])) return { kind: 'squash-tree', pull: pr.number, mergeCommit: merge, tree, defaultHead: info.defaultHead };
      // A merge queue squashes the tip onto the default branch as it stands at the PR's turn. If the
      // tip merges cleanly onto the squash's parent and gives exactly the landed tree, every change on
      // the branch landed, merge commits included. A configured merge driver may resolve a path
      // however it likes, so the proof counts only Git's own merge.
      if (this.git(['config', '--get-regexp', '^merge\\..+\\.driver$'], this.cwd, true).status === 1) {
        const merged = this.git(['merge-tree', '--write-tree', '--no-messages', parents[0], row.head], this.cwd, true);
        const mergedTree = merged.status === 0 ? merged.stdout.trim() : '';
        if (fullSha(mergedTree) && mergedTree === this.text(['rev-parse', '--verify', `${merge}^{tree}`])) return { kind: 'merge-tree', pull: pr.number, mergeCommit: merge, base: parents[0], tree: mergedTree, defaultHead: info.defaultHead };
      }
      const bases =this.text(['merge-base', '--all', row.head, parents[0]]).split('\n');
      if (bases.length !== 1 || !bases[0]) continue;
      if (this.text(['rev-list', '--min-parents=2', `${bases[0]}..${row.head}`])) continue;
      const flags = ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', '--no-color', '--ignore-submodules=none', '--submodule=short', '--no-relative'];
      const aggregate = this.git([...flags, bases[0], row.head, '--']).stdout;
      const landed = this.git([...flags, parents[0], merge, '--']).stdout;
      if (aggregate && aggregate === landed) return { kind: 'squash', pull: pr.number, mergeCommit: merge, base: bases[0], defaultHead: info.defaultHead, diffSha256: sha256(aggregate) };
    }
    return null;
  }

  async pullEvidence(info, row) {
    const pulls = await this.github({ repo: info.repo, kind: 'pulls', branch: row.branch });
    if (!Array.isArray(pulls) || pulls.some((pr) => !['open', 'closed'].includes(pr?.state) || typeof pr.head?.ref !== 'string' || !fullSha(pr.head?.sha) || (pr.head.repo !== null && typeof pr.head.repo?.full_name !== 'string'))) throw new Error('invalid pull request response');
    if (pulls.some((pr) => pr.state === 'open' && pr.head.ref === row.branch && (!pr.head.repo || pr.head.repo.full_name.toLowerCase() === info.repo.toLowerCase()))) throw new Error('open-pr');
    return pulls;
  }

  async inspect(info, row, trees) {
    const reasons = [];
    const registrations = trees.filter((tree) => tree.branch === `refs/heads/${row.branch}`);
    const tree = registrations[0];
    row.path = tree?.path ?? null;
    if (row.symbolicTarget || !this.directBranch(row.branch)) reasons.push('symbolic-branch');
    if (row.branch === 'main' || row.branch === info.defaultBranch) reasons.push('default-branch');
    if (registrations.length > 1) reasons.push('multiple-worktrees');
    let record;
    try { record = await this.getRecord(row.branch); } catch { reasons.push('invalid-ownership-record'); }
    if (!record || record.version !== 1 || record.status !== 'released') reasons.push('unreleased');
    else if (record.branch !== row.branch || record.head !== row.head || record.path !== row.path) reasons.push('release-changed');
    if (tree) reasons.push(...this.treeReasons(info, tree));
    // A released path must remain registered. A missing registration is not consent
    // to discard a branch whose worktree may have been manually moved.
    if (!tree && record?.path) reasons.push('registration-changed');
    if (reasons.length) return { ...row, eligible: false, reasons };
    try {
      const pulls = await this.pullEvidence(info, row);
      if (tree) {
        const active = await this.activity(tree.path);
        if (typeof active !== 'boolean') throw new Error('unknown process activity');
        if (active) reasons.push('active-process');
      }
      if (!reasons.length) row.proof = this.proof(info, row, pulls);
      if (!row.proof && !reasons.length) reasons.push('not-proven-merged');
    } catch (error) { reasons.push(`observation-failed: ${error.message}`); }
    return { ...row, eligible: reasons.length === 0, reasons };
  }

  async audit() {
    const branches = this.branches();
    let info;
    try { info = await this.discover(); } catch (error) {
      return { info: await this.info(), branches: branches.map((row) => ({ ...row, eligible: false, reasons: ['remote-observation-failed'] })), errors: [error.message] };
    }
    const trees = this.worktrees();
    const rows = [];
    for (const row of branches) rows.push(await this.inspect(info, row, trees));
    return { info, branches: rows, errors: [], worktrees: trees };
  }

  persistManifest(run) {
    assertStatePath(run, run.manifest);
    const contents = `${JSON.stringify(run, null, 2)}\n`;
    atomicFile(run.manifest, contents);
    atomicFile(`${run.manifest}.sha256`, `${sha256(contents)}\n`);
  }

  archive(info, candidates) {
    const id = `${new Date().toISOString().replaceAll(/[:.]/g, '-')}-${randomUUID()}`;
    const directory = assertStatePath(info, path.join(info.stateDir, 'archives', id));
    if (candidates.some((row) => row.path && (directory === row.path || directory.startsWith(`${row.path}${path.sep}`)))) throw new Error('archive location must be outside every removal target');
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    const run = { version: 1, id, repo: info.repo, stateDir: info.stateDir, createdAt: new Date().toISOString(), bundle: path.join(directory, 'archive.bundle'), manifest: path.join(directory, 'manifest.json'), entries: [], results: [] };
    for (const row of candidates) {
      const archiveRef = `refs/tags/modex-archive/${id}/${sha256(row.branch).slice(0, 20)}`;
      this.git(['update-ref', '--no-deref', archiveRef, row.head, '']);
      run.entries.push({ branch: row.branch, head: row.head, path: row.path, proof: row.proof, archiveRef, restore: `git fetch ${quote(run.bundle)} ${quote(`${archiveRef}:refs/heads/restored-${sha256(row.branch).slice(0, 12)}`)}` });
    }
    this.git(['bundle', 'create', run.bundle, ...run.entries.map((entry) => entry.archiveRef)]);
    // With no exclusions, the bundle has complete history and no prerequisites.
    this.git(['bundle', 'verify', run.bundle]);
    const restore = fs.mkdtempSync(path.join(os.tmpdir(), 'modex-archive-proof-'));
    try {
      this.git(['init', '--bare', '--template=', restore]);
      this.git(['fetch', run.bundle, ...run.entries.map((entry) => `${entry.archiveRef}:${entry.archiveRef}`)], restore);
      for (const entry of run.entries) if (this.text(['rev-parse', `${entry.archiveRef}^{commit}`], restore) !== entry.head) throw new Error('bundle restored SHA mismatch');
      this.git(['fsck', '--full'], restore);
    } finally { fs.rmSync(restore, { recursive: true, force: true }); }
    const bundleFd = fs.openSync(run.bundle, 'r');
    try { fs.fsyncSync(bundleFd); } finally { fs.closeSync(bundleFd); }
    run.bundleSha256 = sha256(fs.readFileSync(run.bundle));
    run.verifiedAt = new Date().toISOString();
    this.persistManifest(run);
    return run;
  }

  verifyArchive(run, entry) {
    for (const file of [run.bundle, run.manifest, `${run.manifest}.sha256`]) assertStatePath(run, file);
    const manifest = fs.readFileSync(run.manifest, 'utf8');
    if (sha256(manifest) !== fs.readFileSync(`${run.manifest}.sha256`, 'utf8').trim() || JSON.parse(manifest).bundleSha256 !== run.bundleSha256 || sha256(fs.readFileSync(run.bundle)) !== run.bundleSha256 || this.text(['rev-parse', entry.archiveRef]) !== entry.head) throw new Error('archive integrity changed');
  }

  async prune({ apply = false, branch } = {}) {
    return this.withLock(async () => {
      const report = await this.audit();
      report.results = [];
      const candidates = report.branches.filter((row) => row.eligible && (!branch || row.branch === branch));
      if (!apply || !candidates.length || report.errors.length) return report;
      let run;
      try { run = this.archive(report.info, candidates); report.run = run; } catch (error) {
        report.errors.push(`archive-failed: ${error.message}`); return report;
      }
      for (const candidate of candidates) {
        const entry = run.entries.find((item) => item.branch === candidate.branch);
        const result = { branch: candidate.branch, head: candidate.head, status: 'preserved', reasons: [] };
        try {
          // Re-fetch and reread every observation; the earlier audit is not authority.
          const info = await this.discover();
          if (info.repo !== report.info.repo || info.commonDir !== report.info.commonDir) throw new Error('repository identity changed');
          const current = this.branches().find((row) => row.branch === candidate.branch);
          if (!current || current.head !== candidate.head) throw new Error('head changed after audit');
          const checked = await this.inspect(info, current, this.worktrees());
          if (!checked.eligible || checked.path !== candidate.path) throw new Error(`revalidation: ${checked.reasons.join(', ') || 'path changed'}`);
          this.verifyArchive(run, entry);
          // External observations may themselves take time: repeat local checks after
          // them, immediately before invoking Git's non-forced worktree removal.
          const fresh = this.worktrees();
          const trees = fresh.filter((tree) => tree.branch === `refs/heads/${candidate.branch}`);
          if (this.text(['rev-parse', `refs/heads/${candidate.branch}`]) !== candidate.head) throw new Error('head changed during observations');
          const record = await this.getRecord(candidate.branch);
          if (record?.status !== 'released' || record.head !== candidate.head || record.path !== candidate.path) throw new Error('release changed during observations');
          if (candidate.path) {
            if (trees.length !== 1 || trees[0].path !== candidate.path) throw new Error('registration changed during observations');
            const reasons = this.treeReasons(info, trees[0]);
            if (reasons.length) throw new Error(reasons.join(', '));
            this.git(['worktree', 'remove', candidate.path], info.primary);
            result.worktreeRemoved = true;
            if (fs.existsSync(candidate.path)) throw new Error('worktree removal not confirmed');
          }
          // Worktree removal and ref deletion are separate irreversible operations.
          // A newly opened PR or claim between them must keep the surviving ref.
          const finalInfo = await this.discover();
          const finalPulls = await this.pullEvidence(finalInfo, candidate);
          if (!this.proof(finalInfo, candidate, finalPulls)) throw new Error('merge proof changed before ref deletion');
          const finalRecord = await this.getRecord(candidate.branch);
          if (finalRecord?.status !== 'released' || finalRecord.head !== candidate.head || finalRecord.path !== candidate.path) throw new Error('release changed before ref deletion');
          if (!this.directBranch(candidate.branch)) throw new Error('branch became symbolic before deletion');
          if (this.worktrees().some((tree) => tree.branch === `refs/heads/${candidate.branch}`)) throw new Error('branch still checked out');
          if (candidate.branch === 'main' || candidate.branch === finalInfo.defaultBranch) throw new Error('default branch protected');
          this.verifyArchive(run, entry);
          this.git(['update-ref', '--no-deref', '-d', `refs/heads/${candidate.branch}`, candidate.head]);
          if (this.git(['show-ref', '--verify', '--quiet', `refs/heads/${candidate.branch}`], this.cwd, true).status !== 1) throw new Error('branch removal not confirmed');
          result.status = 'removed';
        } catch (error) { result.reasons.push(error.message); }
        report.results.push(result);
        run.results.push(result);
        this.persistManifest(run);
      }
      return report;
    });
  }
}
