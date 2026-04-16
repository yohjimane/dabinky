import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(here, "..", "src", "data");
const defaultPath = path.join(dataDir, "composition.default.json");
const localPath = path.join(dataDir, "composition.json");

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
