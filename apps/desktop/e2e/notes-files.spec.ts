import { test, expect } from "@playwright/test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, seedHome, tid } from "./support";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

test("files imported into a project are copied into its folder and preview in Space", async () => {
  const { home, repo } = seedHome();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-notes-files-"));
  const img = path.join(dir, "diagram.png");
  const txt = path.join(dir, "readme.txt");
  const bin = path.join(dir, "archive.bin");
  fs.writeFileSync(img, PNG);
  fs.writeFileSync(txt, "plain notes\nsecond line\n");
  fs.writeFileSync(bin, Buffer.from([0, 1, 2, 3]));
  const notes = (...parts: string[]) => path.join(home, "notes", "Personal", "Notes", ...parts);
  const session = await launch(home);
  try {
    const { app, page } = session;
    await app.evaluate(({ dialog }, paths) => { dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: paths })) as typeof dialog.showOpenDialog; }, [img, txt, bin]);
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "Notes actions" }).click();
    await page.getByRole("menuitem", { name: "Import files…" }).click();
    await expect(page.getByRole("button", { name: "Open diagram.png", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Open readme.txt", exact: true })).toBeVisible();
    expect(fs.readFileSync(notes("diagram.png")).equals(PNG)).toBe(true);
    expect(fs.readFileSync(notes("archive.bin")).length).toBe(4);
    expect(fs.existsSync(img)).toBe(true);

    // A second import of the same file keeps both copies.
    await page.getByRole("button", { name: "Notes actions" }).click();
    await page.getByRole("menuitem", { name: "Import files…" }).click();
    await expect.poll(() => fs.existsSync(notes("diagram 2.png"))).toBe(true);

    await page.getByRole("button", { name: "Open diagram.png", exact: true }).click();
    const preview = tid(page, "notes-file-preview");
    await expect(preview.getByRole("img", { name: "diagram.png" })).toBeVisible();
    await expect.poll(() => preview.getByRole("img").evaluate(el => (el as HTMLImageElement).naturalWidth)).toBe(1);
    await preview.getByRole("button", { name: "Close preview" }).click();
    await expect(preview).toHaveCount(0);

    await page.getByRole("button", { name: "Open readme.txt", exact: true }).click();
    await expect(preview.locator("pre")).toHaveText("plain notes\nsecond line\n");
    await page.keyboard.press("Escape");
    await expect(preview).toHaveCount(0);

    await page.getByRole("button", { name: "Open archive.bin", exact: true }).click();
    await expect(preview.getByText("No preview for this kind of file")).toBeVisible();
    await page.keyboard.press("Escape");
  } finally {
    await session.app.close();
    for (const p of [home, repo, dir]) fs.rmSync(p, { recursive: true, force: true });
  }
});
