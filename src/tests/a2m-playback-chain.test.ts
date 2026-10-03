import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createPinia, setActivePinia } from 'pinia';
import { toRaw } from 'vue';
import JSZip from 'jszip';
// Relative on purpose: the `app/public/wasm/audio_processor.js` alias is
// mocked for every other test, and this one is about the real bytes.
import { A2Player, OplRenderer, a2m_from_json, a2m_new_json, a2m_to_json, initSync } from '../../public/wasm/audio_processor.js';
import { resetPostFxRegistryForTests } from '@another-synth/tracker-playback';
import {
  OPL_TAP_OUTPUTS,
  OplProcessorCore,
  type A2WasmPlayerCtor,
  type OplCommand,
  type OplEvent,
  type OplWasmRendererCtor,
} from 'src/audio/worklets/opl-core';
import { a2mEffectText, looksLikeA2m } from 'src/audio/tracker/a2m-import';
import { setA2mCodecBackend } from 'src/audio/tracker/a2m-codec';
import { demoSongUrl, type DemoCollection } from 'src/composables/useDemoManifest';

/**
 * .ai/plan-opl.md O7 step 4: an Adlib Tracker II module opens and PLAYS
 * through the whole app-side chain, as `sid-playback-chain.test.ts` proves
 * for SID: the real host (`parseSongBuffer`, which reads the module in an
 * OPL worklet and builds the grid from its `song-loaded`, then
 * `applySongFile`), the real playback store (`play` -> the `'a2m'` branch ->
 * `A2mSongTransport`), the real `A2mPlayerClient` over the real
 * `createOplNode` handshake.
 *
 * Only the render thread is stood in for: `AudioWorkletNode` is a fake whose
 * port runs the REAL `OplProcessorCore` over the REAL rebuilt wasm, and
 * `pump(frames)` does what `opl-worklet.ts`'s `process` does (output 0 the
 * stereo mix, outputs 1..18 the channel taps) in 128-frame quanta.
 */

const ROOT = resolve(__dirname, '../..');
const A2M = resolve(ROOT, 'src/tests/fixtures/opl/a2m');
const SAMPLE_RATE = 48000;

const corpus = (rel: string) => {
  const b = readFileSync(resolve(A2M, rel));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
};
const COT = 'NAB622/corridors of time.a2m';

