import React, { useCallback, useEffect, useRef, useState } from "react";

type Asset = { name: string; size: number; mtime: number };

export const ASSET_MIME = "application/x-media-asset";
export type AssetDragPayload = { src: string; duration: number };

const VIDEO_EXT = new Set([".mp4", ".mov", ".webm", ".mkv", ".m4v"]);

const extOf = (name: string) => {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
};

export const MediaPool: React.FC<{
  usedSources: Set<string>;
  onAdd: (name: string, durationSec: number) => void;
  reloadKey?: number;
}> = ({ usedSources, onAdd, reloadKey }) => {
  const [assets, setAssets] = useState<Asset[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState<{
    current: string;
    done: number;
    total: number;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const refresh = useCallback(() => {
    fetch("/api/assets")
      .then((r) => r.json())
      .then((json) => setAssets(json.assets ?? []))
      .catch((err) => setError((err as Error).message));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh, reloadKey]);

  const uploadFiles = useCallback(
    async (files: File[]) => {
      const videos = files.filter((f) => VIDEO_EXT.has(extOf(f.name)));
      if (videos.length === 0) {
        setError("No supported video files in drop (.mp4/.mov/.webm/.mkv/.m4v)");
        setTimeout(() => setError(null), 4000);
        return;
      }
      setError(null);
      for (let i = 0; i < videos.length; i++) {
        const f = videos[i];
        setUploading({ current: f.name, done: i, total: videos.length });
        try {
          const res = await fetch("/api/upload", {
            method: "POST",
            headers: {
              "x-filename": encodeURIComponent(f.name),
              "content-type": f.type || "application/octet-stream",
            },
            body: f,
          });
          const json = await res.json();
          if (!json.ok) throw new Error(json.error ?? "upload failed");
        } catch (err) {
          setError(`Upload of ${f.name} failed: ${(err as Error).message}`);
        }
      }
      setUploading(null);
      refresh();
    },
    [refresh],
  );

  const onDragEnter = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    dragDepth.current += 1;
    setIsDragging(true);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
  };
  const onDragLeave = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes("Files")) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setIsDragging(false);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    dragDepth.current = 0;
    setIsDragging(false);
    const files = Array.from(e.dataTransfer.files);
    if (files.length > 0) uploadFiles(files);
  };

  return (
    <div
      onDragEnter={onDragEnter}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      style={{
        position: "relative",
        display: "flex",
        flexDirection: "column",
        height: "100%",
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
          gap: 6,
        }}
      >
        <strong style={{ fontSize: 13 }}>Media pool</strong>
        <button
          onClick={() => fileInputRef.current?.click()}
          title="Browse files"
          style={{
            marginLeft: "auto",
            background: "#1e4b87",
            color: "white",
            border: "none",
            padding: "4px 9px",
            borderRadius: 5,
            cursor: "pointer",
            fontSize: 11,
            fontWeight: 500,
          }}
        >
          + Import
        </button>
        <button
          onClick={refresh}
          title="Refresh"
          style={{
            background: "transparent",
            color: "#e8e8ea",
            border: "1px solid #2e2e34",
            padding: "3px 8px",
            borderRadius: 5,
            cursor: "pointer",
            fontSize: 11,
          }}
        >
          ⟳
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="video/*,.mp4,.mov,.webm,.mkv,.m4v"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            const files = Array.from(e.target.files ?? []);
            if (files.length > 0) uploadFiles(files);
            e.target.value = "";
          }}
        />
      </div>
      {uploading && (
        <div
          style={{
            padding: "6px 12px",
            background: "#1a2f4a",
            color: "#9dc3ff",
            fontSize: 11,
            borderBottom: "1px solid #1e1e24",
            display: "flex",
            justifyContent: "space-between",
            gap: 8,
          }}
        >
          <span
            style={{
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            Uploading {uploading.current}…
          </span>
          <span style={{ fontVariantNumeric: "tabular-nums" }}>
            {uploading.done + 1}/{uploading.total}
          </span>
        </div>
      )}
      <div style={{ overflowY: "auto", padding: 10, flex: 1 }}>
        {error && (
          <div
            style={{
              color: "#ff7a75",
              fontSize: 12,
              marginBottom: 8,
              background: "#2a1414",
              padding: 8,
              borderRadius: 5,
              border: "1px solid #4a2826",
            }}
          >
            {error}
          </div>
        )}
        {assets && assets.length === 0 && !isDragging && (
          <div
            style={{
              color: "#666",
              fontSize: 12,
              textAlign: "center",
              padding: 24,
              border: "1px dashed #2e2e38",
              borderRadius: 8,
            }}
          >
            Drop videos here, or click "+ Import".
          </div>
        )}
        {assets?.map((a) => (
          <AssetCard
            key={a.name}
            asset={a}
            used={usedSources.has(a.name)}
            onAdd={onAdd}
          />
        ))}
      </div>
      {isDragging && (
        <div
          style={{
            position: "absolute",
            inset: 0,
            background: "rgba(30, 75, 135, 0.85)",
            border: "2px dashed #6aa0ff",
            borderRadius: 0,
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            color: "white",
            pointerEvents: "none",
            zIndex: 10,
          }}
        >
          <div style={{ fontSize: 32, marginBottom: 8 }}>+</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            Drop to import videos
          </div>
          <div
            style={{ fontSize: 11, opacity: 0.85, marginTop: 4 }}
          >
            .mp4 · .mov · .webm · .mkv · .m4v
          </div>
        </div>
      )}
    </div>
  );
};

