import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { markRaw, toRaw } from 'vue';
import JSZip from 'jszip';

import TrackerSpectrumAnalyzer from 'src/components/tracker/TrackerSpectrumAnalyzer.vue';
import { resetPostFxRegistryForTests } from '@another-synth/tracker-playback';
import { buildSidChainSong } from './helpers/sid-chain-song';

/**
 * plan-sid-tracking.md S4, Morten's visual-parity requirement (2026-09-23
 * 13:54): a SID song gets REAL per-track spectrum taps and waveform hooks,
 * never the `moduleFormat === 'ahx' -> []` master fallback, in the tracker
 * AND the jukebox (both pages take them from `useTrackerSongHost`).
 *
 * The jt_letgo rule: the host half goes through the REAL load path. A real
 * SidDoc (S3's chain song, made with the doc's ops) is adopted by a real
 * tracker store, saved as a real `.cmod` (the JSON the store serializes, in
 * the zip `parseSongBuffer` opens), and loaded by the real host:
 * `parseSongBuffer` -> `applySongFile` (the funnel the tracker's open and the
 * jukebox's playlist both end in), with the real song bank on a stubbed
 * AudioContext. Red on the unfixed host: it resolves taps through bank
 * instruments, and a SID slot has none, so every tap was null.
 *
 * The taps are the song bank's own per-track monitors (`getTrackTap`), the
 * node a sampled track's voices feed; the SID worklet's voice outputs are
 * routed into them (`SidSongTransport.connectVoiceTaps`, pinned in
 * `sid-playback-chain.test.ts`).
 */

// ---------------------------------------------------------------------------
// The real song bank on a stubbed context (jukebox-spectrum-ahx's pattern).
// ---------------------------------------------------------------------------

class FakeAudioParam {
  value = 1;
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
  cancelScheduledValues(): void {}
  setTargetAtTime(): void {}
}

