import { describe, expect, it } from 'vitest';

import { PlaybackEngine } from '../engine';
import type { Song, Step } from '../types';

/**
 * ST3 defers a note-delayed cell whole (st3play digread.c `donewnote`
 * returns early on SDx; `s_notedelayb` runs it on the delay tick), so the
 * row's volume lands with the note, not on tick 0. ProTracker sets the
 * volume on tick 0 and delays only the trigger. See
 * `FormatProfile.noteDelayDefersCell`.
 */
function volumes(moduleFormat: 'mod' | 's3m', row1: Step): Array<[number, number]> {
  const song: Song = {
    title: 'note delay',
    author: '',
    bpm: 125,
    moduleFormat,
    sequence: ['p0'],
    patterns: [
      {
        id: 'p0',
        length: 2,
        tracks: [{ id: 't0', steps: [{ row: 0, instrumentId: '01', midi: 60, velocity: 255 }, row1] }],
      },
    ],
  };
  const tick = 2.5 / 125;
  const out: Array<[number, number]> = [];
  const engine = new PlaybackEngine({
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: () => {},
    scheduledPitchHandler: () => {},
    scheduledVolumeHandler: (_id, _voice, volume, time) => {
      if (time >= 1) out.push([Math.round((time - 1) / tick), Math.round(volume * 64)]);
    },
    steppedTickAutomation: () => true,
  });
  engine.loadSong(song, 0);
  const scheduleRow = (Reflect.get(engine, 'scheduleRow') as (row: number, time: number) => void).bind(engine);
  scheduleRow(0, 0);
  scheduleRow(1, 1);
  return out;
}

const delay2 = { type: 'noteDelay' as const, paramX: 0xd, paramY: 2, extSubtype: 'noteDelay' as const };

describe('note delay and the row volume', () => {
  it('ST3: a delayed note brings its volume on the delay tick', () => {
    expect(volumes('s3m', { row: 1, instrumentId: '01', midi: 62, velocity: 128, effect: delay2 })).toEqual([[2, 32]]);
  });

  it('ST3: a delayed volume with no note waits for the delay tick too', () => {
    expect(volumes('s3m', { row: 1, instrumentId: '01', velocity: 128, effect: delay2 })).toEqual([[2, 32]]);
  });

  it('ProTracker: the volume applies on tick 0', () => {
    expect(volumes('mod', { row: 1, instrumentId: '01', midi: 62, velocity: 128, effect: delay2 })[0]).toEqual([0, 32]);
  });
});
