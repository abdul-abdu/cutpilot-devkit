/**
 * The tools each plugin kind must offer, with their input and output schemas. The engine
 * calls them; the SDK checks a plugin's answers against them before they leave the plugin.
 * Times are integer milliseconds in SOURCE time, as everywhere in CutPilot.
 */
import { z } from 'zod';
import type { PluginKind } from './manifest.js';

const Ms = z.number().int().nonnegative();
const Fraction = z.number().min(0).max(1);
const Path = z.string().min(1);

// ── transcriber ──────────────────────────────────────────────────────────────

export const TranscribeInputSchema = z.object({
  /** 16 kHz mono wav made by the engine */
  audio: Path,
  /** ISO 639-1 code (en, ru, uz, …) or `auto` */
  language: z.string().regex(/^([a-z]{2,3}|auto)$/),
  /** words to expect (names, jargon) */
  prompt: z.string().max(2000).optional(),
});

export const TranscribedWordSchema = z
  .object({
    /** as spoken, with its punctuation attached (`Hello,`) */
    text: z.string().min(1),
    start: Ms,
    end: Ms,
    confidence: Fraction.optional(),
    /** a non-speech event such as (laughs) or [music] */
    event: z.boolean().optional(),
  })
  .refine((w) => w.end >= w.start, { message: 'a word ends at or after its start', path: ['end'] });

export const TranscribeOutputSchema = z.object({
  /** the language heard (ISO 639-1) */
  language: z.string().regex(/^[a-z]{2,3}$/),
  words: z.array(TranscribedWordSchema).superRefine((ws, ctx) => {
    for (let i = 1; i < ws.length; i++)
      if (ws[i]!.start < ws[i - 1]!.start)
        ctx.addIssue({ code: 'custom', message: 'words are in time order', path: [i, 'start'] });
  }),
});

// ── analyzer: reframe-track ──────────────────────────────────────────────────

/** Same names as core's ASPECT_NAMES (plugin-api imports nothing from core; the engine tests keep them equal). */
export const ASPECTS = ['9:16', '16:9', '1:1', '4:5', '4:3'] as const;

export const ReframeTrackInputSchema = z.object({
  /** the source video (never modified) */
  source: Path,
  aspect: z.enum(ASPECTS),
  /** the kept parts of the edit, in source time; only these need a track */
  ranges: z
    .array(z.object({ start: Ms, end: Ms }).refine((r) => r.end > r.start, 'a range ends after it starts'))
    .min(1),
  /** frames to look at per second (the plugin may choose) */
  sampleFps: z.number().positive().max(30).optional(),
});

export const KeyframeSchema = z.object({
  /** source time */
  t: Ms,
  /** crop centre as a fraction of the source frame */
  x: Fraction,
  y: Fraction,
});
export type Keyframe = z.infer<typeof KeyframeSchema>;

export const ReframeTrackOutputSchema = z.object({
  keyframes: z
    .array(KeyframeSchema)
    .min(1)
    .superRefine((ks, ctx) => {
      for (let i = 1; i < ks.length; i++)
        if (ks[i]!.t <= ks[i - 1]!.t)
          ctx.addIssue({ code: 'custom', message: 'keyframe times strictly increase', path: [i, 't'] });
    }),
  /** how sure the plugin is about what it followed, 0..1 */
  confidence: Fraction.optional(),
});

// ── asset: music ─────────────────────────────────────────────────────────────

