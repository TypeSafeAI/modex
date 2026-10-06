import { WebContentsView, type BrowserWindow } from "electron";
import { allowedBrowserURL, browserURL, type BrowserBounds, type BrowserSnapshot, type WorkspaceShortcut } from "../shared/browser.js";

/** Guest pages have no preload, Node, app storage, permissions or access to Modex's bridge. */
export class WorkspaceBrowser {
  private views = new Map<string, { view: WebContentsView; error?: string }>();
  private fullView = false;
  constructor(private window: BrowserWindow) {}
  async command(id: string, action: "navigate" | "back" | "forward" | "reload" | "state" | "close", input?: string): Promise<BrowserSnapshot | null> {
    if (typeof id !== "string" || !/^[\w-]{1,100}$/.test(id)) throw new Error("Invalid browser tab.");
    if (action === "close") { this.close(id); return null; }
    let entry = this.views.get(id);
    const url = action === "navigate" ? browserURL(input ?? "") : undefined;
    if (!entry) {
      if (!url) return null;
      if (this.views.size >= 12) throw new Error("Close a browser tab before opening another.");
      const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: "modex-workspace-browser", webSecurity: true, allowRunningInsecureContent: false } });
      entry = { view };
      this.views.set(id, entry);
      const contents = view.webContents;
      contents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown") return;
        const key = input.key.toLowerCase();
        let shortcut: WorkspaceShortcut | undefined;
        if ((input.meta || input.control) && input.shift && key === "b") shortcut = "new";
        else if ((input.meta || input.control) && input.shift && key === "f") shortcut = "full";
        else if ((input.meta || input.control) && !input.shift && key === "p") shortcut = "files";
        else if (input.control && input.shift && key === "g") shortcut = "review";
        else if ((input.meta || input.control) && key === "l") shortcut = "address";
        else if (input.control && input.code === "Backquote") shortcut = "terminal";
        else if (input.meta && key === "j") shortcut = "hide";
        else if (key === "escape" && this.fullView) shortcut = "escape";
        if (shortcut) { event.preventDefault(); this.window.webContents.focus(); this.window.webContents.send("workspace:shortcut", shortcut); }
      });
      contents.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      contents.session.setPermissionCheckHandler(() => false);
      // Set once per guest session; remove our listener when all guest views are disposed.
      if (!contents.session.listenerCount("will-download")) contents.session.on("will-download", (event) => event.preventDefault());
      contents.on("will-navigate", (e, target) => { if (!allowedBrowserURL(target)) e.preventDefault(); });
      contents.on("will-redirect", (e, target) => { if (!allowedBrowserURL(target)) e.preventDefault(); });
      contents.on("will-frame-navigate", (e) => { if (!allowedBrowserURL(e.url) && e.url !== "about:blank") e.preventDefault(); });
      contents.setWindowOpenHandler(({ url }) => { if (allowedBrowserURL(url)) void contents.loadURL(url).catch(() => {}); return { action: "deny" }; });
      contents.on("did-fail-load", (_e, code, description, _url, mainFrame) => { if (mainFrame && code !== -3 && entry) entry.error = description; });
      contents.on("did-start-navigation", (_e, _url, _inPlace, mainFrame) => { if (mainFrame && entry) entry.error = undefined; });
      contents.on("render-process-gone", () => { if (entry) entry.error = "This page stopped responding. Reload to try again."; });
      view.setBackgroundColor("#101010");
      view.setVisible(false);
      this.window.contentView.addChildView(view);
    }
    const contents = entry.view.webContents;
    if (url) { entry.error = undefined; void contents.loadURL(url).catch(() => { /* did-fail-load owns errors; superseded loads reject with ERR_ABORTED. */ }); }
    else if (action === "back" && contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
    else if (action === "forward" && contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
    else if (action === "reload") { entry.error = undefined; contents.reload(); }
    return { id, url: url ?? contents.getURL(), title: contents.getTitle().slice(0, 200), back: contents.navigationHistory.canGoBack(), forward: contents.navigationHistory.canGoForward(), loading: contents.isLoading(), ...(entry.error ? { error: entry.error } : {}) };
  }
  show(id: string | null, bounds?: BrowserBounds, fullView = false): void {
    this.fullView = false;
    for (const [key, { view }] of this.views) {
      let visible = key === id && Boolean(bounds);
      if (visible && bounds) {
        if (![bounds.x, bounds.y, bounds.width, bounds.height].every(Number.isFinite)) visible = false;
        else {
          const [width = 0, height = 0] = this.window.getContentSize();
          const x = Math.max(0, Math.min(width, Math.round(bounds.x)));
          const y = Math.max(0, Math.min(height, Math.round(bounds.y)));
          const w = Math.max(0, Math.min(width - x, Math.round(bounds.width)));
          const h = Math.max(0, Math.min(height - y, Math.round(bounds.height)));
          view.setBounds({ x, y, width: w, height: h });
          visible = w > 0 && h > 0;
        }
      }
      view.setVisible(visible);
      if (visible) this.fullView = fullView;
    }
  }
  close(id: string): void {
    const entry = this.views.get(id);
    if (!entry) return;
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    this.views.delete(id);
  }
  dispose(): void { for (const id of this.views.keys()) this.close(id); }
}
