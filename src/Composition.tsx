import { Video } from "@remotion/media";
import {
  AbsoluteFill,
  Easing,
  Sequence,
  interpolate,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { z } from "zod";

const ClipSchema = z.object({
  src: z.string().describe("File path relative to /public"),
  from: z.number().describe("Timeline position in seconds"),
  startFrom: z.number().describe("Source start (seconds into the clip)"),
  endAt: z.number().describe("Source end (seconds into the clip)"),
});

const TextSegmentSchema = z.object({
  from: z.number().describe("Start time in seconds"),
  duration: z.number().describe("Duration in seconds"),
  text: z.string().describe("Text to display"),
});

const VideoTrackSchema = z.object({
  id: z.string(),
  name: z.string(),
  clips: z.array(ClipSchema),
});

const TextTrackSchema = z.object({
  id: z.string(),
  name: z.string(),
  segments: z.array(TextSegmentSchema),
});

export type Clip = z.infer<typeof ClipSchema>;
export type TextSegment = z.infer<typeof TextSegmentSchema>;
export type VideoTrack = z.infer<typeof VideoTrackSchema>;
export type TextTrack = z.infer<typeof TextTrackSchema>;

export const MyCompositionSchema = z.object({
  fadeDuration: z
    .number()
    .describe("Fade in/out duration in seconds")
    .default(0.5),
  fontSize: z.number().describe("Font size in pixels").default(32),
  textColor: z.string().describe("Text color").default("#ffffff"),
  bgColor: z
    .string()
    .describe("Background color (supports rgba)")
    .default("rgba(0, 0, 0, 0.7)"),
  bgBorderRadius: z
    .number()
    .describe("Background border radius in pixels")
    .default(12),
  paddingBottom: z
    .number()
    .describe("Distance from bottom of screen in pixels")
    .default(50),
  videoTracks: z.array(VideoTrackSchema).describe("Video tracks (later tracks render on top)"),
  textTracks: z.array(TextTrackSchema).describe("Text tracks (rendered above all video tracks)"),
});

export type MyCompositionProps = z.infer<typeof MyCompositionSchema>;

const TextOverlay: React.FC<{
  text: string;
  fadeDuration: number;
  fontSize: number;
  textColor: string;
  bgColor: string;
  bgBorderRadius: number;
  paddingBottom: number;
}> = ({
  text,
  fadeDuration,
  fontSize,
  textColor,
  bgColor,
  bgBorderRadius,
  paddingBottom,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();

  const fadeDurationFrames = fadeDuration * fps;

  const fadeIn = interpolate(frame, [0, fadeDurationFrames], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.quad),
  });

  const fadeOut = interpolate(
    frame,
    [durationInFrames - fadeDurationFrames, durationInFrames],
    [1, 0],
    {
      extrapolateLeft: "clamp",
      extrapolateRight: "clamp",
      easing: Easing.inOut(Easing.quad),
    },
  );

  const opacity = Math.min(fadeIn, fadeOut);

  return (
    <AbsoluteFill
      style={{
        justifyContent: "flex-end",
        alignItems: "center",
        paddingBottom,
      }}
    >
      <div
        style={{
          opacity,
          backgroundColor: bgColor,
          color: textColor,
          fontSize,
          fontFamily: "Inter, system-ui, sans-serif",
          fontWeight: 600,
          padding: "14px 36px",
          borderRadius: bgBorderRadius,
          maxWidth: "80%",
          textAlign: "center",
          lineHeight: 1.4,
          letterSpacing: -0.3,
        }}
      >
        {text}
      </div>
    </AbsoluteFill>
  );
};

export const MyComposition: React.FC<MyCompositionProps> = ({
  fadeDuration,
  fontSize,
  textColor,
  bgColor,
  bgBorderRadius,
  paddingBottom,
  videoTracks,
  textTracks,
}) => {
  const { fps } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: "black" }}>
      {videoTracks.flatMap((track, ti) =>
        track.clips
          .filter((clip) => clip.endAt > clip.startFrom)
          .map((clip, ci) => {
            // Round both timeline boundaries independently and derive duration
            // from their difference — otherwise a clip snapped exactly to the
            // end of the previous one can be off by a frame, showing black.
            const fromFrame = Math.round(clip.from * fps);
            const endFrame = Math.round(
              (clip.from + clip.endAt - clip.startFrom) * fps,
            );
            const trimBefore = Math.round(clip.startFrom * fps);
            const trimAfter = trimBefore + (endFrame - fromFrame);
            // Premount so the <Video> element mounts and seeks before this
            // clip is actually visible — prevents a 1-frame black flash at the
            // boundary between two adjacent clips.
            const premountFor = Math.round(0.5 * fps);
            return (
              <Sequence
                key={`${track.id}-${ci}`}
                from={fromFrame}
                durationInFrames={Math.max(1, endFrame - fromFrame)}
                premountFor={premountFor}
              >
                <Video
                  src={staticFile(clip.src)}
                  trimBefore={trimBefore}
                  trimAfter={trimAfter}
                  muted
                />
              </Sequence>
            );
          }),
      )}
      {textTracks.flatMap((track, ti) =>
        track.segments
          .filter((segment) => segment.duration > 0)
          .map((segment, si) => {
            const fromFrame = Math.round(segment.from * fps);
            const endFrame = Math.round(
              (segment.from + segment.duration) * fps,
            );
            return (
            <Sequence
              key={`${track.id}-${si}`}
              from={fromFrame}
              durationInFrames={Math.max(1, endFrame - fromFrame)}
              layout="none"
            >
              <TextOverlay
                text={segment.text}
                fadeDuration={fadeDuration}
                fontSize={fontSize}
                textColor={textColor}
                bgColor={bgColor}
                bgBorderRadius={bgBorderRadius}
                paddingBottom={paddingBottom}
              />
            </Sequence>
            );
          }),
      )}
    </AbsoluteFill>
  );
};
