// Never started: the manifest is refused first.
import { definePlugin } from '@cutpilot/plugin-sdk';

await definePlugin({ transcribe: () => ({ language: 'en', words: [] }) }).start();
