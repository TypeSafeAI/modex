import { session, type BrowserWindow } from "electron";
import { WorkspaceBrowser } from "./workspace-browser.js";
import { ANALYTICS_ORIGIN, ANALYTICS_SCHEME, respondAnalytics } from "./engine/analytics-assets.js";
import type { BrowserBounds } from "../shared/browser.js";
import type { UsageLedger } from "./engine/usage-ledger.js";

export { ANALYTICS_SCHEME } from "./engine/analytics-assets.js";
const PARTITION = "modex-analytics";
const VIEW = "analytics";

/**
 * Analytics in its own in-memory session. `modex-analytics://app/` serves the built usage dashboard
 * (dist/usage-preview) read-only, and `usage.json` returns the ledger's rows; every other request is refused.
 */
export class WorkspaceAnalytics {
  private browser: WorkspaceBrowser | null = null;
  private loaded = false;
  private disposed = false;
  private visibilityRequest = 0;
  private readonly download = (event: Electron.Event, item: Electron.DownloadItem, contents: Electron.WebContents) => {
    try {
      if (this.disposed || !contents || contents.isDestroyed() || contents.getURL() !== `${ANALYTICS_ORIGIN}/index.html` ||
          !item.getURL().startsWith(`blob:${ANALYTICS_ORIGIN}/`) || item.getMimeType() !== "text/csv" || item.getFilename() !== "modex-usage.csv") {
        event.preventDefault();
        return;
      }
      item.setSaveDialogOptions({ title: "Export usage CSV", defaultPath: "modex-usage.csv", filters: [{ name: "CSV", extensions: ["csv"] }] });
    } catch { event.preventDefault(); }
  };

  constructor(private window: BrowserWindow, private root: string, private ledger: Pick<UsageLedger, "list">) {}

  private ensure(): WorkspaceBrowser {
    if (this.browser) return this.browser;
    if (this.disposed) throw new Error("Analytics unavailable.");
    const isolated = session.fromPartition(PARTITION, { cache: false });
    isolated.protocol.handle(ANALYTICS_SCHEME, request => respondAnalytics(this.root, this.ledger, request));
    // Its own pages, inline data, and the blob: URLs its CSV export creates; nothing else.
    isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${ANALYTICS_ORIGIN}/`) && !details.url.startsWith(`blob:${ANALYTICS_ORIGIN}/`) && !details.url.startsWith("data:") }));
    // Install our narrow policy before WorkspaceBrowser installs its default deny policy.
    isolated.on("will-download", this.download);
    this.browser = new WorkspaceBrowser(this.window, { partition: PARTITION, shortcuts: false, allowURL: url => url.startsWith(`${ANALYTICS_ORIGIN}/`), resolveURL: url => url });
    return this.browser;
  }

  /** Places the dashboard over `bounds`, or hides it when there are none. */
  async show(bounds?: BrowserBounds): Promise<{ error?: string } | null> {
    const request = ++this.visibilityRequest;
    if (!bounds) { this.browser?.show(null); return null; }
    const browser = this.ensure();
    if (!this.loaded) { await browser.command(VIEW, "navigate", `${ANALYTICS_ORIGIN}/index.html`); this.loaded = true; }
    // Navigation can outlive a hide, resize, or disposal; only the latest request may show.
    if (this.disposed || request !== this.visibilityRequest) return null;
    browser.show(VIEW, bounds);
    const state = await browser.command(VIEW, "state");
    return state?.error ? { error: state.error } : null;
  }

  dispose(): void {
    this.disposed = true;
    this.visibilityRequest++;
    if (!this.browser) return;
    this.browser.dispose();
    this.browser = null;
    const isolated = session.fromPartition(PARTITION, { cache: false });
    isolated.removeListener("will-download", this.download);
    isolated.protocol.unhandle(ANALYTICS_SCHEME);
    isolated.webRequest.onBeforeRequest(null);
  }
}
