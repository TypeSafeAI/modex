import { test, expect, _electron as electron, type ElectronApplication } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDir, seedHome, tid, items } from "./support";

async function startHost(home: string): Promise<ElectronApplication> {
  const host = await electron.launch({ args: [appDir, "--desktop-host"], cwd: appDir,
    env: { ...process.env, MODEX_HOME: home, MODEX_E2E: "1", MODEX_DESKTOP_DISCOVERY_DIR: path.join(home, "discovery"), MODEX_NO_LOGIN_PATH: "1", JEV_API_KEY: "", TYPESAFE_API_KEY: "", JEV_CONFIG: path.join(home, "no-jev.json") } });
  await host.firstWindow();
  await expect.poll(() => host.evaluate(({ Menu }) => !!Menu.getApplicationMenu()?.items.find((item) => item.label === "Desktop access"))).toBe(true);
  return host;
}
async function pairingLink(host: ElectronApplication): Promise<string> {
  await host.evaluate(({ Menu, dialog }) => {
    dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
    const menu = Menu.getApplicationMenu()!.items.find((item) => item.label === "Desktop access")!.submenu!;
    menu.items[0]!.click();
  });
  let link = "";
  await expect.poll(async () => { link = await host.evaluate(({ clipboard }) => clipboard.readText()); return link.startsWith("modex-desktop://pair?"); }).toBe(true);
  return link;
}

test("Store client uses real host commands, approvals and terminal; reconnect preserves drafts and revocation blocks access", async () => {
  const { home, repo } = seedHome();
  const clientHome = fs.mkdtempSync(path.join(os.tmpdir(), "modex-store-e2e-"));
  let host = await startHost(home);
  const clientDir = path.resolve(appDir, "../store-desktop");
  const client = await electron.launch({ args: [clientDir], cwd: clientDir, env: { ...process.env, MODEX_E2E: "1", MODEX_STORE_HOME: clientHome } });
  try {
    const page = await client.firstWindow();
    await page.getByText("Use a connection link instead", { exact: true }).click();
    await page.getByLabel("Connection link", { exact: true }).fill(await pairingLink(host));
    await page.getByRole("button", { name: "Connect to my Mac" }).click();
    await expect(tid(page, "draft-view")).toBeVisible();
    await tid(page, "composer-input").fill("Build the demo through the Store host");
    await page.keyboard.press("Meta+Enter");
    await expect(items(page, "approval").first()).toBeVisible();
    await items(page, "approval").getByRole("button", { name: "Approve", exact: true }).click();
    await expect.poll(() => fs.existsSync(path.join(repo, "CONTRIBUTING.md"))).toBe(true);
    await expect(items(page, "assistant").last()).toBeVisible();
    const threadId = await page.locator('[data-testid="thread-row"][aria-current="true"]').getAttribute('data-thread-id');
    const terminal = await page.evaluate(async (threadId) => {
      const bridge = (window as any).modex;
      const snapshot = await bridge.invoke('terminal:open', { threadId, cols: 80, rows: 24 });
      await bridge.invoke('terminal:write', { threadId, sessionId: snapshot.sessionId, data: 'printf store_transport_ok\\n\r' });
      return snapshot;
    }, threadId);
    await expect.poll(() => page.evaluate(async (threadId) => (await (window as any).modex.invoke('terminal:open', { threadId, cols: 80, rows: 24 })).output, threadId)).toContain('store_transport_ok');
    await page.evaluate(async ({ threadId, sessionId }) => (window as any).modex.invoke('terminal:close', { threadId, sessionId }), { threadId, sessionId: terminal.sessionId });
    await tid(page, "composer-input").fill("Keep this unsent follow-up");
    await host.close();
    await expect(page.getByText("Reconnecting automatically", { exact: true })).toBeVisible();
    host = await startHost(home);
    await expect(page.getByText("Reconnecting automatically", { exact: true })).toBeHidden();
    await expect(tid(page, "composer-input")).toHaveValue("Keep this unsent follow-up");
    await host.evaluate(({ Menu, dialog }) => {
      dialog.showMessageBox = (async () => ({ response: 1, checkboxChecked: false })) as typeof dialog.showMessageBox;
      Menu.getApplicationMenu()!.items.find((item) => item.label === "Desktop access")!.submenu!.items[1]!.click();
    });
    await expect(page.getByText(/Your Mac removed this desktop's access/)).toBeVisible();
    expect(fs.existsSync(path.join(clientHome, "host-access.enc"))).toBe(false);
  } finally {
    await client.close(); await host.close();
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(clientHome, { recursive: true, force: true });
  }
});

test("Store preview discovers this Mac, confirms access once and restores saved access without another link", async () => {
  const { home, repo } = seedHome();
  const clientHome = fs.mkdtempSync(path.join(os.tmpdir(), "modex-store-discovery-e2e-"));
  const host = await startHost(home);
  const clientDir = path.resolve(appDir, "../store-desktop");
  const startClient = () => electron.launch({ args: [clientDir], cwd: clientDir, env: { ...process.env, MODEX_E2E: "1", MODEX_STORE_HOME: clientHome, MODEX_DESKTOP_DISCOVERY_DIR: path.join(home, "discovery") } });
  let client = await startClient();
  try {
    await host.evaluate(({ dialog }) => {
      const control = globalThis as typeof globalThis & { hostConfirmation: string; hostApprovals: number; approveHost: () => void };
      control.hostApprovals = 0;
      dialog.showMessageBox = (async (_window, options) => {
        control.hostApprovals++;
        control.hostConfirmation = options!.message;
        return new Promise((resolve) => { control.approveHost = () => resolve({ response: 1, checkboxChecked: false }); });
      }) as typeof dialog.showMessageBox;
    });
    const page = await client.firstWindow();
    await expect(page.getByRole("button", { name: "Connect to this Mac", exact: true })).toBeEnabled();
    await expect(page.getByLabel("Connection link", { exact: true })).toBeHidden();
    await page.getByRole("button", { name: "Connect to this Mac", exact: true }).click();
    const code = page.getByLabel("Connection confirmation code");
    await expect(code).toHaveText(/^[0-9]{6}$/);
    await expect.poll(() => host.evaluate(() => (globalThis as typeof globalThis & { hostConfirmation: string }).hostConfirmation)).toContain(await code.textContent());
    await expect(tid(page, "draft-view")).toHaveCount(0);
    expect(fs.existsSync(path.join(clientHome, "host-access.enc"))).toBe(false);
    await host.evaluate(() => (globalThis as typeof globalThis & { approveHost: () => void }).approveHost());
    await expect(tid(page, "draft-view")).toBeVisible();
    await client.close();
    client = await startClient();
    await expect(tid(await client.firstWindow(), "draft-view")).toBeVisible();
    expect(await host.evaluate(() => (globalThis as typeof globalThis & { hostApprovals: number }).hostApprovals)).toBe(1);
  } finally {
    await client.close(); await host.close();
    fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(repo, { recursive: true, force: true }); fs.rmSync(clientHome, { recursive: true, force: true });
  }
});
