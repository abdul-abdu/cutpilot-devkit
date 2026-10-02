// The manifest is fine; the answer isn't: definePlugin refuses it with E_PLUGIN_CONTRACT.
import { definePlugin } from '@cutpilot/plugin-sdk';

await definePlugin({
  transcribe: () => ({
    language: 'en',
    words: [
      { text: 'world.', start: 450, end: 900 },
      { text: 'Hello,', start: 0, end: 400 },
    ],
  }),
}).start();
