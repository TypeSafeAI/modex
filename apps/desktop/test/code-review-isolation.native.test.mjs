import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';

// Opt-in operational evidence, not product capability detection. No live model or external provider request.
const run = promisify(execFile);
const native = process.env.MODEX_CR6_NATIVE === '1' && process.platform === 'darwin';
function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'modex-cr6-proof-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'snapshot'), home = path.join(root, 'home');
  fs.mkdirSync(repo); fs.mkdirSync(home); fs.mkdirSync(path.join(home, '.codex'));
  const selected = path.join(repo, 'selected.txt'), secret = path.join(root, 'synthetic-gh-credentials');
  fs.writeFileSync(selected, 'selected synthetic PR evidence');
  fs.writeFileSync(secret, 'synthetic-secret-only');
  fs.symlinkSync(secret, path.join(repo, 'escape-link'));
  const bin = fs.realpathSync(process.env.MODEX_CR6_CODEX_BIN ?? execFileSync('/usr/bin/which', ['codex'], { encoding: 'utf8', timeout: 5000, maxBuffer: 4096 }).trim());
  // A child-only disposable HOME and explicit environment; the developer's profile is never copied.
  const env = { HOME: home, CODEX_HOME: path.join(home, '.codex'), PATH: '/usr/bin:/bin:/usr/sbin:/sbin', TMPDIR: root, OPENSSL_CONF: '/dev/null' };
  const config = `[permissions.builtin]\nextends = ":read-only"\n[permissions.snapshot.filesystem]\n":minimal" = "read"\n${JSON.stringify(repo)} = "read"\n${JSON.stringify(fs.realpathSync(process.execPath))} = "read"\n[permissions.snapshot.network]\nenabled = false\n`;
  fs.writeFileSync(path.join(home, '.codex', 'config.toml'), config);
  const version = execFileSync(bin, ['--version'], { env, encoding: 'utf8', timeout: 5000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  t.diagnostic(JSON.stringify({ version, bin, os: os.release(), profiles: config.split(root).join('<fixture>') }));
  const invoke = async (profile, command, args, extraEnv = {}) => {
    try { const r = await run(bin, ['sandbox', '-P', profile, '-C', repo, '--', command, ...args], { cwd: repo, env: { ...env, ...extraEnv }, timeout: 10000, maxBuffer: 65536 }); return { code: 0, stdout: r.stdout, stderr: r.stderr, timedOut: false }; }
    catch (error) { return { code: error.code, stdout: String(error.stdout ?? ''), stderr: String(error.stderr ?? ''), timedOut: error.killed === true || error.code === 'ETIMEDOUT' }; }
  };
  return { root, repo, home, selected, secret, bin, env, invoke };
}
function denied(result) {
  assert.equal(result.timedOut, false, 'A timeout is not a policy denial');
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /[Oo]peration not permitted|[Pp]ermission denied/);
}

test('native Codex read-only denies writes but still permits shell, outside reads and inherited credentials', { skip: !native }, async t => {
  const f = fixture(t);
  const version = (await run(f.bin, ['--version'], { env: f.env, timeout: 5000, maxBuffer: 4096 })).stdout.trim();
  t.diagnostic(version);
  const read = await f.invoke('builtin', '/bin/cat', [f.selected]);
  assert.equal(read.code, 0, JSON.stringify(read));
  assert.equal(read.stdout, 'selected synthetic PR evidence');
  const write = await f.invoke('builtin', '/usr/bin/touch', [path.join(f.repo, 'write-marker')]);
  denied(write); assert.equal(fs.existsSync(path.join(f.repo, 'write-marker')), false);
  denied(await f.invoke('builtin', '/bin/sh', ['-c', `printf bad > ${JSON.stringify(f.selected)}`]));
  assert.equal(fs.readFileSync(f.selected, 'utf8'), 'selected synthetic PR evidence');
  const outsideWrite = await f.invoke('builtin', '/usr/bin/touch', [path.join(f.root, 'outside-write')]);
  denied(outsideWrite); assert.equal(fs.existsSync(path.join(f.root, 'outside-write')), false);
  assert.equal((await f.invoke('builtin', '/bin/sh', ['-c', 'printf synthetic-shell-executed'])).stdout, 'synthetic-shell-executed');
  assert.equal((await f.invoke('builtin', '/bin/cat', [f.secret])).stdout, 'synthetic-secret-only');
  assert.equal((await f.invoke('builtin', '/bin/sh', ['-c', 'printf %s "$GH_TOKEN"'], { GH_TOKEN: 'synthetic-gh-token' })).stdout, 'synthetic-gh-token');
  t.diagnostic('Observed counterexamples: shell execution, outside credential-file read, inherited GH_TOKEN. This profile does not satisfy CR-6.');
});

