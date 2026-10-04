/**
 * scaffoldPlugin(): a new plugin folder that works before its author changes a line — the
 * manifest, a TypeScript `definePlugin()` with placeholder logic for its kind, a test that runs
 * `testPlugin()`, a standalone package.json and tsconfig, a README, an AGENTS.md with the rules for
 * coding agents, and a .gitignore. The sources
 * come from this package's `template/` folder; this file writes the rest.
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import {
  CONTRACT_VERSION,
  KIND_READS,
  KIND_TOOLS,
  MANIFEST_FILE,
  PluginIdSchema,
  type PluginKind,
} from '@nodcut/plugin-api';

/** What `nodcut-plugin new --kind` takes: friendly names for the manifest's kinds. */
export const SCAFFOLD_KINDS = {
  /** extra tools only: `suggest_titles` */
  tools: null,
  transcriber: 'transcriber',
  'reframe-track': 'analyzer:reframe-track',
  music: 'asset:music',
  sound: 'asset:sound',
  generator: 'generator',
} as const satisfies Record<string, PluginKind | null>;
export type ScaffoldKind = keyof typeof SCAFFOLD_KINDS;

export interface ScaffoldOptions {
  /** the new plugin's folder; created if missing, refused if not empty */
  dir: string;
  /** the manifest id: kebab-case, at most 40 characters */
  id: string;
  /** shown in NodCut; default: the id in words ("my-titles" → "My Titles") */
  name?: string;
  /** a friendly name (`music`) or a manifest kind (`asset:music`); default `tools` */
  kind?: ScaffoldKind | PluginKind;
  /**
   * the version spec of the `@nodcut/plugin-sdk` dependency: default `^<this SDK's version>`;
   * a `file:` path or a tarball to build against a local SDK before it's on npm
   */
  sdk?: string;
}

export interface ScaffoldResult {
  dir: string;
  id: string;
  name: string;
  kind: ScaffoldKind;
  /** the files written, relative to `dir` */
  files: string[];
}

/** A request scaffoldPlugin() refuses; `fix` says what to do instead. */
export class ScaffoldError extends Error {
  constructor(
    message: string,
    readonly fix: string,
  ) {
    super(message);
  }
}

/**
 * The tools the template's package.json installs, in step with this repo's own (a test keeps
 * them equal), so a new plugin builds and tests with what the SDK is tested with.
 */
export const TEMPLATE_DEV_DEPENDENCIES = {
  '@types/node': '^22.20.4',
  typescript: '~5.9.3',
  vitest: '^5.0.1',
};

/** The engine versions a new plugin asks for: the first NodCut that passes plugins their settings. */
export const TEMPLATE_NODCUT_RANGE = '>=0.2.0-beta.10';

const PKG = new URL('../', import.meta.url);
const TEMPLATE = new URL('template/', PKG);

/** This SDK's version, from its package.json. */
export function sdkVersion(): string {
  return (JSON.parse(readFileSync(new URL('package.json', PKG), 'utf8')) as { version: string }).version;
}

const titleCase = (id: string) =>
  id
    .split('-')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');

/** A friendly kind or a manifest kind → the friendly one. */
export function scaffoldKind(kind: string): ScaffoldKind {
  if (kind in SCAFFOLD_KINDS) return kind as ScaffoldKind;
  const found = (Object.keys(SCAFFOLD_KINDS) as ScaffoldKind[]).find((k) => SCAFFOLD_KINDS[k] === kind);
  if (found) return found;
  throw new ScaffoldError(
    `there is no plugin kind ${JSON.stringify(kind)}`,
    `use one of ${Object.keys(SCAFFOLD_KINDS).join(', ')}`,
  );
}

const DESCRIPTIONS: Record<ScaffoldKind, string> = {
  tools: 'Suggests titles for a video from its transcript.',
  transcriber: 'Turns speech into timed words for NodCut.',
  'reframe-track': 'Decides where a vertical crop should look, over time.',
  music: 'Background music for NodCut edits.',
  sound: 'Sound effects, music and speech made from a description.',
  generator: 'Clips made from templates, at the size of the edit.',
};

const WHAT: Record<ScaffoldKind, string> = {
  tools:
    'An extra tool, `suggest_titles`: AI clients connected to NodCut see it as `<id>__suggest_titles` and call it with a transcript. The placeholder builds titles around the words said most; put your own logic (or a model call) in `src/plugin.ts`.',
  transcriber:
    'A **transcriber**: NodCut sends a 16 kHz mono wav and gets timed words back (`transcribe`). The placeholder spreads a fixed sentence over the audio; put real speech recognition in `src/plugin.ts`.',
  'reframe-track':
    'A **reframe analyzer** (`analyzer:reframe-track`): for a vertical (or other) crop of a wider video, it says where the crop is centred over time (`reframe_track`). The placeholder keeps it centred; put your tracking in `src/plugin.ts`.',
  music:
    'A **music source** (`asset:music`): `find_music` lists tracks for a mood or query, `get_music` hands over the file of one. The placeholder catalogue is two generated tones; put your music in `src/plugin.ts`.',
  sound:
    'A **sound maker** (`asset:sound`): `list_voices`, and `generate_sound` for an effect or music from a prompt, or speech from text. The placeholder beeps; put your model or service in `src/plugin.ts`.',
  generator:
    'A **generator**: `list_templates` and `generate`, which renders a template to an MP4 at the size, frame rate and length NodCut asks for. The placeholder renders a plain colour card with ffmpeg (which must be on PATH); put your renderer in `src/plugin.ts`.',
};

