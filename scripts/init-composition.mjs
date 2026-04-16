import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const dataDir = path.join(root, "src", "data");
const defaultPath = path.join(dataDir, "composition.default.json");
const localPath = path.join(dataDir, "composition.json");
const mediaDir = path.join(root, "public", "media");

if (!fs.existsSync(defaultPath)) {
  console.error(`[init-composition] missing ${defaultPath}`);
  process.exit(1);
}

if (!fs.existsSync(localPath)) {
  fs.copyFileSync(defaultPath, localPath);
  console.log(
    "[init-composition] created src/data/composition.json from default",
  );
}

if (!fs.existsSync(mediaDir)) {
  fs.mkdirSync(mediaDir, { recursive: true });
  console.log("[init-composition] created public/media/");
}
