// @vitest-environment node
import fs from 'node:fs';
import path from 'node:path';
import { describe, it, expect } from 'vitest';
import { parseAhx } from '@another-synth/tracker-playback';
import {
  ahxEnvelopePoints,
  ahxNoteName,
  ahxPListFxName,
  ahxPListFxText,
  ahxPListRows,
  ahxWaveCycleLength,
  ahxWaveformKind,
  ahxWaveformLabel,
  ahxWaveformList,
} from 'src/audio/tracker/ahx-instrument-display';

const song = parseAhx(
  new Uint8Array(fs.readFileSync(path.resolve(__dirname, '../../public/demos/ahx/karma.ahx'))),
);

describe('AHX instrument display model', () => {
  it('names waveforms the way the replayer indexes them', () => {
    expect(ahxWaveformKind(0)).toBe('keep');
    expect(['triangle', 'sawtooth', 'square', 'noise']).toEqual(
      [1, 2, 3, 4].map((f) => ahxWaveformKind(f)),
    );
    expect(ahxWaveformKind(5)).toBe('unknown');
    expect(ahxWaveformLabel(3)).toBe('Square');
    expect(ahxWaveformLabel(0)).toBe('—');
    expect(ahxWaveformLabel(7)).toBe('?7');
  });

  it('gives the cycle length as 4 << waveLength', () => {
    expect([0, 1, 5].map(ahxWaveCycleLength)).toEqual([4, 8, 128]);
  });

  it('draws the envelope from silence through attack, decay, sustain, release', () => {
    expect(
      ahxEnvelopePoints({ aFrames: 2, aVolume: 64, dFrames: 4, dVolume: 40, sFrames: 10, rFrames: 6, rVolume: 0 }),
    ).toEqual([
      { frame: 0, volume: 0 },
      { frame: 2, volume: 64 },
      { frame: 6, volume: 40 },
      { frame: 16, volume: 40 },
      { frame: 22, volume: 0 },
    ]);
  });

  it('formats PList notes and commands', () => {
    expect(ahxNoteName(0)).toBe('---');
    expect(ahxNoteName(1)).toBe('C-1');
    expect(ahxNoteName(2)).toBe('C#1');
    expect(ahxNoteName(13)).toBe('C-2');
    expect(ahxNoteName(60)).toBe('B-5');
    expect(ahxPListFxText(0, 0)).toBe('');
    expect(ahxPListFxText(4, 0x1f)).toBe('41F');
    expect(ahxPListFxName(15, 3)).toBe('Speed');
    expect(ahxPListFxName(0, 0)).toBe('');
  });

  it('lists the waveforms every karma instrument\'s PList actually selects', () => {
    for (let n = 1; n <= song.instrumentNr; n++) {
      const instrument = song.instruments[n]!;
      const list = ahxWaveformList(instrument);
      const selecting = instrument.plist.entries.filter((e) => e.waveform !== 0);
      expect(list.reduce((sum, w) => sum + w.count, 0)).toBe(selecting.length);
      // Distinct, in order of first use.
      expect(new Set(list.map((w) => w.field)).size).toBe(list.length);
      expect(list.map((w) => w.firstRow)).toEqual([...list.map((w) => w.firstRow)].sort((a, b) => a - b));
      expect(ahxPListRows(instrument.plist.entries)).toHaveLength(instrument.plist.entries.length);
    }
  });
});
