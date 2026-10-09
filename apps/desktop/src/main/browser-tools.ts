import { app, dialog, session, shell, systemPreferences, type BrowserWindow } from "electron";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { BrowserExtensions, inspectExtension } from "./engine/browser-extensions.js";
import { fillFrom1Password, read1Password } from "./engine/browser-credentials.js";
import { allowedBrowserURL, WORKSPACE_BROWSER_PARTITION, type BrowserToolsSnapshot } from "../shared/browser.js";
import type { WorkspaceBrowser } from "./workspace-browser.js";

const KEYCHAIN_GROUP = "9LR8Z8UQ9X.ai.typesafe.modex.webauthn";

/** Only signed releases may claim device-bound Touch ID credentials. No vault or OS login is probed. */
function configureTouchID(): boolean {
  if (process.platform !== "darwin" || !app.isPackaged || process.env.MODEX_E2E || !systemPreferences.canPromptTouchID()) return false;
  const signature = spawnSync("/usr/bin/codesign", ["-dvv", "--entitlements", "-", "--xml", app.getPath("exe")], { encoding: "utf8", timeout: 5000, maxBuffer: 128 * 1024 });
  if (signature.status !== 0 || !signature.stderr.includes("TeamIdentifier=9LR8Z8UQ9X") || !signature.stdout.includes(`<string>${KEYCHAIN_GROUP}</string>`)) return false;
  app.configureWebAuthn({ touchID: { keychainAccessGroup: KEYCHAIN_GROUP, promptReason: "sign in to $1" } });
  return true;
}

export class BrowserTools {
  private extensions: BrowserExtensions;
  private touchID = configureTouchID();
  private busy = false;
  private extensionBusy = false;
  private startupError?: string;
  constructor(home: string, private owner: () => { window: BrowserWindow; browser: WorkspaceBrowser } | null) {
    const profile = session.fromPartition(WORKSPACE_BROWSER_PARTITION);
    this.extensions = new BrowserExtensions(path.join(home, "browser"), profile.extensions);
    profile.on("select-webauthn-account", (_event, details, callback) => {
      const owner = this.owner(), frame = details.frame;
      if (!owner || !owner.browser.ownsFrame(frame) || !frame || !allowedBrowserURL(frame.url) || !details.accounts.length || details.accounts.length > 12) { callback(); return; }
      const url = frame.url;
      const isCurrent = owner.browser.frameGuard(frame);
      const accounts = [...details.accounts];
      void (async () => {
        let selected: string | undefined;
        try {
          const result = await dialog.showMessageBox(owner.window, {
            type: "question", title: "Sign in with a passkey", message: `Choose an account for ${details.relyingPartyId}`,
            detail: `Requested by ${new URL(url).origin}`,
            buttons: ["Cancel", ...accounts.map(account => (account.displayName || account.name || "Saved account").slice(0, 100))], defaultId: 0, cancelId: 0, noLink: true,
          });
          if (!owner.window.isDestroyed() && isCurrent()) selected = accounts[result.response - 1]?.credentialId;
        } catch { /* Closing the window cancels its native prompt. */ }
        finally { callback(selected); }
      })();
    });
  }
  async restore(): Promise<void> {
    try { await this.extensions.restore(); }
    catch { this.startupError = "Browser extension settings could not be read. Restore browser/extensions.json from a backup before adding extensions."; }
  }
  snapshot(): BrowserToolsSnapshot { return { extensions: this.extensions.snapshot(), touchID: this.touchID, ...(this.startupError ? { error: this.startupError } : {}) }; }
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
      const answer = await dialog.showMessageBox(owner.window, {
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
    const target = owner.browser.credentialTarget(id);
    this.busy = true;
    try {
      return await fillFrom1Password(target, { read: read1Password, choose: async (logins, origin) => {
        const result = await dialog.showMessageBox(owner.window, {
          type: "question", title: "Fill with 1Password", message: `Choose a login for ${origin}`,
          detail: "Fill this page's login fields without submitting the form.",
          buttons: ["Cancel", ...logins.map(login => login.title)], defaultId: 0, cancelId: 0, noLink: true,
        });
        return result.response === 0 ? undefined : result.response - 1;
      } });
    } finally { this.busy = false; }
  }
  async external(id: string): Promise<void> {
    const owner = this.owner();
    if (!owner) throw new Error("Browser unavailable.");
    const { url } = owner.browser.credentialTarget(id);
    if (!allowedBrowserURL(url)) throw new Error("Open an HTTPS page or local preview first.");
    await shell.openExternal(url);
  }
}
