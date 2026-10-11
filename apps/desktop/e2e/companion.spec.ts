import { test, expect } from "@playwright/test";
import fs from "node:fs";
import { seedHome, launch, tid } from "./support.js";

test("the Mac pairs an iPhone with a QR code and can revoke access", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "open-companion").click();
    await expect(tid(page, "companion-dialog")).toBeVisible();
    await tid(page, "companion-start").click();
    await expect(tid(page, "companion-qr")).toBeVisible();
    const first = await page.evaluate(() => window.modex.invoke("companion:status", undefined));
    expect(first.enabled).toBe(true);
    expect(first.pairingUri).toMatch(/^modex:\/\/pair\?data=/);
    await tid(page, "companion-copy-link").click();
    await expect(tid(page, "companion-copy-link")).toHaveText("Copied pairing link");
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(first.pairingUri);
    await page.getByRole("button", { name: "Forget paired phones" }).click();
    const rotated = await page.evaluate(() => window.modex.invoke("companion:status", undefined));
    expect(rotated.pairingUri).not.toBe(first.pairingUri);
    await expect(tid(page, "companion-copy-link")).toHaveText("Copy pairing link");
    await tid(page, "companion-copy-link").click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(rotated.pairingUri);
    await page.getByRole("button", { name: "Turn off" }).click();
    await expect(tid(page, "companion-qr")).toHaveCount(0);
    expect((await page.evaluate(() => window.modex.invoke("companion:status", undefined))).enabled).toBe(false);
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("pairing network selection keeps each QR and copied link together across revocation and address removal", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  try {
    // This tests UI state only. Real listener reachability is covered by companion-network.test.
    await app.evaluate(({ ipcMain }) => {
      const endpoint = (address: string, revision: string) => ({ address, port: 43120,
        pairingUri: `modex://pair?data=${address}-${revision}`,
        qrDataUrl: `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text y="20">${address}-${revision}</text></svg>`)}` });
      let endpoints = [endpoint("10.0.0.1", "first"), endpoint("192.168.2.1", "first")];
      const status = () => ({ enabled: true, addresses: endpoints.map(e => e.address), ...endpoints[0], endpoints });
      for (const name of ["companion:status", "companion:reset"]) ipcMain.removeHandler(name);
      ipcMain.handle("companion:status", status);
      ipcMain.handle("companion:reset", () => { endpoints = endpoints.map(e => endpoint(e.address, "rotated")); return status(); });
      (globalThis as any).__removeSecondaryNetwork = () => { endpoints = endpoints.slice(0, 1); };
    });
    await tid(page, "open-companion").click();
    const network = page.getByRole("combobox", { name: "Mac network" });
    await expect(network).toBeVisible();
    await network.selectOption("192.168.2.1");
    await expect(tid(page, "companion-qr")).toHaveAttribute("src", /192\.168\.2\.1-first/);
    await tid(page, "companion-copy-link").click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("modex://pair?data=192.168.2.1-first");
    await page.getByRole("button", { name: "Forget paired phones" }).click();
    await expect(network).toHaveValue("192.168.2.1");
    await expect(tid(page, "companion-qr")).toHaveAttribute("src", /192\.168\.2\.1-rotated/);
    await expect(tid(page, "companion-copy-link")).toHaveText("Copy pairing link");
    await tid(page, "companion-copy-link").click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("modex://pair?data=192.168.2.1-rotated");
    await app.evaluate(() => (globalThis as any).__removeSecondaryNetwork());
    await expect(network).toHaveCount(0);
    await expect(tid(page, "companion-qr")).toHaveAttribute("src", /10\.0\.0\.1-rotated/);
    await tid(page, "companion-copy-link").click();
    expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe("modex://pair?data=10.0.0.1-rotated");
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
