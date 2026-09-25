import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { toRaw } from 'vue';
import JSZip from 'jszip';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { SidPlayer, initSync } from '../../public/wasm/audio_processor.js';
import { resetPostFxRegistryForTests } from '@another-synth/tracker-playback';
import { SidProcessorCore, type SidCommand, type SidEvent, type SidWasmPlayerCtor } from 'src/audio/worklets/sid-core';
import { SID_RELOAD_IDLE_MS } from 'src/audio/tracker/sid-song-transport';
import { buildSidChainSong } from './helpers/sid-chain-song';
import { SID_CYCLES_PER_FRAME, SID_PAL_CLOCK_HZ } from 'src/audio/tracker/sid-instrument-visuals';

/**
 * plan-sid-tracking.md S4: a SID song PLAYS. The whole app-side chain runs
 * for real: a real SidDoc in a real tracker store, loaded through the real
 * host (`parseSongBuffer` -> `applySongFile`), played by the real playback
 * store (`play` -> the `'sid'` branch -> `SidSongTransport`), which makes the
 * real `SidPlayerClient` through the real `createSidPlayer` (its wasm
 * handshake included) and speaks the real command protocol to it.
 *
 * Only the browser's render thread is stood in for: `AudioWorkletNode` is a
 * fake whose port runs the REAL `SidProcessorCore` over the REAL rebuilt
 * wasm (`public/wasm`), and `pump(frames)` does what the shell's `process`
 * does (`sid-worklet.ts`: output 0 = mix on both sides, outputs 1..3 = the
 * voice taps) in 128-frame quanta. So every sample asserted on here is the
 * Rust SID player's, reached through every TS layer the browser uses.
 *
 * What is not proven here, and is stated in the verdict: that a browser runs
 * the processor (the shell's ten lines) and that the result is heard. The
 * manual check for Morten is recorded there.
 */

const ROOT = resolve(__dirname, '../..');
const SAMPLE_RATE = 44100;
/** One row, tempo 6 PAL frames (879.8 samples each at 44.1 kHz; GT-parity 0925b, was 6 x 882 at 50 Hz). */
const ROW = Math.round((6 * 44_100 * SID_CYCLES_PER_FRAME) / SID_PAL_CLOCK_HZ);
const A4 = (7494 * 985248) / 2 ** 24;

beforeAll(() => {
  initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
});

// ---------------------------------------------------------------------------
// The stand-in render thread
// ---------------------------------------------------------------------------

interface Connection {
  from: unknown;
  to: unknown;
  output: number | undefined;
}
let connections: Connection[] = [];

class FakeAudioParam {
  value = 1;
  setValueAtTime(): void {}
  linearRampToValueAtTime(): void {}
  cancelScheduledValues(): void {}
  setTargetAtTime(): void {}
}

class FakeNode {
  readonly numberOfOutputs = 1;
  readonly gain = new FakeAudioParam();
  constructor(readonly context: unknown) {}
  connect(to: unknown, output?: number): unknown {
    connections.push({ from: this, to, output });
    return to;
  }
  disconnect(to?: unknown, output?: number): void {
    connections = connections.filter(
      (c) => !(c.from === this && (to === undefined || c.to === to) && (output === undefined || c.output === output)),
    );
  }
}

let workletNodes: FakeSidWorkletNode[] = [];

/** `AudioWorkletNode` for 'sid-audio-processor': the real core behind a fake port. */
class FakeSidWorkletNode extends FakeNode {
  readonly received: SidCommand[] = [];
  onprocessorerror: (() => void) | null = null;
  private core: SidProcessorCore | null = null;
  private handler: ((event: MessageEvent) => void) | null = null;
  readonly port: {
    postMessage: (message: unknown) => void;
    close: () => void;
    onmessage: ((event: MessageEvent) => void) | null;
  };

