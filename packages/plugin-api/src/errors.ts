/**
 * Errors between the engine and plugins. Like every NodCut error, each has a one-line
 * message and a one-line `fix` that tells the reader (often an AI agent) what to do next.
 */
import { z } from 'zod';

export const PLUGIN_ERROR_CODES = [
  /** nodcut-plugin.json is missing or invalid */
  'E_PLUGIN_BAD_MANIFEST',
  /** contract version or engine version range doesn't fit this NodCut */
  'E_PLUGIN_UNSUPPORTED',
  /** the plugin crashed, exited, or reported a failure */
  'E_PLUGIN_FAILED',
  'E_PLUGIN_TIMEOUT',
  /** the plugin's tools or answers don't match its kind's contract */
  'E_PLUGIN_CONTRACT',
  /** the user hasn't approved this plugin's permissions (or a new version asks for more) */
  'E_PLUGIN_NOT_APPROVED',
  /** a declared secret (e.g. an API key) hasn't been entered */
  'E_PLUGIN_NEEDS_SECRET',
  /** a plugin rejected its input */
  'E_PLUGIN_BAD_INPUT',
  /** the user switched the plugin off */
  'E_PLUGIN_OFF',
] as const;
export type PluginErrorCode = (typeof PLUGIN_ERROR_CODES)[number];

const OneLine = z
  .string()
  .min(1)
  .refine((s) => !/[\r\n]/.test(s), 'one line');

/** What a plugin returns (as structured content of an error result) when a call fails. */
export const PluginErrorSchema = z.object({
  code: z.string().regex(/^E_[A-Z0-9_]+$/, 'codes look like E_BAD_KEY'),
  message: OneLine,
  fix: OneLine,
});
export type PluginError = z.infer<typeof PluginErrorSchema>;
