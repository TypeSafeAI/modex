import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { appDir, items, tid } from "./support";

test("Store demo works without a host and resets without saving access", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-store-demo-"));
  const clientDir = path.resolve(appDir, "../store-desktop");
  const client = await electron.launch({ args: [clientDir], cwd: clientDir,
    env: { ...process.env, MODEX_E2E: "1", MODEX_STORE_HOME: home, MODEX_DESKTOP_DISCOVERY_DIR: path.join(home, "no-host") } });
  try {
    const page = await client.firstWindow();
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.evaluate(() => {
      localStorage.setItem("modex.layout", JSON.stringify({ v: 1, sidebar: false, changes: false, streamerMode: true }));
      localStorage.setItem("modex.theme", "coven");
    });
    await page.getByRole("button", { name: "Explore a demo workspace" }).click();
    await expect(page.getByRole("region", { name: "Demo workspace" })).toContainText("No host connected");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "jev");
    await expect(items(page, "approval")).toBeVisible();
    await items(page, "approval").getByRole("button", { name: "Approve", exact: true }).click();
    await expect(items(page, "assistant").last()).toContainText("demo");
    await tid(page, "composer-input").fill("Summarize the change");
    await page.keyboard.press("Meta+Enter");
    await expect(items(page, "assistant").last()).toContainText("Summarize the change");
    const state = await page.evaluate(() => (window as any).modex.invoke("state:get"));
    expect(state.threads).toHaveLength(3);
    expect(fs.existsSync(path.join(home, "host-access.enc"))).toBe(false);
    await tid(page, "sidebar-toggle").click();
    await page.getByRole("button", { name: "Reset demo" }).click();
    await expect(items(page, "approval").getByRole("button", { name: "Approve", exact: true })).toBeVisible();
    await expect(tid(page, "thread-row")).toHaveCount(3);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "jev");
    await page.getByRole("button", { name: "Leave demo" }).click();
    await expect(page.getByRole("button", { name: "Explore a demo workspace" })).toBeVisible();
    await expect(tid(page, "thread-row")).toHaveCount(0);
    expect(fs.existsSync(path.join(home, "host-access.enc"))).toBe(false);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem("modex.layout")!))).toEqual({ v: 1, sidebar: false, changes: false, streamerMode: true });
    expect(await page.evaluate(() => localStorage.getItem("modex.theme"))).toBe("coven");
    expect(errors).toEqual([]);
  } finally {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("Store demo preserves unreadable saved host access", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "modex-store-demo-saved-"));
  const saved = path.join(home, "host-access.enc");
  fs.writeFileSync(saved, "existing encrypted access");
  const clientDir = path.resolve(appDir, "../store-desktop");
  const client = await electron.launch({ args: [clientDir], cwd: clientDir, env: { ...process.env, MODEX_E2E: "1", MODEX_STORE_HOME: home } });
  try {
    const page = await client.firstWindow();
    await expect(page.getByText(/Saved host access could not be opened/)).toBeVisible();
    await page.getByRole("button", { name: "Explore a demo workspace" }).click();
    await expect(items(page, "approval")).toBeVisible();
    const prevented = await page.evaluate(async () => {
      try { await (window as any).modexHost.disconnect(); return false; } catch { return true; }
    });
    expect(prevented).toBe(true);
    await page.getByRole("button", { name: "Leave demo" }).click();
    await expect(page.getByText(/Saved host access could not be opened/)).toBeVisible();
    expect(fs.readFileSync(saved, "utf8")).toBe("existing encrypted access");
  } finally { await client.close(); fs.rmSync(home, { recursive: true, force: true }); }
});
