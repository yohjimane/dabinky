import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(__dirname);
const jsonPath = path.join(repoRoot, "src/data/composition.json");
const publicDir = path.join(repoRoot, "public");
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

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
        server.middlewares.use("/api/composition", (req, res) => {
          if (req.method === "GET") {
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
          const dest = path.join(publicDir, base);
          if (!dest.startsWith(publicDir + path.sep)) {
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
            res.end(JSON.stringify({ ok: true, name: base }));
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
              const fromBase = path.basename(from);
              const toBase = path
                .basename(to)
                .replace(/[^A-Za-z0-9._ -]/g, "_");
              if (!toBase) throw new Error("invalid target name");
              const fromExt = path.extname(fromBase).toLowerCase();
              const toExt = path.extname(toBase).toLowerCase();
              if (!VIDEO_EXT.has(fromExt))
                throw new Error(`source not a video: ${fromExt}`);
              if (!VIDEO_EXT.has(toExt))
                throw new Error(
                  `target must keep a video extension: ${toExt || "(none)"}`,
                );
              const fromPath = path.join(publicDir, fromBase);
              const toPath = path.join(publicDir, toBase);
              if (!fromPath.startsWith(publicDir + path.sep))
                throw new Error("invalid source path");
              if (!toPath.startsWith(publicDir + path.sep))
                throw new Error("invalid target path");
              if (!fs.existsSync(fromPath))
                throw new Error(`source not found: ${fromBase}`);
              if (fromPath !== toPath && fs.existsSync(toPath))
                throw new Error(`target already exists: ${toBase}`);
              if (fromPath !== toPath) fs.renameSync(fromPath, toPath);
              res.setHeader("content-type", "application/json");
              res.end(
                JSON.stringify({ ok: true, from: fromBase, to: toBase }),
              );
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
            const entries = fs.readdirSync(publicDir, { withFileTypes: true });
            const assets = entries
              .filter((e) => e.isFile())
              .filter((e) => VIDEO_EXT.has(path.extname(e.name).toLowerCase()))
              .map((e) => {
                const stat = fs.statSync(path.join(publicDir, e.name));
                return {
                  name: e.name,
                  size: stat.size,
                  mtime: stat.mtimeMs,
                };
              })
              .sort((a, b) => b.mtime - a.mtime);
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
      },
    },
  ],
});
