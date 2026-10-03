# Follow the speaker

When CutPilot reframes a wide video to 9:16 (or 1:1, 4:5…), this plugin moves the crop with the person talking instead of leaving it fixed. Faces are found on your Mac with Apple Vision; nothing leaves your computer. **macOS only.**

It is an `analyzer:reframe-track` plugin. You don't call it directly: ask your AI to "make it vertical and follow the speaker" and CutPilot's `set_reframe({ follow: 'speaker' })` asks it for a crop path over the parts of the video the edit keeps.

## How it works

1. **Faces.** A small helper program (`helper/main.swift`) decodes only the kept ranges of the source with AVFoundation, takes 5 frames per second (or the rate CutPilot asks for), runs Vision's face rectangle detection on each and prints one JSON line per frame: `{"t":1200,"faces":[{"x":0.61,"y":0.18,"w":0.12,"h":0.21,"confidence":0.98}]}`, boxes as fractions of the upright frame, top-left corner, y from the top.
2. **Tracks.** A face continues the track whose last box overlaps it most (IoU ≥ 0.2), or, for someone moving fast between frames, whose last box is near for its size. A track unseen for 2 s ends.
3. **The main speaker.** Each track scores its box areas times their confidence, added up: large and there most of the time wins; a face in the background or someone walking past scores little. The followed face is kept while it's there unless another scores twice as much. When it's lost, a face that scores at least half as much takes over at once (usually the same person after a jump the tracker couldn't bridge); anyone else only after 1.5 s, and until then the last position is held.
4. **A calm camera.** The aim is the face's centre, moved down by a tenth of the face's height so the face sits a little above the middle of the crop (headroom). The camera starts on the median of the first second of each range and then:
   - doesn't move while the face drifts less than 18 % of the crop's width (or height) from where it looks: a nod or a lean doesn't shake the picture;
   - otherwise moves to it with an eased start and stop: at most 3 crop widths per second, accelerating at up to 14 crop widths per second², and braking so it never overshoots;
   - holds still while the face is briefly lost (the aim stays where the face was last seen).
5. **Keyframes.** The camera's position at most every 500 ms of each kept range (evenly spaced from its start to its end; a range shorter than that holds still), with points the line between their neighbours already gives dropped. Times are integer source milliseconds, strictly increasing; CutPilot interpolates between them. `confidence` is the share of frames the followed face was seen in, times its mean detection confidence. With no face at all, the crop stays in the middle with confidence 0.

The settings are constants in `src/follow.ts` (`CAMERA`) and `src/tracker.ts` (`TRACKING`, `SELECTING`), chosen with the synthetic tracks in `src/follow.test.ts`: a speaker at x ≈ 0.74 with detection jitter stays within ±0.03; one who walks from left to right is reached within 1 s and never leaves the crop; a brief face in the background doesn't take the crop, even while the speaker is lost.

## Permissions and settings

Reads `source` (the video, which is never modified). No network, no secrets, no settings.

## Build

The plugin is TypeScript (`pnpm build`); the helper is Swift and needs a Mac with the Xcode command line tools:

```sh
plugins/follow-speaker/helper/build.sh     # bin/face-helper, universal (arm64 + x86_64), signed ad hoc
pnpm bundle plugins/follow-speaker         # build/follow-speaker, bin/ included
```

`bin/` isn't committed; `pnpm bundle` copies it into the package when it's there (it's listed in `files`) and says so when it isn't, so build the helper on a Mac before bundling a package for the store. 0.1.0's helper is signed ad hoc, not notarized; CutPilot installs it without a quarantine flag, so macOS runs it.

Measured on Apple silicon at 5 frames a second: a 45-second 1080p video in 3 s, a 75-second 4K video in 19 s. The tests use a stand-in helper for everything after face detection.

## Limits

- macOS only (Apple Vision). Elsewhere `reframe_track` fails with `E_FOLLOW_SPEAKER_UNSUPPORTED` and a fix: use a fixed crop.
- It follows the most prominent face, not the voice: in a two-person conversation it stays with one of them.
- Rotated phone videos are turned upright from the track's rotation (90°, 180°, 270°); mirrored ones aren't handled.
- Sampled at 5 fps, a very fast move is seen up to 200 ms late.

## Try it

```sh
pnpm build && pnpm vitest run plugins/follow-speaker
```

The tests run the path code on synthetic face tracks, and the plugin (in memory and with `testPlugin()`) with a stand-in helper written in Node that reads a JSON "scene" instead of a video. `CUTPILOT_FACE_HELPER=<path>` makes the plugin run another helper on any platform; the tests use it, CutPilot never sets it.
