// An extra tool: AI clients connected to NodCut see it as `<plugin id>__suggest_titles`.
// Extra tools are read-only: they return text or data, and never change an edit.
import { defineTool, z, type PluginDefinition } from '@nodcut/plugin-sdk';

const STOP_WORDS = new Set(
  'about after also because been before being could does from have here into just like more most only other over really should some than that their them then there these they this those very want what when where which while with would your'.split(
    ' ',
  ),
);

const capital = (w: string) => w.charAt(0).toUpperCase() + w.slice(1);

/**
 * Title ideas for a video from its transcript. A placeholder: it builds titles around the words
 * the speaker uses most. Swap in your own logic (or a call to a model) here.
 */
export function suggestTitles(transcript: string, count = 5): string[] {
  const words = transcript.toLowerCase().match(/\p{L}[\p{L}\p{N}'-]*/gu) ?? [];
  const counts = new Map<string, number>();
  for (const w of words) if (w.length > 3 && !STOP_WORDS.has(w)) counts.set(w, (counts.get(w) ?? 0) + 1);
  const top = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([w]) => w);
  if (!top.length) return ['Untitled video'];
  const [a, b] = top as [string, string?];
  const ideas = [
    `${capital(a)}: what you need to know`,
    `${capital(a)}: why it matters`,
    ...(b ? [`${capital(a)} and ${b}, explained`, `${capital(a)} vs ${b}`] : []),
    `The truth about ${a}`,
    ...(b ? [`${capital(b)} in five minutes`] : []),
  ];
  return ideas.slice(0, count);
}

export const plugin: PluginDefinition = {
  tools: {
    suggest_titles: defineTool({
      description: "Title ideas for a video from its transcript (get it with the editor's get_words).",
      input: {
        transcript: z.string().min(1).describe('what is said in the video, as plain text'),
        count: z.number().int().min(1).max(6).optional().describe('how many titles (default 5)'),
      },
      // an object comes back to the AI as structured data and as JSON text
      handler: ({ transcript, count }) => ({ titles: suggestTitles(transcript, count) }),
    }),
  },
};
