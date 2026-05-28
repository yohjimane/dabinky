const { autoUpdater } = require("electron-updater");
const { ipcMain } = require("electron");

let mainWindow = null;

const send = (channel, data) => {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
};

const initAutoUpdater = (win) => {
  mainWindow = win;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on("update-available", (info) => {
    send("update-available", { version: info.version });
  });

  autoUpdater.on("download-progress", (progress) => {
    send("update-download-progress", Math.round(progress.percent));
  });

  autoUpdater.on("update-downloaded", (info) => {
    send("update-downloaded", { version: info.version });
  });

  autoUpdater.on("error", (err) => {
    console.error("Auto-updater error:", err.message);
  });

  ipcMain.on("install-update", () => {
    autoUpdater.quitAndInstall(false, true);
  });

  ipcMain.on("check-for-updates", () => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("Update check failed:", err.message);
    });
  });

  autoUpdater.checkForUpdates().catch((err) => {
    console.error("Initial update check failed:", err.message);
  });

  // Re-check every 30 minutes so long-running sessions pick up new releases
  setInterval(() => {
    autoUpdater.checkForUpdates().catch((err) => {
      console.error("Periodic update check failed:", err.message);
    });
  }, 30 * 60 * 1000);
};

module.exports = { initAutoUpdater };
