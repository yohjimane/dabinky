import React, { useCallback, useRef, useState } from "react";
import type {
  Clip,
  MyCompositionProps,
  TextSegment,
} from "@src/Composition";
import { ASSET_MIME, AssetDragPayload } from "./MediaPool";

type DragMode = "move" | "left" | "right";

const TRACK_HEIGHT = 44;
const TRACK_GAP = 4;
const RULER_HEIGHT = 28;
const HANDLE_WIDTH = 6;
const MIN_DURATION = 0.1;
const LABEL_WIDTH = 90;

export type Selection =
  | { kind: "clip"; trackIndex: number; itemIndex: number }
  | { kind: "segment"; trackIndex: number; itemIndex: number }
  | null;

export const Timeline: React.FC<{
  state: MyCompositionProps;
  update: (
    updater: (prev: MyCompositionProps) => MyCompositionProps,
    coalesceKey?: string,
  ) => void;
  duration: number;
  currentSeconds: number;
  onSeek: (seconds: number) => void;
  selected: Selection;
  onSelect: (sel: Selection) => void;
  onDropAsset: (
    trackIndex: number,
    atSeconds: number,
    src: string,
    durationSec: number,
  ) => void;
  onSplitSelectedClip: () => void;
}> = ({
  state,
  update,
  duration,
  currentSeconds,
  onSeek,
  selected,
  onSelect,
  onDropAsset,
  onSplitSelectedClip,
}) => {
  const [pxPerSec, setPxPerSec] = useState(24);
  const [dragOverTrack, setDragOverTrack] = useState<number | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);

  type SnapExclude = {
    kind: "clip" | "segment";
    trackIndex: number;
    itemIndex: number;
  };
  // Given one or more candidate values (e.g., both edges of a clip being moved),
  // find the closest snap target within threshold and return the delta that
  // shifts all candidates by the same amount to land on it. Sets the snap line.
  const snapMany = useCallback(
    (candidates: number[], exclude: SnapExclude | null): number => {
      const threshold = 8 / pxPerSec;
      const targets: number[] = [0];
      // Only include playhead as a snap target when snapping clip/segment edits,
      // not when the playhead itself is being dragged.
      if (exclude !== null) targets.push(currentSeconds);
      state.videoTracks.forEach((t, ti) =>
        t.clips.forEach((c, ci) => {
          if (
            exclude?.kind === "clip" &&
            exclude.trackIndex === ti &&
            exclude.itemIndex === ci
          )
            return;
          targets.push(c.from);
          targets.push(c.from + (c.endAt - c.startFrom));
        }),
      );
      state.textTracks.forEach((t, ti) =>
        t.segments.forEach((s, si) => {
          if (
            exclude?.kind === "segment" &&
            exclude.trackIndex === ti &&
            exclude.itemIndex === si
          )
            return;
          targets.push(s.from);
          targets.push(s.from + s.duration);
        }),
      );
      let bestTarget: number | null = null;
      let bestCandidate: number | null = null;
      let bestDist = threshold;
      for (const c of candidates) {
        for (const t of targets) {
          const d = Math.abs(c - t);
          if (d <= bestDist) {
            bestDist = d;
            bestTarget = t;
            bestCandidate = c;
          }
        }
      }
      setSnapLine(bestTarget);
      return bestTarget !== null && bestCandidate !== null
        ? bestTarget - bestCandidate
        : 0;
    },
    [state, currentSeconds, pxPerSec],
  );
  const snap = useCallback(
    (value: number, exclude: SnapExclude | null): number =>
      value + snapMany([value], exclude),
    [snapMany],
  );
  const clearSnap = useCallback(() => setSnapLine(null), []);
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentWidth = Math.max(800, Math.ceil(duration * pxPerSec) + 80);

  // UI rows: text tracks on top (reverse order so highest index is at UI-top),
  // then video tracks below (reverse order so highest index is at UI-top within the group).
  type Row =
    | { kind: "text"; trackIndex: number }
    | { kind: "video"; trackIndex: number };
  const rows: Row[] = [
    ...state.textTracks
      .map((_, i) => i)
      .reverse()
      .map<Row>((i) => ({ kind: "text", trackIndex: i })),
    ...state.videoTracks
      .map((_, i) => i)
      .reverse()
      .map<Row>((i) => ({ kind: "video", trackIndex: i })),
  ];

  const timelineHeight =
    RULER_HEIGHT + rows.length * (TRACK_HEIGHT + TRACK_GAP) + 8;

  const contentRef = useRef<HTMLDivElement>(null);

  const startScrub = useCallback(
    (e: React.PointerEvent) => {
      e.preventDefault();
      const content = contentRef.current;
      if (!content) return;
      const rect = content.getBoundingClientRect();
      const target = e.currentTarget as HTMLElement;
      target.setPointerCapture(e.pointerId);
      const seekAt = (clientX: number) => {
        const raw = Math.max(0, (clientX - rect.left) / pxPerSec);
        const snapped = snap(raw, null);
        onSeek(snapped);
      };
      seekAt(e.clientX);
      const move = (ev: PointerEvent) => seekAt(ev.clientX);
      const up = () => {
        target.removeEventListener("pointermove", move);
        target.removeEventListener("pointerup", up);
        target.removeEventListener("pointercancel", up);
        clearSnap();
      };
      target.addEventListener("pointermove", move);
      target.addEventListener("pointerup", up);
      target.addEventListener("pointercancel", up);
    },
    [pxPerSec, snap, clearSnap, onSeek],
  );

  return (
    <div
      style={{
        background: "#0c0c10",
        borderTop: "1px solid #1e1e24",
        display: "flex",
        flexDirection: "column",
        userSelect: "none",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "6px 12px",
          borderBottom: "1px solid #1e1e24",
          fontSize: 12,
          color: "#a0a0aa",
        }}
      >
        <strong style={{ color: "#e8e8ea" }}>Timeline</strong>
        <BladeButton
          enabled={(() => {
            if (selected?.kind !== "clip") return false;
            const track = state.videoTracks[selected.trackIndex];
            const clip = track?.clips[selected.itemIndex];
            if (!clip) return false;
            const endT = clip.from + (clip.endAt - clip.startFrom);
            return (
              currentSeconds > clip.from + 0.05 &&
              currentSeconds < endT - 0.05
            );
          })()}
          onClick={onSplitSelectedClip}
        />
        <div style={{ flex: 1 }} />
        <span>Zoom</span>
        <input
          type="range"
          min={6}
          max={120}
          value={pxPerSec}
          onChange={(e) => setPxPerSec(Number(e.target.value))}
          style={{ width: 140 }}
        />
        <span style={{ width: 56, textAlign: "right" }}>
          {pxPerSec}px / s
        </span>
      </div>
      <div style={{ display: "flex", minHeight: 0 }}>
        <div
          style={{
            width: LABEL_WIDTH,
            flex: "0 0 auto",
            background: "#0a0a0e",
            borderRight: "1px solid #1e1e24",
          }}
        >
          <div style={{ height: RULER_HEIGHT, borderBottom: "1px solid #1e1e24" }} />
          {rows.map((row, i) => {
            const track =
              row.kind === "text"
                ? state.textTracks[row.trackIndex]
                : state.videoTracks[row.trackIndex];
            const color = row.kind === "text" ? "#c48556" : "#6a9ad8";
            return (
              <div
                key={`${row.kind}-${row.trackIndex}`}
                style={{
                  height: TRACK_HEIGHT,
                  marginTop: i === 0 ? 4 : TRACK_GAP,
                  display: "flex",
                  alignItems: "center",
                  padding: "0 8px",
                  fontSize: 11,
                  color,
                  fontWeight: 600,
                  gap: 6,
                }}
              >
                <span
                  style={{
                    width: 12,
                    height: 12,
                    borderRadius: 3,
                    background: color,
                    opacity: 0.6,
                    flex: "0 0 auto",
                  }}
                />
                <span
                  style={{
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                  title={track?.name}
                >
                  {track?.name ?? "(missing)"}
                </span>
              </div>
            );
          })}
        </div>
        <div
          ref={scrollRef}
          style={{ overflowX: "auto", overflowY: "hidden", flex: 1 }}
        >
          <div
            ref={contentRef}
            style={{
              position: "relative",
              width: contentWidth,
              height: timelineHeight,
            }}
            onClick={(e) => {
              if (e.target === e.currentTarget) onSelect(null);
            }}
          >
            <Ruler
              duration={duration}
              pxPerSec={pxPerSec}
              width={contentWidth}
              onPointerDown={startScrub}
            />
            {rows.map((row, i) => {
              const top = RULER_HEIGHT + 4 + i * (TRACK_HEIGHT + TRACK_GAP);
              if (row.kind === "text") {
                const track = state.textTracks[row.trackIndex];
                if (!track) return null;
                return (
                  <TrackRow key={`text-${row.trackIndex}`} top={top}>
                    {track.segments.map((seg, si) => (
                      <SegmentBlock
                        key={`seg-${row.trackIndex}-${si}`}
                        segment={seg}
                        trackIndex={row.trackIndex}
                        itemIndex={si}
                        pxPerSec={pxPerSec}
                        update={update}
                        selected={
                          selected?.kind === "segment" &&
                          selected.trackIndex === row.trackIndex &&
                          selected.itemIndex === si
                        }
                        onSelect={() =>
                          onSelect({
                            kind: "segment",
                            trackIndex: row.trackIndex,
                            itemIndex: si,
                          })
                        }
                        onSeek={onSeek}
                        snapMany={snapMany}
                        clearSnap={clearSnap}
                      />
                    ))}
                  </TrackRow>
                );
              }
              const track = state.videoTracks[row.trackIndex];
              if (!track) return null;
              return (
                <TrackRow
                  key={`video-${row.trackIndex}`}
                  top={top}
                  dragOver={dragOverTrack === row.trackIndex}
                  onDragEnter={(e) => {
                    if (!e.dataTransfer.types.includes(ASSET_MIME)) return;
                    e.preventDefault();
                    setDragOverTrack(row.trackIndex);
                  }}
                  onDragOver={(e) => {
                    if (!e.dataTransfer.types.includes(ASSET_MIME)) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "copy";
                  }}
                  onDragLeave={() => {
                    setDragOverTrack((cur) =>
                      cur === row.trackIndex ? null : cur,
                    );
                  }}
                  onDrop={(e) => {
                    const raw = e.dataTransfer.getData(ASSET_MIME);
                    if (!raw) return;
                    e.preventDefault();
                    setDragOverTrack(null);
                    const rect = (
                      e.currentTarget as HTMLElement
                    ).getBoundingClientRect();
                    const atSec = Math.max(
                      0,
                      (e.clientX - rect.left) / pxPerSec,
                    );
                    try {
                      const payload = JSON.parse(raw) as AssetDragPayload;
                      onDropAsset(
                        row.trackIndex,
                        atSec,
                        payload.src,
                        payload.duration,
                      );
                    } catch {
                      // ignore malformed payload
                    }
                  }}
                >
                  {track.clips.map((clip, ci) => (
                    <ClipBlock
                      key={`clip-${row.trackIndex}-${ci}`}
                      clip={clip}
                      trackIndex={row.trackIndex}
                      itemIndex={ci}
                      pxPerSec={pxPerSec}
                      update={update}
                      selected={
                        selected?.kind === "clip" &&
                        selected.trackIndex === row.trackIndex &&
                        selected.itemIndex === ci
                      }
                      onSelect={() =>
                        onSelect({
                          kind: "clip",
                          trackIndex: row.trackIndex,
                          itemIndex: ci,
                        })
                      }
                      onSeek={onSeek}
                      snapMany={snapMany}
                      clearSnap={clearSnap}
                    />
                  ))}
                </TrackRow>
              );
            })}
            {snapLine !== null && (
              <div
                style={{
                  position: "absolute",
                  left: snapLine * pxPerSec,
                  top: 0,
                  width: 1,
                  height: timelineHeight,
                  background: "#f2b705",
                  boxShadow: "0 0 4px rgba(242, 183, 5, 0.6)",
                  pointerEvents: "none",
                  zIndex: 2,
                }}
              />
            )}
            <Playhead
              seconds={currentSeconds}
              pxPerSec={pxPerSec}
              height={timelineHeight}
              onScrubPointerDown={startScrub}
            />
          </div>
        </div>
      </div>
    </div>
  );
};

const BladeButton: React.FC<{
  enabled: boolean;
  onClick: () => void;
}> = ({ enabled, onClick }) => (
  <button
    onClick={onClick}
    disabled={!enabled}
    title={
      enabled
        ? "Split selected clip at playhead (B)"
        : "Select a clip and place the playhead inside it"
    }
    style={{
      display: "inline-flex",
      alignItems: "center",
      gap: 4,
      background: enabled ? "#1e4b87" : "transparent",
      color: enabled ? "white" : "#4a4a52",
      border: `1px solid ${enabled ? "#3a6fb5" : "#2e2e34"}`,
      padding: "4px 9px",
      borderRadius: 6,
      cursor: enabled ? "pointer" : "not-allowed",
      fontSize: 12,
      fontWeight: 500,
      lineHeight: 1,
    }}
  >
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="6" cy="6" r="3" />
      <circle cx="6" cy="18" r="3" />
      <line x1="20" y1="4" x2="8.12" y2="15.88" />
      <line x1="14.47" y1="14.48" x2="20" y2="20" />
      <line x1="8.12" y1="8.12" x2="12" y2="12" />
    </svg>
    Blade
  </button>
);

const Ruler: React.FC<{
  duration: number;
  pxPerSec: number;
  width: number;
  onPointerDown: (e: React.PointerEvent) => void;
}> = ({ duration, pxPerSec, width, onPointerDown }) => {
  const majorEvery = pxPerSec < 12 ? 10 : pxPerSec < 30 ? 5 : 1;
  const ticks: { s: number; major: boolean }[] = [];
  for (let s = 0; s <= duration + majorEvery; s += 1) {
    ticks.push({ s, major: s % majorEvery === 0 });
  }
  return (
    <div
      onPointerDown={onPointerDown}
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        width,
        height: RULER_HEIGHT,
        background: "#121218",
        borderBottom: "1px solid #1e1e24",
        cursor: "pointer",
      }}
    >
      {ticks.map((t) => (
        <div
          key={t.s}
          style={{
            position: "absolute",
            left: t.s * pxPerSec,
            top: t.major ? 4 : 14,
            bottom: 0,
            width: 1,
            background: t.major ? "#4a4a54" : "#2a2a32",
          }}
        >
          {t.major && (
            <span
              style={{
                position: "absolute",
                left: 3,
                top: -2,
                fontSize: 10,
                color: "#8b8b94",
                whiteSpace: "nowrap",
              }}
            >
              {t.s}s
            </span>
          )}
        </div>
      ))}
    </div>
  );
};

