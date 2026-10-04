/**
 * The templates: each is a zod schema for its parameters plus a function that lays it out as a
 * HyperFrames composition (HTML + CSS + a paused GSAP timeline the renderer scrubs frame by
 * frame). Pure: no files, no browser. Sizes come from the canvas's short side, so one template
 * fits 9:16, 1:1 and 16:9 alike; text shrinks as it gets longer.
 *
 * HyperFrames' rules, which its linter checks: the root carries the composition's size, fps and
 * length; timed elements have class "clip" with data-start / data-duration / data-track-index
 * and are not nested in each other; an element GSAP moves (x, y, scale) has no CSS transform.
 * Here each template is one card (an untimed flex column over the whole frame, so nothing
 * timed is nested) whose children the timeline animates; the root's length is the clip's. Nothing is fetched: gsap is a file next to the page, fonts are the system's.
 */
import { z } from 'zod';

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colours look like #RRGGBB');

/** Colours every template takes. */
const Style = {
  background: Hex.default('#0f172a').describe('background colour, #RRGGBB'),
  color: Hex.default('#ffffff').describe('text colour, #RRGGBB'),
  accent: Hex.default('#ffd400').describe('accent colour for bars, numbers and highlights, #RRGGBB'),
};

export interface Frame {
  width: number;
  height: number;
  fps: number;
  durationMs: number;
}

interface Layout {
  /** the card's children */
  html: string;
  /** CSS for them (the card itself is laid out by the page) */
  css: string;
  /** GSAP calls on `tl`, times in seconds */
  timeline: string[];
  /** left-aligned cards (chapter, bullets) keep a margin on the left */
  align?: 'center' | 'left';
}

interface Ctx {
  /** the size text and spacing scale with: the canvas's short side (a little more on tall frames) */
  s: number;
  portrait: boolean;
  /** seconds */
  d: number;
  /** when the card starts fading out, seconds */
  out: number;
}

export interface TemplateDef<S extends z.ZodRawShape = z.ZodRawShape> {
  id: string;
  name: string;
  description: string;
  params: z.ZodObject<S>;
  example: z.input<z.ZodObject<S>>;
  defaultDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  layout(p: z.infer<z.ZodObject<S>>, c: Ctx): Layout;
}

const define = <S extends z.ZodRawShape>(t: TemplateDef<S>): TemplateDef => t as unknown as TemplateDef;

// ── helpers ──────────────────────────────────────────────────────────────────

export const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const px = (n: number) => `${Math.round(n)}px`;
const sec = (x: number) => String(Math.round(x * 1000) / 1000);

/** A font size for text of this length: `base` for short text, down to `min` for long text. */
export function fit(text: string, base: number, min: number, comfortable = 18): number {
  const n = [...text].length;
  return Math.round(Math.max(min, base * Math.min(1, Math.sqrt(comfortable / Math.max(1, n)))));
}

/** Mix a #RRGGBB colour with white (amount > 0) or black (amount < 0). */
export function shade(hex: string, amount: number): string {
  const n = parseInt(hex.slice(1), 16);
  const to = amount > 0 ? 255 : 0;
  const a = Math.abs(amount);
  const ch = (v: number) => Math.round(v + (to - v) * a);
  const [r, g, b] = [ch((n >> 16) & 255), ch((n >> 8) & 255), ch(n & 255)];
  return `#${((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1)}`;
}

// ── templates ────────────────────────────────────────────────────────────────

