import { Video } from "@remotion/media";
import {
  AbsoluteFill,
  Easing,
  interpolate,
  staticFile,
  useCurrentFrame,
} from "remotion";
import { z } from "zod";

const KeyframeSchema = z.object({
  frame: z.number(),
  scale: z.number().default(1),
  x: z.number().default(0),
  y: z.number().default(0),
  rotateY: z.number().default(0),
  rotateX: z.number().default(0),
});

export const ScreenDemoSchema = z.object({
  src: z.string().describe("Captured video path relative to /public"),
  sourceUrl: z.string().describe("Live page URL for auto-capture"),
  background: z
    .string()
    .default("linear-gradient(135deg, #0f172a, #1e293b)"),
  screenRadius: z.number().default(12),
  screenShadow: z.string().default("0 40px 80px rgba(0,0,0,0.5)"),
  keyframes: z.array(KeyframeSchema).min(1),
});

export type ScreenDemoProps = z.infer<typeof ScreenDemoSchema>;

const interpolateKeyframes = (
  frame: number,
  keyframes: z.infer<typeof KeyframeSchema>[],
  property: keyof z.infer<typeof KeyframeSchema>,
) => {
  const frames = keyframes.map((k) => k.frame);
  const values = keyframes.map((k) => k[property] as number);
  return interpolate(frame, frames, values, {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.inOut(Easing.quad),
  });
};

export const ScreenDemo: React.FC<ScreenDemoProps> = ({
  src,
  background,
  screenRadius,
  screenShadow,
  keyframes,
}) => {
  const frame = useCurrentFrame();

  const scale = interpolateKeyframes(frame, keyframes, "scale");
  const x = interpolateKeyframes(frame, keyframes, "x");
  const y = interpolateKeyframes(frame, keyframes, "y");
  const rotateY = interpolateKeyframes(frame, keyframes, "rotateY");
  const rotateX = interpolateKeyframes(frame, keyframes, "rotateX");

  return (
    <AbsoluteFill style={{ background }}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <div
          style={{
            transform: `perspective(1200px) rotateX(${rotateX}deg) rotateY(${rotateY}deg) scale(${scale}) translate(${x}px, ${y}px)`,
            borderRadius: screenRadius,
            overflow: "hidden",
            boxShadow: screenShadow,
            width: 1920,
            height: 1080,
          }}
        >
          {src ? (
            <Video
              src={
                src.startsWith("http://") || src.startsWith("https://")
                  ? src
                  : staticFile(src)
              }
              style={{ width: "100%", height: "100%" }}
              muted
            />
          ) : (
            <div
              style={{
                width: "100%",
                height: "100%",
                background: "linear-gradient(135deg, #1e293b, #0f172a)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#475569",
                fontSize: 18,
                fontFamily: "system-ui, sans-serif",
              }}
            >
              Capture a page to preview
            </div>
          )}
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