const TrackRow: React.FC<{
  top: number;
  dragOver?: boolean;
  onDragEnter?: (e: React.DragEvent) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDragLeave?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent) => void;
  children: React.ReactNode;
}> = ({
  top,
  dragOver,
  onDragEnter,
  onDragOver,
  onDragLeave,
  onDrop,
  children,
}) => (
  <>
    <div
      style={{
        position: "absolute",
        top,
        left: 0,
        right: 0,
        height: TRACK_HEIGHT,
        background: dragOver ? "rgba(30, 75, 135, 0.35)" : "#0a0a0e",
        border: `1px ${dragOver ? "dashed #6aa0ff" : "solid #1a1a22"}`,
        borderRadius: 3,
      }}
    />
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        position: "absolute",
        top,
        left: 0,
        right: 0,
        height: TRACK_HEIGHT,
      }}
    >
      {children}
    </div>
  </>
);

const Playhead: React.FC<{
  seconds: number;
  pxPerSec: number;
  height: number;
  onScrubPointerDown: (e: React.PointerEvent) => void;
}> = ({ seconds, pxPerSec, height, onScrubPointerDown }) => (
  <div
    style={{
      position: "absolute",
      left: seconds * pxPerSec,
      top: 0,
      width: 1,
      height,
      background: "#ff4b4b",
      pointerEvents: "none",
      zIndex: 3,
    }}
  >
    <div
      onPointerDown={onScrubPointerDown}
      title="Drag to scrub"
      style={{
        position: "absolute",
        top: -4,
        left: -9,
        width: 19,
        height: 14,
        background: "#ff4b4b",
        clipPath: "polygon(0 0, 100% 0, 50% 100%)",
        cursor: "ew-resize",
        pointerEvents: "auto",
      }}
    />
  </div>
);