const titleCard = define({
  id: 'title-card',
  name: 'Title card',
  description:
    'A big title with an optional small label above and a subtitle below, over a solid background. Use it to open a video, or between topics.',
  params: z.object({
    title: z.string().trim().min(1).max(80).describe('the title, e.g. "How we cut 40% of our costs"'),
    subtitle: z.string().trim().min(1).max(120).optional().describe('a line under the title'),
    eyebrow: z
      .string()
      .trim()
      .min(1)
      .max(40)
      .optional()
      .describe('a small label above the title, e.g. "Episode 12"'),
    ...Style,
  }),
  example: {
    title: 'Three things I learned',
    subtitle: 'A year of building in public',
    eyebrow: 'Episode 12',
  },
  defaultDurationMs: 3000,
  minDurationMs: 1000,
  maxDurationMs: 10000,
  layout(p, { s, out }) {
    const size = fit(p.title, s * 0.12, s * 0.055);
    return {
      html: [
        p.eyebrow ? `<div id="eyebrow">${esc(p.eyebrow)}</div>` : '',
        `<h1 id="title">${esc(p.title)}</h1>`,
        `<div id="bar"></div>`,
        p.subtitle ? `<p id="subtitle">${esc(p.subtitle)}</p>` : '',
      ].join(''),
      css: `
      #eyebrow { color: ${p.accent}; font-size: ${px(s * 0.035)}; font-weight: 700; letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: ${px(s * 0.03)}; }
      #title { margin: 0; font-size: ${px(size)}; font-weight: 800; line-height: 1.08; letter-spacing: -0.01em; }
      #bar { width: ${px(s * 0.16)}; height: ${px(Math.max(4, s * 0.012))}; margin: ${px(s * 0.045)} 0; background: ${p.accent}; border-radius: ${px(s * 0.006)}; }
      #subtitle { margin: 0; font-size: ${px(fit(p.subtitle ?? '', s * 0.05, s * 0.032, 30))}; font-weight: 400; opacity: 0.85; line-height: 1.3; }`,
      timeline: [
        p.eyebrow
          ? `tl.from("#eyebrow", { opacity: 0, y: ${Math.round(s * 0.02)}, duration: 0.4, ease: "power2.out" }, 0.05);`
          : '',
        `tl.from("#title", { opacity: 0, y: ${Math.round(s * 0.05)}, duration: 0.6, ease: "power3.out" }, 0.15);`,
        `tl.from("#bar", { scaleX: 0, duration: 0.5, ease: "power2.inOut" }, 0.35);`,
        p.subtitle
          ? `tl.from("#subtitle", { opacity: 0, y: ${Math.round(s * 0.02)}, duration: 0.5, ease: "power2.out" }, 0.5);`
          : '',
        `tl.to("#card", { opacity: 0, duration: ${sec(Math.min(0.4, out))}, ease: "power1.in" }, ${sec(out)});`,
      ].filter(Boolean),
    };
  },
});

const chapter = define({
  id: 'chapter',
  name: 'Chapter',
  description:
    'A chapter heading: a big number (or short label) and the chapter title, left-aligned. Put one before each part of a longer video.',
  params: z.object({
    title: z.string().trim().min(1).max(80).describe('the chapter title, e.g. "Setting up"'),
    number: z.string().trim().min(1).max(12).optional().describe('e.g. "01" or "Part 2"'),
    ...Style,
  }),
  example: { number: '02', title: 'Getting the first users' },
  defaultDurationMs: 2500,
  minDurationMs: 1000,
  maxDurationMs: 8000,
  layout(p, { s, out }) {
    return {
      align: 'left',
      html: [
        p.number ? `<div id="number">${esc(p.number)}</div>` : '',
        `<div id="line"></div>`,
        `<h2 id="title">${esc(p.title)}</h2>`,
      ].join(''),
      css: `
      #number { color: ${p.accent}; font-size: ${px(fit(p.number ?? '', s * 0.26, s * 0.1, 3))}; font-weight: 900; line-height: 1; letter-spacing: -0.03em; }
      #line { width: ${px(s * 0.22)}; height: ${px(Math.max(4, s * 0.01))}; margin: ${px(s * 0.04)} 0; background: ${p.color}; opacity: 0.6; transform-origin: left center; }
      #title { margin: 0; font-size: ${px(fit(p.title, s * 0.09, s * 0.05))}; font-weight: 700; line-height: 1.12; }`,
      timeline: [
        p.number
          ? `tl.from("#number", { opacity: 0, scale: 0.6, duration: 0.6, ease: "back.out(1.7)" }, 0.05);`
          : '',
        `tl.from("#line", { scaleX: 0, duration: 0.5, ease: "power2.inOut" }, 0.25);`,
        `tl.from("#title", { opacity: 0, x: ${-Math.round(s * 0.05)}, duration: 0.55, ease: "power3.out" }, 0.4);`,
        `tl.to("#card", { opacity: 0, duration: ${sec(Math.min(0.4, out))}, ease: "power1.in" }, ${sec(out)});`,
      ].filter(Boolean),
    };
  },
});

