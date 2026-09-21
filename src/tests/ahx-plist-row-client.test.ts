// @vitest-environment node
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ahxPlayer from 'src/audio/tracker/ahx-player';
import { AhxPlayerClient, type AhxPListRow } from 'src/audio/tracker/ahx-player';
import { AhxPreview } from 'src/audio/tracker/ahx-preview';
import { ahxPListPlayhead, clearAhxPListPlayhead, setAhxPListPlayhead } from 'src/audio/tracker/ahx-plist-playhead';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';

/**
 * The main-thread half of the `plist-row` event: the client's listener set, the
 * preview's lazy one, and the playback store's wiring that feeds
 * `ahxPListPlayhead` and clears it. The worklet half is
 * `ahx-plist-row-core.test.ts`, over the real wasm.
 */

type Client = AhxPlayerClient;

// The store creates its preview with the default player factory: a fake one.
const created: FakeClient[] = [];
vi.mock('src/audio/tracker/ahx-player', async (importOriginal) => {
  const original = await importOriginal<typeof ahxPlayer>();
  return {
    ...original,
    createAhxPlayer: vi.fn(async (ctx: object) => {
      const client = fakeClient(ctx);
      created.push(client);
      return client as unknown as Client;
    }),
  };
});
// What the preview's context says of itself; the playhead's clock reads it (rate and latency).
const contextFacts = vi.hoisted(() => ({}) as { sampleRate?: number; baseLatency?: number; outputLatency?: number });
vi.mock('src/stores/tracker-audio-store', () => ({
  useTrackerAudioStore: () => ({ songBank: { audioContext: contextFacts, output: {} } }),
}));
vi.mock('src/stores/tracker-store', () => ({ useTrackerStore: () => ({}) }));

interface FakeClient {
  audioContext: object;
  output: { connect: () => void };
  setPreview: () => void;
  setHifi: () => void;
  loadSong: () => Promise<object>;
  previewNoteOn: () => void;
  previewNoteOff: () => void;
  onPListRow: (listener: (r: AhxPListRow) => void) => () => boolean;
  dispose: ReturnType<typeof vi.fn>;
  listeners: Set<(r: AhxPListRow) => void>;
  emit: (r: AhxPListRow) => void;
}

function fakeClient(ctx: object): FakeClient {
  const listeners = new Set<(r: AhxPListRow) => void>();
  return {
    audioContext: ctx,
    output: { connect: () => undefined },
    setPreview: () => undefined,
    setHifi: () => undefined,
    loadSong: async () => ({}),
    previewNoteOn: () => undefined,
    previewNoteOff: () => undefined,
    onPListRow: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispose: vi.fn(),
    listeners,
    emit: (r) => {
      for (const listener of listeners) listener(r);
    },
  };
}

