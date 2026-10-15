import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid } from "./support";

test("workspaces, projects and folders made in Space are folders on disk, and persist", async () => {
  const { home, repo } = seedHome();
  const notes = (...parts: string[]) => path.join(home, "notes", ...parts);
  let session = await launch(home);
  try {
    const { page } = session;
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "Space options" }).click();
    await page.getByRole("menuitem", { name: "New workspace" }).click();
    await page.getByRole("textbox", { name: "New workspace name" }).fill("TypeSafeAI");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "TypeSafeAI", exact: true })).toBeVisible();
    expect(fs.existsSync(notes("TypeSafeAI", ".modex-workspace.json"))).toBe(true);

    // New child actions must expose their editor even when the container is collapsed.
    await page.getByRole("button", { name: "TypeSafeAI", exact: true }).click();
    await expect(page.getByRole("button", { name: "TypeSafeAI", exact: true })).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "TypeSafeAI actions" }).click();
    await page.getByRole("menuitem", { name: "New project" }).click();
    await page.getByRole("textbox", { name: "New project name" }).fill("modex");
    await page.keyboard.press("Enter");
    await page.getByRole("button", { name: "modex", exact: true }).click();
    await expect(page.getByRole("button", { name: "modex", exact: true })).toHaveAttribute("aria-expanded", "false");
    await page.getByRole("button", { name: "modex actions" }).click();
    await page.getByRole("menuitem", { name: "New folder" }).click();
    await page.getByRole("textbox", { name: "New folder name" }).fill("Design");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Design", exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Design actions" }).click();
    await page.getByRole("menuitem", { name: "New page" }).click();
    await page.getByRole("textbox", { name: "Page title" }).fill("Spec");
    await page.getByRole("textbox", { name: "Page title" }).blur();
    await expect.poll(() => fs.existsSync(notes("TypeSafeAI", "modex", "Design", "Spec.md"))).toBe(true);

    await page.getByRole("button", { name: "Design actions" }).click();
    await page.getByRole("menuitem", { name: "Rename" }).click();
    await page.getByRole("textbox", { name: "Rename Design" }).fill("Designs");
    await page.keyboard.press("Enter");
    await expect.poll(() => fs.existsSync(notes("TypeSafeAI", "modex", "Designs", "Spec.md"))).toBe(true);

    await page.getByRole("button", { name: "Spec actions" }).click();
    await page.getByRole("menuitem", { name: "Personal › Notes" }).click();
    await expect.poll(() => fs.existsSync(notes("Personal", "Notes", "Spec.md"))).toBe(true);
    await expect(page.getByRole("textbox", { name: "Page title" })).toHaveValue("Spec");
  } finally { await session.app.close(); }
  session = await launch(home);
  try {
    await tid(session.page, "rail-space").click();
    await expect(session.page.getByRole("button", { name: "TypeSafeAI", exact: true })).toBeVisible();
    await expect(session.page.getByRole("button", { name: "Designs", exact: true })).toBeVisible();
    await expect(session.page.getByRole("button", { name: "Open Spec", exact: true })).toBeVisible();
  } finally {
    await session.app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
