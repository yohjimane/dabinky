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
// Per-render temporary directory for intermediate chunk files produced by the
// parallel-render pipeline. Cleaned up after each successful concat.
const chunksDir = path.join(outDir, ".chunks");
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

// State for in-flight parallel renders. Each render has N pending chunk
// promises (resolved when /api/save-chunk writes the blob), a progress array,
// and a ref to the NDJSON send function so chunk-progress/error events can
// push updates back to the editor.
type ParallelRender = {
  totalChunks: number;
  received: Set<number>;
  chunkResolvers: Array<{
    resolve: () => void;
    reject: (err: Error) => void;
  }>;
  chunkProgress: number[];
  emit: (obj: Record<string, unknown>) => void;
  outputBasename: string;
};
const parallelRenders = new Map<string, ParallelRender>();

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
            const stat = fs.statSync(outputPath);
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                ok: true,
                path: `out/${safeName}`,
                size: stat.size,
              }),
            );
          });
          out.on("error", (err) => {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: err.message }));
          });
        });

        // Each chunk page POSTs its rendered MP4 blob here. We write it to
        // the per-render chunks dir and resolve the orchestrator's promise
        // for this chunk so it can proceed to concat once all N arrive.
        server.middlewares.use("/api/save-chunk", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const url = new URL(req.url ?? "", "http://localhost");
          const renderId = url.searchParams.get("renderId") ?? "";
          const chunkIdx = Number(url.searchParams.get("chunk") ?? "-1");
          const render = parallelRenders.get(renderId);
          if (!render || chunkIdx < 0 || chunkIdx >= render.totalChunks) {
            res.statusCode = 404;
            res.end(
              JSON.stringify({ ok: false, error: "unknown renderId/chunk" }),
            );
            return;
          }
          const chunkPath = path.join(
            chunksDir,
            renderId,
            `chunk-${chunkIdx}.mp4`,
          );
          fs.mkdirSync(path.dirname(chunkPath), { recursive: true });
          const w = fs.createWriteStream(chunkPath);
          req.pipe(w);
          w.on("finish", () => {
            render.received.add(chunkIdx);
            render.chunkResolvers[chunkIdx]?.resolve();
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          });
          w.on("error", (err) => {
            render.chunkResolvers[chunkIdx]?.reject(err);
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: err.message }));
          });
        });

        server.middlewares.use("/api/chunk-progress", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const url = new URL(req.url ?? "", "http://localhost");
          const renderId = url.searchParams.get("renderId") ?? "";
          const chunkIdx = Number(url.searchParams.get("chunk") ?? "-1");
          const progress = Number(url.searchParams.get("progress") ?? "0");
          const render = parallelRenders.get(renderId);
          if (!render || chunkIdx < 0 || chunkIdx >= render.totalChunks) {
            res.statusCode = 404;
            res.end("unknown");
            return;
          }
          render.chunkProgress[chunkIdx] = progress;
          const total =
            render.chunkProgress.reduce((s, p) => s + p, 0) /
            render.totalChunks;
          render.emit({
            type: "progress",
            chunk: chunkIdx,
            progress,
            overall: total,
          });
          res.statusCode = 204;
          res.end();
        });

        server.middlewares.use("/api/chunk-error", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          const url = new URL(req.url ?? "", "http://localhost");
          const renderId = url.searchParams.get("renderId") ?? "";
          const chunkIdx = Number(url.searchParams.get("chunk") ?? "-1");
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", () => {
            const render = parallelRenders.get(renderId);
            if (!render) {
              res.statusCode = 404;
              res.end("unknown");
              return;
            }
            let msg = "chunk failed";
            try {
              const parsed = JSON.parse(body);
              if (parsed?.error) msg = String(parsed.error);
            } catch {
              // ignore
            }
            render.chunkResolvers[chunkIdx]?.reject(new Error(msg));
            res.statusCode = 204;
            res.end();
          });
        });

        server.middlewares.use("/api/parallel-render", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          let body = "";
          req.on("data", (c) => {
            body += c;
          });
          req.on("end", async () => {
            res.setHeader("content-type", "application/x-ndjson");
            res.setHeader("cache-control", "no-cache");
            res.setHeader("x-accel-buffering", "no");
            const emit = (obj: Record<string, unknown>) => {
              if (!res.writableEnded) res.write(JSON.stringify(obj) + "\n");
            };

            const renderId = Math.random().toString(36).slice(2, 10);
            let state: ParallelRender | null = null;
            let aborted = false;
            // Browsers spawned below; tracked in outer scope so the
            // disconnect handler can tear them down if the client bails.
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let browsersRef: Array<any> = [];
            // Fires when the editor tab aborts its fetch (e.g. user hit
            // Cancel, or navigated away). Without this the chunk promises
            // below hang forever and Playwright browsers keep burning CPU.
            res.on("close", () => {
              if (res.writableFinished) return;
              aborted = true;
              if (state) {
                for (const r of state.chunkResolvers) {
                  r.reject(new Error("client disconnected"));
                }
              }
              // Kill browsers fire-and-forget; the finally below also
              // attempts cleanup, but that only runs if the Promise.all
              // resolves or rejects — this is the first line of defence.
              for (const b of browsersRef) {
                void b.close().catch(() => {});
              }
            });
            try {
              const parsed = body ? JSON.parse(body) : {};
              const workers = Math.max(1, Math.min(8, Number(parsed.workers ?? 2)));
              const codec = String(parsed.codec ?? "h265");
              const bitrate = String(parsed.bitrate ?? "medium");
              const rawName = String(parsed.filename ?? "").trim();
              const outputBasename =
                (rawName || `render-${Date.now()}`)
                  .replace(/[^A-Za-z0-9._ -]/g, "_")
                  .replace(/\.mp4$/i, "") + ".mp4";

              // Pre-create resolvers for each chunk so save-chunk handlers
              // can find them before the workers finish loading.
              const chunkResolvers = Array.from(
                { length: workers },
                () => {
                  let resolve: () => void = () => {};
                  let reject: (e: Error) => void = () => {};
                  const p = new Promise<void>((res2, rej2) => {
                    resolve = res2;
                    reject = rej2;
                  });
                  return { promise: p, resolve, reject };
                },
              );
              state = {
                totalChunks: workers,
                received: new Set<number>(),
                chunkResolvers,
                chunkProgress: new Array(workers).fill(0),
                emit,
                outputBasename,
              };
              parallelRenders.set(renderId, state);
              emit({ type: "started", renderId, workers });

              // Launch N independent Playwright browser processes. Each
              // process is its own OS process — no inter-browser throttling,
              // no Safari window-focus heuristics. We pick chromium vs
              // webkit based on the engine the editor tab is running in:
              // Chromium gives fast HEVC parallel, WebKit gives AV1 parallel
              // (M3+ has hardware AV1 encoder).
              const engine = parsed.engine === "webkit" ? "webkit" : "chromium";
              emit({ type: "stage", stage: "starting-browsers", engine });
              const playwright = await import("playwright");
              const launcher = engine === "webkit" ? playwright.webkit : playwright.chromium;
              const browsers = await Promise.all(
                Array.from({ length: workers }, () =>
                  launcher.launch({ headless: true }),
                ),
              );
              browsersRef = browsers;
              // If the client bailed while we were launching, tear down and
              // exit without running the render.
              if (aborted) {
                await Promise.all(
                  browsers.map((b) => b.close().catch(() => {})),
                );
                return;
              }
              try {
                emit({ type: "stage", stage: "rendering" });

                // One page per browser, each pointed at its chunk URL.
                await Promise.all(
                  browsers.map(async (browser, i) => {
                    const ctx = await browser.newContext();
                    const page = await ctx.newPage();
                    const u = new URL(
                      "http://localhost:5180/chunk-render.html",
                    );
                    u.searchParams.set("chunk", String(i));
                    u.searchParams.set("total", String(workers));
                    u.searchParams.set("renderId", renderId);
                    u.searchParams.set("codec", codec);
                    u.searchParams.set("bitrate", bitrate);
                    // Don't await the navigation promise; the chunk page
                    // POSTs back /api/save-chunk on its own when done.
                    void page.goto(u.toString()).catch((err) => {
                      // Navigation errors are surfaced via chunkResolvers
                      // rejection in the chunk-error handler — don't need to
                      // handle here unless goto itself throws.
                      state?.chunkResolvers[i]?.reject(err as Error);
                    });
                  }),
                );

                // Wait for every chunk to upload. A failed chunk-error route
                // rejects the corresponding promise, bubbling up here.
                await Promise.all(chunkResolvers.map((r) => r.promise));
              } finally {
                // Always close browsers, even on error.
                await Promise.all(
                  browsers.map((b) => b.close().catch(() => {})),
                );
              }

              emit({ type: "stage", stage: "concat" });
              if (!fs.existsSync(outDir))
                fs.mkdirSync(outDir, { recursive: true });
              const concatList = path.join(
                chunksDir,
                renderId,
                "concat.txt",
              );
              fs.writeFileSync(
                concatList,
                Array.from({ length: workers }, (_, i) =>
                  `file '${path.join(chunksDir, renderId, `chunk-${i}.mp4`).replace(/'/g, "'\\''")}'`,
                ).join("\n") + "\n",
              );
              const outputPath = path.join(outDir, outputBasename);
              await new Promise<void>((resolve, reject) => {
                const ff = spawn(
                  "ffmpeg",
                  [
                    "-y",
                    "-f",
                    "concat",
                    "-safe",
                    "0",
                    "-i",
                    concatList,
                    "-c",
                    "copy",
                    outputPath,
                  ],
                  { stdio: ["ignore", "ignore", "pipe"] },
                );
                let stderr = "";
                ff.stderr.on("data", (chunk) => {
                  stderr += chunk.toString();
                });
                ff.on("error", (err) => {
                  if ((err as NodeJS.ErrnoException).code === "ENOENT") {
                    reject(
                      new Error(
                        "ffmpeg not installed; required for parallel render concat",
                      ),
                    );
                  } else {
                    reject(err);
                  }
                });
                ff.on("close", (code) => {
                  if (code === 0) resolve();
                  else
                    reject(
                      new Error(
                        `ffmpeg exited with code ${code}: ${stderr.slice(-500)}`,
                      ),
                    );
                });
              });

              // Clean up the per-render chunk directory.
              try {
                fs.rmSync(path.join(chunksDir, renderId), {
                  recursive: true,
                  force: true,
                });
              } catch {
                /* ignore */
              }

              const stat = fs.statSync(outputPath);
              emit({
                type: "done",
                outputPath: `out/${outputBasename}`,
                size: stat.size,
              });
            } catch (err) {
              // Don't emit errors to a client that's already gone; it just
              // noise in the response buffer and may throw EPIPE.
              if (!aborted) {
                emit({ type: "error", message: (err as Error).message });
              }
            } finally {
              parallelRenders.delete(renderId);
              // Make sure browsers are down even if the try block didn't
              // reach its own cleanup (e.g. threw before launch completed).
              await Promise.all(
                browsersRef.map((b) => b.close().catch(() => {})),
              );
              if (!res.writableEnded) res.end();
            }
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
