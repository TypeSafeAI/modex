import { dialog, session, shell, type BrowserWindow, type MessageBoxOptions } from "electron";
import path from "node:path";
import { BrowserExtensions, inspectExtension } from "./engine/browser-extensions.js";
import { fillFrom1Password, read1Password } from "./engine/browser-credentials.js";
import { allowedBrowserURL, WORKSPACE_BROWSER_PARTITION, type BrowserToolsSnapshot } from "../shared/browser.js";
import type { WorkspaceBrowser } from "./workspace-browser.js";
import { redactSecrets } from "../shared/streamer-secrets.js";

export class BrowserTools {
  private extensions: BrowserExtensions;
  private busy = false;
  private extensionBusy = false;
  private startupError?: string;
  constructor(home: string, private owner: () => { window: BrowserWindow; browser: WorkspaceBrowser } | null) {
    const profile = session.fromPartition(WORKSPACE_BROWSER_PARTITION);
    this.extensions = new BrowserExtensions(path.join(home, "browser"), profile.extensions);
    profile.on("select-webauthn-account", (_event, details, callback) => {
      void (async () => {
        let selected: string | undefined;
        let isCurrent: ReturnType<WorkspaceBrowser["frameGuard"]> | undefined;
        try {
          const owner = this.owner(), frame = details.frame;
          if (!owner || !frame || !owner.browser.ownsFrame(frame)) return;
          const url = frame.url;
          if (!allowedBrowserURL(url) || !details.accounts.length || details.accounts.length > 12) return;
          isCurrent = owner.browser.frameGuard(frame);
          const accounts = [...details.accounts];
          const result = await this.showMessageBox(owner.window, {
            type: "question", title: "Sign in with a passkey", message: `Choose an account for ${details.relyingPartyId}`,
            detail: `Requested by ${new URL(url).origin}`,
            buttons: ["Cancel", ...accounts.map(account => (account.displayName || account.name || "Saved account").slice(0, 100))], defaultId: 0, cancelId: 0, noLink: true,
          }, isCurrent);
          if (!owner.window.isDestroyed() && isCurrent()) selected = accounts[result.response - 1]?.credentialId;
        } catch { /* Native frame access and closing the window can both cancel setup. */ }
        finally {
          try { isCurrent?.dispose(); } catch { selected = undefined; }
          try { callback(selected); } catch { /* Chromium may already have disposed its request. */ }
        }
      })();
    });
  }
  private async showMessageBox(window: BrowserWindow, options: MessageBoxOptions, isCurrent = () => true) {
    let mask = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const contents = window.webContents;
      if (!window.isDestroyed() && !contents.isDestroyed() && !contents.isLoadingMainFrame()) {
        const frame = contents.mainFrame;
        // Read only the trusted app's current display state, never a guest or request flag.
        const mode = await Promise.race([
          frame.executeJavaScript('document.querySelector(".app")?.getAttribute("data-streamer-mode")'),
          new Promise(resolve => { timer = setTimeout(() => resolve(undefined), 250); }),
        ]);
        if (!window.isDestroyed() && !contents.isDestroyed() && !contents.isLoadingMainFrame()
          && contents.mainFrame === frame && !frame.isDestroyed()) mask = mode !== "false";
      }
    } catch { /* Unavailable app state keeps native labels masked. */ }
    finally { if (timer !== undefined) clearTimeout(timer); }
    if (window.isDestroyed()) throw new Error("Browser unavailable.");
    if (!isCurrent()) throw new Error("The page changed. Select an account again on the current page.");
    return dialog.showMessageBox(window, mask ? {
      ...options, message: redactSecrets(options.message),
      ...(options.detail === undefined ? {} : { detail: redactSecrets(options.detail) }),
      ...(options.buttons === undefined ? {} : { buttons: options.buttons.map(redactSecrets) }),
    } : options);
  }
  async restore(): Promise<void> {
    try { await this.extensions.restore(); }
    catch { this.startupError = "Browser extension settings could not be read. Restore browser/extensions.json from a backup before adding extensions."; }
  }
  snapshot(): BrowserToolsSnapshot { return { extensions: this.extensions.snapshot(), touchID: false, ...(this.startupError ? { error: this.startupError } : {}) }; }
  async install(): Promise<BrowserToolsSnapshot> {
    if (this.extensionBusy) throw new Error("An extension change is already in progress.");
    if (this.startupError) throw new Error(this.startupError);
    const owner = this.owner();
    if (!owner) throw new Error("Browser unavailable.");
    this.extensionBusy = true;
    try {
      const picked = await dialog.showOpenDialog(owner.window, { title: "Add a custom browser extension", buttonLabel: "Review extension", properties: ["openDirectory"] });
      if (picked.canceled || !picked.filePaths[0]) return this.snapshot();
      const candidate = await inspectExtension(picked.filePaths[0]);
      const answer = await this.showMessageBox(owner.window, {
        type: "question", title: "Add browser extension", message: `Add ${candidate.name} ${candidate.version}?`,
        detail: `This extension can read and change page data, including login fields, on:\n\n${candidate.sites.join("\n")}\n\nIt runs only in the workspace browser. Install only code you trust.`,
        buttons: ["Cancel", "Add extension"], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (answer.response === 1 && !owner.window.isDestroyed()) await this.extensions.install(candidate);
      return this.snapshot();
    } finally { this.extensionBusy = false; }
  }
  async update(id: string, action: "enable" | "disable" | "remove"): Promise<BrowserToolsSnapshot> {
    if (this.startupError) throw new Error(this.startupError);
    if (this.extensionBusy) throw new Error("An extension change is already in progress.");
    this.extensionBusy = true;
    try { await this.extensions.update(id, action); return this.snapshot(); }
    finally { this.extensionBusy = false; }
  }
  async fill(id: string): Promise<boolean> {
    const owner = this.owner();
    if (!owner) throw new Error("Browser unavailable.");
    if (this.busy) throw new Error("A 1Password request is already in progress.");
    this.busy = true;
    let target: Awaited<ReturnType<WorkspaceBrowser["credentialTarget"]>> | undefined;
    try {
      target = await owner.browser.credentialTarget(id);
      return await fillFrom1Password(target, { read: read1Password, choose: async (logins, origin) => {
        const result = await this.showMessageBox(owner.window, {
          type: "question", title: "Fill with 1Password", message: `Choose a login for ${origin}`,
          detail: "Fill this page's login fields without submitting the form.",
          buttons: ["Cancel", ...logins.map(login => login.title)], defaultId: 0, cancelId: 0, noLink: true,
        }, () => target!.isCurrent());
        return result.response === 0 ? undefined : result.response - 1;
      } });
    } finally {
      try { target?.dispose(); } finally { this.busy = false; }
    }
  }
  async external(id: string): Promise<void> {
    const owner = this.owner();
    if (!owner) throw new Error("Browser unavailable.");
    const url = owner.browser.tabURL(id);
    if (!allowedBrowserURL(url)) throw new Error("Open an HTTPS page or local preview first.");
    await shell.openExternal(url);
  }
}