  constructor(context: unknown, name: string, readonly options: { numberOfOutputs: number; outputChannelCount: number[] }) {
    super(context);
    const node = this as FakeSidWorkletNode;
    this.port = {
      postMessage: (message: unknown) => node.fromMain(message),
      close: () => undefined,
      get onmessage() {
        return node.handler;
      },
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        node.handler = handler;
      },
    };
    expect(name).toBe('sid-audio-processor');
    workletNodes.push(this);
    // The processor's constructor posts `ready`.
    setTimeout(() => this.toMain({ type: 'ready' }), 0);
  }

  private toMain(data: unknown): void {
    // A message port delivers asynchronously.
    setTimeout(() => this.handler?.({ data } as MessageEvent), 0);
  }

  private fromMain(message: unknown): void {
    const data = message as { type: string; wasmBytes?: ArrayBuffer };
    if (data.type === 'wasm-binary') {
      this.core = new SidProcessorCore(SidPlayer as unknown as SidWasmPlayerCtor, SAMPLE_RATE, (event: SidEvent) => this.toMain(event));
      this.toMain({ type: 'wasm-ready' });
      return;
    }
    this.received.push(message as SidCommand);
    this.core?.handle(message as SidCommand);
  }

  /** What `sid-worklet.ts`'s `process` does, for `frames` frames: mix, its right copy, the voice taps. */
  pump(frames: number) {
    const mix = new Float32Array(frames);
    const right = new Float32Array(frames);
    const taps = [new Float32Array(frames), new Float32Array(frames), new Float32Array(frames)];
    for (let at = 0; at < frames; at += 128) {
      const n = Math.min(128, frames - at);
      this.core?.process(mix.subarray(at, at + n), right.subarray(at, at + n), taps.map((t) => t.subarray(at, at + n)));
    }
    return { mix, right, taps };
  }
}

class FakeAudioContextStub {
  sampleRate = SAMPLE_RATE;
  currentTime = 0;
  state: AudioContextState = 'running';
  readonly destination = new FakeNode(this);
  addEventListener(): void {}
  removeEventListener(): void {}
  readonly audioWorklet = { addModule: vi.fn(async () => undefined) };
  createGain(): FakeNode {
    return new FakeNode(this);
  }
  createIIRFilter(): FakeNode {
    return new FakeNode(this);
  }
  createDynamicsCompressor(): object {
    return Object.assign(new FakeNode(this), {
      threshold: new FakeAudioParam(),
      knee: new FakeAudioParam(),
      ratio: new FakeAudioParam(),
      attack: new FakeAudioParam(),
      release: new FakeAudioParam(),
      reduction: 0,
    });
  }
  createWaveShaper(): object {
    return Object.assign(new FakeNode(this), { curve: null, oversample: 'none' });
  }
  resume(): Promise<void> {
    return Promise.resolve();
  }
}

