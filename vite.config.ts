import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn, execSync } from "node:child_process";
import http from "node:http";
import {
  Zip,
  ZipDeflate,
  ZipPassThrough,
  Unzip,
  UnzipInflate,
  type UnzipFile,
} from "fflate";
import { z } from "zod";
import ffmpegStaticPath from "ffmpeg-static";

// In a packaged Electron app, ffmpeg-static's path points inside app.asar,
// but the binary itself is extracted next to asar via electron-builder's
// asarUnpack rule. Swap the path at runtime so spawn() hits the unpacked copy.
const ffmpegPath = (() => {
  if (!ffmpegStaticPath) return "ffmpeg";
  return ffmpegStaticPath.includes(`${path.sep}app.asar${path.sep}`)
    ? ffmpegStaticPath.replace(
        `${path.sep}app.asar${path.sep}`,
        `${path.sep}app.asar.unpacked${path.sep}`,
      )
    : ffmpegStaticPath;
})();

const repoRoot = path.resolve(__dirname);
// In a packaged Electron build, Electron sets DABINKY_DATA_ROOT to a writable
// directory (app.getPath("userData")) and all user data lives there. In dev it
// stays unset and we use the legacy repo-relative paths so existing devs don't
// have to migrate anything.
const usingExternalDataRoot = Boolean(process.env.DABINKY_DATA_ROOT);
const dataRoot = usingExternalDataRoot
  ? path.resolve(process.env.DABINKY_DATA_ROOT as string)
  : repoRoot;
const jsonPath = usingExternalDataRoot
  ? path.join(dataRoot, "composition.json")
  : path.join(repoRoot, "src/data/composition.json");
const defaultJsonPath = path.join(
  repoRoot,
  "src/data/composition.default.json",
);
const publicDir = path.join(repoRoot, "public");
const mediaDir = usingExternalDataRoot
  ? path.join(dataRoot, "media")
  : path.join(publicDir, "media");
const outDir = usingExternalDataRoot
  ? path.join(dataRoot, "out")
  : path.join(repoRoot, "out");
// Per-render temporary directory for intermediate chunk files produced by the
// parallel-render pipeline. Cleaned up after each successful concat. Always
// lives under dataRoot regardless of user's chosen outputDir so the user's
// Movies folder never gets littered with .chunks debris.
const chunksDir = path.join(outDir, ".chunks");

// User-level settings stored at dataRoot/settings.json. Currently only holds
// outputDir (where rendered MP4s land). Default is ~/Movies/Dabinky on macOS
// since that's the native location Finder surfaces for videos.
const settingsPath = path.join(dataRoot, "settings.json");
const DEFAULT_OUTPUT_DIR = path.join(os.homedir(), "Movies", "Dabinky");

type DabinkySettings = {
  outputDir: string;
};

const readSettings = (): DabinkySettings => {
  try {
    if (!fs.existsSync(settingsPath)) {
      return { outputDir: DEFAULT_OUTPUT_DIR };
    }
    const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return {
      outputDir:
        typeof raw.outputDir === "string" && raw.outputDir.trim()
          ? raw.outputDir
          : DEFAULT_OUTPUT_DIR,
    };
  } catch {
    return { outputDir: DEFAULT_OUTPUT_DIR };
  }
};

const writeSettings = (next: DabinkySettings) => {
  ensureParentDir(settingsPath);
  fs.writeFileSync(settingsPath, JSON.stringify(next, null, 2) + "\n");
};
const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

// .dabinky bundle format. formatVersion is written into manifest.json; bump
// when the on-disk shape changes in a way that requires a migration on import.
const DABINKY_FORMAT_VERSION = 1;
const DABINKY_MAX_IMPORT_BYTES = 5 * 1024 * 1024 * 1024;
const pkgVersion = (() => {
  try {
    return (
      JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"))
        .version ?? "0.0.0"
    );
  } catch {
    return "0.0.0";
  }
})();

// Minimal schemas used to validate an incoming composition.json at import
// time. Intentionally duplicated from src/Composition.tsx — importing the
// editor schema would pull Remotion/React into the vite config. Keep these in
// sync when the real schema evolves.
const ImportClipSchema = z.object({
  src: z.string(),
  from: z.number(),
  startFrom: z.number(),
  endAt: z.number(),
  fadeIn: z.number().optional(),
  fadeOut: z.number().optional(),
});
const ImportVideoTrackSchema = z.object({
  id: z.string(),
  name: z.string(),
  clips: z.array(ImportClipSchema),
});
const ImportTextSegmentSchema = z.object({
  from: z.number(),
  duration: z.number(),
  text: z.string(),
  fadeIn: z.number().optional(),
  fadeOut: z.number().optional(),
});
const ImportTextTrackSchema = z.object({
  id: z.string(),
  name: z.string(),
  segments: z.array(ImportTextSegmentSchema),
});
const ImportCompositionSchema = z.object({
  fadeDuration: z.number(),
  fontSize: z.number(),
  textColor: z.string(),
  bgColor: z.string(),
  bgBorderRadius: z.number(),
  paddingBottom: z.number(),
  videoTracks: z.array(ImportVideoTrackSchema),
  textTracks: z.array(ImportTextTrackSchema),
});
const ImportManifestSchema = z.object({
  formatVersion: z.number(),
  createdAt: z.string().optional(),
  editorVersion: z.string().optional(),
});
type ImportComposition = z.infer<typeof ImportCompositionSchema>;

const MEDIA_ENTRY_NAME_RE = /^[A-Za-z0-9._ -]+\.[A-Za-z0-9]+$/;

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

const ensureParentDir = (p: string) => {
  const parent = path.dirname(p);
  if (!fs.existsSync(parent)) {
    fs.mkdirSync(parent, { recursive: true });
  }
};

