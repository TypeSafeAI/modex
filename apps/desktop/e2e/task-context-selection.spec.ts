import { test, expect, chromium, type Browser, type Page } from "@playwright/test";
import { createServer } from "vite";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { launch, seedHome, tid, currentRow, items, appDir } from "./support";

// All provider behavior below belongs to this isolated executable; no real model or credential is used.
function setup() {
  const seeded = seedHome({ default_backend: "claude", default_mode: "chat" });
  const home = fs.realpathSync(seeded.home), repo = fs.realpathSync(seeded.repo);
  const cli = path.join(home, "context-ui-cli.cjs"), file = path.join(home, "app/state.json"), state = JSON.parse(fs.readFileSync(file, "utf8"));
  state.projects[0].path = repo; state.projects[0].pagesMaintenance = true; state.settings.claude_bin = cli;
  const second = seedHome(); state.projects.push({ id: "p2", name: "Second project", path: fs.realpathSync(second.repo), addedAt: new Date().toISOString() });
  fs.writeFileSync(file, JSON.stringify(state));
  fs.writeFileSync(cli, `#!${process.execPath}
const fs=require('node:fs'),path=require('node:path');
if(process.argv.includes('--version')){console.log('2.1.316 (Claude Code)');process.exit(0);}
if(process.argv.includes('auth')){console.log(JSON.stringify({loggedIn:true}));process.exit(0);}
const emit=x=>console.log(JSON.stringify(x));
const idx=process.argv.indexOf('--mcp-config');
if(idx<0||path.basename(process.cwd()).startsWith('modex-title-')){emit({type:'result',result:'Context fixture',is_error:false});process.exit(0);}
const servers=JSON.parse(process.argv[idx+1]).mcpServers;
async function rpc(url,method,params,id){const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id,method,params})});const j=await r.json();if(j.error||j.result?.isError)throw Error('Fixture RPC refused');return j.result;}
require('node:readline').createInterface({input:process.stdin}).once('line',async line=>{try{
 const input=JSON.parse(line);fs.appendFileSync(${JSON.stringify(path.join(home, "context-inputs.jsonl"))},JSON.stringify(input)+'\\n');
 emit({type:'system',subtype:'init',session_id:'context-ui-session',mcp_servers:Object.keys(servers).map(name=>({name,status:'connected'}))});
 if(JSON.stringify(input).includes('Propose context')){
  const countFile=${JSON.stringify(path.join(home, "context-attempt"))};const count=fs.existsSync(countFile)?Number(fs.readFileSync(countFile,'utf8')):0;fs.writeFileSync(countFile,String(count+1));
  const note=JSON.parse(fs.readFileSync(${JSON.stringify(path.join(home, "context-note.json"))},'utf8'));
  if(count===0){emit({type:'assistant',message:{content:[{type:'tool_use',id:'unrelated-check',name:'Bash',input:{command:'pnpm test'}}]}});emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'unrelated-check',content:'Checks passed',is_error:false}]}});await rpc(servers.modex_task_context.url,'tools/call',{name:'propose_refs',arguments:{refs:[{target:{kind:'file',path:'README.md'},role:'file'},{target:{kind:'note',pageId:note.id},role:'note'}]}},'proposal');}
  else{
   const target=path.join(process.cwd(),'README.md');const body=fs.readFileSync(target,'utf8');
   emit({type:'assistant',message:{content:[{type:'tool_use',id:'read-context',name:'Read',input:{file_path:target}}]}});
   emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'read-context',content:body,is_error:false}]}});
   await rpc(servers.modex_pages.url,'initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'context-ui-fixture',version:'1'}},'init');
   await rpc(servers.modex_pages.url,'tools/call',{name:'read',arguments:{id:note.id}},'read-note');
  }
 }
 emit({type:'assistant',message:{id:'context-answer',content:[{type:'text',text:'Context fixture complete. All context is verified by pnpm test.'}]}});
 emit({type:'result',result:'Context fixture complete',is_error:false});process.exit(0);
}catch(error){emit({type:'result',result:String(error),is_error:true});process.exit(1);}});
`, { mode: 0o755 });
  return { home, repo };
}
async function openContext(page: Page) {
  await page.getByRole("button", { name: "Context for next request", exact: true }).click({ timeout: 3000 });
  return page.getByRole("region", { name: "Context for next request", exact: true });
}
async function notes(page: Page, home: string) {
  const note = await page.evaluate(async () => {
    const project = await window.modex!.invoke("project:notes", { projectId: "p1" });
    const own = await window.modex!.invoke("space:create", { containerId: project.id, title: "Context reference", markdown: "context-private-body-sentinel" });
    const other = await window.modex!.invoke("project:notes", { projectId: "p2" });
    await window.modex!.invoke("space:create", { containerId: other.id, title: "Foreign reference", markdown: "foreign-private-body-sentinel" });
    return own;
  });
  fs.writeFileSync(path.join(home, "context-note.json"), JSON.stringify({ id: note.id })); return note;
}

