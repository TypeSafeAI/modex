import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { launch, seedHome, tid } from "./support";

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

  // Seed state with both projects
  const statePath = path.join(home, "app", "state.json");
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.projects.push({ id: "p2", name: path.basename(repo2), path: repo2, addedAt: new Date().toISOString() });
  fs.writeFileSync(statePath, JSON.stringify(state));

  ({ app, page } = await launch(home));
});

test.afterAll(async () => {
  await app?.close();
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(repo1, { recursive: true, force: true });
  fs.rmSync(repo2, { recursive: true, force: true });
});

test("removing a project replaces its active draft and clears the last project", async () => {
  await expect(tid(page, "sidebar")).toBeVisible();
  const projects = tid(page, "project");
  await expect(projects).toHaveCount(2);

  const p2 = projects.filter({ hasText: path.basename(repo2) });
  await expect(p2).toBeVisible();

  // Open a draft in project 2 and type text
  await p2.hover();
  await tid(p2, "project-new-thread").click();
  await expect(tid(page, "draft-view")).toBeVisible();
  await expect(tid(page, "draft-title")).toContainText(path.basename(repo2));
  await expect(tid(page, "context-project")).toHaveText(path.basename(repo2));
  await tid(page, "composer-input").fill("Unsent draft message in p2");

  // Remove project 2
  page.once("dialog", (d) => void d.accept());
  await p2.hover();
  await tid(p2, "project-menu").click();
  await tid(p2, "project-remove").click();

  // Project 2 is removed from sidebar
  await expect(projects).toHaveCount(1);
  await expect(p2).toHaveCount(0);

  // The draft resets to project 1 instead of showing broken draft for removed project
  await expect(tid(page, "draft-view")).toBeVisible();
  await expect(tid(page, "draft-title")).toContainText(path.basename(repo1));
  await expect(tid(page, "context-project")).toHaveText(path.basename(repo1));
  await expect(page.getByRole("alert")).toHaveCount(0);
  expect(fs.existsSync(repo2)).toBe(true);

  // Remove the last project (project 1)
  const p1 = projects.filter({ hasText: path.basename(repo1) });
  page.once("dialog", (d) => void d.accept());
  await p1.hover();
  await tid(p1, "project-menu").click();
  await tid(p1, "project-remove").click();

  // All projects removed -> EmptyState is rendered immediately
  await expect(tid(page, "project")).toHaveCount(0);
  await expect(tid(page, "empty-open-project")).toBeVisible();
  await expect(tid(page, "draft-view")).toHaveCount(0);
  expect(fs.existsSync(repo1)).toBe(true);
});
