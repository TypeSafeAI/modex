import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createServer } from "node:http";
import { appDir, createThread, seedHome, tid } from "./support";

test("Store browser guests belong to the client and hide while its host is disconnected", async () => {
  const { home, repo } = seedHome();
  const clientHome = fs.mkdtempSync(path.join(os.tmpdir(), "modex-store-browser-"));
  const clientDir = path.resolve(appDir, "../store-desktop");
  const server = createServer((_req, res) => { res.writeHead(200, { "Content-Type": "text/html" }); res.end("<title>Store local browser</title><h1>Client-owned page</h1>"); });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/store-browser`;
  let host: ElectronApplication | undefined;
  let client: ElectronApplication | undefined;
  const startHost = async () => {
    const app = await electron.launch({ args: [appDir, "--desktop-host"], cwd: appDir, env: { ...process.env, MODEX_HOME: home, MODEX_E2E: "1", MODEX_NO_LOGIN_PATH: "1", JEV_API_KEY: "", TYPESAFE_API_KEY: "", JEV_CONFIG: path.join(home, "no-jev.json") } });
    await app.firstWindow();
    await expect.poll(() => app.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.items.find((item) => item.label === "Desktop access"))).toBe(true);
    return app;
  };
  try {
    host = await startHost();
    await host.evaluate(({ Menu, dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
      Menu.getApplicationMenu()!.items.find((item) => item.label === "Desktop access")!.submenu!.items[0]!.click();
    });
    let link = "";
    await expect.poll(async () => { link = await host!.evaluate(({ clipboard }) => clipboard.readText()); return link.startsWith("modex-desktop://pair?"); }).toBe(true);
    client = await electron.launch({ args: [clientDir], cwd: clientDir, env: { ...process.env, MODEX_E2E: "1", MODEX_STORE_HOME: clientHome } });
    const page = await client.firstWindow();
    await page.getByText("Use a connection link instead", { exact: true }).click();
    await page.getByLabel("Connection link", { exact: true }).fill(link);
    await page.getByRole("button", { name: "Connect to my Mac" }).click();
    await expect(tid(page, "draft-view")).toBeVisible();
    await createThread(page, "Browse in the Store client");
    await page.keyboard.press("Meta+Shift+b");
    await tid(page, "workspace-address").fill(url);
    await tid(page, "workspace-address").press("Enter");
    await expect(page.getByRole("tab", { name: "Store local browser", exact: true })).toBeVisible();
    const guestCount = (app: ElectronApplication) => app.evaluate(({ webContents }, url) => webContents.getAllWebContents().filter((w) => w.getURL() === url).length, url);
    const guestVisible = () => client!.evaluate(({ BrowserWindow }, url) => BrowserWindow.getAllWindows()[0]!.contentView.children.some((v) => "webContents" in v && (v as import("electron").WebContentsView).webContents.getURL() === url && v.getVisible()), url);
    await expect.poll(() => guestCount(client!)).toBe(1);
    expect(await guestCount(host)).toBe(0);
    await expect.poll(guestVisible).toBe(true);
    await client.evaluate(({ webContents }, url) => webContents.getAllWebContents().find((w) => w.getURL() === url)!.sendInputEvent({ type: "keyDown", keyCode: "L", modifiers: ["meta"] }), url);
    await expect(tid(page, "workspace-address")).toBeFocused();
    await host.close(); host = undefined;
    await expect(page.getByText("Reconnecting automatically", { exact: true })).toBeVisible();
    await expect.poll(guestVisible).toBe(false);
    host = await startHost();
    await expect(page.getByText("Reconnecting automatically", { exact: true })).toBeHidden();
    await expect.poll(guestVisible).toBe(true);
    expect(await guestCount(host)).toBe(0);
    await page.getByRole("button", { name: "Close Store local browser tab", exact: true }).click();
    await expect.poll(() => guestCount(client!)).toBe(0);
    await page.evaluate((url) => window.modex!.invoke("browser:command", { id: "crash-case", action: "navigate", url }), url);
    await expect.poll(() => guestCount(client!)).toBe(1);
    await client.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.webContents.forcefullyCrashRenderer());
    await expect.poll(() => guestCount(client!)).toBe(0);
  } finally {
    await client?.close(); await host?.close();
    server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
    for (const dir of [home, repo, clientHome]) fs.rmSync(dir, { recursive: true, force: true });
  }
});
