import { session, type BrowserWindow } from "electron";
import { CanvasResources } from "./engine/canvas.js";
import { WorkspaceBrowser } from "./workspace-browser.js";
import { CANVAS_SCHEME, type CanvasSnapshot } from "../shared/canvas.js";
import type { BrowserBounds } from "../shared/browser.js";

/** Each preview gets its own in-memory session, protocol authority and permission boundary. */
export class WorkspaceCanvas {
  private entries = new Map<string, { cwd: string; resources: CanvasResources; browser: WorkspaceBrowser; dispose: () => void; polling?: Promise<CanvasSnapshot> }>();
  private generation = new Map<string, number>();
  private disposed = false;
  constructor(private window: BrowserWindow) {}
  async open(id: string, cwd: string, relative: string): Promise<CanvasSnapshot> {
    if (this.disposed || typeof id !== "string" || !/^[\w-]{1,100}$/.test(id)) throw new Error("Canvas unavailable.");
    if (!this.entries.has(id) && this.entries.size >= 12) throw new Error("Close a Canvas tab before opening another.");
    const current = this.entries.get(id);
    if (current?.cwd === cwd && current.resources.selected === relative) return this.state(id);
    this.close(id);
    const version = this.generation.get(id)!;
    const resources = new CanvasResources(cwd, relative);
    await resources.validate();
    if (this.disposed || this.generation.get(id) !== version) throw new Error("Canvas selection changed.");
    const partition = `canvas-${resources.origin.split("://")[1]}`;
    const isolated = session.fromPartition(partition, { cache: false });
    isolated.protocol.handle(CANVAS_SCHEME, request => resources.respond(request));
    // CSP protects documents, including SVG; the session also blocks navigation and subresources
    // to the network, file URLs, the app and other Canvas origins.
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !resources.allows(details.url) && !details.url.startsWith("data:") }));
    const browser = new WorkspaceBrowser(this.window, { partition, allowURL: value => resources.allows(value), resolveURL: value => value });
    this.entries.set(id, { cwd, resources, browser, dispose: () => {
      browser.dispose();
      isolated.protocol.unhandle(CANVAS_SCHEME);
      isolated.webRequest.onBeforeRequest(null);
      void isolated.clearStorageData().catch(() => {});
    } });
    await browser.command(id, "navigate", resources.url);
    return { path: relative, loading: true };
  }
  async state(id: string, reload = false): Promise<CanvasSnapshot> {
    const entry = this.entries.get(id);
    if (!entry) throw new Error("Choose a Canvas file.");
    if (entry.polling) {
      const snapshot = await entry.polling;
      // An explicit reload must survive a concurrent background read. Recheck ownership so a
      // late request cannot reload a replacement preview after the selection changed.
      return reload && this.entries.get(id) === entry ? this.state(id, true) : snapshot;
    }
    const poll = async (): Promise<CanvasSnapshot> => {
      try {
        const changed = await entry.resources.changed();
        await entry.resources.validate();
        if (this.entries.get(id) !== entry) throw new Error("Canvas selection changed.");
        const state = await entry.browser.command(id, changed || reload ? "reload" : "state");
        return { path: entry.resources.selected, loading: state?.loading ?? false, ...(state?.error ? { error: state.error } : {}) };
      } catch { return { path: entry.resources.selected, loading: false, error: "This file is unavailable or cannot be previewed. Canvas will retry when it changes." }; }
    };
    entry.polling = poll().finally(() => { entry.polling = undefined; });
    return entry.polling;
  }
  show(id: string | null, bounds?: BrowserBounds, fullView = false): void {
    for (const [key, entry] of this.entries) entry.browser.show(key === id ? id : null, bounds, fullView);
  }
  close(id: string): void {
    this.generation.set(id, (this.generation.get(id) ?? 0) + 1);
    this.entries.get(id)?.dispose();
    this.entries.delete(id);
  }
  dispose(): void { this.disposed = true; for (const id of this.entries.keys()) this.close(id); }
}