beforeAll(() => {
  initSync({ module: new Uint8Array(readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'))) });
  // The app loads the same wasm on the main thread; here it is already up.
  setA2mCodecBackend({ a2m_to_json, a2m_from_json, a2m_new_json });
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

let workletNodes: FakeOplWorkletNode[] = [];

/** `AudioWorkletNode` for 'opl-audio-processor': the real core behind a fake port. */
class FakeOplWorkletNode extends FakeNode {
  readonly received: OplCommand[] = [];
  onprocessorerror: (() => void) | null = null;
  disposed = false;
  private core: OplProcessorCore | null = null;
  private handler: ((event: MessageEvent) => void) | null = null;
  readonly port: {
    postMessage: (message: unknown) => void;
    close: () => void;
    onmessage: ((event: MessageEvent) => void) | null;
  };

  constructor(context: unknown, name: string, readonly options: { numberOfOutputs: number; outputChannelCount: number[] }) {
    super(context);
    const node = this as FakeOplWorkletNode;
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
    expect(name).toBe('opl-audio-processor');
    workletNodes.push(this);
    setTimeout(() => this.toMain({ type: 'ready' }), 0);
  }

  private toMain(data: unknown): void {
    setTimeout(() => this.handler?.({ data } as MessageEvent), 0);
  }

  private fromMain(message: unknown): void {
    const data = message as { type: string };
    if (data.type === 'wasm-binary') {
      this.core = new OplProcessorCore(
        OplRenderer as unknown as OplWasmRendererCtor,
        SAMPLE_RATE,
        0,
        (event: OplEvent) => this.toMain(event),
        A2Player as unknown as A2WasmPlayerCtor,
      );
      this.toMain({ type: 'wasm-ready' });
      return;
    }
    if (data.type === 'dispose') this.disposed = true;
    this.received.push(message as OplCommand);
    this.core?.handle(message as OplCommand);
  }

  /** What `opl-worklet.ts`'s `process` does, for `frames` frames. */
  pump(frames: number) {
    const left = new Float32Array(frames);
    const right = new Float32Array(frames);
    const taps = Array.from({ length: OPL_TAP_OUTPUTS }, () => new Float32Array(frames));
    for (let at = 0; at < frames; at += 128) {
      const n = Math.min(128, frames - at);
      this.core?.process(left.subarray(at, at + n), right.subarray(at, at + n), at, taps.map((t) => t.subarray(at, at + n)));
    }
    return { left, right, taps };
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

/** The song a module holds, as the codec reads it, but for the spare patterns past the file's count. */
function songOf(bytes: Uint8Array): unknown {
  const song = JSON.parse(a2m_to_json(bytes)) as { spare_patterns: unknown };
  song.spare_patterns = [];
  return song;
}

const settle = () => new Promise<void>((r) => setTimeout(r, 5));
async function until(what: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (what()) return;
    await settle();
  }
  throw new Error(`timed out waiting for ${label}`);
}
const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

async function makeHost() {
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
  (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode = FakeOplWorkletNode as unknown;
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
  return { host, trackerStore, playbackStore };
}

async function setup(rel = COT) {
  const h = await makeHost();
  const file = await h.host.parseSongBuffer(corpus(rel), rel);
  await h.host.applySongFile(file);
  return { ...h, file };
}

/** Plays and waits until the song's worklet has been told to play. */
async function startPlaying(h: Awaited<ReturnType<typeof setup>>, mode: 'song' | 'pattern' = 'song', row = 0) {
  await h.host.play(mode, row);
  await until(() => workletNodes.some((n) => !n.disposed && n.received.some((c) => c.type === 'play')), 'play');
  return workletNodes.find((n) => !n.disposed && n.received.some((c) => c.type === 'play')) as FakeOplWorkletNode;
}

afterEach(() => {
  delete (globalThis as { AudioContext?: unknown }).AudioContext;
  delete (globalThis as { AudioWorkletNode?: unknown }).AudioWorkletNode;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('A2M display helpers', () => {
  it('knows an A2M (and an A2T, to refuse it truthfully) by its magic', () => {
    expect(looksLikeA2m(new Uint8Array(corpus(COT)))).toBe(true);
    expect(looksLikeA2m(new TextEncoder().encode('_A2tiny_module_xxxx'))).toBe(true);
    expect(looksLikeA2m(new TextEncoder().encode('_A2modul'))).toBe(false);
    expect(looksLikeA2m(new TextEncoder().encode('Extended Module: '))).toBe(false);
  });

  it("writes effects in AT2's letters, and a v5-8 manual slide as the &4x/&5y AT2 converts it to", () => {
    expect(a2mEffectText(0, 0)).toBeUndefined();
    expect(a2mEffectText(0x00, 0x37)).toBe('037');
    expect(a2mEffectText(0x0a, 0x0f)).toBe('A0F');
    expect(a2mEffectText(0x23, 0xff)).toBe('ZFF');
    expect(a2mEffectText(0x24, 0x21)).toBe('&21');
    expect(a2mEffectText(0x2f, 0x01)).toBe('<01');
    expect(a2mEffectText(0xf0, 0x30)).toBe('&43');
    expect(a2mEffectText(0xf0, 0x05)).toBe('&55');
  });
});

describe('an A2M module opens and plays through the host, the playback store and the OPL worklet', () => {
  it('opening reads the module (the player must accept it) and builds an editable song from it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    // The import's worklet is a throwaway: disposed once it answered.
    expect(workletNodes[0]?.disposed).toBe(true);
    expect(h.trackerStore.moduleFormat).toBe('a2m');
    expect(h.trackerStore.isReadOnly).toBe(false);
    expect(h.trackerStore.hasFixedSequence).toBe(false);
    const bytes = new Uint8Array(corpus(COT));
    expect(h.trackerStore.a2mDoc?.instruments).toHaveLength(255);
    // What the player says of the song: 18 tracks, the order list as the sequence.
    const player = new A2Player(bytes, SAMPLE_RATE);
    const orders = Array.from({ length: player.order_count() }, (_, i) => player.order_entry(i));
    expect(h.trackerStore.sequence).toEqual(orders.map((o) => `a2m-pat-${o}`));
    // Every pattern of the file is in the grid, the ordered ones among them.
    const ids = new Set(h.trackerStore.patterns.map((p) => p.id));
    for (const o of orders) expect(ids.has(`a2m-pat-${o}`)).toBe(true);
    const first = h.trackerStore.patterns.find((p) => p.id === `a2m-pat-${orders[0]}`)!;
    expect(first.tracks).toHaveLength(player.track_count());
    expect(first.rows).toBe(player.rows_per_pattern());
    // Every note of every ordered pattern, in the grid where the player has it.
    const tracks = player.track_count();
    let notes = 0;
    for (const o of new Set(orders)) {
      const cells = player.pattern_cells(o);
      const grid = h.trackerStore.patterns.find((p) => p.id === `a2m-pat-${o}`)!;
      for (let r = 0; r < grid.rows; r++) {
        for (let t = 0; t < tracks; t++) {
          const n = cells[(r * tracks + t) * 6]!;
          const entry = grid.tracks[t]!.entries.find((e) => e.row === r);
          if (n === 0) {
            expect(entry?.note).toBeUndefined();
            continue;
          }
          notes++;
          // AT2's note 1 is C-0.
          const name = ['C-', 'C#', 'D-', 'D#', 'E-', 'F-', 'F#', 'G-', 'G#', 'A-', 'A#', 'B-'][(n - 1) % 12];
          expect(entry?.note).toBe(n === 255 ? '###' : `${name}${Math.floor((n - 1) / 12)}`);
        }
      }
    }
    expect(notes).toBeGreaterThan(0);
    expect(h.trackerStore.currentSong.title).toBe(player.song_name().trim());
    // Every instrument the player names is a populated slot of that name.
    for (let i = 0; i < Math.min(player.instrument_count(), h.trackerStore.instrumentSlots.length); i++) {
      const slot = h.trackerStore.instrumentSlots[i]!;
      expect(slot.instrumentFormat).toBe('a2m');
      const name = player.instrument_name(i).trim();
      if (name) expect(slot.instrumentName).toBe(name);
    }
    player.free();
  }, 30000);

  it("a v1 module shows its effects as the module numbers them (AT2's letters)", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup('Subz3ro/intro-tune coop.a2m');
    const macros = h.trackerStore.patterns.flatMap((p) => p.tracks.flatMap((t) => t.entries.map((e) => e.macro).filter(Boolean)));
    expect(macros.length).toBeGreaterThan(0);
    for (const m of macros) expect(m).toMatch(/^[0-9A-Z&%!@=#$~^`><]..$/);
  }, 30000);

  it('refuses a module the player will not play, with its one sentence, and keeps the song it had', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await makeHost();
    const { SongRefusal } = await import('src/composables/useTrackerFileIO');
    const refused = h.host.parseSongBuffer(corpus("OxygenStar/oxygenstar's instrument set #001.a2m"));
    await expect(refused).rejects.toBeInstanceOf(SongRefusal);
    await expect(refused).rejects.toThrow(/Cannot play this A2M module: its order list holds only jump markers/);
    const a2t = new TextEncoder().encode('_A2tiny_module_' + '\0'.repeat(64));
    await expect(h.host.parseSongBuffer(a2t.buffer as ArrayBuffer)).rejects.toThrow(/Cannot read this A2M module/);
    expect(h.trackerStore.moduleFormat).not.toBe('a2m');
  }, 30000);

  it('Play loads the module into a worklet and plays it; the playhead follows the player', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const node = await startPlaying(h);
    expect(node.options).toMatchObject({ numberOfOutputs: 1 + OPL_TAP_OUTPUTS });
    const load = node.received.find((c) => c.type === 'load-a2m') as Extract<OplCommand, { type: 'load-a2m' }>;
    // What plays is the song compiled from the doc and the grid: the same song as the file, not its bytes.
    expect(songOf(new Uint8Array(load.bytes as ArrayBuffer))).toEqual(songOf(new Uint8Array(corpus(COT))));
    expect(node.received.map((c) => c.type)).toEqual(expect.arrayContaining(['load-a2m', 'set-loop-order', 'seek', 'play']));
    expect(node.received).toContainEqual({ type: 'set-loop-order', order: -1 });
    const { left, right } = node.pump(SAMPLE_RATE * 2);
    expect(peak(left)).toBeGreaterThan(0.01);
    expect(peak(right)).toBeGreaterThan(0.01);
    // Far enough in to be past order 0.
    node.pump(SAMPLE_RATE * 20);
    await until(() => h.playbackStore.currentSequenceIndex > 0, 'order 1');
    expect(h.trackerStore.currentPatternId).toBe(h.trackerStore.sequence[h.playbackStore.currentSequenceIndex]);
  }, 60000);

  it("each track's channel feeds its track tap (scopes, spectrum); the mix goes to the bus", async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const node = await startPlaying(h);
    const info = new A2Player(new Uint8Array(corpus(COT)), SAMPLE_RATE);
    for (let t = 0; t < info.track_count(); t++) {
      const tap = h.host.songBank.getTrackTap(t);
      expect(tap).not.toBeNull();
      expect(connections.some((c) => c.from === node && c.to === tap && c.output === 1 + info.track_channel(t))).toBe(true);
      expect(toRaw(h.host.trackAudioNodes.value[t])).toBe(tap);
    }
    expect(node.received).toContainEqual({ type: 'set-taps', enabled: true });
    const { taps } = node.pump(SAMPLE_RATE * 2);
    expect(taps.some((t) => peak(t) > 0.01)).toBe(true);
    const mixTarget = connections.find((c) => c.from === node && c.output === 0)?.to;
    expect(connections.some((c) => c.from === mixTarget && c.to === h.host.songBank.output)).toBe(true);
    info.free();
  }, 60000);

  it('mute and solo from the tracker reach the player as track masks', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const node = await startPlaying(h);
    h.playbackStore.toggleMute(2, 18);
    expect(node.received.at(-1)).toEqual({ type: 'set-mute-solo', mute: 4, solo: 0 });
    h.playbackStore.toggleMute(2, 18);
    h.playbackStore.toggleSolo(5, 18);
    expect(node.received.at(-1)).toEqual({ type: 'set-mute-solo', mute: 0, solo: 32 });
    for (let t = 0; t < 18; t++) if (t !== 5) h.playbackStore.toggleMute(t, 18);
    h.playbackStore.toggleSolo(5, 18);
    h.playbackStore.toggleMute(5, 18);
    expect(node.received.at(-1)).toEqual({ type: 'set-mute-solo', mute: (1 << 18) - 1, solo: 0 });
    node.pump(SAMPLE_RATE / 2);
    expect(peak(node.pump(SAMPLE_RATE).left)).toBe(0);
  }, 60000);

  it('"play pattern" loops the order position; seek moves within it', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    h.playbackStore.setSequenceIndex(2);
    const node = await startPlaying(h, 'pattern', 4);
    expect(node.received).toContainEqual({ type: 'set-loop-order', order: 2 });
    expect(node.received).toContainEqual({ type: 'seek', order: 2, row: 4 });
    node.pump(SAMPLE_RATE * 12);
    await settle();
    expect(h.playbackStore.currentSequenceIndex).toBe(2);
    h.playbackStore.seek(10);
    expect(node.received.at(-1)).toEqual({ type: 'seek', order: 2, row: 10 });
  }, 60000);

  it('pause, resume and stop drive the worklet; a native song hands the transport back and frees the node', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const node = await startPlaying(h);
    node.pump(4800);
    h.playbackStore.pause();
    expect(h.playbackStore.isPaused).toBe(true);
    expect(node.received.at(-1)).toEqual({ type: 'pause' });
    expect(peak(node.pump(4800).left)).toBe(0);
    await h.playbackStore.resume();
    expect(node.received.at(-1)).toEqual({ type: 'play' });
    h.playbackStore.stop();
    expect(node.received.slice(-2)).toEqual([{ type: 'pause' }, { type: 'seek', order: 0, row: 0 }]);
    expect(h.playbackStore.isPlaying).toBe(false);
    h.trackerStore.resetToNewSong();
    await h.host.play('song', 0);
    expect(node.disposed).toBe(true);
  }, 60000);

  it('a jukebox-style play (no loop) stops at the end and tells the song-end listeners', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup('Subz3ro/intro-tune coop.a2m');
    h.playbackStore.setLoopSong(false);
    const ended = vi.fn();
    h.playbackStore.onSongEnd(ended);
    const node = await startPlaying(h, 'song', 0);
    expect(node.received).toContainEqual({ type: 'set-stop-at-end', enabled: true });
    // Jump near the end: the last order position.
    node.received.length = 0;
    const last = h.trackerStore.sequence.length - 1;
    h.playbackStore.setSequenceIndex(last);
    h.playbackStore.seek(0);
    for (let i = 0; i < 40 && ended.mock.calls.length === 0; i++) {
      node.pump(SAMPLE_RATE * 2);
      await settle();
    }
    expect(ended).toHaveBeenCalled();
    expect(h.playbackStore.isPlaying).toBe(false);
  }, 60000);

  it('a saved .cmod keeps the song (doc and grid) and plays it again', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const h = await setup();
    const saved = h.trackerStore.serializeSong();
    expect(saved.data.a2mDoc).toEqual(h.trackerStore.a2mDoc);
    expect(saved.data.a2mFile).toBeUndefined();
    const zip = new JSZip();
    zip.file('song.json', JSON.stringify(saved));
    const bytes = await zip.generateAsync({ type: 'uint8array' });
    const h2 = await makeHost();
    const file = await h2.host.parseSongBuffer(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
    await h2.host.applySongFile(file);
    expect(h2.trackerStore.moduleFormat).toBe('a2m');
    expect(h2.trackerStore.a2mDoc).toEqual(saved.data.a2mDoc);
    const node = await startPlaying({ ...h2, file });
    expect(peak(node.pump(SAMPLE_RATE).left)).toBeGreaterThan(0.01);
  }, 60000);

  it('the corpus is in the demo browser, and a demo loads by its URL and plays', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    const manifest = JSON.parse(readFileSync(resolve(ROOT, 'public/demos/index.json'), 'utf8')) as { collections: DemoCollection[] };
    const a2m = manifest.collections.find((c) => c.id === 'a2m')!;
    expect(a2m.name).toBe('Adlib Tracker II');
    // Every corpus module but the instrument set the player refuses.
    expect(a2m.songs).toHaveLength(278);
    for (const song of a2m.songs) {
      expect(song.format).toBe('A2M');
      expect(readFileSync(resolve(ROOT, 'public/demos', song.file)).length).toBe(song.bytes);
    }
    // Renamed from the corpus's "paradox #3.a2m": Vite's dev server does not serve a `%23`.
    expect(a2m.songs.some((s) => s.file.includes('#'))).toBe(false);
    const song = a2m.songs.find((s) => s.file === 'a2m/Kvee/paradox 3.a2m')!;
    const player = new A2Player(new Uint8Array(corpus('Kvee/paradox #3.a2m')), SAMPLE_RATE);
    expect(song.channels).toBe(player.track_count());
    expect(song.title).toBe(`${player.song_name().trim()} · Kvee`);
    player.free();

    const h = await makeHost();
    const url = demoSongUrl(song);
    expect(url).toBe('demos/a2m/Kvee/paradox%203.a2m');
    const wasmFetch = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (u: string, init?: RequestInit) => {
        if (String(u).startsWith('demos/')) {
          const b = readFileSync(resolve(ROOT, 'public', decodeURIComponent(String(u))));
          const ab = b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
          return { ok: true, status: 200, statusText: 'OK', arrayBuffer: async () => ab };
        }
        return wasmFetch(u, init);
      }),
    );
    await h.host.loadSongFromUrl(url);
    expect(h.trackerStore.moduleFormat).toBe('a2m');
    const node = await startPlaying({ ...h, file: null as never });
    expect(peak(node.pump(SAMPLE_RATE * 2).left)).toBeGreaterThan(0.01);
  }, 60000);
});