test("first request selects scoped files and Notes and reaches the native Send exactly once", async () => {
  const { home } = setup(), { app, page } = await launch(home);
  try {
    const note = await notes(page, home);
    await tid(page, "new-chat").click();
    const panel = await openContext(page);
    await expect(panel.getByRole("checkbox", { name: "README.md", exact: true })).toBeVisible();
    await expect(panel.getByRole("checkbox", { name: "Note: Context reference", exact: true })).toBeVisible();
    await expect(panel.getByText("Foreign reference", { exact: true })).toHaveCount(0);
    await panel.getByRole("checkbox", { name: "README.md", exact: true }).check();
    await panel.getByRole("checkbox", { name: "Note: Context reference", exact: true }).check();
    await panel.getByRole("button", { name: "Apply context", exact: true }).click();
    await expect(panel.getByText("Selected, not inspected", { exact: true })).toHaveCount(2);
    await page.screenshot({ path: test.info().outputPath("context-composer.png"), animations: "disabled" });
    expect((await page.evaluate(() => window.modex!.invoke("state:get", undefined))).threads).toHaveLength(0);
    await tid(page, "composer-input").fill("Selected request"); await tid(page, "send").click();
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect(items(page, "assistant").last()).toContainText("Context fixture complete");
    const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
    const stored = await page.evaluate(id => window.modex!.invoke("thread:items", { threadId: id }), threadId);
    const requests = stored.filter(item => item.kind === "user"); expect(requests).toHaveLength(1);
    expect(requests[0]!.contextEvidence!.refs.map(ref => ref.target)).toEqual([{ kind: "file", path: "README.md" }, { kind: "note", pageId: note.id }]);
    const inputs = fs.readFileSync(path.join(home, "context-inputs.jsonl"), "utf8").trim().split("\n"); expect(inputs).toHaveLength(1);
    expect(inputs[0]).toContain("Modex selected project references"); expect(inputs[0]).not.toContain("context-private-body-sentinel");
  } finally { await app.close(); }
});

test("project switches revoke old draft nonces and retain selections only in their own scope", async () => {
  const { home } = setup(), { app, page } = await launch(home);
  try {
    await notes(page, home);
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get("task:context-draft-open"); ipcMain.removeHandler("task:context-draft-open");
      ipcMain.handle("task:context-draft-open", async (event, request) => { const binding = await original(event, request); (globalThis as any).__contextBinding = binding; return binding; });
    });
    await tid(page, "new-chat").click(); let panel = await openContext(page);
    await panel.getByRole("checkbox", { name: "README.md", exact: true }).check(); await panel.getByRole("button", { name: "Apply context", exact: true }).click();
    const old = await app.evaluate(() => (globalThis as any).__contextBinding);
    await tid(page, "draft-project").click(); await page.locator('[data-testid="draft-project-option"][data-project-id="p2"]').click();
    panel = await openContext(page); await expect(panel.getByRole("checkbox", { name: "Note: Foreign reference", exact: true })).toBeVisible();
    await expect(panel.getByText("Selected, not inspected", { exact: true })).toHaveCount(0);
    await expect(page.evaluate(binding => window.modex!.invoke("task:context-draft-select", { binding, targets: [] }), old)).rejects.toThrow(/draft|stale/);
    await tid(page, "draft-project").click(); await page.locator('[data-testid="draft-project-option"][data-project-id="p1"]').click();
    panel = await openContext(page); await expect(panel.getByText("Selected, not inspected", { exact: true })).toHaveCount(1);
  } finally { await app.close(); }
});

