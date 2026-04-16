import "./index.css";
import { Composition } from "remotion";
import { MyComposition, MyCompositionSchema } from "./Composition";
import type { MyCompositionProps } from "./Composition";
import compositionData from "./data/composition.json";

const defaultProps = compositionData as MyCompositionProps;

const fps = 60;
const clipEnds = defaultProps.videoTracks.flatMap((t) =>
  t.clips.map((c) => c.from + (c.endAt - c.startFrom)),
);
const segEnds = defaultProps.textTracks.flatMap((t) =>
  t.segments.map((s) => s.from + s.duration),
);
const totalDuration = Math.max(...clipEnds, ...segEnds, 1);

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="MyComp"
        component={MyComposition}
        durationInFrames={Math.ceil(totalDuration * fps)}
        fps={fps}
        width={1920}
        height={1080}
        schema={MyCompositionSchema}
        defaultProps={defaultProps}
      />
    </>
  );
};