/** How the AI gets to the plugin once it's installed. */
const USE: Record<ScaffoldKind, (id: string) => string> = {
  tools: (id) =>
    `Then ask your AI for title ideas: it sees the tool as \`${id}__suggest_titles\` (\`nodcut plugin list\` shows it).`,
  transcriber: (id) =>
    `Then ask your AI to open a video with it: NodCut's \`open_project\` takes \`transcriber: "${id}"\`.`,
  'reframe-track': () =>
    "Then ask your AI for a vertical version that follows the speaker: NodCut's `set_reframe` asks this plugin for the crop track.",
  music: () =>
    "Then ask your AI for background music: NodCut's `find_music` and `set_music` use this plugin.",
  sound: () => 'Then ask your AI for a sound effect or a voice-over: NodCut asks this plugin to make it.',
  generator: () =>
    "Then ask your AI for a title card: NodCut's `list_templates` and `add_insert` use this plugin's templates.",
};

function readme(id: string, name: string, kind: ScaffoldKind): string {
  const tools = SCAFFOLD_KINDS[kind] ? Object.keys(KIND_TOOLS[SCAFFOLD_KINDS[kind]]) : ['suggest_titles'];
  return `# ${name}

A [NodCut](https://github.com/abdul-abdu/nodcut) plugin. ${WHAT[kind]}

Tools: ${tools.map((t) => `\`${t}\``).join(', ')}.

## Develop

Requirements: Node 22+.

\`\`\`sh
npm install
npm run build        # src/ → dist/ (NodCut runs node dist/index.js)
npm test             # builds, then runs testPlugin(): the plugin started and called the way NodCut does
npx nodcut-plugin validate .   # the manifest, icon and command, without starting anything
npx nodcut-plugin test .       # after a build: start it and call its tools, printed as ✓ / ✗ with fixes
\`\`\`

- \`nodcut-plugin.json\`: what the plugin is (id, name, version, kinds), what it may access (\`permissions\`: network hosts, secrets such as API keys, the files it reads) and its \`settings\`.
- \`src/plugin.ts\`: the handlers, \`src/index.ts\` starts them, \`src/index.test.ts\` tests them.

## Try it in NodCut

\`\`\`sh
npm run build
nodcut plugin install . --link   # NodCut runs it from this folder; rebuild to update it
nodcut plugin list
\`\`\`

${USE[kind](id)}

To share it, pack it into one file:

\`\`\`sh
npm run build
npm prune --omit=dev     # a package holds the folder as it is: keep only what runs
nodcut plugin pack     # writes ${id}-<version>.nodcut-plugin
\`\`\`

It installs with \`nodcut plugin install <file>\`, or NodCut → Plugins → Install from file… (or drop it on the app). A package can't hold links, so build against an SDK installed from npm or a tarball, not a \`file:\` folder, before you pack.

See the [plugin guide](https://github.com/abdul-abdu/nodcut-devkit/blob/main/docs/plugin-guide.md).
`;
}

/** The rules an agent working in the new plugin folder must know; written as AGENTS.md. */
function agentsMd(id: string, kind: ScaffoldKind): string {
  const manifestKind = SCAFFOLD_KINDS[kind];
  const tools = manifestKind ? Object.keys(KIND_TOOLS[manifestKind]) : [];
  const kindLine = manifestKind
    ? `Kind \`${manifestKind}\`: NodCut calls ${tools.map((t) => `\`${t}\``).join(' and ')} and checks each answer against the contract in \`@nodcut/plugin-api\` (\`KIND_TOOLS\`); a wrong shape is refused as \`E_PLUGIN_CONTRACT\`.`
    : `Extra tools only: AI clients see each tool as \`${id}__<tool>\` (snake_case, at most 64 characters together). They are read-only: they return text or data and never change an edit.`;
  return `# Agent notes

This folder is a NodCut plugin: \`nodcut-plugin.json\` (the manifest) plus an MCP server on stdio that \`src/index.ts\` starts with \`definePlugin()\` from \`@nodcut/plugin-sdk\`. NodCut starts it when needed, calls its tools, validates every answer and applies the result as an ordinary, undoable edit.

${kindLine}

## Rules the host enforces

- A plugin returns data or files; it never edits the timeline.
- Times are integer milliseconds in SOURCE time; positions are fractions 0..1 of the frame.
- Never write to stdout: it carries MCP, and a stray \`console.log\` breaks the session. Log with \`ctx.log()\` (stderr).
- Fail with \`throw new PluginFailure('E_YOUR_CODE', oneLineMessage, oneLineFix)\`: the fix names the setting, the tool to call or the thing to install. Anything else becomes a generic \`E_PLUGIN_FAILED\`.
- Report progress during long work (\`ctx.progress(0..1, message)\`) and stop when \`ctx.signal\` aborts; a silent call is timed out.
- Declare in the manifest only what is used: \`permissions.network\` (hosts), \`permissions.secrets\` (names the user enters in NodCut), \`permissions.reads\`, \`settings\`. Secrets come through \`ctx.secret()\` / \`ctx.requireSecret()\`, settings through \`ctx.settings\`.
- Files returned are absolute paths that exist; NodCut copies what it needs.
- Describe tools and every input field (\`.describe()\`, units, an example) for the weakest model that should succeed.

## Commands

\`\`\`sh
npm run build                      # src/ → dist/ (NodCut runs node dist/index.js)
npm test                           # build, then the tests, including testPlugin()
npx nodcut-plugin validate .     # the manifest, icon and command, without starting anything
npx nodcut-plugin test .         # start it the way NodCut does and call its tools (--secret NAME, --setting key=value)
nodcut plugin install . --link   # try it in NodCut (the app's command line); nodcut plugin list shows its state
\`\`\`

Before saying a change is done: \`npm test\` green, the README updated if a tool, setting or requirement changed, and \`version\` bumped in both \`nodcut-plugin.json\` and \`package.json\` when it is to be shared again.

Guide: https://github.com/abdul-abdu/nodcut-devkit/blob/main/docs/plugin-guide.md
`;
}

