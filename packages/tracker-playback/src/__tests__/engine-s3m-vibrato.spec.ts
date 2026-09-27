import { describe, expect, it } from 'vitest';

import { PlaybackEngine } from '../engine';
import type { Song, Step } from '../types';

/**
 * ST3's vibrato (st3play digcmd.c `s_vibrato`, `docmd1`; see
 * `FormatProfile.st3Vibrato`). Offsets are read back as ST3 periods
 * (`aspd`, hz = 14317056 / aspd) relative to the note's own.
 */
const H = (row: number, param: number, midi?: number): Step => ({
  row,
  instrumentId: '01',
  ...(midi !== undefined ? { midi, velocity: 255 } : {}),
  effect: { type: 'vibrato', paramX: param >> 4, paramY: param & 15 },
  rawEffect: { command: 0x08, param },
});

function offsets(steps: Step[], rows: number, opl = false): number[][] {
  const song: Song = {
    title: 'st3 vibrato',
    author: '',
    bpm: 125,
    moduleFormat: 's3m',
    sequence: ['p0'],
    patterns: [{ id: 'p0', length: rows, tracks: [{ id: 't0', steps }] }],
  };
  const tick = 2.5 / 125;
  const byRow: number[][] = Array.from({ length: rows }, () => []);
  let base = 0;
  const period = (hz: number) => 14317056 / (hz * 16);
  const engine = new PlaybackEngine({
    audioContext: { currentTime: 0 } as unknown as AudioContext,
    scheduledNoteHandler: (e) => {
      if (e.type === 'noteOn') base = period(e.frequency ?? 0);
    },
    scheduledPitchHandler: (_id, _voice, hz, time) => {
      const row = Math.floor(time + 1e-9);
      const t = Math.round((time - row) / tick);
      if (t > 0) byRow[row]![t - 1] = Math.round(period(hz) - base);
    },
    scheduledVolumeHandler: () => {},
    steppedTickAutomation: () => true,
    oplInstrument: () => opl,
  });
  engine.loadSong(song, 0);
  const scheduleRow = (Reflect.get(engine, 'scheduleRow') as (row: number, time: number) => void).bind(engine);
  for (let row = 0; row < rows; row++) scheduleRow(row, row);
  return byRow;
}

describe('ST3 vibrato', () => {
  it('H85: vibsin read before advancing, (dat * depth) >> 5 rounding down', () => {
    // idx 0, 8, 16, 24, 32: vibsin 0, 0xB4, 0xFF, 0xB4, 0 -> *5 >> 5.
    expect(offsets([H(0, 0x85, 60)], 1)[0]).toEqual([0, 28, 39, 28, 0]);
  });

  it('the wave carries on through H00 and falls below the note with floor rounding', () => {
    // idx 40.. : -0xB4*5>>5 = -29 (floor of -28.1), -0xFF*5>>5 = -40.
    expect(offsets([H(0, 0x85, 60), H(1, 0x00)], 2)[1]).toEqual([-29, -40, -29, 0, 28]);
  });

  it('Hx0 is depth 0', () => {
    expect(offsets([H(0, 0x85, 60), H(1, 0x40)], 2)[1]).toEqual([0, 0, 0, 0, 0]);
  });

  it('a row with no command keeps the phase; any other command restarts it', () => {
    const volSlide = (row: number): Step => ({
      row,
      instrumentId: '01',
      effect: { type: 'volSlide', paramX: 0, paramY: 1 },
      rawEffect: { command: 0x04, param: 0x01 },
    });
    const speed = (row: number): Step => ({ row, instrumentId: '01', speedCommand: 6, rawEffect: { command: 0x01, param: 6 } });
    // After an empty row 1 the wave resumes at idx 40.
    expect(offsets([H(0, 0x85, 60), H(2, 0x00)], 3)[2]![0]).toBe(-29);
    // D keeps it too.
    expect(offsets([H(0, 0x85, 60), volSlide(1), H(2, 0x00)], 3)[2]![0]).toBe(-29);
    // A (set speed) sets avibcnt bit 7: back to idx 0.
    expect(offsets([H(0, 0x85, 60), speed(1), H(2, 0x00)], 3)[2]![0]).toBe(0);
  });

  it('a new note restarts the wave on PCM, not on AdLib', () => {
    expect(offsets([H(0, 0x85, 60), H(1, 0x00, 62)], 2)[1]![0]).toBe(0);
    expect(offsets([H(0, 0x85, 60), H(1, 0x00, 62)], 2, true)[1]![0]).not.toBe(0);
  });

  it('after a vibrato, an empty or D cell snaps back; E slides on from the bent pitch; others hold it', () => {
    const cell = (row: number, command: number, param: number, effect: Step['effect']): Step => ({
      row,
      instrumentId: '01',
      ...(effect ? { effect } : {}),
      rawEffect: { command, param },
    });
    // H45 leaves the wave at idx 16 after row 0: +39.
    const vib = H(0, 0x45, 60);
    // An empty row snaps back on tick 0 and writes nothing after it.
    expect(offsets([vib], 2)[1]).toEqual([]);
    // D01: snaps back at tick 0, so tick 1 is at the note.
    const d = offsets([vib, cell(1, 0x04, 0x01, { type: 'volSlide', paramX: 0, paramY: 1 })], 2)[1]!;
    expect(d.every((v) => v === 0)).toBe(true);
    // E01: +39 folds into the note, then 4 per tick: 43, 47, ...
    expect(offsets([vib, cell(1, 0x05, 0x01, { type: 'portaDown', paramX: 0, paramY: 1 })], 2)[1]).toEqual([43, 47, 51, 55, 59]);
    // Q (retrigger) leaves aspd alone: nothing re-states the pitch.
    const q = offsets([vib, cell(1, 0x11, 0x00, { type: 'retrigVol', paramX: 0, paramY: 0 })], 2)[1]!;
    expect(q.filter((v) => v !== undefined && v !== 39)).toEqual([]);
  });
});
