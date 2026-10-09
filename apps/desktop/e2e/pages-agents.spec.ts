import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid } from "./support";

test("Pages notes access persists; open notes refresh and recover historical revisions", async () => {
  const { home, repo } = seedHome();
  const first = await launch(home);
  try {
    await tid(first.page, "rail-space").click();
    await first.page.getByText("Agent notes", { exact: true }).click();
    const toggle = first.page.getByRole("checkbox", { name: `Manage notes for ${path.basename(repo)}` });
    await expect(toggle).not.toBeChecked(); await toggle.check(); await expect(toggle).toBeChecked();
    await tid(first.page, "rail-chat").click();
    const added = path.join(home, "new-project"); fs.mkdirSync(added);
    await first.page.evaluate(async path => (window as any).modex.invoke("project:add", { path }), added);
    await tid(first.page, "rail-space").click();
    await expect(first.page.getByRole("checkbox", { name: "Manage notes for new-project" })).toBeVisible();
    const id = await first.page.evaluate(async () => (await (window as any).modex.invoke("space:create", { title: "Agent note", markdown: "Original human text" })).id);
    await first.page.getByRole("button", { name: "Open Agent note", exact: true }).click();
    await expect(first.page.getByText("Original human text", { exact: true })).toBeVisible();
    await first.page.evaluate(async id => {
      const p = (await (window as any).modex.invoke("space:list")).find((p: any) => p.id === id);
      await (window as any).modex.invoke("space:save", { ...p, markdown: "Updated through main" });
    }, id);
    await expect(first.page.getByText("Updated through main", { exact: true })).toBeVisible();
    await first.page.getByRole("button", { name: "Page actions" }).click();
    await first.page.getByRole("menuitem", { name: "Version history" }).click();
    await first.page.getByText("Revision 1 · You · Created page", { exact: true }).click();
    await first.page.getByRole("button", { name: "Restore revision 1", exact: true }).click();
    await expect(first.page.getByText("Original human text", { exact: true }).first()).toBeVisible();
    await expect.poll(() => JSON.parse(fs.readFileSync(path.join(home, "app/space.json"), "utf8")).pages[0].revision).toBe(3);
  } finally { await first.app.close(); }
  const second = await launch(home);
  try {
    await tid(second.page, "rail-space").click();
    await second.page.getByText("Agent notes", { exact: true }).click();
    await expect(second.page.getByRole("checkbox", { name: `Manage notes for ${path.basename(repo)}` })).toBeChecked();
    await second.page.getByRole("button", { name: "Open Agent note", exact: true }).click();
    await expect(second.page.getByText("Original human text", { exact: true })).toBeVisible();
  } finally { await second.app.close(); }
});

