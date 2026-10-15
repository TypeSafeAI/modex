// Preload: the only bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

// One isolated-world document owns the session and every write sequence. A
// renderer cannot manufacture main capability handles or reset this counter.
let draftSequence = 0;
let draftSession;
let draftOpening;
let draftRecoveryOnly = false;
const nativeDrafts = process.platform === "win32" ? undefined : {
  open: () => draftOpening ??= ipcRenderer.invoke("drafts:open").then(result => {
    if (!result) return null;
    draftSession = undefined;
    if (result.readOnly === true) {
      if (!Array.isArray(result.pending) || !Array.isArray(result.pendingIds) || result.pendingIds.length
        || !result.recovery || typeof result.recovery.message !== "string"
        || !["uncertain", "staged", "unreadable", "recovery"].includes(result.recovery.outcome)) throw new Error("Invalid native recovery response.");
      return { readOnly: true, drafts: result.drafts, pendingIds: [], pending: result.pending, recovery: result.recovery };
    }
    if (draftRecoveryOnly || (result.readOnly !== undefined && result.readOnly !== false) || result.recovery
      || typeof result.session !== "string" || !result.session || !Array.isArray(result.pendingIds)) throw new Error("Invalid native recovery response.");
    draftSession = result.session;
    return { drafts: result.drafts, pendingIds: result.pendingIds };
  }),
  save: snapshot => draftInvoke("drafts:save", { sequence: ++draftSequence, snapshot }),
  saveBeforeClose: snapshot => {
    if (!draftSession) return null;
    const receipt = ipcRenderer.sendSync("drafts:close-save", { session: draftSession, sequence: ++draftSequence, snapshot });
    return receipt?.saved === true && Number.isSafeInteger(receipt.revision) && receipt.revision > 0 ? receipt.revision : null;
  },
  stage: (owner, files) => draftInvoke("drafts:stage", { owner, files }),
  pick: (owner, remaining) => draftInvoke("drafts:pick", { owner, remaining }),
  discard: (owner, ids) => draftInvoke("drafts:discard", { owner, ids }),
  retire: owner => draftInvoke("drafts:retire", { owner }),
  begin: input => draftInvoke("drafts:begin", { input }),
  create: intentId => draftInvoke("drafts:create", { intentId }),
  transfer: input => draftInvoke("drafts:transfer", { ...input, sequence: ++draftSequence }),
  send: intentId => draftInvoke("drafts:send", { intentId }),
  readPending: intentId => draftInvoke("drafts:pending", { intentId }),
};
function draftInvoke(channel, payload) {
  if (!draftSession) return Promise.reject(new Error("Open native draft recovery before editing."));
  return ipcRenderer.invoke(channel, { ...payload, session: draftSession });
}

// Attempt IDs stay in the isolated world. Editor membership can revoke a
// positive acknowledgment; only main's matching release reopens renderer work.
function preparationBridge(requestChannel, replyChannel) {
  let restartSubscription;
  function subscribe(prepare, release) {
    if (restartSubscription) throw new Error("Restart preparation is still awaiting release.");
    if (typeof prepare !== "function" || typeof release !== "function") throw new Error("Restart preparation callbacks are required.");
    const subscription = restartSubscription = { disposed: false, current: undefined };
    const remove = () => {
      ipcRenderer.removeListener(requestChannel, listener);
      if (restartSubscription === subscription) restartSubscription = undefined;
    };
    const listener = (_event, request) => {
      if (!request || typeof request.id !== "string" || !request.id) return;
      if (request.type === "release") {
        if (subscription.current?.id !== request.id) return;
        subscription.current = undefined;
        try { release(); } finally { if (subscription.disposed) remove(); }
        return;
      }
      if (request.type !== "prepare" || subscription.disposed) return;
      if (subscription.current) {
        subscription.current.invalidate();
        ipcRenderer.send(replyChannel, { id: request.id, error: "Restart preparation is already active." });
        return;
      }
      const attempt = { id: request.id, invalid: false, invalidate: undefined };
      attempt.invalidate = () => {
        if (subscription.current !== attempt || attempt.invalid) return;
        attempt.invalid = true;
        ipcRenderer.send(replyChannel, { id: attempt.id, error: "The workspace changed while preparing to restart." });
      };
      subscription.current = attempt;
      Promise.resolve().then(() => {
        if (subscription.current !== attempt || attempt.invalid || subscription.disposed) return;
        return prepare(attempt.invalidate, request.payload);
      }).then(revision => {
        if (subscription.current !== attempt || attempt.invalid) return;
        if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("Composer drafts have not been saved for restart.");
        ipcRenderer.send(replyChannel, { id: attempt.id, revision });
      }).catch(error => {
        if (subscription.current !== attempt || attempt.invalid) return;
        attempt.invalid = true;
        ipcRenderer.send(replyChannel, { id: attempt.id, error: typeof error?.message === "string" && error.message ? error.message.slice(0, 300) : "Workspace restart preparation failed." });
      });
    };
    ipcRenderer.on(requestChannel, listener);
    return () => {
      if (subscription.disposed) return;
      subscription.disposed = true;
      if (subscription.current) subscription.current.invalidate();
      else remove();
    };
  }
  return subscribe;
}
const onRestartPreparation = preparationBridge("updates:prepare", "updates:prepared");
const onRecoveryQuitPreparation = preparationBridge("updates:prepare-quit", "updates:quit-prepared");
const onOwnerRemovalPreparation = preparationBridge("drafts:remove-prepare", "drafts:remove-prepared");
const onOwnerRemovalAdoption = preparationBridge("drafts:remove-adopt", "drafts:remove-adopted");

contextBridge.exposeInMainWorld("modex", {
  ...(nativeDrafts ? { nativeDrafts } : {}),
  onRestartPreparation,
  onRecoveryQuitPreparation,
  onOwnerRemovalPreparation,
  onOwnerRemovalAdoption,
  onOwnerRemovalRecovery: (cb) => {
    const listener = (_event, message) => {
      draftSession = undefined; draftOpening = undefined; draftRecoveryOnly = true;
      cb(message);
    };
    ipcRenderer.on("drafts:remove-recovery", listener);
    return () => ipcRenderer.removeListener("drafts:remove-recovery", listener);
  },
  onUpdateState: (cb) => {
    const listener = (_event, state) => cb(state);
    ipcRenderer.on("updates:state", listener);
    return () => ipcRenderer.removeListener("updates:state", listener);
  },
  platform: process.platform,
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
  // A File object cannot cross IPC under the sandbox; its OS path can. Pasted files have none.
  pathForFile: (file) => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  onMediaEvent: (cb) => {
    const listener = (_event, value) => cb(value);
    ipcRenderer.on("media:event", listener);
    return () => ipcRenderer.removeListener("media:event", listener);
  },
  onEvent: (cb) => {
    const listener = (_e, event) => cb(event);
    ipcRenderer.on("thread:event", listener);
    return () => ipcRenderer.removeListener("thread:event", listener);
  },
  onWorkspaceShortcut: (cb) => {
    const listener = (_e, shortcut) => cb(shortcut);
    ipcRenderer.on("workspace:shortcut", listener);
    return () => ipcRenderer.removeListener("workspace:shortcut", listener);
  },
  onTerminalEvent: (cb) => {
    const listener = (_e, event) => cb(event);
    ipcRenderer.on("terminal:event", listener);
    return () => ipcRenderer.removeListener("terminal:event", listener);
  },
});