test("a model proposal is confirmed explicitly, inspected on Retry and frozen by Save and reopen", async () => {
  const { home } = setup(), { app, page } = await launch(home);
  try {
    const note = await notes(page, home); await tid(page, "new-chat").click();
    await tid(page, "composer-input").fill("Propose context"); await tid(page, "send").click();
    await expect(items(page, "assistant").last()).toContainText("Context fixture complete"); await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    const threadId = (await currentRow(page).getAttribute("data-thread-id"))!;
    await page.getByRole("button", { name: "Task context · 2", exact: true }).click({ timeout: 3000 });
    const panel = page.getByRole("region", { name: "Task context", exact: true });
    await expect(panel.getByText("Proposed by model", { exact: true })).toHaveCount(2);
    await panel.getByText("Proposed role: file", { exact: true }).waitFor({ timeout: 3000 });
    await expect(panel.getByText("Proposed role: note", { exact: true })).toBeVisible();
    await expect(panel.getByText("Observed read", { exact: true })).toHaveCount(0);
    await panel.getByRole("checkbox", { name: "Relevant: README.md", exact: true }).check();
    await panel.getByRole("checkbox", { name: `Relevant: Note ${note.id}`, exact: true }).check();
    await expect(panel.getByText("Confirmed by you", { exact: true })).toHaveCount(2);
    const initial = await page.evaluate(id => window.modex!.invoke("thread:items", { threadId: id }), threadId);
    const user = initial.find(item => item.kind === "user")!; expect(user.kind).toBe("user"); if (user.kind !== "user") throw Error("Missing user");
    expect(user.contextEvidence!.captures).toEqual([]);
    expect(user.contextEvidence!.checks[0]!.relevance).toBe("unestablished");
    await expect(tid(page, "task-verification").last()).toHaveAttribute("data-state", "unknown");
    const checkControls = panel.getByRole("group", { name: "Check relevance: pnpm test", exact: true });
    await checkControls.getByRole("button", { name: /^Show native item / }).click({ timeout: 3000 });
    await expect(page.locator('[data-item-kind="tool"][data-item-id]').filter({ hasText: "pnpm test" }).first()).toBeFocused();
    await checkControls.getByRole("checkbox", { name: "Check reference: README.md", exact: true }).check({ timeout: 3000 });
    await checkControls.getByRole("button", { name: "Apply check relevance", exact: true }).click();
    await expect(checkControls).toContainText("user-confirmed");
    await expect(tid(page, "task-verification").last()).toHaveAttribute("data-state", "unknown");
    await checkControls.getByRole("button", { name: "Clear check relevance", exact: true }).click();
    await expect(checkControls).toContainText("unestablished");
    const retryReceipt = await page.evaluate(id => window.modex!.invoke("thread:retry", { threadId: id }), threadId);
    expect(retryReceipt.ok, retryReceipt.error).toBe(true);
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await test.info().attach("retry-metadata", { body: JSON.stringify({ count: fs.readFileSync(path.join(home, "context-attempt"), "utf8"), items: await page.evaluate(id => window.modex!.invoke("thread:items", { threadId: id }), threadId) }), contentType: "application/json" });
    await expect(panel.getByText("Observed read", { exact: true })).toHaveCount(2);
    await panel.getByRole("button", { name: /^Show native item / }).first().click({ timeout: 3000 });
    await expect(page.locator('[data-item-kind="tool"][data-item-id]').filter({ hasText: "README.md" }).first()).toBeFocused();
    const after = await page.evaluate(({ threadId, turnId }) => window.modex!.invoke("task:context", { threadId, turnId }), { threadId, turnId: user.id });
    expect(JSON.stringify(after)).not.toContain("context-private-body-sentinel");
    expect(after.captures.some(c => c.target.kind === "note" && c.target.pageId === note.id && c.revision.state === "available" && c.revision.digest === createHash("sha256").update("context-private-body-sentinel").digest("hex"))).toBe(true);
    await tid(page, "save-task-note").last().click(); await expect(tid(page, "task-note-saved").last()).toContainText("Saved to Notes");
    const before = fs.readFileSync(path.join(home, "context-inputs.jsonl"), "utf8");
    await tid(page, "task-note-saved").last().getByRole("button", { name: "Open", exact: true }).click(); await tid(page, "task-view-open").click();
    const frozen = tid(page, "task-view"); await expect(frozen).toBeVisible();
    await frozen.getByRole("button", { name: "Task context · 2", exact: true }).click();
    await expect(frozen.getByText("Observed read", { exact: true })).toHaveCount(2);
    await expect(frozen.getByRole("checkbox", { name: /^Relevant:/ })).toHaveCount(0);
    await expect(frozen.getByRole("checkbox", { name: /^Check reference:/ })).toHaveCount(0);
    await expect(frozen.getByRole("button", { name: "Apply check relevance", exact: true })).toHaveCount(0);
    await page.screenshot({ path: test.info().outputPath("context-frozen-task.png"), animations: "disabled" });
    expect(fs.readFileSync(path.join(home, "context-inputs.jsonl"), "utf8")).toBe(before);
  } finally { await app.close(); }
});

