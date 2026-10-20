import { test, expect, type ElectronApplication, type Page, type TestInfo } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { launch, seedHome, tid, items, resizeWindow } from './support';
import type { Thread, ThreadItem } from '../src/shared/types';

let app: ElectronApplication, page: Page, home: string, repo: string;
const at = '2026-10-18T07:00:00Z';
const threadId = 'continuity-a';
const origin = (id: string) => ({ thread: threadId, turn: 'u', attempt: 'a', backend: 'codex' as const, native: { runtime: 'fixture', item: id } });
const long = Array.from({ length: 35 }, (_, i) => `Paragraph ${i}: ${'Readable ordered output. '.repeat(12)}`).join('\n\n');
const saved: ThreadItem[] = [
  { id: 'u', kind: 'user', text: 'Inspect this conversation fixture', at },
  { id: 'r', kind: 'thinking', text: 'Provider summary: inspect and verify.', reasoning: 'summary', outcome: 'succeeded', status: 'done', origin: origin('r'), at },
  { id: 't', kind: 'tool', name: 'shell', title: '$ fixture-check', args: { command: 'fixture-check' }, output: 'Captured output, never executed by this test.', status: 'done', outcome: 'succeeded', ok: true, origin: origin('t'), at },
  { id: 'f', kind: 'assistant', text: long, phase: 'final', outcome: 'succeeded', origin: origin('f'), at },
];
const row = (id: string) => page.locator(`[data-testid="thread-row"][data-thread-id="${id}"]`);
async function shot(name: string, info: TestInfo) {
  const image = await page.screenshot();
  await info.attach(name, { body: image, contentType: 'image/png' });
  if (process.env.MODEX_SCREENSHOTS) {
    fs.mkdirSync(process.env.MODEX_SCREENSHOTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.MODEX_SCREENSHOTS, `${name}.png`), image);
  }
}

test.beforeAll(async () => {
  ({ home, repo } = seedHome());
  const file = path.join(home, 'app', 'state.json');
  const state = JSON.parse(fs.readFileSync(file, 'utf8'));
  state.threads = ['continuity-a', 'continuity-b'].map((id): Thread => ({ id, projectId: 'p1', title: id, titleSource: 'manual', createdAt: at, updatedAt: at, cwd: repo, backend: 'mock', mode: 'chat', plan: false, model: 'mock', status: 'idle' }));
  fs.writeFileSync(file, JSON.stringify(state));
  fs.writeFileSync(path.join(home, 'app', 'threads', `${threadId}.json`), JSON.stringify(saved));
  fs.writeFileSync(path.join(home, 'app', 'threads', 'continuity-b.json'), '[]');
  ({ app, page } = await launch(home));
  await row(threadId).click();
  await expect(items(page, 'assistant')).toContainText('Paragraph 34');
});
test.afterAll(async () => { await app?.close(); fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); });

test('reading position, expansion and drafts survive sustained updates and switching threads', async () => {
  await tid(page, 'turn-label').click();
  const tool = items(page, 'tool');
  await tid(tool, 'item-toggle').click();
  await expect(tid(tool, 'item-body')).toBeVisible();
  await tid(page, 'turn-label').click();
  await expect(tool).toBeHidden();
  await tid(page, 'turn-label').click();
  await expect(tid(tool, 'item-body')).toBeVisible();
  const composer = tid(page, 'composer-input');
  await composer.fill('draft belonging to A');
  const transcript = tid(page, 'transcript');
  await transcript.evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await expect(tid(page, 'jump-latest')).toBeVisible();
  await app.evaluate(async ({ BrowserWindow }, { threadId, long }) => {
    for (let i = 1; i <= 60; i++) {
      BrowserWindow.getAllWindows()[0]!.webContents.send('thread:event', { type: 'item_update', threadId, id: 'f', patch: { text: `${long}\n\nDelta ${i}`, outcome: 'running' } });
      await new Promise(resolve => setTimeout(resolve, 16));
    }
  }, { threadId, long });
  await expect(items(page, 'assistant')).toContainText('Delta 60');
  expect(await transcript.evaluate(el => el.scrollTop)).toBe(0);
  await expect(composer).toBeFocused();
  await expect(composer).toHaveValue('draft belonging to A');
  await expect(tid(tool, 'item-body')).toBeVisible();
  await row('continuity-b').click();
  await composer.fill('draft belonging to B');
  await row(threadId).click();
  await expect(composer).toHaveValue('draft belonging to A');
  await expect(tid(page, 'turn-label')).toHaveAttribute('aria-expanded', 'true');
  await expect(tid(tool, 'item-body')).toBeVisible();
  expect(await transcript.evaluate(el => el.scrollTop)).toBe(0);
  await tid(page, 'jump-latest').click();
  expect(await transcript.evaluate(el => el.scrollHeight - el.scrollTop - el.clientHeight)).toBeLessThanOrEqual(80);
});

