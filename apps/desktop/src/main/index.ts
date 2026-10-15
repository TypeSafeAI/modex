import { NativeDrafts } from "./engine/native-drafts.js";
import { OwnerRemoval } from "./engine/owner-removal.js";
import type { DraftRemovalScope } from "../shared/native-drafts.js";
import { RestartAdmission } from "./engine/restart-admission.js";
import { readUpdateStartup } from "./engine/update-startup.js";
import { UpdateRecovery } from "./engine/update-recovery.js";
import { UpdateRestartCoordinator } from "./engine/update-restart-coordinator.js";
import { UpdateInstallation } from "./engine/update-installation.js";
import { MacUpdateHandoff } from "./engine/update-mac-handoff.js";
import type { UpdateInstallState } from "../shared/updates.js";
import type { UpdateStartupRecovery } from "../shared/update-recovery.js";
import { DocumentRestartPreflight } from "./engine/update-renderer-preflight.js";
import type { IpcMainInvokeEvent } from "electron";
import { WorkspaceCanvas } from "./workspace-canvas.js";
import { CANVAS_SCHEME } from "../shared/canvas.js";
import { KnowledgeService } from "./engine/knowledge.js";
import { PagesAgents } from "./engine/pages-agents.js";
import { KnowledgeAgents } from "./engine/knowledge-agents.js";
import { UsageLedger } from "./engine/usage-ledger.js";
import { ANALYTICS_SCHEME, WorkspaceAnalytics } from "./workspace-analytics.js";
import { WorkspaceBrowser } from "./workspace-browser.js";
import { BrowserTools } from "./browser-tools.js";
import { ThreadContextReader } from "./engine/thread-context.js";
import { cliHealth, resolveCli } from "./engine/cli-path.js";
import { THEMES } from "../shared/theme.js";
import { knowledgeAppearance } from "./knowledge-theme.js";
import { ReleaseChecker } from "./engine/updates.js";
import { EventJournal } from "./engine/event-journal.js";
import { app, autoUpdater, BrowserWindow, clipboard, dialog, ipcMain, protocol, shell, nativeTheme, safeStorage, screen, Menu, MenuItem } from "electron";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Store } from "./engine/store.js";
import { saveSettings } from "./engine/settings-update.js";
import { ThreadRunner } from "./engine/runner.js";
import { WorkOSAuth, workosConfig } from "./engine/workos-auth.js";
import { ChatGPTAuth } from "./engine/chatgpt-auth.js";
import { AccountCodexBackend } from "./engine/backends/account-codex.js";
import { ClaudeLogin } from "./engine/claude-login.js";
import * as gitx from "./engine/git.js";
import { listWorkspaceFiles, readWorkspaceFile } from "./engine/workspace-files.js";
import { runDemo } from "./engine/demo.js";
import { openTerminal } from "./engine/open-terminal.js";
import { TerminalManager, isTrustedTerminalSender } from "./engine/terminal.js";
import { SecretStore, electronCipher, testCipher } from "./engine/secrets.js";
import { hydratePath } from "./engine/shell-env.js";
import { initialBounds, readWindowState, writeWindowState } from "./engine/window-state.js";
import { CompanionServer } from "./engine/companion.js";
import { TaskRetirer } from "./engine/retire.js";
import { DesktopHost } from "./engine/desktop-host.js";
import { createDesktopHostActivation } from "./engine/desktop-host-activation.js";
import { desktopSystem } from "./engine/desktop-discovery.js";
import QRCode from "qrcode";
import type { BackendId, BridgeCommands, CompanionStatus, ThreadEvent } from "../shared/types.js";
import { describeFailure } from "../shared/failures.js";
import { previewApproval, validateRules } from "./engine/approvals/preview.js";
import { registerAttachmentCommands } from "./attachment-commands.js";
import { AttachmentStore } from "./engine/attachments.js";
import { LIMITS } from "../shared/attachments.js";
import { ATTACHMENT_SCHEME, relFromUrl } from "../shared/attachments.js";
import { NOTES_SCHEME, pageImageFromUrl } from "../shared/notes.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(1);
const flag = (name: string): string | undefined => {
  const hit = argv.find((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return undefined;
  return hit.includes("=") ? hit.slice(hit.indexOf("=") + 1) : "true";
};

const demo = flag("demo");
const screenshotDir = flag("screenshot");
// Electron resolves app.getName() from the packaged metadata, which can still be the
// shared Modex product name even when this bundle is the signed Host Preview. The
// executable path is stable for this companion bundle and keeps the host self-starting
// when it is opened directly from Finder or by the Store client.
const hostPreview = app.isPackaged && (app.getName() === "Modex Host Preview" || /Modex Host Preview\.app[\\/]/.test(process.execPath));
const hostPreviewHome = path.join(os.homedir(), "Library", "Application Support", "Modex Host Preview");
const home = demo ? fs.mkdtempSync(path.join(os.tmpdir(), "modex-demo-")) : process.env.MODEX_HOME ?? (hostPreview ? hostPreviewHome : path.join(os.homedir(), ".modex"));
fs.mkdirSync(home, { recursive: true });
// Attachment thumbnails load from main over this scheme; registration must precede app ready.
protocol.registerSchemesAsPrivileged([
  { scheme: ATTACHMENT_SCHEME, privileges: { standard: true, secure: true } },
  { scheme: NOTES_SCHEME, privileges: { standard: true, secure: true } },
  { scheme: CANVAS_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  { scheme: ANALYTICS_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
// The scripted demo and screenshots must never discover a real Jev key or call the network.
if (demo) {
  process.env.TYPESAFE_API_KEY = "";
  process.env.JEV_API_KEY = "";
  process.env.JEV_CONFIG = path.join(home, "no-jev-config.json");
  process.env.MODEX_NO_LOGIN_PATH = "1";
}
// An isolated home (e2e, demo) also gets its own Chromium profile, so renderer preferences in
// localStorage (panel layout) and window-state.json never leak between runs or into the user's real app.
if (demo || process.env.MODEX_HOME) app.setPath("userData", path.join(home, "electron"));

if (!demo && !app.requestSingleInstanceLock()) app.exit(0);

// A Finder/Dock launch inherits launchd's minimal PATH, which hides claude, codex, and jev.
// Resolve the user's login-shell PATH once, in the background, and make every channel that
// spawns a CLI wait for it (see SPAWNS below) so the first turn never races it.
const pathReady = hydratePath(process.env).then(
  (r) => { if (r.via === "none") console.error("[modex] could not read the login-shell PATH; using", r.merged); return r; },
  (err: Error) => { console.error("[modex] login-shell PATH failed:", err.message); return null; },
);

process.env.MODEX_VERSION ??= app.getVersion();
const store = new Store(home);
const restartAdmission = new RestartAdmission();
const knowledge = new KnowledgeService(home, { notesFolder: () => store.space.root });
const knowledgeAgents = new KnowledgeAgents({
  knowledge, enabled: id => store.project(id)?.knowledgeMaintenance === true,
  // A knowledge base that is the notes folder holds every project's notes; each project's agents stay in theirs.
  scope: (id, folder) => {
    let notes: string;
    try { notes = fs.realpathSync(store.space.root); } catch { return undefined; }
    const project = store.project(id);
    return folder === notes && project ? store.space.linkProject(project).rel : undefined;
  },
});
const pagesAgents = new PagesAgents({
  space: store.space, notes: store.space, enabled: id => store.project(id)?.pagesMaintenance === true,
  // Each project's agents work in that project's notes only (docs/pages-maintenance.md).
  scope: id => { const project = store.project(id); if (!project) return undefined; const notes = store.space.linkProject(project); return { id: notes.id, rel: notes.rel }; },
});
const threadContexts = new ThreadContextReader({ enabled: !demo && !process.env.MODEX_E2E });
const updates = new ReleaseChecker({
  currentVersion: app.getVersion(), platform: process.platform, arch: process.arch,
  enabled: app.isPackaged && !demo && !process.env.MODEX_E2E,
});
let win: BrowserWindow | null = null;
let workspaceCanvas: WorkspaceCanvas | null = null;
let workspaceBrowser: WorkspaceBrowser | null = null;
let browserTools: BrowserTools | null = null;
let knowledgeBrowser: WorkspaceBrowser | null = null;
let workspaceAnalytics: WorkspaceAnalytics | null = null;
let knowledgeURL: string | null = null;
let shuttingDown = false;
let servicesTouched = false;
let shutdownComplete = false;
let checkingWindowClose = false;
let desktopHost: DesktopHost | undefined;
const desktopHostActivation = createDesktopHostActivation({
  available: () => !demo && !shuttingDown && !servicesTouched && !checkingWindowClose && !restartAdmission.held && !nativeDraftFailure && !nativeStartup?.recovery,
  start: startDesktopHost,
  onError: (error) => console.error("[modex] desktop host activation failed:", error),
});
// macOS can deliver this event before ready. Register synchronously, then wait until
// normal window initialization completes. App Sandbox does not forward launch arguments.
app.on("open-url", (event, url) => {
  if (desktopHostActivation.open(url)) event.preventDefault();
});
// Routines Phase 0 event journal, off by default (docs/event-journal.md). It records alongside the
// authoritative state files; a failure turns the journal off and never affects a turn.
let journal: EventJournal | undefined;
if (process.env.MODEX_EVENT_JOURNAL === "1") {
  try { journal = new EventJournal(path.join(home, "app", "events.sqlite")); }
  catch (error) { console.error("[modex] event journal unavailable:", error); }
}
const journalEvent = (event: ThreadEvent): void => {
  if (!journal) return;
  try { journal.record(event); }
  catch (error) {
    console.error("[modex] event journal stopped:", error);
    try { journal.close(); } catch { /* Already failing; the state files remain authoritative. */ }
    journal = undefined;
  }
};
const emit = (event: ThreadEvent): void => {
  journalEvent(event);
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("thread:event", event);
  desktopHost?.broadcast("thread", event);
};
// The e2e harness has no keychain to unlock; everything else goes through the OS keychain.
const secrets = new SecretStore(home, process.env.MODEX_E2E ? testCipher : electronCipher(safeStorage));
// Settings reads ChatGPT status in packaged e2e too; keep its test home off the OS keychain.
const osCipher = process.env.MODEX_E2E ? testCipher : electronCipher(safeStorage);
const chatgptCipher = { ...osCipher, available: () => osCipher.available() && (process.platform !== "linux" || safeStorage.getSelectedStorageBackend() !== "basic_text") };
const modexAccount = new WorkOSAuth({ home, cipher: chatgptCipher, config: workosConfig(process.env.MODEX_WORKOS_ENV), openBrowser: (url) => shell.openExternal(url) });
const chatgpt = new ChatGPTAuth({ home, cipher: chatgptCipher, openBrowser: (url) => shell.openExternal(url) });
const sessionCliSettings = store.settings;
const accountCodex = new AccountCodexBackend(chatgpt, () => resolveCli("codex", sessionCliSettings.codex_bin));
process.env.MODEX_VERSION = app.getVersion();
const attachments = new AttachmentStore(path.join(home, "attachments"), {
  authorizeDraft: owner => owner.kind === "project" ? !!store.project(owner.projectId) : !!store.thread(owner.threadId) && !store.thread(owner.threadId)!.retired,
  authorizeTransfer: (owner, threadId) => owner.kind === "thread" ? owner.threadId === threadId : store.thread(threadId)?.projectId === owner.projectId,
});
// Install preservation before any cleanup. NativeDrafts replays sealed ownership
// before startup inspection can update the installed-version receipt.
attachments.setRecoveryRetention(null);
const usageLedger = new UsageLedger(store.dir);
const runner = new ThreadRunner({ home, store, emit, secrets, knowledge: knowledgeAgents, pages: pagesAgents, usage: usageLedger, backends: { codex: accountCodex }, attachments, beforeDeleteThread: (id) => terminals.close(id), withOwnerRemoval });
let nativeDrafts: NativeDrafts | undefined;
let nativeDraftFailure: string | undefined;
let nativeStartup: ReturnType<typeof readUpdateStartup> | undefined;
let restartCoordinator: UpdateRestartCoordinator | undefined;
if (process.platform !== "win32" && !demo) {
  try {
    nativeDrafts = new NativeDrafts({ store, runner, attachments });
    nativeStartup = readUpdateStartup(nativeDrafts.recovery, app.getVersion());
  } catch (error) {
    nativeDraftFailure = error instanceof Error ? error.message : "Native draft recovery is unavailable.";
    attachments.setRecoveryRetention(null);
  }
} else attachments.setRecoveryRetention([]);
// Native document opening establishes strict durable retention. A failed startup
// stays preserve-all; Windows/demo keep their existing unbound staging cleanup.
if (!nativeDrafts && !nativeDraftFailure) attachments.sweepStaging();
let documentEpoch = 0;
let nativeDocument: { frame: unknown; epoch: number; session: string } | undefined;
let readOnlyDocument: { frame: unknown; epoch: number } | undefined;
type RecoveryQuitOperation = { document: NonNullable<typeof nativeDocument>; promise: Promise<void> };
let recoveryQuitOperation: RecoveryQuitOperation | undefined;
const rendererPreflight = new DocumentRestartPreflight(() => nativeDocument, (_document, request) => {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) throw new Error("The workspace is unavailable.");
  win.webContents.send("updates:prepare", request);
});
const recoveryQuitPreflight = new DocumentRestartPreflight(() => nativeDocument, (_document, request) => {
  if (!win || win.isDestroyed() || win.webContents.isDestroyed()) throw new Error("The workspace is unavailable.");
  win.webContents.send("updates:prepare-quit", request);
});
const ownerRemoval = new OwnerRemoval({
  current: () => nativeDocument,
  send: (_document, request) => {
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) throw new Error("The workspace is unavailable.");
    win.webContents.send(request.phase === "prepare" ? "drafts:remove-prepare" : "drafts:remove-adopt", {
      id: request.id, type: request.type, payload: request.phase === "prepare" ? request.scope : request.result,
    });
  },
  // Do not hold TaskRetirer here: retirement itself runs inside its sweep.
  holds: [() => restartAdmission.holdForRestart(), () => runner.holdForOwnerRemoval(), () => nativeDrafts!.holdForOwnerRemoval()],
  prune: (scope, revision) => nativeDrafts!.pruneEmptyOwner(scope, revision),
  snapshot: () => store.snapshot(),
  requiresRecovery: () => Boolean(nativeDrafts?.requiresRecovery),
  recover: error => {
    nativeDraftFailure = `Owner removal could not be confirmed: ${error.message}`;
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("drafts:remove-recovery", nativeDraftFailure);
  },
});
async function withOwnerRemoval(scope: DraftRemovalScope, operation: () => Promise<void>): Promise<void> {
  const recovery = currentDraftRecovery();
  if (recovery) throw new Error(recovery.message);
  if (!nativeDrafts) return restartAdmission.run(operation);
  return ownerRemoval.run(scope, operation);
}
function invalidateNativeDocument(): void {
  ownerRemoval.invalidate();
  rendererPreflight.invalidate();
  recoveryQuitPreflight.invalidate(); recoveryQuitOperation = undefined;
  documentEpoch++; nativeDocument = undefined; readOnlyDocument = undefined; nativeDrafts?.invalidate();
}
ipcMain.on("updates:prepared", (event, reply) => {
  if (!isTrustedTerminalSender(event, win) || !nativeDocument || nativeDocument.frame !== event.senderFrame || nativeDocument.epoch !== documentEpoch) return;
  rendererPreflight.reply(nativeDocument, reply);
});
ipcMain.on("updates:quit-prepared", (event, reply) => {
  if (!isTrustedTerminalSender(event, win) || !nativeDocument || nativeDocument.frame !== event.senderFrame || nativeDocument.epoch !== documentEpoch) return;
  recoveryQuitPreflight.reply(nativeDocument, reply);
});
for (const [channel, phase] of [["drafts:remove-prepared", "prepare"], ["drafts:remove-adopted", "adopt"]] as const) {
  ipcMain.on(channel, (event, reply) => {
    if (!isTrustedTerminalSender(event, win) || !nativeDocument || nativeDocument.frame !== event.senderFrame || nativeDocument.epoch !== documentEpoch) return;
    ownerRemoval.reply(nativeDocument, { ...reply, phase });
  });
}
const retirer = new TaskRetirer({
  enabled: () => store.settings.auto_retire,
  threads: () => store.snapshot().threads,
  busy: (id) => runner.status(id) !== "idle",
  context: (cwd) => threadContexts.read(cwd),
  inspect: (cwd) => gitx.worktreeState(cwd),
  retire: (id, pr) => runner.retireThread(id, pr),
});
const companion = new CompanionServer(home, {
  state: () => store.snapshot(),
  pullRequest: (id) => retirer.pullRequest(id),
  setApprovals: (id, approvals) => { restartAdmission.assertOpen(); if (currentDraftRecovery()) throw new Error("Draft recovery is required."); runner.updateThread(id, { approvals }); },
  setArchived: (id, archived) => { restartAdmission.assertOpen(); if (currentDraftRecovery()) throw new Error("Draft recovery is required."); runner.setArchived(id, archived); },
  items: (id) => runner.items(id),
  status: (id) => runner.status(id),
  create: (projectId, options) => restartAdmission.run(async () => {
    if (currentDraftRecovery()) throw new Error("Draft recovery is required.");
    await pathReady;
    if (currentDraftRecovery()) throw new Error("Draft recovery is required.");
    return runner.createThread(projectId, options);
  }),
  send: (id, text) => restartAdmission.run(async () => {
    if (currentDraftRecovery()) throw new Error("Draft recovery is required.");
    await pathReady;
    if (currentDraftRecovery()) throw new Error("Draft recovery is required.");
    return startTurn(id, runner.send(id, text));
  }),
  answer: (id, itemId, answer) => { restartAdmission.assertOpen(); if (currentDraftRecovery()) throw new Error("Draft recovery is required."); return runner.answer(id, itemId, answer); },
});
const companionView = async (status: CompanionStatus): Promise<CompanionStatus> => {
  const endpoints = await Promise.all((status.endpoints ?? []).map(async (endpoint) => ({
    ...endpoint,
    qrDataUrl: await QRCode.toDataURL(endpoint.pairingUri, { width: 360, margin: 2, color: { dark: "#17191d", light: "#ffffff" } }),
  })));
  return { ...status, ...(endpoints.length ? { endpoints, qrDataUrl: endpoints[0]!.qrDataUrl } : {}) };
};

type NativeIPCEvent = Pick<IpcMainInvokeEvent, "sender" | "senderFrame">;
type Handler<K extends keyof BridgeCommands> = (req: BridgeCommands[K]["req"], event?: NativeIPCEvent) => Promise<BridgeCommands[K]["res"]> | BridgeCommands[K]["res"];
/** Channels that can start a CLI (claude, codex, jev, a project's worktree script). */
const SPAWNS = new Set<keyof BridgeCommands>(["drafts:create", "drafts:send", "knowledge:install", "knowledge:start", "settings:update", "thread:create", "thread:send", "thread:retry", "thread:followup", "terminal:open", "models:list", "backends:health", "routing:status", "routing:reset", "routing:setKey", "routing:clearKey", "routing:test", "approvals:try"]);
const desktopCommands = new Map<string, (payload: unknown, authorized: () => boolean) => unknown>();

// These operations persist preflight drafts or control the restart itself.
// They must not count as work which prevents their own restart admission.
const RESTART_CONTROL = new Set<string>(["state:get", "drafts:save", "drafts:pending", "updates:check", "updates:state", "updates:install", "updates:cancel", "updates:quit", "updates:recovery-folder"]);
// These acquire their own admission fence before awaiting renderer preparation.
const OWNER_REMOVAL_CONTROL = new Set<string>(["thread:delete", "project:remove"]);
function handle<K extends keyof BridgeCommands>(channel: K, fn: Handler<K>, options: { localOnly?: boolean } = {}): void {
  const invoke = (req: BridgeCommands[K]["req"], event?: NativeIPCEvent, authorized?: () => boolean) => {
    const epoch = documentEpoch;
    const recoveryPersistence = () => Boolean(channel === "space:save" && restartAdmission.held && event && nativeDocument
      && nativeDocument.frame === event.senderFrame && nativeDocument.epoch === epoch && recoveryQuitPreflight.allowsPersistence(nativeDocument));
    const check = () => {
      if (shuttingDown) throw new Error("Modex is shutting down.");
      if (authorized && authorized() !== true) throw new Error("Desktop host access is unavailable.");
      if (event && (!isTrustedTerminalSender(event, win) || epoch !== documentEpoch)) throw new Error("Untrusted or stale app request.");
      const recovery = currentDraftRecovery();
      if (recovery && !["state:get", "drafts:open", "updates:state", "updates:check", "updates:quit", "updates:recovery-folder"].includes(channel) && !recoveryPersistence()) {
        throw new Error(recovery.message);
      }
    };
    const run = async () => {
      check();
      if (SPAWNS.has(channel)) await pathReady;
      check();
      return fn(req, event);
    };
    // Claim admission before PATH or any other asynchronous operation can yield.
    const preparationSave = restartAdmission.held && channel === "space:save" && event
      && nativeDocument?.frame === event.senderFrame && nativeDocument.epoch === epoch
      && (rendererPreflight.allowsPersistence(nativeDocument) || ownerRemoval.allowsPersistence(nativeDocument));
    // Deletion drains a running CLI; another Stop must still be able to force it.
    const removalStop = channel === "thread:stop" && ownerRemoval.active;
    const recoveryRead = channel === "drafts:open" && Boolean(currentDraftRecovery());
    return RESTART_CONTROL.has(channel) || OWNER_REMOVAL_CONTROL.has(channel) || preparationSave || removalStop || recoveryRead || recoveryPersistence() ? run() : restartAdmission.run(run);
  };
  if (!options.localOnly) desktopCommands.set(channel, (payload, authorized) => invoke(payload as BridgeCommands[K]["req"], undefined, authorized));
  ipcMain.handle(channel, (event, req) => invoke(req as BridgeCommands[K]["req"], event));
}

function nativeFor(request: { session: string }, event?: NativeIPCEvent): NativeDrafts {
  if (!event || !isTrustedTerminalSender(event, win) || !nativeDrafts || !nativeDocument
    || nativeDocument.frame !== event.senderFrame || nativeDocument.epoch !== documentEpoch || nativeDocument.session !== request?.session) {
    throw new Error("The native draft document is no longer available.");
  }
  return nativeDrafts;
}
function currentDraftRecovery(): UpdateStartupRecovery | null {
  if (nativeDraftFailure) return { outcome: "unreadable", message: `${nativeDraftFailure} Original recovery files have been preserved. Quit and repair or restore them before continuing.` };
  const phase = restartCoordinator?.state;
  if (servicesTouched || (phase && !["idle", "preparing"].includes(phase))) {
    return nativeDrafts ? readUpdateStartup(nativeDrafts.recovery, app.getVersion(), phase && !["idle", "preparing"].includes(phase) ? phase : "recovery").recovery
      : { outcome: "recovery", message: "Modex has started shutting down. Quit and reopen Modex before continuing." };
  }
  return nativeStartup?.recovery ?? null;
}
// Explicitly local-only: paired desktop commands never receive document sessions.
handle("drafts:open", (_req, event) => {
  if (!event || !isTrustedTerminalSender(event, win)) throw new Error("Untrusted app request.");
  const recovery = currentDraftRecovery();
  if (recovery) {
    nativeDrafts?.invalidate(); nativeDocument = undefined;
    readOnlyDocument = { frame: event.senderFrame, epoch: documentEpoch };
    try {
      const saved = nativeDrafts?.readOnly() ?? { drafts: new UpdateRecovery(store.dir).read().drafts, pending: [] };
      return { readOnly: true as const, ...saved, pendingIds: [] as [], recovery };
    } catch {
      return { readOnly: true as const, drafts: null, pendingIds: [] as [], pending: [],
        recovery: { outcome: "unreadable" as const, message: "Some recovery data could not be read. Original files have been preserved. Quit and repair or restore them before continuing." } };
    }
  }
  if (!nativeDrafts) return null;
  const opened = nativeDrafts.open();
  readOnlyDocument = undefined;
  nativeDocument = { frame: event.senderFrame, epoch: documentEpoch, session: opened.session };
  attachments.sweepStaging();
  return opened;
}, { localOnly: true });
handle("drafts:save", (req, event) => nativeFor(req, event).save(req.session, req), { localOnly: true });
handle("drafts:stage", (req, event) => nativeFor(req, event).stage(req.session, req.owner, req.files), { localOnly: true });
handle("drafts:pick", async (req, event) => {
  let omitted = 0;
  const picked = await nativeFor(req, event).pick(req.session, req.owner, req.remaining, async () => {
    const result = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"], title: "Attach files", buttonLabel: "Attach" });
    if (result.canceled) return [];
    omitted = Math.max(0, result.filePaths.length - req.remaining);
    return result.filePaths.slice(0, req.remaining);
  });
  if (omitted) picked.errors.push(`Up to ${LIMITS.perTurn} attachments per message; ${omitted} left out.`);
  return picked;
}, { localOnly: true });
handle("drafts:discard", (req, event) => nativeFor(req, event).discard(req.session, req.owner, req.ids), { localOnly: true });
handle("drafts:retire", (req, event) => nativeFor(req, event).retire(req.session, req.owner), { localOnly: true });
handle("drafts:begin", (req, event) => nativeFor(req, event).begin(req.session, req.input), { localOnly: true });
handle("drafts:create", (req, event) => nativeFor(req, event).create(req.session, req.intentId), { localOnly: true });
handle("drafts:transfer", (req, event) => nativeFor(req, event).transfer(req.session, req), { localOnly: true });
handle("drafts:pending", (req, event) => {
  const record = nativeFor(req, event).readPending(req.session, req.intentId);
  if (!record) return null;
  const { creation: _mainOnly, ...view } = record;
  return view;
}, { localOnly: true });
handle("drafts:send", (req, event) => {
  const controller = nativeFor(req, event), record = controller.readPending(req.session, req.intentId);
  if (!record?.target) throw new Error("The pending message has no target thread.");
  return startTurn(record.target.threadId, controller.send(req.session, req.intentId));
}, { localOnly: true });
ipcMain.on("drafts:close-save", (event, req) => {
  try {
    if (shuttingDown || nativeDraftFailure || nativeStartup?.recovery) throw new Error("Draft recovery is unavailable.");
    event.returnValue = nativeFor(req, event).save(req.session, req);
  } catch { event.returnValue = { saved: false, revision: 0 }; }
});

function cwdFor(threadId: string): string {
  const t = store.thread(threadId);
  if (!t) throw new Error(`unknown thread ${threadId}`);
  return t.cwd;
}

/** Embedded shells, one per thread, started in the thread's working directory. */
const terminals = new TerminalManager(
  (id) => { runner.assertThreadAvailable(id); return cwdFor(id); },
  (event) => {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("terminal:event", event);
    desktopHost?.broadcast("terminal", event);
  },
  undefined,
  process.env.MODEX_E2E ? { ...process.env, BASH_SILENCE_DEPRECATION_WARNING: "1" } : process.env,
  // e2e types into the shell: a plain bash, not the user's login shell and its rc files.
  process.env.MODEX_E2E ? { file: "/bin/bash", args: ["--noprofile", "--norc"] } : undefined,
);

let servicesDrained = false;
let drainingServices: Promise<void> | undefined;
function drainServices(): Promise<void> {
  if (servicesDrained) return Promise.resolve();
  if (drainingServices) return drainingServices;
  servicesTouched = true;
  modexAccount.cancel(); chatgpt.cancel(); claudeLogin.cancel(); retirer.stop();
  drainingServices = (async () => {
    // Start every disposer even if another throws before returning its promise.
    const operations = [() => pagesAgents.dispose(), () => knowledgeAgents.dispose().then(() => knowledge.dispose()),
      () => desktopHost?.dispose(), () => companion.dispose(), () => terminals.dispose(), () => runner.dispose()];
    const results = await Promise.allSettled(operations.map(dispose => Promise.resolve().then(dispose)));
    modexAccount.dispose(); chatgpt.dispose();
    try { journal?.close(); } catch (error) { console.error("[modex] event journal close failed:", error); }
    journal = undefined;
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    servicesDrained = true;
  })().finally(() => { drainingServices = undefined; });
  return drainingServices;
}
// Main-owned update lifecycle.
const automaticUpdates = Boolean(app.isPackaged && process.platform === "darwin" && ["arm64", "x64"].includes(process.arch)
  && !demo && !process.env.MODEX_E2E && !hostPreview && nativeDrafts && !nativeDraftFailure && !nativeStartup?.recovery);
const updateInstallation = new UpdateInstallation({
  enabled: automaticUpdates, parent: path.join(home, "updates"),
  runningApp: path.resolve(path.dirname(process.execPath), "../.."), arch: process.arch === "x64" ? "x64" : "arm64",
  checker: updates,
  changed: state => {
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) win.webContents.send("updates:state", state);
  },
  restart: candidate => {
    if (!restartCoordinator) throw new Error("Automatic installation is unavailable.");
    return restartCoordinator.restart(candidate);
  },
});
if (automaticUpdates) {
  const native = new MacUpdateHandoff(autoUpdater, state => restartCoordinator?.observeNative(state));
  restartCoordinator = new UpdateRestartCoordinator({
    currentVersion: app.getVersion(), recovery: nativeDrafts!.recovery, native,
    holds: [() => restartAdmission.holdForRestart(), () => runner.holdForRestart(), () => terminals.holdForRestart(),
      () => retirer.holdForRestart(), () => nativeDrafts!.holdForRestart(), () => {
        // Guest content has its own editor state. Closing it is an explicit user
        // decision; app draft persistence cannot acknowledge unsaved guest forms.
        if (workspaceBrowser?.hasOpenPages || workspaceCanvas?.hasOpenPages || knowledgeBrowser?.hasOpenPages) {
          throw new Error("Close Browser, Canvas and Knowledge pages before restarting to protect unsaved work.");
        }
        return () => {};
      }],
    prepareRenderer: () => rendererPreflight.prepare(), assertRendererPrepared: () => rendererPreflight.assertPrepared(),
    releaseRenderer: () => rendererPreflight.release(), drainServices,
    changed: state => updateInstallation.observeRestart(state), quitAndInstall: () => autoUpdater.quitAndInstall(),
  });
}
function updateState(): UpdateInstallState {
  const state = updateInstallation.state(), recovery = currentDraftRecovery();
  // An in-flight handoff must not become an actionable recovery screen. Its
  // coordinator will publish a terminal outcome after the native boundary settles.
  if (!recovery || state.phase === "preparing") return state;
  return { ...state, phase: recovery.outcome === "staged" || recovery.outcome === "uncertain" ? recovery.outcome : "recovery",
    installable: false, canRestart: restartCoordinator?.state === "staged", message: recovery.message };
}

handle("canvas:open", ({ id, threadId, path }) => {
  if (!workspaceCanvas) throw new Error("Canvas unavailable.");
  return workspaceCanvas.open(id, cwdFor(threadId), path);
}, { localOnly: true });
handle("canvas:state", ({ id, reload }) => {
  if (!workspaceCanvas) throw new Error("Canvas unavailable.");
  return workspaceCanvas.state(id, reload);
}, { localOnly: true });
handle("canvas:show", ({ id, bounds, fullView }) => workspaceCanvas?.show(id, bounds, fullView), { localOnly: true });
handle("canvas:close", ({ id }) => workspaceCanvas?.close(id), { localOnly: true });

handle("browser:command", ({ id, action, url }) => {
  if (!workspaceBrowser) throw new Error("Browser unavailable.");
  return workspaceBrowser.command(id, action, url);
}, { localOnly: true });
handle("browser:show", ({ id, bounds, fullView }) => workspaceBrowser?.show(id, bounds, fullView), { localOnly: true });
const browserToolsReady = () => { if (!browserTools) throw new Error("Browser tools unavailable."); return browserTools; };
handle("browser:extensions", () => browserToolsReady().snapshot(), { localOnly: true });
handle("browser:extensionInstall", () => browserToolsReady().install(), { localOnly: true });
handle("browser:extensionUpdate", ({ id, action }) => browserToolsReady().update(id, action), { localOnly: true });
handle("browser:fillLogin", async ({ id }) => { await pathReady; return browserToolsReady().fill(id); }, { localOnly: true });
handle("browser:external", ({ id }) => browserToolsReady().external(id), { localOnly: true });

// The companion owns its local server. Only this window can install, select folders, or show it.
handle("knowledge:state", () => knowledge.snapshot(), { localOnly: true });
handle("project:pages", ({ projectId, enabled }) => store.setPagesMaintenance(projectId, enabled), { localOnly: true });
handle("space:history", ({ id }) => store.space.history(id));
handle("space:revert", ({ id, revision, version }) => store.space.revert(id, revision, version));
handle("project:knowledge", ({ projectId, enabled }) => store.setKnowledgeMaintenance(projectId, enabled), { localOnly: true });
handle("knowledge:open", async change => { await pathReady; await shell.openExternal(await knowledgeAgents.preview(change)); }, { localOnly: true });
handle("knowledge:choose", async () => {
  const result = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], title: "Choose knowledge folder", buttonLabel: "Use this folder" });
  return result.canceled || !result.filePaths[0] ? knowledge.snapshot() : knowledge.selectFolder(result.filePaths[0]);
}, { localOnly: true });
handle("knowledge:install", () => knowledge.install(), { localOnly: true });
// One set of files: the knowledge base opens Modex's notes folder (made first if needed).
handle("knowledge:useNotes", () => { store.space.list(); return knowledge.selectFolder(store.space.root); }, { localOnly: true });
handle("knowledge:start", () => knowledge.start(), { localOnly: true });
handle("knowledge:stop", async () => {
  knowledgeBrowser?.dispose(); knowledgeURL = null;
  return knowledge.stop();
}, { localOnly: true });
handle("knowledge:show", async ({ bounds }) => {
  const state = knowledge.snapshot();
  if (!bounds || state.status !== "ready" || !state.url) { knowledgeBrowser?.show(null); return null; }
  if (!knowledgeBrowser) throw new Error("Knowledge view unavailable.");
  if (knowledgeURL !== state.url) {
    await knowledgeBrowser.command("knowledge", "navigate", state.url);
    knowledgeURL = state.url;
  }
  knowledgeBrowser.show("knowledge", bounds);
  return knowledgeBrowser.command("knowledge", "state");
}, { localOnly: true });
handle("knowledge:reload", () => knowledgeBrowser?.command("knowledge", "reload") ?? null, { localOnly: true });
handle("knowledge:external", async () => {
  const state = knowledge.snapshot();
  if (state.status !== "ready" || !state.url) throw new Error("Open your knowledge base first.");
  await shell.openExternal(state.url);
}, { localOnly: true });
handle("knowledge:copy", ({ pageId }) => {
  const page = store.space.list().find(page => page.id === pageId && !page.trashedAt);
  if (!page) throw new Error("This page is no longer available.");
  return knowledge.copyPage(page);
}, { localOnly: true });

