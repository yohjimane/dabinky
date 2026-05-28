import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Player, PlayerRef } from "@remotion/player";
import {
  MyComposition,
  MyCompositionProps,
  Clip,
  TextSegment,
} from "@src/Composition";
import { ScreenDemo } from "@src/ScreenDemo";
import type { ScreenDemoProps } from "@src/ScreenDemo";
import { useHistory } from "./useHistory";
import { Timeline, Selection } from "./Timeline";
import { MediaPool, ASSET_MIME, AssetDragPayload } from "./MediaPool";
import { UpdateNotification } from "./UpdateNotification";

const FPS = 60;
const WIDTH = 1920;
const HEIGHT = 1080;
const OVERSCAN = 1.5;
const OVERSCAN_W = Math.round(WIDTH * OVERSCAN);
const OVERSCAN_H = Math.round(HEIGHT * OVERSCAN);

const makeOverscanWrapper = <P extends object>(
  Inner: React.ComponentType<P>,
): React.FC<P> => {
  const Wrapped: React.FC<P> = (props) => {
    const padX = (OVERSCAN_W - WIDTH) / 2;
    const padY = (OVERSCAN_H - HEIGHT) / 2;
    return (
      <div style={{ position: "absolute", inset: 0, background: "#080808" }}>
        <div
          style={{
            position: "absolute",
            left: padX,
            top: padY,
            width: WIDTH,
            height: HEIGHT,
            overflow: "visible",
          }}
        >
          <div style={{ position: "relative", width: WIDTH, height: HEIGHT }}>
            <Inner {...props} />
          </div>
        </div>
        <div style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
          <div
            style={{
              position: "absolute",
              top: 0,
              left: 0,
              right: 0,
              height: padY,
              background: "rgba(0,0,0,0.55)",
            }}
          />
          <div
            style={{
              position: "absolute",
              bottom: 0,
              left: 0,
              right: 0,
              height: padY,
              background: "rgba(0,0,0,0.55)",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: padY,
              left: 0,
              width: padX,
              height: HEIGHT,
              background: "rgba(0,0,0,0.55)",
            }}
          />
          <div
            style={{
              position: "absolute",
              top: padY,
              right: 0,
              width: padX,
              height: HEIGHT,
              background: "rgba(0,0,0,0.55)",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: padX - 1,
              top: padY - 1,
              width: WIDTH + 2,
              height: HEIGHT + 2,
              border: "1px solid rgba(255,255,255,0.15)",
            }}
          />
          {[1, 2].map((i) => (
            <React.Fragment key={`third-${i}`}>
              <div
                style={{
                  position: "absolute",
                  left: padX + (WIDTH * i) / 3,
                  top: 0,
                  width: 1,
                  height: OVERSCAN_H,
                  background: "rgba(255,255,255,0.08)",
                }}
              />
              <div
                style={{
                  position: "absolute",
                  left: 0,
                  top: padY + (HEIGHT * i) / 3,
                  width: OVERSCAN_W,
                  height: 1,
                  background: "rgba(255,255,255,0.08)",
                }}
              />
            </React.Fragment>
          ))}
        </div>
      </div>
    );
  };
  Wrapped.displayName = `Overscan(${Inner.displayName || Inner.name})`;
  return Wrapped;
};

const OverscanScreenDemo = makeOverscanWrapper(ScreenDemo);
const OverscanMyComposition = makeOverscanWrapper(MyComposition);

const getCursorAtFrame = (
  frame: number,
  events: MouseEventDef[],
): { x: number; y: number; clicking: boolean } | null => {
  if (events.length === 0) return null;
  const sorted = [...events].sort((a, b) => a.frame - b.frame);
  if (frame < sorted[0].frame) return null;

  const exact = sorted.find((e) => e.frame === frame);
  if (exact) return { x: exact.x, y: exact.y, clicking: exact.type === "click" };

  const beforeArr = sorted.filter((e) => e.frame <= frame);
  const before = beforeArr[beforeArr.length - 1];
  const after = sorted.find((e) => e.frame > frame);
  if (before && after) {
    const t = (frame - before.frame) / (after.frame - before.frame);
    const ease = t * t * (3 - 2 * t);
    return {
      x: before.x + (after.x - before.x) * ease,
      y: before.y + (after.y - before.y) * ease,
      clicking: false,
    };
  }
  if (before) return { x: before.x, y: before.y, clicking: false };
  return null;
};

const CURSOR_SVG = (
  <svg
    width="20"
    height="20"
    viewBox="0 0 24 24"
    fill="none"
    style={{ filter: "drop-shadow(0 1px 2px rgba(0,0,0,0.6))" }}
  >
    <path
      d="M5.5 3.2l12.8 7.3-5.3 1.7-3.7 5.5z"
      fill="#fff"
      stroke="#111"
      strokeWidth="1.2"
      strokeLinejoin="round"
    />
  </svg>
);

type DragTarget =
  | { kind: "seek" }
  | { kind: "keyframe"; index: number }
  | { kind: "mouse"; index: number };

const ScreenDemoTimeline: React.FC<{
  currentFrame: number;
  totalFrames: number;
  fps: number;
  keyframes: { frame: number }[];
  mouseEvents: MouseEventDef[];
  onSeek: (frame: number) => void;
  onKeyframeFrame: (index: number, frame: number) => void;
  onMouseEventFrame: (index: number, frame: number) => void;
}> = ({
  currentFrame,
  totalFrames,
  fps,
  keyframes,
  mouseEvents,
  onSeek,
  onKeyframeFrame,
  onMouseEventFrame,
}) => {
  const barRef = React.useRef<HTMLDivElement>(null);
  const [drag, setDrag] = useState<DragTarget | null>(null);

  const pct = (frame: number) =>
    totalFrames > 0 ? `${(frame / totalFrames) * 100}%` : "0%";

  const frameFromPointer = (e: React.PointerEvent) => {
    const bar = barRef.current;
    if (!bar) return 0;
    const rect = bar.getBoundingClientRect();
    const t = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    return Math.round(t * (totalFrames - 1));
  };

  const onBarPointerDown = (e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag({ kind: "seek" });
    onSeek(frameFromPointer(e));
  };

  const onMarkerPointerDown = (
    e: React.PointerEvent,
    target: DragTarget,
  ) => {
    e.stopPropagation();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setDrag(target);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const f = frameFromPointer(e);
    if (drag.kind === "seek") {
      onSeek(f);
    } else if (drag.kind === "keyframe") {
      onKeyframeFrame(drag.index, f);
    } else if (drag.kind === "mouse") {
      onMouseEventFrame(drag.index, f);
    }
  };

  const onPointerUp = () => setDrag(null);

  const totalSec = totalFrames / fps;
  const stepSec = totalSec <= 10 ? 1 : totalSec <= 30 ? 2 : 5;
  const ticks: number[] = [];
  for (let s = 0; s <= totalSec; s += stepSec) ticks.push(s);

  const laneStyle: React.CSSProperties = {
    position: "relative",
    height: 20,
  };
  const lineStyle: React.CSSProperties = {
    position: "absolute",
    top: "50%",
    left: 0,
    right: 0,
    height: 1,
    background: "#1e1e24",
  };
  const labelStyle: React.CSSProperties = {
    position: "absolute",
    left: -54,
    width: 48,
    textAlign: "right",
    top: "50%",
    transform: "translateY(-50%)",
    fontSize: 9,
    color: "#5a5a64",
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };
  const markerGrab: React.CSSProperties = {
    cursor: "grab",
    zIndex: 1,
  };

  return (
    <div
      style={{
        gridColumn: 2,
        gridRow: 3,
        height: 86,
        background: "#0a0a0e",
        borderTop: "1px solid #1e1e24",
        padding: "8px 16px 6px 70px",
        display: "flex",
        flexDirection: "column",
        userSelect: "none",
      }}
    >
      <div
        ref={barRef}
        style={{
          flex: 1,
          position: "relative",
          cursor: drag ? "grabbing" : "crosshair",
        }}
        onPointerDown={onBarPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* Camera lane */}
        <div style={laneStyle}>
          <div style={lineStyle} />
          <span style={labelStyle}>Camera</span>
          {keyframes.map((kf, i) => (
            <div
              key={i}
              title={`Keyframe #${i + 1} — frame ${kf.frame}`}
              onPointerDown={(e) =>
                onMarkerPointerDown(e, { kind: "keyframe", index: i })
              }
              style={{
                ...markerGrab,
                position: "absolute",
                left: pct(kf.frame),
                top: "50%",
                transform: "translate(-50%,-50%)",
                width: 10,
                height: 10,
                borderRadius: 2,
                background:
                  drag?.kind === "keyframe" && drag.index === i
                    ? "#6b8fd4"
                    : "#4a6aa8",
                border: "1px solid #6b8fd4",
              }}
            />
          ))}
        </div>

        {/* Mouse lane */}
        <div style={{ ...laneStyle, marginTop: 2 }}>
          <div style={lineStyle} />
          <span style={labelStyle}>Mouse</span>
          {mouseEvents.map((ev, i) => {
            const isClick = ev.type === "click";
            const active = drag?.kind === "mouse" && drag.index === i;
            return (
              <div
                key={i}
                title={`${ev.type} (${ev.x}, ${ev.y}) — frame ${ev.frame}`}
                onPointerDown={(e) =>
                  onMarkerPointerDown(e, { kind: "mouse", index: i })
                }
                style={{
                  ...markerGrab,
                  position: "absolute",
                  left: pct(ev.frame),
                  top: "50%",
                  transform: "translate(-50%,-50%)",
                  width: isClick ? 12 : 9,
                  height: isClick ? 12 : 9,
                  borderRadius: "50%",
                  background: active
                    ? isClick
                      ? "#fbbf24"
                      : "#fff"
                    : isClick
                      ? "#f59e0b"
                      : "#e8e8ea",
                  border: isClick ? "1.5px solid #d97706" : "1px solid #aaa",
                }}
              />
            );
          })}
        </div>

        {/* Playhead */}
        <div
          style={{
            position: "absolute",
            left: pct(currentFrame),
            top: 0,
            bottom: 0,
            width: 1.5,
            background: "#e8e8ea",
            transform: "translateX(-0.75px)",
            pointerEvents: "none",
            zIndex: 2,
          }}
        >
          <div
            style={{
              position: "absolute",
              top: -3,
              left: -3,
              width: 7,
              height: 7,
              borderRadius: "50%",
              background: "#fff",
            }}
          />
        </div>
      </div>

      {/* Time ticks */}
      <div style={{ position: "relative", height: 14, marginTop: 2 }}>
        {ticks.map((s) => (
          <span
            key={s}
            style={{
              position: "absolute",
              left: pct(Math.round(s * fps)),
              transform: "translateX(-50%)",
              fontSize: 9,
              color: "#5a5a64",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            {s}s
          </span>
        ))}
      </div>
    </div>
  );
};

const computeDuration = (data: MyCompositionProps): number => {
  const clipEnds = data.videoTracks.flatMap((t) =>
    t.clips.map((c) => c.from + (c.endAt - c.startFrom)),
  );
  const segEnds = data.textTracks.flatMap((t) =>
    t.segments.map((s) => s.from + s.duration),
  );
  const all = [...clipEnds, ...segEnds];
  return all.length ? Math.max(...all, 1) : 1;
};

const secs = (n: number) => Math.round(n * 1000) / 1000;

const newTrackId = (prefix: string) =>
  `${prefix}${Date.now().toString(36).slice(-5)}`;

type MouseEventDef = {
  frame: number;
  type: "move" | "click";
  x: number;
  y: number;
};

type EditorMode = "timeline" | "screen-demo";

const defaultCaptureName = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `capture-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.mp4`;
};

export const Editor: React.FC = () => {
  const [mode, setMode] = useState<EditorMode>("timeline");
  const [loaded, setLoaded] = useState<MyCompositionProps | null>(null);
  const [initStatus, setInitStatus] = useState("Loading composition…");
  const [globalAssetKey, setGlobalAssetKey] = useState(0);

  useEffect(() => {
    (async () => {
      const compositionRes = await fetch("/api/composition");
      const data = (await compositionRes.json()) as MyCompositionProps;

      const sources = data.videoTracks.flatMap((t) =>
        t.clips.map((c) => c.src),
      );
      if (sources.length > 0) {
        setInitStatus("Checking media compatibility…");
        try {
          const res = await fetch("/api/ensure-h264", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sources }),
          });
          const json = await res.json();
          if (json.ok && json.transcoded) {
            const map = json.transcoded as Record<string, string>;
            if (Object.keys(map).length > 0) {
              for (const track of data.videoTracks) {
                for (const clip of track.clips) {
                  if (map[clip.src]) clip.src = map[clip.src];
                }
              }
              await fetch("/api/composition", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(data),
              });
            }
          }
        } catch {
          // Non-fatal — rendering may be slow but won't crash
        }
      }

      setLoaded(data);
    })();
  }, []);

  const tabStyle = (active: boolean): React.CSSProperties => ({
    background: active ? "#2a2a34" : "transparent",
    color: active ? "#fff" : "#70707a",
    border: "none",
    padding: "6px 14px",
    borderRadius: 6,
    cursor: "pointer",
    fontWeight: active ? 600 : 400,
    fontSize: 13,
  });

  if (!loaded && mode === "timeline") {
    return <div style={{ padding: 40 }}>{initStatus}</div>;
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <UpdateNotification />
      <div
        style={{
          display: "flex",
          gap: 4,
          padding: "6px 12px",
          background: "#0c0c10",
          borderBottom: "1px solid #1e1e24",
        }}
      >
        <button
          style={tabStyle(mode === "timeline")}
          onClick={() => setMode("timeline")}
        >
          Timeline
        </button>
        <button
          style={tabStyle(mode === "screen-demo")}
          onClick={() => setMode("screen-demo")}
        >
          Screen Demo
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {mode === "timeline" && loaded && (
          <EditorInner
            initial={loaded}
            externalReloadKey={globalAssetKey}
          />
        )}
        {mode === "screen-demo" && (
          <ScreenDemoEditor
            onCaptureComplete={() => setGlobalAssetKey((k) => k + 1)}
          />
        )}
      </div>
    </div>
  );
};

