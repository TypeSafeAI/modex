import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { appDir, launch, seedHome, tid, items } from "./target-support";
import { longTranscript } from "./history-fixture";

import { root, sourceHead, driverHead, driverRoot, manifest, verifySource } from "./source-guard";
for (let replicate = 1; replicate <= 3; replicate++) {
  test(`three-history natural-GC observations replicate ${replicate}`, async () => {
    const { home, repo } = seedHome();
    const receipt = path.join(root, `history-${replicate}.json`);
    expect(fs.existsSync(receipt)).toBe(false);
    fs.writeFileSync(receipt, JSON.stringify({ state: "fixture-seeded", sourceHead, sourceRole: manifest.role, fixture: { home, repo }, at: new Date().toISOString() }, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    const now = new Date().toISOString();
    const ids = ["history-a", "history-b", "history-c"];
    const files = ids.map(id => path.join(home, "app", "threads", id + ".json"));
    const digest = (file: string) => crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    for (const [index, id] of ids.entries()) {
      const saved = longTranscript(id);
      saved[0]!.text = `Distinct history ${id}: tidy module group ${index}.`;
      fs.writeFileSync(files[index]!, JSON.stringify(saved));
    }
    const beforeHashes = files.map(digest);
    const statePath = path.join(home, "app", "state.json");
    const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
    state.threads = ids.map(id => ({ id, projectId: "p1", title: id, titleSource: "manual", createdAt: now, updatedAt: now, cwd: repo, backend: "codex", mode: "chat", plan: false, model: "", status: "idle" }));
    fs.writeFileSync(statePath, JSON.stringify(state));
    const out: Record<string, any> = { diagnosticDriverHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: driverRoot, encoding: "utf8" }).trim(), sourceHead, sourceRole: manifest.role, fixture: { home, repo }, replicate, startedAt: now, state: "started", samples: [],
      workload: { histories: 3, shape: "200 turns/1400 items each; distinct thread provenance and first request, otherwise same deterministic shape", warmupOpens: 3, measuredOpens: 63, opensPerHistory: 21, savedBytes: files.map(f => fs.statSync(f).size), savedSha256: beforeHashes },
      host: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryBytes: os.totalmem(), release: os.release(), arch: os.arch(), node: process.version, loadAverage: os.loadavg() },
      instrumentation: "Renderer forced GC only after three-history warmup and at final detached endpoint. All 63 per-open samples and timed post-detach observations are natural-GC snapshots. Main always natural GC. Two RAF plus positive last-answer/nondeferred checks are a sampling point, not exhaustive async settlement. Trace off. No latency/memory-ceiling/leak-freedom or historical-improvement claim." };
    expect(out.diagnosticDriverHead).toBe(driverHead);
    const persist = () => fs.writeFileSync(receipt, JSON.stringify(out, null, 2) + "\n"); persist();
    let opened: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      out.sourceVerification = verifySource();
      expect(appDir).toBe(manifest.appDir);
      opened = await launch(home);
      const { app, page } = opened;
      const cdp = await page.context().newCDPSession(page);
      out.native = await app.evaluate(({ app, BrowserWindow }) => ({ appVersion: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome, mainPid: process.pid, executablePath: process.execPath, appPath: app.getAppPath(), userData: app.getPath("userData"), rendererPids: BrowserWindow.getAllWindows().map(w => w.webContents.getOSProcessId()) }));
      expect(out.native.appPath).toBe(manifest.appDir); expect(out.native.appVersion).toBe(manifest.appVersion);
      out.document = await page.evaluate(() => location.href); expect(out.document).toBe(pathToFileURL(path.join(appDir, "dist/renderer/index.html")).href);
      const observe = async (phase: string, forcedGc = false) => {
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        if (forcedGc) await cdp.send("HeapProfiler.collectGarbage");
        const heap = await cdp.send("Runtime.getHeapUsage");
        const dom = await cdp.send("Memory.getDOMCounters");
        const main = await app.evaluate(async ({ app }) => ({ pid: process.pid, node: process.memoryUsage(), nativeKiB: await process.getProcessMemoryInfo(), metrics: app.getAppMetrics() }));
        return { at: new Date().toISOString(), phase, forcedGc, heap, dom, main, renderedItems: await items(page).count(), selectedThreadIds: await page.locator('[data-testid="thread-row"][aria-current="true"]').evaluateAll(rows => rows.map(row => row.getAttribute("data-thread-id"))) };
      };
      const detach = async () => { await page.keyboard.press("Meta+n"); await expect(tid(page, "draft-view")).toBeVisible(); return Date.now(); };
      const open = async (id: string) => {
        await detach();
        const row = page.locator(`[data-testid="thread-row"][data-thread-id="${id}"]`);
        await row.getByRole("button", { name: id, exact: true }).click();
        await expect(row).toHaveAttribute("aria-current", "true");
        await expect(items(page, "user").first()).toContainText(`Distinct history ${id}:`);
        const last = items(page, "assistant").last();
        await expect(last).toContainText("Answer 199.");
        await expect(last.locator("[data-markdown-deferred]")).toHaveCount(0);
        await expect(items(page)).toHaveCount(1400);
      };
      out.cold = await observe("cold draft natural");
      for (const id of ids) await open(id);
      await detach();
      out.warmDetachedBefore = await observe("after warming all three histories, detached", true); persist();
      for (let index = 0; index < 63; index++) {
        const id = ids[index % ids.length]!;
        await open(id);
        out.samples.push({ history: id, open: index + 1, ...await observe(`natural open ${index + 1}`) }); persist();
      }
      const detachedAt = await detach();
      out.detachTimeOrigin = "draft-view positively observed, before immediate measurement";
      out.detachedNatural = await observe("detached, immediate natural"); persist();
      out.detachedTimedNatural = [];
      for (const intervalMs of [1000, 5000]) {
        // A declared measurement time point, not a readiness wait or retry.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, detachedAt + intervalMs - Date.now())));
        out.detachedTimedNatural.push({ requestedAfterDetachMs: intervalMs, actualAfterDetachMs: Date.now() - detachedAt, ...await observe(`detached natural +${intervalMs}ms`) }); persist();
      }
      out.warmDetachedAfter = await observe("final warm detached endpoint", true);
      out.savedAfterSha256 = files.map(digest); expect(out.savedAfterSha256).toEqual(beforeHashes);
      expect(out.samples).toHaveLength(63); expect(out.samples.every((s: any) => !s.forcedGc && s.renderedItems === 1400 && s.selectedThreadIds.length === 1 && s.selectedThreadIds[0] === s.history)).toBe(true);
      expect(out.warmDetachedBefore.renderedItems).toBe(0); expect(out.warmDetachedAfter.renderedItems).toBe(0);
      out.state = "observations-complete"; persist();
    } catch (error) { out.state = "failed"; out.failure = String(error); persist(); throw error; }
    finally {
      try { if (opened) { await opened.app.close(); out.appClose = "returned"; } else out.appClose = "launch returned no app handle"; }
      catch (error) { out.appClose = "failed"; out.closeError = String(error); throw error; }
      finally { out.finishedAt = new Date().toISOString(); persist(); }
    }
  });
}
