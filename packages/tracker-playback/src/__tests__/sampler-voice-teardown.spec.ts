import { describe, it, expect } from 'vitest';
import { TrackerSamplerInstrument } from '../sampler-instrument';
import type {
  TrackerSamplerConfig,
  TrackerVolumeEnvelope,
} from '../tracker-sample';
import {
  resetSampleQuality,
  setSampleQuality,
} from '../sample-quality';

/**
 * Teardown used to run on setTimeout: seven sites registered a timer and a
 * closure per note-off, "not guaranteed to be prompt" by their own comment.
 * Disconnects now ride `onended`, which fires at the scheduled stop time.
 *
 * Pinned here: dense note-ons drain to zero voices after allNotesOff plus the
 * grace of their stop events; released voices drain through the releasing
 * set; a source stopped before it ever starts (where `onended` never fires)
 * is disconnected immediately; and the duplicated scheduleAutoVibratoStop
 * calls are gone — one osc.stop per note-off.
 */

interface Param {
  value: number;
  setValueAtTime: ReturnType<typeof vi.fn>;
  linearRampToValueAtTime: ReturnType<typeof vi.fn>;
  exponentialRampToValueAtTime: ReturnType<typeof vi.fn>;
  cancelScheduledValues: ReturnType<typeof vi.fn>;
}

const makeParam = (): Param => ({
  value: 1,
  setValueAtTime: vi.fn(),
  linearRampToValueAtTime: vi.fn(),
  exponentialRampToValueAtTime: vi.fn(),
  cancelScheduledValues: vi.fn(),
});