const settle = () => new Promise<void>((r) => setTimeout(r, 5));
async function until(what: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (what()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${label}`);
}

function power(x: Float32Array, hz: number): number {
  const w = (2 * Math.PI * hz) / SAMPLE_RATE;
  const c = 2 * Math.cos(w);
  let s1 = 0;
  let s2 = 0;
  for (const v of x) {
    const s0 = v + c * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return s1 * s1 + s2 * s2 - c * s1 * s2;
}
const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

async function sidCmod(doc = buildSidChainSong()): Promise<ArrayBuffer> {
  const { useTrackerStore } = await import('src/stores/tracker-store');
  const previous = (await import('pinia')).getActivePinia();
  setActivePinia(createPinia());
  const source = useTrackerStore();
  source.adoptSidDoc(doc);
  const zip = new JSZip();
  zip.file('song.json', JSON.stringify(source.serializeSong()));
  if (previous) setActivePinia(previous);
  const bytes = await zip.generateAsync({ type: 'uint8array' });
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

async function setup() {
  connections = [];
  workletNodes = [];
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
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = FakeSidWorkletNode as unknown;
  const wasm = readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      expect(String(url)).toMatch(/wasm\/audio_processor_bg\.wasm$/);
      return { ok: true, arrayBuffer: async () => wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) };
    }),
  );

  const { useTrackerStore } = await import('src/stores/tracker-store');
  const { useUserSettingsStore } = await import('src/stores/user-settings-store');
  const { useTrackerPlaybackStore } = await import('src/stores/tracker-playback-store');
  const { useTrackerSongHost } = await import('src/composables/useTrackerSongHost');
  setActivePinia(createPinia());
  const settings = useUserSettingsStore();
  settings.settings.showSpectrumAnalyzer = true;
  settings.settings.showWaveformVisualizers = true;
  const trackerStore = useTrackerStore();
  trackerStore.initializeIfNeeded();
  const host = useTrackerSongHost();
  const playbackStore = useTrackerPlaybackStore();
  const file = await host.parseSongBuffer(await sidCmod());
  await host.applySongFile(file);
  return { host, trackerStore, playbackStore };
}

/** Plays and waits until the worklet holds the song and has been told to play. */
async function startPlaying(h: Awaited<ReturnType<typeof setup>>, mode: 'song' | 'pattern' = 'song', row = 0) {
  await h.host.play(mode, row);
  await until(() => workletNodes[0]?.received.some((c) => c.type === 'play') ?? false, 'play');
  return workletNodes[0] as FakeSidWorkletNode;
}

afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('a SID song plays through the playback store, the SID transport and the worklet', () => {
  it('Play makes the worklet, loads the store\'s doc and plays it: audio, A-4 on voice 1', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const node = await startPlaying(h);
    expect(h.playbackStore.isPlaying).toBe(true);
    expect(node.options).toMatchObject({ numberOfOutputs: 4, outputChannelCount: [2, 1, 1, 1] });
    // The worklet got the doc as its file, then a seek to the top and a play.
    const load = node.received.find((c) => c.type === 'load-song') as Extract<SidCommand, { type: 'load-song' }>;
    const { serializeSidFile } = await import('src/audio/tracker/sid-doc');
    expect(Array.from(new Uint8Array(load.bytes as ArrayBuffer))).toEqual(Array.from(serializeSidFile(h.trackerStore.sidDoc!)));
    expect(node.received.map((c) => c.type)).toEqual(expect.arrayContaining(['load-song', 'seek', 'play']));

    node.pump(ROW);
    const { mix, right, taps } = node.pump(6 * ROW);
    expect(peak(mix)).toBeGreaterThan(0.05);
    expect(Array.from(right)).toEqual(Array.from(mix));
    expect(power(mix, A4)).toBeGreaterThan(100 * power(mix, 466.16));
    expect(power(taps[0]!, A4)).toBeGreaterThan(100 * power(taps[0]!, 466.16));
  }, 30000);

  it('the voices leave the worklet into the bank\'s per-track taps (the analyzer\'s and scopes\' nodes); the mix into the bus', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const node = await startPlaying(h);
    for (const voice of [0, 1, 2]) {
      const tap = h.host.songBank.getTrackTap(voice);
      expect(tap).not.toBeNull();
      expect(connections.some((c) => c.from === node && c.to === tap && c.output === voice + 1)).toBe(true);
      // And they are exactly what the host hands the analyzer and the scopes.
      expect(toRaw(h.host.spectrumTrackNodes.value[voice])).toBe(tap);
      expect(toRaw(h.host.trackAudioNodes.value[voice])).toBe(tap);
    }
    const mixTarget = connections.find((c) => c.from === node && c.output === 0)?.to;
    expect(connections.some((c) => c.from === mixTarget && c.to === h.host.songBank.output)).toBe(true);
  }, 30000);

  it('the worklet\'s rows move the grid\'s playhead (song row -> position, row)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const node = await startPlaying(h);
    node.pump(20 * ROW + 2000);
    await until(() => h.playbackStore.currentSequenceIndex === 1, 'position 1');
    // Song row 20 = position 1 (rows 16..31), row 4.
    expect(h.playbackStore.playbackRow).toBe(4);
    expect(h.trackerStore.currentPatternId).toBe('sid-pos-1');
  }, 30000);

  it('an edit while playing reloads the song where it is, and the new note sounds', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const node = await startPlaying(h);
    node.pump(2 * ROW + 500);
    await settle();
    const loadsBefore = node.received.filter((c) => c.type === 'load-song').length;
    // Voice 2 gets an E-5 on row 4 of position 0 (P1 row 4), through the grid.
    h.trackerStore.setCurrentPatternId('sid-pos-0');
    const cell = h.trackerStore.patterns[0]!.tracks[1]!;
    cell.entries = [...cell.entries, { row: 4, note: 'E-5', instrument: '01' }];
    await new Promise((r) => setTimeout(r, SID_RELOAD_IDLE_MS + 60));
    await settle();
    const after = node.received.slice(-3).map((c) => c.type);
    expect(node.received.filter((c) => c.type === 'load-song').length).toBe(loadsBefore + 1);
    expect(after).toEqual(['load-song', 'seek', 'play']);
    const seek = node.received.at(-2) as Extract<SidCommand, { type: 'seek' }>;
    expect(seek.row).toBe(2);
    // Rows 4.. now carry voice 2's E-5 (659.26 Hz) on its tap.
    node.pump(2 * ROW);
    const { taps } = node.pump(3 * ROW);
    const E5 = (sidReg(64) * 985248) / 2 ** 24;
    expect(peak(taps[1]!)).toBeGreaterThan(0.05);
    expect(power(taps[1]!, E5)).toBeGreaterThan(100 * power(taps[1]!, E5 * 2 ** (1 / 12)));
  }, 30000);

  it('mute and solo from the tracker reach the chip\'s voices', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const node = await startPlaying(h);
    h.playbackStore.toggleMute(0, 3);
    expect(node.received.at(-1)).toEqual({ type: 'set-mute-solo', mute: 1, solo: 0 });
    node.pump(ROW);
    const { taps } = node.pump(4 * ROW);
    expect(peak(taps[0]!)).toBe(0);
  }, 30000);

  it('pause, resume and stop drive the worklet; a non-SID song hands the transport back and frees the node', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const node = await startPlaying(h);
    node.pump(ROW);
    h.playbackStore.pause();
    expect(h.playbackStore.isPaused).toBe(true);
    expect(node.received.at(-1)).toEqual({ type: 'pause' });
    expect(peak(node.pump(4410).mix)).toBe(0);
    await h.playbackStore.resume();
    expect(node.received.at(-1)).toEqual({ type: 'play' });
    expect(h.playbackStore.isPlaying).toBe(true);
    h.playbackStore.stop();
    expect(node.received.slice(-2)).toEqual([{ type: 'pause' }, { type: 'seek', row: 0 }]);
    expect(h.playbackStore.isPlaying).toBe(false);
    // A native song: the SID worklet is disposed.
    h.trackerStore.resetToNewSong();
    await h.host.play('song', 0);
    expect(node.received.at(-1)).toEqual({ type: 'dispose' });
  }, 30000);

  it('a jukebox-style play (no loop) stops at the song\'s end and tells the song-end listeners', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    h.playbackStore.setLoopSong(false);
    const ended = vi.fn();
    h.playbackStore.onSongEnd(ended);
    const node = await startPlaying(h, 'song', 0);
    expect(node.received).toContainEqual({ type: 'set-stop-at-end', enabled: true });
    node.pump(33 * ROW);
    await until(() => ended.mock.calls.length > 0, 'song end');
    expect(h.playbackStore.isPlaying).toBe(false);
  }, 30000);

  it('"play pattern" loops the position\'s rows', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    h.trackerStore.setCurrentPatternId('sid-pos-1');
    h.playbackStore.setSequenceIndex(1);
    const node = await startPlaying(h, 'pattern', 0);
    expect(node.received).toContainEqual({ type: 'set-loop-rows', start: 16, end: 32 });
    expect(node.received).toContainEqual({ type: 'seek', row: 16 });
  }, 30000);
});

/** The worklet client's last `song-loaded` info (the Rust player's own report). */
function loadedChip(h: Awaited<ReturnType<typeof setup>>): string | undefined {
  return h.playbackStore.sidTransport().player?.song?.chipModel;
}

describe('S5.7: switching the chip model mid-session rebuilds the player with it', () => {
  it('while playing: the doc is retagged, the worklet reloads the 8580 file, seeks back to the row it was on and plays on', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const node = await startPlaying(h);
    await until(() => loadedChip(h) === '6581', 'the song\'s own 6581 load');
    node.pump(3 * ROW + 500);
    await settle();
    const loadsBefore = node.received.filter((c) => c.type === 'load-song').length;

    expect(h.trackerStore.setSidChip('8580')).toBe(true);
    expect(h.trackerStore.sidDoc?.chipModel).toBe('8580');
    await new Promise((r) => setTimeout(r, SID_RELOAD_IDLE_MS + 60));
    await until(() => loadedChip(h) === '8580', 'the 8580 load');

    expect(node.received.filter((c) => c.type === 'load-song').length).toBe(loadsBefore + 1);
    expect(node.received.slice(-3).map((c) => c.type)).toEqual(['load-song', 'seek', 'play']);
    const load = node.received.at(-3) as Extract<SidCommand, { type: 'load-song' }>;
    // Header byte 5 (after 'ASID' and the version): the chip code, 0 = 8580.
    expect(new Uint8Array(load.bytes as ArrayBuffer)[5]).toBe(0);
    // Resumed, not restarted: the seek is the row the song had reached.
    expect((node.received.at(-2) as Extract<SidCommand, { type: 'seek' }>).row).toBe(3);
    expect(h.playbackStore.isPlaying).toBe(true);
    expect(peak(node.pump(4 * ROW).mix)).toBeGreaterThan(0.05);

    // Undo is a doc edit too: back to the song's own 6581.
    h.trackerStore.undo();
    await new Promise((r) => setTimeout(r, SID_RELOAD_IDLE_MS + 60));
    await until(() => loadedChip(h) === '6581', 'the 6581 reload after undo');
  }, 30000);

  it('paused: the switch waits for the resume, which loads the new chip at the paused row', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const node = await startPlaying(h);
    node.pump(2 * ROW + 500);
    await settle();
    h.playbackStore.pause();
    const loadsBefore = node.received.filter((c) => c.type === 'load-song').length;
    h.trackerStore.setSidChip('8580');
    await new Promise((r) => setTimeout(r, SID_RELOAD_IDLE_MS + 60));
    expect(node.received.filter((c) => c.type === 'load-song').length).toBe(loadsBefore);
    await h.playbackStore.resume();
    expect(node.received.slice(-3).map((c) => c.type)).toEqual(['load-song', 'seek', 'play']);
    expect((node.received.at(-2) as Extract<SidCommand, { type: 'seek' }>).row).toBe(2);
    await until(() => loadedChip(h) === '8580', 'the 8580 load on resume');
  }, 30000);

  it('stopped: the next Play loads the retagged song (the chain song is tagged 6581, the switch makes it 8580)', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    h.trackerStore.setSidChip('8580');
    await startPlaying(h);
    await until(() => loadedChip(h) === '8580', 'the 8580 load');
  }, 30000);
});

function sidReg(index: number): number {
  return Math.round((440 * 2 ** ((index + 12 - 69) / 12) * 2 ** 24) / 985248);
}
