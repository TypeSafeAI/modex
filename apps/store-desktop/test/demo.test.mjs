import test from 'node:test';
import assert from 'node:assert/strict';
import { StoreDemo } from '../dist/apps/store-desktop/src/main/demo.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function setup(t) {
  const events = [], terminal = [];
  const demo = new StoreDemo(event => events.push(event), event => terminal.push(event));
  t.after(() => demo.dispose());
  const state = demo.invoke('state:get');
  return { demo, events, terminal, state, threadId: state.threads[0].id };
}

test('approval decisions edit only the sample file, reset restores it, arbitrary paths fail', t => {
  const { demo, threadId } = setup(t);
  const approval = demo.invoke('thread:items', { threadId }).find(i => i.kind === 'approval');
  assert.throws(() => demo.invoke('thread:answer', { threadId, itemId: approval.id, answer: 'always' }));
  demo.invoke('thread:answer', { threadId, itemId: approval.id, answer: 'yes' });
  assert.match(demo.invoke('files:read', { threadId, path: 'README.md' }), /Review approvals/);
  assert.match(demo.invoke('changes:diff', { threadId, path: 'README.md' }), /^diff --git/);
  assert.throws(() => demo.invoke('thread:answer', { threadId, itemId: approval.id, answer: 'no' }));
  assert.throws(() => demo.invoke('files:read', { threadId, path: '/etc/passwd' }));
  assert.throws(() => demo.invoke('changes:revert', { threadId, path: '../README.md' }));
  assert.equal(demo.invoke('changes:revert', { threadId, path: 'README.md' }).files.length, 0);
  const fresh = setup(t).demo;
  assert.throws(() => fresh.invoke('thread:items', { threadId }), /no longer exists/);
});

test('denying an approval leaves the sample unchanged and allows follow-ups', async t => {
  const { demo, threadId } = setup(t);
  const itemId = demo.invoke('thread:items', { threadId }).find(i => i.kind === 'approval').id;
  demo.invoke('thread:answer', { threadId, itemId, answer: 'no' });
  assert.equal(demo.invoke('changes:status', { threadId }).files.length, 0);
  assert.deepEqual(demo.invoke('thread:send', { threadId, text: 'Continue' }), { ok: true });
  assert.equal(demo.invoke('thread:send', { threadId, text: 'Again' }).ok, false);
  await sleep(900);
  assert.match(demo.invoke('thread:items', { threadId }).at(-1).text, /Demo reply to “Continue”/);
});

test('new threads, stopped turns and disposal never emit stale replies', async t => {
  const { demo, events, state } = setup(t);
  const thread = demo.invoke('thread:create', { projectId: state.projects[0].id, worktree: true });
  assert.match(thread.worktree.path, /^\/Demo\//);
  demo.invoke('thread:send', { threadId: thread.id, text: 'A new task' });
  demo.invoke('thread:stop', { threadId: thread.id });
  await sleep(900);
  assert.equal(demo.invoke('thread:items', { threadId: thread.id }).length, 1);
  demo.invoke('thread:send', { threadId: thread.id, text: 'Another task' });
  demo.dispose(); const count = events.length;
  await sleep(900);
  assert.equal(events.length, count);
  assert.throws(() => demo.invoke('state:get'), /ended/);
});

test('demo terminal only echoes bounded text, never runs commands or exposes host credentials', t => {
  const { demo, terminal, threadId } = setup(t);
  const session = demo.invoke('terminal:open', { threadId, cols: 80, rows: 24 });
  assert.match(session.output, /no shell or commands run/);
  demo.invoke('terminal:write', { threadId, sessionId: session.sessionId, data: 'touch /tmp/should-not-exist\r' });
  assert.match(terminal.at(-1).data, /nothing executed/);
  assert.throws(() => demo.invoke('terminal:write', { threadId, sessionId: 'other-session', data: 'x' }));
  assert.throws(() => demo.invoke('terminal:write', { threadId, sessionId: session.sessionId, data: 'x'.repeat(4097) }));
  for (const channel of ['routing:setKey', 'chatgpt:signIn', 'companion:start', 'shell:openPath', 'shell:openTerminal']) assert.throws(() => demo.invoke(channel, { key: 'secret', path: '/tmp' }), /offline demo/);
  assert.equal(demo.invoke('chatgpt:status').accounts.length, 0);
  assert.equal(demo.invoke('routing:status').keyLast4, null);
  assert.match(demo.invoke('browser:command', { id: 'browser', action: 'navigate', url: 'https://example.com' }).error, /External pages require/);
  assert.throws(() => demo.invoke('__proto__'), /Unknown/);
});

test('snapshots and settings are not shared with callers or another demo', t => {
  const { demo, state } = setup(t);
  state.threads[0].title = 'external mutation';
  assert.notEqual(demo.invoke('state:get').threads[0].title, state.threads[0].title);
  const settings = demo.invoke('settings:update', { theme: 'coven' });
  settings.theme = 'jev';
  assert.equal(demo.invoke('state:get').settings.theme, 'coven');
  assert.equal(setup(t).demo.invoke('state:get').settings.theme, 'jev');
});
