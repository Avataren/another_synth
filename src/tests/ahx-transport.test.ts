import { describe, it, expect, vi } from 'vitest';
import { AhxTransport } from 'src/audio/tracker/ahx-transport';
import type { AhxPlayerClient, AhxPosition, AhxSongInfo } from 'src/audio/tracker/ahx-player';

const INFO: AhxSongInfo = {
  name: 'T',
  positionCount: 2,
  trackLength: 4,
  channels: 4,
  droppedChannels: 0,
  sampleRate: 44100,
};

function fakeClient(audioContext: AudioContext) {
  const positionListeners = new Set<(p: AhxPosition) => void>();
  const songEndListeners = new Set<() => void>();
  const output = { connect: vi.fn() };
  const client = {
    audioContext,
    output,
    loadSong: vi.fn(async () => INFO),
    play: vi.fn(),
    pause: vi.fn(),
    restart: vi.fn(),
    dispose: vi.fn(),
    onPosition: (l: (p: AhxPosition) => void) => {
      positionListeners.add(l);
      return () => positionListeners.delete(l);
    },
    onSongEnd: (l: () => void) => {
      songEndListeners.add(l);
      return () => songEndListeners.delete(l);
    },
  };
  return {
    client: client as unknown as AhxPlayerClient,
    raw: client,
    emitPosition: (p: AhxPosition) => positionListeners.forEach((l) => l(p)),
    emitEnd: () => songEndListeners.forEach((l) => l()),
  };
}

function setup() {
  const ctx = {} as AudioContext;
  const bus = {} as AudioNode;
  const fake = fakeClient(ctx);
  const create = vi.fn(async () => fake.client);
  const transport = new AhxTransport({ audioContext: ctx, output: bus }, create);
  return { ctx, bus, fake, create, transport };
}

describe('AhxTransport', () => {
  it('creates one client lazily and routes it into the mix bus', async () => {
    const { bus, fake, create, transport } = setup();
    expect(create).not.toHaveBeenCalled();
    await transport.load(new Uint8Array([1]));
    await transport.load(new Uint8Array([2]));
    expect(create).toHaveBeenCalledTimes(1);
    expect(fake.raw.output.connect).toHaveBeenCalledWith(bus);
  });

  it('loading the same bytes again does not reload; different bytes do', async () => {
    const { fake, transport } = setup();
    const a = new Uint8Array([1]);
    await transport.load(a);
    await transport.load(a);
    expect(fake.raw.loadSong).toHaveBeenCalledTimes(1);
    await transport.load(new Uint8Array([2]));
    expect(fake.raw.loadSong).toHaveBeenCalledTimes(2);
  });

  it('joins a load already under way instead of superseding it', async () => {
    const { fake, transport } = setup();
    const a = new Uint8Array([1]);
    const first = transport.load(a);
    const second = transport.load(a);
    await Promise.all([first, second]);
    expect(fake.raw.loadSong).toHaveBeenCalledTimes(1);
  });

  it('stop pauses and rewinds; play plays', async () => {
    const { fake, transport } = setup();
    transport.stop(); // nothing loaded: no-op
    expect(fake.raw.pause).not.toHaveBeenCalled();
    await transport.load(new Uint8Array([1]));
    transport.play();
    expect(fake.raw.play).toHaveBeenCalledOnce();
    transport.stop();
    expect(fake.raw.pause).toHaveBeenCalledOnce();
    expect(fake.raw.restart).toHaveBeenCalledWith(0);
  });

  it('relays position and song-end to its listeners, and unsubscribes', async () => {
    const { fake, transport } = setup();
    const positions: AhxPosition[] = [];
    const ends = vi.fn();
    const off = transport.onPosition((p) => positions.push(p));
    transport.onSongEnd(ends);
    await transport.load(new Uint8Array([1]));
    fake.emitPosition({ position: 1, row: 2, tempo: 6, ticks: 0 });
    fake.emitEnd();
    expect(positions).toEqual([{ position: 1, row: 2, tempo: 6, ticks: 0 }]);
    expect(ends).toHaveBeenCalledOnce();
    off();
    fake.emitPosition({ position: 0, row: 0, tempo: 6, ticks: 0 });
    expect(positions).toHaveLength(1);
  });

  it('dispose tears the client down', async () => {
    const { fake, transport } = setup();
    await transport.load(new Uint8Array([1]));
    transport.dispose();
    expect(fake.raw.dispose).toHaveBeenCalledOnce();
    expect(transport.info).toBeNull();
  });
});
