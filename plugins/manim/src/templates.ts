/**
 * The templates as the AI sees them: each is a zod schema for its parameters, an example and its
 * lengths. The drawing is Python (python/nodcut_manim.py, one function per template id), so
 * the schemas here are the only check the parameters get before Manim runs: keep them as strict
 * as the Python expects. Pure: no files, no Manim.
 */
import { z } from 'zod';

const Hex = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'colours look like #RRGGBB');

/** Colours every template takes (custom-scene only the background). */
const Style = {
  background: Hex.default('#0f172a').describe('background colour, #RRGGBB'),
  color: Hex.default('#ffffff').describe('text and axis colour, #RRGGBB'),
  accent: Hex.default('#58c4dd').describe('colour of the curve, bars, underline and highlights, #RRGGBB'),
};

/** The functions and constants a function-plot expression may use (as Python's math has them). */
export const EXPRESSION_NAMES = [
  'sin',
  'cos',
  'tan',
  'atan',
  'sinh',
  'cosh',
  'tanh',
  'exp',
  'log',
  'sqrt',
  'abs',
  'pi',
  'e',
  'x',
] as const;

/**
 * Why an expression in x can't be plotted, or null when it can: only numbers, x, + - * / ^ % **,
 * brackets and EXPRESSION_NAMES. The Python side checks the same with its parser.
 */
export function expressionProblem(src: string): string | null {
  if (!/^[\d\s.+\-*/^%(),a-z]+$/i.test(src))
    return 'use only numbers, x, + - * / ^, brackets and functions like sin(x)';
  for (const name of src.match(/[a-z_][a-z0-9_]*/gi) ?? [])
    if (!(EXPRESSION_NAMES as readonly string[]).includes(name))
      return `${name} is not known; use x and ${EXPRESSION_NAMES.filter((n) => n !== 'x').join(', ')}`;
  let depth = 0;
  for (const c of src) {
    depth += c === '(' ? 1 : c === ')' ? -1 : 0;
    if (depth < 0) break;
  }
  return depth === 0 ? null : 'the brackets do not match';
}

export interface TemplateDef<S extends z.ZodRawShape = z.ZodRawShape> {
  id: string;
  name: string;
  description: string;
  params: z.ZodType<z.output<z.ZodObject<S>>, z.input<z.ZodObject<S>>>;
  example: z.input<z.ZodObject<S>>;
  defaultDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  /** renders with LaTeX (MathTex), which Manim runs as `latex` and `dvisvgm` */
  latex?: boolean;
}

const define = <S extends z.ZodRawShape>(t: TemplateDef<S>): TemplateDef => t as unknown as TemplateDef;

// ── templates ────────────────────────────────────────────────────────────────

const title = define({
  id: 'title',
  name: 'Title',
  description:
    'A title written on stroke by stroke, Manim style, with an accent underline and an optional subtitle. Use it to open an explainer or between topics.',
  params: z.object({
    title: z.string().trim().min(1).max(80).describe('the title, e.g. "The Fourier transform"'),
    subtitle: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .optional()
      .describe('a line under it, e.g. "in three minutes"'),
    ...Style,
  }),
  example: { title: 'The Fourier transform', subtitle: 'in three minutes' },
  defaultDurationMs: 3000,
  minDurationMs: 1000,
  maxDurationMs: 10000,
});

const functionPlot = define({
  id: 'function-plot',
  name: 'Function plot',
  description:
    'Axes, then the graph of y = f(x) drawn from left to right with a dot tracing it, and an optional label above. For a formula the video talks about, a growth curve, a wave.',
  params: z
    .object({
      expression: z
        .string()
        .trim()
        .min(1)
        .max(120)
        .superRefine((s, ctx) => {
          const problem = expressionProblem(s);
          if (problem) ctx.addIssue({ code: 'custom', message: problem });
        })
        .describe(
          `f(x) in x, e.g. "sin(x) * x^2 / 10"; numbers, + - * / ^, brackets and ${EXPRESSION_NAMES.filter((n) => n !== 'x').join(', ')}`,
        ),
      xMin: z.number().default(-5).describe('left end of the x axis, e.g. -5'),
      xMax: z.number().default(5).describe('right end of the x axis, e.g. 5'),
      yMin: z.number().optional().describe('bottom of the y axis; leave out (with yMax) to fit the curve'),
      yMax: z.number().optional().describe('top of the y axis; leave out (with yMin) to fit the curve'),
      label: z
        .string()
        .trim()
        .min(1)
        .max(60)
        .optional()
        .describe('a line above the plot, e.g. "y = x² sin x"'),
      ...Style,
    })
    .refine((p) => p.xMin < p.xMax, { message: 'xMin is less than xMax', path: ['xMax'] })
    .refine((p) => (p.yMin === undefined) === (p.yMax === undefined), {
      message: 'give both yMin and yMax, or neither',
      path: ['yMax'],
    })
    .refine((p) => p.yMin === undefined || p.yMin < p.yMax!, {
      message: 'yMin is less than yMax',
      path: ['yMax'],
    }),
  example: { expression: 'sin(x) * x^2 / 10', xMin: -6, xMax: 6, label: 'y = x² sin x / 10' },
  defaultDurationMs: 5000,
  minDurationMs: 2000,
  maxDurationMs: 20000,
});

