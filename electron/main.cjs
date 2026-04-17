const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const VITE_PORT = 5180;
const VITE_URL = `http://localhost:${VITE_PORT}`;
const VITE_PROBE_URL = `${VITE_URL}/api/composition`;
const repoRoot = path.resolve(__dirname, "..");

let viteProc = null;
let mainWindow = null;

const probeHttp = (url, timeoutMs = 1500) =>
  new Promise((resolve) => {
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };
    const req = http.get(url, (res) => {
      res.resume();
      done(res.statusCode !== undefined && res.statusCode < 500);
    });
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      done(false);
    });
    req.once("error", () => done(false));
  });

const waitForServer = async (url, timeoutMs = 30000) => {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await probeHttp(url, 1000)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`vite did not respond at ${url} within ${timeoutMs}ms`);
};

const spawnVite = () => {
  const vitePath = path.join(repoRoot, "node_modules", "vite", "bin", "vite.js");
  const env = {
    ...process.env,
    ELECTRON_RUN_AS_NODE: "1",
  };
  const args = [vitePath];
  if (app.isPackaged) {
    env.DABINKY_DATA_ROOT = app.getPath("userData");
    env.PLAYWRIGHT_BROWSERS_PATH = path.join(
      process.resourcesPath,
      "pw-browsers",
    );
    // Production: serve the prebuilt editor/dist/. Dev mode stays on the
    // transforming dev server so HMR still works with `npm run electron-dev`.
    args.push("preview");
  }
  args.push("--port", String(VITE_PORT), "--strictPort");
  return spawn(process.execPath, args, {
    cwd: repoRoot,
    env,
    stdio: "inherit",
  });
};

const createWindow = async (url) => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    backgroundColor: "#0c0c10",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url: openUrl }) => {
    shell.openExternal(openUrl);
    return { action: "deny" };
  });

  mainWindow.webContents.on("did-fail-load", (_e, errCode, errDesc, failedUrl) => {
    console.error(`load failed (${errCode}) ${errDesc} for ${failedUrl}`);
  });

  try {
    await mainWindow.loadURL(url);
  } catch (err) {
    console.error("loadURL error", err);
  }
};

app.whenReady().then(async () => {
  const alreadyRunning = await probeHttp(VITE_PROBE_URL);
  if (!alreadyRunning) {
    viteProc = spawnVite();
    viteProc.on("exit", (code, signal) => {
      viteProc = null;
      if (code !== 0 && !signal) {
        dialog.showErrorBox(
          "Vite exited",
          `Vite dev server exited with code ${code}. Is port ${VITE_PORT} already in use by a different app?`,
        );
        app.quit();
      }
    });
    try {
      await waitForServer(VITE_PROBE_URL);
    } catch (err) {
      dialog.showErrorBox("Vite failed to start", String(err));
      app.quit();
      return;
    }
  } else {
    console.log(`reusing existing vite server at ${VITE_URL}`);
  }
  await createWindow(VITE_URL);
});

app.on("window-all-closed", () => {
  app.quit();
});

app.on("before-quit", () => {
  if (viteProc && !viteProc.killed) {
    viteProc.kill("SIGTERM");
  }
});

process.on("SIGINT", () => app.quit());
process.on("SIGTERM", () => app.quit());
