const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");
const { initAutoUpdater } = require("./auto-updater.cjs");

const VITE_PORT = 5180;
const VITE_URL = `http://localhost:${VITE_PORT}`;
const VITE_PROBE_URL = `${VITE_URL}/api/composition`;
const repoRoot = path.resolve(__dirname, "..");

let viteProc = null;
let mainWindow = null;
let splashWindow = null;

const SPLASH_HTML = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
    background: #0c0c10;
    color: #e8e8ea;
    height: 100vh;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    -webkit-app-region: drag;
    user-select: none;
  }
  .title {
    font-size: 28px;
    font-weight: 700;
    letter-spacing: -0.5px;
    margin-bottom: 32px;
  }
  .steps {
    width: 260px;
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin-bottom: 20px;
  }
  .step {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: #3a3a42;
    transition: color 300ms;
  }
  .step.active { color: #e8e8ea; }
  .step.done { color: #4a8a5a; }
  .dot {
    width: 6px; height: 6px;
    border-radius: 50%;
    background: #3a3a42;
    flex-shrink: 0;
    transition: background 300ms;
  }
  .step.active .dot { background: #4a6aa8; }
  .step.done .dot { background: #4a8a5a; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .step.active .dot { animation: pulse 1.2s ease-in-out infinite; }
  #elapsed {
    font-size: 11px;
    color: #3a3a42;
    font-variant-numeric: tabular-nums;
  }
</style>
</head>
<body>
  <div class="title">Dabinky</div>
  <div class="steps">
    <div class="step" id="step-init"><span class="dot"></span>Initializing</div>
    <div class="step" id="step-server"><span class="dot"></span>Starting server</div>
    <div class="step" id="step-ready"><span class="dot"></span>Server ready</div>
    <div class="step" id="step-editor"><span class="dot"></span>Loading editor</div>
  </div>
  <div id="elapsed"></div>
</body>
</html>`;

const STEPS = ["init", "server", "ready", "editor"];

const createSplash = () => {
  splashWindow = new BrowserWindow({
    width: 360,
    height: 280,
    frame: false,
    resizable: false,
    transparent: false,
    backgroundColor: "#0c0c10",
    webPreferences: {
      contextIsolation: true,
    },
  });
  splashWindow.loadURL(
    `data:text/html;charset=utf-8,${encodeURIComponent(SPLASH_HTML)}`,
  );
};

const setSplashStep = (activeStep, elapsedSec) => {
  if (!splashWindow || splashWindow.isDestroyed()) return;
  const activeIdx = STEPS.indexOf(activeStep);
  const js = STEPS.map((s, i) => {
    const el = `document.getElementById('step-${s}')`;
    if (i < activeIdx) return `${el}.className='step done'`;
    if (i === activeIdx) return `${el}.className='step active'`;
    return `${el}.className='step'`;
  }).join(";") +
    `;document.getElementById('elapsed').textContent='${
      elapsedSec != null ? elapsedSec + "s" : ""
    }'`;
  splashWindow.webContents.executeJavaScript(js).catch(() => {});
};

const closeSplash = () => {
  if (splashWindow && !splashWindow.isDestroyed()) {
    splashWindow.close();
  }
  splashWindow = null;
};

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

const waitForServer = async (url, startedAt, timeoutMs = 60000) => {
  while (Date.now() - startedAt < timeoutMs) {
    if (await probeHttp(url, 1000)) return;
    setSplashStep("server", Math.round((Date.now() - startedAt) / 1000));
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
    args.push("preview");
  }
  args.push("--port", String(VITE_PORT), "--strictPort");
  const proc = spawn(process.execPath, args, {
    cwd: repoRoot,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  proc.stdout.on("data", (d) => process.stdout.write(d));
  proc.stderr.on("data", (d) => {
    process.stderr.write(d);
    const msg = d.toString();
    if (proc._lastError === undefined) proc._lastError = "";
    proc._lastError += msg;
  });
  return proc;
};

const createWindow = async (url) => {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    show: false,
    backgroundColor: "#0c0c10",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, "preload.cjs"),
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

  mainWindow.show();
  closeSplash();

  if (app.isPackaged) {
    initAutoUpdater(mainWindow);
  }
};

app.whenReady().then(async () => {
  const startedAt = Date.now();
  createSplash();
  setSplashStep("init", 0);

  const alreadyRunning = await probeHttp(VITE_PROBE_URL);
  if (!alreadyRunning) {
    setSplashStep("server", Math.round((Date.now() - startedAt) / 1000));
    viteProc = spawnVite();
    viteProc.on("exit", (code, signal) => {
      const detail = viteProc?._lastError || "(no stderr captured)";
      viteProc = null;
      if (code !== 0 && !signal && code !== 143) {
        closeSplash();
        dialog.showErrorBox(
          "Vite exited",
          `Vite dev server exited with code ${code}.\n\n${detail}`,
        );
        app.quit();
      }
    });
    try {
      await waitForServer(VITE_PROBE_URL, startedAt);
    } catch (err) {
      closeSplash();
      dialog.showErrorBox("Vite failed to start", String(err));
      app.quit();
      return;
    }
  } else {
    console.log(`reusing existing vite server at ${VITE_URL}`);
  }

  setSplashStep("ready", Math.round((Date.now() - startedAt) / 1000));
  await new Promise((r) => setTimeout(r, 300));
  setSplashStep("editor", Math.round((Date.now() - startedAt) / 1000));
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
