// Loaded inside a headless Chromium page spawned by /api/parallel-render.
// URL params: chunk, total, renderId, codec, bitrate.
// The page:
//   1. fetches the current composition.json
//   2. computes its chunk's frame range
//   3. calls renderMediaOnWeb for that range
//   4. POSTs the resulting blob to /api/save-chunk so the orchestrator sees it
import { MyComposition } from "@src/Composition";
import type { MyCompositionProps } from "@src/Composition";

const FPS = 60;
const WIDTH = 1920;
const HEIGHT = 1080;

type CodecChoice = "av1" | "h265" | "h264";
type BitratePreset = "very-low" | "low" | "medium" | "high" | "very-high";

const CODEC_PROBES: Array<{ codec: CodecChoice; mime: string }> = [
  { codec: "av1", mime: "av01.0.08M.08" },
  { codec: "h265", mime: "hev1.1.6.L120.90" },
  { codec: "h264", mime: "avc1.640028" },
];

type ResolvedCodec = {
  codec: CodecChoice;
  hardwareAcceleration: "prefer-hardware" | "no-preference";
};

// Probe locally — the parent window's pick doesn't apply because workers
// may run in a different engine/mode (headless Chromium has no GPU, Safari
// has AV1, etc). Prefer hardware-accelerated encoding; fall back to
// software if no codec supports hardware in this environment.
const pickLocalCodec = async (): Promise<ResolvedCodec> => {
  const VE = (globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
  if (!VE) return { codec: "h264", hardwareAcceleration: "no-preference" };
  for (const hwAccel of ["prefer-hardware", "no-preference"] as const) {
    for (const { codec, mime } of CODEC_PROBES) {
      try {
        const res = await VE.isConfigSupported({
          codec: mime,
          width: WIDTH,
          height: HEIGHT,
          framerate: FPS,
          bitrate: 2_000_000,
          hardwareAcceleration: hwAccel,
        });
        if (res.supported) return { codec, hardwareAcceleration: hwAccel };
      } catch {
        // try next combination
      }
    }
  }
  return { codec: "h264", hardwareAcceleration: "no-preference" };
};

const setStatus = (msg: string) => {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
};

const computeTotalFrames = (data: MyCompositionProps): number => {
  const clipEnds = data.videoTracks.flatMap((t) =>
    t.clips.map((c) => c.from + (c.endAt - c.startFrom)),
  );
  const segEnds = data.textTracks.flatMap((t) =>
    t.segments.map((s) => s.from + s.duration),
  );
  const all = [...clipEnds, ...segEnds];
  const duration = all.length ? Math.max(...all, 1) : 1;
  return Math.max(1, Math.ceil(duration * FPS));
};

const main = async () => {
  const params = new URLSearchParams(location.search);
  const chunkIndex = Number(params.get("chunk") ?? "0");
  const totalChunks = Number(params.get("total") ?? "1");
  const renderId = params.get("renderId") ?? "";
  const requestedCodec = (params.get("codec") ?? "auto") as
    | CodecChoice
    | "auto";
  const bitrate = (params.get("bitrate") ?? "medium") as BitratePreset;

  if (!renderId) throw new Error("missing renderId");

  // Probe is the source of truth for both codec and hardware availability.
  // If the parent passed an explicit codec but this worker's browser
  // doesn't support it at all, we still fall back through the probe.
  const probed = await pickLocalCodec();
  const codec: CodecChoice =
    requestedCodec === "auto" ? probed.codec : requestedCodec;
  const hardwareAcceleration = probed.hardwareAcceleration;

  setStatus(`Chunk ${chunkIndex + 1}/${totalChunks} — loading composition…`);
  const inputProps = (await fetch("/api/composition").then((r) =>
    r.json(),
  )) as MyCompositionProps;
  const totalFrames = computeTotalFrames(inputProps);

  // Evenly split frames across chunks. Each chunk is a standalone render
  // that starts on its own keyframe, so no boundary-frame deduplication is
  // needed (unlike revideo's per-frame model).
  const framesPerChunk = Math.ceil(totalFrames / totalChunks);
  const firstFrame = chunkIndex * framesPerChunk;
  const lastFrame = Math.min(firstFrame + framesPerChunk - 1, totalFrames - 1);
  const chunkFrameCount = lastFrame - firstFrame + 1;

  setStatus(
    `Chunk ${chunkIndex + 1}/${totalChunks} — rendering frames ${firstFrame}–${lastFrame}`,
  );

  const { renderMediaOnWeb } = await import("@remotion/web-renderer");
  const result = await renderMediaOnWeb({
    composition: {
      id: "MyComp",
      component: MyComposition,
      durationInFrames: totalFrames,
      fps: FPS,
      width: WIDTH,
      height: HEIGHT,
    },
    inputProps,
    container: "mp4",
    videoCodec: codec,
    videoBitrate: bitrate,
    muted: true,
    hardwareAcceleration,
    outputTarget: "arraybuffer",
    frameRange: [firstFrame, lastFrame],
    onProgress: (p) => {
      setStatus(
        `Chunk ${chunkIndex + 1}/${totalChunks} — ${p.renderedFrames}/${chunkFrameCount} frames (${Math.round(p.progress * 100)}%)`,
      );
      // Fire-and-forget progress ping so the orchestrator can report per-chunk
      // progress in the editor UI. Failure doesn't affect the render.
      void fetch(
        `/api/chunk-progress?renderId=${encodeURIComponent(renderId)}&chunk=${chunkIndex}&progress=${p.progress}`,
        { method: "POST" },
      ).catch(() => {
        /* ignore */
      });
    },
  });

  const blob = await result.getBlob();
  setStatus(`Chunk ${chunkIndex + 1}/${totalChunks} — uploading ${Math.round(blob.size / 1024)} KB`);

  const saveRes = await fetch(
    `/api/save-chunk?renderId=${encodeURIComponent(renderId)}&chunk=${chunkIndex}`,
    {
      method: "POST",
      headers: { "content-type": "video/mp4" },
      body: blob,
    },
  );
  if (!saveRes.ok) {
    throw new Error(`save-chunk failed: ${saveRes.status}`);
  }
  setStatus(`Chunk ${chunkIndex + 1}/${totalChunks} — done`);
};

main().catch((err) => {
  const msg = (err as Error).message ?? String(err);
  setStatus("Error: " + msg);
  const params = new URLSearchParams(location.search);
  void fetch(
    `/api/chunk-error?renderId=${encodeURIComponent(params.get("renderId") ?? "")}&chunk=${params.get("chunk") ?? ""}`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: msg }),
    },
  ).catch(() => {
    /* ignore */
  });
});
