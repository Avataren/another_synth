import { describe, expect, it } from 'vitest';

import { PlaybackEngine } from '../engine';
import type { EffectCommand, Song, Step } from '../types';

/**
 * ST3's one-byte parameter memory, shared by every command on a channel
 * (st3play digcmd.c: `docmd1` stores `alastnfo` from any non-zero
 * parameter; D E F I J K L Q R S read it back through `GET_LAST_NFO`). See
 * `FormatProfile.sharedEffectInfoCommands`.
 */
function cell(row: number, command: number, param: number, effect?: EffectCommand, midi?: number): Step {
  return {
    row,
    instrumentId: '01',
    ...(midi !== undefined ? { midi, velocity: 255 } : {}),
    ...(effect ? { effect } : {}),
    rawEffect: { command, param },
  };
}

/** Pitch ratios over the note, per tick, for rows 1.. of a speed-6 song. */
function arpeggioSemitones(steps: Step[]): number[] {
  const song: Song = {
    title: 'shared info',
    author: '',
    bpm: 125,
    moduleFormat: 's3m',
    sequence: ['p0'],
    patterns: [{ id: 'p0', length: 4, tracks: [{ id: 't0', steps }] }],
  };
  const pitches: Array<[number, number]> = [];
  let base = 0;
  const fakeNow = 0;
  const audioContext = { get currentTime() { return fakeNow; } };
  const engine = new PlaybackEngine({
    audioContext: audioContext as unknown as AudioContext,
    scheduledNoteHandler: (e) => {
      if (e.type === 'noteOn') base = e.frequency ?? 0;
    },
    scheduledPitchHandler: (_id, _voice, frequency, time) => pitches.push([time, frequency]),
    scheduledVolumeHandler: () => {},
    steppedTickAutomation: () => true,
  });
  engine.loadSong(song, 0);
  const scheduleRow = (Reflect.get(engine, 'scheduleRow') as (row: number, time: number) => void).bind(engine);
  for (let row = 0; row < 3; row++) scheduleRow(row, row);
  const tick = 2.5 / 125;
  return pitches
    .filter(([t]) => t >= 2 - 1e-9 && t < 2 + 6 * tick - 1e-9)
    .map(([, f]) => Math.round(12 * Math.log2(f / base)) + 0);
}

describe('S3M shared parameter memory', () => {
  it('J00 repeats the last arpeggio', () => {
    expect(
      arpeggioSemitones([
        cell(0, 0x0a, 0x37, { type: 'arpeggio', paramX: 3, paramY: 7 }, 60),
        cell(1, 0x0a, 0x00),
        cell(2, 0x0a, 0x00),
      ]),
    ).toEqual([0, 3, 7, 0, 3, 7]);
  });

  it('J00 after a D04 plays J04: the memory belongs to the channel, not to J', () => {
    expect(
      arpeggioSemitones([
        cell(0, 0x0a, 0x37, { type: 'arpeggio', paramX: 3, paramY: 7 }, 60),
        cell(1, 0x04, 0x04, { type: 'volSlide', paramX: 0, paramY: 4 }),
        cell(2, 0x0a, 0x00),
      ]),
    ).toEqual([0, 0, 4, 0, 0, 4]);
  });
});