interface NodeStub {
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

interface SourceStub extends NodeStub {
  buffer: unknown;
  playbackRate: Param;
  detune: Param;
  loop: boolean;
  loopStart: number;
  loopEnd: number;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  onended: (() => void) | null;
}

interface OscStub extends NodeStub {
  type: string;
  frequency: Param;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function makeAudioContext() {
  const now = { t: 10 };
  const sources: SourceStub[] = [];
  const gains: NodeStub[] = [];
  const pans: NodeStub[] = [];
  const oscillators: OscStub[] = [];

  const ctx = {
    get currentTime() {
      return now.t;
    },
    set currentTime(value: number) {
      now.t = value;
    },
    sampleRate: 44100,
    state: 'running' as AudioContextState,
    destination: { connect: vi.fn() },
    createBuffer: (channels: number, length: number, rate: number) => {
      const channelData = Array.from(
        { length: channels },
        () => new Float32Array(length),
      );
      return {
        length,
        sampleRate: rate,
        duration: length / rate,
        getChannelData: (ch: number) => channelData[ch]!,
      };
    },
    createGain: (): NodeStub & { gain: Param } => {
      const node = { gain: makeParam(), connect: vi.fn(), disconnect: vi.fn() };
      gains.push(node);
      return node;
    },
    createStereoPanner: (): NodeStub & { pan: Param } => {
      const node = { pan: makeParam(), connect: vi.fn(), disconnect: vi.fn() };
      pans.push(node);
      return node;
    },
    createBufferSource: (): SourceStub => {
      const source: SourceStub = {
        buffer: null,
        playbackRate: makeParam(),
        detune: makeParam(),
        loop: false,
        loopStart: 0,
        loopEnd: 0,
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
        onended: null,
      };
      sources.push(source);
      return source;
    },
    createOscillator: (): OscStub => {
      const osc: OscStub = {
        type: 'sine',
        frequency: makeParam(),
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(),
        stop: vi.fn(),
      };
      oscillators.push(osc);
      return osc;
    },
  };
  return {
    ctx: ctx as unknown as AudioContext,
    sources,
    gains,
    pans,
    oscillators,
    now,
  };
}

const plainConfig = (): TrackerSamplerConfig => ({
  id: 'test-instrument',
  rootNote: 69,
  detune: 0,
  gain: 1,
  loopMode: 'off',
  loopStart: 0,
  loopEnd: 1,
});

const vibratoConfig = (): TrackerSamplerConfig => ({
  ...plainConfig(),
  trackerAutoVibrato: { type: 0, sweepTicks: 0, depth: 4, rate: 1 },
});

/** Sustain at 32, fading out over 64 ticks after key-off. */
const fadeEnvelope = (): TrackerVolumeEnvelope => ({
  points: [
    { tick: 0, value: 64 },
    { tick: 8, value: 32 },
  ],
  sustainPoint: 1,
  loopStart: 0,
  loopEnd: 0,
  loopEnabled: false,
  fadeout: 512,
});

const envelopeConfig = (): TrackerSamplerConfig => ({
  ...plainConfig(),
  trackerEnvelope: fadeEnvelope(),
});

function makeData(frames: number): Float32Array {
  const out = new Float32Array(frames);
  let state = 7;
  for (let i = 0; i < frames; i++) {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    out[i] = (state / 0x3fffffff - 1) * 0.5;
  }
  return out;
}

async function loadInstrument(config: TrackerSamplerConfig, voiceCount = 4) {
  resetSampleQuality();
  setSampleQuality({ oversampleFactor: 1, removeDcOffset: false });
  const audio = makeAudioContext();
  const instrument = new TrackerSamplerInstrument(
    audio.ctx.destination,
    audio.ctx,
  );
  await instrument.load(config, makeData(2000), 44100, 1, voiceCount);
  return { instrument, ...audio };
}

const mapsOf = (instrument: TrackerSamplerInstrument) => ({
  active: Reflect.get(instrument, 'activeVoices') as Map<number, unknown>,
  releasing: Reflect.get(instrument, 'releasingVoices') as Map<number, unknown>,
});

/** Simulate the audio clock reaching every scheduled stop: fire all onended. */
function fireAllOnended(sources: SourceStub[]): number {
  let fired = 0;
  for (const source of sources) {
    if (source.onended) {
      source.onended();
      fired++;
    }
  }
  return fired;
}

describe('voice teardown rides onended instead of setTimeout', () => {
  it('dense note-ons drain to empty after allNotesOff plus grace', async () => {
    const { instrument, sources, gains, pans, now } = await loadInstrument(
      plainConfig(),
      4,
    );

    // Dense: more notes than voices, across tracks, some stealing slots.
    for (let track = 0; track < 8; track++) {
      instrument.noteOnAtTime(60 + track, 100, now.t, { trackIndex: track });
    }
    const { active } = mapsOf(instrument);
    expect(active.size).toBeGreaterThan(0);

    instrument.allNotesOff();
    expect(active.size).toBe(0);

    // Grace: the audio clock reaches the scheduled stops.
    const fired = fireAllOnended(sources);
    expect(fired).toBeGreaterThan(0);
    for (const source of sources) {
      expect(source.disconnect).toHaveBeenCalled();
    }
    for (const gain of gains.slice(1)) {
      // gains[0] is the instrument's own output node; teardown only handles
      // per-voice stages.
      expect(gain.disconnect).toHaveBeenCalled();
    }
    for (const pan of pans) {
      expect(pan.disconnect).toHaveBeenCalled();
    }
  });

  it('released voices drain through the releasing set', async () => {
    const { instrument, sources, now } = await loadInstrument(envelopeConfig());

    instrument.noteOnAtTime(60, 100, now.t, { trackIndex: 0 });
    const voiceIndex = instrument.noteOnAtTime(62, 100, now.t, {
      trackIndex: 1,
      }) as number;
    const { active, releasing } = mapsOf(instrument);

    instrument.gateOffVoiceAtTime(voiceIndex, now.t);
    expect(active.size).toBe(1); // the other note still sounding
    expect(releasing.size).toBe(1);

    instrument.allNotesOff();
    expect(active.size).toBe(0);
    // allNotesOff cuts releasing voices too; both stop events then fire.
    fireAllOnended(sources);
    expect(releasing.size).toBe(0);
    for (const source of sources) {
      expect(source.disconnect).toHaveBeenCalled();
    }
  });

  it('the releasing slot is freed when the release completes on its own', async () => {
    const { instrument, sources, now } = await loadInstrument(envelopeConfig());
    const voiceIndex = instrument.noteOnAtTime(60, 100, now.t, {
      trackIndex: 0,
      }) as number;
    instrument.gateOffVoiceAtTime(voiceIndex, now.t);
    const { releasing } = mapsOf(instrument);
    expect(releasing.size).toBe(1);

    expect(fireAllOnended(sources)).toBe(1);
    expect(releasing.size).toBe(0);
  });

  it('a source stopped before it starts is disconnected immediately', async () => {
    const { instrument, sources, now } = await loadInstrument(plainConfig());

    // Scheduled a second ahead, then cut before that start time arrives.
    instrument.noteOnAtTime(60, 100, now.t + 1, { trackIndex: 0 });
    const voiceIndex = Reflect.get(
      instrument,
      'trackVoices',
    ) as Map<number, number>;
    const slot = voiceIndex.get(0)!;
    const { active } = mapsOf(instrument);
    expect(active.has(slot)).toBe(true);

    const source = sources[sources.length - 1]!;
    source.disconnect.mockClear();
    instrument.cutVoiceAtTime(slot, now.t + 0.005); // stopAt < startTime

    // Immediate: disconnected synchronously, no onended needed.
    expect(source.disconnect).toHaveBeenCalled();
    expect(active.has(slot)).toBe(false);
  });

  it('a releasing voice whose scheduled stop already passed disconnects directly', async () => {
    const { instrument, sources, now } = await loadInstrument(envelopeConfig());
    const voiceIndex = instrument.noteOnAtTime(60, 100, now.t, {
      trackIndex: 0,
      }) as number;
    instrument.gateOffVoiceAtTime(voiceIndex, now.t);

    // The fade runs out before anyone touches the voice again: the source has
    // already stopped, so onended will not fire again.
    now.t += 5;
    const source = sources[sources.length - 1]!;
    source.disconnect.mockClear();
    instrument.cutVoiceAtTime(voiceIndex, now.t + 0.01);

    expect(source.disconnect).toHaveBeenCalled();
    const { releasing } = mapsOf(instrument);
    expect(releasing.size).toBe(0);
  });

  it('autovibrato is stopped exactly once per note-off', async () => {
    const { instrument, oscillators, sources, now } =
      await loadInstrument(vibratoConfig());

    instrument.noteOnAtTime(60, 100, now.t, { trackIndex: 0 });
    expect(oscillators.length).toBe(1);
    const osc = oscillators[0]!;
    instrument.gateOffVoiceAtTime(0, now.t);

    expect(osc.stop).toHaveBeenCalledTimes(1); // no duplicated calls
    expect(fireAllOnended(sources)).toBe(1);
    // And the LFO is disconnected with the voice.
    expect(osc.disconnect).toHaveBeenCalled();
  });
});