function requireReadOnlyRecoveryDocument(event?: NativeIPCEvent): void {
  assertRecoveryQuitReady();
  if (!currentDraftRecovery() || !event || !isTrustedTerminalSender(event, win) || nativeDocument || !readOnlyDocument
    || readOnlyDocument.frame !== event.senderFrame || readOnlyDocument.epoch !== documentEpoch) {
    throw new Error("The read-only recovery document is no longer available.");
  }
}
function requireRecoveryEditingDocument(event?: NativeIPCEvent): NonNullable<typeof nativeDocument> {
  assertRecoveryQuitReady();
  if (!currentDraftRecovery() || !event || !isTrustedTerminalSender(event, win) || readOnlyDocument || !nativeDrafts || !nativeDocument
    || nativeDocument.frame !== event.senderFrame || nativeDocument.epoch !== documentEpoch) {
    throw new Error("The recovery editing document is no longer available.");
  }
  return nativeDocument;
}
function assertRecoveryQuitReady(): void {
  if (restartCoordinator && ["preparing", "draining", "staging"].includes(restartCoordinator.state)) {
    throw new Error("Modex is still preparing the update. Wait for it to finish before quitting.");
  }
}
function releaseRecoveryQuit(): void {
  recoveryQuitOperation = undefined;
  recoveryQuitPreflight.release();
}
function requestRecoveryQuit(event?: NativeIPCEvent): Promise<void> {
  const document = requireRecoveryEditingDocument(event);
  if (recoveryQuitOperation) {
    if (recoveryQuitOperation.document !== document) throw new Error("The recovery document changed.");
    return recoveryQuitOperation.promise;
  }
  const operation: RecoveryQuitOperation = { document, promise: Promise.resolve().then(async () => {
    if (recoveryQuitOperation !== operation || requireRecoveryEditingDocument(event) !== document) throw new Error("The recovery document changed.");
    const revision = await recoveryQuitPreflight.prepare();
    if (recoveryQuitOperation !== operation || requireRecoveryEditingDocument(event) !== document) throw new Error("The recovery document changed.");
    recoveryQuitPreflight.assertPrepared();
    nativeDrafts!.recovery.validateRecoveryClose(revision);
    // Keep this proof until actual close or will-prevent-unload, not just until
    // app.quit returns. The renderer can still revoke it in beforeunload.
    app.quit();
  }).catch(error => {
    if (recoveryQuitOperation === operation) releaseRecoveryQuit();
    throw error;
  }) };
  recoveryQuitOperation = operation;
  return operation.promise;
}
handle("updates:check", async () => automaticUpdates ? (await updateInstallation.check()).release : updates.check());
handle("updates:state", (_req, event) => {
  const state = updateState();
  // Windows has no native draft capability. A trusted local state read still
  // binds ordinary recovery controls after service disposal, without granting
  // any editing authority or bypassing the window's beforeunload checks.
  if (!nativeDrafts && !nativeDraftFailure && currentDraftRecovery() && event && isTrustedTerminalSender(event, win)) {
    readOnlyDocument = { frame: event.senderFrame, epoch: documentEpoch };
  }
  return state;
}, { localOnly: true });
handle("updates:download", () => updateInstallation.download(), { localOnly: true });
handle("updates:cancel", () => updateInstallation.cancel(), { localOnly: true });
handle("updates:install", () => updateInstallation.install(), { localOnly: true });
handle("updates:quit", (_req, event) => {
  if (!readOnlyDocument) return requestRecoveryQuit(event);
  requireReadOnlyRecoveryDocument(event);
  // Keep normal beforeunload handling: this never bypasses unsaved editors.
  setImmediate(() => app.quit());
}, { localOnly: true });
handle("updates:recovery-folder", async (_req, event) => {
  requireReadOnlyRecoveryDocument(event);
  const error = await shell.openPath(store.dir);
  if (error) throw new Error(error);
}, { localOnly: true });
handle("space:export", async ({ pageId }) => {
  const page = store.space.list().find(page => page.id === pageId && !page.trashedAt);
  if (!page) throw new Error("This page is no longer available.");
  const title = page.title.trim() || "Untitled page";
  const result = await dialog.showSaveDialog(win!, { title: "Export Markdown", defaultPath: `${title.replace(/[^\p{L}\p{N}\s_-]/gu, "").trim() || "Untitled page"}.md`, filters: [{ name: "Markdown", extensions: ["md"] }] });
  if (result.canceled || !result.filePath) return null;
  await fs.promises.writeFile(result.filePath, `# ${title}\n\n${page.markdown}\n`, { mode: 0o600 });
  return result.filePath;
}, { localOnly: true });
handle("space:list", () => store.space.list());
handle("space:comments", ({ pageId }) => store.space.comments(pageId));
handle("space:comment:add", ({ pageId, text, quote }) => store.space.addComment(pageId, text, quote));
handle("space:comment:delete", ({ pageId, id }) => store.space.deleteComment(pageId, id));
handle("space:create", (input) => store.space.create(input));
handle("space:save", (page) => store.space.save(page));
handle("space:trash", ({ id, trash }) => store.space.trash(id, trash));
handle("notes:settle", ({ id }) => store.space.settle(id));
handle("notes:tree", (req) => { const tree = store.space.tree(); return req?.since === tree.version ? { unchanged: true as const, version: tree.version } : tree; });
handle("notes:workspace:create", ({ name }) => store.space.createWorkspace(name));
handle("notes:project:create", ({ workspaceId, name }) => store.space.createProject(workspaceId, name));
handle("notes:folder:create", ({ parentId, name }) => store.space.createFolder(parentId, name));
handle("notes:rename", ({ id, name }) => store.space.rename(id, name));
handle("notes:move", ({ ids, targetId }) => { store.space.moveNodes(ids, targetId); return store.space.tree(); });
handle("notes:delete", ({ id }) => { store.space.deleteEmpty(id); return store.space.tree(); });
handle("notes:workspaces", () => store.space.workspaces());
handle("project:notes", ({ projectId }) => { const project = store.project(projectId); if (!project) throw new Error("This project is no longer in Modex."); return store.space.linkProject(project); });
handle("project:workspace", ({ projectId, workspaceId }) => { const project = store.project(projectId); if (!project) throw new Error("This project is no longer in Modex."); store.space.moveNodes([store.space.linkProject(project).id], workspaceId); return store.space.workspaces(); });
handle("notes:reveal", ({ id }) => shell.showItemInFolder(store.space.pathOf(id)), { localOnly: true });
handle("notes:open", async ({ id }) => { const error = await shell.openPath(store.space.pathOf(id)); if (error) throw new Error(error); }, { localOnly: true });
handle("notes:import", async ({ targetId, paths }) => {
  let sources = paths;
  if (!sources) {
    const picked = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"], title: "Import files into your notes", buttonLabel: "Import" });
    if (picked.canceled) return { imported: 0, errors: [] };
    sources = picked.filePaths;
  }
  const result = store.space.importFiles(targetId, sources);
  return { imported: result.imported.length, errors: result.errors };
}, { localOnly: true });
handle("notes:file:read", ({ id }) => store.space.readFile(id));

