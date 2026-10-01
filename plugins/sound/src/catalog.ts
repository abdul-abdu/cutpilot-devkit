/**
 * What the plugin downloads, pinned by SHA-256: one audio.cpp build per platform and one GGUF
 * model per job. Everything here is public and comes from its publisher's own releases; the
 * plugin's installer carries none of it (the model licences want the user to fetch them).
 */

export interface Download {
  url: string;
  sha256: string;
  /** bytes, as published; the download stops past it */
  size: number;
}

export interface Runtime extends Download {
  version: string;
  /** `tar.gz` or `zip` (both unpacked with the OS's tar) */
  archive: 'tar.gz' | 'zip';
  /** the CLI inside the archive */
  exe: string;
}

export type Job = 'sfx' | 'music' | 'speech';

export interface Model extends Download {
  /** the folder it lives in under models/ */
  id: string;
  job: Job;
  /** the name to show, and to credit in `model` */
  name: string;
  /** audio.cpp's `--family` */
  family: string;
  /** audio.cpp's `--task` */
  task: 'gen' | 'tts';
  file: string;
  license: string;
  licenseUrl: string;
  /** the credit line the licence asks for, if any */
  attribution?: string;
  /** what the licence allows, in one line, for `doctor` */
  terms: string;
}

export const RUNTIME_VERSION = 'v0.9.0';
const RELEASE = `https://github.com/0xShug0/audio.cpp/releases/download/${RUNTIME_VERSION}`;

/** `<platform>-<arch>` → the build. Linux and Windows on arm64 have no build yet. */
export const RUNTIMES: Readonly<Record<string, Runtime>> = {
  'darwin-arm64': {
    version: RUNTIME_VERSION,
    url: `${RELEASE}/audio-${RUNTIME_VERSION}-bin-macos-arm64-metal.tar.gz`,
    sha256: '7cea9219d5f06475011c5d225d71d988cecef633ff7d098ee8a4c7b08583b1b4',
    size: 29162796,
    archive: 'tar.gz',
    exe: 'audiocpp_cli',
  },
  'darwin-x64': {
    version: RUNTIME_VERSION,
    url: `${RELEASE}/audio-${RUNTIME_VERSION}-bin-macos-x64-metal.tar.gz`,
    sha256: 'f6e50c776bfe3b23cb5e420f1dd31b11661ed3dc01207cf05cf780dfdadca1c9',
    size: 30897245,
    archive: 'tar.gz',
    exe: 'audiocpp_cli',
  },
  'linux-x64': {
    version: RUNTIME_VERSION,
    url: `${RELEASE}/audio-${RUNTIME_VERSION}-bin-ubuntu-x64-cpu-portable.tar.gz`,
    sha256: 'cf87b6baa46cf45fc8a2816b8f04f0f3f3fce32cca297231a4da56543f19fe87',
    size: 55607598,
    archive: 'tar.gz',
    exe: 'audiocpp_cli',
  },
  'win32-x64': {
    version: RUNTIME_VERSION,
    url: `${RELEASE}/audio-${RUNTIME_VERSION}-bin-windows-x64-cpu-portable.zip`,
    sha256: '3ee19466a1a2b5366364ca8447a4794391dd89671e655ffd01aa421ac1668bfa',
    size: 25803809,
    archive: 'zip',
    exe: 'audiocpp_cli.exe',
  },
};

export const RUNTIME_LICENSE = {
  name: 'Apache-2.0',
  url: 'https://github.com/0xShug0/audio.cpp/blob/main/LICENSE',
};

const GGUF = 'https://huggingface.co/audio-cpp/audio.cpp-gguf/resolve/main';

const STABILITY = {
  license: 'Stability AI Community License',
  licenseUrl: 'https://stability.ai/community-license-agreement',
  attribution: 'Powered by Stability AI',
  terms:
    'free, also commercially, while your yearly revenue is under US $1M (register with Stability AI above that); show "Powered by Stability AI" where the sound is used; its Gemma text encoder is under the Gemma Terms of Use',
};

