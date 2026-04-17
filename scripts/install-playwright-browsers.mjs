import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const browsersDir = path.join(repoRoot, "pw-browsers");

const env = {
  ...process.env,
  PLAYWRIGHT_BROWSERS_PATH: browsersDir,
};

const result = spawnSync(
  "npx",
  ["playwright", "install", "chromium", "webkit"],
  { cwd: repoRoot, env, stdio: "inherit" },
);

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

console.log(`[install-playwright-browsers] browsers installed at ${browsersDir}`);
