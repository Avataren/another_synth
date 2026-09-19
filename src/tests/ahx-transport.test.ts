import { describe, it, expect, vi } from 'vitest';
import { AhxTransport } from 'src/audio/tracker/ahx-transport';
import type {
  AhxPlayerClient,
  AhxPosition,
  AhxSongInfo,
  AhxWaveforms,
} from 'src/audio/tracker/ahx-player';

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
  const waveformListeners = new Set<(w: AhxWaveforms) => void>();
  const output = { connect: vi.fn() };
  const client = {
    audioContext,
    output,
    loadSong: vi.fn(async () => INFO),
    play: vi.fn(),
    pause: vi.fn(),
    restart: vi.fn(),
    seek: vi.fn(),
    setLoopPosition: vi.fn(),
    setStopAtEnd: vi.fn(),
    setCapture: vi.fn(),
    setMuteSolo: vi.fn(),
    setHifi: vi.fn(),
    dispose: vi.fn(),
    onPosition: (l: (p: AhxPosition) => void) => {
      positionListeners.add(l);
      return () => positionListeners.delete(l);
    },
    onSongEnd: (l: () => void) => {
      songEndListeners.add(l);
      return () => songEndListeners.delete(l);
    },
    onWaveforms: (l: (w: AhxWaveforms) => void) => {
      waveformListeners.add(l);
      return () => waveformListeners.delete(l);
    },
  };
  return {
    client: client as unknown as AhxPlayerClient,
    raw: client,
    emitPosition: (p: AhxPosition) => positionListeners.forEach((l) => l(p)),
    emitEnd: () => songEndListeners.forEach((l) => l()),
    emitWaveforms: (w: AhxWaveforms) => waveformListeners.forEach((l) => l(w)),
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

  it('applies stop-at-end to a client made after it was set, and to a live one', async () => {
    const { fake, transport } = setup();
    transport.setStopAtEnd(true);
    await transport.load(new Uint8Array([1]));
    expect(fake.raw.setStopAtEnd).toHaveBeenLastCalledWith(true);
    transport.setStopAtEnd(false);
    expect(fake.raw.setStopAtEnd).toHaveBeenLastCalledWith(false);
  });

  it('applies capture to a client made after it was set, and to a live one; off by default', async () => {
    const off = setup();
    await off.transport.load(new Uint8Array([1]));
    expect(off.fake.raw.setCapture).not.toHaveBeenCalled();

    const { fake, transport } = setup();
    transport.setCapture(true);
    await transport.load(new Uint8Array([1]));
    expect(fake.raw.setCapture).toHaveBeenLastCalledWith(true);
    transport.setCapture(false);
    expect(fake.raw.setCapture).toHaveBeenLastCalledWith(false);
  });

  it('applies mute/solo to a client made after it was set, and to a live one; untouched by default', async () => {
    const off = setup();
    await off.transport.load(new Uint8Array([1]));
    expect(off.fake.raw.setMuteSolo).not.toHaveBeenCalled();

    const { fake, transport } = setup();
    transport.setMuteSolo(0b0101, 0);
    await transport.load(new Uint8Array([1]));
    expect(fake.raw.setMuteSolo).toHaveBeenLastCalledWith(0b0101, 0);
    transport.setMuteSolo(0, 0b0010);
    expect(fake.raw.setMuteSolo).toHaveBeenLastCalledWith(0, 0b0010);
  });

  it('applies loop-position to a client made after it was set, and to a live one; untouched by default', async () => {
    const off = setup();
    await off.transport.load(new Uint8Array([1]));
    expect(off.fake.raw.setLoopPosition).not.toHaveBeenCalled();

    const { fake, transport } = setup();
    transport.setLoopPosition(true);
    await transport.load(new Uint8Array([1]));
    expect(fake.raw.setLoopPosition).toHaveBeenLastCalledWith(true);
    transport.setLoopPosition(false);
    expect(fake.raw.setLoopPosition).toHaveBeenLastCalledWith(false);
  });

  it('seek goes to the client as it is: no pause, no restart', async () => {
    const { fake, transport } = setup();
    await transport.load(new Uint8Array([1]));
    transport.seek(3, 12);
    expect(fake.raw.seek).toHaveBeenCalledWith(3, 12);
    expect(fake.raw.pause).not.toHaveBeenCalled();
    expect(fake.raw.restart).not.toHaveBeenCalled();
  });

  it('always turns hi-fi on for the client it makes, before the song loads', async () => {
    const { fake, transport } = setup();
    await transport.load(new Uint8Array([1]));
    expect(fake.raw.setHifi).toHaveBeenCalledTimes(1);
    expect(fake.raw.setHifi).toHaveBeenLastCalledWith(true);
    const [hifiOrder] = fake.raw.setHifi.mock.invocationCallOrder;
    const [loadOrder] = fake.raw.loadSong.mock.invocationCallOrder;
    expect(hifiOrder).toBeLessThan(loadOrder as number);
  });

  it('relays waveform snapshots to its listeners, and unsubscribes', async () => {
    const { fake, transport } = setup();
    const seen: AhxWaveforms[] = [];
    const off = transport.onWaveforms((w) => seen.push(w));
    await transport.load(new Uint8Array([1]));
    const w = { channels: 4, points: 2, data: new Int16Array(8) };
    fake.emitWaveforms(w);
    expect(seen).toEqual([w]);
    off();
    fake.emitWaveforms(w);
    expect(seen).toHaveLength(1);
  });

  it('loading the bytes already loaded touches nothing: it does not rewind', async () => {
    const { fake, transport } = setup();
    const bytes = new Uint8Array([1]);
    await transport.load(bytes);
    fake.raw.restart.mockClear();
    fake.raw.pause.mockClear();
    await transport.load(bytes);
    expect(fake.raw.loadSong).toHaveBeenCalledOnce();
    expect(fake.raw.restart).not.toHaveBeenCalled();
    expect(fake.raw.pause).not.toHaveBeenCalled();
  });

  it('a client still starting when the transport is disposed is disposed, not attached', async () => {
    const ctx = {} as AudioContext;
    const fake = fakeClient(ctx);
    let finish!: () => void;
    const create = vi.fn(
      () =>
        new Promise<AhxPlayerClient>((resolve) => {
          finish = () => resolve(fake.client);
        }),
    );
    const transport = new AhxTransport({ audioContext: ctx, output: {} as AudioNode }, create);
    const loading = transport.load(new Uint8Array([1]));
    transport.dispose();
    finish();
    await expect(loading).rejects.toThrow(/disposed/);
    expect(fake.raw.dispose).toHaveBeenCalledOnce();
    expect(fake.raw.output.connect).not.toHaveBeenCalled();
  });
});