const json = (v: unknown) => JSON.stringify(v, null, 2) + '\n';

/** Write a new plugin folder; throws a ScaffoldError for a bad id or kind, or a folder in use. */
export function scaffoldPlugin(o: ScaffoldOptions): ScaffoldResult {
  const idCheck = PluginIdSchema.safeParse(o.id);
  if (!idCheck.success)
    throw new ScaffoldError(
      `${JSON.stringify(o.id)} can't be a plugin id: ${idCheck.error.issues[0]!.message}`,
      'use lowercase words joined by hyphens, at most 40 characters, like my-titles',
    );
  const kind = scaffoldKind(o.kind ?? 'tools');
  const manifestKind = SCAFFOLD_KINDS[kind];
  const name = o.name?.trim() || titleCase(o.id);
  if (name.length > 60) throw new ScaffoldError('the name is longer than 60 characters', 'shorten --name');
  const dir = resolve(o.dir);
  if (existsSync(dir)) {
    if (!statSync(dir).isDirectory())
      throw new ScaffoldError(`${dir} is a file`, 'choose a folder for the new plugin');
    if (readdirSync(dir).length)
      throw new ScaffoldError(`${dir} isn't empty`, 'choose a new or empty folder for the plugin');
  }

  const files: string[] = [];
  const write = (rel: string, content: string) => {
    writeFileSync(join(dir, rel), content);
    files.push(rel);
  };
  const copy = (from: URL, rel: string) => {
    copyFileSync(from, join(dir, rel));
    files.push(rel);
  };
  mkdirSync(join(dir, 'src'), { recursive: true });

  const description = DESCRIPTIONS[kind];
  write(
    MANIFEST_FILE,
    json({
      id: o.id,
      name,
      version: '0.1.0',
      description,
      contract: CONTRACT_VERSION,
      nodcut: TEMPLATE_NODCUT_RANGE,
      command: 'node',
      args: ['dist/index.js'],
      kinds: manifestKind ? [manifestKind] : [],
      permissions: { network: [], secrets: [], reads: manifestKind ? [...KIND_READS[manifestKind]] : [] },
      settings: [],
    }),
  );
  write(
    'package.json',
    json({
      name: o.id,
      version: '0.1.0',
      private: true,
      description,
      type: 'module',
      engines: { node: '>=22' },
      scripts: {
        build: 'tsc',
        test: 'tsc && vitest run',
        validate: 'nodcut-plugin validate .',
      },
      dependencies: { '@nodcut/plugin-sdk': o.sdk ?? `^${sdkVersion()}` },
      devDependencies: TEMPLATE_DEV_DEPENDENCIES,
    }),
  );
  write(
    'tsconfig.json',
    json({
      compilerOptions: {
        target: 'ES2023',
        lib: ['ES2023'],
        module: 'NodeNext',
        moduleResolution: 'NodeNext',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        isolatedModules: true,
        verbatimModuleSyntax: true,
        forceConsistentCasingInFileNames: true,
        sourceMap: true,
        rootDir: 'src',
        outDir: 'dist',
        types: ['node'],
      },
      include: ['src'],
      exclude: ['src/**/*.test.ts'],
    }),
  );
  write('.gitignore', 'node_modules/\ndist/\n*.nodcut-plugin\n*.tgz\n');
  write('README.md', readme(o.id, name, kind));
  write('AGENTS.md', agentsMd(o.id, kind));
  copy(new URL('index.ts', TEMPLATE), 'src/index.ts');
  copy(new URL(`${kind}/plugin.ts`, TEMPLATE), 'src/plugin.ts');
  copy(new URL(`${kind}/index.test.ts`, TEMPLATE), 'src/index.test.ts');
  return { dir, id: o.id, name, kind, files };
}
