import { test, expect, _electron as electron } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { appDir, seedHome, tid } from "./support.js";
import { FAKE_GH } from "../test/fixtures/code-review-gh.js";
import type { CodeReviewRequest, Inbox, PrOverview } from "../src/shared/code-review.js";

// #321 AC1: keep production preload, IPC registration, service and subprocess transport.
// Only the gh executable is synthetic; no ipcMain handler replacement or direct service calls.
test("real Electron IPC reads synthetic inbox, distinct PRs and revision-bound files without changing the checkout", async ({}, testInfo) => {
  const { home, repo } = seedHome();
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "gh"), FAKE_GH, { mode: 0o755 });
  const calls = path.join(home, "gh-calls.log");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, encoding: "utf8" });
  const before = { head: git("rev-parse", "HEAD"), branch: git("symbolic-ref", "HEAD"), status: git("status", "--porcelain=v1", "--untracked-files=all") };
  const env = { ...process.env, MODEX_HOME: home, MODEX_NO_LOGIN_PATH: "1", PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
    FAKE_GH_LOG: calls, GH_CONFIG_DIR: path.join(home, "gh-config"), JEV_API_KEY: "", TYPESAFE_API_KEY: "", JEV_CONFIG: path.join(home, "no-jev.json") };
  delete env.MODEX_E2E;
  delete env.MODEX_DEMO;
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  const executablePath = process.env.MODEX_PACKAGED_APP;
  const app = await electron.launch({ executablePath, args: executablePath ? [] : [appDir], cwd: appDir, env });
  const child = app.process();
  const started = Date.now();
  const events: { ms: number; event: string; detail?: unknown }[] = [];
  const record = (event: string, detail?: unknown) => {
    if (events.length < 64) events.push({ ms: Date.now() - started, event, detail });
  };
  let stderr = "";
  const onStderr = (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-8192); };
  child.stderr?.on("data", onStderr);
  child.on("exit", (code, signal) => record("process-exit", { code, signal }));
  child.on("error", error => record("process-error", String(error)));
  app.on("close", () => record("application-close"));
  try {
    const identity = await app.evaluate(({ app }) => ({ executable: process.execPath, packaged: app.isPackaged }));
    expect(identity.packaged).toBe(Boolean(process.env.MODEX_PACKAGED_APP));
    if (process.env.MODEX_PACKAGED_APP) {
      expect(fs.realpathSync(identity.executable)).toBe(fs.realpathSync(process.env.MODEX_PACKAGED_APP));
    }
    const page = await app.firstWindow();
    page.on("crash", () => record("page-crash"));
    page.on("close", () => record("page-close"));
    await page.waitForLoadState("domcontentloaded");
    const invoke = (request: CodeReviewRequest) => page.evaluate(request => window.modex!.invoke("code-review:read", request), request);
    const connection = await invoke({ op: "connection", requestId: "connection" });
    expect(connection?.result.state).toBe("ready");
    expect(connection?.scope.account).toBe("1001");
    const inbox = await invoke({ op: "inbox", requestId: "inbox", query: "" });
    expect(inbox?.result.state).toBe("ready");
    if (inbox?.result.state !== "ready") throw new Error("Expected ready inbox");
    const groups = (inbox.result.value as Inbox).groups;
    const authored = groups.authored, requested = groups["review-requested"];
    if (authored.state !== "ready" || requested.state !== "ready") throw new Error("Expected ready groups");
    const lending = authored.value[0]!, field = requested.value[0]!;
    expect([lending.key.repoId, lending.key.number, field.key.repoId, field.key.number]).toEqual(["7301", 73, "7302", 73]);
    const overview = await invoke({ op: "overview", requestId: "lending", key: lending.key });
    expect(overview?.result.state).toBe("ready");
    if (overview?.result.state !== "ready") throw new Error("Expected ready overview");
    const revision = (overview.result.value as PrOverview).revision;
    expect(revision).toEqual({ baseRef: "main", baseSha: "b".repeat(40), headSha: "c".repeat(40) });
    const other = await invoke({ op: "overview", requestId: "field", key: field.key });
    expect(other?.result.state === "ready" && (other.result.value as PrOverview).title).toBe("Move the field notes index");
    const files = await invoke({ op: "files", requestId: "files", key: lending.key, revision, cursor: null });
    expect(files?.scope).toEqual({ account: "1001", key: lending.key, revision });
    expect(files?.result).toMatchObject({ state: "ready", value: { files: [
      { path: "src/holds/move.ts", patch: { kind: "text" } }, { path: "assets/shelf.png", patch: { kind: "omitted" } },
    ] } });
    // CR-5: drive the populated Changes pane through the production read path too.
    await page.evaluate(() => localStorage.setItem("modex.codeReview", "on"));
    await page.reload();
    await tid(page, "rail-code-review").click();
    await page.locator('[data-testid="code-review-row"][data-pr="example-org/lending#73"]').click();
    await tid(page, "code-review-tab-changes").click();
    await expect(tid(page, "cr-file-section")).toHaveCount(2);
    await expect(tid(page, "cr-file-section").first()).toHaveAttribute("data-head-sha", revision.headSha);
    await expect(tid(page, "cr-file-section").last()).toContainText("No text diff");
    await tid(page, "cr-file-section").first().getByRole("button", { name: /Expand.*unchanged lines below/ }).click();
    await expect(page.locator('[data-old-line="2"][data-new-line="4"]')).toContainText("remote unchanged four");
    const foreign = await invoke({ op: "overview", requestId: "foreign", key: { ...lending.key, account: "2002" } });
    expect(foreign?.result).toMatchObject({ state: "unavailable", reason: "signed-out" });
    await expect(invoke({ op: "overview", requestId: "invalid", key: { ...lending.key, number: 0 } })).rejects.toThrow(/Invalid Code Review request/);
    const endpoints = fs.readFileSync(calls, "utf8").trim().split("\n");
    expect(endpoints).toContain("repos/example-org/lending/pulls/73/files?per_page=100&page=1");
    expect(endpoints).toContain(`repos/example-org/lending/contents/src/holds/move.ts?ref=${revision.headSha}`);
    // CR-4 starts these read-only requests when the populated overview mounts. This fixture
    // intentionally returns 404 for their data; permit only the exact scoped endpoints.
    const overviewReads = new Set([
      `repos/example-org/lending/commits/${revision.headSha}/check-runs?per_page=100&page=1`,
      "repos/example-org/lending/issues/73/timeline?per_page=100&page=1",
      "repos/example-org/lending/pulls?state=open&per_page=100&page=1",
    ]);
    expect(endpoints.filter(endpoint => !overviewReads.has(endpoint) && !/^repos\/example-org\/lending\/compare\/b{40}\.\.\.c{40}\?per_page=1&page=1$/.test(endpoint) && !/^(user|search\/issues\?.+|repos\/example-org\/(lending|field-guide)(\/pulls\/73(\/files\?per_page=100&page=1)?|\/contents\/src\/holds\/move\.ts\?ref=c{40})?)$/.test(endpoint))).toEqual([]);
    expect({ head: git("rev-parse", "HEAD"), branch: git("symbolic-ref", "HEAD"), status: git("status", "--porcelain=v1", "--untracked-files=all") }).toEqual(before);
  } finally {
    record("cleanup-start");
    try {
      await testInfo.attach("electron-lifecycle-before-cleanup", {
        body: Buffer.from(JSON.stringify({ pid: child.pid, exitCode: child.exitCode, signalCode: child.signalCode, events, stderr }, null, 2)),
        contentType: "application/json",
      });
    } finally {
      await app.close();
      child.stderr?.removeListener("data", onStderr);
    }
  }
});
