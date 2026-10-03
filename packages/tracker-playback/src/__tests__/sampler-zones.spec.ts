import { describe, it, expect } from 'vitest';
import { TrackerSamplerInstrument } from '../sampler-instrument';
import type { TrackerSamplerConfig, TrackerZoneSet } from '../tracker-sample';
import { resetSampleQuality, setSampleQuality } from '../sample-quality';

/**
 * A multi-sample (XM) instrument picks its sample per note from the keymap, and
 * a voice keeps the sample it started on: a pitch slide after the note-on must
 * be computed against that sample's root note, not whichever played last.
 */

const param = () => ({
  value: 1,
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  exponentialRampToValueAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

function makeAudio() {
  const sources: Array<{ buffer: { length: number } | null; playbackRate: ReturnType<typeof param> }> = [];
  const node = () => ({ connect: vi.fn(), disconnect: vi.fn() });
  const ctx = {
    currentTime: 10,
    sampleRate: 44100,
    destination: node(),
    createBuffer: (channels: number, length: number, rate: number) => {
      const data = Array.from({ length: channels }, () => new Float32Array(length));
      return { length, sampleRate: rate, duration: length / rate, getChannelData: (c: number) => data[c]! };
    },
    createGain: () => ({ ...node(), gain: param() }),
    createStereoPanner: () => ({ ...node(), pan: param() }),
    createBufferSource: () => {
      const s = {
        ...node(),
        buffer: null as { length: number } | null,
        playbackRate: param(),
        detune: param(),
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      sources.push(s);
      return s;
    },
  };
  return { ctx: ctx as unknown as AudioContext, sources };
}

const config = (rootNote: number): TrackerSamplerConfig => ({
  id: `zone-${rootNote}`,
  rootNote,
  detune: 0,
  gain: 1,
  loopMode: 'off',
  loopStart: 0,
  loopEnd: 1,
});

// Zone 0 is 100 frames rooted at A4 (69), zone 1 is 300 frames rooted an octave up.
const zones = (): TrackerZoneSet => ({
  map: Array.from({ length: 96 }, (_, n) => (n >= 48 ? 1 : 0)),
  zones: [
    { config: config(69), data: new Float32Array(100).fill(0.1), sampleRate: 44100 },
    { config: config(81), data: new Float32Array(300).fill(0.2), sampleRate: 44100 },
  ],
});

async function loaded() {
  resetSampleQuality();
  setSampleQuality({ oversampleFactor: 1, removeDcOffset: false, antiAliasHighNotes: false });
  const audio = makeAudio();
  const instrument = new TrackerSamplerInstrument(audio.ctx.destination, audio.ctx);
  await instrument.loadZones(zones(), 4);
  return { instrument, ...audio };
}

describe('multi-sample instrument', () => {
  it('plays the sample the keymap names for each note', async () => {
    const { instrument, sources } = await loaded();
    // MIDI 59 is XM note 48 (B-3): zone 0. MIDI 60 is XM note 49 (C-4): zone 1.
    instrument.noteOnAtTime(59, 100, 11, { trackIndex: 0 });
    instrument.noteOnAtTime(60, 100, 11, { trackIndex: 1 });
    expect(sources[0]!.buffer!.length).toBe(100);
    expect(sources[1]!.buffer!.length).toBe(300);
  });

  it("works out each sample's playback rate against its own root note", async () => {
    const { instrument, sources } = await loaded();
    instrument.noteOnAtTime(59, 100, 11, { trackIndex: 0, frequency: 440 });
    instrument.noteOnAtTime(60, 100, 11, { trackIndex: 1, frequency: 440 });
    expect(sources[0]!.playbackRate.value).toBeCloseTo(1, 6); // root 69 at 440 Hz
    expect(sources[1]!.playbackRate.value).toBeCloseTo(0.5, 6); // root 81 is an octave higher
  });

  it('keeps a voice on its own sample when its pitch is changed later', async () => {
    const { instrument, sources } = await loaded();
    const low = instrument.noteOnAtTime(59, 100, 11, { trackIndex: 0, frequency: 440 })!;
    instrument.noteOnAtTime(60, 100, 11, { trackIndex: 1, frequency: 440 });
    // A slide on the low voice after the high note started still uses root 69.
    instrument.setFrequency(low, 880);
    const calls = sources[0]!.playbackRate.linearRampToValueAtTime.mock.calls;
    expect(calls.at(-1)![0]).toBeCloseTo(2, 6);
  });

  it('is an ordinary one-sample instrument through load()', async () => {
    resetSampleQuality();
    setSampleQuality({ oversampleFactor: 1, removeDcOffset: false });
    const audio = makeAudio();
    const instrument = new TrackerSamplerInstrument(audio.ctx.destination, audio.ctx);
    await instrument.load(config(69), new Float32Array(50), 44100, 1, 2);
    instrument.noteOnAtTime(30, 100, 11, { trackIndex: 0 });
    instrument.noteOnAtTime(100, 100, 11, { trackIndex: 1 });
    expect(audio.sources.map((s) => s.buffer!.length)).toEqual([50, 50]);
  });
});