describe('AhxPlayerClient.onPListRow', () => {
  function client() {
    const port = { onmessage: null as ((e: MessageEvent) => void) | null, postMessage: vi.fn(), close: vi.fn() };
    const node = { port, connect: vi.fn(), disconnect: vi.fn(), onprocessorerror: null };
    const ctx = { createGain: () => ({ disconnect: vi.fn() }) };
    const c = new AhxPlayerClient(ctx as unknown as AudioContext, node as unknown as AudioWorkletNode);
    const deliver = (data: object) => port.onmessage?.({ data } as MessageEvent);
    return { c, deliver };
  }

  it('hands a plist-row event to a listener, with the instrument it came with', () => {
    const { c, deliver } = client();
    const heard: AhxPListRow[] = [];
    c.onPListRow((r) => heard.push(r));
    deliver({ type: 'plist-row', instrument: 7, row: 12 });
    deliver({ type: 'plist-row', instrument: 0, row: -1 });
    expect(heard).toEqual([
      { instrument: 7, row: 12 },
      { instrument: 0, row: -1 },
    ]);
  });

  it('stops after the unsubscribe, and other event types do not reach it', () => {
    const { c, deliver } = client();
    const listener = vi.fn();
    const off = c.onPListRow(listener);
    deliver({ type: 'position', position: 0, row: 3, tempo: 6, ticks: 1 });
    expect(listener).not.toHaveBeenCalled();
    off();
    deliver({ type: 'plist-row', instrument: 1, row: 0 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('dispose drops its listeners', () => {
    const { c, deliver } = client();
    const listener = vi.fn();
    c.onPListRow(listener);
    c.dispose();
    deliver({ type: 'plist-row', instrument: 1, row: 0 });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('AhxPreview.onPListRow', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const ctx = {};

  it('creates nothing by being subscribed to', async () => {
    const create = vi.fn(async (c: object) => fakeClient(c) as unknown as Client);
    const host = { audioContext: ctx as AudioContext, output: {} as AudioNode };
    const preview = new AhxPreview(host, create);
    preview.onPListRow(() => undefined);
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
    expect(preview.active).toBe(false);
  });

  it('forwards the worklet’s reports once it exists, and not after the unsubscribe', async () => {
    const clients: FakeClient[] = [];
    const host = { audioContext: ctx as AudioContext, output: {} as AudioNode };
    const preview = new AhxPreview(host, async (c) => {
      const client = fakeClient(c);
      clients.push(client);
      return client as unknown as Client;
    });
    const heard: AhxPListRow[] = [];
    const off = preview.onPListRow((r) => heard.push(r));
    await preview.preload(bytes);
    clients[0]!.emit({ instrument: 2, row: 5 });
    expect(heard).toEqual([{ instrument: 2, row: 5 }]);
    off();
    clients[0]!.emit({ instrument: 2, row: 6 });
    expect(heard).toHaveLength(1);
  });

  it('keeps its listeners through a replaced worklet, detaches the old one and says the old note is over', async () => {
    const clients: FakeClient[] = [];
    const host = { audioContext: ctx as AudioContext, output: {} as AudioNode };
    const preview = new AhxPreview(host, async (c) => {
      const client = fakeClient(c);
      clients.push(client);
      return client as unknown as Client;
    });
    const heard: AhxPListRow[] = [];
    preview.onPListRow((r) => heard.push(r));
    await preview.preload(bytes);
    clients[0]!.emit({ instrument: 4, row: 1 });
    // A new audio context: the worklet is dropped and made again.
    host.audioContext = {} as AudioContext;
    await preview.preload(new Uint8Array([9]));
    expect(clients).toHaveLength(2);
    expect(clients[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(clients[0]!.listeners.size).toBe(0);
    expect(heard).toEqual([
      { instrument: 4, row: 1 },
      { instrument: 0, row: -1 },
    ]);
    clients[1]!.emit({ instrument: 4, row: 2 });
    expect(heard.at(-1)).toEqual({ instrument: 4, row: 2 });
  });

  it('dispose tells the listeners the note is over, then forgets them', async () => {
    const host = { audioContext: ctx as AudioContext, output: {} as AudioNode };
    const clients: FakeClient[] = [];
    const preview = new AhxPreview(host, async (c) => {
      const client = fakeClient(c);
      clients.push(client);
      return client as unknown as Client;
    });
    const listener = vi.fn();
    preview.onPListRow(listener);
    await preview.preload(bytes);
    preview.dispose();
    expect(listener).toHaveBeenCalledWith({ instrument: 0, row: -1 });
    listener.mockClear();
    clients[0]!.emit({ instrument: 1, row: 1 });
    expect(listener).not.toHaveBeenCalled();
  });

  it('dispose with no worklet ever made says nothing', () => {
    const host = { audioContext: ctx as AudioContext, output: {} as AudioNode };
    const preview = new AhxPreview(host, async (c) => fakeClient(c) as unknown as Client);
    const listener = vi.fn();
    preview.onPListRow(listener);
    preview.dispose();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('ahxPListPlayhead', () => {
  afterEach(() => clearAhxPListPlayhead());

  it('takes a row, replaces it, and clears on row -1 or instrument 0', () => {
    expect(ahxPListPlayhead.value).toBeNull();
    setAhxPListPlayhead({ instrument: 3, row: 2 });
    expect(ahxPListPlayhead.value).toEqual({ instrument: 3, row: 2 });
    setAhxPListPlayhead({ instrument: 3, row: 5 });
    expect(ahxPListPlayhead.value).toEqual({ instrument: 3, row: 5 });
    setAhxPListPlayhead({ instrument: 0, row: -1 });
    expect(ahxPListPlayhead.value).toBeNull();
    setAhxPListPlayhead({ instrument: 3, row: 0 });
    setAhxPListPlayhead({ instrument: 0, row: 4 });
    expect(ahxPListPlayhead.value).toBeNull();
  });

  it('is not replaced by a report that says what it already says (no reactive churn)', () => {
    setAhxPListPlayhead({ instrument: 3, row: 2 });
    const held = ahxPListPlayhead.value;
    setAhxPListPlayhead({ instrument: 3, row: 2 });
    expect(ahxPListPlayhead.value).toBe(held);
  });

  it('holds a plain object, never a reactive Proxy (a shallowRef)', () => {
    setAhxPListPlayhead({ instrument: 1, row: 1 });
    expect(Object.getPrototypeOf(ahxPListPlayhead.value)).toBe(Object.prototype);
    expect(ahxPListPlayhead.value).not.toHaveProperty('__v_isReactive');
  });
});

describe('the playback store’s wiring', () => {
  const bytes = () => new Uint8Array([0x54, 0x48, 0x58, 0, 1, 2, 3]);

  // Reports reach the playhead from a frame (a 60 Hz timer in this run, which has no requestAnimationFrame).
  beforeEach(() => {
    // The driver stamps reports with performance.now(), so that is faked too.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    for (const key of Object.keys(contextFacts)) delete contextFacts[key as keyof typeof contextFacts];
    created.length = 0;
    setActivePinia(createPinia());
    clearAhxPListPlayhead();
  });

  afterEach(async () => {
    const { useTrackerPlaybackStore } = await import('src/stores/tracker-playback-store');
    useTrackerPlaybackStore().dispose();
    setCurrentAhxSource(null);
    vi.useRealTimers();
  });

  /** Frames go by: `ms` of fake time. */
  const frames = (ms: number) => vi.advanceTimersByTime(ms);

  async function storeWithPreview() {
    const { useTrackerPlaybackStore } = await import('src/stores/tracker-playback-store');
    const store = useTrackerPlaybackStore();
    setCurrentAhxSource(bytes());
    // The source change made the preview; its first key (or preload) makes the worklet.
    await store.prepareAhxPreview();
    expect(created).toHaveLength(1);
    return { store, worklet: created[0]! };
  }

  it('a subscribed store makes no worklet until something asks for one', async () => {
    const { useTrackerPlaybackStore } = await import('src/stores/tracker-playback-store');
    useTrackerPlaybackStore();
    expect(created).toHaveLength(0);
  });

  it('a row the preview’s worklet reports lands in ahxPListPlayhead', async () => {
    const { worklet } = await storeWithPreview();
    worklet.emit({ instrument: 3, row: 2 });
    frames(20);
    expect(ahxPListPlayhead.value).toEqual({ instrument: 3, row: 2 });
    worklet.emit({ instrument: 0, row: -1 });
    frames(20);
    expect(ahxPListPlayhead.value).toBeNull();
  });

  it('holds a row for the context’s base + output latency, as the audio is heard that much later', async () => {
    contextFacts.sampleRate = 48000;
    contextFacts.baseLatency = 0.01;
    contextFacts.outputLatency = 0.06;
    const { worklet } = await storeWithPreview();
    worklet.emit({ instrument: 3, row: 2 });
    // 70 ms: the frames at 16.7, 33.3, 50 and 66.7 find it not due, the one at 83.3 shows it.
    frames(70);
    expect(ahxPListPlayhead.value).toBeNull();
    frames(20);
    expect(ahxPListPlayhead.value).toEqual({ instrument: 3, row: 2 });
  });

  it('a context that reports no latency shows a row at the next frame', async () => {
    const { worklet } = await storeWithPreview();
    worklet.emit({ instrument: 3, row: 2 });
    expect(ahxPListPlayhead.value).toBeNull();
    frames(17);
    expect(ahxPListPlayhead.value).toEqual({ instrument: 3, row: 2 });
  });

  it('a burst of rows inside one frame is one update: the newest', async () => {
    const { worklet } = await storeWithPreview();
    for (const row of [0, 1, 2, 3]) worklet.emit({ instrument: 3, row });
    frames(17);
    expect(ahxPListPlayhead.value).toEqual({ instrument: 3, row: 3 });
  });

  it('a different song clears the row', async () => {
    const { worklet } = await storeWithPreview();
    worklet.emit({ instrument: 3, row: 2 });
    frames(20);
    expect(ahxPListPlayhead.value).not.toBeNull();
    setCurrentAhxSource(new Uint8Array([0x54, 0x48, 0x58, 0, 9, 9]));
    expect(ahxPListPlayhead.value).toBeNull();
    expect(worklet.dispose).toHaveBeenCalled();
    // The old worklet's late report cannot bring it back.
    worklet.emit({ instrument: 3, row: 3 });
    frames(40);
    expect(ahxPListPlayhead.value).toBeNull();
  });

  it('a row still waiting for its frame when the song changes is dropped, not shown afterwards', async () => {
    const { worklet } = await storeWithPreview();
    worklet.emit({ instrument: 3, row: 2 });
    setCurrentAhxSource(new Uint8Array([0x54, 0x48, 0x58, 0, 9, 9]));
    frames(40);
    expect(ahxPListPlayhead.value).toBeNull();
  });

  it('a non-AHX song (no bytes) clears the row', async () => {
    const { worklet } = await storeWithPreview();
    worklet.emit({ instrument: 3, row: 2 });
    frames(20);
    setCurrentAhxSource(null);
    expect(ahxPListPlayhead.value).toBeNull();
  });

  it('dispose clears the row and drops the subscription', async () => {
    const { store, worklet } = await storeWithPreview();
    worklet.emit({ instrument: 3, row: 2 });
    frames(20);
    store.dispose();
    expect(ahxPListPlayhead.value).toBeNull();
    worklet.emit({ instrument: 3, row: 4 });
    frames(40);
    expect(ahxPListPlayhead.value).toBeNull();
  });
});