let gainCount = 0;
class FakeGainNode {
  readonly gain = new FakeAudioParam();
  readonly numberOfOutputs = 1;
  readonly serial = gainCount++;
  context: unknown = null;
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
    const node = new FakeGainNode();
    node.context = this;
    return node;
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

async function freshHost(options: { spectrum?: boolean; waveforms?: boolean } = {}) {
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
  (globalThis as { AudioContext?: unknown }).AudioContext = FakeAudioContextStub as unknown;
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = FakeAudioWorkletNode as unknown;

  const { useTrackerStore } = await import('src/stores/tracker-store');
  const { useUserSettingsStore } = await import('src/stores/user-settings-store');
  const { useTrackerSongHost } = await import('src/composables/useTrackerSongHost');

  setActivePinia(createPinia());
  const settings = useUserSettingsStore();
  settings.settings.showSpectrumAnalyzer = options.spectrum ?? true;
  settings.settings.showWaveformVisualizers = options.waveforms ?? true;

  const trackerStore = useTrackerStore();
  trackerStore.initializeIfNeeded();
  const host = useTrackerSongHost();
  return { host, trackerStore, useTrackerStore };
}

/** A real SID song as a real `.cmod`: the chain doc adopted by a store, serialized, zipped. */
async function sidCmod(): Promise<ArrayBuffer> {
  const { useTrackerStore } = await import('src/stores/tracker-store');
  setActivePinia(createPinia());
  const source = useTrackerStore();
  source.adoptSidDoc(buildSidChainSong());
  const zip = new JSZip();
  zip.file('song.json', JSON.stringify(source.serializeSong()));
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** The real load funnel both pages end in: format detection, then the full apply. */
async function loadSid(host: Awaited<ReturnType<typeof freshHost>>['host']) {
  const cmod = await sidCmod();
  const file = await host.parseSongBuffer(cmod);
  await host.applySongFile(file);
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  vi.restoreAllMocks();
});

describe('a SID song loaded through the real path gets real per-track taps', () => {
  it('spectrum: three non-null taps, one per voice, the bank\'s own track monitors (never the master fallback)', async () => {
    const { host, trackerStore } = await freshHost();
    await loadSid(host);
    expect(trackerStore.moduleFormat).toBe('sid');
    expect(trackerStore.sidDoc).not.toBeNull();
    expect(host.trackCount.value).toBe(3);

    // `toRaw`: the fake nodes are plain classes, which Vue proxies inside the
    // host's refs; a real GainNode is never proxied.
    const taps = host.spectrumTrackNodes.value.map((node) => (node ? toRaw(node) : node));
    expect(taps).toHaveLength(3);
    expect(taps.every((node) => node !== null)).toBe(true);
    expect(new Set(taps).size).toBe(3);
    taps.forEach((node, i) => expect(node).toBe(host.songBank.getTrackTap(i)));
  }, 20000);

  it('waveforms: every voice\'s visualizer node is its tap, before and during playback', async () => {
    const { host } = await freshHost();
    await loadSid(host);
    const nodes = [0, 1, 2].map((i) => {
      const node = host.trackAudioNodes.value[i] ?? null;
      return node ? toRaw(node) : null;
    });
    expect(nodes.every((node) => node !== null)).toBe(true);
    nodes.forEach((node, i) => expect(node).toBe(host.songBank.getTrackTap(i)));
    // A voice with nothing on the current position still has its node: the
    // voice is the track, not a bank instrument that may or may not play.
    host.updateTrackAudioNodes();
    expect([0, 1, 2].map((i) => toRaw(host.trackAudioNodes.value[i]))).toEqual(nodes);
    // The per-note callback the playback store makes keeps it too, and so
    // do a play's and a stop's clears (no per-note callback brings a SID
    // voice's tap back: it must survive them).
    host.setTrackAudioNodeForInstrument(1, '02');
    expect(toRaw(host.trackAudioNodes.value[1])).toBe(nodes[1]);
    host.clearTrackAudioNodes();
    expect([0, 1, 2].map((i) => toRaw(host.trackAudioNodes.value[i]))).toEqual(nodes);
  }, 20000);

  it('with nothing looking (analyzer and scopes off) there are no taps, as for a native song', async () => {
    const { host } = await freshHost({ spectrum: false, waveforms: false });
    await loadSid(host);
    expect(host.spectrumTrackNodes.value).toEqual([null, null, null]);
    expect([0, 1, 2].map((i) => host.trackAudioNodes.value[i] ?? null)).toEqual([null, null, null]);
  }, 20000);

  it('AHX keeps its master fallback and a native song its tap array (unchanged)', async () => {
    const { host, trackerStore } = await freshHost();
    expect(host.spectrumTrackNodes.value).toHaveLength(host.trackCount.value);
    const demo = readFileSync(resolve(__dirname, '../../public/demos/ahx/(iridion 0.5)q22.ahx'));
    const file = await host.parseSongBuffer(demo.buffer.slice(demo.byteOffset, demo.byteOffset + demo.byteLength) as ArrayBuffer);
    await host.applySongFile(file);
    expect(trackerStore.moduleFormat).toBe('ahx');
    expect(host.spectrumTrackNodes.value).toEqual([]);
  }, 20000);
});

describe('both pages take the SID taps from the host', () => {
  const page = (name: string) => readFileSync(resolve(__dirname, '../pages', name), 'utf8');
  it('TrackerPage and JukeboxPage feed the analyzer the host\'s spectrum taps and each track\'s scope its node', () => {
    for (const name of ['TrackerPage.vue', 'JukeboxPage.vue']) {
      const src = page(name);
      expect(src, name).toContain(':track-nodes="spectrumTrackNodes"');
      expect(src, name).toMatch(/:audio-node="trackAudioNodes\[index( - 1)?\] \?\? null"/);
      // A SID song's scopes are its taps, not the AHX worklet's capture.
      expect(src, name).toContain(':scope-source="isAhxSong ? playbackStore.getAhxChannelWaveform : null"');
    }
  });
  it('S5.7: both pages tell the analyzer a SID song is mono (per source, not a global setting)', () => {
    expect(page('TrackerPage.vue')).toContain(':mono="isSidSong"');
    expect(page('JukeboxPage.vue')).toContain(':mono="trackerStore.isSidSong"');
    for (const name of ['TrackerPage.vue', 'JukeboxPage.vue']) {
      expect(page(name).match(/<TrackerSpectrumAnalyzer[\s\S]*?\/>/)?.[0], name).toMatch(/:mono=/);
    }
  });
});

// ---------------------------------------------------------------------------
// The analyzer: three live taps are a per-track layout, like four.
// ---------------------------------------------------------------------------

interface FakeEndpoint {
  connect: (target: unknown, output?: number) => unknown;
  disconnect: (...targets: unknown[]) => void;
}
let connections: { from: FakeEndpoint; to: unknown; output?: number | undefined }[] = [];
function endpoint(): FakeEndpoint {
  return {
    connect(target: unknown, output?: number) {
      connections.push({ from: this, to: target, output });
      return target;
    },
    disconnect(...targets: unknown[]) {
      connections = connections.filter((c) => !(c.from === this && (targets.length === 0 || targets.includes(c.to))));
    },
  };
}
function fakeAnalyzerContext() {
  const analysers: FakeEndpoint[] = [];
  return {
    analysers,
    createAnalyser() {
      const a = { ...endpoint(), fftSize: 0, smoothingTimeConstant: 0, frequencyBinCount: 1024, getByteFrequencyData: () => undefined };
      analysers.push(a);
      return a;
    },
    createChannelSplitter() {
      return endpoint();
    },
  };
}
const tap = (context: unknown): AudioNode => markRaw({ context, ...endpoint(), numberOfOutputs: 1 }) as unknown as AudioNode;
const twoFrames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

describe('TrackerSpectrumAnalyzer with a SID song\'s three taps', () => {
  beforeEach(() => {
    connections = [];
  });

  it('three live taps -> per-track mode: each voice feeds its own analyser, the master none', async () => {
    const ctx = fakeAnalyzerContext();
    const master = tap(ctx);
    const voices = [0, 1, 2].map(() => tap(ctx));
    const w = mount(TrackerSpectrumAnalyzer, { props: { node: master, trackNodes: voices, isPlaying: true } });
    await twoFrames();
    expect(connections.filter((c) => c.from === master)).toHaveLength(0);
    for (const voice of voices) {
      const conns = connections.filter((c) => c.from === voice);
      expect(conns).toHaveLength(1);
      expect(ctx.analysers).toContain(conns[0]!.to);
    }
    expect(ctx.analysers).toHaveLength(3);
    w.unmount();
  });

  it('S5.7 mono (a SID song): ONE analyser straight on the master -- no splitter, no voice spread over both strips', async () => {
    const ctx = fakeAnalyzerContext();
    const master = tap(ctx);
    const voices = [0, 1, 2].map(() => tap(ctx));
    const w = mount(TrackerSpectrumAnalyzer, { props: { node: master, trackNodes: voices, isPlaying: true, mono: true } });
    await twoFrames();
    expect(ctx.analysers).toHaveLength(1);
    const fromMaster = connections.filter((c) => c.from === master);
    expect(fromMaster).toHaveLength(1);
    expect(fromMaster[0]!.to).toBe(ctx.analysers[0]);
    for (const voice of voices) expect(connections.filter((c) => c.from === voice)).toHaveLength(0);
    // Leaving mono (the next song is a MOD) rebuilds the per-track graph.
    await w.setProps({ mono: false });
    expect(connections.filter((c) => c.from === master)).toHaveLength(0);
    expect(ctx.analysers).toHaveLength(4); // the mono one (torn down) + one per voice
    for (const voice of voices) expect(connections.filter((c) => c.from === voice)).toHaveLength(1);
    w.unmount();
  });

  it('S5.7 mono with no taps: still one trace; the same props without mono keep the L/R pair', async () => {
    const monoCtx = fakeAnalyzerContext();
    const monoMaster = tap(monoCtx);
    const m = mount(TrackerSpectrumAnalyzer, { props: { node: monoMaster, trackNodes: [], isPlaying: false, mono: true } });
    await twoFrames();
    expect(monoCtx.analysers).toHaveLength(1);
    m.unmount();

    connections = [];
    const stereoCtx = fakeAnalyzerContext();
    const stereoMaster = tap(stereoCtx);
    const s = mount(TrackerSpectrumAnalyzer, { props: { node: stereoMaster, trackNodes: [], isPlaying: false } });
    await twoFrames();
    expect(stereoCtx.analysers).toHaveLength(2);
    s.unmount();
  });

  it('S5.13 per-source discrimination unchanged: the stereo master keeps its splitter and a distinct analyser per side', async () => {
    const ctx = fakeAnalyzerContext();
    const master = tap(ctx);
    const w = mount(TrackerSpectrumAnalyzer, { props: { node: master, trackNodes: [], isPlaying: true } });
    await twoFrames();
    expect(ctx.analysers).toHaveLength(2);
    const fromMaster = connections.filter((c) => c.from === master);
    expect(fromMaster).toHaveLength(1);
    expect(ctx.analysers).not.toContain(fromMaster[0]!.to); // the splitter, not an analyser
    const splitterOut = connections.filter((c) => c.from === fromMaster[0]!.to);
    expect(splitterOut.map((c) => [c.output, c.to])).toEqual([
      [0, ctx.analysers[0]],
      [1, ctx.analysers[1]],
    ]);
    expect(ctx.analysers[0]).not.toBe(ctx.analysers[1]);
    w.unmount();
  });

  it('three null taps (nothing looking yet) -> the stereo master graph, like four', async () => {
    const ctx = fakeAnalyzerContext();
    const master = tap(ctx);
    const w = mount(TrackerSpectrumAnalyzer, { props: { node: master, trackNodes: [null, null, null], isPlaying: false } });
    await twoFrames();
    expect(connections.filter((c) => c.from === master)).toHaveLength(1);
    expect(ctx.analysers).toHaveLength(2);
    w.unmount();
  });
});

// ---------------------------------------------------------------------------
// S5.13: what the strips actually paint. A recording 2D context per canvas and
// a fixed strip size, so the draw loop runs in jsdom; each analyser returns a
// ramp (bin i -> i), so every bar differs and a mismatch can't hide.
// ---------------------------------------------------------------------------

type Rect = [number, number, number, number];
const STRIP_W = 160;
const STRIP_H = 40;

function paintingAnalyzerContext() {
  const ctx = fakeAnalyzerContext();
  const reads: unknown[] = [];
  const createAnalyser = ctx.createAnalyser.bind(ctx);
  ctx.createAnalyser = () => {
    const a = createAnalyser();
    (a as { getByteFrequencyData: (arr: Uint8Array) => void }).getByteFrequencyData = (arr: Uint8Array) => {
      reads.push(a);
      for (let i = 0; i < arr.length; i++) arr[i] = Math.min(255, 40 + i);
    };
    return a;
  };
  return { ...ctx, reads };
}

function recordCanvases() {
  const painted = new Map<HTMLCanvasElement, { rects: Rect[]; frames: number }>();
  vi.spyOn(HTMLCanvasElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ left: 0, top: 0, right: STRIP_W, bottom: STRIP_H, width: STRIP_W, height: STRIP_H, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect,
  );
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(function (this: HTMLCanvasElement) {
    let rec = painted.get(this);
    if (!rec) painted.set(this, (rec = { rects: [], frames: 0 }));
    const r = rec;
    return {
      fillStyle: '',
      scale: () => undefined,
      clearRect: () => {
        r.frames++;
        r.rects = []; // keep only the latest frame
      },
      fillRect: (x: number, y: number, w: number, h: number) => r.rects.push([x, y, w, h]),
      createLinearGradient: () => ({ addColorStop: () => undefined }),
    } as unknown as CanvasRenderingContext2D;
  } as unknown as typeof HTMLCanvasElement.prototype.getContext);
  return painted;
}

function strips(w: ReturnType<typeof mount>) {
  const [l, r] = w.findAll('canvas').map((c) => c.element as HTMLCanvasElement);
  return { l: l!, r: r! };
}

/** A left-strip rect reflected about the screen center (the left strip's right edge). */
const reflect = ([x, y, w, h]: Rect): Rect => [STRIP_W - x - w, y, w, h];
const round = (rects: Rect[]) => rects.map((rect) => rect.map((v) => Math.round(v * 1000) / 1000));

describe('S5.13: a mono (SID) trace is mirrored across the screen center', () => {
  beforeEach(() => {
    connections = [];
  });

  it('mono: ONE analyser, painted in BOTH strips -- the right strip is the left one mirrored', async () => {
    const painted = recordCanvases();
    const ctx = paintingAnalyzerContext();
    const master = tap(ctx);
    const voices = [0, 1, 2].map(() => tap(ctx));
    const w = mount(TrackerSpectrumAnalyzer, { props: { node: master, trackNodes: voices, isPlaying: true, mono: true } });
    await twoFrames();
    await twoFrames();

    // Still one analyser on the master, nothing on the voices.
    expect(ctx.analysers).toHaveLength(1);
    expect(connections.filter((c) => c.from === master).map((c) => c.to)).toEqual([ctx.analysers[0]]);
    for (const voice of voices) expect(connections.filter((c) => c.from === voice)).toHaveLength(0);

    const { l, r } = strips(w);
    const left = painted.get(l)!;
    const right = painted.get(r);
    expect(left.rects.length).toBeGreaterThan(0);
    expect(right?.rects.length ?? 0).toBeGreaterThan(0);
    // Same bars, same heights, reflected about the center line.
    expect(round(right!.rects)).toEqual(round(left.rects.map(reflect)));
    // The shared analyser is read once per frame, not once per strip (a second
    // read would advance its smoothing/peaks twice and break the mirror).
    expect(ctx.reads.length).toBe(left.frames);
    w.unmount();
  });

  it('stereo (not mono): each strip paints its own analyser, as before', async () => {
    const painted = recordCanvases();
    const ctx = paintingAnalyzerContext();
    const master = tap(ctx);
    const w = mount(TrackerSpectrumAnalyzer, { props: { node: master, trackNodes: [], isPlaying: true } });
    await twoFrames();
    await twoFrames();
    expect(ctx.analysers).toHaveLength(2);
    const { l, r } = strips(w);
    expect(painted.get(l)!.rects.length).toBeGreaterThan(0);
    expect(painted.get(r)!.rects.length).toBeGreaterThan(0);
    // Both analysers read, each once per frame of its own strip.
    expect(ctx.reads.filter((a) => a === ctx.analysers[0]).length).toBe(painted.get(l)!.frames);
    expect(ctx.reads.filter((a) => a === ctx.analysers[1]).length).toBe(painted.get(r)!.frames);
    w.unmount();
  });

  it('per-track (three live taps): quad layout unchanged -- two voices left, one right, one analyser each', async () => {
    const painted = recordCanvases();
    const ctx = paintingAnalyzerContext();
    const master = tap(ctx);
    const voices = [0, 1, 2].map(() => tap(ctx));
    const w = mount(TrackerSpectrumAnalyzer, { props: { node: master, trackNodes: voices, isPlaying: true } });
    await twoFrames();
    await twoFrames();
    expect(ctx.analysers).toHaveLength(3);
    const { l, r } = strips(w);
    const left = painted.get(l)!;
    const right = painted.get(r)!;
    // Left overlays two channels, right draws one: twice the fills per frame.
    expect(left.rects.length).toBeGreaterThan(right.rects.length);
    expect(ctx.reads.length).toBe(left.frames * 2 + right.frames);
    w.unmount();
  });
});