const startDrag = (
  e: React.PointerEvent,
  mode: DragMode,
  pxPerSec: number,
  onDelta: (dSec: number) => void,
  onEnd?: () => void,
) => {
  e.preventDefault();
  e.stopPropagation();
  const startX = e.clientX;
  const target = e.currentTarget as HTMLElement;
  target.setPointerCapture(e.pointerId);
  const move = (ev: PointerEvent) => {
    onDelta((ev.clientX - startX) / pxPerSec);
  };
  const up = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", up);
    target.removeEventListener("pointercancel", up);
    onEnd?.();
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", up);
  target.addEventListener("pointercancel", up);
};

const ClipBlock: React.FC<{
  clip: Clip;
  trackIndex: number;
  itemIndex: number;
  pxPerSec: number;
  update: (
    updater: (prev: MyCompositionProps) => MyCompositionProps,
    coalesceKey?: string,
  ) => void;
  selected: boolean;
  onSelect: () => void;
  onSeek: (s: number) => void;
  snapMany: (
    candidates: number[],
    exclude: { kind: "clip" | "segment"; trackIndex: number; itemIndex: number },
  ) => number;
  clearSnap: () => void;
}> = ({
  clip,
  trackIndex,
  itemIndex,
  pxPerSec,
  update,
  selected,
  onSelect,
  onSeek,
  snapMany,
  clearSnap,
}) => {
  const duration = clip.endAt - clip.startFrom;
  const left = clip.from * pxPerSec;
  const width = Math.max(6, duration * pxPerSec);
  const coalesce = (mode: string) =>
    `drag-clip-${trackIndex}-${itemIndex}-${mode}`;
  const exclude = {
    kind: "clip" as const,
    trackIndex,
    itemIndex,
  };

  const beginDrag = (e: React.PointerEvent, mode: DragMode) => {
    const origin = { ...clip };
    const originDuration = origin.endAt - origin.startFrom;
    startDrag(
      e,
      mode,
      pxPerSec,
      (dSec) => {
        let effective = dSec;
        if (mode === "left") {
          effective = dSec + snapMany([origin.from + dSec], exclude);
        } else if (mode === "right") {
          const originRight = origin.from + originDuration;
          effective = dSec + snapMany([originRight + dSec], exclude);
        } else {
          const newLeft = origin.from + dSec;
          const newRight = newLeft + originDuration;
          effective = dSec + snapMany([newLeft, newRight], exclude);
        }
        update((prev) => {
          const tracks = prev.videoTracks.slice();
          const track = tracks[trackIndex];
          if (!track) return prev;
          const clips = track.clips.slice();
          const cur = clips[itemIndex];
          if (!cur) return prev;
          if (mode === "move") {
            clips[itemIndex] = {
              ...cur,
              from: Math.max(0, origin.from + effective),
            };
          } else if (mode === "left") {
            const newStartFrom = Math.max(
              0,
              Math.min(origin.endAt - MIN_DURATION, origin.startFrom + effective),
            );
            const delta = newStartFrom - origin.startFrom;
            clips[itemIndex] = {
              ...cur,
              startFrom: newStartFrom,
              from: Math.max(0, origin.from + delta),
            };
          } else {
            const newEndAt = Math.max(
              origin.startFrom + MIN_DURATION,
              origin.endAt + effective,
            );
            clips[itemIndex] = { ...cur, endAt: newEndAt };
          }
          tracks[trackIndex] = { ...track, clips };
          return { ...prev, videoTracks: tracks };
        }, coalesce(mode));
      },
      clearSnap,
    );
  };

  return (
    <Block
      left={left}
      width={width}
      color="#2a4d7a"
      selected={selected}
      label={clip.src}
      sublabel={`${fmt(clip.startFrom)} – ${fmt(clip.endAt)}`}
      onSelect={() => {
        if (!selected) onSeek(clip.from);
        onSelect();
      }}
      onMoveDown={(e) => beginDrag(e, "move")}
      onLeftDown={(e) => beginDrag(e, "left")}
      onRightDown={(e) => beginDrag(e, "right")}
    />
  );
};

