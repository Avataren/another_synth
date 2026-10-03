import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { importXmToTrackerSong } from 'src/audio/tracker/xm-import';
import { deserializePatch } from 'src/audio/serialization/patch-serializer';
import ModInstrument from 'src/audio/mod-instrument';
import { resetSampleQuality, setSampleQuality } from '@another-synth/tracker-playback';

const param = () => ({ value: 1, setValueAtTime: vi.fn(), linearRampToValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn(), cancelScheduledValues: vi.fn() });
function audio() {
  const sources: Array<{ buffer: { length: number } | null }> = [];
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const ctx = {
    currentTime: 10,
    sampleRate: 44100,
    destination: node(),
    createBuffer: (c: number, length: number, rate: number) => {
      const d = Array.from({ length: c }, () => new Float32Array(length));
      return { length, sampleRate: rate, duration: length / rate, getChannelData: (i: number) => d[i]! };
    },
    createGain: () => ({ ...node(), gain: param() }),
    createStereoPanner: () => ({ ...node(), pan: param() }),
    createBufferSource: () => {
      const s = { ...node(), buffer: null as { length: number } | null, playbackRate: param(), detune: param(), loop: false, loopStart: 0, loopEnd: 0, start: vi.fn(), stop: vi.fn(), onended: null };
      sources.push(s);
      return s;
    },
    createOscillator: () => ({ ...node(), type: 'sine', frequency: param(), start: vi.fn(), stop: vi.fn() }),
  };
  return { ctx: ctx as unknown as AudioContext, sources };
}

describe('a multi-sample XM instrument through the real patch path', () => {
  it('keeps its zones across the song bank normalisation and plays the keymap sample', async () => {
    resetSampleQuality();
    setSampleQuality({ oversampleFactor: 1, removeDcOffset: false, antiAliasHighNotes: false });
    const bytes = readFileSync(resolve(__dirname, '../../public/demos/ft2/artificial_sweetener.xm'));
    const song = importXmToTrackerSong(new Uint8Array(bytes).slice().buffer);
    const slot = song.data.instrumentSlots.find((s) => s.xmInstrument && new Set(s.xmInstrument.keymap).size > 1)!;
    const meta = slot.xmInstrument!;
    const patch = song.data.songPatches[slot.patchId!]!;

    // What the bank does before loading: deserialize and re-serialise through the whitelist.
    const d = deserializePatch(patch);
    const sampler = [...d.samplers.values()][0]!;
    expect(sampler.trackerZones?.length).toBe(meta.samples.length - 1);
    expect(sampler.trackerZoneMap).toEqual(meta.keymap);

    const a = audio();
    const instrument = new ModInstrument(a.ctx.destination, a.ctx);
    await instrument.loadPatch({ ...patch, synthState: { ...patch.synthState, samplers: Object.fromEntries(d.samplers) } });

    // Play the lowest and highest note that map to different samples.
    const lo = meta.keymap.indexOf(meta.keymap[0]!);
    const other = meta.keymap.findIndex((z) => z !== meta.keymap[0]);
    expect(other).toBeGreaterThan(0);
    instrument.noteOnAtTime(lo + 12, 100, 11, { trackIndex: 0 });
    instrument.noteOnAtTime(other + 12, 100, 11, { trackIndex: 1 });
    const lengths = a.sources.map((s) => s.buffer!.length);
    const frames = (zone: number) => {
      if (zone === 0) return sampler.sampleLength;
      const asset = patch.audioAssets[sampler.trackerZones![zone - 1]!.assetId]!;
      return Math.round((asset.duration ?? 0) * asset.sampleRate);
    };
    expect(lengths[0]).toBe(frames(meta.keymap[lo]!));
    expect(lengths[1]).toBe(frames(meta.keymap[other]!));
    expect(lengths[0]).not.toBe(lengths[1]);
  });
});
