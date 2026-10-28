import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launch, seedHome, tid } from "./support";
import { savedNotes } from "./notes-support";

const at = "2026-10-01T09:00:00.000Z";
const legacyPage = (id: string, parentId: string | null, title: string, markdown: string) =>
  ({ id, parentId, title, markdown, favorite: false, createdAt: at, updatedAt: at, trashedAt: null, revision: 1 });

test("existing Space pages move into the notes folder once, with their history, and space.json stays as it was", async () => {
  const { home, repo } = seedHome();
  const pages = [legacyPage("plan-1", null, "Plan", "# Plan"), legacyPage("child-1", "plan-1", "Child", "Inside the plan")];
  const legacy = path.join(home, "app", "space.json");
  fs.writeFileSync(legacy, JSON.stringify({ version: 2, pages, history: pages.map(page => ({ page, actor: "human", summary: "Created page" })), comments: [] }));
  const before = fs.readFileSync(legacy, "utf8");
  let session = await launch(home);
  try {
    await tid(session.page, "rail-space").click();
    await session.page.getByRole("button", { name: "Open Child", exact: true }).click();
    await expect(session.page.getByRole("textbox", { name: "Page title" })).toHaveValue("Child");
    await expect(session.page.getByText("Inside the plan", { exact: true })).toBeVisible();
    await session.page.getByRole("button", { name: "Page actions" }).click();
    await session.page.getByRole("menuitem", { name: "Version history" }).click();
    await expect(session.page.getByText("Revision 1 · You · Created page", { exact: true })).toBeVisible();
    const history = session.page.getByRole("region", { name: "Version history", exact: true });
    for (let cycle = 0; cycle < 3; cycle++) {
      await expect(history).toHaveCount(1);
      await expect(history.locator("summary")).toHaveCount(1);
      await expect(history.locator("summary")).toHaveText("Revision 1 · You · Created page");
      await session.page.getByRole("button", { name: "Close history", exact: true }).click();
      await expect(history).toHaveCount(0);
      await expect(session.page.getByRole("textbox", { name: "Page title" })).toHaveValue("Child");
      await expect(session.page.getByText("Inside the plan", { exact: true })).toBeVisible();
      await session.page.getByRole("button", { name: "Version history", exact: true }).click();
    }
    await expect(history).toHaveCount(1);
    await expect(history.locator("summary")).toHaveCount(1);
    expect(savedNotes(home).map(note => [note.rel, note.id])).toEqual([["Personal/Notes/Plan/Child.md", "child-1"], ["Personal/Notes/Plan/Plan.md", "plan-1"]]);
  } finally { await session.app.close(); }
  session = await launch(home);
  try {
    const listed = await session.page.evaluate(() => window.modex!.invoke("space:list", undefined));
    expect(listed.map(page => [page.id, page.parentId]).sort()).toEqual([["child-1", "plan-1"], ["plan-1", null]]);
    expect(fs.readFileSync(legacy, "utf8")).toBe(before);
    expect(fs.readdirSync(path.join(home, "app")).filter(name => name.startsWith("space.json.pre-notes-"))).toHaveLength(1);
  } finally {
    await session.app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test("an edit made outside Modex shows in Space and in the page's history", async () => {
  const { home, repo } = seedHome();
  const { app, page } = await launch(home);
  try {
    await tid(page, "rail-space").click();
    await page.getByRole("button", { name: "New page", exact: true }).click();
    await page.getByRole("textbox", { name: "Page title" }).fill("Outside");
    await page.getByRole("textbox", { name: "Block 1" }).fill("Written in Modex");
    await expect(page.getByRole("status", { name: "Save status" })).toHaveText("Saved locally");
    await page.getByRole("textbox", { name: "Page title" }).click();
    await page.getByRole("textbox", { name: "Page title" }).blur();
    await expect.poll(() => savedNotes(home).find(note => note.title === "Outside")?.rel).toBe("Personal/Notes/Outside.md");
    const file = path.join(home, "notes", "Personal", "Notes", "Outside.md");
    fs.writeFileSync(file, fs.readFileSync(file, "utf8").replace("Written in Modex", "Edited in another editor"));
    await expect(page.getByText("Edited in another editor", { exact: true })).toBeVisible({ timeout: 15_000 });
    await page.getByRole("button", { name: "Page actions" }).click();
    await page.getByRole("menuitem", { name: "Version history" }).click();
    await expect(page.getByText(/Revision \d+ · Outside Modex · Edited outside Modex/)).toBeVisible();
  } finally {
    await app.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
