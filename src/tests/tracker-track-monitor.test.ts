import { describe, it, expect, vi } from 'vitest';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import ModInstrument from 'src/audio/mod-instrument';
import type AudioSystem from 'src/audio/AudioSystem';

/**
 * Per-track visualiser taps.
 *
 * The waveform strips used to read the *instrument's* output. One sample is one
 * instrument here, and an instrument is shared by every channel that plays it,
 * so two channels on the same sample drew the same waveform -- their sum -- and
 * a channel's display jumped to a different mix entirely the moment it changed
 * instrument. Voices now also connect to a tap belonging to their channel.
 */

function createMockAudioSystem() {
  const make = () => ({
    gain: { value: 1 },
    connect: vi.fn(),
    disconnect: vi.fn(),
    numberOfOutputs: 1,
  });
  return {
    audioContext: {
      sampleRate: 48000,
      currentTime: 0,
      state: 'running' as const,
      createGain: make,
      destination: make(),
      onstatechange: null as unknown,
    },
    destinationNode: { connect: vi.fn(), numberOfOutputs: 1 },
  };
}

function makeBank() {
  const bank = new TrackerSongBank(
    createMockAudioSystem() as unknown as AudioSystem,
  );
  const noteOnAtTime = vi.fn(
    (
      _midi: number,
      _velocity: number,
      _time: number,
      _options?: { monitorNode?: AudioNode },
    ) => 0,
  );
  // A real ModInstrument shell, so the bank's instanceof check is meaningful
  // rather than mocked away -- that check is what decides which node a track's
  // visualiser reads.
  const instrument = Object.create(ModInstrument.prototype) as ModInstrument;
  Object.assign(instrument, {
    outputNode: { connect: vi.fn() },
    getVoiceLimit: () => 4,
    getQuantumDurationSeconds: () => 128 / 48000,
    noteOnAtTime,
    gateOffVoiceAtTime: vi.fn(),
    cutVoiceAtTime: vi.fn(),
    cancelAndSilenceVoice: vi.fn(),
    workletNode: null,
  });
  // `isReady` is a getter on the prototype, so it has to be redefined rather
  // than assigned.
  Object.defineProperty(instrument, 'isReady', { get: () => true });
  const instruments = Reflect.get(bank as object, 'instruments') as Map<
    string,
    unknown
  >;
  instruments.set('01', {
    instrument,
    patchId: 'p',
    patchReuseKey: null,
    hasPortamento: false,
  });
  return { bank, noteOnAtTime, instrument };
}

describe('each track gets its own tap', () => {
  it('hands a different monitor to each track', () => {
    const { bank } = makeBank();

    expect(bank.getTrackMonitor(0)).not.toBe(bank.getTrackMonitor(1));
  });

  it('reuses the same monitor for a track', () => {
    const { bank } = makeBank();

    expect(bank.getTrackMonitor(3)).toBe(bank.getTrackMonitor(3));
  });

  it('gives a voice the monitor for its own channel', () => {
    const { bank, noteOnAtTime } = makeBank();

    bank.noteOnAtTime('01', 60, 100, 1, 2);

    const options = noteOnAtTime.mock.calls[0]![3];
    expect(options?.monitorNode).toBe(bank.getTrackMonitor(2));
  });

  it('points a mod track at its monitor rather than the shared instrument', () => {
    const { bank, instrument } = makeBank();

    const node = bank.getTrackVisualizationNode(1, '01');

    expect(node).toBe(bank.getTrackMonitor(1));
    expect(node).not.toBe(instrument.outputNode);
  });

  it('gives two tracks on the same instrument different nodes', () => {
    // The whole point: sharing an instrument must not mean sharing a display.
    const { bank } = makeBank();

    expect(bank.getTrackVisualizationNode(0, '01')).not.toBe(
      bank.getTrackVisualizationNode(1, '01'),
    );
  });

  it('falls back to the instrument output for other instrument types', () => {
    // Only ModInstrument routes per voice, so anything else keeps the old
    // behaviour rather than showing a flat line.
    const { bank } = makeBank();
    const instruments = Reflect.get(bank as object, 'instruments') as Map<
      string,
      { instrument: { outputNode: unknown } }
    >;
    const output = { connect: vi.fn() };
    instruments.set('02', {
      instrument: { outputNode: output },
    } as unknown as { instrument: { outputNode: unknown } });

    expect(bank.getTrackVisualizationNode(0, '02')).toBe(output);
  });

  it('has no node for a track with no instrument', () => {
    const { bank } = makeBank();
    expect(bank.getTrackVisualizationNode(0, undefined)).toBeNull();
  });
});
