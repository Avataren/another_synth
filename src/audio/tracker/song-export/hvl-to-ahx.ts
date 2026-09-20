import { ahxInstrumentProblem, type AhxSong } from '@another-synth/tracker-playback';
import { AhxEncodeError, isBlankTrack, serializeAhx } from './ahx-writer';

/**
 * An HVL song as an AHX song, when the tune fits: the model of `parseAhx`
 * turned into another model of it, which `serializeAhx` then writes.
 *
 * Both formats play through this app's replayer the same way, so a tune that
 * only uses what AHX has plays the same here (that claim is for this engine;
 * another AHX player may treat HVL-only effects such as panning differently).
 * The rest is refused, one plain reason each, and whenever this is unsure it
 * refuses. What it checks:
 *  - only channels 0..3 carry data, in any position (a channel above them that
 *    only holds blank tracks is dropped; data on a higher channel is not moved
 *    down, which would change where it sits in the stereo field);
 *  - no second effect column, no note or instrument above 63 (AHX steps are
 *    3 bytes);
 *  - every instrument is one AHX can write (`ahxInstrumentProblem`: HVL's
 *    wider PList entries and extra commands);
 *  - no `EF1` in a version-1 HVL song (the engine reads it there and never in
 *    AHX, so the tune would sound different);
 *  - the converted song actually writes: every track is written, referenced or
 *    not, so the writer is run once and whatever it rejects (a second effect
 *    column in an unused track, a song past the 16-bit table offset) is refused
 *    in the same words.
 * The HVL header's own mix gain and default stereo have no AHX field and are
 * dropped; `HVL_MIX_NOTE` tells the user.
 */

export const HVL_MIX_NOTE = "AHX files don't store this song's stereo and volume mix.";

const AHX_CHANNELS = 4;
const AHX_MAX_NOTE = 63;
const AHX_MAX_INSTRUMENT = 63;
/** The AHX version written: the engine plays every AHX file the same, and this one keeps filter toggles whole. */
const AHX_VERSION = 1;

const INSTEAD = 'Export it as HVL instead.';

/** The channels (0-based, ascending) that have a non-blank track in some position. */
export function channelsWithData(song: AhxSong): number[] {
  const blank = new Map<number, boolean>();
  const isBlank = (index: number): boolean => {
    let value = blank.get(index);
    if (value === undefined) {
      const track = song.tracks[index];
      value = track === undefined || isBlankTrack(track);
      blank.set(index, value);
    }
    return value;
  };
  const used = new Set<number>();
  for (const position of song.positions) {
    position.track.forEach((index, channel) => {
      if (!isBlank(index)) used.add(channel);
    });
  }
  return [...used].sort((a, b) => a - b);
}

export type HvlToAhx = { ok: true; song: AhxSong } | { ok: false; reason: string };

export function convertHvlToAhx(song: AhxSong): HvlToAhx {
  if (song.format !== 'hvl') return { ok: false, reason: 'Only HVL songs can be converted.' };

  const used = channelsWithData(song);
  const width = (used[used.length - 1] ?? -1) + 1;
  if (width > AHX_CHANNELS) {
    return { ok: false, reason: `AHX files have ${AHX_CHANNELS} tracks; this song reaches track ${width}. ${INSTEAD}` };
  }

  const positions = song.positions.map((position) => ({
    track: position.track.slice(0, AHX_CHANNELS),
    transpose: position.transpose.slice(0, AHX_CHANNELS),
  }));

  const kept = new Set(positions.flatMap((position) => position.track));
  for (const index of kept) {
    for (const step of song.tracks[index] ?? []) {
      if (step.fxb !== 0 || step.fxbParam !== 0) {
        return { ok: false, reason: `This song uses a second effect column, which AHX files don't have. ${INSTEAD}` };
      }
      if (step.note > AHX_MAX_NOTE || step.instrument > AHX_MAX_INSTRUMENT) {
        return { ok: false, reason: `This song has notes or instruments AHX files can't hold. ${INSTEAD}` };
      }
      if (song.version >= 1 && step.fx === 0xe && step.fxParam === 0xf1) {
        return { ok: false, reason: `This song uses an effect (EF1) that only HVL plays. ${INSTEAD}` };
      }
    }
  }

  for (let n = 1; n <= song.instrumentNr; n++) {
    if (ahxInstrumentProblem(song.instruments[n], 'ahx') !== null) {
      return { ok: false, reason: `Instrument ${n} uses settings AHX files don't have. ${INSTEAD}` };
    }
  }

  const converted: AhxSong = { ...song, format: 'ahx', version: AHX_VERSION, channels: AHX_CHANNELS, positions };
  delete converted.mixgainRaw;
  delete converted.defstereo;

  // The checks above only read tracks a kept channel plays; the writer writes them all.
  try {
    serializeAhx(converted);
  } catch (error) {
    if (!(error instanceof AhxEncodeError)) throw error;
    const problem = error.message.replace(/^cannot write this AHX\/HVL song: /, '');
    return { ok: false, reason: `AHX files can't hold this song: ${problem}. ${INSTEAD}` };
  }
  return { ok: true, song: converted };
}
