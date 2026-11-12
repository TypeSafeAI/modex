import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
// Test-harness diagnostics only. No application, request, trust or test-outcome authority.
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const PHASE = /^MODEX_PAIRING_TLS observer=([a-f0-9-]{36}) phase=(chain-start|chain-return|reject-challenge|reject-chain|accept-pin|reject-pin|completion-return)$/i;
const pidOK = pid => Number.isSafeInteger(pid) && pid > 1;
const identityMatches = (identity, image, at) => identity && identity.image === image
  && typeof identity.identity === 'string' && identity.identity.length > 0 && identity.identity.length <= 256
  && Number.isFinite(identity.startedAt) && identity.startedAt <= at;

export class TrustStallObserver {
  constructor({ deviceId, now = Date.now, appImage, identity, sample }) {
    if (!UUID.test(deviceId) || ![now, appImage, identity, sample].every(x => typeof x === 'function')) throw Error('Invalid trust observer configuration');
    Object.assign(this, { deviceId, now, appImage, identity, sample });
    this.pending = new Map(); this.seen = new Set(); this.controllers = new Set();
    this.closed = false; this.busy = false; this.captures = 0;
    this.report = { state: 'observing', observers: 0, samples: [], refusals: [], imageBindings: [] };
  }
  refuse(reason) { if (this.report.refusals.length < 16) this.report.refusals.push(reason); }
  recordImageBinding(event, key, at, outcome, error) {
    if (this.report.imageBindings.length >= 16) return;
    const row = { observer: key, pid: event.processID, boot: event.bootUUID,
      chainStartAt: new Date(at).toISOString(), observedAt: new Date(this.now()).toISOString(), outcome };
    if (error) {
      row.code = typeof error.code === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : 'IMAGE_LOOKUP_UNAVAILABLE';
      if (typeof error.closed === 'boolean') row.commandClosed = error.closed;
      if (pidOK(error.pid)) row.commandPid = error.pid;
    }
    this.report.imageBindings.push(row);
  }
  async ingest(event) {
    if (this.closed || !event || !pidOK(event.processID) || !UUID.test(event.bootUUID)
      || typeof event.eventMessage !== 'string' || event.eventMessage.length > 512
      || typeof event.processImagePath !== 'string' || event.processImagePath.length > 2048) return;
    const at = Date.parse(event.timestamp);
    if (!Number.isFinite(at) || at > this.now() + 1000 || this.now() - at > 15000) return;
    const phase = PHASE.exec(event.eventMessage);
    if (phase && UUID.test(phase[1])) {
      const key = phase[1], existing = this.pending.get(key);
      if (phase[2] !== 'chain-start') {
        if (existing && existing.pid === event.processID && existing.image === event.processImagePath && existing.boot === event.bootUUID) {
          existing.returned = true; existing.controller?.abort(); this.pending.delete(key);
        }
        return;
      }
      if (this.seen.has(key)) return;
      if (this.seen.size >= 128 || this.pending.size >= 32) { this.refuse('observer-limit'); this.close(); return; }
      let image;
      try { image = await this.appImage(); }
      catch (error) {
        const stage = ['container-query', 'image-realpath'].includes(error?.imageStage) ? error.imageStage : 'lookup';
        this.recordImageBinding(event, key, at, `${stage}-failed`, error);
        this.refuse('app-image'); return;
      }
      const outcome = typeof image !== 'string' ? 'image-unavailable'
        : image !== event.processImagePath ? 'image-mismatch'
        : !image.includes(`/CoreSimulator/Devices/${this.deviceId}/data/Containers/Bundle/Application/`) ? 'device-path-mismatch'
        : !image.endsWith('/ModexCompanion.app/ModexCompanion') ? 'bundle-path-mismatch' : 'matched';
      this.recordImageBinding(event, key, at, outcome);
      if (outcome !== 'matched') { this.refuse('app-image'); return; }
      const snapshot = await this.identity(event.processID, image);
      if (!identityMatches(snapshot, image, at)) { this.refuse('app-identity'); return; }
      if (this.closed) return;
      this.seen.add(key); this.report.observers = this.seen.size;
      this.pending.set(key, { key, pid: event.processID, image, boot: event.bootUUID, at, since: this.now(), thread: pidOK(event.threadID) ? event.threadID : null, identity: { ...snapshot }, returned: false });
      return;
    }
    for (const entry of this.pending.values()) {
      if (event.bootUUID !== entry.boot || at < entry.at) continue;
      if (event.processID === entry.pid && event.processImagePath === entry.image && event.eventMessage === 'SecTrustEvaluateIfNecessary'
        && entry.thread !== null && event.threadID === entry.thread && Number.isSafeInteger(event.activityIdentifier) && event.activityIdentifier > 0) {
        entry.activity = event.activityIdentifier;
      } else if (entry.activity && event.activityIdentifier === entry.activity && event.processImagePath.endsWith('/RuntimeRoot/usr/libexec/trustd')
        && event.eventMessage.includes(`com.apple.trustd.peer[${entry.pid}]`)) {
        const snapshot = await this.identity(event.processID, event.processImagePath);
        if (identityMatches(snapshot, event.processImagePath, at) && !entry.returned && !this.closed) {
          entry.daemon = { pid: event.processID, image: event.processImagePath, at, identity: { ...snapshot } };
        }
      }
    }
  }
  async tick() {
    if (this.closed || this.busy || this.captures >= 2) return;
    this.busy = true;
    try {
      for (const entry of this.pending.values()) {
        if (this.closed || this.captures >= 2) break;
        if (entry.returned || entry.sampled || this.now() - entry.since < 5000) continue;
        entry.sampled = true;
        const current = await this.identity(entry.pid, entry.image);
        if (this.closed || entry.returned) continue;
        if (!identityMatches(current, entry.image, entry.at) || current.identity !== entry.identity.identity || current.startedAt !== entry.identity.startedAt) {
          this.report.samples.push({ observer: entry.key, role: 'app', state: 'identity-refused' }); this.captures++; continue;
        }
        this.captures++;
        await this.collect(entry, { role: 'app', pid: entry.pid, image: entry.image, at: entry.at, identity: entry.identity });
        if (this.closed || entry.returned) continue;
        if (!entry.daemon) { this.report.samples.push({ observer: entry.key, role: 'trustd', state: 'unavailable', code: 'no-correlated-daemon' }); continue; }
        await this.collect(entry, { role: 'trustd', ...entry.daemon });
      }
    } finally { this.busy = false; }
  }
  async collect(entry, target) {
    const row = { observer: entry.key, role: target.role, pid: target.pid, activity: entry.activity ?? null, thread: entry.thread, boot: entry.boot, chainStartAt: new Date(entry.at).toISOString(), sampledAt: new Date(this.now()).toISOString(), state: 'checking' };
    this.report.samples.push(row);
    const current = await this.identity(target.pid, target.image);
    if (this.closed || entry.returned) { row.state = 'cancelled'; return; }
    if (!identityMatches(current, target.image, target.at) || current.identity !== target.identity.identity || current.startedAt !== target.identity.startedAt) { row.state = 'identity-refused'; return; }
    const controller = new AbortController(); entry.controller = controller; this.controllers.add(controller);
    try {
      const result = await this.sample(target.pid, { signal: controller.signal, role: target.role, observer: entry.key });
      row.state = controller.signal.aborted ? 'cancelled' : 'sampled';
      if (!controller.signal.aborted) { row.bytes = result.bytes; row.file = result.file; if (result.sha256) row.sha256 = result.sha256; }
    } catch (error) { row.state = controller.signal.aborted ? 'cancelled' : 'unavailable'; row.code = typeof error.code === 'string' ? error.code.slice(0,64) : 'sample-failed'; if (error.closed === false) { row.commandClosed = false; row.commandPid = error.pid; this.close(); } }
    finally { this.controllers.delete(controller); if (entry.controller === controller) delete entry.controller; }
  }
  close() { this.closed = true; this.report.state = 'stopped'; for (const c of this.controllers) c.abort(); }
}

