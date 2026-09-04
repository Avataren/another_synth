/**
 * What a bare `Gxx`/`3xx` slides towards.
 *
 * A tone-portamento row with no note of its own continues towards the target
 * the channel already has, which may have been named in an earlier pattern --
 * so `precomputeTonePortaTargets` carries that target along the order list and
 * fills it into those rows.
 *
 * Only tone-porta rows used to update the carried target. A plain note did
 * not, so a target named on one porta row could outlive every note played
 * after it and still be inherited patterns later.
 *
 * Reported (Morten, 2026-09-04) on ascent_of_the_cloud_eagle.s3m, pattern 28
 * track 9: the channel plays note 114 at row 0x23 and then swells on bare
 * G02/G00 rows, which inherited note 101 from pattern 17 -- nine semitones
 * below the note actually sounding. The swell slid away downwards and ended
 * up out of tune; it should hold, because a plain note has already arrived at
 * its pitch and leaves nothing to slide towards.
 */

import { describe, it, expect, vi } from 'vitest';
import { PlaybackEngine } from '../../packages/tracker-playback/src/engine';
import type {
  PlaybackScheduler,
  Song,
  Step,
} from '../../packages/tracker-playback/src/types';

const porta = (row: number, midi?: number): Step => ({
  row,
  ...(midi === undefined ? {} : { note: 'x', midi }),
  effect: { type: 'tonePorta', paramX: 0, paramY: 2 },
});

const plainNote = (row: number, midi: number): Step => ({
  row,
  note: 'x',
  midi,
  velocity: 255,
  instrumentId: '01',
});

function makeSong(p1: Step[], p2: Step[]): Song {
  return {
    title: 'T',
    author: 'A',
    bpm: 125,
    moduleFormat: 'protracker',
    patterns: [
      { id: 'p1', length: 4, tracks: [{ id: 't0', steps: p1 }] },
      { id: 'p2', length: 4, tracks: [{ id: 't0', steps: p2 }] },
    ],
    sequence: ['p1', 'p2'],
  };
}

/** The midi each step carries after the precompute has run. */
function targetsAfterLoad(song: Song): Array<number | undefined> {
  const engine = new PlaybackEngine({
    scheduler: { start: vi.fn(), stop: vi.fn() } as PlaybackScheduler,
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: vi.fn(),
  } as unknown as ConstructorParameters<typeof PlaybackEngine>[0]);
  engine.loadSong(song);
  return song.patterns[1]!.tracks[0]!.steps.map((s) => s.midi);
}

describe('the carried tone-portamento target', () => {
  it('a bare porta still inherits a target from an earlier pattern', () => {
    // The behaviour the precompute exists for, unchanged.
    const targets = targetsAfterLoad(
      makeSong([porta(0, 60)], [porta(0), porta(1)]),
    );
    expect(targets).toEqual([60, 60]);
  });

  it('a plain note in between becomes the target, so a later bare porta holds', () => {
    // The bug: 60 was named on a porta row in p1, then note 72 actually
    // played. The bare portas after it must head for 72 -- where the channel
    // already is -- not slide back down to 60.
    const targets = targetsAfterLoad(
      makeSong([porta(0, 60)], [plainNote(0, 72), porta(1), porta(2)]),
    );
    expect(targets).toEqual([72, 72, 72]);
  });

  it('a porta naming its own note still wins over the carried one', () => {
    const targets = targetsAfterLoad(
      makeSong([porta(0, 60)], [plainNote(0, 72), porta(1, 64), porta(2)]),
    );
    expect(targets).toEqual([72, 64, 64]);
  });

  it('a bare porta with nothing ever stated is left alone', () => {
    const targets = targetsAfterLoad(makeSong([], [porta(0), porta(1)]));
    expect(targets).toEqual([undefined, undefined]);
  });
});