const DEFAULT_SCREEN_DEMO_PROPS: ScreenDemoProps = {
  src: "",
  sourceUrl: "http://localhost:3001/?capture=true",
  background: "linear-gradient(135deg, #0f172a 0%, #1e293b 100%)",
  screenRadius: 12,
  screenShadow: "0 40px 80px rgba(0,0,0,0.5)",
  keyframes: [
    { frame: 0, scale: 0.75, x: 0, y: 0, rotateY: 2, rotateX: 0 },
    { frame: 90, scale: 0.75, x: 0, y: 0, rotateY: 0, rotateX: 0 },
    { frame: 180, scale: 1.4, x: -200, y: -80, rotateY: 0, rotateX: 0 },
    { frame: 360, scale: 1.4, x: -200, y: -80, rotateY: 0, rotateX: 0 },
    { frame: 420, scale: 1.2, x: 250, y: -60, rotateY: 0, rotateX: 0 },
    { frame: 600, scale: 1.2, x: 250, y: -60, rotateY: 0, rotateX: 0 },
    { frame: 660, scale: 0.75, x: 0, y: 0, rotateY: -2, rotateX: 1 },
  ],
};

type CaptureState =
  | { kind: "idle" }
  | { kind: "capturing"; stage: string; progress: number }
  | { kind: "done"; output: string; size: number }
  | { kind: "error"; message: string };

type CaptureAsset = { name: string; size: number; mtime: number };

const CaptureList: React.FC<{
  selected: string;
  onSelect: (src: string) => void;
  onDelete: (name: string) => void;
  refreshKey: number;
}> = ({ selected, onSelect, onDelete, refreshKey }) => {
  const [assets, setAssets] = useState<CaptureAsset[]>([]);

  useEffect(() => {
    fetch("/api/assets")
      .then((r) => r.json())
      .then((json) => {
        const captures = ((json.assets ?? []) as CaptureAsset[])
          .filter((a) => a.name.startsWith("media/capture-"))
          .sort((a, b) => b.mtime - a.mtime);
        setAssets(captures);
      })
      .catch(() => {});
  }, [refreshKey]);

  const deleteCapture = (name: string) => {
    fetch("/api/delete-asset", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    })
      .then((r) => r.json())
      .then((json) => {
        if (json.ok) {
          setAssets((prev) => prev.filter((a) => a.name !== name));
          onDelete(name);
        }
      })
      .catch(() => {});
  };

  const [hoveredName, setHoveredName] = useState<string | null>(null);

  if (assets.length === 0) {
    return (
      <div
        style={{
          color: "#555",
          fontSize: 12,
          textAlign: "center",
          padding: 20,
        }}
      >
        No captures yet.
      </div>
    );
  }

  return (
    <>
      {assets.map((a) => {
        const active = a.name === selected;
        return (
          <div
            key={a.name}
            onClick={() => onSelect(a.name)}
            onMouseEnter={() => setHoveredName(a.name)}
            onMouseLeave={() => setHoveredName(null)}
            style={{
              position: "relative",
              background: active ? "#1e2a3a" : "#1a1a20",
              border: `1px solid ${active ? "#3b6aa8" : "#26262e"}`,
              borderRadius: 8,
              padding: 8,
              marginBottom: 8,
              cursor: "pointer",
            }}
          >
            {hoveredName === a.name && (
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  deleteCapture(a.name);
                }}
                style={{
                  position: "absolute",
                  top: 4,
                  right: 4,
                  zIndex: 5,
                  width: 20,
                  height: 20,
                  borderRadius: 4,
                  background: "#c53030",
                  color: "#fff",
                  border: "none",
                  cursor: "pointer",
                  fontSize: 13,
                  fontWeight: 700,
                  lineHeight: "20px",
                  textAlign: "center",
                  padding: 0,
                }}
                title="Delete capture"
              >
                ×
              </button>
            )}
            <div
              style={{
                position: "relative",
                width: "100%",
                aspectRatio: "16 / 9",
                background: "#000",
                borderRadius: 5,
                overflow: "hidden",
                marginBottom: 6,
              }}
            >
              <video
                src={`/${a.name}`}
                muted
                preload="metadata"
                onLoadedMetadata={(e) => {
                  try {
                    e.currentTarget.currentTime = Math.min(
                      0.1,
                      e.currentTarget.duration / 2,
                    );
                  } catch {}
                }}
                style={{
                  width: "100%",
                  height: "100%",
                  objectFit: "cover",
                  pointerEvents: "none",
                }}
              />
            </div>
            <div
              style={{
                fontSize: 11,
                color: "#e8e8ea",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
              title={a.name}
            >
              {a.name.split("/").pop()}
            </div>
            <div style={{ fontSize: 10, color: "#5a5a64", marginTop: 2 }}>
              {(a.size / 1024 / 1024).toFixed(1)} MB
            </div>
          </div>
        );
      })}
    </>
  );
};

