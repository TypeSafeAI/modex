// Preload: the only bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("modex", {
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
