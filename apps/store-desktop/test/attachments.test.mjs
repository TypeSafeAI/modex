import test from 'node:test';
import assert from 'node:assert/strict';
import { connectedInvoke, STORE_ATTACHMENTS_UNAVAILABLE } from '../dist/apps/store-desktop/src/main/attachments.js';

function recorder() {
  const calls = [];
  const forward = (channel, payload) => { calls.push(channel); return { forwarded: channel, payload }; };
  return { calls, forward };
}

test('connected Store edition answers attachments:stage and attachments:pick locally as unavailable', () => {
  const { calls, forward } = recorder();
  const files = [{ name: 'big.bin', mime: 'application/octet-stream', size: 2_000_000, data: 'AAAA' }];
  assert.deepEqual(connectedInvoke('attachments:stage', { files }, forward), { staged: [], errors: [STORE_ATTACHMENTS_UNAVAILABLE] });
  assert.deepEqual(connectedInvoke('attachments:pick', undefined, forward), { staged: [], errors: [STORE_ATTACHMENTS_UNAVAILABLE] });
  assert.match(STORE_ATTACHMENTS_UNAVAILABLE, /App Store edition/);
  assert.deepEqual(calls, []);
});

test('connected Store edition never forwards any attachments:* channel to the host', () => {
  const { calls, forward } = recorder();
  assert.equal(connectedInvoke('attachments:discard', { ids: ['a'] }, forward), undefined);
  assert.throws(() => connectedInvoke('attachments:open', { rel: 'staging/a/x.png' }, forward), new RegExp(STORE_ATTACHMENTS_UNAVAILABLE));
  assert.throws(() => connectedInvoke('attachments:future', {}, forward), /Unknown attachment action/);
  assert.deepEqual(calls, []);
});

test('connected Store edition still forwards other channels to the host', () => {
  const { calls, forward } = recorder();
  assert.deepEqual(connectedInvoke('state:get', { x: 1 }, forward), { forwarded: 'state:get', payload: { x: 1 } });
  assert.deepEqual(calls, ['state:get']);
});