const quote = define({
  id: 'quote',
  name: 'Quote',
  description:
    'A quotation revealed word by word, with who said it. Use it to highlight a line from the video or a source.',
  params: z.object({
    text: z.string().trim().min(1).max(240).describe('the quote, without quotation marks'),
    author: z.string().trim().min(1).max(60).optional().describe('who said it'),
    ...Style,
  }),
  example: { text: 'Make something people want.', author: 'Paul Graham' },
  defaultDurationMs: 5000,
  minDurationMs: 2000,
  maxDurationMs: 15000,
  layout(p, { s, d, out }) {
    const words = p.text.split(/\s+/).filter(Boolean);
    // the whole quote is in by 45% of the clip, so there is time to read it
    const stagger = Math.min(0.12, (d * 0.45) / Math.max(1, words.length));
    return {
      html: [
        `<div id="mark">“</div>`,
        `<blockquote id="text">${words.map((w, i) => `<span id="w${i + 1}">${esc(w)}</span>`).join(' ')}</blockquote>`,
        p.author ? `<div id="author">— ${esc(p.author)}</div>` : '',
      ].join(''),
      css: `
      #mark { color: ${p.accent}; font-family: Georgia, "Times New Roman", "Liberation Serif", "DejaVu Serif", serif; font-size: ${px(s * 0.3)}; line-height: 0.7; height: ${px(s * 0.14)}; }
      #text { margin: 0; font-size: ${px(fit(p.text, s * 0.085, s * 0.042, 30))}; font-weight: 600; line-height: 1.25; }
      #text span { display: inline-block; }
      #author { margin-top: ${px(s * 0.05)}; color: ${p.accent}; font-size: ${px(s * 0.04)}; font-weight: 600; letter-spacing: 0.04em; }`,
      timeline: [
        `tl.from("#mark", { opacity: 0, scale: 0.5, duration: 0.5, ease: "back.out(2)" }, 0);`,
        `tl.from("#text span", { opacity: 0, y: ${Math.round(s * 0.02)}, duration: 0.35, ease: "power2.out", stagger: ${sec(stagger)} }, 0.2);`,
        p.author
          ? `tl.from("#author", { opacity: 0, duration: 0.4, ease: "none" }, ${sec(0.2 + stagger * words.length + 0.1)});`
          : '',
        `tl.to("#card", { opacity: 0, duration: ${sec(Math.min(0.4, out))}, ease: "power1.in" }, ${sec(out)});`,
      ].filter(Boolean),
    };
  },
});

