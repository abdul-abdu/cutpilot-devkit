/**
 * Bring your own licence. The user, not CutPilot, is Remotion's licensee: nothing here works until
 * the user enters their own Remotion licence key in CutPilot → Plugins → Remotion (a secret only
 * the user can set; the AI can't). "free-license" declares they qualify for Remotion's free
 * licence; a Company License key comes from remotion.pro. The key goes to Remotion's renderer as
 * `licenseKey`, as Remotion asks, and nowhere else.
 *
 * Each time the key is used with a project or a Remotion version not seen before, the plugin
 * records it (when, which project, which Remotion version, which kind of licence, never the key)
 * and puts the notice in its answer, for the AI to show the user.
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { PluginFailure, type PluginContext } from '@cutpilot/plugin-sdk';
import { writeAtomic } from './scenes.js';

export const LICENSE_SECRET = 'REMOTION_LICENSE_KEY';
export const FREE_LICENSE = 'free-license';

export const LICENSE_NOTICE =
  'This plugin uses your own installation of Remotion, which is licensed separately by Remotion AG. ' +
  'CutPilot does not include or license Remotion. You are responsible for complying with Remotion’s license: ' +
  'it’s free for individuals and companies of up to 3 people; larger companies need a Remotion Company License — remotion.pro.';

const KEY_FIX =
  `enter your Remotion licence key as ${LICENSE_SECRET} in CutPilot → Plugins → Remotion: "${FREE_LICENSE}" ` +
  'if you qualify for the free licence (individuals, companies of up to 3 people, non-profits), ' +
  'or your Company License key from remotion.pro. Only the user can do this; ask them.';

export type LicenseKind = 'free' | 'company';

/** The user's licence key, or a PluginFailure that shows the notice and says where to enter it. */
export function licenseKey(ctx: Pick<PluginContext, 'secret'>): { key: string; kind: LicenseKind } {
  const key = ctx.secret(LICENSE_SECRET)?.trim();
  if (!key)
    throw new PluginFailure(
      'E_PLUGIN_NEEDS_SECRET',
      `no Remotion licence key yet. ${LICENSE_NOTICE}`,
      KEY_FIX,
    );
  if (/\s/.test(key))
    throw new PluginFailure(
      'E_REMOTION_BAD_LICENSE_KEY',
      'the Remotion licence key has spaces in it',
      KEY_FIX,
    );
  return { key, kind: key === FREE_LICENSE ? 'free' : 'company' };
}

export interface Acceptance {
  projectDir: string;
  remotionVersion: string;
  license: LicenseKind;
  /** ISO time the user's key was first used with this project and version */
  acceptedAt: string;
}

/** Where the records are kept: a folder of this plugin's own, outside the user's project. */
export function stateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CUTPILOT_REMOTION_STATE_DIR) return env.CUTPILOT_REMOTION_STATE_DIR;
  const home = env.HOME || homedir();
  if (process.platform === 'darwin')
    return join(home, 'Library', 'Application Support', 'CutPilot', 'plugin-remotion');
  if (process.platform === 'win32')
    return join(env.APPDATA || join(home, 'AppData', 'Roaming'), 'CutPilot', 'plugin-remotion');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'cutpilot', 'plugin-remotion');
}

export function readAcceptances(dir: string): Acceptance[] {
  const f = join(dir, 'acceptances.json');
  if (!existsSync(f)) return [];
  try {
    const all = JSON.parse(readFileSync(f, 'utf8')) as unknown;
    return Array.isArray(all) ? (all as Acceptance[]) : [];
  } catch {
    return [];
  }
}

/**
 * Record that the user's licence is used with this project and Remotion version. `isNew` is true
 * the first time for that pair (or a different kind of licence): the answer then carries the notice.
 */
export function recordAcceptance(
  dir: string,
  a: Omit<Acceptance, 'acceptedAt'>,
  now: Date = new Date(),
): { acceptance: Acceptance; isNew: boolean } {
  const all = readAcceptances(dir);
  const found = all.find(
    (x) =>
      x.projectDir === a.projectDir && x.remotionVersion === a.remotionVersion && x.license === a.license,
  );
  if (found) return { acceptance: found, isNew: false };
  const acceptance: Acceptance = { ...a, acceptedAt: now.toISOString() };
  mkdirSync(dir, { recursive: true });
  writeAtomic(join(dir, 'acceptances.json'), JSON.stringify([...all, acceptance], null, 2) + '\n');
  return { acceptance, isNew: true };
}
