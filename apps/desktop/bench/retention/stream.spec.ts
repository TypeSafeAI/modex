import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { appDir, launch, seedHome, tid, items } from "./target-support";
import { fakeCodex, CHUNK, CHUNKS, PREVIEW } from "./log-fixture";

import { root, sourceHead, driverHead, driverRoot, manifest, legacy, verifySource } from "./source-guard";
for (let replicate = 1; replicate <= 3; replicate++) {
  test(`repeated synthetic log streaming memory replicate ${replicate}`, async () => {
    const { home, repo } = seedHome({ default_backend: "codex" });
    const callLog = path.join(home, "stream-calls.jsonl"); fs.writeFileSync(callLog, "", { flag: "wx" });
    const cli = fakeCodex(home);
    const retainedCli = path.join(root, `stream-${replicate}-cli.cjs`);
    fs.copyFileSync(cli, retainedCli, fs.constants.COPYFILE_EXCL);
    const stateFile = path.join(home, "app", "state.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8")); state.settings.codex_bin = cli; fs.writeFileSync(stateFile, JSON.stringify(state));
    const calls = (): any[] => fs.readFileSync(callLog, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
    const out: Record<string, any> = { startedAt: new Date().toISOString(), diagnosticDriverHead: execFileSync("git", ["rev-parse", "HEAD"], { cwd: driverRoot, encoding: "utf8" }).trim(), sourceHead, sourceRole: manifest.role, replicate, state: "started", samples: [],
      workload: { warmupStreams: 1, measuredStreams: 21, bytesPerStream: Buffer.byteLength(CHUNK) * CHUNKS, deltasPerStream: CHUNKS, deltaSpacingMs: 10, openedPreviewBytes: legacy ? null : PREVIEW, expectedLegacyOutputViolation: legacy },
      fixture: { scriptSha256: crypto.createHash("sha256").update(fs.readFileSync(cli)).digest("hex"), retainedScript: retainedCli, synthetic: true },
      host: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryBytes: os.totalmem(), release: os.release(), arch: os.arch(), node: process.version, loadAverage: os.loadavg() },
      instrumentation: "Existing synthetic native-CLI fixture, no real inference or emitted command execution. Per-thread main IPC observer calls original send. All per-stream renderer/main memory samples natural; renderer GC only matched warm detached before/after endpoints. Timed detached natural samples at declared1s/5s. Two RAF sampling is not exhaustive settlement. No latency/memory-ceiling/leak-freedom/historical improvement or fullCF8 acceptance claim. Trace off." };
    const receipt = path.join(root, `stream-${replicate}.json`); expect(fs.existsSync(receipt)).toBe(false); expect(out.diagnosticDriverHead).toBe(driverHead);
    const persist = () => fs.writeFileSync(receipt, JSON.stringify(out, null, 2) + "\n"); persist();
    let opened: Awaited<ReturnType<typeof launch>> | undefined;
    try {
      out.sourceVerification = verifySource();
      opened = await launch(home); const { app, page } = opened;
      const cdp = await page.context().newCDPSession(page);
      out.native = await app.evaluate(({ app, BrowserWindow }) => ({ appVersion: app.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome, mainPid: process.pid, executablePath: process.execPath, appPath: app.getAppPath(), userData: app.getPath("userData"), rendererPids: BrowserWindow.getAllWindows().map(w => w.webContents.getOSProcessId()) }));
      expect(out.native.appPath).toBe(appDir); expect(out.native.appVersion).toBe(manifest.appVersion); out.document = await page.evaluate(() => location.href); expect(out.document).toBe(pathToFileURL(path.join(appDir, "dist/renderer/index.html")).href);
      await app.evaluate(({ BrowserWindow }) => {
        const g = globalThis as any; g.__streamMemory = { byThread: {} };
        const contents = BrowserWindow.getAllWindows()[0]!.webContents; const original = contents.send.bind(contents);
        contents.send = (channel: string, ...args: unknown[]) => {
          if (channel === "thread:event") {
            const event = args[0] as any;
            const m = g.__streamMemory.byThread[event.threadId] ??= { bytes: 0, events: 0, largestEvent: 0, largestOutput: 0, first: 0, idle: 0 };
            const size = Buffer.byteLength(JSON.stringify(event)); m.bytes += size; m.events++; m.largestEvent = Math.max(m.largestEvent, size);
            const output = event.item?.output ?? event.patch?.output;
            if (typeof output === "string") m.largestOutput = Math.max(m.largestOutput, Buffer.byteLength(output));
            if (!m.first && (event.type === "item" || event.type === "item_update")) m.first = performance.now();
            if (event.type === "status" && event.status === "idle" && m.first && !m.idle) m.idle = performance.now();
          }
          return original(channel, ...args);
        };
      });
      const observe = async (phase: string, forcedGc = false) => {
        await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
        if (forcedGc) await cdp.send("HeapProfiler.collectGarbage");
        return { at: new Date().toISOString(), phase, forcedGc, heap: await cdp.send("Runtime.getHeapUsage"), dom: await cdp.send("Memory.getDOMCounters"),
          main: await app.evaluate(async ({ app }) => ({ pid: process.pid, node: process.memoryUsage(), nativeKiB: await process.getProcessMemoryInfo(), metrics: app.getAppMetrics() })),
          renderedItems: await items(page).count(), selectedThreadIds: await page.locator('[data-testid="thread-row"][aria-current="true"]').evaluateAll(rows => rows.map(row => row.getAttribute("data-thread-id"))) };
      };
      const detach = async () => { await page.keyboard.press("Meta+n"); await expect(tid(page, "draft-view")).toBeVisible(); return Date.now(); };
      const stream = async (cycle: number) => {
        await detach(); const beforeIds = await page.evaluate(async () => (await window.modex!.invoke("state:get", undefined)).threads.map(t => t.id));
        const marker = `Print a long log for private memory cycle ${cycle}`;
        await tid(page, "composer-input").fill(marker); const sentAt = Date.now(); await page.keyboard.press("Meta+Enter");
        await expect(items(page, "user").first()).toContainText(marker); await expect(items(page, "assistant").last()).toContainText("Streamed the log.", { timeout: 60000 });
        const selected = page.locator('[data-testid="thread-row"][aria-current="true"]'); await expect(selected).toHaveCount(1);
        const threadId = await selected.getAttribute("data-thread-id"); expect(threadId).toBeTruthy(); expect(beforeIds).not.toContain(threadId);
        await expect.poll(() => app.evaluate(({}, id) => (globalThis as any).__streamMemory.byThread[id!]?.idle ?? 0, threadId)).toBeGreaterThan(0);
        const main = await app.evaluate(({}, id) => ({ ...(globalThis as any).__streamMemory.byThread[id!] }), threadId);
        if (legacy) {
          expect(main.largestOutput).toBe(Buffer.byteLength(CHUNK) * CHUNKS);
          expect(main.largestOutput).toBeGreaterThan(PREVIEW);
        } else {
          expect(main.largestOutput).toBeLessThanOrEqual(PREVIEW); expect(main.bytes).toBeLessThan(CHUNKS * (PREVIEW + 4096));
        }
        await tid(page, "turn-label").last().click(); const tool = items(page, "tool").filter({ hasText: "yes | head" }); await expect(tool).toHaveCount(1);
        await tid(tool, "item-toggle").click();
        let renderedOutputAsciiBytes: number | undefined;
        if (legacy) {
          await expect(tid(tool, "tool-output")).toBeVisible(); await expect(tid(tool, "tool-truncated")).toHaveCount(0);
          // Retained legacy-only shallow read: avoid copying/encoding its full ASCII string.
          renderedOutputAsciiBytes = await tid(tool, "tool-output").evaluate(el => {
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT); let size = 0;
            for (let node = walker.nextNode(); node; node = walker.nextNode()) size += (node as Text).length;
            return size;
          });
          expect(renderedOutputAsciiBytes).toBe(Buffer.byteLength(CHUNK) * CHUNKS);
        } else await expect(tid(tool, "tool-truncated")).toHaveText("Showing the last 256 KB of 3.0 MB.");
        const native = calls(); const starts = native.filter(c => c.kind === "coding-start"); const finishes = native.filter(c => c.kind === "coding-finish");
        expect(starts).toHaveLength(cycle + 1); expect(finishes).toHaveLength(cycle + 1); expect(finishes.every(c => c.deltas === CHUNKS && c.rawBytes === Buffer.byteLength(CHUNK) * CHUNKS)).toBe(true);
        return { cycle, threadId, marker, renderedOutputAsciiBytes, expectedLegacyOutputViolation: legacy, mainIpc: main, fixtureCodingStarts: starts.length, fixtureCodingFinishes: finishes.length, sendToAnswerAndPreviewObservedMs: Date.now() - sentAt, memory: await observe(`natural stream ${cycle}`) };
      };
      out.cold = await observe("cold draft natural"); out.warmup = await stream(0); await detach();
      out.warmDetachedBefore = await observe("warm detached baseline", true); persist();
      for (let cycle = 1; cycle <= 21; cycle++) { out.samples.push(await stream(cycle)); persist(); }
      const detachedAt = await detach(); out.detachTimeOrigin = "draft positively observed before immediate sample";
      out.detachedNatural = await observe("detached immediate natural"); out.detachedTimedNatural = [];
      for (const intervalMs of [1000, 5000]) {
        // Declared measurement interval, not a readiness wait/retry.
        await new Promise(resolve => setTimeout(resolve, Math.max(0, detachedAt + intervalMs - Date.now())));
        out.detachedTimedNatural.push({ requestedAfterDetachMs: intervalMs, actualAfterDetachMs: Date.now() - detachedAt, ...await observe(`detached natural +${intervalMs}ms`) }); persist();
      }
      out.warmDetachedAfter = await observe("final warm detached endpoint", true);
      expect(out.samples).toHaveLength(21); expect(new Set([out.warmup.threadId, ...out.samples.map((s: any) => s.threadId)]).size).toBe(22);
      expect(out.samples.every((s: any) => !s.memory.forcedGc && s.memory.selectedThreadIds.length === 1 && s.memory.selectedThreadIds[0] === s.threadId)).toBe(true);
      expect(out.warmDetachedBefore.renderedItems).toBe(0); expect(out.warmDetachedAfter.renderedItems).toBe(0);
      out.state = "observations-complete"; persist();
    } catch (error) { out.state = "failed"; out.failure = String(error); persist(); throw error; }
    finally {
      try { if (opened) { await opened.app.close(); out.appClose = "returned"; } else out.appClose = "launch returned no app handle"; }
      catch (error) { out.appClose = "failed"; out.closeError = String(error); throw error; }
      finally { out.fixtureCalls = calls(); const retainedLog = path.join(root, `stream-${replicate}-calls.jsonl`); fs.copyFileSync(callLog, retainedLog, fs.constants.COPYFILE_EXCL); out.fixture.retainedCalls = retainedLog; out.finishedAt = new Date().toISOString(); persist(); }
    }
  });
}
