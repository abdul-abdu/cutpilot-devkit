import { definePlugin } from '@nodcut/plugin-sdk';
import { definition } from './plugin.js';

await definePlugin(definition).start();
