const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("updater", {
  onUpdateAvailable: (cb) => ipcRenderer.on("update-available", (_e, info) => cb(info)),
  onDownloadProgress: (cb) => ipcRenderer.on("update-download-progress", (_e, pct) => cb(pct)),
  onUpdateDownloaded: (cb) => ipcRenderer.on("update-downloaded", (_e, info) => cb(info)),
  installUpdate: () => ipcRenderer.send("install-update"),
  checkForUpdates: () => ipcRenderer.send("check-for-updates"),
});
