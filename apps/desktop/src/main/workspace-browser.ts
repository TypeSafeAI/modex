import { WebContentsView, type BrowserWindow, type WebFrameMain } from "electron";
import { allowedBrowserURL, browserURL, WORKSPACE_BROWSER_PARTITION, type BrowserBounds, type BrowserSnapshot, type WorkspaceShortcut } from "../shared/browser.js";
import { randomUUID } from "node:crypto";
import { disposeLoginRequest, fillLoginFields, fillLoginRequest, prepareLoginRequest, type LoginFields } from "./engine/browser-credentials.js";

interface BrowserEntry {
  view: WebContentsView;
  navigation: number;
  frameNavigations: Map<number, { generation: number; users: number }>;
  error?: string; styled?: boolean; cssKey?: string; styleVersion?: number;
}

/** Guest pages have no app preload, Node, app storage or access to Modex's bridge. */
export class WorkspaceBrowser {
  private views = new Map<string, BrowserEntry>();
  get hasOpenPages(): boolean { return this.views.size > 0; }
  private fullView = false;
  private shown: { id: string | null; bounds?: BrowserBounds; fullView: boolean } = { id: null, fullView: false };
  constructor(private window: BrowserWindow, private options: { partition?: string; resolveURL?: (input: string) => string; allowURL?: (url: string) => boolean; shortcuts?: boolean; appearance?: () => { background: string; css: string; script?: string } } = {}) {}
  ownsFrame(frame: WebFrameMain | null): boolean {
    try { return Boolean(frame && !frame.isDestroyed() && [...this.views.values()].some(({ view }) => !view.webContents.isDestroyed() && view.webContents.mainFrame === frame.top)); }
    catch { return false; }
  }
  frameGuard(frame: WebFrameMain): (() => boolean) & { dispose(): void } {
    const snapshots: { frame: WebFrameMain; parent: WebFrameMain | null; id: number; url: string; record: { generation: number; users: number }; generation: number }[] = [];
    let entry: BrowserEntry | undefined, disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      for (const { id, record } of snapshots) if (--record.users === 0 && entry?.frameNavigations.get(id) === record) entry.frameNavigations.delete(id);
    };
    try {
      if (!this.ownsFrame(frame)) throw new Error();
      entry = [...this.views.values()].find(({ view }) => view.webContents.mainFrame === frame.top);
      if (!entry) throw new Error();
      for (let current: WebFrameMain | null = frame; current;) {
        const id = current.frameTreeNodeId;
        if (current.isDestroyed() || !Number.isInteger(id) || id < 0 || snapshots.some(snapshot => snapshot.id === id)) throw new Error();
        // Native getters may throw after renderer loss. Capture them before registering
        // ownership so a partial snapshot cannot strand a navigation-tracking record.
        const parent: WebFrameMain | null = current.parent, url = current.url;
        let record = entry.frameNavigations.get(id);
        if (!record) { record = { generation: 0, users: 0 }; entry.frameNavigations.set(id, record); }
        record.users++;
        snapshots.push({ frame: current, parent, id, url, record, generation: record.generation });
        current = parent;
      }
      if (snapshots.at(-1)?.frame !== entry.view.webContents.mainFrame) throw new Error();
    } catch { dispose(); }
    return Object.assign(() => {
      try {
        if (!disposed && entry && [...this.views.values()].includes(entry) && this.ownsFrame(frame) && snapshots.every(snapshot =>
          !snapshot.frame.isDestroyed() && snapshot.frame.parent === snapshot.parent && snapshot.frame.frameTreeNodeId === snapshot.id && snapshot.frame.url === snapshot.url && entry!.frameNavigations.get(snapshot.id) === snapshot.record && snapshot.record.generation === snapshot.generation)) return true;
      } catch { /* Frame access can throw after renderer loss. Cancel permanently. */ }
      dispose();
      return false;
    }, { dispose });
  }
  tabURL(id: string): string {
    const entry = this.views.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error("Open a browser page first.");
    return entry.view.webContents.getURL();
  }
  async credentialTarget(id: string) {
    const entry = this.views.get(id);
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error("Open a browser page first.");
    const contents = entry.view.webContents, frame = contents.mainFrame, navigation = entry.navigation, url = contents.getURL();
    let disposed = false;
    const token = randomUUID();
    const isCurrent = () => {
      try { return !disposed && !contents.isDestroyed() && !frame.isDestroyed() && !contents.isLoadingMainFrame() && this.views.get(id) === entry && contents.mainFrame === frame && entry.navigation === navigation && contents.getURL() === url; }
      catch { return false; }
    };
    const dispose = () => {
      if (disposed) return;
      const current = isCurrent();
      disposed = true;
      if (!current) return; // Navigation/pagehide already revokes the old document's token.
      // Cleanup must not hold the fill lock if navigation races this dispatch. The token
      // is all this best-effort script carries; delayed cleanup cannot revoke a new request.
      try { void contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${disposeLoginRequest.toString()})(${JSON.stringify(token)})` }]).catch(() => {}); }
      catch { /* Never expose raw execution errors or script source. */ }
    };
    if (!isCurrent()) throw new Error("The page is loading or changed. Try again after it finishes.");
    try {
      const prepared = await contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${prepareLoginRequest.toString()})(${JSON.stringify(token)},${JSON.stringify(url)})` }]);
      if (!prepared || !isCurrent()) throw new Error();
    } catch {
      dispose();
      throw new Error("The page changed. Select a login again on the current page.");
    }
    return { url, isCurrent, dispose, fill: async (fields: LoginFields): Promise<boolean> => {
      if (!isCurrent()) return false;
      try {
        const filled = await contents.executeJavaScriptInIsolatedWorld(1001, [{ code: `(${fillLoginRequest.toString()})(${JSON.stringify(token)},${JSON.stringify(url)},${JSON.stringify(fields)},${fillLoginFields.toString()})` }]);
        return filled === true && isCurrent();
      } catch { return false; }
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
      if (appearance.script) await contents.executeJavaScriptInIsolatedWorld(999, [{ code: appearance.script }]);
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
    const url = action === "navigate" ? (this.options.resolveURL ?? browserURL)(input ?? "") : undefined;
    const allowed = this.options.allowURL ?? allowedBrowserURL;
    if (url && !allowed(url)) throw new Error("This address is outside the knowledge base.");
    if (!entry) {
      if (!url) return null;
      if (this.views.size >= 12) throw new Error("Close a browser tab before opening another.");
      const view = new WebContentsView({ webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, partition: this.options.partition ?? WORKSPACE_BROWSER_PARTITION, webSecurity: true, allowRunningInsecureContent: false } });
      entry = { view, navigation: 0, frameNavigations: new Map() };
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
      contents.on("did-start-navigation", details => {
        if (!entry) return;
        if (details.isMainFrame) { entry.error = undefined; entry.navigation++; }
        try {
          const frame = details.frame;
          if (!frame || frame.isDestroyed() || !Number.isInteger(frame.frameTreeNodeId) || frame.frameTreeNodeId < 0) throw new Error();
          const tracked = entry.frameNavigations.get(frame.frameTreeNodeId);
          if (tracked) tracked.generation++;
        } catch {
          // Unknown navigation details cannot prove that an active request is unrelated.
          entry.navigation++;
          entry.frameNavigations.clear();
        }
      });
      if (this.options.appearance) {
        contents.on("did-start-navigation", (_e, _url, inPlace, mainFrame) => {
          if (mainFrame && !inPlace && entry) { entry.styled = false; entry.styleVersion = (entry.styleVersion ?? 0) + 1; entry.cssKey = undefined; view.setVisible(false); }
        });
        contents.on("dom-ready", () => { void this.style(id); });
      }
      contents.on("render-process-gone", () => { if (entry) { entry.navigation++; entry.frameNavigations.clear(); entry.error = "This page stopped responding. Reload to try again."; } });
      contents.on("destroyed", () => { entry?.frameNavigations.clear(); });
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
          // Renderer rectangles are CSS pixels; native child views use device-independent pixels.
          const zoom = this.window.webContents.getZoomFactor();
          const [width = 0, height = 0] = this.window.getContentSize();
          const x = Math.max(0, Math.min(width, Math.round(bounds.x * zoom)));
          const y = Math.max(0, Math.min(height, Math.round(bounds.y * zoom)));
          const w = Math.max(0, Math.min(width - x, Math.round(bounds.width * zoom)));
          const h = Math.max(0, Math.min(height - y, Math.round(bounds.height * zoom)));
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
    entry.frameNavigations.clear();
    if (!this.window.isDestroyed()) this.window.contentView.removeChildView(entry.view);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    this.views.delete(id);
  }
  dispose(): void { for (const id of this.views.keys()) this.close(id); }
}