const ScreenDemoEditor: React.FC<{
  onCaptureComplete: () => void;
}> = ({ onCaptureComplete }) => {
  type ScreenDemoState = { props: ScreenDemoProps; mouseEvents: MouseEventDef[] };
  const {
    state: { props, mouseEvents },
    set: setState,
    undo,
    redo,
    canUndo,
    canRedo,
  } = useHistory<ScreenDemoState>({
    props: DEFAULT_SCREEN_DEMO_PROPS,
    mouseEvents: [],
  });
  const setProps = useCallback(
    (fn: (p: ScreenDemoProps) => ScreenDemoProps, coalesce?: string) =>
      setState((s) => ({ ...s, props: fn(s.props) }), { coalesce }),
    [setState],
  );
  const setMouseEvents = useCallback(
    (fn: (m: MouseEventDef[]) => MouseEventDef[], coalesce?: string) =>
      setState((s) => ({ ...s, mouseEvents: fn(s.mouseEvents) }), { coalesce }),
    [setState],
  );
  const [durationSec, setDurationSec] = useState(12);
  const [captureName, setCaptureName] = useState(defaultCaptureName());
  const [captureState, setCaptureState] = useState<CaptureState>({
    kind: "idle",
  });
  const [captureRefreshKey, setCaptureRefreshKey] = useState(0);
  const [exportState, setExportState] = useState<CaptureState>({ kind: "idle" });
  const [overscan, setOverscan] = useState(false);
  const [showCursor, setShowCursor] = useState(true);
  const [currentFrame, setCurrentFrame] = useState(0);
  const playerRef = React.useRef<PlayerRef>(null);

  const durationInFrames = Math.max(1, Math.ceil(durationSec * FPS));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === " " && !e.metaKey && !e.ctrlKey) {
        const tag = (e.target as HTMLElement).tagName;
        if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
        e.preventDefault();
        playerRef.current?.toggle();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    const onFrame = () => setCurrentFrame(player.getCurrentFrame());
    player.addEventListener("frameupdate", onFrame as never);
    return () => player.removeEventListener("frameupdate", onFrame as never);
  }, []);

  const cursorAtFrame = useMemo(
    () => getCursorAtFrame(currentFrame, mouseEvents),
    [currentFrame, mouseEvents],
  );

  const updateKeyframe = (
    idx: number,
    patch: Partial<ScreenDemoProps["keyframes"][number]>,
    coalesceKey?: string,
  ) => {
    setProps(
      (prev) => ({
        ...prev,
        keyframes: prev.keyframes.map((kf, i) =>
          i === idx ? { ...kf, ...patch } : kf,
        ),
      }),
      coalesceKey,
    );
  };

  const addKeyframe = () => {
    const last = props.keyframes[props.keyframes.length - 1];
    setProps((prev) => ({
      ...prev,
      keyframes: [
        ...prev.keyframes,
        {
          frame: (last?.frame ?? 0) + 60,
          scale: last?.scale ?? 1,
          x: last?.x ?? 0,
          y: last?.y ?? 0,
          rotateY: last?.rotateY ?? 0,
          rotateX: last?.rotateX ?? 0,
        },
      ],
    }));
  };

  const removeKeyframe = (idx: number) => {
    if (props.keyframes.length <= 1) return;
    setProps((prev) => ({
      ...prev,
      keyframes: prev.keyframes.filter((_, i) => i !== idx),
    }));
  };

  const startCapture = async () => {
    setCaptureState({ kind: "capturing", stage: "starting", progress: 0 });
    try {
      const res = await fetch("/api/capture-page", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sourceUrl: props.sourceUrl,
          fps: FPS,
          duration: durationSec,
          width: WIDTH,
          height: HEIGHT,
          output: captureName,
          mouseEvents: showCursor ? mouseEvents : [],
        }),
      });
      if (!res.body) throw new Error("no response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === "stage") {
              setCaptureState({
                kind: "capturing",
                stage: ev.stage,
                progress: 0,
              });
            } else if (ev.type === "progress") {
              setCaptureState({
                kind: "capturing",
                stage: "capturing",
                progress: ev.progress ?? 0,
              });
            } else if (ev.type === "done") {
              setProps((prev) => ({ ...prev, src: ev.output }));
              setCaptureState({
                kind: "done",
                output: ev.output,
                size: ev.size,
              });
              setCaptureRefreshKey((k) => k + 1);
              onCaptureComplete();
              setCaptureName(defaultCaptureName());
            } else if (ev.type === "error") {
              setCaptureState({ kind: "error", message: ev.message });
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch (err) {
      setCaptureState({ kind: "error", message: (err as Error).message });
    }
  };

  const captureRunning = captureState.kind === "capturing";

  const startExport = async () => {
    if (!props.src) return;
    setExportState({ kind: "capturing", stage: "starting", progress: 0 });
    try {
      const res = await fetch("/api/render-screen-demo", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          props,
          fps: FPS,
          duration: durationSec,
        }),
      });
      if (!res.body) throw new Error("no response body");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl).trim();
          buffer = buffer.slice(nl + 1);
          if (!line) continue;
          try {
            const ev = JSON.parse(line);
            if (ev.type === "stage") {
              setExportState({
                kind: "capturing",
                stage: ev.stage,
                progress: 0,
              });
            } else if (ev.type === "progress") {
              setExportState({
                kind: "capturing",
                stage: "rendering",
                progress: ev.progress ?? 0,
              });
            } else if (ev.type === "done") {
              setExportState({
                kind: "done",
                output: ev.output,
                size: ev.size,
              });
              onCaptureComplete();
            } else if (ev.type === "error") {
              setExportState({ kind: "error", message: ev.message });
            }
          } catch {
            // skip malformed lines
          }
        }
      }
    } catch (err) {
      setExportState({ kind: "error", message: (err as Error).message });
    }
  };

  const exportRunning = exportState.kind === "capturing";

  const kfLabelStyle: React.CSSProperties = {
    color: "#8b8b94",
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 0.5,
  };

  const kfInputStyle: React.CSSProperties = {
    background: "#0c0c10",
    border: "1px solid #2e2e34",
    borderRadius: 4,
    color: "#e8e8ea",
    padding: "4px 6px",
    width: 60,
    fontSize: 12,
    textAlign: "center",
  };

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "220px 1fr 340px",
        gridTemplateRows: "auto 1fr auto",
        height: "100%",
        minHeight: 0,
        overflow: "hidden",
      }}
    >
      {/* Left sidebar — spans all rows */}
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gridRow: "1 / -1",
          minHeight: 0,
          background: "#101014",
          borderRight: "1px solid #1e1e24",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            padding: "10px 12px",
            borderBottom: "1px solid #1e1e24",
            flexShrink: 0,
          }}
        >
          <strong style={{ fontSize: 13 }}>Captures</strong>
        </div>
        <div style={{ overflowY: "auto", padding: 10, flex: 1, minHeight: 0 }}>
          <CaptureList
            selected={props.src}
            onSelect={(src) => setProps((p) => ({ ...p, src }))}
            onDelete={(name) => {
              if (props.src === name) setProps((p) => ({ ...p, src: "" }));
              onCaptureComplete();
            }}
            refreshKey={captureRefreshKey}
          />
        </div>
      </div>

      {/* Center — toolbar (row 1) */}
      <div
        style={{
          gridColumn: 2,
          gridRow: 1,
          background: "#070708",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            borderBottom: "1px solid #1e1e24",
            flexWrap: "wrap",
          }}
        >
          <strong style={{ marginRight: "auto" }}>Screen Demo</strong>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ color: "#8b8b94", fontSize: 12 }}>URL</label>
            <input
              value={props.sourceUrl}
              onChange={(e) =>
                setProps((p) => ({ ...p, sourceUrl: e.target.value }), "url")
              }
              style={{
                background: "#0c0c10",
                border: "1px solid #2e2e34",
                borderRadius: 6,
                color: "#e8e8ea",
                padding: "6px 10px",
                fontSize: 12,
                width: 220,
              }}
            />
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ color: "#8b8b94", fontSize: 12 }}>Duration</label>
            <input
              type="number"
              value={durationSec}
              min={1}
              max={120}
              step={1}
              onChange={(e) => setDurationSec(Number(e.target.value))}
              style={{
                background: "#0c0c10",
                border: "1px solid #2e2e34",
                borderRadius: 6,
                color: "#e8e8ea",
                padding: "6px 10px",
                fontSize: 12,
                width: 50,
                textAlign: "center",
              }}
            />
            <span style={{ color: "#70707a", fontSize: 11 }}>s</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
            <label style={{ color: "#8b8b94", fontSize: 12 }}>Name</label>
            <input
              value={captureName}
              onChange={(e) => setCaptureName(e.target.value)}
              style={{
                background: "#0c0c10",
                border: "1px solid #2e2e34",
                borderRadius: 6,
                color: "#e8e8ea",
                padding: "6px 10px",
                fontSize: 12,
                width: 180,
              }}
              placeholder="capture-..."
            />
          </div>
          <button
            onClick={startCapture}
            disabled={captureRunning}
            style={{
              background: captureRunning ? "#3a3a44" : "#2563eb",
              color: "white",
              border: "none",
              padding: "8px 14px",
              borderRadius: 8,
              cursor: captureRunning ? "default" : "pointer",
              fontWeight: 600,
              fontSize: 12,
            }}
          >
            {captureRunning
              ? `Capturing ${Math.round((captureState as { progress: number }).progress * 100)}%`
              : "Capture"}
          </button>
          {captureState.kind === "done" && (
            <span style={{ color: "#4ade80", fontSize: 12 }}>
              {(captureState.size / 1024 / 1024).toFixed(1)} MB
            </span>
          )}
          {captureState.kind === "error" && (
            <span
              style={{ color: "#ff7a75", fontSize: 12, maxWidth: 200 }}
              title={captureState.message}
            >
              Error
            </span>
          )}
          <button
            onClick={startExport}
            disabled={exportRunning || !props.src}
            style={{
              background: exportRunning
                ? "#3a3a44"
                : !props.src
                  ? "#1a1a22"
                  : "#16a34a",
              color: !props.src ? "#5a5a64" : "white",
              border: "none",
              padding: "8px 14px",
              borderRadius: 8,
              cursor: exportRunning || !props.src ? "default" : "pointer",
              fontWeight: 600,
              fontSize: 12,
            }}
            title={
              !props.src
                ? "Capture a page first"
                : "Render composition to media pool"
            }
          >
            {exportRunning
              ? `Exporting ${Math.round((exportState as { progress: number }).progress * 100)}%`
              : "Export to Media"}
          </button>
          {exportState.kind === "done" && (
            <span style={{ color: "#4ade80", fontSize: 12 }}>
              {((exportState.size as number) / 1024 / 1024).toFixed(1)} MB
            </span>
          )}
          {exportState.kind === "error" && (
            <span
              style={{ color: "#ff7a75", fontSize: 12, maxWidth: 200 }}
              title={(exportState as { message: string }).message}
            >
              Export error
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 4 }}>
            <button
              onClick={() => setShowCursor((v) => !v)}
              style={{
                background: showCursor ? "#4a6aa8" : "#2a2a34",
                color: showCursor ? "#fff" : "#8b8b94",
                border: "none",
                padding: "6px 12px",
                borderRadius: 6,
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 11,
              }}
              title="Show cursor preview and include cursor in capture"
            >
              Cursor
            </button>
            <button
              onClick={() => setOverscan((o) => !o)}
              style={{
                background: overscan ? "#4a6aa8" : "#2a2a34",
                color: overscan ? "#fff" : "#8b8b94",
                border: "none",
                padding: "6px 12px",
                borderRadius: 6,
                cursor: "pointer",
                fontWeight: 600,
                fontSize: 11,
              }}
              title="Show area outside the viewport"
            >
              Overscan
            </button>
          </div>
        </div>
      </div>

      {/* Center — player (row 2) */}
      <div
        style={{
          gridColumn: 2,
          gridRow: 2,
          minHeight: 0,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
          background: "#070708",
        }}
      >
        <div
          style={{
            position: "relative",
            width: "100%",
            maxHeight: "100%",
            aspectRatio: `${overscan ? OVERSCAN_W : WIDTH} / ${overscan ? OVERSCAN_H : HEIGHT}`,
          }}
        >
          <Player
            ref={playerRef}
            component={overscan ? OverscanScreenDemo : ScreenDemo}
            inputProps={props}
            durationInFrames={durationInFrames}
            compositionWidth={overscan ? OVERSCAN_W : WIDTH}
            compositionHeight={overscan ? OVERSCAN_H : HEIGHT}
            fps={FPS}
            controls
            style={{
              position: "absolute",
              inset: 0,
              width: "100%",
              height: "100%",
            }}
            acknowledgeRemotionLicense
          />
          {showCursor && cursorAtFrame && (
            <div
              style={{
                position: "absolute",
                left: `${((overscan ? (OVERSCAN_W - WIDTH) / 2 + cursorAtFrame.x : cursorAtFrame.x) / (overscan ? OVERSCAN_W : WIDTH)) * 100}%`,
                top: `${((overscan ? (OVERSCAN_H - HEIGHT) / 2 + cursorAtFrame.y : cursorAtFrame.y) / (overscan ? OVERSCAN_H : HEIGHT)) * 100}%`,
                pointerEvents: "none",
                zIndex: 10,
                transform: "translate(-2px, -2px)",
              }}
            >
              {CURSOR_SVG}
              {cursorAtFrame.clicking && (
                <div
                  style={{
                    position: "absolute",
                    top: 2,
                    left: 2,
                    width: 24,
                    height: 24,
                    borderRadius: "50%",
                    border: "2px solid rgba(245,158,11,0.7)",
                    transform: "translate(-50%, -50%)",
                  }}
                />
              )}
            </div>
          )}
        </div>
      </div>

      {/* Center — timeline (row 3) */}
      <ScreenDemoTimeline
        currentFrame={currentFrame}
        totalFrames={durationInFrames}
        fps={FPS}
        keyframes={props.keyframes}
        mouseEvents={mouseEvents}
        onSeek={(f) => playerRef.current?.seekTo(f)}
        onKeyframeFrame={(idx, frame) =>
          setProps(
            (prev) => ({
              ...prev,
              keyframes: prev.keyframes.map((kf, i) =>
                i === idx ? { ...kf, frame } : kf,
              ),
            }),
            `drag-kf-${idx}`,
          )
        }
        onMouseEventFrame={(idx, frame) =>
          setMouseEvents(
            (prev) =>
              prev.map((ev, i) => (i === idx ? { ...ev, frame } : ev)),
            `drag-me-${idx}`,
          )
        }
      />

      {/* Right sidebar — spans all rows */}
      <div
        style={{
          gridColumn: 3,
          gridRow: "1 / -1",
          borderLeft: "1px solid #1e1e24",
          overflowY: "auto",
          minHeight: 0,
          background: "#101014",
          padding: 12,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: 12,
          }}
        >
          <strong style={{ color: "#e8e8ea", fontSize: 14 }}>Keyframes</strong>
          <button
            onClick={addKeyframe}
            style={{
              background: "#2a2a34",
              color: "#e8e8ea",
              border: "1px solid #3a3a44",
              borderRadius: 6,
              padding: "4px 10px",
              cursor: "pointer",
              fontSize: 11,
            }}
          >
            + Add
          </button>
        </div>
        {props.keyframes.map((kf, i) => (
          <div
            key={i}
            style={{
              background: "#1a1a22",
              borderRadius: 8,
              padding: 10,
              marginBottom: 8,
              border: "1px solid #2e2e34",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: 8,
              }}
            >
              <span style={{ color: "#e8e8ea", fontSize: 12, fontWeight: 600 }}>
                #{i + 1} — frame {kf.frame}
              </span>
              {props.keyframes.length > 1 && (
                <button
                  onClick={() => removeKeyframe(i)}
                  style={{
                    background: "none",
                    border: "none",
                    color: "#ff7a75",
                    cursor: "pointer",
                    fontSize: 11,
                    padding: "2px 6px",
                  }}
                >
                  Remove
                </button>
              )}
            </div>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(3, 1fr)",
                gap: 6,
              }}
            >
              {(
                [
                  ["frame", "Frame"],
                  ["scale", "Scale"],
                  ["x", "X"],
                  ["y", "Y"],
                  ["rotateX", "Rot X"],
                  ["rotateY", "Rot Y"],
                ] as const
              ).map(([key, label]) => (
                <div key={key}>
                  <div style={kfLabelStyle}>{label}</div>
                  <input
                    type="number"
                    value={kf[key]}
                    step={key === "scale" ? 0.05 : key === "frame" ? 1 : 10}
                    onChange={(e) =>
                      updateKeyframe(i, { [key]: Number(e.target.value) }, `kf-${i}-${key}`)
                    }
                    style={kfInputStyle}
                  />
                </div>
              ))}
            </div>
          </div>
        ))}
        <div style={{ marginTop: 16 }}>
          <strong
            style={{ color: "#e8e8ea", fontSize: 14, display: "block", marginBottom: 10 }}
          >
            Style
          </strong>
          <div style={{ marginBottom: 8 }}>
            <div style={kfLabelStyle}>Background</div>
            <input
              value={props.background}
              onChange={(e) =>
                setProps((p) => ({ ...p, background: e.target.value }), "bg")
              }
              style={{ ...kfInputStyle, width: "100%" }}
            />
          </div>
          <div
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}
          >
            <div>
              <div style={kfLabelStyle}>Radius</div>
              <input
                type="number"
                value={props.screenRadius}
                onChange={(e) =>
                  setProps((p) => ({
                    ...p,
                    screenRadius: Number(e.target.value),
                  }), "radius")
                }
                style={kfInputStyle}
              />
            </div>
            <div>
              <div style={kfLabelStyle}>Shadow</div>
              <input
                value={props.screenShadow}
                onChange={(e) =>
                  setProps((p) => ({ ...p, screenShadow: e.target.value }), "shadow")
                }
                style={{ ...kfInputStyle, width: "100%" }}
              />
            </div>
          </div>
        </div>
        <div style={{ marginTop: 16 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: 10,
            }}
          >
            <strong style={{ color: "#e8e8ea", fontSize: 14 }}>
              Mouse Events
            </strong>
            <button
              onClick={() => {
                const last = mouseEvents[mouseEvents.length - 1];
                setMouseEvents((prev) => [
                  ...prev,
                  {
                    frame: (last?.frame ?? 0) + 30,
                    type: "move",
                    x: last?.x ?? Math.round(WIDTH / 2),
                    y: last?.y ?? Math.round(HEIGHT / 2),
                  },
                ]);
              }}
              style={{
                background: "#2a2a34",
                color: "#e8e8ea",
                border: "1px solid #3a3a44",
                borderRadius: 6,
                padding: "4px 10px",
                cursor: "pointer",
                fontSize: 11,
              }}
            >
              + Add
            </button>
          </div>
          {mouseEvents.length === 0 && (
            <div style={{ color: "#5a5a64", fontSize: 12 }}>
              No mouse events. Add one to show a cursor during capture.
            </div>
          )}
          {mouseEvents.map((ev, i) => (
            <div
              key={i}
              style={{
                background: "#1a1a22",
                borderRadius: 8,
                padding: 10,
                marginBottom: 8,
                border: "1px solid #2e2e34",
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  marginBottom: 8,
                }}
              >
                <select
                  value={ev.type}
                  onChange={(e) =>
                    setMouseEvents(
                      (prev) =>
                        prev.map((m, j) =>
                          j === i
                            ? { ...m, type: e.target.value as "move" | "click" }
                            : m,
                        ),
                      `me-${i}-type`,
                    )
                  }
                  style={{
                    background: "#0c0c10",
                    border: "1px solid #2e2e34",
                    borderRadius: 4,
                    color: ev.type === "click" ? "#f59e0b" : "#e8e8ea",
                    padding: "3px 6px",
                    fontSize: 12,
                  }}
                >
                  <option value="move">Move</option>
                  <option value="click">Click</option>
                </select>
                <button
                  onClick={() =>
                    setMouseEvents((prev) => prev.filter((_, j) => j !== i))
                  }
                  style={{
                    background: "none",
                    border: "none",
                    color: "#ff7a75",
                    cursor: "pointer",
                    fontSize: 11,
                    padding: "2px 6px",
                  }}
                >
                  Remove
                </button>
              </div>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr 1fr 1fr",
                  gap: 6,
                }}
              >
                {(
                  [
                    ["frame", "Frame"],
                    ["x", "X"],
                    ["y", "Y"],
                  ] as const
                ).map(([key, label]) => (
                  <div key={key}>
                    <div style={kfLabelStyle}>{label}</div>
                    <input
                      type="number"
                      value={ev[key]}
                      step={key === "frame" ? 1 : 10}
                      onChange={(e) =>
                        setMouseEvents(
                          (prev) =>
                            prev.map((m, j) =>
                              j === i
                                ? { ...m, [key]: Number(e.target.value) }
                                : m,
                            ),
                          `me-${i}-${key}`,
                        )
                      }
                      style={kfInputStyle}
                    />
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

const EditorInner: React.FC<{
  initial: MyCompositionProps;
  externalReloadKey: number;
}> = ({ initial, externalReloadKey }) => {
  const { state, set, reset, undo, redo, canUndo, canRedo } =
    useHistory<MyCompositionProps>(initial);
  const [savedSnapshot, setSavedSnapshot] =
    useState<MyCompositionProps>(initial);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [currentFrame, setCurrentFrame] = useState(0);
  const [selected, setSelected] = useState<Selection>(null);
  const [assetRefreshKey, setAssetRefreshKey] = useState(0);
  const [newProjectDialog, setNewProjectDialog] = useState(false);
  const [newProjectName, setNewProjectName] = useState("");
  const [projectName, setProjectName] = useState(initial.projectName ?? "");
  const [overscan, setOverscan] = useState(false);
  const playerRef = React.useRef<PlayerRef>(null);
  const rightPanelRef = React.useRef<HTMLDivElement>(null);

  const duration = useMemo(() => computeDuration(state), [state]);
  const durationInFrames = Math.max(1, Math.ceil(duration * FPS));

  const dirty = useMemo(
    () => JSON.stringify(state) !== JSON.stringify(savedSnapshot),
    [state, savedSnapshot],
  );

  useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    const onFrame = (e: { detail: { frame: number } }) =>
      setCurrentFrame(e.detail.frame);
    p.addEventListener("frameupdate", onFrame);
    return () => p.removeEventListener("frameupdate", onFrame);
  }, []);

  useEffect(() => {
    if (!selected) return;
    const root = rightPanelRef.current;
    if (!root) return;
    const id = `${selected.kind}-${selected.trackIndex}-${selected.itemIndex}`;
    const target = root.querySelector(
      `[data-card-id="${id}"]`,
    ) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [selected]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  const currentSeconds = currentFrame / FPS;

  const seekTo = useCallback((seconds: number) => {
    const p = playerRef.current;
    if (!p) return;
    const frame = Math.max(0, Math.round(seconds * FPS));
    // Paint the playhead + selection synchronously so the click feels instant,
    // then defer the video seek. Safari blocks the main thread when setting
    // <video>.currentTime for HEVC on a large jump — running the seek off the
    // click handler lets React paint before Safari decodes.
    setCurrentFrame(frame);
    requestAnimationFrame(() => p.seekTo(frame));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveMsg("");
    try {
      const res = await fetch("/api/composition", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ...state, projectName }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error ?? "save failed");
      setSavedSnapshot(state);
      setSaveMsg("Saved ✓");
      setTimeout(() => setSaveMsg(""), 2000);
    } catch (err) {
      setSaveMsg(`Error: ${(err as Error).message}`);
    } finally {
      setSaving(false);
    }
  }, [state]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        save();
        return;
      }
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      const isEditable =
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable;
      if (isEditable) return;
      if (e.code === "Space" && !e.metaKey && !e.ctrlKey && !e.altKey) {
        e.preventDefault();
        const p = playerRef.current;
        if (!p) return;
        if (p.isPlaying()) p.pause();
        else p.play();
        return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [save]);

  const updateClip = (
    trackIdx: number,
    itemIdx: number,
    patch: Partial<Clip>,
    coalesce?: string,
  ) => {
    set(
      (prev) => ({
        ...prev,
        videoTracks: prev.videoTracks.map((t, ti) =>
          ti !== trackIdx
            ? t
            : {
                ...t,
                clips: t.clips.map((c, ci) =>
                  ci === itemIdx ? { ...c, ...patch } : c,
                ),
              },
        ),
      }),
      {
        coalesce: coalesce
          ? `clip-${trackIdx}-${itemIdx}-${coalesce}`
          : undefined,
      },
    );
  };

  const updateSegment = (
    trackIdx: number,
    itemIdx: number,
    patch: Partial<TextSegment>,
    coalesce?: string,
  ) => {
    set(
      (prev) => ({
        ...prev,
        textTracks: prev.textTracks.map((t, ti) =>
          ti !== trackIdx
            ? t
            : {
                ...t,
                segments: t.segments.map((s, si) =>
                  si === itemIdx ? { ...s, ...patch } : s,
                ),
              },
        ),
      }),
      {
        coalesce: coalesce
          ? `seg-${trackIdx}-${itemIdx}-${coalesce}`
          : undefined,
      },
    );
  };

  const addVideoTrack = () => {
    set((prev) => ({
      ...prev,
      videoTracks: [
        ...prev.videoTracks,
        {
          id: newTrackId("v"),
          name: `V${prev.videoTracks.length + 1}`,
          clips: [],
        },
      ],
    }));
  };

  const addTextTrack = () => {
    set((prev) => ({
      ...prev,
      textTracks: [
        ...prev.textTracks,
        {
          id: newTrackId("t"),
          name: `T${prev.textTracks.length + 1}`,
          segments: [],
        },
      ],
    }));
  };

  const deleteVideoTrack = (idx: number) => {
    const track = state.videoTracks[idx];
    if (!track) return;
    if (track.clips.length > 0) {
      flash(`Can't delete "${track.name}" — it has ${track.clips.length} clip(s). Move or delete them first.`);
      return;
    }
    set((prev) => ({
      ...prev,
      videoTracks: prev.videoTracks.filter((_, i) => i !== idx),
    }));
    setSelected(null);
  };

  const deleteTextTrack = (idx: number) => {
    const track = state.textTracks[idx];
    if (!track) return;
    if (track.segments.length > 0) {
      flash(`Can't delete "${track.name}" — it has ${track.segments.length} segment(s). Move or delete them first.`);
      return;
    }
    set((prev) => ({
      ...prev,
      textTracks: prev.textTracks.filter((_, i) => i !== idx),
    }));
    setSelected(null);
  };

  const swap = <T,>(arr: T[], a: number, b: number): T[] => {
    if (a < 0 || b < 0 || a >= arr.length || b >= arr.length) return arr;
    const copy = arr.slice();
    [copy[a], copy[b]] = [copy[b], copy[a]];
    return copy;
  };

  const moveVideoTrack = (idx: number, dir: 1 | -1) => {
    const target = idx + dir;
    if (target < 0 || target >= state.videoTracks.length) return;
    set((prev) => ({
      ...prev,
      videoTracks: swap(prev.videoTracks, idx, target),
    }));
    // Keep selection pointing at the same track (now at `target`)
    if (selected?.kind === "clip") {
      if (selected.trackIndex === idx) {
        setSelected({ ...selected, trackIndex: target });
      } else if (selected.trackIndex === target) {
        setSelected({ ...selected, trackIndex: idx });
      }
    }
  };

  const moveTextTrack = (idx: number, dir: 1 | -1) => {
    const target = idx + dir;
    if (target < 0 || target >= state.textTracks.length) return;
    set((prev) => ({
      ...prev,
      textTracks: swap(prev.textTracks, idx, target),
    }));
    if (selected?.kind === "segment") {
      if (selected.trackIndex === idx) {
        setSelected({ ...selected, trackIndex: target });
      } else if (selected.trackIndex === target) {
        setSelected({ ...selected, trackIndex: idx });
      }
    }
  };

  const renameVideoTrack = (idx: number, name: string) => {
    set(
      (prev) => ({
        ...prev,
        videoTracks: prev.videoTracks.map((t, i) =>
          i === idx ? { ...t, name } : t,
        ),
      }),
      { coalesce: `rename-v-${idx}` },
    );
  };

  const renameTextTrack = (idx: number, name: string) => {
    set(
      (prev) => ({
        ...prev,
        textTracks: prev.textTracks.map((t, i) =>
          i === idx ? { ...t, name } : t,
        ),
      }),
      { coalesce: `rename-t-${idx}` },
    );
  };

  const addClip = (trackIdx: number) => {
    const track = state.videoTracks[trackIdx];
    if (!track) return;
    const last = track.clips[track.clips.length - 1];
    if (!last) {
      flash("Drop a clip from the media pool to add one to this track.");
      return;
    }
    const defaultClip: Clip = {
      src: last.src,
      from: last.from + (last.endAt - last.startFrom),
      startFrom: 0,
      endAt: 5,
    };
    set((prev) => ({
      ...prev,
      videoTracks: prev.videoTracks.map((t, i) =>
        i === trackIdx ? { ...t, clips: [...t.clips, defaultClip] } : t,
      ),
    }));
    setSelected({
      kind: "clip",
      trackIndex: trackIdx,
      itemIndex: track.clips.length,
    });
  };

  const deleteClip = (trackIdx: number, itemIdx: number) => {
    set((prev) => ({
      ...prev,
      videoTracks: prev.videoTracks.map((t, ti) =>
        ti !== trackIdx
          ? t
          : { ...t, clips: t.clips.filter((_, ci) => ci !== itemIdx) },
      ),
    }));
    setSelected(null);
  };

  const splitClip = (trackIdx: number, itemIdx: number) => {
    const track = state.videoTracks[trackIdx];
    const clip = track?.clips[itemIdx];
    if (!track || !clip) return;
    const clipTimelineStart = clip.from;
    const clipTimelineEnd = clip.from + (clip.endAt - clip.startFrom);
    const splitAtTimeline = currentSeconds;
    if (
      splitAtTimeline <= clipTimelineStart + 0.05 ||
      splitAtTimeline >= clipTimelineEnd - 0.05
    ) {
      flash(
        `Move playhead inside clip (${secs(clipTimelineStart)}s–${secs(
          clipTimelineEnd,
        )}s)`,
      );
      return;
    }
    const offsetIntoSource =
      clip.startFrom + (splitAtTimeline - clipTimelineStart);
    const left: Clip = { ...clip, endAt: offsetIntoSource };
    const right: Clip = {
      ...clip,
      from: splitAtTimeline,
      startFrom: offsetIntoSource,
    };
    set((prev) => ({
      ...prev,
      videoTracks: prev.videoTracks.map((t, ti) =>
        ti !== trackIdx
          ? t
          : {
              ...t,
              clips: [
                ...t.clips.slice(0, itemIdx),
                left,
                right,
                ...t.clips.slice(itemIdx + 1),
              ],
            },
      ),
    }));
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key !== "b" && e.key !== "B") return;
      const el = e.target as HTMLElement | null;
      const tag = el?.tagName;
      if (
        tag === "INPUT" ||
        tag === "TEXTAREA" ||
        tag === "SELECT" ||
        el?.isContentEditable
      )
        return;
      if (selected?.kind !== "clip") return;
      e.preventDefault();
      splitClip(selected.trackIndex, selected.itemIndex);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const addSegment = (trackIdx: number) => {
    const at = secs(currentSeconds);
    const segment: TextSegment = { from: at, duration: 3, text: "New caption" };
    set((prev) => ({
      ...prev,
      textTracks: prev.textTracks.map((t, i) =>
        i !== trackIdx
          ? t
          : {
              ...t,
              segments: [...t.segments, segment].sort(
                (a, b) => a.from - b.from,
              ),
            },
      ),
    }));
  };

  const deleteSegment = (trackIdx: number, itemIdx: number) => {
    set((prev) => ({
      ...prev,
      textTracks: prev.textTracks.map((t, ti) =>
        ti !== trackIdx
          ? t
          : { ...t, segments: t.segments.filter((_, si) => si !== itemIdx) },
      ),
    }));
    setSelected(null);
  };

  const addClipFromAsset = (src: string, durationSec: number) => {
    // Target: if a video track is selected use that; else first video track;
    // else create one.
    let targetIdx =
      selected?.kind === "clip" ? selected.trackIndex : -1;
    set((prev) => {
      let tracks = prev.videoTracks;
      if (tracks.length === 0) {
        tracks = [{ id: newTrackId("v"), name: "V1", clips: [] }];
        targetIdx = 0;
      } else if (targetIdx < 0 || targetIdx >= tracks.length) {
        targetIdx = 0;
      }
      const from = secs(currentSeconds);
      const clip: Clip = { src, from, startFrom: 0, endAt: durationSec };
      const newTracks = tracks.map((t, i) =>
        i === targetIdx ? { ...t, clips: [...t.clips, clip] } : t,
      );
      setSelected({
        kind: "clip",
        trackIndex: targetIdx,
        itemIndex: tracks[targetIdx].clips.length,
      });
      return { ...prev, videoTracks: newTracks };
    });
  };

  const renameAsset = async (from: string, to: string) => {
    const res = await fetch("/api/rename", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ from, to }),
    });
    const json = await res.json();
    if (!json.ok) throw new Error(json.error ?? "rename failed");
    const finalTo = json.to as string;
    set((prev) => ({
      ...prev,
      videoTracks: prev.videoTracks.map((t) => ({
        ...t,
        clips: t.clips.map((c) =>
          c.src === from ? { ...c, src: finalTo } : c,
        ),
      })),
    }));
    setAssetRefreshKey((k) => k + 1);
    return finalTo;
  };

  const dropAssetOnVideoTrack = (
    trackIdx: number,
    atSeconds: number,
    src: string,
    durationSec: number,
  ) => {
    set((prev) => {
      if (trackIdx < 0 || trackIdx >= prev.videoTracks.length) return prev;
      const clip: Clip = {
        src,
        from: Math.max(0, secs(atSeconds)),
        startFrom: 0,
        endAt: durationSec,
      };
      const newItemIndex = prev.videoTracks[trackIdx].clips.length;
      setSelected({
        kind: "clip",
        trackIndex: trackIdx,
        itemIndex: newItemIndex,
      });
      return {
        ...prev,
        videoTracks: prev.videoTracks.map((t, i) =>
          i === trackIdx ? { ...t, clips: [...t.clips, clip] } : t,
        ),
      };
    });
  };

  const revert = () => {
    fetch("/api/composition")
      .then((r) => r.json())
      .then((json) => {
        const data = json as MyCompositionProps;
        reset(data);
        setSavedSnapshot(data);
        setProjectName(data.projectName ?? "");
        setSelected(null);
      });
  };

  const flash = (msg: string) => {
    setSaveMsg(msg);
    setTimeout(() => setSaveMsg(""), 3500);
  };

  const importInputRef = React.useRef<HTMLInputElement>(null);

  // The server reads composition.json from disk when assembling the archive,
  // so unsaved in-memory edits have to be flushed first or they won't be in
  // the exported bundle.
  const exportProject = useCallback(async () => {
    try {
      if (dirty) await save();
      const defaultName = projectName || "project";
      const res = await fetch(`/api/export-project?filename=${encodeURIComponent(defaultName)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const blob = await res.blob();
      if ("showSaveFilePicker" in window) {
        const handle = await (window as any).showSaveFilePicker({
          suggestedName: `${defaultName}.dabinky`,
          types: [{ description: "Dabinky Project", accept: { "application/zip": [".dabinky"] } }],
        });
        const writable = await handle.createWritable();
        await writable.write(blob);
        await writable.close();
      } else {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `${defaultName}.dabinky`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(url);
      }
      flash("Exported ✓");
    } catch (err) {
      if ((err as Error).name === "AbortError") return;
      setSaveMsg(`Export error: ${(err as Error).message}`);
    }
  }, [dirty, save, projectName]);

  const openImportPicker = useCallback(() => {
    if (
      dirty &&
      !window.confirm(
        "You have unsaved changes. Importing will replace the current project and discard them. Continue?",
      )
    ) {
      return;
    }
    importInputRef.current?.click();
  }, [dirty]);

  const handleImportFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      // Reset the input so choosing the same file a second time still fires
      // change — otherwise a failed import can't be retried with the same file.
      e.target.value = "";
      if (!file) return;
      setSaving(true);
      setSaveMsg("Importing…");
      try {
        const res = await fetch("/api/import-project", {
          method: "POST",
          headers: { "content-type": "application/zip" },
          body: file,
        });
        const json = await res.json();
        if (!res.ok || !json.ok)
          throw new Error(json.error ?? `HTTP ${res.status}`);
        const imported = json.composition as MyCompositionProps;
        reset(imported);
        setSavedSnapshot(imported);
        setProjectName(imported.projectName ?? "");
        setSelected(null);
        // Bounce MediaPool's asset list — freshly imported media files won't
        // show up otherwise until the next manual refresh.
        setAssetRefreshKey((k) => k + 1);
        const warnings = Array.isArray(json.warnings) ? json.warnings : [];
        setSaveMsg(
          warnings.length
            ? `Imported ✓ — ${warnings.join("; ")}`
            : "Imported ✓",
        );
        setTimeout(() => setSaveMsg(""), warnings.length ? 6000 : 2500);
      } catch (err) {
        setSaveMsg(`Import error: ${(err as Error).message}`);
      } finally {
        setSaving(false);
      }
    },
    [reset],
  );

  const usedSources = useMemo(() => {
    const set = new Set<string>();
    for (const t of state.videoTracks) for (const c of t.clips) set.add(c.src);
    return set;
  }, [state.videoTracks]);

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "260px 1fr 460px",
        gridTemplateRows: "1fr auto",
        height: "100%",
        minHeight: 0,
      }}
    >
      <div style={{ gridColumn: 1, gridRow: "1 / span 2", minHeight: 0 }}>
        <MediaPool
          usedSources={usedSources}
          onAdd={addClipFromAsset}
          onDelete={() => setAssetRefreshKey((k) => k + 1)}
          reloadKey={assetRefreshKey + externalReloadKey}
        />
      </div>
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          minWidth: 0,
          background: "#070708",
          gridColumn: 2,
          gridRow: 1,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "10px 16px",
            borderBottom: "1px solid #1e1e24",
          }}
        >
          <strong style={{ marginRight: "auto" }}>
            Editor{projectName && <span style={{ fontWeight: 400, color: "#8b8b94" }}>{" — "}{projectName}</span>}
          </strong>
          <IconButton
            onClick={() => {
              setNewProjectName("");
              setNewProjectDialog(true);
            }}
            title="Clear timeline and start fresh"
          >
            ✦ New
          </IconButton>
          <IconButton disabled={!canUndo} onClick={undo} title="Undo (⌘Z)">
            ↶ Undo
          </IconButton>
          <IconButton disabled={!canRedo} onClick={redo} title="Redo (⌘⇧Z)">
            ↷ Redo
          </IconButton>
          <IconButton onClick={revert} title="Reload from disk">
            Revert
          </IconButton>
          <IconButton
            onClick={openImportPicker}
            title="Import a .dabinky project archive"
          >
            ⇡ Import
          </IconButton>
          <IconButton
            onClick={exportProject}
            title="Download this project as a .dabinky archive"
          >
            ⇣ Export
          </IconButton>
          <input
            ref={importInputRef}
            type="file"
            accept=".dabinky,application/zip"
            onChange={handleImportFile}
            style={{ display: "none" }}
          />
          <SaveButton dirty={dirty} saving={saving} onClick={save} />
          <RenderButton
            dirty={dirty}
            onSaveFirst={save}
            inputProps={state}
            durationInFrames={durationInFrames}
            fps={FPS}
            width={WIDTH}
            height={HEIGHT}
          />
          <span
            style={{
              color: saveMsg.startsWith("Error") ? "#ff7a75" : "#8b8b94",
              fontSize: 12,
              maxWidth: 260,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {saveMsg}
          </span>
          <button
            onClick={() => setOverscan((o) => !o)}
            style={{
              background: overscan ? "#4a6aa8" : "#2a2a34",
              color: overscan ? "#fff" : "#8b8b94",
              border: "none",
              padding: "6px 12px",
              borderRadius: 6,
              cursor: "pointer",
              fontWeight: 600,
              fontSize: 11,
              marginLeft: "auto",
            }}
            title="Show area outside the viewport"
          >
            Overscan
          </button>
        </div>
        <div
          style={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: 16,
          }}
        >
          <Player
            ref={playerRef}
            component={overscan ? OverscanMyComposition : MyComposition}
            inputProps={state}
            durationInFrames={durationInFrames}
            compositionWidth={overscan ? OVERSCAN_W : WIDTH}
            compositionHeight={overscan ? OVERSCAN_H : HEIGHT}
            fps={FPS}
            controls
            style={{ width: "100%", maxHeight: "100%" }}
            acknowledgeRemotionLicense
          />
        </div>
      </div>
      <div
        ref={rightPanelRef}
        style={{
          borderLeft: "1px solid #1e1e24",
          overflowY: "auto",
          background: "#101014",
          gridColumn: 3,
          gridRow: "1 / span 2",
        }}
      >
        <SectionHeader
          title="Video tracks"
          action={
            <button onClick={addVideoTrack} style={addBtnStyle}>
              + Track
            </button>
          }
        />
        {state.videoTracks
          .map((track, ti) => ({ track, ti }))
          .reverse()
          .map(({ track, ti }) => (
          <TrackGroup
            key={track.id}
            name={track.name}
            color="#4a6aa8"
            onRename={(name) => renameVideoTrack(ti, name)}
            onDelete={() => deleteVideoTrack(ti)}
            onAddItem={() => addClip(ti)}
            addLabel="+ Clip"
            canMoveUp={ti < state.videoTracks.length - 1}
            canMoveDown={ti > 0}
            onMoveUp={() => moveVideoTrack(ti, 1)}
            onMoveDown={() => moveVideoTrack(ti, -1)}
            onAssetDrop={(payload) =>
              dropAssetOnVideoTrack(
                ti,
                currentSeconds,
                payload.src,
                payload.duration,
              )
            }
          >
            {track.clips.map((clip, ci) => (
              <ClipCard
                key={ci}
                clip={clip}
                cardId={`clip-${ti}-${ci}`}
                selected={
                  selected?.kind === "clip" &&
                  selected.trackIndex === ti &&
                  selected.itemIndex === ci
                }
                onSelect={() => {
                  const wasSelected =
                    selected?.kind === "clip" &&
                    selected.trackIndex === ti &&
                    selected.itemIndex === ci;
                  setSelected({ kind: "clip", trackIndex: ti, itemIndex: ci });
                  if (!wasSelected) seekTo(clip.from);
                }}
                onChange={(patch, coalesce) =>
                  updateClip(ti, ci, patch, coalesce)
                }
                onRenameSrc={renameAsset}
                onRenameError={flash}
              />
            ))}
            {track.clips.length === 0 && <EmptyHint>No clips.</EmptyHint>}
          </TrackGroup>
        ))}
        {state.videoTracks.length === 0 && (
          <EmptyHint>No video tracks. Add one to start.</EmptyHint>
        )}
        <SectionHeader
          title="Text tracks"
          action={
            <button onClick={addTextTrack} style={addBtnStyle}>
              + Track
            </button>
          }
        />
        {state.textTracks
          .map((track, ti) => ({ track, ti }))
          .reverse()
          .map(({ track, ti }) => (
          <TrackGroup
            key={track.id}
            name={track.name}
            color="#c48556"
            onRename={(name) => renameTextTrack(ti, name)}
            onDelete={() => deleteTextTrack(ti)}
            onAddItem={() => addSegment(ti)}
            addLabel="+ Caption @ playhead"
            canMoveUp={ti < state.textTracks.length - 1}
            canMoveDown={ti > 0}
            onMoveUp={() => moveTextTrack(ti, 1)}
            onMoveDown={() => moveTextTrack(ti, -1)}
          >
            {track.segments.map((seg, si) => (
              <SegmentCard
                key={si}
                segment={seg}
                cardId={`segment-${ti}-${si}`}
                selected={
                  selected?.kind === "segment" &&
                  selected.trackIndex === ti &&
                  selected.itemIndex === si
                }
                onSelect={() => {
                  const wasSelected =
                    selected?.kind === "segment" &&
                    selected.trackIndex === ti &&
                    selected.itemIndex === si;
                  setSelected({
                    kind: "segment",
                    trackIndex: ti,
                    itemIndex: si,
                  });
                  if (!wasSelected) seekTo(seg.from);
                }}
                onChange={(patch, coalesce) =>
                  updateSegment(ti, si, patch, coalesce)
                }
              />
            ))}
            {track.segments.length === 0 && <EmptyHint>No segments.</EmptyHint>}
          </TrackGroup>
        ))}
        {state.textTracks.length === 0 && (
          <EmptyHint>No text tracks. Add one to start.</EmptyHint>
        )}
      </div>
      <div style={{ gridColumn: 2, gridRow: 2, minWidth: 0 }}>
        <Timeline
          state={state}
          update={(updater, coalesceKey) =>
            set(updater, { coalesce: coalesceKey })
          }
          duration={duration}
          currentSeconds={currentSeconds}
          onSeek={seekTo}
          selected={selected}
          onSelect={setSelected}
          onDropAsset={dropAssetOnVideoTrack}
          onSplitSelectedClip={() => {
            if (selected?.kind !== "clip") return;
            splitClip(selected.trackIndex, selected.itemIndex);
          }}
          onDeleteSelected={() => {
            if (!selected) return;
            if (selected.kind === "clip") {
              deleteClip(selected.trackIndex, selected.itemIndex);
            } else {
              deleteSegment(selected.trackIndex, selected.itemIndex);
            }
          }}
        />
      </div>
      {newProjectDialog && (
        <div
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
          }}
          onClick={() => setNewProjectDialog(false)}
        >
          <div
            style={{
              background: "#1a1a22",
              borderRadius: 12,
              padding: 24,
              minWidth: 340,
              display: "flex",
              flexDirection: "column",
              gap: 16,
            }}
            onClick={(e) => e.stopPropagation()}
          >
            <strong style={{ color: "#fff", fontSize: 16 }}>New Project</strong>
            <p style={{ color: "#aaa", fontSize: 13, margin: 0 }}>
              This will clear the timeline and media pool.
            </p>
            <input
              autoFocus
              type="text"
              placeholder="Project name"
              value={newProjectName}
              onChange={(e) => setNewProjectName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setNewProjectDialog(false);
                if (e.key === "Enter" && newProjectName.trim()) {
                  (e.target as HTMLInputElement).closest("div")
                    ?.querySelector<HTMLButtonElement>("button[data-create]")
                    ?.click();
                }
              }}
              style={{
                background: "#0c0c10",
                border: "1px solid #333",
                borderRadius: 6,
                padding: "8px 12px",
                color: "#fff",
                fontSize: 14,
                outline: "none",
              }}
            />
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button
                onClick={() => setNewProjectDialog(false)}
                style={{
                  background: "#2a2a34",
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 16px",
                  color: "#ccc",
                  cursor: "pointer",
                  fontSize: 13,
                }}
              >
                Cancel
              </button>
              <button
                data-create
                disabled={!newProjectName.trim()}
                onClick={async () => {
                  const name = newProjectName.trim();
                  setNewProjectDialog(false);
                  const blank: MyCompositionProps = {
                    projectName: name,
                    fadeDuration: 0.5,
                    fontSize: 32,
                    textColor: "#ffffff",
                    bgColor: "rgba(0, 0, 0, 0.7)",
                    bgBorderRadius: 12,
                    paddingBottom: 50,
                    videoTracks: [{ id: newTrackId("v"), name: "V1", clips: [] }],
                    textTracks: [{ id: newTrackId("t"), name: "T1", segments: [] }],
                  };
                  await fetch("/api/clear-media", { method: "POST" });
                  const res = await fetch("/api/composition", {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(blank),
                  });
                  if (!(await res.json()).ok) {
                    setSaveMsg("Error creating project");
                    return;
                  }
                  reset(blank);
                  setSavedSnapshot(blank);
                  setSelected(null);
                  setCurrentFrame(0);
                  setAssetRefreshKey((k) => k + 1);
                  setProjectName(name);
                  setSaveMsg(`New project: ${name}`);
                }}
                style={{
                  background: !newProjectName.trim() ? "#333" : "#4f6df5",
                  border: "none",
                  borderRadius: 6,
                  padding: "6px 16px",
                  color: "#fff",
                  cursor: !newProjectName.trim() ? "default" : "pointer",
                  fontSize: 13,
                  opacity: !newProjectName.trim() ? 0.5 : 1,
                }}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

const SaveButton: React.FC<{
  dirty: boolean;
  saving: boolean;
  onClick: () => void;
}> = ({ dirty, saving, onClick }) => {
  const label = saving ? "Saving…" : dirty ? "Save (⌘S) •" : "Saved";
  return (
    <button
      onClick={onClick}
      disabled={saving || !dirty}
      style={{
        background: dirty ? "#f2b705" : "#1e6f3e",
        color: dirty ? "#1a1500" : "white",
        border: "none",
        padding: "8px 14px",
        borderRadius: 8,
        cursor: saving || !dirty ? "default" : "pointer",
        fontWeight: 600,
        boxShadow: dirty ? "0 0 0 1px rgba(255,255,255,0.15)" : undefined,
      }}
      title={dirty ? "Unsaved changes" : "All changes saved"}
    >
      {label}
    </button>
  );
};

type RenderStats = {
  elapsedMs: number;
  sizeBytes: number;
  totalFrames: number;
  fps: number;
  workers: number;
};

type RenderState =
  | { kind: "idle" }
  | { kind: "preparing"; startedAt: number }
  | {
      kind: "rendering";
      startedAt: number;
      progress: number;
      renderedFrames: number;
      encodedFrames: number;
      totalFrames: number;
      fps: number;
      // Populated only in parallel mode. Index = chunk index.
      chunkProgress?: number[];
    }
  | { kind: "saving"; startedAt: number }
  | { kind: "compressing"; startedAt: number; progress: number }
  | { kind: "done"; outputPath: string; stats: RenderStats }
  | { kind: "error"; message: string };

const defaultRenderName = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return `render-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
};

type CodecChoice = "auto" | "av1" | "h265" | "h264";
type BitratePreset = "very-low" | "low" | "medium" | "high" | "very-high";

const CODEC_PROBES: Array<{ codec: "av1" | "h265" | "h264"; mime: string }> = [
  { codec: "av1", mime: "av01.0.08M.08" },
  { codec: "h265", mime: "hev1.1.6.L120.90" },
  { codec: "h264", mime: "avc1.640028" },
];

// Returns a map of which codecs this browser's WebCodecs path actually
// supports at the given resolution/fps. Used to disable unavailable choices
// in the codec dropdown.
const probeCodecs = async (
  width: number,
  height: number,
  fps: number,
): Promise<Record<"av1" | "h265" | "h264", boolean>> => {
  const out = { av1: false, h265: false, h264: false };
  const VE = (globalThis as { VideoEncoder?: typeof VideoEncoder }).VideoEncoder;
  if (!VE) return out;
  await Promise.all(
    CODEC_PROBES.map(async ({ codec, mime }) => {
      try {
        const res = await VE.isConfigSupported({
          codec: mime,
          width,
          height,
          framerate: fps,
          bitrate: 2_000_000,
          hardwareAcceleration: "prefer-hardware",
        });
        out[codec] = !!res.supported;
      } catch {
        // probe failed; leave as false
      }
    }),
  );
  return out;
};

// Given a support map, return the preferred codec: AV1 > HEVC > H.264.
const pickAutoCodec = (
  support: Record<"av1" | "h265" | "h264", boolean>,
): "av1" | "h265" | "h264" => {
  if (support.av1) return "av1";
  if (support.h265) return "h265";
  return "h264";
};

const CODEC_LABELS: Record<"av1" | "h265" | "h264", string> = {
  av1: "AV1",
  h265: "HEVC (H.265)",
  h264: "H.264",
};

// Detect which engine the editor tab is running in. Used to pick matching
// Playwright browsers for parallel workers, so codec support in workers
// aligns with what the user expects from their editor tab's behavior.
type Engine = "webkit" | "chromium";
const detectEngine = (): Engine => {
  const ua = navigator.userAgent;
  // Chrome-family UAs include "Chrome"; pure Safari UAs don't.
  if (/Chrome\//.test(ua) || /Chromium\//.test(ua) || /Edg\//.test(ua)) {
    return "chromium";
  }
  if (/Safari\//.test(ua)) {
    return "webkit";
  }
  return "chromium";
};

const BITRATE_LABELS: Record<BitratePreset, string> = {
  "very-low": "Very low (smallest file)",
  low: "Low",
  medium: "Medium (default)",
  high: "High",
  "very-high": "Very high (largest file)",
};

const runSingleRender = async (opts: {
  filename: string;
  videoCodec: "av1" | "h265" | "h264";
  bitrate: BitratePreset;
  inputProps: MyCompositionProps;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
  signal: AbortSignal;
  setState: React.Dispatch<React.SetStateAction<RenderState>>;
  startedAt: number;
}) => {
  const {
    filename,
    videoCodec,
    bitrate,
    inputProps,
    durationInFrames,
    fps,
    width,
    height,
    signal,
    setState,
    startedAt,
  } = opts;
  const { renderMediaOnWeb } = await import("@remotion/web-renderer");
  const result = await renderMediaOnWeb({
    composition: {
      id: "MyComp",
      component: MyComposition,
      durationInFrames,
      fps,
      width,
      height,
    },
    inputProps,
    container: "mp4",
    videoCodec,
    videoBitrate: bitrate,
    muted: true,
    hardwareAcceleration: "prefer-hardware",
    outputTarget: "arraybuffer",
    timeoutInMilliseconds: 120000,
    signal,
    onProgress: (p) => {
      setState({
        kind: "rendering",
        startedAt,
        progress: p.progress,
        renderedFrames: p.renderedFrames,
        encodedFrames: p.encodedFrames,
        totalFrames: durationInFrames,
        fps,
      });
    },
  });
  const blob = await result.getBlob();
  setState({ kind: "saving", startedAt });
  const res = await fetch("/api/save-render", {
    method: "POST",
    headers: {
      "content-type": "video/mp4",
      "x-filename": encodeURIComponent(`${filename}.mp4`),
    },
    body: blob,
  });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error ?? "save failed");
  setState({
    kind: "done",
    outputPath: json.path,
    stats: {
      elapsedMs: Date.now() - startedAt,
      sizeBytes: typeof json.size === "number" ? json.size : blob.size,
      totalFrames: durationInFrames,
      fps,
      workers: 1,
    },
  });
};

// Server-orchestrated parallel render. Streams NDJSON events back as chunk
// progress arrives; concat happens server-side via ffmpeg and the final
// file lands in out/<filename>.mp4.
const runParallelRender = async (opts: {
  filename: string;
  workers: number;
  codec: CodecChoice;
  bitrate: BitratePreset;
  engine: Engine;
  signal: AbortSignal;
  setState: React.Dispatch<React.SetStateAction<RenderState>>;
  durationInFrames: number;
  fps: number;
  startedAt: number;
}) => {
  const {
    filename,
    workers,
    codec,
    bitrate,
    engine,
    signal,
    setState,
    durationInFrames,
    fps,
    startedAt,
  } = opts;
  const res = await fetch("/api/parallel-render", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ filename, workers, codec, bitrate, engine }),
    signal,
  });
  if (!res.body) throw new Error("no response body");
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const chunkProgress = new Array(workers).fill(0);
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const ev = JSON.parse(line);
        if (ev.type === "stage") {
          // The compress stage runs after all chunks are uploaded and
          // can take minutes on its own (libsvtav1 transcode). Swap the
          // UI out of "rendering 100%" so the user sees what's happening.
          if (ev.stage === "compressing") {
            setState({
              kind: "compressing",
              startedAt: Date.now(),
              progress: 0,
            });
          }
        } else if (ev.type === "compress-progress") {
          const p =
            typeof ev.progress === "number" ? ev.progress : 0;
          setState((prev) =>
            prev.kind === "compressing" ? { ...prev, progress: p } : prev,
          );
        } else if (ev.type === "progress") {
          if (
            typeof ev.chunk === "number" &&
            typeof ev.progress === "number" &&
            ev.chunk >= 0 &&
            ev.chunk < chunkProgress.length
          ) {
            chunkProgress[ev.chunk] = ev.progress;
          }
          const overall = ev.overall ?? 0;
          setState({
            kind: "rendering",
            startedAt,
            progress: overall,
            renderedFrames: Math.round(overall * durationInFrames),
            encodedFrames: 0,
            totalFrames: durationInFrames,
            fps,
            chunkProgress: chunkProgress.slice(),
          });
        } else if (ev.type === "done") {
          setState({
            kind: "done",
            outputPath: ev.outputPath,
            stats: {
              elapsedMs: Date.now() - startedAt,
              sizeBytes: typeof ev.size === "number" ? ev.size : 0,
              totalFrames: durationInFrames,
              fps,
              workers,
            },
          });
        } else if (ev.type === "error") {
          throw new Error(ev.message ?? "parallel render failed");
        }
      } catch (err) {
        // Re-throw real errors; swallow JSON parse errors on malformed lines.
        if (err instanceof SyntaxError) continue;
        throw err;
      }
    }
  }
};