const AssetCard: React.FC<{
  asset: Asset;
  used: boolean;
  onAdd: (name: string, durationSec: number) => void;
}> = ({ asset, used, onAdd }) => {
  const [duration, setDuration] = useState<number | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  return (
    <div
      onClick={() => onAdd(asset.name, duration ?? 5)}
      draggable
      onDragStart={(e) => {
        const payload = JSON.stringify({
          src: asset.name,
          duration: duration ?? 5,
        });
        e.dataTransfer.setData(ASSET_MIME, payload);
        e.dataTransfer.setData("text/plain", asset.name);
        e.dataTransfer.effectAllowed = "copy";
      }}
      title="Drag to a track, or click to add at playhead"
      style={{
        display: "flex",
        flexDirection: "column",
        background: "#1a1a20",
        border: "1px solid #26262e",
        borderRadius: 8,
        padding: 8,
        marginBottom: 8,
        cursor: "grab",
        gap: 6,
      }}
    >
      <div
        style={{
          position: "relative",
          width: "100%",
          aspectRatio: "16 / 9",
          background: "#000",
          borderRadius: 5,
          overflow: "hidden",
        }}
      >
        <video
          ref={videoRef}
          src={`/${asset.name}`}
          muted
          preload="metadata"
          onLoadedMetadata={(e) => {
            const v = e.currentTarget;
            setDuration(v.duration);
            try {
              v.currentTime = Math.min(0.1, v.duration / 2);
            } catch {
              // ignore seek errors
            }
          }}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "cover",
            pointerEvents: "none",
          }}
        />
        {used && (
          <div
            style={{
              position: "absolute",
              top: 4,
              right: 4,
              background: "rgba(30, 111, 62, 0.9)",
              color: "white",
              fontSize: 10,
              padding: "2px 6px",
              borderRadius: 4,
              fontWeight: 600,
            }}
          >
            in use
          </div>
        )}
      </div>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          gap: 6,
        }}
      >
        <div
          style={{
            fontSize: 12,
            color: "#e8e8ea",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            flex: 1,
          }}
        >
          {asset.name}
        </div>
        <div
          style={{
            fontSize: 10,
            color: "#8b8b94",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
          }}
        >
          {duration != null ? fmtDuration(duration) : "…"}
        </div>
      </div>
      <div
        style={{
          fontSize: 10,
          color: "#5a5a64",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <span>{fmtSize(asset.size)}</span>
        <span style={{ color: "#4a7bd5" }}>+ Add at playhead</span>
      </div>
    </div>
  );
};

const fmtDuration = (s: number) => {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, "0")}`;
};

const fmtSize = (bytes: number) => {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
};