test("a CLI turn manages Pages through MCP and its persisted receipt opens the native note", async () => {
  const { home, repo } = seedHome({ default_backend: "claude", default_mode: "agent" });
  const cli = path.join(home, "pages-cli.cjs");
  fs.writeFileSync(cli, `#!${process.execPath}
const fs=require('node:fs');
if(process.argv.includes('--version')){console.log('2.1.289 (Claude Code)');process.exit(0);}
if(!process.argv.includes('--mcp-config')){console.log(JSON.stringify({type:'result',result:'Notes',is_error:false}));process.exit(0);}
const url=JSON.parse(process.argv[process.argv.indexOf('--mcp-config')+1]).mcpServers.modex_pages.url;
fs.writeFileSync(${JSON.stringify(path.join(home, "pages-url"))},url);
let id=0;
async function rpc(method,params){const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:++id,method,params})});const result=await response.json();if(result.error||result.result?.isError)throw Error(JSON.stringify(result));return result.result;}
async function call(name,args){return JSON.parse((await rpc('tools/call',{name,arguments:args})).content[0].text);}
require('node:readline').createInterface({input:process.stdin}).once('line',async()=>{
try {
 await rpc('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'pages-cli-fixture',version:'1'}});
 await call('search',{query:'CLI note'});
 const parent=await call('create',{title:'CLI folder',markdown:'Project notes',summary:'Create parent'});
 let p=await call('create',{title:'CLI note',markdown:'Human content. Original decision.',summary:'Create note'});
 p=await call('read',{id:p.id});
 p=await call('edit',{id:p.id,revision:p.revision,find:'Original',replace:'Verified',summary:'Verify decision'});
 p=await call('update',{id:p.id,revision:p.revision,parentId:parent.id,favorite:true,summary:'Organize note'});
 await call('trash',{id:p.id,revision:p.revision,summary:'Trash requested note'});
 p=await call('read',{id:p.id});
 await call('restore',{id:p.id,revision:p.revision,summary:'Restore requested note'});
 const h=await call('history',{id:p.id}); if(h.versions.length<5) throw Error('Missing history');
 fs.writeFileSync(${JSON.stringify(path.join(home, "pages-id"))},p.id);
 console.log(JSON.stringify({type:'assistant',message:{content:[{type:'text',text:'Notes complete.'}]}}));
 console.log(JSON.stringify({type:'result',is_error:false,result:'Notes complete.'}));process.exit(0);
}catch(error){console.log(JSON.stringify({type:'result',is_error:true,result:String(error)}));process.exit(1);}
});
`, { mode: 0o755 });
  const stateFile = path.join(home, "app/state.json"); const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  state.projects[0].pagesMaintenance = true; state.settings.claude_bin = cli; fs.writeFileSync(stateFile, JSON.stringify(state));
  let { app, page } = await launch(home);
  try {
    await tid(page, "new-chat").click(); await tid(page, "composer-input").fill("Manage my notes"); await tid(page, "send").click();
    await expect(page.getByText("Notes complete.", { exact: true })).toBeVisible();
    const link = page.getByRole("button", { name: "Open note CLI note", exact: true }).last();
    await expect(link).toBeVisible(); await link.click();
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("CLI note");
    await expect(page.getByText("Human content. Verified decision.", { exact: true })).toBeVisible();
    expect(fs.existsSync(path.join(repo, "space.json"))).toBe(false);
    const url = fs.readFileSync(path.join(home, "pages-url"), "utf8");
    await expect.poll(async () => {
      const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/call", params: { name: "search", arguments: { query: "" } } }) });
      return (await r.json()).result?.isError;
    }).toBe(true);
    await app.close(); ({ app, page } = await launch(home));
    await expect(page.getByRole("button", { name: "Open note CLI note", exact: true }).last()).toBeVisible();
    await page.getByRole("button", { name: "Open note CLI note", exact: true }).last().click();
    await expect(page.getByText("Human content. Verified decision.", { exact: true })).toBeVisible();
  } finally { await app.close(); }
});

test("draft recovery locks editing and saves a copy without overwriting a concurrent change", async () => {
  const { home } = seedHome(); const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await page.getByRole("textbox", { name: "Block 1" }).fill("Original");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved locally");
    await app.evaluate(({ ipcMain }) => {
      const handlers = (ipcMain as any)._invokeHandlers as Map<string, (...args: any[]) => any>;
      const list = handlers.get("space:list")!;
      const save = handlers.get("space:save")!;
      const create = handlers.get("space:create")!;
      ipcMain.removeHandler("space:save");
      ipcMain.handle("space:save", async (event, draft) => {
        const p = (await list(event)).find((p: any) => p.id === draft.id)!;
        await save(event, { ...p, markdown: "Agent version" });
        return save(event, draft);
      });
      ipcMain.removeHandler("space:create");
      ipcMain.handle("space:create", (event, input) => new Promise(resolve => { (globalThis as any).__recover = () => resolve(create(event, input)); }));
    });
    await page.getByRole("textbox", { name: "Block 1" }).fill("Keep my draft");
    await expect(page.getByRole("alert")).toContainText("changed in another window");
    await page.getByRole("button", { name: "Save drafts as copies and reload" }).click();
    await expect(tid(page, "space")).toHaveAttribute("inert", "");
    await app.evaluate(() => (globalThis as any).__recover());
    await expect(tid(page, "space")).not.toHaveAttribute("inert", "");
    await expect(page.getByText("Agent version", { exact: true })).toBeVisible();
    const pages = JSON.parse(fs.readFileSync(path.join(home, "app/space.json"), "utf8")).pages;
    expect(pages.map((p: any) => p.markdown).sort()).toEqual(["Agent version", "Keep my draft"]);
  } finally {
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().forEach(w => w.destroy()));
    await app.close();
  }
});
