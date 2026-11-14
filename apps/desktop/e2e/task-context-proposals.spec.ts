import { test, expect, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid, items } from "./support";

// Main-process integration with a synthetic Claude executable. No provider turn or native-model qualification.
function fixture(home: string): string {
  const cli = path.join(home, "proposal-cli.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
if (process.argv.includes('--version')) { console.log('2.1.316 (Claude Code)'); process.exit(0); }
if (process.argv.includes('auth')) { console.log(JSON.stringify({ loggedIn: true })); process.exit(0); }
if (path.basename(process.cwd()).startsWith('modex-title-')) process.exit(1);
const emit = value => process.stdout.write(JSON.stringify(value) + '\\n');
const prior = ${JSON.stringify(path.join(home, "fixture-private-route"))};
const reports = ${JSON.stringify(path.join(home, "fixture-proposals.jsonl"))};
let running = false;
require('node:readline').createInterface({ input: process.stdin }).on('line', async line => {
  const input = JSON.parse(line); if (input.type !== 'user' || running) return; running = true;
  try {
    const index = process.argv.indexOf('--mcp-config');
    const connection = index < 0 ? undefined : JSON.parse(process.argv[index + 1]).mcpServers.modex_task_context;
    if (!connection) { fs.appendFileSync(reports, JSON.stringify({ missing: true }) + '\\n'); emit({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'Proposal connection missing' }] } }); return; }
    const previous = fs.existsSync(prior) ? fs.readFileSync(prior, 'utf8') : null;
    let oldStatus = null;
    if (previous) oldStatus = await fetch(previous, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'old', method: 'tools/call', params: { name: 'propose_refs', arguments: { refs: [] } } }) }).then(r => r.status, () => 'closed');
    fs.writeFileSync(prior, connection.url, { mode: 0o600 });
    emit({ type: 'system', subtype: 'init', session_id: 'proposal-session', mcp_servers: [{ name: 'modex_task_context', status: 'connected' }] });
    const noteId = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(home, "fixture-note.json"))}, 'utf8')).id;
    const response = await fetch(connection.url, { method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'proposal', method: 'tools/call', params: { name: 'propose_refs', arguments: { refs: [{ target: { kind: 'file', path: 'README.md' }, role: 'file' }, { target: { kind: 'note', pageId: noteId }, role: 'note' }] } } }) });
    const result = await response.json();
    fs.appendFileSync(reports, JSON.stringify({ missing: false, oldStatus, fresh: previous !== connection.url, status: response.status, error: result.result?.isError === true, detail: result.result?.isError ? result.result.content : undefined }) + '\\n');
    emit({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'Proposal fixture finished' }] } });
  } catch (error) { emit({ type: 'assistant', message: { id: 'a', content: [{ type: 'text', text: 'Proposal fixture failed: ' + error.message }] } }); }
  finally { emit({ type: 'result', subtype: 'success', result: 'Proposal fixture finished' }); process.stdin.destroy(); setTimeout(() => process.exit(0), 10); }
});
`, { mode: 0o755 });
  return cli;
}

test("main owns a proposal service across fresh/resumed turns and revokes each private lease", async () => {
  const seeded = seedHome({ default_backend: "claude", default_mode: "chat" });
  const home = fs.realpathSync(seeded.home), repo = fs.realpathSync(seeded.repo);
  const stateFile = path.join(home, "app/state.json"), state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.settings.claude_bin = fixture(home); state.projects[0].path = repo;
  const at = new Date().toISOString();
  state.threads = [{ id: "proposal-thread", projectId: "p1", title: "Proposal fixture", titleSource: "manual", createdAt: at, updatedAt: at, cwd: repo, backend: "claude", mode: "chat", plan: false, auto: false, model: "", status: "idle" }];
  fs.writeFileSync(stateFile, JSON.stringify(state)); fs.writeFileSync(path.join(home, "app/threads/proposal-thread.json"), "[]");
  let app: ElectronApplication | undefined;
  try {
    const opened = await launch(home); app = opened.app; const page = opened.page;
    const note = await page.evaluate(async () => { const project = await window.modex!.invoke("project:notes", { projectId: "p1" }); return window.modex!.invoke("space:create", { containerId: project.id, title: "Uninspected proposal", markdown: "private-note-body-not-inspected" }); });
    fs.writeFileSync(path.join(home, "fixture-note.json"), JSON.stringify({ id: note.id }));
    const row = page.locator('[data-testid="thread-row"][data-thread-id="proposal-thread"]'); await row.click();
    for (const index of [0, 1]) {
      await tid(page, "composer-input").fill(`Propose references ${index}`); await tid(page, "send").click();
      await expect(items(page, "assistant")).toHaveCount(index + 1); await expect(row).toHaveAttribute("data-status", "idle");
      const stored = await page.evaluate(() => window.modex!.invoke("thread:items", { threadId: "proposal-thread" }));
      await test.info().attach(`proposal-fixture-${index}`, { body: fs.readFileSync(path.join(home, "fixture-proposals.jsonl")), contentType: "application/json" });
      const user = stored.filter(item => item.kind === "user")[index]!; expect(user.kind).toBe("user"); if (user.kind !== "user") throw new Error("Missing request");
      expect(user.contextEvidence?.refs.map(ref => ref.target)).toEqual([{ kind: "file", path: "README.md" }, { kind: "note", pageId: note.id }]);
      expect(user.contextEvidence?.refs.every(ref => ref.relations.every(relation => relation.provenance === "model-proposed"))).toBe(true);
      expect(user.contextEvidence?.captures).toEqual([]); expect(user.contextEvidence?.checks).toEqual([]);
      expect(JSON.stringify(user.contextEvidence)).not.toContain("private-note-body-not-inspected");
      expect(user.contextEvidence?.capabilities?.map(receipt => receipt.capability)).toEqual([{ state: "available" }]);
      expect(await page.evaluate(turnId => window.modex!.invoke("task:context", { threadId: "proposal-thread", turnId }), user.id)).toEqual(user.contextEvidence);
      await expect(page.evaluate(({ turnId, revision, refId }) => window.modex!.invoke("task:check-confirm", { threadId: "proposal-thread", turnId, expectedRevision: revision, itemId: "foreign-check", refIds: [refId] }), { turnId: user.id, revision: user.contextEvidence!.revision, refId: user.contextEvidence!.refs[0]!.id })).rejects.toThrow(/does not belong/);
    }
    const reports = fs.readFileSync(path.join(home, "fixture-proposals.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line));
    expect(reports).toEqual([{ missing: false, oldStatus: null, fresh: true, status: 200, error: false }, { missing: false, oldStatus: 404, fresh: true, status: 200, error: false }]);
    const lastURL = fs.readFileSync(path.join(home, "fixture-private-route"), "utf8");
    expect(await fetch(lastURL).then(response => response.status)).toBe(404);
    await app.close(); app = undefined;
    expect(await fetch(lastURL).then(() => false, () => true)).toBe(true);
  } finally { await app?.close(); }
});