const RenderButton: React.FC<{
  dirty: boolean;
  onSaveFirst: () => Promise<void> | void;
  inputProps: MyCompositionProps;
  durationInFrames: number;
  fps: number;
  width: number;
  height: number;
}> = ({
  dirty,
  onSaveFirst,
  inputProps,
  durationInFrames,
  fps,
  width,
  height,
}) => {
  const [open, setOpen] = React.useState(false);
  const [filename, setFilename] = React.useState(defaultRenderName());
  const [state, setState] = React.useState<RenderState>({ kind: "idle" });
  const [codec, setCodec] = React.useState<CodecChoice>("auto");
  const [bitrate, setBitrate] = React.useState<BitratePreset>("medium");
  const [workers, setWorkers] = React.useState<number>(1);
  const [engineOverride, setEngineOverride] = React.useState<
    "auto" | Engine
  >("auto");
  const [codecSupport, setCodecSupport] = React.useState<Record<
    "av1" | "h265" | "h264",
    boolean
  > | null>(null);
  const [outputDir, setOutputDir] = React.useState<string>("");
  const [outputDirDraft, setOutputDirDraft] = React.useState<string>("");
  const [outputDirSaving, setOutputDirSaving] = React.useState(false);
  const cancelRef = React.useRef<AbortController | null>(null);
  const rootRef = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    if (!open) return;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((s: { outputDir?: string }) => {
        if (typeof s.outputDir === "string") {
          setOutputDir(s.outputDir);
          setOutputDirDraft(s.outputDir);
        }
      })
      .catch(() => {
        // Non-fatal: render still works, just without surfacing the folder.
      });
  }, [open]);

  const commitOutputDir = async () => {
    const next = outputDirDraft.trim();
    if (!next || next === outputDir) {
      setOutputDirDraft(outputDir);
      return;
    }
    setOutputDirSaving(true);
    try {
      const res = await fetch("/api/settings", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ outputDir: next }),
      });
      const json = await res.json();
      if (!res.ok || !json.ok)
        throw new Error(json.error ?? `HTTP ${res.status}`);
      const saved = json.settings?.outputDir ?? next;
      setOutputDir(saved);
      setOutputDirDraft(saved);
    } catch {
      setOutputDirDraft(outputDir);
    } finally {
      setOutputDirSaving(false);
    }
  };

  const running =
    state.kind === "preparing" ||
    state.kind === "rendering" ||
    state.kind === "saving" ||
    state.kind === "compressing";

  React.useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (running) return;
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, running]);

  // Probe which codecs this browser actually accepts the first time the
  // dialog opens — lets us disable unsupported options in the dropdown.
  React.useEffect(() => {
    if (!open || codecSupport) return;
    let cancelled = false;
    probeCodecs(width, height, fps).then((support) => {
      if (!cancelled) setCodecSupport(support);
    });
    return () => {
      cancelled = true;
    };
  }, [open, codecSupport, width, height, fps]);

  const startRender = async () => {
    if (dirty) await onSaveFirst();
    const startedAt = Date.now();
    setState({ kind: "preparing", startedAt });
    const controller = new AbortController();
    cancelRef.current = controller;
    try {
      const safeName = filename || defaultRenderName();

      if (workers > 1) {
        // For the parallel path we ship the user's raw choice ("auto" or an
        // explicit codec) to the worker pages. Workers run in headless
        // Chromium, which has different codec support from the editor tab
        // (which might be Safari with AV1), so they must probe for
        // themselves — the editor's probe isn't valid for them.
        const engine: Engine =
          engineOverride === "auto" ? detectEngine() : engineOverride;
        await runParallelRender({
          filename: safeName,
          workers,
          codec,
          bitrate,
          engine,
          signal: controller.signal,
          setState,
          durationInFrames,
          fps,
          startedAt,
        });
      } else {
        const support =
          codecSupport ?? (await probeCodecs(width, height, fps));
        // "auto": pick the best available (AV1 > HEVC > H.264). Otherwise
        // the user's explicit choice — we still downgrade silently if they
        // picked one this browser can't encode.
        const videoCodec =
          codec === "auto"
            ? pickAutoCodec(support)
            : support[codec]
              ? codec
              : pickAutoCodec(support);
        await runSingleRender({
          filename: safeName,
          videoCodec,
          bitrate,
          inputProps,
          durationInFrames,
          fps,
          width,
          height,
          signal: controller.signal,
          setState,
          startedAt,
        });
      }
    } catch (err) {
      setState({ kind: "error", message: (err as Error).message });
    } finally {
      cancelRef.current = null;
    }
  };

  const cancelRender = () => {
    cancelRef.current?.abort();
  };

  const reveal = async (p: string) => {
    try {
      await fetch("/api/reveal", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ path: p }),
      });
    } catch {
      // ignore
    }
  };

  return (
    <div ref={rootRef} style={{ position: "relative" }}>
      <button
        onClick={() => {
          setOpen((o) => !o);
          if (state.kind === "done" || state.kind === "error") {
            setState({ kind: "idle" });
            setFilename(defaultRenderName());
          }
        }}
        style={{
          background: running ? "#7a2a2a" : "#a13a2a",
          color: "white",
          border: "none",
          padding: "8px 14px",
          borderRadius: 8,
          cursor: "pointer",
          fontWeight: 600,
          boxShadow: "0 0 0 1px rgba(255,255,255,0.15)",
        }}
        title="Render to MP4"
      >
        {running ? "Rendering…" : "Render"}
      </button>
      {open && (
        <div
          style={{
            position: "absolute",
            top: "calc(100% + 6px)",
            right: 0,
            width: 340,
            background: "#17171d",
            border: "1px solid #2e2e34",
            borderRadius: 8,
            padding: 14,
            boxShadow: "0 8px 24px rgba(0,0,0,0.5)",
            zIndex: 10,
            fontSize: 12,
            color: "#e8e8ea",
          }}
        >
          <div style={{ fontWeight: 700, marginBottom: 8 }}>Render video</div>
          {state.kind === "idle" && (
            <>
              <div style={{ ...labelStyle, marginBottom: 4 }}>Filename</div>
              <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                <input
                  style={inputStyle}
                  value={filename}
                  onChange={(e) => setFilename(e.target.value)}
                  placeholder="render-…"
                  autoFocus
                />
                <span style={{ color: "#70707a", fontSize: 11 }}>.mp4</span>
              </div>
              <div style={{ ...labelStyle, marginTop: 10, marginBottom: 4 }}>
                Output folder
              </div>
              <input
                style={{
                  ...inputStyle,
                  opacity: outputDirSaving ? 0.6 : 1,
                }}
                value={outputDirDraft}
                disabled={outputDirSaving}
                placeholder="~/Movies/Dabinky"
                onChange={(e) => setOutputDirDraft(e.target.value)}
                onBlur={commitOutputDir}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    (e.target as HTMLInputElement).blur();
                  } else if (e.key === "Escape") {
                    setOutputDirDraft(outputDir);
                    (e.target as HTMLInputElement).blur();
                  }
                }}
                title="Folder renders get saved into. Press Enter to save."
              />
              <div
                style={{
                  marginTop: 4,
                  color: "#70707a",
                  fontSize: 11,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={`${outputDir || "…"}/${filename || "…"}.mp4`}
              >
                Saves to: {outputDir || "…"}/{filename || "…"}.mp4
              </div>
              <div style={{ ...labelStyle, marginTop: 10, marginBottom: 4 }}>
                Codec
              </div>
              <select
                style={{ ...inputStyle, cursor: "pointer" }}
                value={codec}
                onChange={(e) => setCodec(e.target.value as CodecChoice)}
              >
                <option value="auto">
                  Auto
                  {codecSupport
                    ? ` — ${CODEC_LABELS[pickAutoCodec(codecSupport)]}`
                    : ""}
                </option>
                {(["av1", "h265", "h264"] as const).map((c) => {
                  const probeSupported = codecSupport?.[c] ?? true;
                  const disabled = workers === 1 && !probeSupported;
                  return (
                    <option key={c} value={c} disabled={disabled}>
                      {CODEC_LABELS[c]}
                      {disabled ? " — unsupported in this browser" : ""}
                    </option>
                  );
                })}
              </select>
              <div style={{ ...labelStyle, marginTop: 10, marginBottom: 4 }}>
                Bitrate
              </div>
              <select
                style={{ ...inputStyle, cursor: "pointer" }}
                value={bitrate}
                onChange={(e) => setBitrate(e.target.value as BitratePreset)}
              >
                {(
                  [
                    "very-low",
                    "low",
                    "medium",
                    "high",
                    "very-high",
                  ] as const
                ).map((b) => (
                  <option key={b} value={b}>
                    {BITRATE_LABELS[b]}
                  </option>
                ))}
              </select>
              <div style={{ ...labelStyle, marginTop: 10, marginBottom: 4 }}>
                Workers
              </div>
              <select
                style={{ ...inputStyle, cursor: "pointer" }}
                value={workers}
                onChange={(e) => setWorkers(Number(e.target.value))}
              >
                <option value={1}>1 — in-browser (fastest startup)</option>
                {[2, 3, 4, 5, 6, 7, 8].map((n) => (
                  <option key={n} value={n}>
                    {n} — parallel
                  </option>
                ))}
              </select>
              {workers > 1 && (
                <>
                  <div style={{ ...labelStyle, marginTop: 8 }}>
                    Engine
                  </div>
                  <select
                    style={{ ...inputStyle, cursor: "pointer" }}
                    value={engineOverride}
                    onChange={(e) =>
                      setEngineOverride(
                        e.target.value as "auto" | Engine,
                      )
                    }
                  >
                    <option value="auto">
                      Auto — match this tab ({detectEngine()})
                    </option>
                    <option value="chromium">Chromium</option>
                    <option value="webkit">
                      WebKit (hardware AV1 on M3+)
                    </option>
                  </select>
                  <div
                    style={{
                      marginTop: 4,
                      color: "#c9a94b",
                      fontSize: 11,
                      lineHeight: 1.4,
                    }}
                  >
                    Spawns {workers} headless Playwright{" "}
                    {(engineOverride === "auto"
                      ? detectEngine()
                      : engineOverride) === "webkit"
                      ? "WebKit"
                      : "Chromium"}{" "}
                    processes, concats with ffmpeg. Detected{" "}
                    {navigator.hardwareConcurrency ?? "?"} logical cores —
                    try larger values if CPU is under-utilized.
                  </div>
                </>
              )}
              <div style={{ display: "flex", gap: 6, marginTop: 12 }}>
                <button style={splitBtnStyle} onClick={() => setOpen(false)}>
                  Cancel
                </button>
                <div style={{ flex: 1 }} />
                <button
                  style={{
                    ...addBtnStyle,
                    background: "#a13a2a",
                    padding: "6px 14px",
                  }}
                  onClick={startRender}
                >
                  Start render
                </button>
              </div>
            </>
          )}
          {(state.kind === "preparing" ||
            state.kind === "rendering" ||
            state.kind === "saving" ||
            state.kind === "compressing") && (
            <RenderProgress state={state} onCancel={cancelRender} />
          )}
          {state.kind === "done" && (
            <div>
              <div style={{ color: "#8fd48b", marginBottom: 8 }}>
                ✓ Saved to {state.outputPath}
              </div>
              <RenderStatsRow stats={state.stats} />
              <div style={{ display: "flex", gap: 6, marginTop: 10 }}>
                <button
                  style={splitBtnStyle}
                  onClick={() => {
                    setState({ kind: "idle" });
                    setFilename(defaultRenderName());
                  }}
                >
                  Render another
                </button>
                <div style={{ flex: 1 }} />
                <button
                  style={{ ...addBtnStyle, padding: "6px 14px" }}
                  onClick={() => reveal(state.outputPath)}
                >
                  Reveal in Finder
                </button>
              </div>
            </div>
          )}
          {state.kind === "error" && (
            <div>
              <div
                style={{
                  color: "#ff7a75",
                  marginBottom: 8,
                  whiteSpace: "pre-wrap",
                  maxHeight: 140,
                  overflow: "auto",
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 11,
                }}
              >
                {state.message}
              </div>
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button
                  style={splitBtnStyle}
                  onClick={() => setState({ kind: "idle" })}
                >
                  Dismiss
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const RenderStatsRow: React.FC<{ stats: RenderStats }> = ({ stats }) => {
  const elapsedSec = stats.elapsedMs / 1000;
  const durationSec = stats.totalFrames / stats.fps;
  const realtimeMultiplier = durationSec > 0 ? durationSec / elapsedSec : 0;
  const effectiveFps = elapsedSec > 0 ? stats.totalFrames / elapsedSec : 0;
  const sizeMB = stats.sizeBytes / (1024 * 1024);
  const bitrateMbps =
    durationSec > 0 ? (stats.sizeBytes * 8) / (durationSec * 1_000_000) : 0;

  const rows: Array<[string, string]> = [
    ["Time", `${elapsedSec.toFixed(1)}s`],
    [
      "Speed",
      realtimeMultiplier > 0
        ? `${realtimeMultiplier.toFixed(2)}× realtime · ${effectiveFps.toFixed(0)} fps`
        : "—",
    ],
    [
      "Size",
      sizeMB > 0
        ? `${sizeMB.toFixed(1)} MB · ${bitrateMbps.toFixed(1)} Mbps`
        : "—",
    ],
    [
      "Workers",
      stats.workers === 1 ? "1 (in-browser)" : `${stats.workers} (parallel)`,
    ],
  ];
  return (
    <div
      style={{
        background: "#0b0b0e",
        border: "1px solid #2e2e38",
        borderRadius: 6,
        padding: "8px 10px",
        display: "grid",
        gridTemplateColumns: "auto 1fr",
        columnGap: 10,
        rowGap: 4,
        fontSize: 11,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {rows.map(([label, value]) => (
        <React.Fragment key={label}>
          <div style={{ color: "#70707a" }}>{label}</div>
          <div style={{ color: "#e8e8ea" }}>{value}</div>
        </React.Fragment>
      ))}
    </div>
  );
};

const formatDuration = (sec: number): string => {
  if (!isFinite(sec) || sec < 0) return "—";
  if (sec < 60) return `${sec.toFixed(1)}s`;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec - m * 60);
  return `${m}m ${s}s`;
};

const RenderProgress: React.FC<{
  state: Extract<
    RenderState,
    | { kind: "preparing" }
    | { kind: "rendering" }
    | { kind: "saving" }
    | { kind: "compressing" }
  >;
  onCancel: () => void;
}> = ({ state, onCancel }) => {
  // Tick every 250ms so elapsed time keeps updating between progress events.
  const [, setNow] = React.useState(0);
  React.useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1), 250);
    return () => clearInterval(id);
  }, []);
  const bar = (pct: number, color: string) => (
    <div
      style={{
        height: 8,
        background: "#0b0b0e",
        borderRadius: 4,
        overflow: "hidden",
        border: "1px solid #2e2e38",
      }}
    >
      <div
        style={{
          width: `${Math.max(0, Math.min(1, pct)) * 100}%`,
          height: "100%",
          background: color,
          transition: "width 120ms linear",
        }}
      />
    </div>
  );
  const cancelRow = (
    <div
      style={{
        display: "flex",
        justifyContent: "flex-end",
        marginTop: 10,
      }}
    >
      <button style={splitBtnStyle} onClick={onCancel}>
        Cancel
      </button>
    </div>
  );
  if (state.kind === "preparing") {
    return (
      <div>
        <div style={{ marginBottom: 6 }}>Preparing render…</div>
        {bar(0, "#4a6aa8")}
        {cancelRow}
      </div>
    );
  }
  if (state.kind === "saving") {
    return (
      <div>
        <div style={{ marginBottom: 6 }}>Saving to disk…</div>
        {bar(1, "#4a6aa8")}
      </div>
    );
  }
  if (state.kind === "compressing") {
    const elapsed = (Date.now() - state.startedAt) / 1000;
    const p = state.progress;
    const etaSec = p > 0.01 ? elapsed / p - elapsed : Infinity;
    return (
      <div>
        <div style={{ marginBottom: 6 }}>
          Re-encoding with libsvtav1 ({Math.round(p * 100)}%)
        </div>
        {bar(p, "#4a6aa8")}
        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            marginTop: 6,
            color: "#8b8b94",
            fontSize: 11,
            fontVariantNumeric: "tabular-nums",
          }}
        >
          <span>Elapsed {formatDuration(elapsed)}</span>
          <span>ETA {formatDuration(etaSec)}</span>
        </div>
        {cancelRow}
      </div>
    );
  }
  const p = state.progress;
  const frames = state.renderedFrames;
  const total = state.totalFrames;
  const chunkProgress = state.chunkProgress;
  const elapsedSec = (Date.now() - state.startedAt) / 1000;
  const etaSec = p > 0.01 ? elapsedSec / p - elapsedSec : Infinity;
  const liveFps = elapsedSec > 0.5 ? frames / elapsedSec : 0;
  const videoSec = total / state.fps;
  const realtimeMultiplier =
    elapsedSec > 0.5 && p > 0 ? (videoSec * p) / elapsedSec : 0;
  return (
    <div>
      <div style={{ marginBottom: 6 }}>
        Rendering {frames}
        {total > 0 ? ` / ${total}` : ""} frames ({Math.round(p * 100)}%)
      </div>
      {bar(p, "#a13a2a")}
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          marginTop: 6,
          color: "#8b8b94",
          fontSize: 11,
          fontVariantNumeric: "tabular-nums",
        }}
      >
        <span>Elapsed {formatDuration(elapsedSec)}</span>
        <span>ETA {formatDuration(etaSec)}</span>
        <span>
          {liveFps > 0 ? `${liveFps.toFixed(0)} fps` : "—"}
          {realtimeMultiplier > 0
            ? ` · ${realtimeMultiplier.toFixed(2)}×`
            : ""}
        </span>
      </div>
      {chunkProgress && chunkProgress.length > 1 && (
        <div
          style={{
            marginTop: 10,
            display: "flex",
            flexDirection: "column",
            gap: 4,
          }}
        >
          {chunkProgress.map((cp, i) => (
            <div
              key={i}
              style={{ display: "flex", alignItems: "center", gap: 8 }}
            >
              <span
                style={{
                  width: 48,
                  fontSize: 10,
                  color: "#8b8b94",
                  flex: "0 0 auto",
                }}
              >
                Chunk {i + 1}
              </span>
              <div style={{ flex: 1 }}>{bar(cp, "#6a9ad8")}</div>
              <span
                style={{
                  width: 36,
                  textAlign: "right",
                  fontSize: 10,
                  color: "#8b8b94",
                  flex: "0 0 auto",
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                {Math.round(cp * 100)}%
              </span>
            </div>
          ))}
        </div>
      )}
      {cancelRow}
    </div>
  );
};

