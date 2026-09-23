import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { markRaw, nextTick } from 'vue';

import TrackerSpectrumAnalyzer from 'src/components/tracker/TrackerSpectrumAnalyzer.vue';
import { resetPostFxRegistryForTests } from '@another-synth/tracker-playback';

/**
 * The jukebox spectrum analyzer must show something for AHX and HVL songs.
 *
 * AHX/HVL songs are played by the worklet's file engine and carry no patches,
 * so the song bank has no per-track instruments and every per-track tap would
 * be permanently null. The host therefore offers NO taps for `moduleFormat
 * 'ahx'` (useTrackerSongHost.spectrumTrackNodes), which resolves the
 * analyzer's stereo fallback against the master output (the post-fx rack
 * output the file engine's audio actually reaches). This file pins both
 * halves of that contract:
 *
 *  - the component contract: no taps → stereo graph on the master node;
 *    four live taps → quad; quad → no taps → falls back to stereo.
 *  - the host contract, through the REAL production load path (real stores,
 *    real song bank on a stubbed AudioContext, real AHX/HVL demo bytes
 *    through parseSongBuffer → applySongFile): an AHX/HVL song exposes an
 *    empty tap array while a native-format song keeps the tap array shape.
 */

const DEMOS = resolve(__dirname, '../../public/demos');
const demoBytes = (file: string): ArrayBuffer => {
  const b = readFileSync(resolve(DEMOS, file));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};

// ---------------------------------------------------------------------------
// Fake audio nodes (oscilloscope-mono pattern): enough surface for the
// analyzer's graph build to run, with every connect recorded.
// ---------------------------------------------------------------------------

interface FakeEndpoint {
  connect: (target: unknown, output?: number) => unknown;
  disconnect: (...targets: unknown[]) => void;
}

let connections: {
  from: FakeEndpoint;
  to: unknown;
  output?: number | undefined;
}[] = [];

function endpoint(): FakeEndpoint {
  return {
    connect(target: unknown, output?: number) {
      connections.push({ from: this, to: target, output });
      return target;
    },
    disconnect(...targets: unknown[]) {
      connections = connections.filter(
        (c) => !(c.from === this && (targets.length === 0 || targets.includes(c.to))),
      );
    },
  };
}

interface FakeAnalyser extends FakeEndpoint {
  fftSize: number;
  smoothingTimeConstant: number;
  frequencyBinCount: number;
  getByteFrequencyData: () => void;
}

function fakeAnalyser(): FakeAnalyser {
  return {
    ...endpoint(),
    fftSize: 0,
    smoothingTimeConstant: 0,
    frequencyBinCount: 1024,
    getByteFrequencyData: () => undefined,
  } as FakeAnalyser;
}

function fakeAudioContext() {
  const analysers: FakeAnalyser[] = [];
  const splitters: FakeEndpoint[] = [];
  return {
    analysers,
    splitters,
    createAnalyser(): FakeAnalyser {
      const a = fakeAnalyser();
      analysers.push(a);
      return a;
    },
    createChannelSplitter(_channels: number): FakeEndpoint {
      const s = endpoint();
      splitters.push(s);
      return s;
    },
  };
}

/** A track/master tap standing in for the real AudioNodes the host returns. */
function fakeTap(context: ReturnType<typeof fakeAudioContext>): AudioNode {
  // markRaw: the component reads these through Vue props, and a reactive
  // proxy would break the identity assertions below (and be a node the real
  // pages never see).
  return markRaw({
    context,
    ...endpoint(),
    numberOfOutputs: 1,
  }) as unknown as AudioNode;
}

function connectionsFrom(from: unknown) {
  return connections.filter((c) => c.from === from);
}

const twoFrames = () =>
  new Promise<void>((r) =>
    requestAnimationFrame(() => requestAnimationFrame(() => r())),
  );

