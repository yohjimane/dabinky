import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawn } from "node:child_process";
import {
  Zip,
  ZipDeflate,
  ZipPassThrough,
  Unzip,
  UnzipInflate,
  type UnzipFile,
} from "fflate";
import { z } from "zod";

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
