/**
 * A tone portamento stops at the last row that carries one.
 *
 * space_debris.mod channel 4 writes its bass glides as a `3xx` on the note row
 * followed by seven `300` rows, and calibrates them so eight rows of sliding
 * is exactly the distance it wants: at speed 6 that is 8 rows x 5 slide ticks
 * x 4 period units = 160 units. Order 1 (0-based) rows 25-32 slide F-2 -> F-3 (320 ->
 * 160), which is 160 units, and land on the written note.
 *
 * Rows 56-63 use the same shape but write `C-2` (period 428) as the target --
 * 268 units below the F-3 the channel is on, which eight rows cannot cover.
 * ProTracker re-reads the effect column every row, and neither order 2's
 * opening `A10` rows nor the blank cells after them carry a tone portamento,
 * so the slide simply stops where row 63 left it: period 320, exactly F-2, an
 * octave below where it started. The written C-2 is never reached.
 *
 * The engine used to keep stepping the slide through rows that carry no tone
 * portamento, which walked the bass past F-2 and on down to C-2 -- "the pitch
 * slide goes too deep, and misses the correct pitch". See
 * `tonePortaContinuesThroughEmptyRows` in format-profile.ts.
 */

import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { importModToTrackerSong } from 'src/audio/tracker/mod-import';
import { PlaybackEngine } from '@another-synth/tracker-playback';
import { songFromImport } from './helpers/imported-song';

const TRACK = 3; // channel 4
const PAULA_TO_SYNTH_SCALE = 128;
const frequencyForPeriod = (period: number) =>
  7159090.5 / (2 * period * PAULA_TO_SYNTH_SCALE);

const F2 = frequencyForPeriod(320); // where eight rows of 3xx actually arrive
const C2 = frequencyForPeriod(428); // the note the rows write as their target

function loadSong() {
  const buf = fs.readFileSync(
    path.resolve(__dirname, '../../public/demos/amiga/space_debris.mod'),
  );
  return songFromImport(
    importModToTrackerSong(
      buf.buffer.slice(
        buf.byteOffset,
        buf.byteOffset + buf.byteLength,
      ) as ArrayBuffer,
    ),
  );
}

/**
 * Play orders 0 to 2 in full -- the channel has to arrive at row 56 on the
 * F-3 the earlier rows slid it to -- and split channel 4's scheduled pitches
 * at the order 1 -> order 2 boundary.
 */
function pitchesAcrossTheBoundary() {
  const song = loadSong();
  const beforeBoundary: number[] = [];
  const afterBoundary: number[] = [];
  let collecting = beforeBoundary;

  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() },
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: () => {},
    scheduledPitchHandler: (
      _instrumentId: string,
      _voiceIndex: number,
      frequency: number,
      _time: number,
      trackIndex: number,
    ) => {
      if (trackIndex === TRACK) collecting.push(frequency);
    },
  } as unknown as ConstructorParameters<typeof PlaybackEngine>[0]);

  engine.loadSong(song, 0);
  const internals = engine as unknown as {
    scheduleRow: (row: number, time: number) => void;
  };
  const sequence = song.sequence ?? [];
  let time = 0;
  for (let order = 0; order < 3; order++) {
    // loadPattern keeps the effect state, which is the point: the slide has to
    // survive (or not) the order change.
    if (order > 0) {
      engine.loadPattern(sequence[order]!, { updatePosition: false });
    }
    if (order === 2) collecting = afterBoundary;
    // Order 2 is only followed as far as its first nine rows: the channel gets
    // new notes further in, and it is the rows right after the boundary that
    // the slide used to walk through.
    const rows = order === 2 ? 9 : 64;
    for (let row = 0; row < rows; row++) {
      internals.scheduleRow(row, time);
      time += 0.1;
    }
  }
  return { beforeBoundary, afterBoundary };
}

describe('space_debris.mod order 1 -> order 2, channel 4', () => {
  it('ends the 3xx run on F-2 and leaves it there', () => {
    const { beforeBoundary, afterBoundary } = pitchesAcrossTheBoundary();

    // Eight rows of sliding cover exactly an octave, F-3 down to F-2.
    const last = beforeBoundary.at(-1);
    expect(last).toBeDefined();
    expect(last!).toBeCloseTo(F2, 4);

    // The next pattern carries no tone portamento, so nothing moves it -- and
    // in particular it never reaches the C-2 the rows wrote as their target.
    for (const frequency of afterBoundary) {
      expect(frequency).toBeCloseTo(F2, 4);
    }
    expect(afterBoundary.some((f) => f < C2 * 1.05)).toBe(false);
  });
});
