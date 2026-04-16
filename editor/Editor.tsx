import React, { useCallback, useEffect, useMemo, useState } from "react";
import { Player, PlayerRef } from "@remotion/player";
import {
  MyComposition,
  MyCompositionProps,
  Clip,
  TextSegment,
} from "@src/Composition";
import { useHistory } from "./useHistory";
import { Timeline, Selection } from "./Timeline";
import { MediaPool, ASSET_MIME, AssetDragPayload } from "./MediaPool";

const FPS = 60;
const WIDTH = 1920;
const HEIGHT = 1080;

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

export const Editor: React.FC = () => {
  const [loaded, setLoaded] = useState<MyCompositionProps | null>(null);

  useEffect(() => {
    fetch("/api/composition")
      .then((r) => r.json())
      .then((json) => setLoaded(json as MyCompositionProps));
  }, []);

  if (!loaded) {
    return <div style={{ padding: 40 }}>Loading composition…</div>;
  }
  return <EditorInner initial={loaded} />;
};

const EditorInner: React.FC<{ initial: MyCompositionProps }> = ({
  initial,
}) => {
  const { state, set, reset, undo, redo, canUndo, canRedo } =
    useHistory<MyCompositionProps>(initial);
  const [savedSnapshot, setSavedSnapshot] =
    useState<MyCompositionProps>(initial);
  const [saving, setSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState("");
  const [currentFrame, setCurrentFrame] = useState(0);
  const [selected, setSelected] = useState<Selection>(null);
  const [assetRefreshKey, setAssetRefreshKey] = useState(0);
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
    p.seekTo(frame);
    setCurrentFrame(frame);
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    setSaveMsg("");
    try {
      const res = await fetch("/api/composition", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(state),
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
    const defaultClip: Clip = last
      ? {
          src: last.src,
          from: last.from + (last.endAt - last.startFrom),
          startFrom: 0,
          endAt: 5,
        }
      : { src: "wall_alignment_demo.mp4", from: 0, startFrom: 0, endAt: 5 };
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
        reset(json as MyCompositionProps);
        setSavedSnapshot(json as MyCompositionProps);
        setSelected(null);
      });
  };

  const flash = (msg: string) => {
    setSaveMsg(msg);
    setTimeout(() => setSaveMsg(""), 3500);
  };

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
        height: "100vh",
        minHeight: 0,
      }}
    >
      <div style={{ gridColumn: 1, gridRow: "1 / span 2", minHeight: 0 }}>
        <MediaPool
          usedSources={usedSources}
          onAdd={addClipFromAsset}
          reloadKey={assetRefreshKey}
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
          <strong style={{ marginRight: "auto" }}>Editor</strong>
          <IconButton disabled={!canUndo} onClick={undo} title="Undo (⌘Z)">
            ↶ Undo
          </IconButton>
          <IconButton disabled={!canRedo} onClick={redo} title="Redo (⌘⇧Z)">
            ↷ Redo
          </IconButton>
          <IconButton onClick={revert} title="Reload from disk">
            Revert
          </IconButton>
          <SaveButton dirty={dirty} saving={saving} onClick={save} />
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
            component={MyComposition}
            inputProps={state}
            durationInFrames={durationInFrames}
            compositionWidth={WIDTH}
            compositionHeight={HEIGHT}
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
                  setSelected({ kind: "clip", trackIndex: ti, itemIndex: ci });
                  seekTo(clip.from);
                }}
                onChange={(patch, coalesce) =>
                  updateClip(ti, ci, patch, coalesce)
                }
                onRenameSrc={renameAsset}
                onRenameError={flash}
                onSplit={() => splitClip(ti, ci)}
                onDelete={() => deleteClip(ti, ci)}
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
                  setSelected({
                    kind: "segment",
                    trackIndex: ti,
                    itemIndex: si,
                  });
                  seekTo(seg.from);
                }}
                onChange={(patch, coalesce) =>
                  updateSegment(ti, si, patch, coalesce)
                }
                onDelete={() => deleteSegment(ti, si)}
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
        />
      </div>
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
  onSplit: () => void;
  onDelete: () => void;
}> = ({
  clip,
  cardId,
  selected,
  onSelect,
  onChange,
  onRenameSrc,
  onRenameError,
  onSplit,
  onDelete,
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
      style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}
    >
      <button style={splitBtnStyle} onClick={onSplit}>
        ✂ Split at playhead
      </button>
      <button style={deleteBtnStyle} onClick={onDelete}>
        Delete
      </button>
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
  onDelete: () => void;
}> = ({ segment, cardId, selected, onSelect, onChange, onDelete }) => (
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
      style={{ display: "flex", justifyContent: "flex-end" }}
    >
      <button style={deleteBtnStyle} onClick={onDelete}>
        Delete
      </button>
    </div>
  </div>
);
