import React, { useEffect, useState } from "react";

declare global {
  interface Window {
    updater?: {
      onUpdateAvailable: (cb: (info: { version: string }) => void) => void;
      onDownloadProgress: (cb: (pct: number) => void) => void;
      onUpdateDownloaded: (cb: (info: { version: string }) => void) => void;
      installUpdate: () => void;
      checkForUpdates: () => void;
    };
  }
}

type Phase = "available" | "downloading" | "ready" | "dismissed";

export const UpdateNotification: React.FC = () => {
  const [phase, setPhase] = useState<Phase | null>(null);
  const [version, setVersion] = useState("");
  const [progress, setProgress] = useState(0);

  useEffect(() => {
    if (!window.updater) return;

    window.updater.onUpdateAvailable((info) => {
      setVersion(info.version);
      setPhase("available");
    });

    window.updater.onDownloadProgress((pct) => {
      setPhase("downloading");
      setProgress(pct);
    });

    window.updater.onUpdateDownloaded((info) => {
      setVersion(info.version);
      setPhase("ready");
    });
  }, []);

  if (!phase || phase === "dismissed") return null;

  const container: React.CSSProperties = {
    position: "fixed",
    bottom: 20,
    right: 20,
    background: "#1a1a22",
    border: "1px solid #2a2a34",
    borderRadius: 10,
    padding: "14px 18px",
    zIndex: 9999,
    minWidth: 280,
    fontFamily: "Inter, system-ui, sans-serif",
    fontSize: 13,
    color: "#e8e8ea",
    boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
  };

  const btnBase: React.CSSProperties = {
    border: "none",
    borderRadius: 6,
    padding: "6px 14px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
  };

  const primaryBtn: React.CSSProperties = {
    ...btnBase,
    background: "#4a6aa8",
    color: "#fff",
  };

  const ghostBtn: React.CSSProperties = {
    ...btnBase,
    background: "transparent",
    color: "#888",
  };

  if (phase === "downloading") {
    return (
      <div style={container}>
        <div style={{ marginBottom: 8 }}>Downloading v{version}… {progress}%</div>
        <div
          style={{
            height: 4,
            borderRadius: 2,
            background: "#2a2a34",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              height: "100%",
              width: `${progress}%`,
              background: "#4a6aa8",
              transition: "width 300ms",
            }}
          />
        </div>
      </div>
    );
  }

  if (phase === "ready") {
    return (
      <div style={container}>
        <div style={{ marginBottom: 10 }}>
          v{version} is ready to install.
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button style={primaryBtn} onClick={() => window.updater?.installUpdate()}>
            Restart & Update
          </button>
          <button style={ghostBtn} onClick={() => setPhase("dismissed")}>
            Later
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={container}>
      <div style={{ marginBottom: 10 }}>
        A new version (v{version}) is downloading…
      </div>
      <button style={ghostBtn} onClick={() => setPhase("dismissed")}>
        Dismiss
      </button>
    </div>
  );
};
