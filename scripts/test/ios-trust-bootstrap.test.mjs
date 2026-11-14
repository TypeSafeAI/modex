import test from 'node:test';
import assert from 'node:assert/strict';
import * as diagnostics from '../../apps/ios/ModexCompanion/Scripts/observe-trust-stalls.mjs';

const deviceId = '2CC7A2C1-E1A7-4633-911A-DB60BDEB97F0';
const otherId = 'CE535A64-185F-4FD3-8C18-86EE73EB4C42';
const booted = () => ({ stdout: Buffer.from(JSON.stringify({ devices: { runtime: [{ udid: deviceId, state: 'Booted' }] } })), closed: true });
const unavailable = (code = 'COMMAND_TIMEOUT', closed = true) => Object.assign(Error('private command text'), { code, closed, pid: 12345 });

// These tests never invoke simctl or inspect a person's simulator: only the fixed command contract is exercised.
test('startup observes the explicitly selected booted device with unchanged command bounds', async () => {
  const signal = new AbortController().signal, rows = []; let calls = 0;
  await diagnostics.confirmBootedSimulator({ deviceId, signal, onAttempt: row => rows.push(row), command: async (binary, args, options) => {
    calls++; assert.equal(binary, '/usr/bin/xcrun'); assert.deepEqual(args, ['simctl', 'list', 'devices', 'booted', '-j']);
    assert.equal(options.signal, signal); assert.equal(options.timeoutMs, 5000); assert.equal(options.maxBytes, 1024 * 1024); return booted();
  } });
  assert.equal(calls, 1); assert.deepEqual(rows, [{ attempt: 1, outcome: 'booted' }]);
});

for (const failures of [1, 2]) test(`startup recovers after ${failures} confirmed-closed metadata timeout(s)`, async () => {
  let calls = 0; const rows = [];
  await diagnostics.confirmBootedSimulator({ deviceId, onAttempt: row => rows.push(row), command: async () => { if (++calls <= failures) throw unavailable(); return booted(); } });
  assert.equal(calls, failures + 1);
  assert.deepEqual(rows.slice(0, failures), Array.from({ length: failures }, (_, i) => ({ attempt: i + 1, outcome: 'unavailable', code: 'COMMAND_TIMEOUT', commandClosed: true })));
  assert.deepEqual(rows.at(-1), { attempt: failures + 1, outcome: 'booted' });
});

test('three closed startup timeouts exhaust the budget without accepting a device', async () => {
  let calls = 0; const rows = [];
  await assert.rejects(diagnostics.confirmBootedSimulator({ deviceId, onAttempt: row => rows.push(row), command: async () => { calls++; throw unavailable(); } }), e => e.code === 'COMMAND_TIMEOUT' && e.closed === true);
  assert.equal(calls, 3); assert.equal(rows.length, 3); assert.equal(rows.some(row => row.outcome === 'booted'), false);
});

test('an unclosed startup child keeps the common stop gate and never permits another command', async () => {
  let calls = 0; const notices = [];
  const command = diagnostics.gateCommands(async () => { calls++; throw unavailable('COMMAND_TIMEOUT', false); }, info => notices.push(info));
  await assert.rejects(diagnostics.confirmBootedSimulator({ deviceId, command }), e => e.code === 'COMMAND_TIMEOUT' && e.closed === false);
  await assert.rejects(command(), e => e.code === 'DIAGNOSTIC_STOPPED');
  assert.equal(calls, 1); assert.deepEqual(notices, [{ pid: 12345, code: 'COMMAND_TIMEOUT' }]);
});

test('unknown child closure never qualifies for a retry', async () => {
  let calls = 0;
  await assert.rejects(diagnostics.confirmBootedSimulator({ deviceId, command: async () => { calls++; const error = unavailable(); delete error.closed; throw error; } }), e => e.code === 'COMMAND_TIMEOUT');
  assert.equal(calls, 1);
});

for (const code of ['COMMAND_FAILED', 'OUTPUT_LIMIT', 'ABORT_ERR']) test(`closed ${code} is not a retryable startup timeout`, async () => {
  let calls = 0;
  await assert.rejects(diagnostics.confirmBootedSimulator({ deviceId, command: async () => { calls++; throw unavailable(code); } }), e => e.code === code);
  assert.equal(calls, 1);
});

test('an already-aborted observer launches no startup command', async () => {
  const abort = new AbortController(); abort.abort(); let calls = 0;
  await assert.rejects(diagnostics.confirmBootedSimulator({ deviceId, signal: abort.signal, command: async () => { calls++; return booted(); } }), e => e.code === 'ABORT_ERR');
  assert.equal(calls, 0);
});

test('abort after a closed timeout prevents the next attempt', async () => {
  const abort = new AbortController(); let calls = 0;
  await assert.rejects(diagnostics.confirmBootedSimulator({ deviceId, signal: abort.signal, command: async () => { calls++; abort.abort(); throw unavailable(); } }), e => e.code === 'ABORT_ERR');
  assert.equal(calls, 1);
});

test('another booted device does not satisfy explicit simulator identity', async () => {
  let calls = 0;
  await assert.rejects(diagnostics.confirmBootedSimulator({ deviceId, command: async () => { calls++; return { stdout: Buffer.from(JSON.stringify({ devices: { runtime: [{ udid: otherId, state: 'Booted' }] } })), closed: true }; } }), e => e.code === 'DEVICE_NOT_BOOTED');
  assert.equal(calls, 1);
});

test('malformed device metadata is refused without retry or retained output', async () => {
  let calls = 0; const rows = [];
  await assert.rejects(diagnostics.confirmBootedSimulator({ deviceId, onAttempt: row => rows.push(row), command: async () => { calls++; return { stdout: Buffer.from('private malformed JSON'), closed: true }; } }), e => e.code === 'INVALID_DEVICE_LIST');
  assert.equal(calls, 1); assert.equal(JSON.stringify(rows).includes('private'), false);
});

test('even a successful result needs confirmed command closure', async () => {
  let calls = 0;
  await assert.rejects(diagnostics.confirmBootedSimulator({ deviceId, command: async () => { calls++; return { ...booted(), closed: false }; } }), e => e.code === 'COMMAND_CLEANUP_UNVERIFIED' && e.closed === false);
  assert.equal(calls, 1);
});

test('invalid explicit device identifiers launch nothing', async () => {
  let calls = 0;
  await assert.rejects(diagnostics.confirmBootedSimulator({ deviceId: '../other-device', command: async () => { calls++; return booted(); } }), e => e.code === 'INVALID_DEVICE');
  assert.equal(calls, 0);
});

test('unknown error text and codes do not enter startup receipts', async () => {
  const rows = [];
  await assert.rejects(diagnostics.confirmBootedSimulator({ deviceId, onAttempt: row => rows.push(row), command: async () => { throw unavailable('private/path\ncredential'); } }), e => e.code === 'SIMULATOR_QUERY_UNAVAILABLE' && !e.message.includes('private'));
  assert.deepEqual(rows, [{ attempt: 1, outcome: 'unavailable', code: 'SIMULATOR_QUERY_UNAVAILABLE', commandClosed: true }]);
});

test('cancellation racing a successful closed query cannot confirm startup', async () => {
  const abort = new AbortController(), rows = []; let calls = 0;
  await assert.rejects(diagnostics.confirmBootedSimulator({ deviceId, signal: abort.signal, onAttempt: row => rows.push(row), command: async () => { calls++; abort.abort(); return booted(); } }), e => e.code === 'ABORT_ERR');
  assert.equal(calls, 1); assert.equal(rows.some(row => row.outcome === 'booted'), false);
});
