import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";

const repoRoot = path.resolve(__dirname);
const jsonPath = path.join(repoRoot, "src/data/composition.json");
const defaultJsonPath = path.join(
  repoRoot,
  "src/data/composition.default.json",
);
const publicDir = path.join(repoRoot, "public");
const mediaDir = path.join(publicDir, "media");
const outDir = path.join(repoRoot, "out");
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

const MIME_BY_EXT: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
};

const ensureMediaDir = () => {
  if (!fs.existsSync(mediaDir)) {
    fs.mkdirSync(mediaDir, { recursive: true });
  }
};

// Resolve a clip's src (like "media/foo.mp4" or legacy "foo.mp4") to its
// absolute filesystem path, staying inside publicDir.
const resolveAssetPath = (relName: string): string | null => {
  const normalized = relName.replace(/^\/+/, "");
  const abs = path.join(publicDir, normalized);
  if (!abs.startsWith(publicDir + path.sep) && abs !== publicDir) return null;
  return abs;
};

export default defineConfig({
  root: path.join(repoRoot, "editor"),
  publicDir: path.join(repoRoot, "public"),
  server: {
    port: 5180,
    fs: {
      allow: [repoRoot],
    },
  },
  resolve: {
    alias: {
      "@src": path.join(repoRoot, "src"),
    },
  },
  plugins: [
    react(),
    {
      name: "composition-json-api",
      configureServer(server) {
        // Serve /media/* directly from disk. Vite's built-in public middleware
        // caches the public dir file list and updates it async via a file
        // watcher, so immediately after /api/rename there's a window where
        // the new URL isn't in Vite's set and the SPA fallback returns
        // index.html — poisoning <video> elements with an unplayable response.
        server.middlewares.use("/media", (req, res, next) => {
          if (req.method !== "GET" && req.method !== "HEAD") return next();
          const rawUrl = (req.url ?? "/").split("?")[0].split("#")[0];
          let rel: string;
          try {
            rel = decodeURI(rawUrl).replace(/^\/+/, "");
          } catch {
            return next();
          }
          const abs = path.join(mediaDir, rel);
          if (!abs.startsWith(mediaDir + path.sep)) {
            res.statusCode = 403;
            return res.end("forbidden");
          }
          let stat: fs.Stats;
          try {
            stat = fs.statSync(abs);
          } catch {
            return next();
          }
          if (!stat.isFile()) return next();
          const ext = path.extname(abs).toLowerCase();
          res.setHeader(
            "content-type",
            MIME_BY_EXT[ext] ?? "application/octet-stream",
          );
          res.setHeader("accept-ranges", "bytes");
          res.setHeader("cache-control", "no-cache");
          const range = req.headers.range;
          if (range) {
            const m = /^bytes=(\d*)-(\d*)$/.exec(range);
            if (m) {
              const start = m[1] ? parseInt(m[1], 10) : 0;
              const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
              if (
                Number.isNaN(start) ||
                Number.isNaN(end) ||
                start > end ||
                end >= stat.size
              ) {
                res.statusCode = 416;
                res.setHeader("content-range", `bytes */${stat.size}`);
                return res.end();
              }
              res.statusCode = 206;
              res.setHeader("content-range", `bytes ${start}-${end}/${stat.size}`);
              res.setHeader("content-length", String(end - start + 1));
              if (req.method === "HEAD") return res.end();
              fs.createReadStream(abs, { start, end }).pipe(res);
              return;
            }
          }
          res.statusCode = 200;
          res.setHeader("content-length", String(stat.size));
          if (req.method === "HEAD") return res.end();
          fs.createReadStream(abs).pipe(res);
        });
        server.middlewares.use("/api/composition", (req, res) => {
          if (req.method === "GET") {
            if (!fs.existsSync(jsonPath) && fs.existsSync(defaultJsonPath)) {
              fs.copyFileSync(defaultJsonPath, jsonPath);
            }
            const raw = fs.readFileSync(jsonPath, "utf8");
            res.setHeader("content-type", "application/json");
            res.end(raw);
            return;
          }
          if (req.method === "POST") {
            let body = "";
            req.on("data", (chunk) => {
              body += chunk;
            });
            req.on("end", () => {
              try {
                const parsed = JSON.parse(body);
                fs.writeFileSync(
                  jsonPath,
                  JSON.stringify(parsed, null, 2) + "\n",
                );
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true }));
              } catch (err) {
                res.statusCode = 400;
                res.end(
                  JSON.stringify({
                    ok: false,
                    error: (err as Error).message,
                  }),
                );
              }
            });
            return;
          }
          res.statusCode = 405;
          res.end("method not allowed");
        });
        server.middlewares.use("/api/upload", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const rawName = req.headers["x-filename"];
          if (typeof rawName !== "string" || !rawName) {
            res.statusCode = 400;
            res.end(
              JSON.stringify({ ok: false, error: "missing x-filename" }),
            );
            return;
          }
          let filename: string;
          try {
            filename = decodeURIComponent(rawName);
          } catch {
            res.statusCode = 400;
            res.end(
              JSON.stringify({ ok: false, error: "invalid x-filename" }),
            );
            return;
          }
          const base = path.basename(filename).replace(/[^A-Za-z0-9._ -]/g, "_");
          const ext = path.extname(base).toLowerCase();
          if (!VIDEO_EXT.has(ext)) {
            res.statusCode = 415;
            res.end(
              JSON.stringify({
                ok: false,
                error: `unsupported extension: ${ext || "(none)"}`,
              }),
            );
            return;
          }
          ensureMediaDir();
          const dest = path.join(mediaDir, base);
          if (!dest.startsWith(mediaDir + path.sep)) {
            res.statusCode = 400;
            res.end(
              JSON.stringify({ ok: false, error: "invalid destination" }),
            );
            return;
          }
          const out = fs.createWriteStream(dest);
          req.pipe(out);
          out.on("finish", () => {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true, name: `media/${base}` }));
          });
          out.on("error", (err) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: err.message }));
          });
        });
        server.middlewares.use("/api/rename", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", () => {
            try {
              const { from, to } = JSON.parse(body) as {
                from?: string;
                to?: string;
              };
              if (!from || !to) throw new Error("missing from/to");
              const fromAbs = resolveAssetPath(from);
              if (!fromAbs) throw new Error("invalid source path");
              if (!fs.existsSync(fromAbs))
                throw new Error(`source not found: ${from}`);
              const fromDir = path.dirname(fromAbs);
              const fromExt = path.extname(fromAbs).toLowerCase();
              const toBase = path
                .basename(to)
                .replace(/[^A-Za-z0-9._ -]/g, "_");
              if (!toBase) throw new Error("invalid target name");
              const toExt = path.extname(toBase).toLowerCase();
              if (!VIDEO_EXT.has(fromExt))
                throw new Error(`source not a video: ${fromExt}`);
              if (!VIDEO_EXT.has(toExt))
                throw new Error(
                  `target must keep a video extension: ${toExt || "(none)"}`,
                );
              const toAbs = path.join(fromDir, toBase);
              if (!toAbs.startsWith(publicDir + path.sep))
                throw new Error("invalid target path");
              if (fromAbs !== toAbs && fs.existsSync(toAbs))
                throw new Error(`target already exists: ${toBase}`);
              if (fromAbs !== toAbs) fs.renameSync(fromAbs, toAbs);
              // Return path using the same directory as from (relative to public/)
              const relFromDir = path.relative(publicDir, fromDir);
              const toRel = relFromDir ? `${relFromDir}/${toBase}` : toBase;
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ ok: true, from, to: toRel }));
            } catch (err) {
              res.statusCode = 400;
              res.end(
                JSON.stringify({
                  ok: false,
                  error: (err as Error).message,
                }),
              );
            }
          });
        });
        server.middlewares.use("/api/assets", (req, res) => {
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          try {
            ensureMediaDir();
            const listDir = (
              absDir: string,
              relPrefix: string,
            ): { name: string; size: number; mtime: number }[] => {
              if (!fs.existsSync(absDir)) return [];
              return fs
                .readdirSync(absDir, { withFileTypes: true })
                .filter((e) => e.isFile())
                .filter((e) =>
                  VIDEO_EXT.has(path.extname(e.name).toLowerCase()),
                )
                .map((e) => {
                  const stat = fs.statSync(path.join(absDir, e.name));
                  return {
                    name: relPrefix ? `${relPrefix}/${e.name}` : e.name,
                    size: stat.size,
                    mtime: stat.mtimeMs,
                  };
                });
            };
            const assets = [
              ...listDir(mediaDir, "media"),
              ...listDir(publicDir, ""),
            ].sort((a, b) => b.mtime - a.mtime);
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ assets }));
          } catch (err) {
            res.statusCode = 500;
            res.end(
              JSON.stringify({
                ok: false,
                error: (err as Error).message,
              }),
            );
          }
        });
        // Save a client-side render: accepts the MP4 body streamed from the
        // browser (produced by @remotion/web-renderer) and writes it to out/.
        server.middlewares.use("/api/save-render", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const rawName = req.headers["x-filename"];
          if (typeof rawName !== "string" || !rawName) {
            res.statusCode = 400;
            res.end(
              JSON.stringify({ ok: false, error: "missing x-filename" }),
            );
            return;
          }
          let filename: string;
          try {
            filename = decodeURIComponent(rawName);
          } catch {
            res.statusCode = 400;
            res.end(
              JSON.stringify({ ok: false, error: "invalid x-filename" }),
            );
            return;
          }
          const safeName =
            filename
              .replace(/[^A-Za-z0-9._ -]/g, "_")
              .replace(/\.mp4$/i, "") + ".mp4";
          const outputPath = path.join(outDir, safeName);
          if (!outputPath.startsWith(outDir + path.sep)) {
            res.statusCode = 400;
            res.end(
              JSON.stringify({ ok: false, error: "invalid output path" }),
            );
            return;
          }
          if (!fs.existsSync(outDir))
            fs.mkdirSync(outDir, { recursive: true });
          const out = fs.createWriteStream(outputPath);
          req.pipe(out);
          out.on("finish", () => {
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({ ok: true, path: `out/${safeName}` }),
            );
          });
          out.on("error", (err) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: err.message }));
          });
        });
        server.middlewares.use("/api/reveal", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", () => {
            try {
              const { path: relPath } = JSON.parse(body) as { path?: string };
              if (!relPath) throw new Error("missing path");
              const abs = path.resolve(repoRoot, relPath);
              if (!abs.startsWith(outDir + path.sep))
                throw new Error("only files under out/ can be revealed");
              if (!fs.existsSync(abs)) throw new Error("file not found");
              // macOS: -R reveals the file in Finder. On Linux/Windows this is
              // a no-op — we just open the directory.
              const args =
                process.platform === "darwin"
                  ? ["-R", abs]
                  : [path.dirname(abs)];
              const cmd = process.platform === "win32" ? "explorer" : "open";
              spawn(cmd, args, { detached: true, stdio: "ignore" }).unref();
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ ok: true }));
            } catch (err) {
              res.statusCode = 400;
              res.end(
                JSON.stringify({
                  ok: false,
                  error: (err as Error).message,
                }),
              );
            }
          });
        });
      },
    },
  ],
});
