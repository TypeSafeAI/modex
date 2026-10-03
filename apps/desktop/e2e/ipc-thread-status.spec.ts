import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, seedHome, tid, items } from "./support";

let app: ElectronApplication;
let page: Page;
let home: string;
let repo1: string;
let repo2: string;

test.beforeAll(async () => {
  ({ home, repo: repo1 } = seedHome());
  repo2 = fs.mkdtempSync(path.join(os.tmpdir(), "modex-e2e-repo2-"));
  const env = { ...process.env, GIT_AUTHOR_NAME: "e2e", GIT_AUTHOR_EMAIL: "e2e@modex.local", GIT_COMMITTER_NAME: "e2e", GIT_COMMITTER_EMAIL: "e2e@modex.local" };
  fs.writeFileSync(path.join(repo2, "package.json"), JSON.stringify({ name: "e2e-repo2", private: true }, null, 2) + "\n");
  fs.writeFileSync(path.join(repo2, "README.md"), "# repo2\n");
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo2, env });
  execFileSync("git", ["add", "."], { cwd: repo2, env });
  execFileSync("git", ["-c", "commit.gpgsign=false", "commit", "-q", "-m", "baseline"], { cwd: repo2, env });

  // Seed state with two projects and two threads in project 1
  const statePath = path.join(home, "app", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.projects.push({ id: "p2", name: path.basename(repo2), path: repo2, addedAt: new Date().toISOString() });
  state.threads.push(
    {
      id: "t1",
      projectId: "p1",
      title: "Active Thread",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cwd: repo1,
      backend: "mock",
      mode: "chat",
      plan: false,
      model: "mock",
      status: "idle",
    },
    {
      id: "t2",
      projectId: "p1",
      title: "Sibling Thread",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      cwd: repo1,
      backend: "mock",
      mode: "chat",
      plan: false,
      model: "mock",
      status: "idle",
    },
  );
  fs.writeFileSync(statePath, JSON.stringify(state));

  ({ app, page } = await launch(home));
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo1, { recursive: true, force: true });
  fs.rmSync(repo2, { recursive: true, force: true });
});

test("thread:delete and project:remove preserve live status of remaining active threads", async () => {
  // Select t1 and send a prompt so it enters the waiting approval turn
  const row1 = page.locator('[data-testid="thread-row"][data-thread-id="t1"]');
  await expect(row1).toBeVisible();
  await row1.click();

  await tid(page, "composer-input").fill("Add a CONTRIBUTING.md file");
  await page.keyboard.press("Meta+Enter");

  // Wait until t1 is waiting for approval
  const card = items(page, "approval").first();
  await expect(card).toBeVisible();
  await expect(row1).toHaveAttribute("data-status", "waiting");

  // Now delete sibling thread t2 via IPC and verify returned state preserves t1's status as "waiting"
  const deleteResult = await page.evaluate(async () => {
    return window.modex!.invoke("thread:delete", { threadId: "t2" });
  });

  const t1InDeleteResult = deleteResult.threads.find((t) => t.id === "t1");
  expect(t1InDeleteResult?.status).toBe("waiting");

  // In the UI, row1 should still have data-status="waiting", not reset to "idle"
  await expect(row1).toHaveAttribute("data-status", "waiting");

  // Now remove project p2 via IPC and verify returned state preserves t1's status as "waiting"
  const removeResult = await page.evaluate(async () => {
    return window.modex!.invoke("project:remove", { projectId: "p2" });
  });

  const t1InRemoveResult = removeResult.threads.find((t) => t.id === "t1");
  expect(t1InRemoveResult?.status).toBe("waiting");

  // In the UI, row1 still maintains data-status="waiting"
  await expect(row1).toHaveAttribute("data-status", "waiting");

  // Finally approve to clean up turn cleanly
  await card.getByRole("button", { name: "Approve" }).click();
  await expect(row1).toHaveAttribute("data-status", "idle");
});
