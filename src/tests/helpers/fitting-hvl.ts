import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseAhx, type AhxSong } from '@another-synth/tracker-playback';
import { serializeAhx } from 'src/audio/tracker/song-export';

/**
 * An HVL song that fits AHX, derived from a real demo `.hvl`: parsed, cut down
 * in memory to channels 0..3 with no second effect column, and (for the byte
 * form) written back with the app's own writer. Never a checked-in fixture:
 * no demo `.hvl` fits in 4 tracks, so the positive path of the HVL -> AHX
 * export needs one made this way.
 */

const DEMOS = resolve(__dirname, '../../../public/demos/ahx');

export const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** A real HVL model cut down until it fits: channels 0..3 only, no second effect column. */
export function fittingHvlModel(name = 'sliding_away.hvl'): AhxSong {
  const song = clone(parseAhx(new Uint8Array(readFileSync(resolve(DEMOS, name)))));
  const blank = song.tracks.findIndex((track) =>
    track.every((s) => s.note === 0 && s.instrument === 0 && s.fx === 0 && s.fxParam === 0 && s.fxb === 0 && s.fxbParam === 0),
  );
  if (blank < 0) throw new Error(`${name} has no blank track to point the dropped channels at`);
  for (const position of song.positions) {
    for (let ch = 4; ch < song.channels; ch++) position.track[ch] = blank;
  }
  for (const track of song.tracks) for (const step of track) Object.assign(step, { fxb: 0, fxbParam: 0 });
  return song;
}

/** The `.hvl` file bytes of a model (no `base`: the writer works from the model alone). */
export const hvlBytesOf = (song: AhxSong): ArrayBuffer => serializeAhx(song).slice().buffer;