const bullets = define({
  id: 'bullets',
  name: 'Bullet list',
  description:
    'A heading and up to five short points that appear one after another. Use it to sum up, list steps, or preview what is coming.',
  params: z.object({
    title: z.string().trim().min(1).max(60).optional().describe('the heading, e.g. "What you need"'),
    items: z
      .array(z.string().trim().min(1).max(80))
      .min(1)
      .max(5)
      .describe('the points, in order, a few words each'),
    ...Style,
  }),
  example: { title: 'What you need', items: ['A camera', 'Good light', 'Something to say'] },
  defaultDurationMs: 5000,
  minDurationMs: 2000,
  maxDurationMs: 15000,
  layout(p, { s, d, out }) {
    const longest = Math.max(...p.items.map((i) => [...i].length));
    const size = fit('x'.repeat(longest), s * 0.065, s * 0.04, 22);
    // every point is in by 60% of the clip
    const stagger = Math.min(0.6, (d * 0.6 - 0.4) / p.items.length);
    return {
      align: 'left',
      html: [
        p.title ? `<h2 id="title">${esc(p.title)}</h2>` : '',
        `<ul id="items">${p.items.map((t, i) => `<li id="item${i + 1}">${esc(t)}</li>`).join('')}</ul>`,
      ].join(''),
      css: `
      #title { margin: 0 0 ${px(s * 0.05)}; font-size: ${px(fit(p.title ?? '', s * 0.08, s * 0.05))}; font-weight: 800; line-height: 1.1; }
      #items { margin: 0; padding: 0; list-style: none; }
      #items li { position: relative; padding-left: ${px(size * 1.1)}; margin: ${px(size * 0.45)} 0; font-size: ${px(size)}; font-weight: 500; line-height: 1.25; }
      #items li::before { content: ""; position: absolute; left: 0; top: ${px(size * 0.38)}; width: ${px(size * 0.45)}; height: ${px(size * 0.45)}; border-radius: 50%; background: ${p.accent}; }`,
      timeline: [
        p.title
          ? `tl.from("#title", { opacity: 0, y: ${Math.round(s * 0.03)}, duration: 0.45, ease: "power2.out" }, 0);`
          : '',
        `tl.from("#items li", { opacity: 0, x: ${-Math.round(s * 0.04)}, duration: 0.4, ease: "power2.out", stagger: ${sec(Math.max(0.1, stagger))} }, 0.3);`,
        `tl.to("#card", { opacity: 0, duration: ${sec(Math.min(0.4, out))}, ease: "power1.in" }, ${sec(out)});`,
      ].filter(Boolean),
    };
  },
});

const endCard = define({
  id: 'end-card',
  name: 'End card',
  description:
    'A closing card: a headline, a call to action on a pulsing button, and a handle or link. Put it at the very end of a video.',
  params: z.object({
    headline: z.string().trim().min(1).max(60).describe('e.g. "Thanks for watching"'),
    cta: z.string().trim().min(1).max(40).optional().describe('the button text, e.g. "Subscribe for more"'),
    handle: z.string().trim().min(1).max(60).optional().describe('e.g. "@nodcut" or a web address'),
    ...Style,
  }),
  example: { headline: 'Thanks for watching', cta: 'Subscribe for more', handle: '@nodcut' },
  defaultDurationMs: 4000,
  minDurationMs: 1500,
  maxDurationMs: 10000,
  layout(p, { s, out }) {
    const pulses = Math.max(0, Math.floor((out - 1.1) / 0.5));
    return {
      html: [
        `<h1 id="headline">${esc(p.headline)}</h1>`,
        p.cta ? `<div id="cta">${esc(p.cta)}</div>` : '',
        p.handle ? `<div id="handle">${esc(p.handle)}</div>` : '',
      ].join(''),
      css: `
      #headline { margin: 0; font-size: ${px(fit(p.headline, s * 0.1, s * 0.055))}; font-weight: 800; line-height: 1.1; }
      #cta { margin-top: ${px(s * 0.06)}; padding: ${px(s * 0.025)} ${px(s * 0.06)}; border-radius: ${px(s * 0.1)}; background: ${p.accent}; color: ${p.background}; font-size: ${px(fit(p.cta ?? '', s * 0.05, s * 0.035, 20))}; font-weight: 800; }
      #handle { margin-top: ${px(s * 0.045)}; font-size: ${px(s * 0.04)}; font-weight: 500; opacity: 0.8; letter-spacing: 0.02em; }`,
      timeline: [
        `tl.from("#headline", { opacity: 0, scale: 0.9, duration: 0.6, ease: "power3.out" }, 0.05);`,
        p.cta
          ? `tl.from("#cta", { opacity: 0, y: ${Math.round(s * 0.04)}, duration: 0.5, ease: "back.out(1.6)" }, 0.4);`
          : '',
        p.cta && pulses
          ? `tl.to("#cta", { scale: 1.06, duration: 0.25, ease: "sine.inOut", yoyo: true, repeat: ${pulses * 2 - 1} }, 1.1);`
          : '',
        p.handle ? `tl.from("#handle", { opacity: 0, duration: 0.4, ease: "none" }, 0.7);` : '',
        `tl.to("#card", { opacity: 0, duration: ${sec(Math.min(0.4, out))}, ease: "power1.in" }, ${sec(out)});`,
      ].filter(Boolean),
    };
  },
});

