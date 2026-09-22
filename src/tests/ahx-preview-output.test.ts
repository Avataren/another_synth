// @vitest-environment node
import { createPinia, setActivePinia } from 'pinia';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ahxPlayer from 'src/audio/tracker/ahx-player';
import { type AhxPListRow } from 'src/audio/tracker/ahx-player';
import { AhxPreview } from 'src/audio/tracker/ahx-preview';
import { ahxPreviewOutputNode } from 'src/audio/tracker/ahx-preview-output';
import { setCurrentAhxSource } from 'src/audio/tracker/ahx-source';

/**
 * The main-thread half of the preview's output-node feed: the preview's lazy
 * listener set (`AhxPreview.onOutputNode`) and the playback store's wiring
 * that feeds `ahxPreviewOutputNode` and clears it. Mirrors
 * `ahx-plist-row-client.test.ts`'s `AhxPreview.onPListRow` and store-wiring
 * blocks structurally.
 */

type Client = ahxPlayer.AhxPlayerClient;

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

describe('AhxPreview.onOutputNode', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const ctx = {};

  it('creates nothing by being subscribed to', async () => {
    const create = vi.fn(async (c: object) => fakeClient(c) as unknown as Client);
    const host = { audioContext: ctx as AudioContext, output: {} as AudioNode };
    const preview = new AhxPreview(host, create);
    preview.onOutputNode(() => undefined);
    await Promise.resolve();
    expect(create).not.toHaveBeenCalled();
    expect(preview.active).toBe(false);
  });

  it('fires the client’s output once it exists, and not after the unsubscribe', async () => {
    const clients: FakeClient[] = [];
    const host = { audioContext: ctx as AudioContext, output: {} as AudioNode };
    const preview = new AhxPreview(host, async (c) => {
      const client = fakeClient(c);
      clients.push(client);
      return client as unknown as Client;
    });
    const heard: Array<AudioNode | null> = [];
    const off = preview.onOutputNode((node) => heard.push(node));
    await preview.preload(bytes);
    expect(heard).toEqual([clients[0]!.output]);
    off();
    // A new context forces a fresh client (and a fresh notification) — the
    // unsubscribed listener must not hear it.
    host.audioContext = {} as AudioContext;
    await preview.preload(new Uint8Array([9]));
    expect(heard).toHaveLength(1);
  });

  it('keeps its listeners through a replaced worklet: fires null for the old client, then the new client’s output', async () => {
    const clients: FakeClient[] = [];
    const host = { audioContext: ctx as AudioContext, output: {} as AudioNode };
    const preview = new AhxPreview(host, async (c) => {
      const client = fakeClient(c);
      clients.push(client);
      return client as unknown as Client;
    });
    const heard: Array<AudioNode | null> = [];
    preview.onOutputNode((node) => heard.push(node));
    await preview.preload(bytes);
    // A new audio context: the worklet is dropped and made again.
    host.audioContext = {} as AudioContext;
    await preview.preload(new Uint8Array([9]));
    expect(clients).toHaveLength(2);
    expect(heard).toEqual([clients[0]!.output, null, clients[1]!.output]);
  });

  it('dispose fires null, then forgets the listeners', async () => {
    const host = { audioContext: ctx as AudioContext, output: {} as AudioNode };
    const clients: FakeClient[] = [];
    const preview = new AhxPreview(host, async (c) => {
      const client = fakeClient(c);
      clients.push(client);
      return client as unknown as Client;
    });
    const listener = vi.fn();
    preview.onOutputNode(listener);
    await preview.preload(bytes);
    listener.mockClear();
    preview.dispose();
    expect(listener).toHaveBeenCalledWith(null);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('dispose with no worklet ever made fires nothing', () => {
    const host = { audioContext: ctx as AudioContext, output: {} as AudioNode };
    const preview = new AhxPreview(host, async (c) => fakeClient(c) as unknown as Client);
    const listener = vi.fn();
    preview.onOutputNode(listener);
    preview.dispose();
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('the playback store’s wiring of ahxPreviewOutputNode', () => {
  const bytes = () => new Uint8Array([0x54, 0x48, 0x58, 0, 1, 2, 3]);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    for (const key of Object.keys(contextFacts)) delete contextFacts[key as keyof typeof contextFacts];
    created.length = 0;
    setActivePinia(createPinia());
  });

  afterEach(async () => {
    const { useTrackerPlaybackStore } = await import('src/stores/tracker-playback-store');
    useTrackerPlaybackStore().dispose();
    setCurrentAhxSource(null);
    vi.useRealTimers();
  });

  async function storeWithPreview() {
    const { useTrackerPlaybackStore } = await import('src/stores/tracker-playback-store');
    const store = useTrackerPlaybackStore();
    setCurrentAhxSource(bytes());
    await store.prepareAhxPreview();
    expect(created).toHaveLength(1);
    return { store, worklet: created[0]! };
  }

  it('a subscribed store makes no worklet until something asks for one', async () => {
    const { useTrackerPlaybackStore } = await import('src/stores/tracker-playback-store');
    useTrackerPlaybackStore();
    expect(created).toHaveLength(0);
    expect(ahxPreviewOutputNode.value).toBeNull();
  });

  it('the preview’s client output lands in ahxPreviewOutputNode', async () => {
    const { worklet } = await storeWithPreview();
    expect(ahxPreviewOutputNode.value).toBe(worklet.output);
  });

  it('a different song clears the node', async () => {
    await storeWithPreview();
    expect(ahxPreviewOutputNode.value).not.toBeNull();
    setCurrentAhxSource(new Uint8Array([0x54, 0x48, 0x58, 0, 9, 9]));
    expect(ahxPreviewOutputNode.value).toBeNull();
  });

  it('dispose clears the node', async () => {
    const { store } = await storeWithPreview();
    expect(ahxPreviewOutputNode.value).not.toBeNull();
    store.dispose();
    expect(ahxPreviewOutputNode.value).toBeNull();
  });
});
