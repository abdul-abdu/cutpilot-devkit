/** Short authoring rules for the AI writing scenes (the remotion__guide tool). */
export const GUIDE = `# Writing a Remotion scene for CutPilot

A scene is ONE .tsx file: TypeScript + React, run by the user's own Remotion. Every frame is
rendered on its own in a headless browser, possibly out of order and in parallel, so a frame must
depend ONLY on its frame number and props.

## The workflow
1. remotion__status: is a project linked, which Remotion, which scenes exist.
2. remotion__create_scene { id, code, durationInFrames, fps, width, height, defaultProps }.
   Read the "check" in the answer: TypeScript and bundler errors come back verbatim. Fix them with
   remotion__update_scene until check.ok is true.
3. remotion__preview_frame at several frames (start, the middle of each animation, the end) and
   LOOK at the images: text cut off, overlaps, contrast, safe margins. Fix, preview again.
4. Into the edit: add_insert { template: "<scene id>", params: { …props }, at } renders it at the
   timeline's size. For a file instead (a ProRes overlay with alpha, an export), remotion__render.

## Rules
- Animate ONLY with useCurrentFrame() + interpolate() / spring() (from "remotion"), timing from
  useVideoConfig().fps. Never CSS animations or transitions, setTimeout/setInterval,
  requestAnimationFrame, Date.now() or Math.random(): use random("seed") from "remotion".
  Clamp: interpolate(frame, [0, 20], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }).
- Lay out from useVideoConfig().width / height (the scene may be rendered at the timeline's size),
  not fixed pixel positions. Use <AbsoluteFill> for full-frame layers; <Sequence from={30}> to
  start something later (inside it, useCurrentFrame() starts at 0 again).
- Assets: put files in the project's public/ folder and use staticFile("logo.png") with <Img>,
  <OffthreadVideo>, <Audio> from "remotion" (they wait until loaded; plain <img>/<video> don't).
  Remote URLs work too but make renders depend on the network.
- Props: every text, colour, and timing the user may want to change is a prop with a default in
  defaultProps (JSON values only). Type them: type Props = { headline: string; accent: string };
  export default function Scene({ headline, accent }: Props) {…}. Then a change is a new props
  object, not new code.
- Fonts: system fonts, or @remotion/google-fonts if the project has it installed. Don't fetch CSS.
- The file must \`export default\` the component. Don't register a <Composition>: the plugin does.
  Don't export cutpilotScene: the plugin writes it from durationInFrames, fps, width, height, defaultProps.
- Import only from "remotion", "react" and packages the project has installed.

## Common sizes
- 1080x1920 (9:16: Reels, Shorts, TikTok), 1920x1080 (16:9), 1080x1080 (1:1), 1080x1350 (4:5).
- 30 fps unless the edit says otherwise; durationInFrames = seconds × fps.
- Keep text inside a safe area: about 8% from the edges, more at the bottom of 9:16 (captions, app UI).

## A minimal scene
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

type Props = { headline: string; accent: string };

export default function Scene({ headline, accent }: Props) {
  const frame = useCurrentFrame();
  const { fps, width } = useVideoConfig();
  const pop = spring({ frame, fps, config: { damping: 12 } });
  const opacity = interpolate(frame, [0, 10], [0, 1], { extrapolateRight: 'clamp' });
  return (
    <AbsoluteFill style={{ backgroundColor: '#0b0b0b', justifyContent: 'center', alignItems: 'center' }}>
      <h1 style={{ color: 'white', fontSize: width * 0.08, opacity, transform: \`scale(\${pop})\`, borderBottom: \`8px solid \${accent}\` }}>
        {headline}
      </h1>
    </AbsoluteFill>
  );
}
`;
