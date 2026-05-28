import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Player, PlayerRef } from "@remotion/player";
import { ScreenDemo } from "@src/ScreenDemo";
import type { ScreenDemoProps } from "@src/ScreenDemo";

const WIDTH = 1920;
const HEIGHT = 1080;
const FPS = 60;

declare global {
  interface Window {
    __renderReady: boolean;
    __initRender: (props: ScreenDemoProps, durationInFrames: number) => void;
    __seekTo: (frame: number) => Promise<void>;
  }
}

const App: React.FC = () => {
  const playerRef = useRef<PlayerRef>(null);
  const [props, setProps] = useState<ScreenDemoProps | null>(null);
  const [dur, setDur] = useState(1);

  useEffect(() => {
    window.__initRender = (p, d) => {
      setProps(p);
      setDur(d);
    };

    window.__seekTo = (frame) =>
      new Promise<void>((resolve) => {
        const player = playerRef.current;
        if (!player) {
          resolve();
          return;
        }
        player.seekTo(frame);
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      });

    window.__renderReady = true;
  }, []);

  if (!props) return null;

  return (
    <Player
      ref={playerRef}
      component={ScreenDemo}
      inputProps={props}
      durationInFrames={dur}
      compositionWidth={WIDTH}
      compositionHeight={HEIGHT}
      fps={FPS}
      controls={false}
      loop={false}
      style={{ width: WIDTH, height: HEIGHT }}
      acknowledgeRemotionLicense
    />
  );
};

const root = document.getElementById("root");
if (root) createRoot(root).render(<App />);