handle("state:get", () => {
  const state = store.snapshot();
  return { ...state, threads: state.threads.map((t) => ({ ...t, status: runner.status(t.id) })) };
});
handle("project:add", async (req) => {
  let dir = req?.path;
  if (!dir) {
    const r = await dialog.showOpenDialog(win!, { properties: ["openDirectory", "createDirectory"], title: "Open a project folder" });
    if (r.canceled || !r.filePaths[0]) return null;
    dir = r.filePaths[0];
  }
  return store.addProject(dir);
});
handle("project:remove", async ({ projectId }) => {
  await runner.removeProject(projectId);
  return store.snapshot();
});
handle("thread:create", ({ projectId, worktree, mode, model, backend, auto }) => runner.createThread(projectId, { worktree, mode, model, backend, auto }));
handle("thread:items", ({ threadId }) => runner.items(threadId));
handle("thread:followup", ({ threadId }) => runner.followUp(threadId));
/**
 * Starts a turn without waiting for it. A rejection the runner can detect up front (busy thread,
 * missing cwd, nothing to retry) is returned to the caller, as in PR #61. Accepted turns
 * report their failures through the runner's persisted failure card.
 */
async function startTurn(threadId: string, run: Promise<void>): Promise<{ ok: boolean; error?: string }> {
  let accepting = true;
  let earlyError: string | undefined;
  run.catch((err: Error) => {
    if (accepting) { earlyError = err.message; return; }
    const thread = store.thread(threadId);
    const failure = describeFailure({ backend: thread?.backend ?? "mock", message: err.message, context: { at: new Date().toISOString(), modex: process.env.MODEX_VERSION, platform: `${process.platform} ${process.arch}`, threadId, cwd: thread?.cwd } });
    emit({ threadId, type: "item", item: { id: `err-${Date.now()}`, kind: "notice", level: "error", text: failure.summary, failure: { ...failure, retryable: false }, at: new Date().toISOString() } });
  });
  // Give the runner a tick to reject synchronously-detectable problems (busy thread, missing cwd).
  await new Promise((r) => setTimeout(r, 0));
  accepting = false;
  return earlyError !== undefined ? { ok: false, error: earlyError } : { ok: true };
}
handle("thread:send", ({ threadId, text, attachments: files }) => startTurn(threadId, runner.send(threadId, text, files)));
registerAttachmentCommands(handle, attachments, { bytesOnly: false, reveal: (abs) => shell.showItemInFolder(abs) });
handle("attachments:pick", async (req) => {
  // Explicit renderer paths keep the strict whole-request guard. Only the native dialog's
  // trusted selection is trimmed to the slots the composer reserved before opening it.
  if (req?.paths !== undefined) return attachments.stagePaths(req.paths, req.remaining);
  const remaining = req?.remaining === undefined ? LIMITS.perTurn : req.remaining;
  if (typeof remaining !== "number" || !Number.isInteger(remaining) || remaining < 0 || remaining > LIMITS.perTurn) {
    return attachments.stagePaths([], remaining);
  }
  const r = await dialog.showOpenDialog(win!, { properties: ["openFile", "multiSelections"], title: "Attach files", buttonLabel: "Attach" });
  if (r.canceled) return { staged: [], errors: [] };
  const result = attachments.stagePaths(r.filePaths.slice(0, remaining), remaining);
  if (r.filePaths.length > remaining) result.errors.push(`Up to ${LIMITS.perTurn} attachments per message; ${r.filePaths.length - remaining} left out.`);
  return result;
}, { localOnly: true });
handle("thread:retry", ({ threadId }) => startTurn(threadId, runner.retry(threadId)));
handle("thread:stop", ({ threadId }) => runner.stop(threadId));
handle("thread:answer", ({ threadId, itemId, answer }) => runner.answer(threadId, itemId, answer));
handle("thread:update", ({ threadId, patch }) => runner.updateThread(threadId, patch));
handle("thread:archive", ({ threadId, archived }) => runner.setArchived(threadId, archived));
handle("thread:delete", async ({ threadId, removeWorktree }) => {
  await runner.deleteThread(threadId, removeWorktree);
  return store.snapshot();
});
handle("project:branch", async ({ projectId }) => {
  const p = store.project(projectId);
  return p && (await gitx.isRepo(p.path)) ? gitx.currentBranch(p.path) : null;
});
handle("files:list", ({ threadId }) => listWorkspaceFiles(cwdFor(threadId)));
handle("thread:context", async ({ threadId }) => { await pathReady; return threadContexts.read(cwdFor(threadId)); });
handle("files:read", ({ threadId, path }) => readWorkspaceFile(cwdFor(threadId), path));
handle("changes:status", ({ threadId }) => gitx.status(cwdFor(threadId)));
handle("changes:diff", ({ threadId, path: rel, original, fullContext }) => gitx.diff(cwdFor(threadId), rel, original, fullContext));
handle("changes:revert", async ({ threadId, path: rel }) => {
  const cwd = cwdFor(threadId);
  await gitx.revert(cwd, rel);
  return gitx.status(cwd);
});
handle("settings:update", async (patch) => {
  const previousTheme = store.settings.theme;
  const settings = await saveSettings(store, runner.router, {
    ...patch,
    ...(patch.approval_rules !== undefined ? { approval_rules: validateRules(patch.approval_rules) } : {}),
  });
  win?.setBackgroundColor(THEMES[settings.theme].background);
  if (settings.theme !== previousTheme) void knowledgeBrowser?.refreshAppearance();
  return settings;
});
handle("approvals:rules:get", () => store.snapshot().settings.approval_rules);
handle("approvals:rules:set", ({ rules }) => store.updateSettings({ approval_rules: validateRules(rules) }).approval_rules);
handle("approvals:try", (req) => previewApproval(req, {
  project: (id) => store.project(id), config: store.snapshot().settings.approval_gate,
  jev: () => runner.router.jev(),
}));
handle("models:list", ({ backend }) => runner.listModels(backend));
// Account identity is local desktop authority, never exposed to paired mobile clients.
handle("modexAccount:status", () => modexAccount.status(), { localOnly: true });
handle("modexAccount:signIn", async () => { await modexAccount.signIn(); return modexAccount.status(); }, { localOnly: true });
handle("modexAccount:cancel", () => modexAccount.cancel(), { localOnly: true });
handle("modexAccount:refresh", () => modexAccount.refresh(), { localOnly: true });
handle("modexAccount:signOut", async () => { const detail = await modexAccount.signOut(); return { status: modexAccount.status(), detail }; }, { localOnly: true });
handle("chatgpt:status", () => chatgpt.status());
handle("chatgpt:signIn", async ({ accountId }) => {
  try {
    if (accountId) await accountCodex.accountChange(accountId, () => chatgpt.signIn(accountId));
    else await chatgpt.signIn();
    return chatgpt.status();
  } catch { throw new Error("ChatGPT sign-in did not complete. Finish active turns, check protected storage, or retry authorization."); }
});
handle("chatgpt:cancel", () => chatgpt.cancel());
handle("chatgpt:select", ({ accountId }) => { chatgpt.select(accountId); return chatgpt.status(); });
handle("chatgpt:signOut", async ({ accountId }) => {
  const detail = await accountCodex.accountChange(accountId, () => chatgpt.signOut(accountId)); return { status: chatgpt.status(), detail };
});
const claudeLogin = new ClaudeLogin();
SPAWNS.add("claude:login");
handle("claude:login", () => claudeLogin.run(resolveCli("claude", sessionCliSettings.claude_bin)));
handle("claude:cancelLogin", () => claudeLogin.cancel());
handle("usage:list", (req) => usageLedger.list(req ?? {}), { localOnly: true });
handle("analytics:show", ({ bounds }) => workspaceAnalytics?.show(bounds) ?? null, { localOnly: true });
handle("routing:status", () => runner.router.status());
handle("routing:reset", () => {
  runner.router.fit.reset();
  return runner.router.status();
});
handle("routing:setKey", ({ key }) => runner.router.setKey(key));
handle("routing:clearKey", () => runner.router.clearKey());
handle("routing:test", () => runner.router.test());
handle("backends:health", async () => {
  const entries = await Promise.all((["claude", "codex", "mock"] as BackendId[]).map(async (id) => {
    const backend = runner.backend(id);
    const status = backend.health ? await (id === "mock" ? backend.health() : cliHealth(id, sessionCliSettings[`${id}_bin`], () => backend.health!())) : { executable: "available" as const, authentication: "unknown" as const, access: "unverified" as const, detail: "Offline demo · no account" };
    return [id, status] as const;
  }));
  return Object.fromEntries(entries) as BridgeCommands["backends:health"]["res"];
});
handle("companion:status", () => companionView(companion.status()));
handle("companion:start", async () => companionView(await companion.start()));
handle("companion:stop", async () => companionView(await companion.stop()));
handle("companion:reset", () => companionView(companion.resetAccess()));
handle("shell:openPath", async ({ path: p }) => {
  const err = await shell.openPath(p);
  if (err) throw new Error(err);
});
handle("shell:openTerminal", ({ path: p }) => openTerminal(p));
handle("clipboard:write", ({ text }) => { clipboard.writeText(String(text).slice(0, 200_000)); });
handle("terminal:open", ({ threadId, cols, rows }) => terminals.open(threadId, cols, rows));
handle("terminal:write", ({ threadId, sessionId, data }) => terminals.write(threadId, sessionId, data));
handle("terminal:resize", ({ threadId, sessionId, cols, rows }) => terminals.resize(threadId, sessionId, cols, rows));
handle("terminal:close", ({ threadId, sessionId }) => terminals.close(threadId, sessionId));