const SegmentBlock: React.FC<{
  segment: TextSegment;
  trackIndex: number;
  itemIndex: number;
  pxPerSec: number;
  update: (
    updater: (prev: MyCompositionProps) => MyCompositionProps,
    coalesceKey?: string,
  ) => void;
  selected: boolean;
  onSelect: () => void;
  onSeek: (s: number) => void;
  snapMany: (
    candidates: number[],
    exclude: { kind: "clip" | "segment"; trackIndex: number; itemIndex: number },
  ) => number;
  clearSnap: () => void;
}> = ({
  segment,
  trackIndex,
  itemIndex,
  pxPerSec,
  update,
  selected,
  onSelect,
  onSeek,
  snapMany,
  clearSnap,
}) => {
  const left = segment.from * pxPerSec;
  const width = Math.max(6, segment.duration * pxPerSec);
  const coalesce = (mode: string) =>
    `drag-seg-${trackIndex}-${itemIndex}-${mode}`;
  const exclude = {
    kind: "segment" as const,
    trackIndex,
    itemIndex,
  };

  const beginDrag = (e: React.PointerEvent, mode: DragMode) => {
    const origin = { ...segment };
    startDrag(
      e,
      mode,
      pxPerSec,
      (dSec) => {
        let effective = dSec;
        if (mode === "left") {
          effective = dSec + snapMany([origin.from + dSec], exclude);
        } else if (mode === "right") {
          const originRight = origin.from + origin.duration;
          effective = dSec + snapMany([originRight + dSec], exclude);
        } else {
          const newLeft = origin.from + dSec;
          const newRight = newLeft + origin.duration;
          effective = dSec + snapMany([newLeft, newRight], exclude);
        }
        update((prev) => {
          const tracks = prev.textTracks.slice();
          const track = tracks[trackIndex];
          if (!track) return prev;
          const segs = track.segments.slice();
          const cur = segs[itemIndex];
          if (!cur) return prev;
          if (mode === "move") {
            segs[itemIndex] = {
              ...cur,
              from: Math.max(0, origin.from + effective),
            };
          } else if (mode === "left") {
            const newFrom = Math.max(
              0,
              Math.min(
                origin.from + origin.duration - MIN_DURATION,
                origin.from + effective,
              ),
            );
            const delta = newFrom - origin.from;
            segs[itemIndex] = {
              ...cur,
              from: newFrom,
              duration: Math.max(MIN_DURATION, origin.duration - delta),
            };
          } else {
            segs[itemIndex] = {
              ...cur,
              duration: Math.max(MIN_DURATION, origin.duration + effective),
            };
          }
          tracks[trackIndex] = { ...track, segments: segs };
          return { ...prev, textTracks: tracks };
        }, coalesce(mode));
      },
      clearSnap,
    );
  };

  return (
    <Block
      left={left}
      width={width}
      color="#7a4d2a"
      selected={selected}
      label={segment.text || "(empty)"}
      sublabel={`${fmt(segment.from)} · ${fmt(segment.duration)}s`}
      onSelect={() => {
        if (!selected) onSeek(segment.from);
        onSelect();
      }}
      onMoveDown={(e) => beginDrag(e, "move")}
      onLeftDown={(e) => beginDrag(e, "left")}
      onRightDown={(e) => beginDrag(e, "right")}
    />
  );
};

