// Preload: the only bridge between the sandboxed renderer and the main process.
const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("modex", {
  platform: process.platform,
  invoke: (channel, payload) => ipcRenderer.invoke(channel, payload),
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