const hook = define({
  id: 'hook',
  name: 'Hook',
  description:
    "A stop-scroll opener: one short, bold line punched in hard, with an optional highlighted word in the accent colour. Put it first, 1-2 s, before the product or the point (an ad's first beat).",
  params: z.object({
    text: z.string().trim().min(1).max(60).describe('the line, e.g. "Still editing by hand?"'),
    highlight: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .optional()
      .describe('a word or phrase of the line to show in the accent colour, e.g. "by hand"'),
    ...Style,
  }),
  example: { text: 'Still editing by hand?', highlight: 'by hand' },
  defaultDurationMs: 1800,
  minDurationMs: 800,
  maxDurationMs: 5000,
  layout(p, { s, out }) {
    const i = p.highlight ? p.text.indexOf(p.highlight) : -1;
    const text =
      i < 0
        ? esc(p.text)
        : `${esc(p.text.slice(0, i))}<span id="hl">${esc(p.highlight!)}</span>${esc(p.text.slice(i + p.highlight!.length))}`;
    return {
      html: `<h1 id="line">${text}</h1><div id="rule"></div>`,
      css: `
      #line { margin: 0; font-size: ${px(fit(p.text, s * 0.14, s * 0.07))}; font-weight: 900; line-height: 1.05; letter-spacing: -0.02em; text-transform: none; }
      #hl { color: ${p.accent}; }
      #rule { width: ${px(s * 0.2)}; height: ${px(Math.max(5, s * 0.016))}; margin-top: ${px(s * 0.05)}; background: ${p.accent}; border-radius: ${px(s * 0.008)}; }`,
      timeline: [
        `tl.from("#line", { opacity: 0, scale: 1.35, duration: 0.35, ease: "power4.out" }, 0);`,
        `tl.from("#rule", { scaleX: 0, duration: 0.3, ease: "power3.out" }, 0.25);`,
        `tl.to("#card", { opacity: 0, duration: ${sec(Math.min(0.3, out))}, ease: "power1.in" }, ${sec(out)});`,
      ],
    };
  },
});