test("a scoped Note preview uses the human Notes view and grants no agent capability", async () => {
  const { home } = setup(), { app, page } = await launch(home);
  try {
    await notes(page, home);
    await page.evaluate(() => window.modex!.invoke("project:pages", { projectId: "p1", enabled: false }));
    await tid(page, "new-chat").click(); const panel = await openContext(page);
    await panel.getByRole("button", { name: "Preview Note: Context reference", exact: true }).click({ timeout: 3000 });
    await expect(page.getByRole("textbox", { name: "Page title", exact: true })).toHaveValue("Context reference");
    const state = await page.evaluate(() => window.modex!.invoke("state:get", undefined));
    expect(state.threads).toHaveLength(0); expect(state.projects.find(project => project.id === "p1")!.pagesMaintenance).toBe(false);
    expect(fs.existsSync(path.join(home, "context-inputs.jsonl"))).toBe(false);
  } finally { await app.close(); }
});

test("selection errors recover, keyboard focus stays local and overflow expansion never rehashes retained references", async () => {
  const { home, repo } = setup(); for (let i = 0; i < 23; i++) fs.writeFileSync(path.join(repo, `context-${String(i).padStart(2, "0")}.ts`), `// ${i}\n`);
  const { app, page } = await launch(home);
  try {
    await app.evaluate(({ ipcMain }) => {
      const original = (ipcMain as any)._invokeHandlers.get("task:context-draft-select"); let fail = true; (globalThis as any).__contextSelectCalls = 0; ipcMain.removeHandler("task:context-draft-select");
      ipcMain.handle("task:context-draft-select", async (event, request) => { (globalThis as any).__contextSelectCalls++; if (fail) { fail = false; throw Error("Synthetic context selection failure"); } const result = await original(event, request); (globalThis as any).__contextSelection = result; return result; });
    });
    await tid(page, "new-chat").click(); const trigger = page.getByRole("button", { name: "Context for next request", exact: true }); await trigger.waitFor({ timeout: 3000 }); await trigger.focus(); await page.keyboard.press("Enter");
    const panel = page.getByRole("region", { name: "Context for next request", exact: true });
    await panel.getByRole("button", { name: /Show all candidates/ }).click();
    for (let i = 0; i < 23; i++) await panel.getByRole("checkbox", { name: `context-${String(i).padStart(2, "0")}.ts`, exact: true }).check();
    await panel.getByRole("button", { name: "Apply context", exact: true }).click(); await expect(panel.getByRole("alert")).toContainText("Synthetic context selection failure");
    await panel.getByRole("button", { name: "Apply context", exact: true }).click(); await expect(panel.getByText("Selected, not inspected", { exact: true })).toHaveCount(20);
    const before = await app.evaluate(() => ({ calls: (globalThis as any).__contextSelectCalls, selection: (globalThis as any).__contextSelection }));
    expect(before.calls).toBe(2); expect(before.selection.context.refs).toHaveLength(23);
    fs.writeFileSync(path.join(repo, "context-00.ts"), "changed after selection\n");
    await panel.getByRole("button", { name: "Show all 23 references", exact: true }).click(); await expect(panel.getByText("Selected, not inspected", { exact: true })).toHaveCount(23);
    expect(await app.evaluate(() => ({ calls: (globalThis as any).__contextSelectCalls, selection: (globalThis as any).__contextSelection }))).toEqual(before);
    const digest = before.selection.context.captures[0].revision.digest; await panel.getByTestId("context-reference").first().locator("summary").first().click(); await expect(panel.getByTestId("context-digest").first()).toHaveText(digest);
    await page.keyboard.press("Escape"); await expect(trigger).toBeFocused(); await expect(panel).toHaveCount(0);
  } finally { await app.close(); }
});

