const { contextBridge, ipcRenderer } = require("electron");
const subscribe = (channel, cb) => {
  const listener = (_event, data) => cb(data);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
};
contextBridge.exposeInMainWorld("modex", {
  platform: process.platform,
  invoke: (channel, payload) => ipcRenderer.invoke("store:invoke", { channel, payload }),
  onEvent: (cb) => subscribe("thread:event", cb),
  onTerminalEvent: (cb) => subscribe("terminal:event", cb),
  onReconnect: (cb) => subscribe("host:reconnected", cb),
});
contextBridge.exposeInMainWorld("modexHost", {
  status: () => ipcRenderer.invoke("host:status"),
  discover: () => ipcRenderer.invoke("host:discover"),
  connect: () => ipcRenderer.invoke("host:connect"),
  pair: (uri) => ipcRenderer.invoke("host:pair", uri),
  disconnect: () => ipcRenderer.invoke("host:disconnect"),
  onStatus: (cb) => subscribe("host:status", cb),
});