const commandEnv = { PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LC_ALL: 'C', TZ: 'UTC' };
export function runBounded(binary, args, { signal, maxBytes = 1024 * 1024, timeoutMs = 5000 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 1024 * 1024
    || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 5000) return Promise.reject(Object.assign(Error('Invalid command bounds'), { code: 'INVALID_BOUNDS' }));
  if (signal?.aborted) return Promise.reject(Object.assign(Error('Aborted before spawn'), { code: 'ABORT_ERR', closed: true }));
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], env: commandEnv });
    const out = [], err = []; let bytes = 0, reason, settled = false, force, final;
    const finish = (code, closed) => {
      if (settled) return; settled = true;
      clearTimeout(timer); clearTimeout(force); clearTimeout(final); signal?.removeEventListener('abort', abort);
      if (reason || code !== 0) reject(Object.assign(Error('Diagnostic command unavailable'), { code: reason ?? 'COMMAND_FAILED', closed, pid: child.pid }));
      else resolve({ stdout: Buffer.concat(out), stderr: Buffer.concat(err), pid: child.pid, closed });
    };
    const stop = code => {
      if (reason || settled) return; reason = code;
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
      force = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }, 250);
      final = setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); finish(null, false); }, 1000);
    };
    const abort = () => stop('ABORT_ERR');
    const timer = setTimeout(() => stop('COMMAND_TIMEOUT'), timeoutMs);
    signal?.addEventListener('abort', abort, { once: true });
    for (const [stream, chunks] of [[child.stdout, out], [child.stderr, err]]) stream.on('data', chunk => {
      if (reason) return; bytes += chunk.length;
      if (bytes > maxBytes) { stop('OUTPUT_LIMIT'); return; }
      chunks.push(chunk);
    });
    child.once('error', error => { reason = typeof error.code === 'string' ? error.code : 'SPAWN_FAILED'; finish(null, true); });
    child.once('close', code => finish(code, true));
    if (signal?.aborted) abort();
  });
}