test("turn relevance controls share the retained-reference limit and reveal overflow explicitly", async () => {
  const { home, repo } = setup(); for (let i = 0; i < 23; i++) fs.writeFileSync(path.join(repo, `reference-${i}.ts`), "// selected\n");
  const { app, page } = await launch(home);
  try {
    await tid(page, "new-chat").click(); const draft = await openContext(page);
    await draft.getByRole("button", { name: /Show all candidates/ }).click();
    for (let i = 0; i < 23; i++) await draft.getByRole("checkbox", { name: `reference-${i}.ts`, exact: true }).check();
    await draft.getByRole("button", { name: "Apply context", exact: true }).click();
    await tid(page, "composer-input").fill("Selected references"); await tid(page, "send").click();
    await expect(items(page, "assistant").last()).toContainText("Context fixture complete"); await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await page.getByRole("button", { name: "Task context · 23", exact: true }).click();
    const turn = page.getByRole("region", { name: "Task context", exact: true });
    await expect(turn.getByRole("checkbox", { name: /^Relevant:/ })).toHaveCount(20);
    await turn.getByRole("button", { name: "Show all 23 references", exact: true }).click();
    await expect(turn.getByRole("checkbox", { name: /^Relevant:/ })).toHaveCount(23);
  } finally { await app.close(); }
});

