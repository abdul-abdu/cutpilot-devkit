// The smallest CutPilot plugin: one read-only tool that AI clients see as `hello__greet`.
import { definePlugin } from '@cutpilot/plugin-sdk';
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
