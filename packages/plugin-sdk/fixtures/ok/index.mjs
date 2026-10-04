// Answers every call the way its contract says: `testPlugin()` passes.
import { definePlugin, z } from '@nodcut/plugin-sdk';

await definePlugin({
  transcribe: ({ language }) => ({
    language: language === 'auto' ? 'en' : language,
    words: [
      { text: 'Hello,', start: 0, end: 400 },
      { text: 'world.', start: 450, end: 900 },
    ],
  }),
  tools: {
    shout: {
      description: 'The text in capitals.',
      input: { text: z.string() },
      handler: ({ text }) => text.toUpperCase(),
    },
  },
}).start();