// Resolve a clip's src (like "media/foo.mp4" or legacy "foo.mp4") to its
// absolute filesystem path. media/* routes to mediaDir (which may live outside
// publicDir in packaged mode); anything else stays under publicDir.
const resolveAssetPath = (relName: string): string | null => {
  const normalized = relName.replace(/^\/+/, "");
  if (normalized.startsWith("media/")) {
    const sub = normalized.slice("media/".length);
    const abs = path.join(mediaDir, sub);
    if (!abs.startsWith(mediaDir + path.sep) && abs !== mediaDir) return null;
    return abs;
  }
  const abs = path.join(publicDir, normalized);
  if (!abs.startsWith(publicDir + path.sep) && abs !== publicDir) return null;
  return abs;
};

// Track every ffmpeg child we spawn so the process can SIGKILL them on
// exit. Without this, a running libsvtav1 encode outlives the Electron /
// Vite parent (Node doesn't propagate shutdown to children) and pins the
// user's CPU until they manually killall. Added when spawned, removed on
// close.
const activeFfmpegs = new Set<ReturnType<typeof spawn>>();
const killAllFfmpegs = () => {
  for (const ff of activeFfmpegs) {
    if (ff.exitCode === null) {
      try {
        ff.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }
  }
  activeFfmpegs.clear();
};
process.on("exit", killAllFfmpegs);
process.on("SIGINT", () => {
  killAllFfmpegs();
  process.exit(130);
});
process.on("SIGTERM", () => {
  killAllFfmpegs();
  process.exit(143);
});

const HEVC_CODECS = new Set(["hevc", "h265"]);

const probeVideoCodec = (filePath: string): Promise<string> =>
  new Promise((resolve) => {
    const probe = spawn(ffmpegPath, ["-i", filePath], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    probe.stderr.on("data", (c: Buffer) => {
      stderr += c.toString();
    });
    probe.on("close", () => {
      const m = /Video:\s+(\w+)/.exec(stderr);
      resolve(m?.[1]?.toLowerCase() ?? "unknown");
    });
    probe.on("error", () => resolve("unknown"));
  });

const transcodeToH264 = (input: string, output: string): Promise<void> =>
  new Promise((resolve, reject) => {
    const ff = spawn(
      ffmpegPath,
      [
        "-y",
        "-i",
        input,
        "-c:v",
        "libx264",
        "-crf",
        "18",
        "-preset",
        "medium",
        "-pix_fmt",
        "yuv420p",
        "-an",
        "-movflags",
        "+faststart",
        output,
      ],
      { stdio: ["ignore", "ignore", "pipe"] },
    );
    activeFfmpegs.add(ff);
    ff.on("close", (code) => {
      activeFfmpegs.delete(ff);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg transcode exited with code ${code}`));
    });
    ff.on("error", (err) => {
      activeFfmpegs.delete(ff);
      reject(err);
    });
  });

// Standalone static media server for parallel render workers. Bypasses Vite's
// middleware stack: 6 Playwright workers pulling 100–200MB source files in
// parallel saturate Vite's single-threaded connect chain, so we give them a
// dedicated origin that only does range-aware file streaming.
export const MEDIA_SERVER_PORT = 5181;
let mediaServerStarted = false;
const ensureMediaServer = () => {
  if (mediaServerStarted) return;
  mediaServerStarted = true;
  const server = http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-methods", "GET, HEAD, OPTIONS");
    res.setHeader(
      "access-control-allow-headers",
      "range, content-type, accept",
    );
    res.setHeader("access-control-max-age", "86400");
    res.setHeader(
      "access-control-expose-headers",
      "content-range, accept-ranges, content-length, content-type",
    );
    if (req.method === "OPTIONS") {
      res.statusCode = 204;
      return res.end();
    }
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.statusCode = 405;
      return res.end();
    }
    const rawUrl = (req.url ?? "/").split("?")[0].split("#")[0];
    let rel: string;
    try {
      rel = decodeURI(rawUrl).replace(/^\/+/, "");
    } catch {
      res.statusCode = 400;
      return res.end();
    }
    if (!rel.startsWith("media/")) {
      res.statusCode = 404;
      return res.end();
    }
    const abs = path.join(mediaDir, rel.slice("media/".length));
    if (!abs.startsWith(mediaDir + path.sep)) {
      res.statusCode = 403;
      return res.end();
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(abs);
    } catch {
      res.statusCode = 404;
      return res.end();
    }
    if (!stat.isFile()) {
      res.statusCode = 404;
      return res.end();
    }
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
        res.setHeader(
          "content-range",
          `bytes ${start}-${end}/${stat.size}`,
        );
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
  server.on("error", (err) => {
    // EADDRINUSE is the common case on dev restarts — surface it clearly
    // rather than crashing the Vite process.
    console.error(
      `[dabinky] media server failed on :${MEDIA_SERVER_PORT}: ${(err as Error).message}`,
    );
    mediaServerStarted = false;
  });
  server.listen(MEDIA_SERVER_PORT, "127.0.0.1");
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
  build: {
    rollupOptions: {
      input: {
        index: path.join(repoRoot, "editor/index.html"),
        chunkRender: path.join(repoRoot, "editor/chunk-render.html"),
      },
    },
  },
  plugins: [
    react(),
    {
      name: "composition-json-api",
      configureServer: attachDabinkyMiddlewares,
      configurePreviewServer: attachDabinkyMiddlewares,
    },
  ],
});

function attachDabinkyMiddlewares(
  server: import("vite").ViteDevServer | import("vite").PreviewServer,
) {
        ensureMediaServer();
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
              ensureParentDir(jsonPath);
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
                ensureParentDir(jsonPath);
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

        server.middlewares.use("/api/settings", (req, res) => {
          if (req.method === "GET") {
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(readSettings()));
            return;
          }
          if (req.method === "POST") {
            let body = "";
            req.on("data", (chunk) => {
              body += chunk;
            });
            req.on("end", () => {
              try {
                const parsed = JSON.parse(body) as { outputDir?: unknown };
                if (
                  typeof parsed.outputDir !== "string" ||
                  !parsed.outputDir.trim()
                ) {
                  throw new Error("outputDir must be a non-empty string");
                }
                const next: DabinkySettings = {
                  outputDir: path.resolve(parsed.outputDir),
                };
                writeSettings(next);
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, settings: next }));
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

        // Export the current project (composition.json + referenced media)
        // as a streamed .dabinky ZIP. ZipPassThrough on MP4s skips deflate
        // (already-compressed payload, saves CPU for ~0 bytes), ZipDeflate on
        // the small JSON files.
        server.middlewares.use("/api/export-project", (req, res) => {
          if (req.method !== "GET") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          let compositionRaw: string;
          let composition: unknown;
          try {
            if (!fs.existsSync(jsonPath) && fs.existsSync(defaultJsonPath)) {
              fs.copyFileSync(defaultJsonPath, jsonPath);
            }
            compositionRaw = fs.readFileSync(jsonPath, "utf8");
            composition = JSON.parse(compositionRaw);
          } catch (err) {
            res.statusCode = 500;
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({ ok: false, error: (err as Error).message }),
            );
            return;
          }

          // Collect unique referenced media files. Split clips share a src,
          // so dedupe by path — don't embed the same MP4 three times.
          const seen = new Set<string>();
          const mediaFiles: { absPath: string; entryName: string }[] = [];
          const missingRefs: string[] = [];
          const videoTracks =
            (composition as { videoTracks?: unknown }).videoTracks;
          if (Array.isArray(videoTracks)) {
            for (const track of videoTracks) {
              const clips = (track as { clips?: unknown }).clips;
              if (!Array.isArray(clips)) continue;
              for (const clip of clips) {
                const src = (clip as { src?: unknown }).src;
                if (typeof src !== "string" || seen.has(src)) continue;
                seen.add(src);
                const abs = resolveAssetPath(src);
                if (!abs || !fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
                  missingRefs.push(src);
                  continue;
                }
                mediaFiles.push({
                  absPath: abs,
                  entryName: `media/${path.basename(src)}`,
                });
              }
            }
          }

          const url = new URL(req.url ?? "", "http://localhost");
          const rawName = (url.searchParams.get("filename") ?? "").trim();
          const cleanName =
            (rawName || `project-${Date.now()}`)
              .replace(/[^A-Za-z0-9._ -]/g, "_")
              .replace(/\.dabinky$/i, "") + ".dabinky";

          const manifest = {
            formatVersion: DABINKY_FORMAT_VERSION,
            createdAt: new Date().toISOString(),
            editorVersion: pkgVersion,
            missingMedia: missingRefs,
          };

          res.setHeader("content-type", "application/zip");
          res.setHeader(
            "content-disposition",
            `attachment; filename="${cleanName.replace(/"/g, "")}"`,
          );

          let aborted = false;
          res.on("close", () => {
            if (!res.writableFinished) aborted = true;
          });

          const zip = new Zip();
          zip.ondata = (err, chunk, final) => {
            if (err) {
              if (!res.writableEnded) res.destroy(err);
              return;
            }
            if (res.writableEnded) return;
            res.write(chunk);
            if (final) res.end();
          };

          // Order matters for streaming importers: manifest + composition
          // first so an importer can validate before touching any media.
          const manifestEntry = new ZipDeflate("manifest.json", { level: 6 });
          zip.add(manifestEntry);
          manifestEntry.push(
            new Uint8Array(Buffer.from(JSON.stringify(manifest, null, 2))),
            true,
          );

          const compEntry = new ZipDeflate("composition.json", { level: 6 });
          zip.add(compEntry);
          compEntry.push(new Uint8Array(Buffer.from(compositionRaw)), true);

          // Stream each media file through ZipPassThrough. Sequential rather
          // than parallel — fflate's Zip requires a single in-flight entry.
          (async () => {
            for (const { absPath, entryName } of mediaFiles) {
              if (aborted) return;
              await new Promise<void>((resolve, reject) => {
                const entry = new ZipPassThrough(entryName);
                zip.add(entry);
                const stream = fs.createReadStream(absPath);
                stream.on("data", (chunk) => {
                  const buf = chunk as Buffer;
                  entry.push(
                    new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength),
                    false,
                  );
                });
                stream.on("end", () => {
                  entry.push(new Uint8Array(0), true);
                  resolve();
                });
                stream.on("error", (err) => {
                  entry.push(new Uint8Array(0), true);
                  reject(err);
                });
              });
            }
            if (!aborted) zip.end();
          })().catch((err) => {
            if (!res.writableEnded) res.destroy(err);
          });
        });

        // Import a .dabinky ZIP: extract into a temp dir, validate, then
        // commit. Media collisions are resolved by SHA-256: byte-identical
        // files reuse the existing asset (no duplication on re-import), and
        // differing contents get a numeric suffix with clip.src rewritten to
        // match.
        server.middlewares.use("/api/import-project", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }

          const importId = crypto.randomBytes(8).toString("hex");
          const tempDir = path.join(os.tmpdir(), `dabinky-import-${importId}`);
          fs.mkdirSync(tempDir, { recursive: true });

          const cleanup = () => {
            try {
              fs.rmSync(tempDir, { recursive: true, force: true });
            } catch {
              // ignore
            }
          };
          const fail = (status: number, msg: string) => {
            cleanup();
            if (res.headersSent) return;
            res.statusCode = status;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: false, error: msg }));
          };

          let manifestChunks: Buffer[] | null = null;
          let compositionChunks: Buffer[] | null = null;
          // One entry per media/ file. originalBasename is the name as it
          // appeared in the archive (used to match clip.src). tempPath is
          // where we streamed it; fileClosed resolves when the write stream
          // emits "close" so we know it's safe to hash and move.
          const mediaEntries: {
            originalBasename: string;
            tempPath: string;
            fileClosed: Promise<void>;
          }[] = [];
          let totalBytes = 0;
          let parseError: Error | null = null;

          const unzip = new Unzip();
          unzip.register(UnzipInflate);

          unzip.onfile = (file: UnzipFile) => {
            if (parseError) return;
            const name = file.name;
            // Reject path traversal regardless of where in the tree: fflate
            // exposes the raw entry name, so `..` or absolute-path segments
            // must be blocked explicitly.
            if (
              name.includes("\0") ||
              name.includes("..") ||
              name.startsWith("/") ||
              path.isAbsolute(name)
            ) {
              parseError = new Error(`invalid entry path: ${name}`);
              return;
            }

            if (name === "manifest.json") {
              const chunks: Buffer[] = [];
              manifestChunks = chunks;
              file.ondata = (err, dat) => {
                if (err) {
                  parseError = err;
                  return;
                }
                chunks.push(Buffer.from(dat));
              };
              file.start();
              return;
            }
            if (name === "composition.json") {
              const chunks: Buffer[] = [];
              compositionChunks = chunks;
              file.ondata = (err, dat) => {
                if (err) {
                  parseError = err;
                  return;
                }
                chunks.push(Buffer.from(dat));
              };
              file.start();
              return;
            }
            if (name.startsWith("media/")) {
              const rest = name.slice("media/".length);
              if (!MEDIA_ENTRY_NAME_RE.test(rest)) {
                parseError = new Error(`invalid media filename: ${name}`);
                return;
              }
              const ext = path.extname(rest).toLowerCase();
              if (!VIDEO_EXT.has(ext)) {
                parseError = new Error(
                  `unsupported media extension: ${ext || "(none)"}`,
                );
                return;
              }
              const tempPath = path.join(tempDir, rest);
              const out = fs.createWriteStream(tempPath);
              const fileClosed = new Promise<void>((resolve, reject) => {
                out.on("close", () => resolve());
                out.on("error", reject);
              });
              mediaEntries.push({
                originalBasename: rest,
                tempPath,
                fileClosed,
              });
              file.ondata = (err, dat, final) => {
                if (err) {
                  parseError = err;
                  out.destroy();
                  return;
                }
                totalBytes += dat.length;
                if (totalBytes > DABINKY_MAX_IMPORT_BYTES) {
                  parseError = new Error(
                    `import exceeds ${DABINKY_MAX_IMPORT_BYTES} byte cap`,
                  );
                  out.destroy();
                  return;
                }
                out.write(Buffer.from(dat));
                if (final) out.end();
              };
              file.start();
              return;
            }
            parseError = new Error(`unexpected entry: ${name}`);
          };

          req.on("data", (chunk: Buffer) => {
            if (parseError) return;
            try {
              unzip.push(
                new Uint8Array(
                  chunk.buffer,
                  chunk.byteOffset,
                  chunk.byteLength,
                ),
                false,
              );
            } catch (err) {
              parseError = err as Error;
            }
          });

          req.on("error", (err) => fail(400, err.message));

          req.on("end", async () => {
            if (parseError) {
              return fail(400, parseError.message);
            }
            try {
              unzip.push(new Uint8Array(0), true);
            } catch (err) {
              return fail(400, (err as Error).message);
            }
            if (parseError) {
              return fail(400, (parseError as Error).message);
            }

            try {
              await Promise.all(mediaEntries.map((e) => e.fileClosed));
            } catch (err) {
              return fail(500, (err as Error).message);
            }

            if (!manifestChunks) return fail(400, "missing manifest.json");
            if (!compositionChunks)
              return fail(400, "missing composition.json");

            let manifest: z.infer<typeof ImportManifestSchema>;
            try {
              const manifestJson = JSON.parse(
                Buffer.concat(manifestChunks).toString("utf8"),
              );
              const parsed = ImportManifestSchema.safeParse(manifestJson);
              if (!parsed.success) {
                return fail(
                  400,
                  `invalid manifest: ${parsed.error.issues
                    .map((i) => i.message)
                    .join("; ")}`,
                );
              }
              manifest = parsed.data;
            } catch (err) {
              return fail(400, `malformed manifest.json: ${(err as Error).message}`);
            }
            if (manifest.formatVersion > DABINKY_FORMAT_VERSION) {
              return fail(
                400,
                `unsupported formatVersion ${manifest.formatVersion}; this editor supports up to ${DABINKY_FORMAT_VERSION}`,
              );
            }

            let composition: ImportComposition;
            try {
              const compJson = JSON.parse(
                Buffer.concat(compositionChunks).toString("utf8"),
              );
              const parsed = ImportCompositionSchema.safeParse(compJson);
              if (!parsed.success) {
                return fail(
                  400,
                  `invalid composition: ${parsed.error.issues
                    .map((i) => `${i.path.join(".")}: ${i.message}`)
                    .join("; ")}`,
                );
              }
              composition = parsed.data;
            } catch (err) {
              return fail(
                400,
                `malformed composition.json: ${(err as Error).message}`,
              );
            }

            ensureMediaDir();

            // Hash each imported media file and compare to any existing file
            // with the same basename. Byte-identical → reuse. Different → pick
            // a "<stem>-N<ext>" suffix and track the rename so we can rewrite
            // clip.src below.
            const hashFile = (p: string): string => {
              const h = crypto.createHash("sha256");
              h.update(fs.readFileSync(p));
              return h.digest("hex");
            };
            const renameMap = new Map<string, string>();
            const reusedExisting = new Set<string>();
            try {
              for (const entry of mediaEntries) {
                const existing = path.join(mediaDir, entry.originalBasename);
                if (!fs.existsSync(existing)) {
                  renameMap.set(entry.originalBasename, entry.originalBasename);
                  continue;
                }
                if (hashFile(existing) === hashFile(entry.tempPath)) {
                  renameMap.set(entry.originalBasename, entry.originalBasename);
                  reusedExisting.add(entry.originalBasename);
                  continue;
                }
                const ext = path.extname(entry.originalBasename);
                const stem = entry.originalBasename.slice(
                  0,
                  entry.originalBasename.length - ext.length,
                );
                let i = 1;
                let candidate = `${stem}-${i}${ext}`;
                while (fs.existsSync(path.join(mediaDir, candidate))) {
                  i += 1;
                  candidate = `${stem}-${i}${ext}`;
                }
                renameMap.set(entry.originalBasename, candidate);
              }
            } catch (err) {
              return fail(500, `hash/compare failed: ${(err as Error).message}`);
            }

            try {
              for (const entry of mediaEntries) {
                if (reusedExisting.has(entry.originalBasename)) {
                  fs.unlinkSync(entry.tempPath);
                  continue;
                }
                const finalName = renameMap.get(entry.originalBasename)!;
                const targetAbs = path.join(mediaDir, finalName);
                if (!targetAbs.startsWith(mediaDir + path.sep)) {
                  return fail(400, `resolved media path escapes media dir: ${finalName}`);
                }
                fs.renameSync(entry.tempPath, targetAbs);
              }
            } catch (err) {
              return fail(500, `media install failed: ${(err as Error).message}`);
            }

            // Rewrite clip.src for renames, and normalize to media/<name> for
            // any referenced asset we just installed.
            const warnings: string[] = [];
            const missing: string[] = [];
            for (const track of composition.videoTracks) {
              for (const clip of track.clips) {
                const base = path.basename(clip.src);
                if (renameMap.has(base)) {
                  const finalName = renameMap.get(base)!;
                  clip.src = `media/${finalName}`;
                } else {
                  const abs = resolveAssetPath(clip.src);
                  if (!abs || !fs.existsSync(abs)) missing.push(clip.src);
                }
              }
            }
            if (missing.length > 0) {
              warnings.push(
                `missing media (not included in archive, not present locally): ${Array.from(
                  new Set(missing),
                ).join(", ")}`,
              );
            }
            if (Array.isArray(manifest.missingMedia) && manifest.missingMedia.length > 0) {
              warnings.push(
                `archive was exported with missing assets: ${manifest.missingMedia.join(", ")}`,
              );
            }

            try {
              ensureParentDir(jsonPath);
              fs.writeFileSync(
                jsonPath,
                JSON.stringify(composition, null, 2) + "\n",
              );
            } catch (err) {
              return fail(500, `composition write failed: ${(err as Error).message}`);
            }

            cleanup();
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                ok: true,
                composition,
                warnings,
                mediaFiles: Array.from(renameMap.values()).map(
                  (n) => `media/${n}`,
                ),
                manifest,
              }),
            );
          });
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
          const tempPath = path.join(
            mediaDir,
            `._upload_${Date.now()}_${base}`,
          );
          const out = fs.createWriteStream(tempPath);
          req.pipe(out);
          out.on("finish", async () => {
            try {
              const codec = await probeVideoCodec(tempPath);
              if (HEVC_CODECS.has(codec)) {
                const outBase =
                  base.replace(/\.[^.]+$/, "") + ".mp4";
                const finalPath = path.join(mediaDir, outBase);
                await transcodeToH264(tempPath, finalPath);
                try {
                  fs.unlinkSync(tempPath);
                } catch {}
                res.setHeader("content-type", "application/json");
                res.end(
                  JSON.stringify({
                    ok: true,
                    name: `media/${outBase}`,
                    transcoded: true,
                  }),
                );
              } else {
                fs.renameSync(tempPath, dest);
                res.setHeader("content-type", "application/json");
                res.end(
                  JSON.stringify({ ok: true, name: `media/${base}` }),
                );
              }
            } catch (err) {
              try {
                fs.unlinkSync(tempPath);
              } catch {}
              res.statusCode = 500;
              res.end(
                JSON.stringify({
                  ok: false,
                  error: (err as Error).message,
                }),
              );
            }
          });
          out.on("error", (err) => {
            try {
              fs.unlinkSync(tempPath);
            } catch {}
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
              // mediaDir may live outside publicDir in packaged mode, so
              // figure out which bucket the source lives in and anchor the
              // target-path guard against that bucket.
              const isInMedia = fromAbs.startsWith(mediaDir + path.sep);
              const baseDir = isInMedia ? mediaDir : publicDir;
              const toAbs = path.join(fromDir, toBase);
              if (!toAbs.startsWith(baseDir + path.sep))
                throw new Error("invalid target path");
              if (fromAbs !== toAbs && fs.existsSync(toAbs))
                throw new Error(`target already exists: ${toBase}`);
              if (fromAbs !== toAbs) fs.renameSync(fromAbs, toAbs);
              // Preserve the "media/" prefix convention when renaming a media
              // asset; for loose files in publicDir use their relative dir.
              const relFromDir = isInMedia
                ? "media"
                : path.relative(publicDir, fromDir);
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
        server.middlewares.use("/api/clear-media", (req, res) => {
          if (req.method !== "POST") {
            res.statusCode = 405;
            res.end("method not allowed");
            return;
          }
          try {
            if (fs.existsSync(mediaDir)) {
              for (const entry of fs.readdirSync(mediaDir)) {
                fs.rmSync(path.join(mediaDir, entry), { recursive: true, force: true });
              }
            }
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify({ ok: true }));
          } catch (err) {
            res.statusCode = 500;
            res.end(JSON.stringify({ ok: false, error: (err as Error).message }));
          }
        });

        server.middlewares.use("/api/ensure-h264", (req, res) => {
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
            try {
              const { sources } = JSON.parse(body) as {
                sources?: string[];
              };
              if (!Array.isArray(sources) || sources.length === 0) {
                res.setHeader("content-type", "application/json");
                res.end(JSON.stringify({ ok: true, transcoded: {} }));
                return;
              }
              const seen = new Set<string>();
              const transcoded: Record<string, string> = {};
              for (const src of sources) {
                if (seen.has(src)) continue;
                seen.add(src);
                const abs = resolveAssetPath(src);
                if (!abs || !fs.existsSync(abs)) continue;
                const codec = await probeVideoCodec(abs);
                if (!HEVC_CODECS.has(codec)) continue;
                const stem = path.basename(abs, path.extname(abs));
                const outName = `${stem}.h264.mp4`;
                const outAbs = path.join(path.dirname(abs), outName);
                if (fs.existsSync(outAbs)) {
                  const isInMedia = abs.startsWith(mediaDir + path.sep);
                  const prefix = isInMedia ? "media" : "";
                  transcoded[src] = prefix
                    ? `${prefix}/${outName}`
                    : outName;
                  continue;
                }
                await transcodeToH264(abs, outAbs);
                const isInMedia = abs.startsWith(mediaDir + path.sep);
                const prefix = isInMedia ? "media" : "";
                transcoded[src] = prefix
                  ? `${prefix}/${outName}`
                  : outName;
              }
              res.setHeader("content-type", "application/json");
              res.end(JSON.stringify({ ok: true, transcoded }));
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
        });

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
          const destDir = readSettings().outputDir;
          const outputPath = path.join(destDir, safeName);
          if (!outputPath.startsWith(destDir + path.sep)) {
            res.statusCode = 400;
            res.end(
              JSON.stringify({ ok: false, error: "invalid output path" }),
            );
            return;
          }
          if (!fs.existsSync(destDir))
            fs.mkdirSync(destDir, { recursive: true });
          const out = fs.createWriteStream(outputPath);
          req.pipe(out);
          out.on("finish", () => {
            const stat = fs.statSync(outputPath);
            res.setHeader("content-type", "application/json");
            res.end(
              JSON.stringify({
                ok: true,
                path: outputPath,
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
            // ffmpeg child for the concat/re-encode step. Tracked so the
            // disconnect handler can SIGKILL it — libsvtav1 encodes can
            // run for minutes and otherwise survive the editor closing,
            // pinning the user's CPU.
            let activeFfmpeg: ReturnType<typeof spawn> | null = null;
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
              if (activeFfmpeg && activeFfmpeg.exitCode === null) {
                try {
                  activeFfmpeg.kill("SIGKILL");
                } catch {
                  /* ignore */
                }
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
              const engine =
                parsed.engine === "webkit" && process.platform === "darwin"
                  ? "webkit"
                  : "chromium";
              emit({ type: "stage", stage: "starting-browsers", engine });
              const playwright = await import("playwright");
              const launcher = engine === "webkit" ? playwright.webkit : playwright.chromium;
              // Old headless Chromium ships with GPU disabled, so WebCodecs
              // probes fall back to software encoding. New-headless + explicit
              // GPU flags let VideoToolbox-backed encoders light up. WebKit
              // ignores these and uses its own GPU path.
              const chromiumGpuArgs =
                process.platform === "darwin"
                  ? [
                      "--use-angle=metal",
                      "--enable-features=Vulkan,UseSkiaRenderer,CanvasOopRasterization",
                      "--ignore-gpu-blocklist",
                      "--enable-gpu-rasterization",
                      "--enable-zero-copy",
                      "--disable-gpu-driver-bug-workarounds",
                    ]
                  : [
                      "--use-angle=d3d11",
                      "--enable-features=Vulkan,UseSkiaRenderer,CanvasOopRasterization",
                      "--ignore-gpu-blocklist",
                      "--enable-gpu-rasterization",
                      "--enable-zero-copy",
                      "--disable-gpu-driver-bug-workarounds",
                    ];
              const browsers = await Promise.all(
                Array.from({ length: workers }, () =>
                  launcher.launch(
                    engine === "chromium"
                      ? { headless: true, args: chromiumGpuArgs }
                      : { headless: true },
                  ),
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
                    page.on("console", (msg) => {
                      const text = msg.text();
                      if (text.startsWith("[chunk ")) {
                        console.log(`[parallel-render] ${text}`);
                      }
                    });
                    page.on("pageerror", (err) => {
                      console.log(
                        `[parallel-render][chunk ${i}][pageerror] ${err.message}`,
                      );
                    });
                    // Media srcs are rewritten to the standalone media
                    // server in chunk-render.tsx before render. No
                    // page.route here — interception on a page with large
                    // POST uploads (save-chunk) drops bytes in some
                    // Playwright builds, producing 0-byte chunk files.
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
              const destDir = readSettings().outputDir;
              if (!fs.existsSync(destDir))
                fs.mkdirSync(destDir, { recursive: true });
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
              const outputPath = path.join(destDir, outputBasename);

              // Detect what codec the workers actually produced. 'auto' may
              // have resolved to any of av1/h265/h264 depending on the
              // engine; we need to know which so we can decide between a
              // stream-copy concat and an AV1 re-encode pass.
              const firstChunk = path.join(
                chunksDir,
                renderId,
                "chunk-0.mp4",
              );
              const probeChunk = (chunkPath: string) =>
                new Promise<{ codec: string; durationUs: number }>(
                  (resolveProbe) => {
                    const probe = spawn(ffmpegPath, ["-i", chunkPath], {
                      stdio: ["ignore", "ignore", "pipe"],
                    });
                    let probeStderr = "";
                    probe.stderr.on("data", (c) => {
                      probeStderr += c.toString();
                    });
                    probe.on("close", () => {
                      const codecM = /Video:\s+(\w+)/.exec(probeStderr);
                      const durM =
                        /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(
                          probeStderr,
                        );
                      const durationUs = durM
                        ? (Number(durM[1]) * 3600 +
                            Number(durM[2]) * 60 +
                            Number(durM[3])) *
                          1_000_000
                        : 0;
                      resolveProbe({
                        codec: codecM?.[1]?.toLowerCase() ?? "unknown",
                        durationUs,
                      });
                    });
                    probe.on("error", () =>
                      resolveProbe({ codec: "unknown", durationUs: 0 }),
                    );
                  },
                );
              // Probe every chunk: the concat demuxer prints Duration: N/A
              // so we can't rely on ffmpeg's own duration line during the
              // re-encode. Summing per-chunk durations gives an accurate
              // denominator for progress. Chunks are fast to probe
              // (metadata only).
              const chunkProbes = await Promise.all(
                Array.from({ length: workers }, (_, ci) =>
                  probeChunk(
                    path.join(chunksDir, renderId, `chunk-${ci}.mp4`),
                  ),
                ),
              );
              const chunkCodec = chunkProbes[0]?.codec ?? "unknown";
              const totalDurationUs = chunkProbes.reduce(
                (acc, p) => acc + p.durationUs,
                0,
              );

              // AV1 chunks from WebCodecs sit around 1.2 Mbps for 1080p60.
              // libsvtav1 at CRF 38 / preset 6 hits similar quality at
              // ~0.5 Mbps — roughly a 60% file-size drop — so for AV1 we
              // transcode the concat instead of stream-copying. Other
              // codecs stream-copy as before (no quality loss, negligible
              // time cost).
              const ffArgs =
                chunkCodec === "av1"
                  ? [
                      "-y",
                      "-f",
                      "concat",
                      "-safe",
                      "0",
                      "-i",
                      concatList,
                      "-c:v",
                      "libsvtav1",
                      "-crf",
                      "38",
                      "-preset",
                      "6",
                      "-pix_fmt",
                      "yuv420p",
                      "-an",
                      "-movflags",
                      "+faststart",
                      outputPath,
                    ]
                  : [
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
                    ];
              const isReencode = chunkCodec === "av1";
              if (isReencode) {
                emit({ type: "stage", stage: "compressing" });
              }
              // -progress pipe:1 emits key=value lines on stdout at ~0.5s
              // intervals. out_time_us is input-time progress in µs; we
              // divide by the total input duration (parsed once from
              // stderr) to compute a 0..1 ratio. Only wire this up for
              // the re-encode path — stream-copy is fast enough that
              // progress feedback would be noise.
              const progressArgs = isReencode
                ? [...ffArgs.slice(0, -1), "-progress", "pipe:1", ffArgs[ffArgs.length - 1]!]
                : ffArgs;
              await new Promise<void>((resolve, reject) => {
                const ff = spawn(ffmpegPath, progressArgs, {
                  stdio: ["ignore", isReencode ? "pipe" : "ignore", "pipe"],
                });
                // Register with the render state so abort / browser-close
                // teardown can kill this process. Otherwise the encode
                // keeps running — potentially pinning the CPU — after the
                // user closes the app.
                activeFfmpeg = ff;
                activeFfmpegs.add(ff);
                ff.on("close", () => activeFfmpegs.delete(ff));
                let stderr = "";
                ff.stderr.on("data", (chunk) => {
                  stderr += chunk.toString();
                });
                if (isReencode && ff.stdout) {
                  let stdoutBuf = "";
                  ff.stdout.on("data", (chunk) => {
                    stdoutBuf += chunk.toString();
                    let nl: number;
                    while ((nl = stdoutBuf.indexOf("\n")) >= 0) {
                      const line = stdoutBuf.slice(0, nl).trim();
                      stdoutBuf = stdoutBuf.slice(nl + 1);
                      const m = /^out_time_us=(\d+)/.exec(line);
                      if (m && totalDurationUs > 0) {
                        const p = Math.min(
                          1,
                          Number(m[1]) / totalDurationUs,
                        );
                        emit({ type: "compress-progress", progress: p });
                      }
                    }
                  });
                }
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
                outputPath,
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

        server.middlewares.use("/api/capture-page", (req, res) => {
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

            let browser: Awaited<
              ReturnType<typeof import("playwright").chromium.launch>
            > | null = null;
            let captureFfmpeg: ReturnType<typeof spawn> | null = null;
            let aborted = false;
            const frameDir = path.join(
              os.tmpdir(),
              `dabinky-capture-${Date.now()}`,
            );

            res.on("close", () => {
              if (res.writableFinished) return;
              aborted = true;
              void browser?.close().catch(() => {});
              if (captureFfmpeg && captureFfmpeg.exitCode === null) {
                try {
                  captureFfmpeg.kill("SIGKILL");
                } catch {
                  /* ignore */
                }
              }
            });

            try {
              const parsed = body ? JSON.parse(body) : {};
              const sourceUrl = String(
                parsed.sourceUrl || "http://localhost:3001/?capture=true",
              );
              const captureFps = Math.max(1, Number(parsed.fps ?? 60));
              const duration = Math.max(0.1, Number(parsed.duration ?? 12));
              const width = Math.max(1, Number(parsed.width ?? 1920));
              const height = Math.max(1, Number(parsed.height ?? 1080));
              const defaultName = (() => {
                const d = new Date();
                const pad = (n: number) => String(n).padStart(2, "0");
                return `capture-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.mp4`;
              })();
              const outputName = String(parsed.output || defaultName).replace(
                /^media\//,
                "",
              );
              ensureMediaDir();
              const outputAbs = path.join(mediaDir, path.basename(outputName));

              const totalFrames = Math.ceil(captureFps * duration);
              const frameMs = 1000 / captureFps;

              fs.mkdirSync(frameDir, { recursive: true });

              emit({ type: "stage", stage: "launching-browser" });

              const playwright = await import("playwright");
              browser = await playwright.chromium.launch({ headless: false });
              const context = await browser.newContext({
                viewport: { width, height },
                deviceScaleFactor: 1,
              });
              const page = await context.newPage();

              const virtualTimeScript = `
(() => {
    let virtualNow = 0;
    const FRAME_MS = ${frameMs};
    performance.now = () => virtualNow;
    Date.now = () => virtualNow;
    const rafQueue = [];
    let rafId = 0;
    window.requestAnimationFrame = (cb) => { const id = ++rafId; rafQueue.push({ id, cb }); return id; };
    window.cancelAnimationFrame = (id) => { const idx = rafQueue.findIndex(r => r.id === id); if (idx !== -1) rafQueue.splice(idx, 1); };
    const timers = [];
    let timerId = 1000;
    window.setTimeout = (cb, ms = 0, ...args) => { const id = ++timerId; timers.push({ id, cb, args, fireAt: virtualNow + ms, interval: false }); return id; };
    window.setInterval = (cb, ms = 0, ...args) => { const id = ++timerId; timers.push({ id, cb, args, fireAt: virtualNow + ms, interval: true, ms }); return id; };
    window.clearTimeout = (id) => { const idx = timers.findIndex(t => t.id === id); if (idx !== -1) timers.splice(idx, 1); };
    window.clearInterval = window.clearTimeout;
    window.__stepTime = () => {
        virtualNow += FRAME_MS;
        const due = timers.filter(t => t.fireAt <= virtualNow);
        for (const t of due) { t.cb(...t.args); if (t.interval) { t.fireAt += t.ms; } else { const idx = timers.indexOf(t); if (idx !== -1) timers.splice(idx, 1); } }
        const batch = rafQueue.splice(0);
        for (const { cb } of batch) { try { cb(virtualNow); } catch {} }
    };
    window.__virtualNow = () => virtualNow;
})();`;

              await page.addInitScript(virtualTimeScript);
              emit({ type: "stage", stage: "loading-page" });
              await page.goto(sourceUrl, { waitUntil: "networkidle" });

              const cdp = await context.newCDPSession(page);
              await cdp.send("Input.setIgnoreInputEvents", { ignore: true });

              for (let i = 0; i < 10; i++) {
                await page.evaluate(() =>
                  (window as unknown as { __stepTime: () => void }).__stepTime(),
                );
              }
              if (aborted) return;

              emit({
                type: "stage",
                stage: "capturing",
                totalFrames,
                fps: captureFps,
                width,
                height,
              });

              for (let i = 0; i < totalFrames; i++) {
                if (aborted) return;
                await page.evaluate(() =>
                  (window as unknown as { __stepTime: () => void }).__stepTime(),
                );
                await page.evaluate(() =>
                  (
                    window as unknown as {
                      __capture?: { stepFrame: () => void };
                    }
                  ).__capture?.stepFrame(),
                );
                const padded = String(i).padStart(5, "0");
                await page.screenshot({
                  path: path.join(frameDir, `frame_${padded}.png`),
                });
                if (i % 30 === 0) {
                  emit({
                    type: "progress",
                    frame: i,
                    totalFrames,
                    progress: i / totalFrames,
                  });
                }
              }

              await browser.close();
              browser = null;
              if (aborted) return;

              emit({ type: "stage", stage: "encoding" });
              await new Promise<void>((resolve, reject) => {
                captureFfmpeg = spawn(
                  ffmpegPath,
                  [
                    "-y",
                    "-framerate",
                    String(captureFps),
                    "-i",
                    path.join(frameDir, "frame_%05d.png"),
                    "-c:v",
                    "libx264",
                    "-crf",
                    "18",
                    "-preset",
                    "medium",
                    "-pix_fmt",
                    "yuv420p",
                    "-movflags",
                    "+faststart",
                    outputAbs,
                  ],
                  { stdio: ["ignore", "ignore", "pipe"] },
                );
                activeFfmpegs.add(captureFfmpeg);
                captureFfmpeg.on("close", (code) => {
                  activeFfmpegs.delete(captureFfmpeg!);
                  captureFfmpeg = null;
                  if (code === 0) resolve();
                  else
                    reject(
                      new Error(`ffmpeg capture encode exited with ${code}`),
                    );
                });
                captureFfmpeg.on("error", (err) => {
                  activeFfmpegs.delete(captureFfmpeg!);
                  captureFfmpeg = null;
                  reject(err);
                });
              });

              const stat = fs.statSync(outputAbs);
              emit({
                type: "done",
                output: `media/${path.basename(outputAbs)}`,
                size: stat.size,
                totalFrames,
              });
            } catch (err) {
              if (!aborted) {
                emit({ type: "error", message: (err as Error).message });
              }
            } finally {
              if (browser) await browser.close().catch(() => {});
              if (fs.existsSync(frameDir)) {
                fs.rmSync(frameDir, { recursive: true, force: true });
              }
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
              const abs = path.isAbsolute(relPath)
                ? relPath
                : path.resolve(dataRoot, relPath);
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
}
