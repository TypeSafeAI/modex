import { WebContentsView, type BrowserWindow, type WebFrameMain } from "electron";
import { allowedBrowserURL, browserURL, WORKSPACE_BROWSER_PARTITION, type BrowserBounds, type BrowserSnapshot, type WorkspaceShortcut } from "../shared/browser.js";
import { fillLoginFields, type LoginFields } from "./engine/browser-credentials.js";

/** Guest pages have no app preload, Node, app storage or access to Modex's bridge. */
export class WorkspaceBrowser {
  private views = new Map<string, { view: WebContentsView; navigation: number; error?: string; styled?: boolean; cssKey?: string; styleVersion?: number }>();
  private fullView = false;
  private shown: { id: string | null; bounds?: BrowserBounds; fullView: boolean } = { id: null, fullView: false };
  constructor(private window: BrowserWindow, private options: { partition?: string; allowURL?: (url: string) => boolean; shortcuts?: boolean; appearance?: () => { background: string; css: string } } = {}) {}
  ownsFrame(frame: WebFrameMain | null): boolean {
    if (!frame || frame.isDestroyed()) return false;
    return [...this.views.values()].some(({ view }) => !view.webContents.isDestroyed() && view.webContents.mainFrame === frame.top);
  }
  frameGuard(frame: WebFrameMain): () => boolean {
    const entry = [...this.views.values()].find(({ view }) => !view.webContents.isDestroyed() && view.webContents.mainFrame === frame.top);
    const navigation = entry?.navigation, url = frame.url;
    return () => Boolean(entry && this.ownsFrame(frame) && entry.navigation === navigation && frame.url === url);
  }
  credentialTarget(id: string) {
    const entry = this.views.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error("Open a browser page first.");
    const contents = entry.view.webContents, navigation = entry.navigation, url = contents.getURL();
    const isCurrent = () => !contents.isDestroyed() && this.views.get(id) === entry && entry.navigation === navigation && contents.getURL() === url;
    return { url, isCurrent, fill: async (fields: LoginFields): Promise<boolean> => {
      if (!isCurrent()) return false;
      const origin = new URL(url).origin;
      return contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${fillLoginFields.toString()})(${JSON.stringify(origin)},${JSON.stringify(fields)})` }]);
    } };
  }
  async refreshAppearance(): Promise<void> {
    await Promise.all([...this.views.keys()].map(id => this.style(id)));
  }
  private async style(id: string): Promise<void> {
    const entry = this.views.get(id);
    const appearance = this.options.appearance?.();
    if (!entry || !appearance || entry.view.webContents.isDestroyed()) return;
    const version = entry.styleVersion = (entry.styleVersion ?? 0) + 1;
    const contents = entry.view.webContents;
    entry.view.setBackgroundColor(appearance.background);
    try {
      const key = await contents.insertCSS(appearance.css, { cssOrigin: "user" });
      if (contents.isDestroyed()) return;
      if (entry.styleVersion !== version) { await contents.removeInsertedCSS(key); return; }
      const previous = entry.cssKey;
      entry.cssKey = key;
      // An isolated world changes presentation only; the guest receives no preload or bridge.
      await contents.executeJavaScriptInIsolatedWorld(999, [{ code: `(() => {
        const root = document.documentElement;
        const dark = () => { root.classList.remove('light'); root.classList.add('dark'); };
        dark();
        if (!globalThis.modexThemeObserver) {
          globalThis.modexThemeObserver = new MutationObserver(() => { if (!root.classList.contains('dark') || root.classList.contains('light')) dark(); });
          globalThis.modexThemeObserver.observe(root, { attributes: true, attributeFilter: ['class'] });
        }
      })()` }]);
      if (previous) await contents.removeInsertedCSS(previous);
      if (entry.styleVersion !== version || contents.isDestroyed()) return;
      entry.styled = true;
      this.show(this.shown.id, this.shown.bounds, this.shown.fullView);
    } catch { if (!contents.isDestroyed() && entry.styleVersion === version) entry.error = "The knowledge theme could not load. Reload to try again."; }
  }
  async command(id: string, action: "navigate" | "back" | "forward" | "reload" | "state" | "close", input?: string): Promise<BrowserSnapshot | null> {
    if (typeof id !== "string" || !/^[\w-]{1,100}$/.test(id)) throw new Error("Invalid browser tab.");
    if (action === "close") { this.close(id); return null; }
    let entry = this.views.get(id);
    const url = action === "navigate" ? browserURL(input ?? "") : undefined;
    const allowed = this.options.allowURL ?? allowedBrowserURL;
    if (url && !allowed(url)) throw new Error("This address is outside the knowledge base.");
    if (!entry) {
      if (!url) return null;
      if (this.views.size >= 12) throw new Error("Close a browser tab before opening another.");
      const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: this.options.partition ?? WORKSPACE_BROWSER_PARTITION, webSecurity: true, allowRunningInsecureContent: false } });
      entry = { view, navigation: 0 };
      this.views.set(id, entry);
      const contents = view.webContents;
      contents.on("before-input-event", (event, input) => {
        if (input.type !== "keyDown" || this.options.shortcuts === false) return;
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
      contents.on("will-navigate", (e, target) => { if (!allowed(target)) e.preventDefault(); });
      contents.on("will-redirect", (e, target) => { if (!allowed(target)) e.preventDefault(); });
      contents.on("will-frame-navigate", (e) => { if (!allowed(e.url) && e.url !== "about:blank") e.preventDefault(); });
      contents.setWindowOpenHandler(({ url }) => { if (allowed(url)) void contents.loadURL(url).catch(() => {}); return { action: "deny" }; });
      contents.on("did-fail-load", (_e, code, description, _url, mainFrame) => { if (mainFrame && code !== -3 && entry) entry.error = description; });
      contents.on("did-start-navigation", (_e, _url, _inPlace, mainFrame) => { if (mainFrame && entry) { entry.error = undefined; entry.navigation++; } });
      if (this.options.appearance) {
        contents.on("did-start-navigation", (_e, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace && entry) { entry.styled = false; entry.styleVersion = (entry.styleVersion ?? 0) + 1; entry.cssKey = undefined; view.setVisible(false); }
        });
        contents.on("dom-ready", () => { void this.style(id); });
      }
      contents.on("render-process-gone", () => { if (entry) entry.error = "This page stopped responding. Reload to try again."; });
      view.setBackgroundColor(this.options.appearance?.().background ?? "#101010");
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
    this.shown = { id, bounds, fullView };
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
      view.setVisible(visible && (!this.options.appearance || this.views.get(key)?.styled === true));
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