const Block: React.FC<{
  left: number;
  width: number;
  color: string;
  selected: boolean;
  label: string;
  sublabel: string;
  onSelect: () => void;
  onMoveDown: (e: React.PointerEvent) => void;
  onLeftDown: (e: React.PointerEvent) => void;
  onRightDown: (e: React.PointerEvent) => void;
}> = ({
  left,
  width,
  color,
  selected,
  label,
  sublabel,
  onSelect,
  onMoveDown,
  onLeftDown,
  onRightDown,
}) => (
  <div
    onPointerDown={(e) => {
      onSelect();
      onMoveDown(e);
    }}
    style={{
      position: "absolute",
      top: 3,
      left,
      width,
      height: TRACK_HEIGHT - 6,
      background: color,
      border: `1px solid ${selected ? "#ffffff" : "rgba(255,255,255,0.15)"}`,
      borderRadius: 5,
      cursor: "grab",
      overflow: "hidden",
      boxShadow: selected ? "0 0 0 2px rgba(255,255,255,0.3)" : undefined,
    }}
  >
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
        onLeftDown(e);
      }}
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        bottom: 0,
        width: HANDLE_WIDTH,
        background: "rgba(255,255,255,0.25)",
        cursor: "ew-resize",
      }}
    />
    <div
      onPointerDown={(e) => {
        e.stopPropagation();
        onSelect();
        onRightDown(e);
      }}
      style={{
        position: "absolute",
        right: 0,
        top: 0,
        bottom: 0,
        width: HANDLE_WIDTH,
        background: "rgba(255,255,255,0.25)",
        cursor: "ew-resize",
      }}
    />
    <div
      style={{
        padding: `2px ${HANDLE_WIDTH + 4}px`,
        color: "white",
        fontSize: 11,
        lineHeight: 1.2,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "ellipsis",
        pointerEvents: "none",
      }}
    >
      <div
        style={{
          fontWeight: 600,
          overflow: "hidden",
          textOverflow: "ellipsis",
        }}
      >
        {label}
      </div>
      <div style={{ opacity: 0.75, fontSize: 10 }}>{sublabel}</div>
    </div>
  </div>
);

const fmt = (s: number) => {
  const v = Math.round(s * 10) / 10;
  return `${v}s`;
};