const IconButton: React.FC<{
  disabled?: boolean;
  onClick: () => void;
  title?: string;
  children: React.ReactNode;
}> = ({ disabled, onClick, title, children }) => (
  <button
    onClick={onClick}
    disabled={disabled}
    title={title}
    style={{
      background: "transparent",
      color: disabled ? "#555" : "#e8e8ea",
      border: "1px solid #2e2e34",
      padding: "6px 10px",
      borderRadius: 6,
      cursor: disabled ? "default" : "pointer",
      fontSize: 12,
    }}
  >
    {children}
  </button>
);

const SectionHeader: React.FC<{
  title: string;
  action?: React.ReactNode;
}> = ({ title, action }) => (
  <div
    style={{
      display: "flex",
      alignItems: "center",
      padding: "12px 14px 6px",
      gap: 8,
      position: "sticky",
      top: 0,
      background: "#101014",
      zIndex: 1,
    }}
  >
    <div
      style={{
        fontSize: 12,
        fontWeight: 700,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        color: "#a0a0aa",
      }}
    >
      {title}
    </div>
    <div style={{ marginLeft: "auto" }}>{action}</div>
  </div>
);

const TrackGroup: React.FC<{
  name: string;
  color: string;
  onRename: (name: string) => void;
  onDelete: () => void;
  onAddItem: () => void;
  addLabel: string;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onAssetDrop?: (payload: AssetDragPayload) => void;
  children: React.ReactNode;
}> = ({
  name,
  color,
  onRename,
  onDelete,
  onAddItem,
  addLabel,
  canMoveUp,
  canMoveDown,
  onMoveUp,
  onMoveDown,
  onAssetDrop,
  children,
}) => {
  const [over, setOver] = React.useState(false);
  return (
  <div
    onDragEnter={(e) => {
      if (!onAssetDrop) return;
      if (!e.dataTransfer.types.includes(ASSET_MIME)) return;
      e.preventDefault();
      setOver(true);
    }}
    onDragOver={(e) => {
      if (!onAssetDrop) return;
      if (!e.dataTransfer.types.includes(ASSET_MIME)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
    }}
    onDragLeave={(e) => {
      if (!onAssetDrop) return;
      if (
        (e.relatedTarget as HTMLElement | null)?.closest?.("[data-track-group]")
      ) {
        // still inside
        return;
      }
      setOver(false);
    }}
    onDrop={(e) => {
      if (!onAssetDrop) return;
      const raw = e.dataTransfer.getData(ASSET_MIME);
      if (!raw) return;
      e.preventDefault();
      setOver(false);
      try {
        const payload = JSON.parse(raw) as AssetDragPayload;
        onAssetDrop(payload);
      } catch {
        // ignore malformed payload
      }
    }}
    data-track-group
    style={{
      padding: "4px 14px 12px",
      borderBottom: "1px solid #1e1e24",
      background: over ? "rgba(30, 75, 135, 0.25)" : undefined,
      outline: over ? "1px dashed #6aa0ff" : undefined,
      outlineOffset: -2,
    }}
  >
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 6,
        marginBottom: 8,
      }}
    >
      <span
        style={{
          width: 10,
          height: 10,
          borderRadius: 3,
          background: color,
          flex: "0 0 auto",
        }}
      />
      <input
        value={name}
        onChange={(e) => onRename(e.target.value)}
        style={{
          background: "transparent",
          color: "#e8e8ea",
          border: "1px solid transparent",
          padding: "3px 6px",
          borderRadius: 4,
          fontSize: 13,
          fontWeight: 600,
          flex: 1,
          minWidth: 0,
          fontFamily: "inherit",
        }}
        onFocus={(e) => {
          e.currentTarget.style.border = "1px solid #2e2e34";
        }}
        onBlur={(e) => {
          e.currentTarget.style.border = "1px solid transparent";
        }}
      />
      <button
        onClick={onMoveUp}
        disabled={!canMoveUp}
        style={moveBtnStyle(!canMoveUp)}
        title="Move up (higher z-order)"
      >
        ↑
      </button>
      <button
        onClick={onMoveDown}
        disabled={!canMoveDown}
        style={moveBtnStyle(!canMoveDown)}
        title="Move down (lower z-order)"
      >
        ↓
      </button>
      <button onClick={onAddItem} style={addBtnStyle}>
        {addLabel}
      </button>
      <button
        onClick={onDelete}
        style={{ ...deleteBtnStyle, fontSize: 14, padding: "2px 8px" }}
        title="Delete track (must be empty)"
      >
        ×
      </button>
    </div>
    <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      {children}
    </div>
  </div>
  );
};

