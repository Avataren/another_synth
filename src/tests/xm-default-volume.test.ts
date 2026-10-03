import { describe, expect, it } from 'vitest';
import { buildPlaybackStepsForTrack, xmEntrySignature, xmSampleForNote, type PlaybackSongSource } from '@another-synth/tracker-playback';

// Instrument 01: sample 0 (volume 64) below C-4, sample 1 (volume 16) from C-4.
const meta = {
  keymap: Array.from({ length: 96 }, (_, n) => (n >= 48 ? 1 : 0)),
  samples: [{ volume: 64 }, { volume: 16 }],
};

function source(): PlaybackSongSource {
  return {
    currentSong: { title: '', author: '', bpm: 125 },
    moduleFormat: 'xm',
    patterns: [],
    sequence: [],
    currentPattern: undefined,
    defaultPatternRows: 8,
    normalizeInstrumentId: (id?: string) => id,
    sampleDefaultVelocity: (_id: string, midi?: number) => {
      const sample = midi === undefined ? undefined : xmSampleForNote(meta, midi - 11);
      return sample ? Math.round((sample.volume / 64) * 255) : undefined;
    },
  } as unknown as PlaybackSongSource;
}

const velocities = (entries: Array<Record<string, unknown>>) =>
  buildPlaybackStepsForTrack(source(), { id: 'T01', name: 'T', entries: entries as never, interpolations: [] }, 8)
    .filter((s) => s.midi !== undefined && s.instrumentId)
    .map((s) => s.velocity);

describe('an authored XM row with an instrument and no volume', () => {
  it("plays at the sample's default volume, chosen by the note's keymap entry", () => {
    // C-3 (midi 48 -> XM note 37) is sample 0, C-4 (midi 60 -> XM note 49) is sample 1.
    expect(velocities([{ row: 0, note: 'C-3', instrument: '01' }, { row: 2, note: 'C-4', instrument: '01' }])).toEqual([255, 64]);
  });

  it('leaves an explicit volume alone', () => {
    expect(velocities([{ row: 0, note: 'C-4', instrument: '01', volume: '80' }])).toEqual([128]);
  });

  it('trusts an imported row, which already carries its volume', () => {
    const entry = { row: 0, note: 'C-4', instrument: '01' } as Record<string, unknown>;
    entry.xmCell = [49, 1, 0, 0, 0];
    entry.xmSig = xmEntrySignature(entry as never);
    expect(velocities([entry])).not.toEqual([64]);
  });
});
