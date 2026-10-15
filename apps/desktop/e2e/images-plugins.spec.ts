import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid } from "./support";
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
test("Images imports, displays, inserts into Space, attaches to chat and survives relaunch", async () => {
  const { home } = seedHome();
  let { app, page } = await launch(home);
  try {
    await tid(page, "rail-images").click();
    await expect(
      page.getByRole("heading", { name: "Images", exact: true }),
    ).toBeVisible();
    await page.getByLabel("Import image files").setInputFiles([
      { name: "sample.png", mimeType: "image/png", buffer: png },
      {
        name: "bad.png",
        mimeType: "image/png",
        buffer: Buffer.from("not an image"),
      },
    ]);
    await expect(page.getByRole("alert")).toContainText("bad.png");
    const card = page.getByRole("button", {
      name: "Open sample.png",
      exact: true,
    });
    await expect(card).toBeVisible();
    await expect
      .poll(() =>
        card
          .locator("img")
          .evaluate(
            (img: HTMLImageElement) => img.complete && img.naturalWidth > 0,
          ),
      )
      .toBe(true);
    const spacePage = await page.evaluate(() =>
      window.modex.invoke("space:create", {
        title: "Image board",
        markdown: "Original text",
      }),
    );
    await page.screenshot({ path: test.info().outputPath("images-library.png") });
    await card.click();
    await page.getByRole("button", { name: "Favorite", exact: true }).click();
    await page.getByLabel("Image name", { exact: true }).fill("Kept image");
    await page.getByRole("button", { name: "Rename", exact: true }).click();
    await page.getByLabel("Insert image into page").selectOption(spacePage.id);
    await page.getByRole("button", { name: "Insert", exact: true }).click();
    const md = await page.evaluate(
      (id) =>
        window.modex
          .invoke("space:list", undefined)
          .then((p) => p.find((p) => p.id === id)!.markdown),
      spacePage.id,
    );
    expect(md).toContain("modex-image://asset/");
    expect(md).toContain("Original text");
    await page
      .getByRole("button", { name: "Use in chat", exact: true })
      .click();
    await expect(tid(page, "attachment-chip")).toBeVisible();
    await tid(page, "rail-images").click();
    await page
      .getByRole("button", { name: "Open Kept image", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Move to Trash", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Delete permanently…", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Delete image", exact: true })
      .click();
    await expect(page.getByRole("alert")).toContainText("referenced");
    await page.getByRole("button", { name: "Restore", exact: true }).click();
    await app.close();
    ({ app, page } = await launch(home));
    await tid(page, "rail-images").click();
    await expect(
      page.getByRole("button", { name: "Open Kept image", exact: true }),
    ).toBeVisible();
  } finally {
    await app.close();
  }
});
test("Plugins binds an offline image skill; approvals produce a saved revision and persist prompt drafts", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-plugins").click();
    await expect(
      page.getByRole("heading", { name: "Plugins", exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: /modex-fixture/ })
      .first()
      .click();
    await page.screenshot({ path: test.info().outputPath("plugins-detail.png") });
    await page
      .getByRole("button", { name: "Use for Images", exact: true })
      .click();
    await page.getByRole("checkbox", { name: "This skill accepts reference images and edits" }).check();
    await page
      .getByRole("button", { name: "Save image skill", exact: true })
      .click();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await page
      .getByLabel("Image skill", { exact: true })
      .selectOption({ label: "modex-fixture · claude · unverified" });
    await page
      .getByLabel("Image prompt", { exact: true })
      .fill("An offline fixture flower");
    await page
      .getByRole("button", { name: "Generate image", exact: true })
      .click();
    await expect(
      page.getByText("waiting for approval", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Execution details", exact: true })
      .click();
    await expect(
      page.getByText("Writes one synthetic PNG", { exact: false }),
    ).toBeVisible();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("succeeded", { exact: true })).toBeVisible();
    await page
      .getByRole("button", { name: "View result", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Edit with a prompt", exact: true })
      .click();
    await page
      .getByLabel("Image prompt", { exact: true })
      .fill("Make the fixture blue");
    await tid(page, "rail-chat").click();
    await tid(page, "rail-images").click();
    await expect(page.getByLabel("Image prompt", { exact: true })).toHaveValue(
      "Make the fixture blue",
    );
    await page
      .getByRole("button", { name: "Generate revision", exact: true })
      .click();
    await expect(
      page.getByText("waiting for approval", { exact: true }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "Execution details", exact: true })
      .first()
      .click();
    await page.getByRole("button", { name: "Approve", exact: true }).click();
    await expect(page.getByText("succeeded", { exact: true })).toHaveCount(2);
    const assets = await page.evaluate(() =>
      window.modex.invoke("images:list", {}),
    );
    expect(assets.total).toBe(2);
    expect(assets.assets.some((a) => a.parentIds.length === 1)).toBe(true);
    await expect
      .poll(
        () =>
          JSON.parse(
            fs.readFileSync(path.join(home, "images", "jobs.json"), "utf8"),
          ).draft.prompt,
      )
      .toBe("Make the fixture blue");
  } finally {
    await app.close();
  }
});

test("corrupt image metadata preserves Chat and displays a recoverable library error", async () => {
  const { home } = seedHome();
  fs.mkdirSync(path.join(home, "images"));
  fs.writeFileSync(path.join(home, "images", "library.json"), "invalid original");
  const { app, page } = await launch(home);
  try {
    await expect(tid(page, "rail-chat")).toBeVisible();
    await tid(page, "rail-images").click();
    await expect(page.getByRole("alert")).toContainText("preserved");
    await tid(page, "rail-chat").click();
    await expect(tid(page, "main")).toBeVisible();
    expect(fs.readFileSync(path.join(home, "images", "library.json"), "utf8")).toBe("invalid original");
  } finally { await app.close(); }
});

test("plugin changes are blocked during generation; disabling a skill refuses new jobs", async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  try {
    const context = { runtime: "claude" as const, scope: "user" as const, account: "cli" };
    const cap = await page.evaluate(() => window.modex.invoke("images:bind", { runtime: "claude", account: "cli", pluginId: "modex-fixture", pluginVersion: "1", entrypoint: "modex-fixture", label: "Offline fixture", edit: true }));
    const job = await page.evaluate(capabilityId => window.modex.invoke("imageJobs:submit", { capabilityId, prompt: "Wait for approval", referenceIds: [], requestId: crypto.randomUUID() }), cap.id);
    await expect.poll(() => page.evaluate(() => window.modex.invoke("imageJobs:list", undefined).then(j => j[0]?.status))).toBe("waiting-for-approval");
    const refusal = await page.evaluate(context => window.modex.invoke("plugins:mutate", { context, id: "modex-fixture", action: "disable" }).then(() => "unexpected", err => err.message), context);
    expect(refusal).toContain("finish");
    expect(fs.existsSync(path.join(home, "images", "plugin-revisions.json"))).toBe(false);
    await page.evaluate(id => window.modex.invoke("imageJobs:cancel", { id }), job.id);
    await expect.poll(() => page.evaluate(() => window.modex.invoke("imageJobs:list", undefined).then(j => j[0]?.status))).toBe("cancelled");
    await expect.poll(() => page.evaluate(context => window.modex.invoke("plugins:mutate", { context, id: "modex-fixture", action: "disable" }).then(() => true, () => false), context)).toBe(true);
    await page.evaluate(capabilityId => window.modex.invoke("imageJobs:submit", { capabilityId, prompt: "Cannot run disabled skill", referenceIds: [], requestId: crypto.randomUUID() }), cap.id);
    await expect.poll(() => page.evaluate(() => window.modex.invoke("imageJobs:list", undefined).then(j => j[0]?.error))).toContain("disabled");
  } finally { await app.close(); }
});

for (const mode of ["delayed", "rejected"] as const) test(`ordinary close preserves ${mode} image draft saves`, async () => {
  const { home } = seedHome();
  const { app, page } = await launch(home);
  // Electron owns beforeunload cancellation; CDP must not dismiss its dialog.
  page.on("dialog", dialog => { if (dialog.type() !== "beforeunload") void dialog.dismiss(); });
  try {
    await page.evaluate(() => window.modex.invoke("images:bind", { runtime: "claude", account: "cli", pluginId: "modex-fixture", pluginVersion: "1", entrypoint: "modex-fixture", label: "Offline fixture", edit: true }));
    await tid(page, "rail-images").click();
    await page.getByRole("button", { name: "Generate", exact: true }).click();
    await expect(page.getByLabel("Image prompt", { exact: true })).toBeVisible();
    await app.evaluate(({ ipcMain, BrowserWindow }, mode) => {
      const controls = globalThis as typeof globalThis & {
        imageSaveRelease?: () => void; imageSaveCalls?: number; imageCloseVetoes?: number;
        imageSaveAccepted?: boolean; imageSavedPrompt?: string;
      };
      controls.imageSaveCalls = 0;
      controls.imageCloseVetoes = 0;
      ipcMain.removeHandler("images:saveDraft");
      ipcMain.handle("images:saveDraft", async (_event, draft: { prompt: string }) => {
        controls.imageSaveCalls!++;
        if (!controls.imageSaveAccepted) {
          if (mode === "rejected") throw new Error("Controlled draft save failure");
          await new Promise<void>(resolve => { controls.imageSaveRelease = resolve; });
        }
        controls.imageSavedPrompt = draft.prompt;
      });
      BrowserWindow.getAllWindows()[0]!.webContents.on("will-prevent-unload", () => { controls.imageCloseVetoes!++; });
    }, mode);
    await page.getByLabel("Image prompt", { exact: true }).fill("Keep this unsaved image idea");
    await expect.poll(() => app.evaluate(() => (globalThis as { imageSaveCalls: number }).imageSaveCalls)).toBeGreaterThan(0);
    if (mode === "rejected") await expect(page.getByRole("alert")).toContainText("Controlled draft save failure");
    await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.close(); });
    await expect.poll(() => app.evaluate(() => (globalThis as { imageCloseVetoes: number }).imageCloseVetoes)).toBe(1);
    await expect(page.getByLabel("Image prompt", { exact: true })).toHaveValue("Keep this unsaved image idea");
    await app.evaluate(() => {
      const controls = globalThis as { imageSaveAccepted: boolean; imageSaveRelease?: () => void };
      controls.imageSaveAccepted = true;
      controls.imageSaveRelease?.();
    });
    if (mode === "rejected") {
      // Another normal close retries the failed write and remains vetoed until acknowledgement.
      await app.evaluate(({ BrowserWindow }) => { BrowserWindow.getAllWindows()[0]!.close(); });
    }
    await expect.poll(() => app.evaluate(() => (globalThis as { imageSavedPrompt?: string }).imageSavedPrompt)).toBe("Keep this unsaved image idea");
    await page.getByLabel("Image prompt", { exact: true }).fill("Renderer remains usable after retry");
    await expect.poll(() => app.evaluate(() => (globalThis as { imageSavedPrompt?: string }).imageSavedPrompt)).toBe("Renderer remains usable after retry");
  } finally {
    await app.evaluate(({ BrowserWindow }) => {
      const controls = globalThis as { imageSaveAccepted: boolean; imageSaveRelease?: () => void };
      controls.imageSaveAccepted = true;
      controls.imageSaveRelease?.();
      // Test cleanup must also work when an assertion failed with a dirty draft.
      for (const window of BrowserWindow.getAllWindows()) window.destroy();
    }).catch(() => {});
    await app.close();
  }
});