function createWindow(): BrowserWindow {
  nativeTheme.themeSource = "dark";
  const devUrl = process.env.MODEX_DEV_URL;
  const appPage = devUrl ? new URL(devUrl) : pathToFileURL(path.join(here, "..", "..", "renderer", "index.html"));
  // The demo captures fixed-size screenshots, so only real (and e2e) launches restore geometry.
  const min = { width: 900, height: 600 };
  const saved = demo ? null : readWindowState(home);
  const bounds = initialBounds(saved, screen.getAllDisplays().map((d) => d.workArea), min);
  const w = new BrowserWindow({
    ...bounds,
    minWidth: min.width,
    minHeight: min.height,
    title: "Modex",
    backgroundColor: THEMES[store.settings.theme].background, // Match the saved canvas before first paint.
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    // e2e captures run at the 1786×1049 reference size; CI runners have smaller displays, and macOS
    // otherwise clamps the window to the screen (1024×677 on the GitHub macOS runner).
    enableLargerThanScreen: Boolean(process.env.MODEX_E2E),
    trafficLightPosition: { x: 14, y: 14 }, // centred in the 42 px titlebar (reference: lights at y 14–25)
    show: false,
    webPreferences: { preload: path.join(here, "preload.cjs"), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  if (process.env.MODEX_E2E) {
    // Retain distinct show and first-paint observations before Playwright connects.
    // Paint does not prove visibility; the harness also waits for settled native geometry.
    const state = globalThis as { __modexE2EShown?: Set<number>; __modexE2EPainted?: Set<number> };
    const shown = state.__modexE2EShown ??= new Set<number>();
    const painted = state.__modexE2EPainted ??= new Set<number>();
    let closed = false;
    w.once("show", () => { if (!closed && !w.isDestroyed()) shown.add(w.id); });
    w.once("ready-to-show", () => { if (!closed && !w.isDestroyed()) painted.add(w.id); });
    w.once("closed", () => { closed = true; shown.delete(w.id); painted.delete(w.id); });
  }
  w.webContents.on("did-start-navigation", details => {
    if (win === w && details.isMainFrame && !details.isSameDocument) invalidateNativeDocument();
  });
  w.once("closed", () => { if (win === w) invalidateNativeDocument(); });
  w.webContents.on("render-process-gone", () => { if (win === w) invalidateNativeDocument(); });
  w.once("closed", () => {
    // Electron 44's visibility handlers access the native window without checking
    // destruction. Late macOS notifications must not reopen an error dialog on quit.
    for (const event of ["show", "hide", "minimize", "maximize", "restore"] as const) w.removeAllListeners(event);
  });
  let canvas = new WorkspaceCanvas(w);
  workspaceCanvas = canvas;
  w.webContents.on("did-start-navigation", () => { canvas.dispose(); canvas = new WorkspaceCanvas(w); workspaceCanvas = canvas; });
  w.on("closed", () => { canvas.dispose(); if (workspaceCanvas === canvas) workspaceCanvas = null; });
  const browser = new WorkspaceBrowser(w);
  workspaceBrowser = browser;
  const knowledgeView = new WorkspaceBrowser(w, {
    partition: "modex-knowledge", shortcuts: false,
    appearance: () => knowledgeAppearance(store.settings.theme),
    allowURL: url => { try { return new URL(url).origin === knowledge.snapshot().url; } catch { return false; } },
  });
  knowledgeBrowser = knowledgeView; knowledgeURL = null;
  w.webContents.on("did-start-navigation", () => { knowledgeView.dispose(); knowledgeURL = null; });
  w.on("closed", () => { knowledgeView.dispose(); if (knowledgeBrowser === knowledgeView) { knowledgeBrowser = null; knowledgeURL = null; } });
  // The built usage dashboard sits beside the renderer (dist/usage-preview); main serves it to its own session.
  const analyticsRoot = path.join(here, "..", "..", "usage-preview");
  let analytics = new WorkspaceAnalytics(w, analyticsRoot, usageLedger);
  workspaceAnalytics = analytics;
  w.webContents.on("did-start-navigation", () => { analytics.dispose(); analytics = new WorkspaceAnalytics(w, analyticsRoot, usageLedger); workspaceAnalytics = analytics; });
  w.on("closed", () => { analytics.dispose(); if (workspaceAnalytics === analytics) workspaceAnalytics = null; });
  w.webContents.on("did-start-navigation", () => browser.dispose());
  w.on("closed", () => { browser.dispose(); if (workspaceBrowser === browser) workspaceBrowser = null; });
  if (devUrl) void w.loadURL(devUrl);
  else void w.loadFile(path.join(here, "..", "..", "renderer", "index.html"));
  w.once("ready-to-show", () => {
    if (saved?.maximized) w.maximize();
    if (saved?.fullscreen) w.setFullScreen(true);
    // Under test the window must not take the keyboard: Playwright drives it over CDP, and a test
    // window that becomes active swallows whatever the developer is typing elsewhere (it reached a
    // real shell in the terminal panel). The helper checks paint and settled native geometry
    // as well: an inactive macOS window does not always emit "show".
    if (process.env.MODEX_E2E) w.showInactive();
    else w.show();
  });
  // getNormalBounds: a maximized or full-screen window remembers the size it returns to.
  if (!demo) w.on("close", () => {
    try {
      writeWindowState(home, { ...w.getNormalBounds(), maximized: w.isMaximized(), fullscreen: w.isFullScreen() });
    } catch (err) {
      console.error("[modex] could not save window state:", (err as Error).message);
    }
  });
  w.on("closed", () => { if (win === w) win = null; });
  w.webContents.on("render-process-gone", () => { if (!w.isDestroyed()) w.destroy(); });
  // The window keeps its preload (and so terminal access) across navigations: never leave the app page.
  w.webContents.on("will-navigate", (event, url) => {
    const next = new URL(url);
    const sameAppPage = next.protocol === appPage.protocol
      && next.pathname === appPage.pathname
      && (appPage.protocol === "file:" || next.origin === appPage.origin);
    if (!sameAppPage) event.preventDefault();
  });
  w.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url);
    return { action: "deny" };
  });
  return w;
}