const barChart = define({
  id: 'bar-chart',
  name: 'Bar chart',
  description:
    'Bars growing from the baseline one after another, with their labels under them and values on top, and an optional title. For two to eight numbers worth comparing: revenue by year, votes by option.',
  params: z.object({
    title: z.string().trim().min(1).max(60).optional().describe('a title above the chart, e.g. "Revenue"'),
    items: z
      .array(
        z.object({
          label: z.string().trim().min(1).max(20).describe('under the bar, e.g. "2024"'),
          value: z.number().min(0).describe("the bar's height, e.g. 30; bars scale to the largest"),
        }),
      )
      .min(1)
      .max(8)
      .describe('the bars, left to right'),
    unit: z.string().max(6).default('').describe('after each value, e.g. "k" or "%"'),
    ...Style,
  }),
  example: {
    title: 'Revenue',
    items: [
      { label: '2023', value: 12 },
      { label: '2024', value: 30 },
      { label: '2025', value: 48 },
    ],
    unit: 'k',
  },
  defaultDurationMs: 5000,
  minDurationMs: 2000,
  maxDurationMs: 20000,
});

const morphText = define({
  id: 'morph-text',
  name: 'Morphing text',
  description:
    'One word or short phrase written on, then its letters fly into place to become another (an anagram looks best: "listen" → "silent"). For a reveal, a before/after, a renamed idea.',
  params: z.object({
    from: z.string().trim().min(1).max(40).describe('the first text, e.g. "listen"'),
    to: z.string().trim().min(1).max(40).describe('what it becomes, e.g. "silent"'),
    ...Style,
  }),
  example: { from: 'listen', to: 'silent' },
  defaultDurationMs: 4000,
  minDurationMs: 2000,
  maxDurationMs: 12000,
});

const equation = define({
  id: 'equation',
  name: 'Equation',
  description:
    'A LaTeX equation written on, with an optional caption under it and an optional highlight around it. Needs LaTeX on the machine (the doctor tool says whether it is there).',
  params: z.object({
    latex: z
      .string()
      .trim()
      .min(1)
      .max(300)
      .describe('the equation in LaTeX math mode, without $…$, e.g. "e^{i\\pi} + 1 = 0"'),
    caption: z
      .string()
      .trim()
      .min(1)
      .max(80)
      .optional()
      .describe('a line under it, e.g. "Euler\'s identity"'),
    highlight: z.boolean().default(false).describe('draw an accent line around it once written'),
    ...Style,
  }),
  example: { latex: 'e^{i\\pi} + 1 = 0', caption: "Euler's identity", highlight: true },
  defaultDurationMs: 4000,
  minDurationMs: 1500,
  maxDurationMs: 15000,
  latex: true,
});

export const SCENE_CODE_MAX = 50_000;

const customScene = define({
  id: 'custom-scene',
  name: 'Custom Manim scene',
  description:
    'Your own Manim Community scene in Python: anything Manim can draw. Call the scene_guide tool first for the rules (size, length, what is available). The clip is padded with its last frame to durationMs, or runs longer if the scene does.',
  params: z.object({
    code: z
      .string()
      .min(1)
      .max(SCENE_CODE_MAX)
      .describe(
        'a Python file: `from manim import *` and a class extending Scene (or MovingCameraScene, ThreeDScene, …) with construct(); see scene_guide',
      ),
    sceneName: z
      .string()
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'a Python class name')
      .optional()
      .describe('the class to render when the code has several; default: the last Scene class'),
    background: Hex.optional().describe("background colour, #RRGGBB; default: the scene's own (black)"),
  }),
  example: {
    code: [
      'from manim import *',
      '',
      'class SquareToCircle(Scene):',
      '    def construct(self):',
      '        square = Square(color=BLUE, fill_opacity=0.5)',
      '        self.play(Create(square))',
      '        self.play(Transform(square, Circle(color=YELLOW, fill_opacity=0.5)))',
      '',
    ].join('\n'),
  },
  defaultDurationMs: 6000,
  minDurationMs: 500,
  maxDurationMs: 120_000,
});

/** In the order list_templates gives them; the first is what testPlugin renders by default. */
export const TEMPLATES: TemplateDef[] = [title, functionPlot, barChart, morphText, equation, customScene];

export const templateById = (id: string) => TEMPLATES.find((t) => t.id === id);

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
