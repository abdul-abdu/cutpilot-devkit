/**
 * The method the AI follows, adapted from /brag (https://github.com/latent-spaces/brag, MIT,
 * Copyright (c) 2026 Shunit Haviv Hakimi) for CutPilot: brag owns the story (angle, hook,
 * storyboard, tone, what to show, share copy); HyperFrames builds and renders it. Upstream, the
 * agent runs HyperFrames itself and reads its own HyperFrames skills; here the plugin runs it
 * (start_project, write_file, add_asset, check, snapshot, render) and these pages carry what the
 * AI needs to know about compositions, with `hyperframes docs` behind the hyperframes-* topics.
 */

export const FORMATS = {
  landscape: { width: 1920, height: 1080 },
  vertical: { width: 1080, height: 1920 },
  square: { width: 1080, height: 1080 },
} as const;
export type Format = keyof typeof FORMATS;

export const TONES = [
  'default',
  'polished',
  'yc-parody',
  'chaotic',
  'deadpan',
  'cinematic',
  'app-store',
] as const;

const WORKFLOW = `# /brag in CutPilot: you built it, now brag

Turn something the user made (an app, a site, a product, a project) into a short, polished, shareable launch video: music, motion and share copy. You own the story; HyperFrames builds and renders it through this plugin's tools. Adapted from /brag by latent-spaces (MIT).

Options the user may give, as flags or plain words: tone (a preset or freeform direction, e.g. "fake Series A launch from 2016"), format (landscape 1920x1080 by default, vertical 1080x1920, square 1080x1080), duration (15–25 s; about 20 by default), no music, no sfx, a title.

## 1. Inspect
Gather material from what you can reach: the project's files if you can read them (index.html, styles, README, package.json, routes and the key components), the live site if you can fetch it, the user's footage in this CutPilot project (its transcript and frames), and what the user tells you. Read beyond the landing page: the best material is the product in use, its 2–3 beats: entry → key action → result.

Answer these nine before planning:
1. What is it? One sentence.
2. The funniest or most impressive claim (a line from the project itself).
3. The visual hook: the strongest colour moment, UI element, diagram or card.
4. What to show from the real UI.
5. The shortest satisfying video: 15 s? 20?
6. The tone: a preset (call guide with topic "tones") plus a short creative direction.
7. What the audio should feel like (role and music direction; exact effects come later).
8. The share caption, in one sentence.
9. The user flow worth showing (entry → key action → result), or "none — landing page only".
Write down the exact colours (background, text, accent) and fonts (display, body) the project uses.

## 2. Plan
Call start_project (name, format, duration). Write brag-plan.md with write_file: what it is, the angle, the hook (first 2–3 s), the key moments, the outro or punchline, the user flow, tone and direction, format and duration, the visual identity, audio direction, the share copy draft, and a scene-by-scene storyboard (what is seen and read, duration, transition, sound cue) whose durations add up to the target.
Shape: Hook (2–3 s) → Reveal (2–4 s) → 2–3 sharp highlights (5–12 s) → Punchline/outro (2–4 s). A starting shape, not a template. If the user points at one part (a new feature, a version), make that the focus.
What to show, best first: recreate a working-app moment (the product doing its thing); recreate a UI element in HTML (hero card, progress meter, swipe UI); animate the core concept; let the copy be the visual (giant type).

## 3. Compose
Copy what the video uses into the project with add_asset: the logo, screenshots, product images, footage (a clip of the user's own video works), fonts, and music. Music: a file the user has, or one from CutPilot's music or sound plugin (find_music / get_music, or generate_sound with kind "music"); with no music, say so and decide whether silence is the stronger choice. Sound effects: list_sounds, then add_asset with "sound"; choose them after the motion exists, so each lands with what moves.
Write composition/index.html with write_file (call guide with topic "hyperframes" first: the rules a composition must follow). Recreate the product's UI in HTML and CSS with its real copy, colours and fonts rather than panning over screenshots.
Then check (HyperFrames lint plus a browser pass for layout, overflow and contrast) and fix every error. Look at stills with snapshot, from every scene and from mid-transition, and fix overflow, collisions and low contrast. A plain crossfade between two busy layouts makes a muddy double exposure: stagger it (old content out, then new content in) or dip through the background.

## 4. Deliver
render with posterAt: the time of the strongest settled frame (text fully in, not mid-transition). It writes brag.mp4, brag.jpg, and bakes the poster in as frame 0 so every platform's thumbnail shows it. Write share-copy.txt with write_file: 1–3 sentences, postable as is, specific, in the tone; no "excited to share". Then offer to put brag.mp4 into the user's CutPilot project, tell them where the files are, give one sentence on the creative angle, and offer to re-roll a scene or try another tone.

## Creative laws (every tone)
- Short: 15–25 s, 18–22 is the sweet spot.
- Clear to a stranger: after one viewing, someone who has never heard of it knows what it does, who it is for and how to get it.
- The hook is everything: the first 2 seconds decide whether anyone keeps watching. Plan it first.
- Show the thing: at least one scene shows real UI, copy or a key visual from the product. Never abstract filler.
- Specific: made for this exact project. Use its own copy and claims; no generic SaaS language ("streamline your workflow" is banned).
- Readable: pace comes from motion and cuts, not from pulling text away early. A line meant to be read stays fully visible and settled ~0.3 s per word (a short label ~0.8 s), counted from when the whole line is on screen. Fast in, then hold; never fast in, then gone. Don't reveal a new text line on every beat of fast music.
- Make it alive: things appearing one by one, simulated clicks, swipes and typing beat static slides.
- Funny earns its place: humour comes from the project's own absurdity, not from trying.
- Every frame postable.

## Grounding
check audits structure; nothing checks the copy, so read the composition once for this. Names, numbers, capabilities, feature claims, quotes and anything presented as the product's own copy must appear in the project (re-cased, trimmed or split is fine; invented is not). Tone, framing, jokes, hooks and connective lines are yours to invent. When a line you want isn't grounded, quote what the project does say.

## Sound
Write the music and effects as one piece: effects sit softly under the music, nothing harsh or spiky, repeated little sounds stay in the background. Prefer low or medium high-frequency-risk effects (list_sounds says which); save bright ones for tiny accents or the chaotic tone. Clicks start with the gesture; reveal sounds land with the visual payoff. Fade the music out under the final logo.
`;