export const MODELS: readonly Model[] = [
  {
    id: 'stable-audio-3-small-sfx',
    job: 'sfx',
    name: 'Stable Audio 3 Small SFX',
    family: 'stable_audio',
    task: 'gen',
    file: 'stable-audio-3-small-sfx-q8_0.gguf',
    url: `${GGUF}/Stable-Audio-3-Small-SFX-GGUF/stable-audio-3-small-sfx-q8_0.gguf`,
    sha256: '5bb1ec653134e63dac46264e336ae198a2590195fc996fcd0605021215e9b26f',
    size: 1683570688,
    ...STABILITY,
  },
  {
    id: 'stable-audio-3-small-music',
    job: 'music',
    name: 'Stable Audio 3 Small Music',
    family: 'stable_audio',
    task: 'gen',
    file: 'stable-audio-3-small-music-q8_0.gguf',
    url: `${GGUF}/Stable-Audio-3-Small-Music-GGUF/stable-audio-3-small-music-q8_0.gguf`,
    sha256: '89bb22db5fa68ab8f1d90af0a9f88121977c945bdb99a57c96b1e88fa34bf1c8',
    size: 1683570752,
    ...STABILITY,
  },
  {
    id: 'supertonic-3',
    job: 'speech',
    name: 'Supertonic 3',
    family: 'supertonic',
    task: 'tts',
    file: 'supertonic-3-orig.gguf',
    url: `${GGUF}/Supertonic-3-GGUF/supertonic-3-orig.gguf`,
    sha256: 'af814486a0bc9513fb36afabd9b1155ad14fb2c36a107ac6ffe62ea9adafb662',
    size: 454072836,
    license: 'BigScience OpenRAIL-M',
    licenseUrl: 'https://huggingface.co/Supertone/supertonic-3/blob/main/LICENSE',
    terms:
      'free, also commercially; its use restrictions (no deception, harassment, discrimination, unlawful use…) apply to what you make with it',
  },
];

export const modelFor = (job: Job): Model => MODELS.find((m) => m.job === job)!;

/** Supertonic 3's languages (ISO 639-1). */
export const SPEECH_LANGUAGES: readonly string[] = [
  'en',
  'ko',
  'ja',
  'ar',
  'bg',
  'cs',
  'da',
  'de',
  'el',
  'es',
  'et',
  'fi',
  'fr',
  'hi',
  'hr',
  'hu',
  'id',
  'it',
  'lt',
  'lv',
  'nl',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sl',
  'sv',
  'tr',
  'uk',
  'vi',
];

/** Supertonic 3's preset voices: every one speaks every language. */
export const VOICES: readonly { id: string; name: string; description: string }[] = [
  { id: 'F1', name: 'Female 1', description: 'clear, neutral; the default' },
  { id: 'F2', name: 'Female 2', description: 'warm, a little lower' },
  { id: 'F3', name: 'Female 3', description: 'bright, lively' },
  { id: 'F4', name: 'Female 4', description: 'calm, soft' },
  { id: 'F5', name: 'Female 5', description: 'mature, steady' },
  { id: 'M1', name: 'Male 1', description: 'clear, neutral' },
  { id: 'M2', name: 'Male 2', description: 'deep, narrator' },
  { id: 'M3', name: 'Male 3', description: 'young, energetic' },
  { id: 'M4', name: 'Male 4', description: 'calm, soft' },
  { id: 'M5', name: 'Male 5', description: 'mature, steady' },
];
export const DEFAULT_VOICE = 'F1';

/** Lengths for effects and music: Stable Audio 3 Small makes up to two minutes. */
export const DURATION = {
  sfx: { default: 5000, min: 1000, max: 120_000 },
  music: { default: 30_000, min: 5000, max: 120_000 },
} as const;
