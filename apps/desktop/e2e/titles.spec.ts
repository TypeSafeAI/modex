import { test, expect, type ElectronApplication, type Page } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { appDir, currentRow, items, launch, seedHome, tid } from "./support";

for (const backend of ["claude", "codex"] as const) test.describe(`${backend} chat titles`, () => {
  let app: ElectronApplication;
  let page: Page;
  let home: string;
  let repo: string;
  const opening = "Please fix the login redirect issue";

  test.beforeEach(async () => {
    ({ home, repo } = seedHome({ default_backend: backend }));
    const cli = path.join(home, `${backend}-title-fixture.cjs`);
    fs.writeFileSync(cli, `#!${process.execPath}\n` + fs.readFileSync(path.join(appDir, "e2e/fixtures/title-cli.cjs"), "utf8"), { mode: 0o755 });
    const file = path.join(home, "app/state.json");
    const state = JSON.parse(fs.readFileSync(file, "utf8"));
    state.settings[`${backend}_bin`] = cli;
    fs.writeFileSync(file, JSON.stringify(state));
    ({ app, page } = await launch(home));
  });

  test.afterEach(async () => {
    await app?.close();
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(repo, { recursive: true, force: true });
  });

  async function start() {
    await tid(page, "composer-input").fill(opening);
    await page.keyboard.press("Meta+Enter");
    await expect(items(page, "assistant")).toContainText("Fixed cookie path handling.");
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect.poll(() => fs.existsSync(path.join(home, "title-request.json"))).toBe(true);
    await expect(tid(page, "thread-title")).toHaveValue(opening);
  }

  function respond(title: string, fail = false) {
    const file = path.join(home, "title-response.json");
    // The fixture polls for this file; publish only complete JSON.
    fs.writeFileSync(`${file}.pending`, JSON.stringify({ title, fail }));
    fs.renameSync(`${file}.pending`, file);
  }

  test("a completed reply produces a clean sidebar title that survives relaunch without polluting the transcript", async () => {
    await start();
    const request = JSON.parse(fs.readFileSync(path.join(home, "title-request.json"), "utf8"));
    expect(request.text).toContain('"openingMessage":"Please fix the login redirect issue"');
    expect(request.text).toContain('"completedReply":"Fixed cookie path handling."');
    expect(request.cwd).not.toBe(repo);
    expect(request.argv).not.toContain("--resume");
    respond('“Fix   cookie path handling.”');
    await expect(tid(page, "thread-title")).toHaveValue("Fix cookie path handling");
    await expect(tid(currentRow(page), "thread-row-title")).toHaveText("Fix cookie path handling");
    await expect(items(page, "user")).toHaveCount(1);
    await expect(items(page, "assistant")).toHaveCount(1);

    await app.close();
    const saved = JSON.parse(fs.readFileSync(path.join(home, "app/state.json"), "utf8"));
    expect(saved.threads[0].sessionHandle).toBe(backend === "claude" ? "coding-session" : "thread-1");
    ({ app, page } = await launch(home));
    await expect(tid(page, "thread-title")).toHaveValue("Fix cookie path handling");
    await tid(page, "composer-input").fill("Add a regression test too");
    await page.keyboard.press("Meta+Enter");
    await expect(items(page, "assistant")).toHaveCount(2);
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect(tid(page, "thread-title")).toHaveValue("Fix cookie path handling");
    const calls = fs.readFileSync(path.join(home, "title-calls.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(calls.filter((call) => call.naming)).toHaveLength(1);
  });

  test("a manual rename cancels pending naming and survives relaunch", async () => {
    await start();
    const title = tid(page, "thread-title");
    await title.dblclick();
    await title.fill("My login investigation");
    await title.press("Enter");
    await expect.poll(() => fs.existsSync(path.join(home, "title-cancelled"))).toBe(true);
    respond("Unwanted generated title");
    await expect(title).toHaveValue("My login investigation");
    await app.close();
    ({ app, page } = await launch(home));
    await expect(tid(page, "thread-title")).toHaveValue("My login investigation");
  });

  for (const fail of [false, true]) test(fail ? "provider failure keeps the fallback" : "malformed provider output keeps the fallback", async () => {
    await start();
    respond(fail ? "Unavailable" : "**Fix login redirects**", fail);
    await expect.poll(() => fs.existsSync(path.join(home, "title-finished"))).toBe(true);
    await app.close(); // Drains naming, so fallback assertions cannot pass before validation finishes.
    ({ app, page } = await launch(home));
    await expect(tid(page, "thread-title")).toHaveValue(opening);
    await expect(currentRow(page)).toHaveAttribute("data-status", "idle");
    await expect(items(page, "notice")).toHaveCount(0);
  });
});