let startingDesktopHost: Promise<void> | undefined;
function startDesktopHost(): Promise<void> {
  if (demo || desktopHost) return Promise.resolve();
  if (startingDesktopHost) return startingDesktopHost;
  startingDesktopHost = restartAdmission.run(async () => {
    const check = () => {
      restartAdmission.assertOpen();
      if (shuttingDown || servicesTouched || checkingWindowClose || nativeDraftFailure || nativeStartup?.recovery) throw new Error("Desktop host is unavailable during recovery or shutdown.");
    };
    check();
    let discoveryDirectory: string | undefined;
    if (!app.isPackaged && process.env.MODEX_E2E && process.env.MODEX_DESKTOP_DISCOVERY_DIR) discoveryDirectory = process.env.MODEX_DESKTOP_DISCOVERY_DIR;
    else if (app.isPackaged && process.platform === "darwin") {
      try { discoveryDirectory = path.join(await desktopSystem("directory"), "desktop-hosts"); }
      catch { console.warn("[modex] system discovery unavailable; manual desktop links remain available"); }
    }
    check();
    desktopHost = new DesktopHost(home, {
      version: app.getVersion(),
      channels: () => [...desktopCommands.keys()],
      authorize: (confirmationCode, signal) => restartAdmission.run(async () => {
        check();
        if (!win || win.isDestroyed()) win = createWindow();
        win.show(); win.focus();
        const result = await dialog.showMessageBox(win, { type: "question", title: "Connect Modex on this Mac", message: `Does your desktop show ${confirmationCode}?`, detail: "Approve only if this code matches the Modex connection screen you just opened. This gives that desktop access to your projects, coding agents, existing CLI sign-ins, terminals, settings and approvals. Access stays saved until you revoke it from Desktop access.", buttons: ["Cancel", "Allow this desktop"], defaultId: 0, cancelId: 0, signal });
        check();
        return result.response === 1 && !signal.aborted;
      }),
      invoke: async (channel, payload, authorized) => {
        const command = desktopCommands.get(channel);
        if (!command) throw new Error("Unknown desktop command.");
        // The shared dispatcher owns the only PATH wait, counts it as active
        // work, and rechecks this live authorization immediately before fn.
        return command(payload, authorized);
      },
    }, discoveryDirectory);
    try {
      await desktopHost.start();
      check();
      const menu = Menu.getApplicationMenu() ?? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "viewMenu" }, { role: "windowMenu" }]);
      menu.append(new MenuItem({ label: "Desktop access", submenu: [
        { label: "Pair a desktop…", click: () => { void restartAdmission.run(async () => {
          check();
          const result = await dialog.showMessageBox(win!, { type: "info", title: "Connect a trusted desktop", message: "Allow a desktop to use this Mac host", detail: "A connected desktop can manage projects, run coding agents and terminals, change settings, and review approvals. Copy this link only into a desktop app you trust. The link works once and expires in five minutes. You can revoke access from this menu.", buttons: ["Cancel", "Copy connection link"], defaultId: 0, cancelId: 0 });
          check();
          if (result.response === 1) clipboard.writeText(desktopHost!.invite());
        }).catch((error: Error) => dialog.showErrorBox("Desktop pairing failed", error.message)); } },
        { label: "Manage connected desktops…", click: () => { void restartAdmission.run(async () => {
          check();
          const clients = desktopHost!.clients();
          const result = await dialog.showMessageBox(win!, { type: "info", title: "Connected desktops", message: clients.length ? "Remove a desktop's host access" : "No desktops are connected", detail: clients.length ? "Revoking access disconnects that desktop and prevents further commands. Coding turns already accepted by this host remain owned by the host." : "Use Pair a desktop to create a one-time connection link.", buttons: ["Done", ...clients.map((client, i) => `Revoke ${client.name} (${i + 1})`)], defaultId: 0, cancelId: 0 });
          check();
          const selected = clients[result.response - 1];
          if (selected) desktopHost!.revoke(selected.id);
        }).catch((error: Error) => dialog.showErrorBox("Desktop access could not be changed", error.message)); } },
      ] }));
      Menu.setApplicationMenu(menu);
    } catch (error) {
      await desktopHost.dispose();
      desktopHost = undefined;
      console.error("[modex] desktop host could not start:", (error as Error).message);
      dialog.showErrorBox("Desktop host could not start", "Its local port may already be in use. Quit the other Modex host and try again.");
    }
  }).finally(() => { startingDesktopHost = undefined; });
  return startingDesktopHost;
}

