import { expect, type ElectronApplication, type Page } from "@playwright/test";
import { tid } from "../support.js";

/** Hold only creation; trap send/staging admission before any provider or file action can run. */
export async function holdLocalDraftCreation(app: ElectronApplication) {
  await app.evaluate(({ ipcMain }) => {
    const ipc = ipcMain as typeof ipcMain & { _invokeHandlers: Map<string, (...args: any[]) => any> };
    const originals = new Map<string, (...args: any[]) => any>();
    let release: (() => void) | undefined;
    const gate = { starts: 0, sends: 0, stages: 0, release: () => release?.(), restore: () => {
      release?.();
      for (const [channel, original] of originals) { ipcMain.removeHandler(channel); ipcMain.handle(channel, original); }
    } };
    Object.assign(globalThis, { localDraftSelectionGate: gate });
    const create = ipc._invokeHandlers.get("thread:create")!;
    originals.set("thread:create", create); ipcMain.removeHandler("thread:create");
    ipcMain.handle("thread:create", async (...args) => {
      if (++gate.starts === 1) await new Promise<void>(resolve => { release = resolve; });
      return create(...args);
    });
    for (const channel of ["thread:send", "drafts:begin", "drafts:send", "attachments:stage", "drafts:stage"]) {
      const original = ipc._invokeHandlers.get(channel); if (!original) continue;
      originals.set(channel, original); ipcMain.removeHandler(channel);
      ipcMain.handle(channel, (...args) => {
        if (channel.endsWith(":stage")) { gate.stages++; throw new Error("Synthetic local-selection staging trap"); }
        gate.sends++;
        // Preserve native intent/transfer semantics; block only the final provider dispatch.
        if (channel === "drafts:begin") return original(...args);
        return { ok: false, error: "Synthetic local-selection send trap" };
      });
    }
  });
}

export async function tryInputWhileLocalSelectionWaits(app: ElectronApplication, page: Page, original: string) {
  await expect.poll(() => app.evaluate(() => (globalThis as any).localDraftSelectionGate.starts)).toBe(1);
  const input = tid(page, "composer-input");
  await input.focus();
  await page.keyboard.type("This message is intended for the chosen local model.");
  await input.press(process.platform === "darwin" ? "Meta+Enter" : "Control+Enter");
  // Dispatch a paste too: the callback must refuse staging even if a stale event bypasses actionability.
  await input.evaluate(el => {
    const data = new DataTransfer(); data.items.add(new File(["private fixture"], "while-selecting.txt", { type: "text/plain" }));
    el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
  });
  await expect(input).toHaveValue(original);
  const counts = await app.evaluate(() => {
    const g = (globalThis as any).localDraftSelectionGate; return { starts: g.starts, sends: g.sends, stages: g.stages };
  });
  expect(counts).toEqual({ starts: 1, sends: 0, stages: 0 });
}

export async function releaseLocalDraftCreation(app: ElectronApplication) {
  await app.evaluate(() => (globalThis as any).localDraftSelectionGate.release());
}

export async function restoreLocalDraftCreation(app: ElectronApplication) {
  return app.evaluate(() => {
    const g = (globalThis as any).localDraftSelectionGate;
    if (!g) return null;
    g.restore(); return { starts: g.starts, sends: g.sends, stages: g.stages };
  });
}