async function currentIdentity(pid, image, signal, command = runBounded) {
  try {
    const { stdout } = await command('/bin/ps', ['-ww', '-p', String(pid), '-o', 'uid=', '-o', 'lstart=', '-o', 'command='], { signal, maxBytes: 8192, timeoutMs: 2000 });
    const match = /^\s*(\d+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d\d:\d\d:\d\d\s+\d{4})\s+(.+?)\s*$/.exec(stdout.toString());
    if (!match || Number(match[1]) !== process.getuid() || !(match[3] === image || match[3].startsWith(image + ' '))) return undefined;
    const startedAt = Date.parse(match[2] + ' UTC');
    if (!Number.isFinite(startedAt)) return undefined;
    return { image, startedAt, identity: crypto.createHash('sha256').update(match[1] + match[2] + match[3]).digest('hex') };
  } catch { return undefined; }
}

export async function captureStack(pid, { directory, role, observer, signal, expectedStartedAt, command = runBounded }) {
  if (!pidOK(pid) || !['app','trustd'].includes(role) || !UUID.test(observer)
    || !Number.isSafeInteger(expectedStartedAt) || expectedStartedAt < 1 || typeof directory !== 'string' || !path.isAbsolute(directory)) throw Object.assign(Error('Invalid stack target'), { code: 'INVALID_TARGET' });
  const { stdout } = await command('/usr/bin/sample', [String(pid), '1', '1', '-file', '/dev/stdout'], { signal });
  const text = stdout.toString();
  const launch = /^Launch Time:\s+(.+)$/m.exec(text);
  const sampledStart = launch ? Date.parse(launch[1]) : NaN;
  if (!new RegExp('^Process:.*\\[' + pid + '\\]\\s*$', 'm').test(text) || !Number.isFinite(sampledStart)
    || sampledStart < expectedStartedAt || sampledStart >= expectedStartedAt + 1000) throw Object.assign(Error('Sample process lifetime changed'), { code: 'SAMPLE_IDENTITY' });
  const file = `${observer}-${role}.txt`;
  fs.writeFileSync(path.join(directory, file), stdout, { flag: 'wx', mode: 0o600 });
  return { file, bytes: stdout.length, sha256: crypto.createHash('sha256').update(stdout).digest('hex'), sampledStart };
}

export async function resolveAppImage({ deviceId, signal, command = runBounded }) {
  let stdout;
  try {
    ({ stdout } = await command('/usr/bin/xcrun', ['simctl', 'get_app_container', deviceId, 'works.jev.modex', 'app'], { signal, maxBytes: 8192 }));
  } catch (error) {
    throw Object.assign(Error('App container query unavailable'), { imageStage: 'container-query', code: error?.code, closed: error?.closed, pid: error?.pid });
  }
  try { return fs.realpathSync(path.join(stdout.toString().trim(), 'ModexCompanion')); }
  catch (error) { throw Object.assign(Error('App image realpath unavailable'), { imageStage: 'image-realpath', code: error?.code }); }
}