const TONE_PAGE = `# Tones

Presets are defaults; freeform direction ("museum exhibit", "overproduced mobile game ad") refines or overrides them. Map freeform direction to the nearest preset for pacing, and keep the direction itself in the plan.

| Tone | Feel | Pacing and transitions | Writing |
| --- | --- | --- | --- |
| default | Punchy, playful, clean, postable | 4–5 scenes; soft transitions | Confident, short, a wink |
| polished | Serious, elegant, restrained (for projects that are not jokes) | 3–4 scenes, long holds; soft fades | Quiet, exact, no exclamation marks |
| yc-parody | Deadpan startup launch, played straight | 4–5 scenes, one claim each; hard cuts | Fake seriousness: "We're reimagining X" about something absurd |
| chaotic | FAST, LOUD, ALL CAPS, over the top | 6–8 scenes, some under 2 s; flash and zoom cuts | Shouting, stacked claims (still readable: hold each line) |
| deadpan | Calm, dry, nothing is a joke | 3–4 scenes, big empty space; slow fades | Flat statements, long pauses |
| cinematic | Trailer scale, epic claims | 4–5 scenes, big type; dramatic wipes | "In a world where…" energy, earned by the product |
| app-store | Clean feature cards, corporate but not boring | 4–6 scenes; smooth slides | One benefit per card, plain words |

Examples: an absurd product → yc-parody, "fake startup launch"; an earnest one → polished, "quiet premium product film"; a chaotic one → chaotic, "overproduced social ad".
`;