const EmptyHint: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <div style={{ color: "#666", fontSize: 12, padding: "4px 16px" }}>
    {children}
  </div>
);

const cardStyle = (selected: boolean): React.CSSProperties => ({
  background: selected ? "#20212a" : "#1a1a20",
  border: `1px solid ${selected ? "#4a6aa8" : "#26262e"}`,
  borderRadius: 8,
  padding: 10,
  display: "flex",
  flexDirection: "column",
  gap: 6,
  cursor: "pointer",
});

const inputStyle: React.CSSProperties = {
  background: "#0b0b0e",
  border: "1px solid #2e2e38",
  color: "#e8e8ea",
  padding: "5px 8px",
  borderRadius: 5,
  fontSize: 12,
  width: "100%",
  boxSizing: "border-box",
  fontFamily: "inherit",
};

const labelStyle: React.CSSProperties = {
  fontSize: 10,
  color: "#70707a",
  textTransform: "uppercase",
  letterSpacing: 0.5,
};

const addBtnStyle: React.CSSProperties = {
  background: "#1e4b87",
  color: "white",
  border: "none",
  padding: "4px 9px",
  borderRadius: 6,
  cursor: "pointer",
  fontSize: 11,
  fontWeight: 500,
};

const deleteBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#d35a56",
  border: "1px solid #4a2826",
  padding: "4px 8px",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 11,
};