export async function runObserver({ deviceId, output, signal }) {
  if (process.platform !== 'darwin' || process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_OS !== 'macOS'
    || !UUID.test(deviceId) || !path.isAbsolute(output) || path.resolve(output) === '/') throw Error('Trust stack diagnostics require an explicit macOS CI simulator and output path');
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const directory = fs.mkdtempSync(path.join(fs.realpathSync(output), 'trust-stacks-'));
  const deadline = new AbortController();
  const combined = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
  const timer = setTimeout(() => deadline.abort(), 15 * 60 * 1000);
  const receipt = { schema: 1, deviceId, ownerPid: process.pid, startedAt: new Date().toISOString(), scope: 'Diagnostic process-metadata spot checks, not atomic native task identity or acceptance; direct command closure does not prove simulator-side descendant cleanup', pollErrors: 0 };
  let observer;
  const command = gateCommands(runBounded, info => { receipt.unconfirmedCommand = info; receipt.unavailable = 'COMMAND_CLEANUP_UNVERIFIED'; deadline.abort(); observer?.close(); });
  const save = () => fs.writeFileSync(path.join(directory, 'manifest.json'), JSON.stringify({ ...receipt, observation: observer?.report }, null, 2) + '\n', { mode: 0o600 });
  try {
    const devices = JSON.parse((await command('/usr/bin/xcrun', ['simctl', 'list', 'devices', 'booted', '-j'], { signal: combined })).stdout.toString());
    if (!Object.values(devices.devices ?? {}).flat().some(x => x.udid === deviceId && x.state === 'Booted')) throw Error('Explicit simulator is not booted');
    const appImage = () => resolveAppImage({ deviceId, signal: combined, command });
    observer = new TrustStallObserver({ deviceId, appImage, identity: (pid, image) => currentIdentity(pid, image, combined, command),
      sample: async (pid, opts) => {
        const entry = observer.pending.get(opts.observer), target = opts.role === 'app' ? entry : entry?.daemon;
        return captureStack(pid, { ...opts, directory, command, signal: AbortSignal.any([combined, opts.signal]), expectedStartedAt: target?.identity.startedAt });
      } });
    const predicate = '(process == "ModexCompanion" AND (eventMessage BEGINSWITH "MODEX_PAIRING_TLS" OR eventMessage == "SecTrustEvaluateIfNecessary")) OR (process == "trustd" AND eventMessage CONTAINS "com.apple.trustd.peer[")';
    while (!combined.aborted) {
      if (observer.captures < 2 && !observer.closed) {
        try {
          const { stdout } = await command('/usr/bin/xcrun', ['simctl', 'spawn', deviceId, 'log', 'show', '--last', '15s', '--style', 'ndjson', '--info', '--debug', '--predicate', predicate], { signal: combined, maxBytes: 512 * 1024 });
          let count = 0;
          for (const line of stdout.toString().split('\n')) {
            if (++count > 2048 || line.length > 32768) throw Object.assign(Error('Bounded log window exceeded'), { code: 'LOG_LIMIT' });
            let event; try { event = JSON.parse(line); } catch { continue; }
            await observer.ingest(event);
          }
          await observer.tick();
        } catch (error) { if (!combined.aborted) { receipt.pollErrors++; receipt.lastPollError = typeof error.code === 'string' ? error.code.slice(0,64) : 'LOG_UNAVAILABLE'; } }
        save();
      }
      await new Promise(resolve => { if (combined.aborted) return resolve(); const done = () => { clearTimeout(pause); combined.removeEventListener('abort', done); resolve(); }; const pause = setTimeout(done, 5000); combined.addEventListener('abort', done, { once: true }); });
    }
  } catch (error) { receipt.unavailable ??= typeof error.code === 'string' ? error.code.slice(0,64) : 'OBSERVER_UNAVAILABLE'; }
  finally { clearTimeout(timer); observer?.close(); receipt.finishedAt = new Date().toISOString(); save(); }
  return { directory, receipt, observation: observer?.report };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const stop = new AbortController();
  process.once('SIGTERM', () => stop.abort()); process.once('SIGINT', () => stop.abort());
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--device' || args[2] !== '--output') { process.stderr.write('Trust observer requires --device UUID --output PATH\n'); process.exitCode = 2; }
  else {
    try { await runObserver({ deviceId: args[1], output: args[3], signal: stop.signal }); }
    catch { process.stderr.write('Trust stack diagnostics unavailable; paired-test outcome is unchanged.\n'); process.exitCode = 2; }
  }
}

export function gateCommands(run, onUnclosed) {
  let stopped = false;
  return async (...args) => {
    if (stopped) throw Object.assign(Error('Diagnostic command collection stopped'), { code: 'DIAGNOSTIC_STOPPED' });
    try { return await run(...args); }
    catch (error) {
      if (error.closed === false) {
        stopped = true;
        onUnclosed({ pid: pidOK(error.pid) ? error.pid : null, code: typeof error.code === 'string' ? error.code.slice(0,64) : 'COMMAND_UNCONFIRMED' });
      }
      throw error;
    }
  };
}