describe('TrackerSpectrumAnalyzer mode resolution (jukebox prop contract)', () => {
  beforeEach(() => {
    connections = [];
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('no track taps → builds the stereo graph from the master node (the AHX fallback)', async () => {
    const ctx = fakeAudioContext();
    const master = fakeTap(ctx);

    const w = mount(TrackerSpectrumAnalyzer, {
      props: { node: master, trackNodes: [], isPlaying: false },
    });
    await twoFrames();

    const masterConns = connectionsFrom(master);
    expect(masterConns.length).toBe(1);
    const splitter = masterConns[0]!.to;
    expect(ctx.splitters).toContain(splitter);
    const splitterConns = connections.filter((c) => c.from === splitter);
    expect(splitterConns.length).toBe(2);
    expect(splitterConns[0]!.output).toBe(0);
    expect(splitterConns[1]!.output).toBe(1);
    expect(ctx.analysers.length).toBe(2);

    w.unmount();
  });

  it('four live track taps → quad mode: every track tap feeds its own analyser', async () => {
    const ctx = fakeAudioContext();
    const master = fakeTap(ctx);
    const tracks = [0, 1, 2, 3].map(() => fakeTap(ctx));

    const w = mount(TrackerSpectrumAnalyzer, {
      props: { node: master, trackNodes: tracks, isPlaying: false },
    });
    await twoFrames();

    // Quad: no master connection; each of the four taps connects to one
    // analyser.
    expect(connectionsFrom(master).length).toBe(0);
    for (const track of tracks) {
      const conns = connectionsFrom(track);
      expect(conns.length).toBe(1);
      expect(ctx.analysers).toContain(conns[0]!.to);
    }
    expect(ctx.analysers.length).toBe(4);

    w.unmount();
  });

  it('quad → no track taps (the AHX handoff) → falls back to the stereo master graph', async () => {
    const ctx = fakeAudioContext();
    const master = fakeTap(ctx);
    const tracks = [0, 1, 2, 3].map(() => fakeTap(ctx));

    const w = mount(TrackerSpectrumAnalyzer, {
      props: { node: master, trackNodes: tracks, isPlaying: false },
    });
    await twoFrames();
    expect(ctx.analysers.length).toBe(4);

    // The host fix hands an empty array for AHX/HVL: the analyzer must leave
    // quad and rebuild stereo from the master node.
    await w.setProps({ trackNodes: [] });
    await nextTick();
    await twoFrames();

    const masterConns = connectionsFrom(master);
    expect(masterConns.length).toBe(1);
    const splitter = masterConns[0]!.to;
    const splitterConns = connections.filter((c) => c.from === splitter);
    expect(splitterConns.length).toBe(2);
    // A fresh stereo graph: two new analysers (the four quad ones were torn
    // down with their connections), fed 0 and 1 by the splitter.
    expect(splitterConns[0]!.output).toBe(0);
    expect(splitterConns[1]!.output).toBe(1);
    expect(splitterConns.every((c) => ctx.analysers.includes(c.to as never))).toBe(true);
    // The dead per-track connections are gone entirely.
    expect(tracks.every((t) => connectionsFrom(t).length === 0)).toBe(true);

    w.unmount();
  });
});

// ---------------------------------------------------------------------------
// Host-level: the real production load path (real stores, real song bank on
// a stubbed AudioContext, real demo bytes).
// ---------------------------------------------------------------------------

/** postfx-path pattern: the test env has no Web Audio. Suspended, so the
 *  AHX worklet handshake is never awaited (a fresh-tab deep-link load). */
class FakeAudioParam {
  value = 1;
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
  cancelScheduledValues(): void {}
}

class FakeGainNode {
  readonly gain = new FakeAudioParam();
  readonly numberOfOutputs = 1;
  connect(): FakeGainNode {
    return this;
  }
  disconnect(): void {}
}

class FakeAudioContextStub {
  sampleRate = 44100;
  currentTime = 0;
  state: AudioContextState = 'suspended';
  readonly destination = new FakeGainNode();
  addEventListener(): void {}
  removeEventListener(): void {}
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) };
  createGain(): FakeGainNode {
    return new FakeGainNode();
  }
  createIIRFilter(): object {
    return { connect: (): void => undefined, disconnect: (): void => undefined };
  }
  createDynamicsCompressor(): object {
    return {
      threshold: new FakeAudioParam(),
      knee: new FakeAudioParam(),
      ratio: new FakeAudioParam(),
      attack: new FakeAudioParam(),
      release: new FakeAudioParam(),
      reduction: 0,
      connect: (): void => undefined,
      disconnect: (): void => undefined,
    };
  }
  createWaveShaper(): object {
    return { curve: null, oversample: 'none', connect: (): void => undefined, disconnect: (): void => undefined };
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

class FakeAudioWorkletNode {
  readonly port = { set onmessage(_handler: unknown) {} };
  connect(): void {}
  disconnect(): void {}
}

async function freshHost() {
  localStorage.clear();
  resetPostFxRegistryForTests();
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
    FakeAudioContextStub as unknown;
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode =
    FakeAudioWorkletNode as unknown;

  // Dynamic imports AFTER the stubs, so the singletons build on the fake.
  const { useTrackerStore } = await import('src/stores/tracker-store');
  const { useUserSettingsStore } = await import('src/stores/user-settings-store');
  const { useTrackerSongHost } = await import('src/composables/useTrackerSongHost');

  setActivePinia(createPinia());
  // The tap-building watchers gate on the visualizer settings (phone layout
  // turns them off); a desktop page with the analyzer enabled is the pin.
  const settings = useUserSettingsStore();
  settings.settings.showSpectrumAnalyzer = true;

  const trackerStore = useTrackerStore();
  trackerStore.initializeIfNeeded();
  const host = useTrackerSongHost();
  return { host, trackerStore };
}

afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  vi.restoreAllMocks();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

describe('useTrackerSongHost spectrum taps through the real load path', () => {
  it('a native-format song keeps the per-track tap array shape (unchanged behavior)', async () => {
    const { host } = await freshHost();

    const taps = host.spectrumTrackNodes.value;
    expect(taps.length).toBe(host.trackCount.value);
    expect(host.trackCount.value).toBeGreaterThan(0);
    // No song playing and no instruments loaded: every tap is null, but the
    // array keeps one slot per track -- the transient-null case quad
    // stickiness exists for.
    expect(taps.every((n) => n === null)).toBe(true);
  }, 20000);

  it('a real 4-channel AHX demo loaded through the real path offers NO spectrum taps', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { host, trackerStore } = await freshHost();

    // The real load funnel: parseSongBuffer detects the format and imports,
    // applySongFile does the full store/bank/post-fx sequence.
        // The same two calls the shared load funnel makes
    // (loadSongFromBuffer): real format detection/import, then the full
    // applySongFile sequence.
    const songFile = await host.parseSongBuffer(demoBytes('ahx/(iridion 0.5)q22.ahx'));
    await host.applySongFile(songFile);

    expect(trackerStore.moduleFormat).toBe('ahx');
    // The display model still has the classic 4 tracks -- exactly the shape
    // that used to lock the analyzer into quad with four dead channels.
    expect(host.trackCount.value).toBe(4);
    expect(host.spectrumTrackNodes.value).toEqual([]);
  }, 20000);

  it('a real 4-channel HVL demo loaded through the real path offers NO spectrum taps', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const { host, trackerStore } = await freshHost();

        const songFile = await host.parseSongBuffer(demoBytes('ahx/ring_modulation_test_song.hvl'));
    await host.applySongFile(songFile);

    expect(trackerStore.moduleFormat).toBe('ahx');
    expect(host.trackCount.value).toBe(4);
    expect(host.spectrumTrackNodes.value).toEqual([]);
  }, 20000);
});
