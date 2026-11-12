import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as diagnostics from '../../apps/ios/ModexCompanion/Scripts/observe-trust-stalls.mjs';

const deviceId = '2CC7A2C1-E1A7-4633-911A-DB60BDEB97F0';
const observerId = 'CE535A64-185F-4FD3-8C18-86EE73EB4C42';
const boot = '3E538CD4-EAD9-4CFC-939A-C7DA3EDBD338';
const timestamp = '2026-11-11T16:22:53.486Z';
const image = `/Users/runner/Library/Developer/CoreSimulator/Devices/${deviceId}/data/Containers/Bundle/Application/C10862C8-D7CA-41C7-B043-7264908A02BB/ModexCompanion.app/ModexCompanion`;
const event = (changes = {}) => ({ processID: 19815, processImagePath: image, bootUUID: boot,
  threadID: 101, timestamp, eventMessage: `MODEX_PAIRING_TLS observer=${observerId} phase=chain-start`, ...changes });
function fixture(appImage) {
  let identities = 0, samples = 0;
  const observer = new diagnostics.TrustStallObserver({ deviceId, now: () => Date.parse(timestamp), appImage,
    identity: async () => { identities++; return { image, startedAt: Date.parse(timestamp) - 1000, identity: 'owned-instance' }; },
    sample: async () => { samples++; return { bytes: 1, file: 'owned.txt' }; } });
  return { observer, counts: () => ({ identities, samples }) };
}

test('an unavailable image records callback identity and time without admitting a process', async () => {
  const h = fixture(async () => undefined);
  await h.observer.ingest(event());
  assert.deepEqual(h.observer.report.imageBindings, [{ observer: observerId, pid: 19815, boot,
    chainStartAt: timestamp, observedAt: timestamp, outcome: 'image-unavailable' }]);
  assert.deepEqual(h.observer.report.refusals, ['app-image']);
  assert.equal(h.observer.report.observers, 0);
  assert.deepEqual(h.counts(), { identities: 0, samples: 0 });
});

test('query and realpath failures stay distinct without retaining error text', async () => {
  for (const [stage, code] of [['container-query', 'COMMAND_FAILED'], ['image-realpath', 'ENOENT']]) {
    const h = fixture(async () => { throw Object.assign(Error('sensitive path or command output'), { imageStage: stage, code, closed: true, pid: 12345 }); });
    await assert.doesNotReject(() => h.observer.ingest(event()));
    const row = h.observer.report.imageBindings[0];
    assert.equal(row.outcome, `${stage}-failed`);
    assert.equal(row.code, code);
    assert.equal(row.commandClosed, true);
    assert.equal(row.commandPid, 12345);
    assert.equal(JSON.stringify(h.observer.report).includes('sensitive'), false);
    assert.deepEqual(h.counts(), { identities: 0, samples: 0 });
  }
});

test('image comparison identifies mismatch and still enforces device and bundle identity', async () => {
  for (const [expected, observed, outcome] of [
    [image, image.replace('C10862C8', 'D10862C8'), 'image-mismatch'],
    [image.replace(deviceId, observerId), image.replace(deviceId, observerId), 'device-path-mismatch'],
    [image.replace('ModexCompanion.app/ModexCompanion', 'Other.app/Other'), image.replace('ModexCompanion.app/ModexCompanion', 'Other.app/Other'), 'bundle-path-mismatch'],
  ]) {
    const h = fixture(async () => expected);
    await h.observer.ingest(event({ processImagePath: observed }));
    assert.equal(h.observer.report.imageBindings?.[0]?.outcome, outcome);
    assert.deepEqual(h.observer.report.refusals, ['app-image']);
    assert.deepEqual(h.counts(), { identities: 0, samples: 0 });
  }
  const h = fixture(async () => image);
  await h.observer.ingest(event());
  assert.equal(h.observer.report.imageBindings[0].outcome, 'matched');
  assert.equal(h.observer.report.observers, 1);
  assert.deepEqual(h.counts(), { identities: 1, samples: 0 });
});

test('repeated image refusals remain bounded and arbitrary error codes are excluded', async () => {
  const h = fixture(async () => { throw Object.assign(Error('private'), { code: 'secret/path\n' + 'x'.repeat(1000) }); });
  for (let n = 0; n < 40; n++) await assert.doesNotReject(() => h.observer.ingest(event()));
  assert.equal(h.observer.report.imageBindings.length, 16);
  assert.equal(h.observer.report.refusals.length, 16);
  assert.equal(h.observer.report.imageBindings[0].code, 'IMAGE_LOOKUP_UNAVAILABLE');
  assert.equal(JSON.stringify(h.observer.report).includes('secret/path'), false);
  assert.deepEqual(h.counts(), { identities: 0, samples: 0 });
});

test('native image resolution preserves the bounded query and real filesystem result', async t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'modex-image-binding-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const canonical = fs.realpathSync(directory), executable = path.join(canonical, 'ModexCompanion');
  fs.writeFileSync(executable, 'owned fixture');
  const signal = new AbortController().signal;
  const command = async (binary, args, options) => {
    assert.equal(binary, '/usr/bin/xcrun');
    assert.deepEqual(args, ['simctl', 'get_app_container', deviceId, 'works.jev.modex', 'app']);
    assert.equal(options.signal, signal);
    assert.equal(options.maxBytes, 8192);
    return { stdout: Buffer.from(directory + '\n'), closed: true };
  };
  let resolved;
  await assert.doesNotReject(async () => { resolved = await diagnostics.resolveAppImage({ deviceId, signal, command }); });
  assert.equal(resolved, executable);
  fs.unlinkSync(executable);
  await assert.rejects(() => diagnostics.resolveAppImage({ deviceId, signal, command }),
    error => error.imageStage === 'image-realpath' && error.code === 'ENOENT');
});

test('an unconfirmed query close preserves the common stop gate and launches no more commands', async () => {
  let calls = 0, h;
  const command = diagnostics.gateCommands(async () => { calls++; throw Object.assign(Error('unknown closure'), { code: 'COMMAND_TIMEOUT', pid: 12345, closed: false }); }, () => h.observer.close());
  h = fixture(() => diagnostics.resolveAppImage({ deviceId, command }));
  await assert.doesNotReject(() => h.observer.ingest(event()));
  await h.observer.ingest(event());
  assert.equal(calls, 1);
  assert.equal(h.observer.closed, true);
  assert.equal(h.observer.report.imageBindings[0].outcome, 'container-query-failed');
  assert.equal(h.observer.report.imageBindings[0].commandClosed, false);
  assert.deepEqual(h.counts(), { identities: 0, samples: 0 });
});
