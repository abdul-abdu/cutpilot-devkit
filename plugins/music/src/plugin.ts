/**
 * The plugin: an `asset:music` over the library shipped in `library/`. find_music picks
 * tracks by mood, words and length; get_music hands over a track's file with its licence.
 */
import { PluginFailure, type PluginDefinition } from '@cutpilot/plugin-sdk';
import { LIBRARY_DIR, loadLibrary, trackFile, type Library } from './library.js';
import { pick, type Track } from './picker.js';

/** The track as find_music lists it: everything but where its file is. */
const listed = ({ file: _file, ...t }: Track) => t;

export function makeDefinition(dir: string = LIBRARY_DIR): PluginDefinition {
  // read once, on first use: the library doesn't change while the plugin runs
  let lib: Library | undefined;
  const library = () => (lib ??= loadLibrary(dir));

  return {
    findMusic: (input) => ({ tracks: pick(library().tracks, input).map(listed) }),
    getMusic: ({ id }) => {
      const l = library();
      const t = l.tracks.find((x) => x.id === id);
      if (!t)
        throw new PluginFailure(
          'E_MUSIC_UNKNOWN_TRACK',
          `there is no track "${id}" in the music library`,
          'call find_music and use one of the ids it lists',
        );
      return {
        file: trackFile(l, t),
        durationMs: t.durationMs,
        license: t.license,
        ...(t.attribution ? { attribution: t.attribution } : {}),
      };
    },
  };
}

export const definition = makeDefinition();
