/**
 * Choosing tracks: pure functions over the library's entries, no files.
 *
 * - `mood` keeps the tracks tagged with it (or with a mood it is a common word for: "happy"
 *   finds upbeat, "chill" finds lo-fi and calm). Spelling of tags doesn't matter: lo-fi, lofi
 *   and "lo fi" are the same tag.
 * - `query` keeps the tracks whose title or moods share a word with it.
 * - `minDurationMs`: a track that covers it on its own comes first, then one that loops to
 *   cover it, then the rest (still listed: a short bed may be all there is).
 */
export interface Track {
  id: string;
  title: string;
  moods: string[];
  bpm?: number;
  durationMs: number;
  loopable: boolean;
  license: string;
  attribution?: string;
  /** relative to the library folder */
  file: string;
}

export interface Find {
  mood?: string;
  query?: string;
  minDurationMs?: number;
  limit?: number;
}

export const DEFAULT_LIMIT = 10;

/** lower case, letters and digits only: "Lo-Fi" and "lofi" are one tag */
export const tagKey = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/** Words people use for a mood that the library tags differently. */
const SYNONYMS: Record<string, string[]> = {
  calm: ['relaxed', 'relaxing', 'peaceful', 'gentle', 'soft', 'ambient', 'quiet', 'soothing'],
  upbeat: ['happy', 'cheerful', 'energetic', 'fun', 'positive', 'bright', 'lively', 'pop'],
  inspiring: ['inspirational', 'uplifting', 'motivational', 'hopeful', 'emotional'],
  corporate: ['business', 'professional', 'tech', 'presentation', 'explainer', 'product'],
  dramatic: ['epic', 'cinematic', 'tense', 'dark', 'suspense', 'serious', 'intense'],
  lofi: ['chill', 'chillhop', 'study', 'jazzy', 'mellow', 'vlog'],
};

/** The tags a word stands for: itself, and the moods it is a synonym of. */
export function tagsFor(word: string): Set<string> {
  const k = tagKey(word);
  const out = new Set([k]);
  for (const [mood, words] of Object.entries(SYNONYMS)) if (words.some((w) => tagKey(w) === k)) out.add(mood);
  // "chill" is as much calm as lo-fi
  if (k === 'chill') out.add('calm');
  return out;
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[^\p{L}\p{N}-]+/u)
    .filter(Boolean);

/** How well a track answers the query: the number of its words found in the title or moods. */
export function queryScore(t: Track, query: string): number {
  const title = new Set(words(t.title).map(tagKey));
  const moods = new Set(t.moods.map(tagKey));
  // "lo fi" as two words is still the lo-fi tag, so pairs of words count too
  const qs = words(query);
  const pairs = qs.slice(1).map((w, i) => qs[i] + w);
  let score = 0;
  for (const w of [...qs, ...pairs]) if ([...tagsFor(w)].some((x) => moods.has(x) || title.has(x))) score++;
  return score;
}

/** Whether a track has the mood: the first tag is the track's main mood, a later one counts less. */
export function moodRank(t: Track, mood: string): number {
  const want = tagsFor(mood);
  const i = t.moods.findIndex((m) => want.has(tagKey(m)));
  return i < 0 ? 0 : i === 0 ? 2 : 1;
}

/** 2: long enough on its own; 1: loops to cover it; 0: too short. */
export function lengthRank(t: Track, minDurationMs: number | undefined): number {
  if (!minDurationMs || t.durationMs >= minDurationMs) return 2;
  return t.loopable ? 1 : 0;
}

/** The tracks that fit, best first. */
export function pick(tracks: readonly Track[], f: Find): Track[] {
  const scored = tracks
    .map((t) => ({
      t,
      mood: f.mood ? moodRank(t, f.mood) : 1,
      query: f.query ? queryScore(t, f.query) : 1,
      length: lengthRank(t, f.minDurationMs),
    }))
    .filter((s) => s.mood > 0 && s.query > 0);
  scored.sort(
    (a, b) =>
      b.length - a.length ||
      b.mood - a.mood ||
      b.query - a.query ||
      // of two that cover the length, the shorter needs less trimming; otherwise the longer loops less
      (f.minDurationMs ? (a.length === 2 ? 1 : -1) * (a.t.durationMs - b.t.durationMs) : 0) ||
      a.t.title.localeCompare(b.t.title),
  );
  return scored.slice(0, f.limit ?? DEFAULT_LIMIT).map((s) => s.t);
}
