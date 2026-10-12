import test from 'node:test';
import assert from 'node:assert/strict';
import * as discovery from '../dist/apps/desktop/src/main/engine/desktop-discovery.js';

test('Store checks notice installation after absence and polling reads only running hosts', async () => {
  assert.equal(typeof discovery.createDesktopDiscovery, 'function');
  let installed, directoryCalls = 0, installedCalls = 0, runningCalls = 0;
  const lookup = discovery.createDesktopDiscovery({
    async directory() { directoryCalls++; return '/group/desktop-hosts'; },
    async installed() { installedCalls++; return installed; },
    async running(directory) { assert.equal(directory, '/group/desktop-hosts'); runningCalls++; return []; },
  });
  assert.equal((await lookup.check()).installed, undefined);
  installed = '/Applications/Modex Host Preview.app';
  assert.equal((await lookup.check()).installed, installed);
  await lookup.running(); await lookup.running();
  assert.equal(installedCalls, 2); assert.equal(directoryCalls, 1); assert.equal(runningCalls, 4);
});

test('Store retries failed group resolution and then caches successful resolution', async () => {
  assert.equal(typeof discovery.createDesktopDiscovery, 'function');
  let calls = 0;
  const lookup = discovery.createDesktopDiscovery({
    async directory() { if (++calls === 1) throw new Error('not ready'); return '/group'; },
    async installed() { return undefined; },
    async running(directory) { return [{ directory }]; },
  });
  assert.deepEqual((await lookup.check()).hosts, []);
  assert.deepEqual((await lookup.check()).hosts, [{ directory: '/group' }]);
  assert.deepEqual(await lookup.running(), [{ directory: '/group' }]);
  assert.equal(calls, 2);
});