app.on("second-instance", (_event, args) => {
  void app.whenReady().then(async () => {
    if (!win || win.isDestroyed()) win = createWindow();
    if (args.includes("--desktop-host")) await startDesktopHost();
    win.show(); win.focus();
  }).catch(error => console.error("[modex] second-instance activation refused:", error));
});

app.whenReady().then(async () => {
  browserTools = new BrowserTools(home, () => win && !win.isDestroyed() && workspaceBrowser ? { window: win, browser: workspaceBrowser } : null);
  if (!nativeDraftFailure && !nativeStartup?.recovery) await browserTools.restore();
  // Images from the notes folder: a file's preview by id, or an image a page names beside it. Only
  // image files are ever served, and an SVG opened on its own gets no scripts or subresources.
  protocol.handle(NOTES_SCHEME, (request) => {
    let image: { data: Buffer; mime: string } | null = null;
    try {
      const url = new URL(request.url);
      const nearby = pageImageFromUrl(request.url);
      if (url.host === "file") image = store.space.readImage(decodeURIComponent(url.pathname.slice(1)));
      else if (nearby) image = store.space.readPageImage(nearby.pageId, nearby.relative);
    } catch { image = null; }
    return image ? new Response(new Uint8Array(image.data), { headers: { "Content-Type": image.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store", "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox" } }) : new Response("Not found", { status: 404 });
  });
  // Serves staged and sent attachments to the renderer's <img>; anything outside the root is a 404.
  protocol.handle(ATTACHMENT_SCHEME, (request) => {
    const rel = relFromUrl(request.url);
    const image = rel ? attachments.readImage(rel) : null;
    return image ? new Response(new Uint8Array(image.data), { headers: { "Content-Type": image.mime, "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" } }) : new Response("Not found", { status: 404 });
  });
  win = createWindow();
  // Space polls the notes folder; watching it lets those polls skip the walk while nothing changed.
  store.space.watch();
  if ((flag("desktop-host") || hostPreview) && !demo && !nativeDraftFailure && !nativeStartup?.recovery) await startDesktopHost();
  desktopHostActivation.ready();
  if (!demo && !process.env.MODEX_E2E && !nativeDraftFailure && !nativeStartup?.recovery) void pathReady.then(() => retirer.start());
  if (!demo && !nativeDraftFailure && !nativeStartup?.recovery && companion.shouldStart) void companion.start().catch((err: Error) => console.error("[modex] companion could not start:", err.message));
  if (demo) {
    if (screenshotDir) setTimeout(() => { console.error("[modex] demo watchdog fired"); app.exit(2); }, 45_000).unref();
    await new Promise<void>((r) => win!.webContents.once("did-finish-load", () => r()));
    await runDemo({
      store, runner, home,
      repoPath: app.isPackaged ? app.getAppPath() : path.resolve(here, "..", "..", "..", "..", ".."),
      scriptPath: path.join(app.getAppPath(), "demo", "mock-script.json"),
      screenshotDir, answer: flag("demo-answer"), capture: (name) => capture(name),
    });
    if (screenshotDir) app.quit();
  }
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) win = createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || screenshotDir) app.quit();
});
app.on("before-quit", (event) => {
  if (shutdownComplete) return;
  event.preventDefault();
  if (restartCoordinator && ["preparing", "draining", "staging"].includes(restartCoordinator.state)) return;
  if (shuttingDown || checkingWindowClose) return;
  // Let unsaved-page beforeunload handlers veto quitting while services and IPC
  // are still usable. Teardown starts only after the renderer accepts closing.
  if (win && !win.isDestroyed()) {
    const window = win;
    checkingWindowClose = true;
    const cancelled = () => {
      checkingWindowClose = false;
      releaseRecoveryQuit();
      window.removeListener("closed", closed);
    };
    const closed = () => {
      checkingWindowClose = false;
      app.quit();
    };
    window.webContents.once("will-prevent-unload", cancelled);
    window.once("closed", closed);
    window.close();
    return;
  }
  shuttingDown = true;
  // A partial service failure still has to cancel downloads and release their
  // files. Keep updater disposal outside the coordinator's drain to avoid
  // waiting on the install operation from inside that same operation.
  void Promise.allSettled([() => drainServices(), () => updateInstallation.dispose()].map(dispose => Promise.resolve().then(dispose))).then(results => {
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
    shutdownComplete = true;
    app.quit();
  }).catch(error => {
    shuttingDown = false;
    console.error("[modex] shutdown failed:", error);
    dialog.showErrorBox("Modex could not finish quitting", "A running command could not be stopped. Your working directories have been preserved. Quit again to retry.");
  });
});

async function capture(name: string): Promise<string> {
  if (!win || !screenshotDir) return "";
  fs.mkdirSync(screenshotDir, { recursive: true });
  const image = await win.webContents.capturePage();
  const file = path.join(screenshotDir, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  return file;
}