const offer = define({
  id: 'offer',
  name: 'Offer',
  description:
    'An urgency card for a deal: the offer big ("50% OFF"), a line of what it applies to, a pulsing badge ("Limited time") and an optional promo code. Put it before the end card of an ad.',
  params: z.object({
    offer: z.string().trim().min(1).max(30).describe('the deal, big, e.g. "50% OFF"'),
    line: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe('what it applies to, e.g. "Everything in the spring collection"'),
    badge: z.string().trim().min(1).max(30).optional().describe('the urgency badge, e.g. "This week only"'),
    code: z
      .string()
      .trim()
      .min(1)
      .max(30)
      .optional()
      .describe('a promo code to show, e.g. "Use code SPRING"'),
    ...Style,
  }),
  example: {
    offer: '50% OFF',
    line: 'Everything in the spring collection',
    badge: 'This week only',
    code: 'Use code SPRING',
  },
  defaultDurationMs: 3000,
  minDurationMs: 1500,
  maxDurationMs: 10000,
  layout(p, { s, out }) {
    const pulses = p.badge ? Math.max(0, Math.floor((out - 0.9) / 0.5)) : 0;
    return {
      html: [
        p.badge ? `<div id="badge">${esc(p.badge)}</div>` : '',
        `<div id="offer">${esc(p.offer)}</div>`,
        p.line ? `<p id="line">${esc(p.line)}</p>` : '',
        p.code ? `<div id="code">${esc(p.code)}</div>` : '',
      ].join(''),
      css: `
      #badge { padding: ${px(s * 0.012)} ${px(s * 0.035)}; border-radius: ${px(s * 0.1)}; background: ${p.accent}; color: ${p.background}; font-size: ${px(s * 0.032)}; font-weight: 800; letter-spacing: 0.08em; text-transform: uppercase; margin-bottom: ${px(s * 0.05)}; }
      #offer { font-size: ${px(fit(p.offer, s * 0.2, s * 0.09, 8))}; font-weight: 900; line-height: 1; letter-spacing: -0.02em; }
      #line { margin: ${px(s * 0.04)} 0 0; font-size: ${px(fit(p.line ?? '', s * 0.05, s * 0.034, 30))}; opacity: 0.85; line-height: 1.3; }
      #code { margin-top: ${px(s * 0.055)}; padding: ${px(s * 0.02)} ${px(s * 0.045)}; border: ${px(Math.max(2, s * 0.005))} dashed ${shade(p.color, -0.3)}; border-radius: ${px(s * 0.02)}; font-size: ${px(s * 0.04)}; font-weight: 700; letter-spacing: 0.06em; }`,
      timeline: [
        p.badge
          ? `tl.from("#badge", { opacity: 0, y: ${-Math.round(s * 0.03)}, duration: 0.35, ease: "power2.out" }, 0);`
          : '',
        `tl.from("#offer", { opacity: 0, scale: 0.7, duration: 0.5, ease: "back.out(1.8)" }, 0.15);`,
        p.line
          ? `tl.from("#line", { opacity: 0, y: ${Math.round(s * 0.025)}, duration: 0.4, ease: "power2.out" }, 0.45);`
          : '',
        p.code ? `tl.from("#code", { opacity: 0, duration: 0.4, ease: "none" }, 0.6);` : '',
        pulses
          ? `tl.to("#badge", { scale: 1.08, duration: 0.25, ease: "sine.inOut", yoyo: true, repeat: ${pulses * 2 - 1} }, 0.9);`
          : '',
        `tl.to("#card", { opacity: 0, duration: ${sec(Math.min(0.4, out))}, ease: "power1.in" }, ${sec(out)});`,
      ].filter(Boolean),
    };
  },
});

const stat = define({
  id: 'stat',
  name: 'Big number',
  description:
    'One number counting up big, with an optional prefix/suffix ("%", "+", "$") and a line saying what it is. Use it for a result, a stat or social proof ("12,000 creators").',
  params: z.object({
    value: z.number().int().min(0).max(1_000_000_000).describe('the number it counts up to, e.g. 73'),
    suffix: z.string().trim().max(12).optional().describe('shown after the number, e.g. "%" or "+ users"'),
    prefix: z.string().trim().max(6).optional().describe('shown before the number, e.g. "$"'),
    label: z.string().trim().min(1).max(80).describe('what the number is, e.g. "less time spent editing"'),
    ...Style,
  }),
  example: { value: 73, suffix: '%', label: 'less time spent editing' },
  defaultDurationMs: 3000,
  minDurationMs: 1500,
  maxDurationMs: 10000,
  layout(p, { s, d, out }) {
    const count = Math.min(1.2, Math.max(0.6, d * 0.4));
    const digits = `${p.prefix ?? ''}${p.value}${p.suffix ?? ''}`;
    return {
      html: [
        `<div id="stat">${p.prefix ? `<span id="pre">${esc(p.prefix)}</span>` : ''}<span id="num">0</span>${p.suffix ? `<span id="suf">${esc(p.suffix)}</span>` : ''}</div>`,
        `<div id="bar"></div>`,
        `<p id="label">${esc(p.label)}</p>`,
      ].join(''),
      css: `
      #stat { font-size: ${px(fit(digits, s * 0.18, s * 0.08, 8))}; font-weight: 900; line-height: 1; letter-spacing: -0.02em; font-variant-numeric: tabular-nums; }
      #pre, #suf { color: ${p.accent}; }
      #bar { width: ${px(s * 0.16)}; height: ${px(Math.max(4, s * 0.012))}; margin: ${px(s * 0.045)} 0; background: ${p.accent}; border-radius: ${px(s * 0.006)}; }
      #label { margin: 0; font-size: ${px(fit(p.label, s * 0.05, s * 0.034, 30))}; opacity: 0.85; line-height: 1.3; }`,
      timeline: [
        `tl.from("#stat", { opacity: 0, y: ${Math.round(s * 0.04)}, duration: 0.4, ease: "power2.out" }, 0);`,
        `tl.to("#num", { innerText: ${p.value}, duration: ${sec(count)}, ease: "power1.out", snap: { innerText: 1 } }, 0.1);`,
        `tl.from("#bar", { scaleX: 0, duration: 0.4, ease: "power2.inOut" }, 0.3);`,
        `tl.from("#label", { opacity: 0, y: ${Math.round(s * 0.02)}, duration: 0.4, ease: "power2.out" }, 0.4);`,
        `tl.to("#card", { opacity: 0, duration: ${sec(Math.min(0.4, out))}, ease: "power1.in" }, ${sec(out)});`,
      ],
    };
  },
});