const moveBtnStyle = (disabled: boolean): React.CSSProperties => ({
  background: "transparent",
  color: disabled ? "#3a3a42" : "#e8e8ea",
  border: "1px solid #2e2e34",
  padding: "2px 6px",
  borderRadius: 4,
  cursor: disabled ? "default" : "pointer",
  fontSize: 11,
  lineHeight: 1,
});

const splitBtnStyle: React.CSSProperties = {
  background: "transparent",
  color: "#e8e8ea",
  border: "1px solid #2e2e38",
  padding: "4px 8px",
  borderRadius: 5,
  cursor: "pointer",
  fontSize: 11,
};

const ClipCard: React.FC<{
  clip: Clip;
  cardId: string;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<Clip>, coalesce?: string) => void;
  onRenameSrc: (from: string, to: string) => Promise<string>;
  onRenameError: (msg: string) => void;
}> = ({
  clip,
  cardId,
  selected,
  onSelect,
  onChange,
  onRenameSrc,
  onRenameError,
}) => {
  const [srcDraft, setSrcDraft] = React.useState(clip.src);
  const [renaming, setRenaming] = React.useState(false);
  React.useEffect(() => {
    setSrcDraft(clip.src);
  }, [clip.src]);

  const commitSrc = async () => {
    const next = srcDraft.trim();
    if (!next || next === clip.src) {
      setSrcDraft(clip.src);
      return;
    }
    setRenaming(true);
    try {
      const finalName = await onRenameSrc(clip.src, next);
      setSrcDraft(finalName);
    } catch (err) {
      onRenameError(`Rename failed: ${(err as Error).message}`);
      setSrcDraft(clip.src);
    } finally {
      setRenaming(false);
    }
  };

  return (
  <div data-card-id={cardId} style={cardStyle(selected)} onClick={onSelect}>
    <div onClick={(e) => e.stopPropagation()}>
      <div style={labelStyle}>Source (rename file)</div>
      <input
        style={{ ...inputStyle, opacity: renaming ? 0.6 : 1 }}
        value={srcDraft}
        disabled={renaming}
        onChange={(e) => setSrcDraft(e.target.value)}
        onBlur={commitSrc}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            (e.target as HTMLInputElement).blur();
          } else if (e.key === "Escape") {
            setSrcDraft(clip.src);
            (e.target as HTMLInputElement).blur();
          }
        }}
        title="Edit and press Enter or tab away to rename the file on disk and all clips using it"
      />
    </div>
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 6 }}
    >
      <div>
        <div style={labelStyle}>Timeline (s)</div>
        <input
          type="number"
          step="0.1"
          style={inputStyle}
          value={clip.from}
          onChange={(e) => onChange({ from: Number(e.target.value) }, "from")}
        />
      </div>
      <div>
        <div style={labelStyle}>In (s)</div>
        <input
          type="number"
          step="0.1"
          style={inputStyle}
          value={clip.startFrom}
          onChange={(e) =>
            onChange({ startFrom: Number(e.target.value) }, "startFrom")
          }
        />
      </div>
      <div>
        <div style={labelStyle}>Out (s)</div>
        <input
          type="number"
          step="0.1"
          style={inputStyle}
          value={clip.endAt}
          onChange={(e) => onChange({ endAt: Number(e.target.value) }, "endAt")}
        />
      </div>
    </div>
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}
    >
      <div>
        <div style={labelStyle}>Fade in (s)</div>
        <input
          type="number"
          step="0.1"
          min="0"
          style={inputStyle}
          value={clip.fadeIn ?? 0}
          onChange={(e) =>
            onChange({ fadeIn: Math.max(0, Number(e.target.value)) }, "fadeIn")
          }
        />
      </div>
      <div>
        <div style={labelStyle}>Fade out (s)</div>
        <input
          type="number"
          step="0.1"
          min="0"
          style={inputStyle}
          value={clip.fadeOut ?? 0}
          onChange={(e) =>
            onChange(
              { fadeOut: Math.max(0, Number(e.target.value)) },
              "fadeOut",
            )
          }
        />
      </div>
    </div>
  </div>
  );
};

