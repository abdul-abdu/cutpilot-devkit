// The smallest NodCut plugin: one read-only tool that AI clients see as `hello__greet`.
import { definePlugin } from '@nodcut/plugin-sdk';
import { z } from 'zod';

await definePlugin({
  tools: {
    greet: {
      description: 'Say hello to someone.',
      input: { name: z.string().describe('who to greet') },
      handler: ({ name }) => `Hello, ${name}!`,
    },
  },
}).start();