test("Files includes an explicit reference in the next composer without sending or claiming inspection", async () => {
  const { home } = setup(), { app, page } = await launch(home);
  try {
    await tid(page, "new-chat").click(); await tid(page, "composer-input").fill("Open files"); await tid(page, "send").click();
    await expect(items(page, "assistant").last()).toContainText("Context fixture complete"); await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    if (!await tid(page, "workspace").isVisible()) await tid(page, "changes-toggle").click();
    await tid(page, "workspace-add").click(); await page.getByRole("menuitem", { name: "New tab ⇧⌘B", exact: true }).click(); await page.getByRole("button", { name: "Files ⌘P", exact: true }).click();
    await page.getByRole("treeitem", { name: "Open README.md", exact: true }).click();
    await page.getByRole("button", { name: "Include in next request", exact: true }).click({ timeout: 3000 });
    const panel = page.getByRole("region", { name: "Context for next request", exact: true });
    await expect(panel.getByText("README.md", { exact: true }).last()).toBeVisible();
    await expect(panel.getByText("Selected, not inspected", { exact: true })).toHaveCount(1);
    expect(fs.readFileSync(path.join(home, "context-inputs.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  } finally { await app.close(); }
});

test("browser create/send retains its held binding when the person switches projects and returns", async () => {
  const { home } = setup(), stateFile = path.join(home, "app/state.json"), state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.settings.default_backend = "mock"; state.settings.mock_script = path.join(home, "browser-context.json");
  fs.writeFileSync(state.settings.mock_script, JSON.stringify([{ content: "Browser context done." }])); fs.writeFileSync(stateFile, JSON.stringify(state));
  const keys = ["MODEX_BROWSER_HOME", "MODEX_E2E", "MODEX_NO_LOGIN_PATH", "TYPESAFE_API_KEY", "JEV_CONFIG", "JEV_API_KEY"] as const;
  const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  Object.assign(process.env, { MODEX_BROWSER_HOME: home, MODEX_E2E: "1", MODEX_NO_LOGIN_PATH: "1", TYPESAFE_API_KEY: "", JEV_API_KEY: "", JEV_CONFIG: path.join(home, "no-jev-config.json") });
  const server = await createServer({ configFile: path.join(appDir, "vite.config.ts"), server: { port: 0, host: "127.0.0.1", open: false } });
  let browser: Browser | undefined, release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  let creates = 0, sends = 0;
  try {
    await server.listen(); const address = server.httpServer!.address(); if (!address || typeof address === "string") throw Error("Missing browser listener");
    browser = await chromium.launch(); const page = await browser.newPage({ viewport: { width: 1400, height: 1000 } });
    await page.route("**/__modex/invoke", async route => {
      const request = route.request().postDataJSON();
      if (request.channel === "thread:create") { creates++; await gate; }
      if (request.channel === "thread:send") sends++;
      await route.continue();
    });
    await page.goto(`http://127.0.0.1:${address.port}`); await tid(page, "new-chat").click();
    const initial = await openContext(page); await initial.getByRole("checkbox", { name: "README.md", exact: true }).check(); await initial.getByRole("button", { name: "Apply context", exact: true }).click();
    await tid(page, "composer-input").fill("Browser selected context"); await tid(page, "send").click(); await expect.poll(() => creates).toBe(1);
    await tid(page, "draft-project").click(); await page.locator('[data-testid="draft-project-option"][data-project-id="p2"]').click();
    await tid(page, "draft-project").click(); await page.locator('[data-testid="draft-project-option"][data-project-id="p1"]').click();
    const returned = page.getByRole("region", { name: "Context for next request", exact: true });
    await expect(returned).toBeVisible({ timeout: 3000 });
    await expect(returned.getByRole("checkbox", { name: "README.md", exact: true })).toBeDisabled();
    release(); await expect(items(page, "assistant").last()).toContainText("Browser context done."); await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    expect(creates).toBe(1); expect(sends).toBe(1);
    const id = (await currentRow(page).getAttribute("data-thread-id"))!;
    const stored = JSON.parse(fs.readFileSync(path.join(home, "app/threads", `${id}.json`), "utf8"));
    expect(stored.filter((item: any) => item.kind === "user")).toHaveLength(1);
    expect(stored.find((item: any) => item.kind === "user").contextEvidence.refs[0].target).toEqual({ kind: "file", path: "README.md" });
  } finally {
    release(); await browser?.close(); await server.close();
    for (const key of keys) { if (previous[key] === undefined) delete process.env[key]; else process.env[key] = previous[key]; }
  }
});

test("a revoked draft reloads saved metadata without recapturing changed files", async () => {
  const { home, repo } = setup(), { app, page } = await launch(home);
  try {
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as any)._invokeHandlers;
      const open = handlers.get("task:context-draft-open"), select = handlers.get("task:context-draft-select");
      ipcMain.removeHandler("task:context-draft-open"); ipcMain.removeHandler("task:context-draft-select"); (globalThis as any).__captureSelections = 0;
      ipcMain.handle("task:context-draft-open", async (event, request) => { const binding = await open(event, request); (globalThis as any).__openedBinding = binding; return binding; });
      ipcMain.handle("task:context-draft-select", async (event, request) => { (globalThis as any).__captureSelections++; const result = await select(event, request); (globalThis as any).__selectedBinding = result.binding; (globalThis as any).__savedSelection = result.context; return result; });
    });
    await tid(page, "new-chat").click(); const panel = await openContext(page);
    await panel.getByRole("checkbox", { name: "README.md", exact: true }).check(); await panel.getByRole("button", { name: "Apply context", exact: true }).click();
    await expect(panel.getByText("Selected, not inspected", { exact: true })).toHaveCount(1);
    const saved = await app.evaluate(() => ({ binding: (globalThis as any).__selectedBinding, context: (globalThis as any).__savedSelection }));
    await page.evaluate(binding => window.modex!.invoke("task:context-draft-close", { binding }), saved.binding);
    fs.writeFileSync(path.join(repo, "README.md"), "changed since saved selection\n");
    await panel.getByRole("checkbox", { name: "package.json", exact: true }).check(); await panel.getByRole("button", { name: "Apply context", exact: true }).click();
    await expect(panel.getByRole("alert")).toContainText(/draft|stale/i);
    await panel.getByRole("button", { name: "Reload saved context", exact: true }).click({ timeout: 3000 });
    await expect(panel.getByRole("alert")).toHaveCount(0);
    await expect(panel.getByRole("checkbox", { name: "README.md", exact: true })).toBeChecked(); await expect(panel.getByRole("checkbox", { name: "package.json", exact: true })).not.toBeChecked();
    const reloaded = await app.evaluate(() => ({ binding: (globalThis as any).__openedBinding, calls: (globalThis as any).__captureSelections }));
    expect(reloaded.binding.nonce).not.toBe(saved.binding.nonce); expect(reloaded.calls).toBe(2);
    const metadata = await page.evaluate(binding => window.modex!.invoke("task:context-draft", { binding }), reloaded.binding);
    expect(metadata).toEqual(saved.context);
    await panel.getByTestId("context-reference").first().locator("summary").first().click(); await expect(panel.getByTestId("context-digest").first()).toHaveText(saved.context.captures[0].revision.digest);
  } finally { await app.close(); }
});