const HYPERFRAMES_PAGE = `# Writing composition/index.html for HyperFrames

HyperFrames renders an HTML page frame by frame in headless Chrome: it seeks a paused GSAP timeline to each frame's time and captures it. start_project writes a working starter; keep its structure.

- The root element carries the composition: data-composition-id="main", data-start="0", data-duration (seconds), data-width, data-height (the format's pixels) and data-fps. Its CSS size is the same width and height, with overflow hidden.
- Scenes are untimed wrappers (<div class="scene" id="s2">, absolutely positioned over the frame) that the timeline shows and hides: tl.set("#s2", { autoAlpha: 1 }, 4) and tl.to("#s1", { autoAlpha: 0, duration: 0.3 }, 3.8), with every scene but the first starting at visibility: hidden. Their children are animated by the same timeline.
- Timed elements (class="clip" with data-start and data-duration in seconds; data-track-index optional) are leaves: audio, video, an image. A timed element with children draws a warning (nested_structure_needs_subcomposition); a scene that must be timed goes in its own file mounted with data-composition-src (topic hyperframes-compositions).
- Animation: one GSAP timeline created paused and registered as window.__timelines.main = tl (gsap is loaded from vendor/gsap.min.js). Every frame must be a pure function of time: no setTimeout, setInterval, requestAnimationFrame loops, Date.now(), Math.random() without a seed, or CSS animations and transitions. An element GSAP moves (x, y, scale, rotation) has no CSS transform of its own.
- End with tl.set({}, {}, <duration>) so the last frame holds to the end.
- Every timed element has an id (check warns otherwise).
- Audio: <audio id="music" class="clip" src="assets/music.mp3" data-start="0" data-duration="20" data-volume="0.6" data-fade-out="1.5"></audio>; an effect is a short <audio> clip at its moment (data-volume 0.3–0.6) whose data-duration is the effect's own length (list_sounds gives durationMs). data-fade-in / data-fade-out are seconds; data-media-start trims the start of a file.
- Video: <video id="demo" class="clip" src="assets/demo.mp4" data-start="4" data-duration="5" data-media-start="12" muted playsinline></video> (data-has-audio="true" to keep its sound).
- Later elements paint over earlier ones: a caption over a video needs a z-index above it (check reports text hidden beneath an opaque element as text_occluded).
- Nothing is fetched while rendering: every image, font, video and sound is a file under composition/ (add_asset puts them in assets/). Load fonts with @font-face from assets/, or use system fonts.
- Text: size it for the frame (the short side of a 1080x1920 frame is 1080 px), keep it inside a safe margin (~6% of the frame), and check contrast against what is behind it.

For HyperFrames' own pages, call guide with topic hyperframes-data-attributes, hyperframes-gsap, hyperframes-compositions, hyperframes-rendering or hyperframes-troubleshooting.
`;

export const GUIDE_TOPICS = ['workflow', 'tones', 'hyperframes'] as const;
export const HYPERFRAMES_DOCS = [
  'data-attributes',
  'gsap',
  'compositions',
  'rendering',
  'troubleshooting',
] as const;

export const PAGES: Record<(typeof GUIDE_TOPICS)[number], string> = {
  workflow: WORKFLOW,
  tones: TONE_PAGE,
  hyperframes: HYPERFRAMES_PAGE,
};

const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** A composition that passes HyperFrames' checks, for the AI to replace scene by scene. */
export function starterComposition(o: {
  title: string;
  width: number;
  height: number;
  fps: number;
  durationS: number;
}): string {
  const d = String(o.durationS);
  const short = Math.min(o.width, o.height);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${o.width}, height=${o.height}" />
    <title>${esc(o.title)}</title>
    <script src="vendor/gsap.min.js"></script>
    <style>
      body { margin: 0; background: #0b0b0f; }
      #root { position: relative; width: ${o.width}px; height: ${o.height}px; overflow: hidden; background: #0b0b0f; color: #ffffff; font-family: -apple-system, "SF Pro Display", "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif; }
      .scene { position: absolute; inset: 0; visibility: hidden; display: flex; align-items: center; justify-content: center; text-align: center; padding: 0 ${Math.round(short * 0.08)}px; box-sizing: border-box; }
      #title { margin: 0; font-size: ${Math.round(short * 0.1)}px; font-weight: 800; letter-spacing: -0.02em; }
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${d}" data-width="${o.width}" data-height="${o.height}" data-fps="${o.fps}">
      <!-- the storyboard's scenes: untimed wrappers the timeline shows and hides -->
      <div id="s1" class="scene">
        <h1 id="title">${esc(o.title)}</h1>
      </div>
    </div>
    <script>
      window.__timelines = window.__timelines || {};
      (function () {
        var tl = gsap.timeline({ paused: true });
        tl.set("#s1", { autoAlpha: 1 }, 0);
        tl.from("#title", { opacity: 0, y: ${Math.round(short * 0.04)}, duration: 0.6, ease: "power3.out" }, 0.2);
        // hold the last frame to the end
        tl.set({}, {}, ${d});
        window.__timelines.main = tl;
      })();
    </script>
  </body>
</html>
`;
}