test('native Codex snapshot profile denies tested outside reads, writes and symlinks but still allows shell', { skip: !native }, async t => {
  const f = fixture(t);
  const read = await f.invoke('snapshot', '/bin/cat', [f.selected]);
  assert.equal(read.code, 0, JSON.stringify(read));
  assert.equal(read.stdout, 'selected synthetic PR evidence');
  denied(await f.invoke('snapshot', '/bin/cat', [f.secret]));
  denied(await f.invoke('snapshot', '/bin/cat', [path.join(f.repo, 'escape-link')]));
  denied(await f.invoke('snapshot', '/usr/bin/touch', [path.join(f.repo, 'write-marker')]));
  assert.equal(fs.existsSync(path.join(f.repo, 'write-marker')), false);
  assert.equal((await f.invoke('snapshot', '/bin/sh', ['-c', 'printf synthetic-shell-executed'])).stdout, 'synthetic-shell-executed');
  assert.equal((await f.invoke('snapshot', '/bin/sh', ['-c', 'printf %s "${GH_TOKEN-unset}"'])).stdout, 'unset');
  // Environment sanitization is a launcher property: the OS profile does not remove explicitly supplied credentials.
  assert.equal((await f.invoke('snapshot', '/bin/sh', ['-c', 'printf %s "$GH_TOKEN"'], { GH_TOKEN: 'synthetic-gh-token' })).stdout, 'synthetic-gh-token');
});

test('native Codex denies actual outbound loopback writes with a working unsandboxed receiver control', { skip: !native }, async t => {
  const f = fixture(t);
  let received = '';
  const sockets = new Set();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('data', bytes => { received += bytes; }); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); });
  const port = server.address().port;
  const script = `const net=require('node:net');const s=net.connect(${port},'127.0.0.1',()=>s.end('synthetic-network-marker'));s.on('error',e=>{console.error(e.code);process.exitCode=7});s.setTimeout(2000,()=>{console.error('timeout');s.destroy();process.exitCode=8});`;
  await run(process.execPath, ['-e', script], { env: f.env, timeout: 5000 });
  assert.equal(received, 'synthetic-network-marker'); received = '';
  for (const profile of ['builtin', 'snapshot']) {
    const result = await f.invoke(profile, process.execPath, ['-e', script]);
    t.diagnostic(JSON.stringify({ profile, network: result }));
    assert.equal(result.timedOut, false);
    assert.equal(result.code, 7);
    assert.match(result.stderr, /EPERM|EACCES/);
    assert.equal(received, '', 'Blocked write must not reach the same live listener');
    await run(process.execPath, ['-e', script], { env: f.env, timeout: 5000 });
    assert.equal(received, 'synthetic-network-marker', 'Receiver must still work after the denied attempt');
    received = '';
  }
});

