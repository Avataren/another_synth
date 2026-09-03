import { describe, it, expect, vi } from 'vitest';
import { TrackerSongBank } from 'src/audio/tracker/song-bank';
import type AudioSystem from 'src/audio/AudioSystem';

/**
 * Per-track monitoring is a cost with no benefit when nothing draws it.
 *
 * Each tap is a GainNode, a second connection from every voice that sounds
 * on the channel, and a branch kept awake by a silent sink -- times the
 * channel count, which for an XM is up to 32. That pays for the per-track
 * waveforms and the analyser's per-channel mode; the phone layout draws
 * neither (see useMobileLayout / useTrackerSongHost), and so does a desktop
 * with both visualizers turned off.
 */

interface FakeGain {
  gain: { value: number };
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

function createBank() {
  const created: FakeGain[] = [];
  const audioSystem = {
    audioContext: {
      sampleRate: 48000,
      currentTime: 0,
      state: 'running' as const,
      createGain: () => {
        const node: FakeGain = {
          gain: { value: 1 },
          connect: vi.fn(),
          disconnect: vi.fn(),
        };
        created.push(node);
        return node;
      },
      destination: { connect: vi.fn() },
      onstatechange: null as unknown,
    },
    destinationNode: { connect: vi.fn(), numberOfOutputs: 1 },
  };
  const bank = new TrackerSongBank(audioSystem as unknown as AudioSystem);
  // The bank builds its own master gain(s) at construction; only nodes made
  // after this point are the taps under test.
  const before = created.length;
  return { bank, tapsSince: () => created.slice(before) };
}

describe('per-track monitoring can be switched off', () => {
  it('builds a tap per track while it is on', () => {
    const { bank, tapsSince } = createBank();

    const first = bank.getTrackMonitor(0);
    const second = bank.getTrackMonitor(1);

    expect(first).not.toBe(second);
    // One node per track, plus the silent sink they share.
    expect(tapsSince()).toHaveLength(3);
    // The same track asks again and gets the tap it already has.
    expect(bank.getTrackMonitor(0)).toBe(first);
  });

  it('drops the taps and the sink when it is turned off', () => {
    const { bank } = createBank();
    const monitor = bank.getTrackMonitor(0) as unknown as FakeGain;

    bank.setTrackMonitoringEnabled(false);

    expect(monitor.disconnect).toHaveBeenCalled();
  });

  it('hands the visualizers nothing rather than building a tap for them', () => {
    // The subtle half: `getTrackVisualizationNode` is what the page calls,
    // and asking it for a node used to *create* the tap this mode exists to
    // avoid -- so the nodes would come back the moment a pattern loaded.
    const { bank, tapsSince } = createBank();
    bank.setTrackMonitoringEnabled(false);

    expect(bank.getTrackVisualizationNode(0, '01')).toBeNull();
    expect(tapsSince()).toHaveLength(0);
  });

  it('builds them again when it comes back on', () => {
    // A rotate into landscape, or the setting turned back on.
    const { bank } = createBank();
    bank.setTrackMonitoringEnabled(false);
    bank.setTrackMonitoringEnabled(true);

    expect(bank.getTrackMonitor(0)).toBeDefined();
  });
});