const SegmentCard: React.FC<{
  segment: TextSegment;
  cardId: string;
  selected: boolean;
  onSelect: () => void;
  onChange: (patch: Partial<TextSegment>, coalesce?: string) => void;
}> = ({ segment, cardId, selected, onSelect, onChange }) => (
  <div data-card-id={cardId} style={cardStyle(selected)} onClick={onSelect}>
    <div onClick={(e) => e.stopPropagation()}>
      <div style={labelStyle}>Text</div>
      <textarea
        style={{ ...inputStyle, minHeight: 54, resize: "vertical" }}
        value={segment.text}
        onChange={(e) => onChange({ text: e.target.value }, "text")}
      />
    </div>
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}
    >
      <div>
        <div style={labelStyle}>From (s)</div>
        <input
          type="number"
          step="0.1"
          style={inputStyle}
          value={segment.from}
          onChange={(e) => onChange({ from: Number(e.target.value) }, "from")}
        />
      </div>
      <div>
        <div style={labelStyle}>Duration (s)</div>
        <input
          type="number"
          step="0.1"
          style={inputStyle}
          value={segment.duration}
          onChange={(e) =>
            onChange({ duration: Number(e.target.value) }, "duration")
          }
        />
      </div>
    </div>
    <div
      onClick={(e) => e.stopPropagation()}
      style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 6 }}
    >
      <div>
        <div style={labelStyle}>Fade in (s)</div>
        <input
          type="number"
          step="0.1"
          min="0"
          style={inputStyle}
          value={segment.fadeIn ?? ""}
          placeholder="default"
          onChange={(e) => {
            const v = e.target.value;
            onChange(
              { fadeIn: v === "" ? undefined : Math.max(0, Number(v)) },
              "fadeIn",
            );
          }}
        />
      </div>
      <div>
        <div style={labelStyle}>Fade out (s)</div>
        <input
          type="number"
          step="0.1"
          min="0"
          style={inputStyle}
          value={segment.fadeOut ?? ""}
          placeholder="default"
          onChange={(e) => {
            const v = e.target.value;
            onChange(
              { fadeOut: v === "" ? undefined : Math.max(0, Number(v)) },
              "fadeOut",
            );
          }}
        />
      </div>
    </div>
  </div>
);