const socialProof = define({
  id: 'social-proof',
  name: 'Social proof',
  description:
    'A star rating popping in, a short customer quote and who said it, with an optional stats line ("4.9 · 2,300 reviews"). Use it as the proof beat of an ad, before the offer or end card.',
  params: z.object({
    quote: z.string().trim().min(1).max(120).describe('the review, short, e.g. "I got my Sundays back."'),
    name: z.string().trim().min(1).max(40).optional().describe('who said it, e.g. "Maria, podcaster"'),
    rating: z.number().int().min(1).max(5).default(5).describe('stars, 1-5'),
    stats: z.string().trim().min(1).max(40).optional().describe('a stats line, e.g. "4.9 · 2,312 reviews"'),
    ...Style,
  }),
  example: { quote: 'I got my Sundays back.', name: 'Maria, podcaster', stats: '4.9 · 2,312 reviews' },
  defaultDurationMs: 3500,
  minDurationMs: 1500,
  maxDurationMs: 10000,
  layout(p, { s, out }) {
    const stars = Array.from({ length: p.rating }, () => '<span class="st">\u2605</span>').join('');
    return {
      html: [
        `<div id="stars">${stars}</div>`,
        `<p id="quote">\u201C${esc(p.quote)}\u201D</p>`,
        p.name ? `<div id="name">${esc(p.name)}</div>` : '',
        p.stats ? `<div id="stats">${esc(p.stats)}</div>` : '',
      ].join(''),
      css: `
      #stars { font-size: ${px(s * 0.07)}; color: ${p.accent}; letter-spacing: ${px(s * 0.012)}; }
      .st { display: inline-block; }
      #quote { margin: ${px(s * 0.045)} 0 0; font-size: ${px(fit(p.quote, s * 0.075, s * 0.042))}; font-weight: 700; line-height: 1.25; }
      #name { margin-top: ${px(s * 0.035)}; font-size: ${px(s * 0.038)}; opacity: 0.8; }
      #stats { margin-top: ${px(s * 0.05)}; padding: ${px(s * 0.014)} ${px(s * 0.04)}; border-radius: ${px(s * 0.1)}; background: ${shade(p.background, 0.12)}; font-size: ${px(s * 0.032)}; font-weight: 700; letter-spacing: 0.04em; }`,
      timeline: [
        `tl.from(".st", { opacity: 0, scale: 0, duration: 0.3, ease: "back.out(2.5)", stagger: 0.08 }, 0);`,
        `tl.from("#quote", { opacity: 0, y: ${Math.round(s * 0.03)}, duration: 0.5, ease: "power2.out" }, 0.4);`,
        p.name ? `tl.from("#name", { opacity: 0, duration: 0.4, ease: "none" }, 0.75);` : '',
        p.stats
          ? `tl.from("#stats", { opacity: 0, y: ${Math.round(s * 0.02)}, duration: 0.4, ease: "power2.out" }, 0.9);`
          : '',
        `tl.to("#card", { opacity: 0, duration: ${sec(Math.min(0.4, out))}, ease: "power1.in" }, ${sec(out)});`,
      ].filter(Boolean),
    };
  },
});

