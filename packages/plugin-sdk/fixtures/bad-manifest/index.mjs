// Never started: the manifest is refused first.
import { definePlugin } from '@nodcut/plugin-sdk';

await definePlugin({ transcribe: () => ({ language: 'en', words: [] }) }).start();
