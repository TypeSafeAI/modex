import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid } from "./support";

test("each project has notes, and a second workspace groups the sidebar's projects", async () => {
  const { home, repo } = seedHome();
  const project = path.basename(repo);
  const { app, page } = await launch(home);
  page.on("dialog", dialog => void dialog.accept());
  try {
    // One workspace: the sidebar is the flat list it always was.
    await expect(tid(page, "project")).toHaveCount(1);
    await expect(tid(page, "workspace-group")).toHaveCount(0);
    await expect.poll(() => fs.existsSync(path.join(home, "notes", "Personal", project, ".modex-project.json"))).toBe(true);

    await tid(page, "project-menu").click();
    await tid(page, "project-notes").click();
    await expect(tid(page, "space")).toBeVisible();
    await expect(page.getByRole("button", { name: project, exact: true })).toBeVisible();

    await page.getByRole("button", { name: "Space options" }).click();
    await page.getByRole("menuitem", { name: "New workspace" }).click();
    await page.getByRole("textbox", { name: "New workspace name" }).fill("Clients");
    await page.keyboard.press("Enter");
    await expect(page.getByRole("button", { name: "Clients", exact: true })).toBeVisible();

    await tid(page, "rail-chat").click();
    await tid(page, "project-menu").click();
    await page.getByRole("menuitem", { name: "Move to Clients" }).click();
    await expect(tid(page, "workspace-group")).toHaveCount(1);
    await expect(tid(page, "workspace-group")).toHaveAccessibleName("Clients");
    await expect(tid(page, "workspace-group").locator('[data-testid="project"]')).toHaveCount(1);
    expect(fs.existsSync(path.join(home, "notes", "Clients", project, ".modex-project.json"))).toBe(true);

    await tid(page, "workspace-toggle").click();
    await expect(tid(page, "project")).toHaveCount(0);
    await tid(page, "workspace-toggle").click();
    await expect(tid(page, "project")).toHaveCount(1);

    // Removing the project keeps its notes, unlinked.
    await tid(page, "project-menu").click();
    await tid(page, "project-remove").click();
    await expect(tid(page, "project")).toHaveCount(0);
    const marker = JSON.parse(fs.readFileSync(path.join(home, "notes", "Clients", project, ".modex-project.json"), "utf8"));
    expect(marker.modexProjectId).toBeNull();
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