export const TEMPLATES: readonly TemplateDef[] = [
  titleCard,
  chapter,
  quote,
  bullets,
  endCard,
  hook,
  offer,
  stat,
  socialProof,
];

export const templateById = (id: string): TemplateDef | undefined => TEMPLATES.find((t) => t.id === id);

/** How the template is listed: its params as JSON Schema (as the caller writes them, defaults optional). */
export function describeTemplate(t: TemplateDef) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    params: z.toJSONSchema(t.params, { io: 'input' }) as Record<string, unknown>,
    example: t.example as Record<string, unknown>,
    defaultDurationMs: t.defaultDurationMs,
    minDurationMs: t.minDurationMs,
    maxDurationMs: t.maxDurationMs,
    aspects: [],
  };
}

const FONT =
  '"Inter", "SF Pro Display", -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Liberation Sans", "DejaVu Sans", sans-serif';

export interface Composition {
  html: string;
  durationMs: number;
}

/**
 * The page HyperFrames renders. `params` must already be parsed by the template's schema;
 * `gsap` is the page-relative path of gsap.min.js.
 */
export function compose(
  t: TemplateDef,
  params: Record<string, unknown>,
  f: Frame,
  gsap: string,
): Composition {
  const portrait = f.height > f.width;
  // a tall frame has room to spare: text a little larger than the short side alone gives
  const s = Math.min(f.width, f.height) * (portrait ? 1.2 : 1);
  const d = f.durationMs / 1000;
  const ctx: Ctx = { s, portrait, d, out: Math.max(0, d - Math.min(0.4, d * 0.2)) };
  const l = t.layout(params as never, ctx);
  const p = params as { background: string; color: string };
  const left = l.align === 'left';
  const pad = Math.min(f.width, f.height) * (portrait ? 0.09 : 0.12);
  const html = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=${f.width}, height=${f.height}" />
    <title>${esc(t.name)}</title>
    <script src="${esc(gsap)}"></script>
    <style>
      body { margin: 0; background: ${p.background}; }
      #root { position: relative; width: ${f.width}px; height: ${f.height}px; overflow: hidden; background: radial-gradient(ellipse at 30% 20%, ${shade(p.background, 0.1)} 0%, ${p.background} 65%); color: ${p.color}; font-family: ${FONT}; }
      #card { position: absolute; inset: 0; box-sizing: border-box; padding: 0 ${px(pad)}; display: flex; flex-direction: column; justify-content: center; align-items: ${left ? 'flex-start' : 'center'}; text-align: ${left ? 'left' : 'center'}; text-wrap: balance; }
${l.css}
    </style>
  </head>
  <body>
    <div id="root" data-composition-id="main" data-start="0" data-duration="${sec(d)}" data-width="${f.width}" data-height="${f.height}" data-fps="${f.fps}">
      <div id="card">${l.html}</div>
    </div>
    <script>
      // Seekable: HyperFrames scrubs this timeline to each frame's time and captures it.
      window.__timelines = window.__timelines || {};
      (function () {
        var tl = gsap.timeline({ paused: true });
${l.timeline.map((x) => `        ${x}`).join('\n')}
        // hold the last frame to the end
        tl.set({}, {}, ${sec(d)});
        window.__timelines.main = tl;
      })();
    </script>
  </body>
</html>
`;
  return { html, durationMs: f.durationMs };
}