export const FindMusicInputSchema = z.object({
  /** e.g. calm, upbeat, inspiring */
  mood: z.string().min(1).max(40).optional(),
  query: z.string().min(1).max(200).optional(),
  /** the output length the music has to cover (looping is fine if the track says so) */
  minDurationMs: Ms.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

export const MusicTrackSchema = z.object({
  id: z.string().min(1).max(200),
  title: z.string().min(1).max(200),
  moods: z.array(z.string().min(1)).default([]),
  bpm: z.number().positive().optional(),
  durationMs: Ms.refine((d) => d > 0, 'a track has a length'),
  /** loops without an audible seam */
  loopable: z.boolean(),
  /** e.g. "CC0", "Licensed for use in CutPilot projects" */
  license: z.string().min(1),
  /** the credit line to show, if the license asks for one */
  attribution: z.string().min(1).optional(),
});

export const FindMusicOutputSchema = z.object({ tracks: z.array(MusicTrackSchema) });

export const GetMusicInputSchema = z.object({ id: z.string().min(1) });

export const GetMusicOutputSchema = z.object({
  /** absolute path of an audio file the engine may copy */
  file: Path,
  durationMs: Ms,
  license: z.string().min(1),
  attribution: z.string().min(1).optional(),
});

// ── generator ────────────────────────────────────────────────────────────────
// A generator makes a clip from a template: a title card, a chapter heading, an end card. The
// engine asks for it at the timeline's output size and puts it in the edit as an insert (a
// clip that plays between two moments of the source); the plugin never sees the timeline.

/** kebab-case, like title-card */
export const TemplateIdSchema = z
  .string()
  .max(40)
  .regex(/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/, 'template ids are kebab-case, like title-card');

/** A clip's frame size: even, as encoders want it. */
const EvenPx = z
  .number()
  .int()
  .min(16)
  .max(7680)
  .refine((n) => n % 2 === 0, 'sizes are even numbers of pixels');

const Positive = Ms.refine((d) => d > 0, 'a clip has a length');

export const ListTemplatesInputSchema = z.object({
  /** only the templates made for this output aspect (and those made for any) */
  aspect: z.enum(ASPECTS).optional(),
});

export const TemplateSchema = z
  .object({
    id: TemplateIdSchema,
    name: z.string().min(1).max(60),
    /** what it shows and when it fits, for the AI choosing one */
    description: z.string().min(1).max(500),
    /** the template's parameters as a JSON Schema of type object (z.toJSONSchema makes one) */
    params: z
      .record(z.string(), z.unknown())
      .refine((s) => s.type === 'object', 'params is a JSON Schema with "type": "object"'),
    /** parameters that make a good example; the test harness renders with them */
    example: z.record(z.string(), z.unknown()).default({}),
    defaultDurationMs: Positive,
    minDurationMs: Positive.optional(),
    maxDurationMs: Positive.optional(),
    /** the aspects it is laid out for; empty: any */
    aspects: z.array(z.enum(ASPECTS)).default([]),
  })
  .superRefine((t, ctx) => {
    const min = t.minDurationMs ?? 0;
    const max = t.maxDurationMs ?? Infinity;
    if (min > max)
      ctx.addIssue({
        code: 'custom',
        message: 'minDurationMs is at most maxDurationMs',
        path: ['minDurationMs'],
      });
    else if (t.defaultDurationMs < min || t.defaultDurationMs > max)
      ctx.addIssue({
        code: 'custom',
        message: 'defaultDurationMs is between minDurationMs and maxDurationMs',
        path: ['defaultDurationMs'],
      });
  });
export type Template = z.infer<typeof TemplateSchema>;

export const ListTemplatesOutputSchema = z.object({
  templates: z.array(TemplateSchema).superRefine((ts, ctx) => {
    const seen = new Set<string>();
    ts.forEach((t, i) => {
      if (seen.has(t.id))
        ctx.addIssue({ code: 'custom', message: `template ${t.id} is listed twice`, path: [i, 'id'] });
      seen.add(t.id);
    });
  }),
});

export const GenerateInputSchema = z.object({
  template: TemplateIdSchema,
  /** checked by the plugin against the template's params schema */
  params: z.record(z.string(), z.unknown()).default({}),
  /** the output canvas of the timeline the clip goes into */
  width: EvenPx,
  height: EvenPx,
  fps: z.number().positive().max(120),
  /** default: the template's */
  durationMs: Positive.optional(),
});

export const GenerateOutputSchema = z.object({
  /** absolute path of the rendered clip (an MP4 the engine copies into the project) */
  file: Path,
  durationMs: Positive,
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  hasAudio: z.boolean(),
});

// ── asset: sound ─────────────────────────────────────────────────────────────
// A sound plugin makes audio from a description: a sound effect ("a door creaks open"), music
// ("calm piano, 20 seconds") or spoken text (a voice-over). The engine puts the file into a
// generated clip or a project asset; the plugin never sees the timeline.

export const SOUND_KINDS = ['sfx', 'music', 'speech'] as const;
export type SoundKind = (typeof SOUND_KINDS)[number];

/** ISO 639-1 (en, ru, uz), with an optional region (pt-br) */
export const LanguageTagSchema = z
  .string()
  .regex(/^[a-z]{2,3}(-[a-z]{2,4})?$/, 'a language tag like en or pt-br');

export const ListVoicesInputSchema = z.object({
  /** only voices that speak this language; default: all */
  language: LanguageTagSchema.optional(),
});

export const VoiceSchema = z.object({
  /** what `generate_sound.voice` takes, e.g. F1 or af_heart */
  id: z.string().min(1).max(60),
  /** a name to show, e.g. "Female 1" */
  name: z.string().min(1).max(60),
  /** the languages it speaks; empty: any the plugin lists in `languages` */
  languages: z.array(LanguageTagSchema).default([]),
  /** a few words for the AI choosing one: "warm, low, narrator" */
  description: z.string().max(200).optional(),
});
export type Voice = z.infer<typeof VoiceSchema>;

export const ListVoicesOutputSchema = z.object({
  voices: z.array(VoiceSchema),
  /** the languages speech can be made in */
  languages: z.array(LanguageTagSchema).default([]),
});

export const GenerateSoundInputSchema = z
  .object({
    kind: z.enum(SOUND_KINDS),
    /** sfx and music: what it sounds like, in English; speech: how to say it (optional) */
    prompt: z.string().max(1000).optional(),
    /** speech: the words to say */
    text: z.string().max(5000).optional(),
    /** speech: the language of the text; default: the plugin's */
    language: LanguageTagSchema.optional(),
    /** speech: a voice id from list_voices; default: the plugin's */
    voice: z.string().min(1).max(60).optional(),
    /** sfx and music: how long; speech: ignored, the words set the length */
    durationMs: Positive.max(600_000).optional(),
    /** the same request with the same seed gives the same sound */
    seed: z.number().int().nonnegative().optional(),
  })
  .superRefine((a, ctx) => {
    if (a.kind === 'speech' && !a.text?.trim())
      ctx.addIssue({ code: 'custom', message: 'speech needs the text to say', path: ['text'] });
    if (a.kind !== 'speech' && !a.prompt?.trim())
      ctx.addIssue({ code: 'custom', message: `${a.kind} needs a prompt`, path: ['prompt'] });
  });

export const GenerateSoundOutputSchema = z.object({
  /** absolute path of an audio file (wav, m4a, mp3…) the engine copies */
  file: Path,
  durationMs: Positive,
  sampleRate: z.number().int().positive(),
  channels: z.number().int().min(1).max(2),
  /** e.g. "Stability AI Community License", "Apache-2.0" */
  license: z.string().min(1),
  /** the credit line to show, if the license asks for one */
  attribution: z.string().min(1).optional(),
  /** the model that made it, e.g. "Stable Audio 3 Small SFX" */
  model: z.string().min(1).max(100).optional(),
});

// ── the contract table ───────────────────────────────────────────────────────

export interface ToolContract<I extends z.ZodType = z.ZodType, O extends z.ZodType = z.ZodType> {
  description: string;
  input: I;
  output: O;
}

export const KIND_TOOLS = {
  transcriber: {
    transcribe: {
      description: 'Transcribe a 16 kHz mono wav into timed words.',
      input: TranscribeInputSchema,
      output: TranscribeOutputSchema,
    },
  },
  'analyzer:reframe-track': {
    reframe_track: {
      description: 'Where to centre the crop over time (keyframes in source time) for the given aspect.',
      input: ReframeTrackInputSchema,
      output: ReframeTrackOutputSchema,
    },
  },
  'asset:music': {
    find_music: {
      description: 'Music tracks that fit a mood or query.',
      input: FindMusicInputSchema,
      output: FindMusicOutputSchema,
    },
    get_music: {
      description: 'The audio file of one track.',
      input: GetMusicInputSchema,
      output: GetMusicOutputSchema,
    },
  },
  generator: {
    list_templates: {
      description: 'The templates this generator can render, with their parameters as JSON Schema.',
      input: ListTemplatesInputSchema,
      output: ListTemplatesOutputSchema,
    },
    generate: {
      description: 'Render one template with its parameters to a clip of the given size, fps and length.',
      input: GenerateInputSchema,
      output: GenerateOutputSchema,
    },
  },
  'asset:sound': {
    list_voices: {
      description: 'The voices speech can be made with, and the languages they speak.',
      input: ListVoicesInputSchema,
      output: ListVoicesOutputSchema,
    },
    generate_sound: {
      description: 'Make a sound effect or music from a prompt, or speech from text; returns an audio file.',
      input: GenerateSoundInputSchema,
      output: GenerateSoundOutputSchema,
    },
  },
  // data only: CutPilot reads its catalogues and never starts it (language.ts)
  language: {},
} as const satisfies Record<PluginKind, Record<string, ToolContract>>;

/** Tool names a plugin must offer for its kinds. */
export const contractTools = (kinds: readonly PluginKind[]): string[] =>
  kinds.flatMap((k) => Object.keys(KIND_TOOLS[k]));

/** Names reserved for the kinds; extra tools can't use them. */
export const CONTRACT_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.values(KIND_TOOLS).flatMap((t) => Object.keys(t)),
);

/** snake_case, and short enough that `<id>__<tool>` stays within MCP's 64 characters */
export const EXTRA_TOOL_NAME_RE = /^[a-z][a-z0-9_]*$/;
export const MAX_EXPORTED_TOOL_NAME = 64;

/** The name AI clients see for a plugin's extra tool. */
export const exportedToolName = (pluginId: string, tool: string) => `${pluginId}__${tool}`;

/** Why an extra tool can't be offered to AI clients, or null when it can. */
export function extraToolProblem(pluginId: string, tool: string): string | null {
  if (!EXTRA_TOOL_NAME_RE.test(tool))
    return `tool ${JSON.stringify(tool)}: names are snake_case, like suggest_titles`;
  if (CONTRACT_TOOL_NAMES.has(tool))
    return `tool ${tool}: that name belongs to a plugin kind; declare the kind instead`;
  const name = exportedToolName(pluginId, tool);
  if (name.length > MAX_EXPORTED_TOOL_NAME)
    return `tool ${tool}: ${name} is longer than ${MAX_EXPORTED_TOOL_NAME} characters; shorten the tool or plugin id`;
  return null;
}