test('live, waiting, failed, completed and reloaded states keep actionable rows visible', async ({}, info) => {
  await page.reload();
  await row(threadId).click();
  await resizeWindow(app, page, 1280, 900);
  await shot('conversation-reloaded', info);
  for (const state of ['live', 'waiting', 'failed', 'completed'] as const) {
    const status = state === 'live' ? 'running' : state === 'waiting' ? 'waiting' : state === 'failed' ? 'error' : 'idle';
    await app.evaluate(({ BrowserWindow }, { threadId, status }) => {
      BrowserWindow.getAllWindows()[0]!.webContents.send('thread:event', { type: 'status', threadId, status });
    }, { threadId, status });
    await expect(row(threadId)).toHaveAttribute('data-status', status);
    // A running transition reloads the authoritative snapshot. Wait until a probe survives it.
    for (let attempt = 0; ; attempt++) {
      const id = `capture-probe-${state}-${attempt}`;
      await app.evaluate(({ BrowserWindow }, { threadId, id }) => {
        BrowserWindow.getAllWindows()[0]!.webContents.send('thread:event', { type: 'item', threadId, item: { id, kind: 'notice', level: 'info', text: id, at: new Date().toISOString() } });
      }, { threadId, id });
      await page.waitForTimeout(150);
      if (await page.getByText(id, { exact: true }).isVisible()) break;
      if (attempt === 20) throw new Error('capture snapshot kept reloading');
    }
    const outcome = state === 'live' || state === 'waiting' ? 'running' : state === 'failed' ? 'failed' : 'succeeded';
    await app.evaluate(({ BrowserWindow }, { threadId, outcome, state }) => {
      const send = (item: unknown) => BrowserWindow.getAllWindows()[0]!.webContents.send('thread:event', { type: 'item', threadId, item });
      const at = new Date().toISOString();
      const origin = { thread: threadId, turn: 'capture-u', attempt: 'capture-a', backend: 'codex', native: { runtime: 'fixture', item: 'capture-result' } };
      send({ id: 'capture-u', kind: 'user', text: 'Review the mixed turn', at });
      send({ id: 'capture-result', kind: 'assistant', text: `## ${state}\n\n\`\`\`ts\nconst result = 42;\n\`\`\``, phase: 'final', outcome, origin, at });
      send({ id: 'capture-error', kind: 'notice', level: 'error', text: 'A prior check failed; its evidence remains visible.', at });
      send({ id: 'capture-request', kind: 'approval', question: 'Allow the next fixture step?', at, ...(state === 'completed' ? { answer: 'no' } : {}) });
    }, { threadId, outcome, state });
    await expect(items(page, 'assistant').last()).toHaveAttribute('data-outcome', outcome);
    const request = items(page, 'approval').last();
    if (state !== 'completed') {
      await expect(request.getByRole('button', { name: 'Deny', exact: true })).toBeVisible();
      await request.getByRole('button', { name: 'Deny', exact: true }).focus();
    }
    if (state === 'waiting') {
      await app.evaluate(({ BrowserWindow }, threadId) => {
        for (let i = 1; i <= 20; i++) BrowserWindow.getAllWindows()[0]!.webContents.send('thread:event', { type: 'item_update', threadId, id: 'capture-result', patch: { text: `Still waiting for your answer. Update ${i}` } });
      }, threadId);
      await expect(items(page, 'assistant').last()).toContainText('Update 20');
      await expect(request.getByRole('button', { name: 'Deny', exact: true })).toBeFocused();
    }
    await expect(page.getByText('A prior check failed; its evidence remains visible.')).toBeVisible();
    await tid(page, 'transcript').evaluate(el => { el.scrollTop = el.scrollHeight; });
    await shot(`conversation-${state}`, info);
  }
});
