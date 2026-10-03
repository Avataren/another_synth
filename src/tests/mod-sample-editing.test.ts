import { describe, expect, it } from 'vitest';
import type { ModSample } from '@another-synth/tracker-playback';
import type { InstrumentSlot } from 'src/stores/tracker-store';
import { emptyModSample, modSampleOfSlot, patchFromModSample } from 'src/audio/tracker/mod-sample-codec';
import { fromPcm, generateWave, halve, normalize, reverse, withData, withLoop } from 'src/audio/tracker/mod-sample-ops';

const sample = (over: Partial<ModSample> = {}): ModSample => ({
  ...emptyModSample(40),
  name: 'saw',
  data: Int8Array.from({ length: 64 }, (_, i) => i * 2 - 64),
  length: 64,
  finetune: -3,
  ...over,
});

describe('mod sample ops', () => {
  it('keeps loops inside the data and on word boundaries', () => {
    const s = withLoop(sample(), 7, 21);
    expect(s.loopStart % 2).toBe(0);
    expect(s.loopLength % 2).toBe(0);
    expect(s.loopStart + s.loopLength).toBeLessThanOrEqual(64);
    expect(withLoop(sample(), 10, 2).loopLength).toBe(0);
  });

  it('pads odd data to a word and refits the loop', () => {
    const s = withData(withLoop(sample(), 0, 64), new Int8Array(31));
    expect(s.data.length).toBe(32);
    expect(s.loopStart + s.loopLength).toBeLessThanOrEqual(32);
  });

  it('normalizes, reverses and halves', () => {
    const quiet = sample({ data: Int8Array.from([10, -20, 5, 0]) , length: 4 });
    expect(Math.max(...normalize(quiet).data.map(Math.abs))).toBe(127);
    expect(Array.from(reverse(quiet).data)).toEqual([0, 5, -20, 10]);
    expect(halve(sample()).data.length).toBe(32);
  });

  it('resamples a loaded file to the chosen note', () => {
    const pcm = new Float32Array(44100).fill(0.5);
    const s = fromPcm(emptyModSample(), pcm, 44100, 214);
    expect(s.data.length).toBe(Math.round(3546895 / 214));
    expect(s.data[10]).toBe(64);
  });
});

describe('new samples', () => {
  it('makes a looped single cycle of each wave', () => {
    for (const kind of ['sine', 'triangle', 'saw', 'square', 'noise'] as const) {
      const s = generateWave(emptyModSample(), kind, 64);
      expect(s.data.length, kind).toBe(64);
      expect([s.loopStart, s.loopLength], kind).toEqual([0, 64]);
      expect(s.name).toBe(kind);
    }
    expect(Array.from(generateWave(emptyModSample(), 'square', 8).data)).toEqual([127, 127, 127, 127, -127, -127, -127, -127]);
  });
});

describe('mod sample <-> patch', () => {
  it('survives the trip through a sampler patch', () => {
    const original = withLoop(sample(), 16, 32);
    const patch = patchFromModSample(3, original);
    const slot: InstrumentSlot = {
      slot: 3,
      bankName: '',
      patchId: patch.metadata.id,
      patchName: patch.metadata.name,
      instrumentName: 'saw',
      modVolume: 40,
    };
    const back = modSampleOfSlot(slot, patch);
    expect(back.name).toBe('saw');
    expect(back.volume).toBe(40);
    expect(back.finetune).toBe(-3);
    expect(Array.from(back.data)).toEqual(Array.from(original.data));
    expect([back.loopStart, back.loopLength]).toEqual([16, 32]);
  });

  it('an edit keeps the patch identity and bumps the revision', () => {
    const first = patchFromModSample(1, sample());
    const second = patchFromModSample(1, sample({ volume: 10 }), first);
    expect(second.metadata.id).toBe(first.metadata.id);
    expect(second.metadata.revision).toBe((first.metadata.revision ?? 0) + 1);
  });
});