// The provider fixture supplies adversarial tool calls; the installed Claude CLI makes the decisions.
// Synthetic usage counters are not live inference or actual charges.
import { claudeFixture } from './fixtures/code-review-native-isolation.mjs';
test('native Claude candidate denies injected shell/write/fetch/MCP/outside reads while selected evidence is readable', { skip: !native }, async t => {
  const result = await claudeFixture(t);
  t.diagnostic(JSON.stringify({ ...result, stdout: undefined, results: result.results.map(r => ({ id: r.tool_use_id, error: r.is_error === true, content: r.content })) }));
  assert.equal(result.timedOut, false); assert.equal(result.overflow, false); assert.equal(result.code, 0, result.stderr);
  assert.equal(result.turns, 2);
  assert.equal(result.selected, 'synthetic-selected-evidence');
  const byId = new Map(result.results.map(r => [r.tool_use_id, r]));
  assert.match(byId.get('read-good')?.content ?? '', /synthetic-selected-evidence/);
  assert.notEqual(byId.get('read-good')?.is_error, true);
  for (const id of ['read-secret', 'read-symlink', 'run-shell', 'write-file', 'external-write', 'mcp-write']) assert.equal(byId.get(id)?.is_error, true, id);
  assert.match(byId.get('read-secret').content, /outside.*--restricted confines/s);
  assert.match(byId.get('read-symlink').content, /resolves through a symlink.*--restricted confines/s);
  for (const [id, tool] of [['run-shell', 'Bash'], ['write-file', 'Write'], ['external-write', 'WebFetch'], ['mcp-write', 'mcp__sentinel__write']]) assert(byId.get(id).content.includes(`No such tool available: ${tool}`), id);
  assert(!JSON.stringify(result.results).includes('synthetic-outside-secret'));
  assert.deepEqual(result.markers, { write: false, hook: false, mcp: false });
  assert.deepEqual(result.advertised, ['Read']);
  assert(!result.requests.some(r => r.path.includes('unexpected-write')));
});

// The shipped confinement (CR-6, #325): --safe-mode in place of --bare, so the person's own Claude login works, with the same tool palette.
test('native Claude production confinement denies injected shell/write/fetch/MCP/outside reads while selected evidence is readable', { skip: !native }, async t => {
  const result = await claudeFixture(t, 'production');
  t.diagnostic(JSON.stringify({ ...result, stdout: undefined, results: result.results.map(r => ({ id: r.tool_use_id, error: r.is_error === true, content: r.content })) }));
  assert.equal(result.timedOut, false); assert.equal(result.overflow, false); assert.equal(result.code, 0, result.stderr);
  assert.equal(result.turns, 2);
  assert.equal(result.selected, 'synthetic-selected-evidence');
  const byId = new Map(result.results.map(r => [r.tool_use_id, r]));
  assert.match(byId.get('read-good')?.content ?? '', /synthetic-selected-evidence/);
  assert.notEqual(byId.get('read-good')?.is_error, true);
  for (const id of ['read-secret', 'read-symlink', 'run-shell', 'write-file', 'external-write', 'mcp-write']) assert.equal(byId.get(id)?.is_error, true, id);
  for (const [id, tool] of [['run-shell', 'Bash'], ['write-file', 'Write'], ['external-write', 'WebFetch'], ['mcp-write', 'mcp__sentinel__write']]) assert(byId.get(id).content.includes(`No such tool available: ${tool}`), id);
  assert(!JSON.stringify(result.results).includes('synthetic-outside-secret'));
  assert.deepEqual(result.markers, { write: false, hook: false, mcp: false });
  assert.deepEqual(result.advertised, ['Read']);
  assert(!result.requests.some(r => r.path.includes('unexpected-write')));
});

test('native Claude hook and MCP controls have working startup markers before candidate suppression is claimed', { skip: !native }, async t => {
  const hook = await claudeFixture(t, 'hook-control');
  t.diagnostic(JSON.stringify({ mode: 'hook-control', version: hook.version, code: hook.code, timedOut: hook.timedOut, markers: hook.markers, requests: hook.requests, stderr: hook.stderr }));
  assert.equal(hook.timedOut, false); assert.equal(hook.code, 0, hook.stderr); assert.equal(hook.markers.hook, true);
  assert.equal(hook.turns, 0, 'init-only must not request a synthetic model response');
  const mcp = await claudeFixture(t, 'mcp-control');
  t.diagnostic(JSON.stringify({ mode: 'mcp-control', version: mcp.version, code: mcp.code, timedOut: mcp.timedOut, markers: mcp.markers, requests: mcp.requests, stderr: mcp.stderr }));
  assert.equal(mcp.timedOut, false); assert.equal(mcp.code, 0, mcp.stderr); assert.equal(mcp.markers.mcp, true, 'Explicit fixture MCP config must actually spawn its command');
});
