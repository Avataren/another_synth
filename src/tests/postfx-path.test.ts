/**
 * Path pins: audio routes through the post-fx rack on both playback paths
 * (plan test item 5, D117).
 *
 * The test env has no Web Audio, so `AudioContext` is replaced with a stub
 * before the module under test is imported; every connect() edge is
 * recorded. Both paths converge on one graph by construction -- the jukebox
 * drives the same shared song bank (`useTrackerSongHost` ->
 * `trackerAudioStore.songBank`) -- so the graph pins cover both, and the
 * recorder re-tap is pinned on the bank itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Recorded = { from: unknown; to: unknown };

let connections: Recorded[] = [];

class FakeAudioParam {
  value = 1;
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
  cancelScheduledValues(): void {}
}

class FakeGainNode {
  readonly gain = new FakeAudioParam();
  readonly numberOfOutputs = 1;
  connect(target: unknown): FakeGainNode {
    connections.push({ from: this, to: target });
    return this;
  }
  disconnect(..._: unknown[]): void {}
}

class FakeAudioContext {
  sampleRate = 44100;
  currentTime = 0;
  state = 'running';
  readonly destination = new FakeGainNode();
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) };
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  createIIRFilter(feedforward: number[], feedback: number[]): object {
    return {
      feedforward,
      feedback,
      connect: (): void => undefined,
      disconnect: (): void => undefined,
    };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeAudioWorkletNode {
  readonly port = {
    set onmessage(_handler: unknown) {},
  };
  connect(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  connections = [];
  localStorage.clear();
  // AudioSystem reads matchMedia for the latency hint; jsdom has none.
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    addListener: () => undefined,
    removeListener: () => undefined,
    onchange: null,
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  (globalThis as { AudioContext?: unknown }).AudioContext =
    FakeAudioContext as unknown;
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode =
    FakeAudioWorkletNode as unknown;
});

afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
});

async function freshGraph() {
  // The post-fx registry is module-global; reset it so a fresh AudioSystem
  // registers into a clean set.
  const registry = await import('@another-synth/tracker-playback');
  registry.resetPostFxRegistryForTests();

  const { default: AudioSystem } = await import('src/audio/AudioSystem');
  const { TrackerSongBank } = await import('src/audio/tracker/song-bank');
  const { SongBankRecorder } = await import('src/audio/tracker/recorder');

  const system = new AudioSystem();
  const bank = new TrackerSongBank(system);
  return { system, bank, registry, TrackerSongBank, SongBankRecorder };
}

describe('the one speaker feed runs through the rack', () => {
  it('destinationNode -> rack.input, rack.output -> audioContext.destination', async () => {
    const { system, registry } = await freshGraph();
    const context = system.audioContext as unknown as {
      destination: FakeGainNode;
    };
    const destinationNode = system.destinationNode as unknown as FakeGainNode;
    const rackInput = system.postFxRack.input as unknown as FakeGainNode;
    const rackOutput = system.postFxRack.output as unknown as FakeGainNode;

    const connectedTo = (from: FakeGainNode, to: unknown) =>
      connections.some((c) => c.from === from && c.to === to);

    expect(connectedTo(destinationNode, rackInput)).toBe(true);
    expect(connectedTo(rackOutput, context.destination)).toBe(true);
    // The rack owns the LPF stage and registered itself for the store.
    expect(system.postFxRack.activeStages()).toEqual([system.postFxLpfStage]);
    expect(registry.getPostFxRack()?.rack).toBe(system.postFxRack);
    // The recorder tap point is the rack output (what-you-hear).
    expect(system.postFxOutput).toBe(system.postFxRack.output);
  });

  it('the tracker bank feeds the rack through destinationNode', async () => {
    const { system, bank } = await freshGraph();
    const destinationNode = system.destinationNode as unknown as FakeGainNode;
    // `output` is the bank's public accessor for masterGain.
    const masterGain = bank.output as unknown as FakeGainNode;
    expect(
      connections.some((c) => c.from === masterGain && c.to === destinationNode),
    ).toBe(true);
    // And destinationNode itself is the rack's input feed (pin above).
    expect(
      connections.some(
        (c) => c.from === destinationNode && c.to === system.postFxRack.input,
      ),
    ).toBe(true);
  });

  it('the recorder taps the rack output, not the pre-rack master bus', async () => {
    const { system, bank } = await freshGraph();
    const recorder = (
      bank as unknown as { recorder: { tapNode: unknown } }
    ).recorder;
    expect(recorder).toBeDefined();
    expect(recorder.tapNode).toBe(system.postFxOutput);
    expect(recorder.tapNode).not.toBe(system.destinationNode);
  });
});