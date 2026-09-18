// @vitest-environment node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { AhxPlayer, initSync } from '../../public/wasm/audio_processor.js';
import {
  AhxProcessorCore,
  type AhxWasmPlayerCtor,
} from 'src/audio/worklets/ahx-core';
import {
  ahxDemoUrl,
  createAhxPlayer,
  loadAhxSongFromUrl,
} from 'src/audio/tracker/ahx-player';
import { AhxTrackerSink } from 'src/audio/tracker/ahx-sink';

const ROOT = resolve(__dirname, '../..');
const wasmBytes = readFileSync(resolve(ROOT, 'public/wasm/audio_processor_bg.wasm'));
const karma = readFileSync(resolve(ROOT, 'public/demos/ahx/karma.ahx'));

/**
 * A stand-in for `AudioWorkletNode` whose far end is what `ahx-worklet.ts`
 * runs: the same `ready` / `wasm-binary` / `wasm-ready` handshake, then an
 * `AhxProcessorCore` over the real wasm. Messages hop a microtask, like a
 * real MessagePort, so nothing here is accidentally synchronous.
 */
class FakeWorkletNode {
  static last: FakeWorkletNode | null = null;
  onprocessorerror: (() => void) | null = null;
  connected: unknown[] = [];
  closed = false;
  private core: AhxProcessorCore | null = null;
  port: {
    onmessage: ((e: MessageEvent) => void) | null;
    postMessage: (data: unknown, transfer?: Transferable[]) => void;
    close: () => void;
  };

  constructor() {
    FakeWorkletNode.last = this;
    const toMain = (data: unknown) =>
      queueMicrotask(() => this.port.onmessage?.({ data } as MessageEvent));
    this.port = {
      onmessage: null,
      close: () => {
        this.closed = true;
      },
      postMessage: (data) =>
        queueMicrotask(() => {
          const msg = data as { type: string; wasmBytes?: ArrayBuffer };
          if (msg.type === 'wasm-binary') {
            initSync({ module: new Uint8Array(msg.wasmBytes as ArrayBuffer) });
            this.core = new AhxProcessorCore(
              AhxPlayer as unknown as AhxWasmPlayerCtor,
              44100,
              toMain,
            );
            toMain({ type: 'wasm-ready' });
          } else {
            this.core?.handle(msg as never);
          }
        }),
    };
    toMain({ type: 'ready' });
  }

  connect(target: unknown) {
    this.connected.push(target);
  }
  disconnect() {}
  /** What the audio thread would do each quantum. */
  pull(frames = 128) {
    const l = new Float32Array(frames);
    const r = new Float32Array(frames);
    this.core?.process(l, r);
    return { l, r };
  }
}

function fakeContext() {
  const gain = {
    value: 1,
    setValueAtTime: vi.fn(),
  };
  const output = { gain, connect: vi.fn(), disconnect: vi.fn() };
  return {
    state: 'running' as AudioContextState,
    currentTime: 10,
    audioWorklet: { addModule: vi.fn(async () => undefined) },
    createGain: () => output,
    resume: vi.fn(async () => undefined),
    output,
  };
}

function stubGlobals(fetchImpl?: typeof fetch) {
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  vi.stubGlobal(
    'fetch',
    fetchImpl ??
      vi.fn(async (url: string) => {
        if (String(url).endsWith('.wasm')) {
          return new Response(wasmBytes, { status: 200 });
        }
        return new Response(karma, { status: 200 });
      }),
  );
}

beforeAll(() => {
  // The client never loads the wasm itself; the fake worklet does.
});

afterEach(() => {
  vi.unstubAllGlobals();
  FakeWorkletNode.last = null;
});

describe('createAhxPlayer / AhxPlayerClient', () => {
  it('handshakes, loads karma.ahx from the demo path and produces audio', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      String(url).endsWith('.wasm')
        ? new Response(wasmBytes, { status: 200 })
        : new Response(karma, { status: 200 }),
    );
    stubGlobals(fetchMock as unknown as typeof fetch);
    const ctx = fakeContext();

    const player = await createAhxPlayer(ctx as unknown as AudioContext);
    expect(ctx.audioWorklet.addModule).toHaveBeenCalledWith(
      expect.stringMatching(/worklets\/ahx-worklet\.js$/),
    );

    const info = await loadAhxSongFromUrl(player, ahxDemoUrl('karma.ahx'));
    expect(fetchMock).toHaveBeenCalledWith('demos/ahx/karma.ahx');
    expect(info).toMatchObject({ channels: 4, droppedChannels: 0 });
    expect(player.song).toEqual(info);

    const node = FakeWorkletNode.last as FakeWorkletNode;
    expect(node.pull().l.every((s) => s === 0)).toBe(true); // not playing yet
    const positions: number[] = [];
    player.onPosition((p) => positions.push(p.position));
    player.play();
    await Promise.resolve();
    await Promise.resolve();
    let audible = false;
    for (let i = 0; i < 400; i++) {
      if (node.pull().l.some((s) => s !== 0)) audible = true;
    }
    expect(audible).toBe(true);
    await Promise.resolve();
    expect(positions.length).toBeGreaterThan(0);
    player.dispose();
    expect(node.closed).toBe(true);
  });

  it('rejects loadSong with the parser message for a bad file', async () => {
    stubGlobals();
    const player = await createAhxPlayer(fakeContext() as unknown as AudioContext);
    await expect(player.loadSong(new Uint8Array([9, 9, 9]))).rejects.toThrow(/AHX load failed/);
  });

  it('rejects a failed wasm fetch during the handshake', async () => {
    stubGlobals(vi.fn(async () => new Response('nope', { status: 404, statusText: 'Not Found' })) as unknown as typeof fetch);
    await expect(
      createAhxPlayer(fakeContext() as unknown as AudioContext),
    ).rejects.toThrow(/404/);
  });

  it('rejects a load that a newer load supersedes', async () => {
    stubGlobals();
    const player = await createAhxPlayer(fakeContext() as unknown as AudioContext);
    const first = player.loadSong(karma);
    const second = player.loadSong(karma);
    await expect(first).rejects.toThrow(/superseded/);
    await expect(second).resolves.toMatchObject({ channels: 4 });
  });

  it('rejects loadSong callers when the player is disposed mid-load', async () => {
    stubGlobals();
    const player = await createAhxPlayer(fakeContext() as unknown as AudioContext);
    const pending = player.loadSong(karma);
    player.dispose();
    await expect(pending).rejects.toThrow(/disposed/);
  });
});

describe('AhxTrackerSink', () => {
  async function makeSink() {
    stubGlobals();
    const ctx = fakeContext();
    const player = await createAhxPlayer(ctx as unknown as AudioContext);
    await player.loadSong(karma);
    const pause = vi.spyOn(player, 'pause');
    return { sink: new AhxTrackerSink(player), ctx, player, pause };
  }

  it('drives master volume through the output gain, now or at a future time', async () => {
    const { sink, ctx } = await makeSink();
    sink.setMasterVolume(0.5);
    expect(ctx.output.gain.setValueAtTime).toHaveBeenLastCalledWith(0.5, 10);
    sink.setMasterVolume(0.25, 12);
    expect(ctx.output.gain.setValueAtTime).toHaveBeenLastCalledWith(0.25, 12);
    sink.setMasterVolume(0.75, 3); // past: now, not skipped
    expect(ctx.output.gain.setValueAtTime).toHaveBeenLastCalledWith(0.75, 10);
    sink.setMasterVolume(-1);
    expect(ctx.output.gain.setValueAtTime).toHaveBeenLastCalledWith(0, 10);
  });

  it('maps the stop-the-song calls to pause and ignores note traffic', async () => {
    const { sink, pause } = await makeSink();
    sink.noteOnAtTime('01', 60, 1, 0, 0);
    sink.setVoicePitchAtTime('01', 0, 440, 0, 0);
    sink.notesOffForTrack(0);
    expect(pause).not.toHaveBeenCalled();
    sink.allNotesOff();
    sink.cutAllVoicesAtTime(0);
    sink.cancelAllScheduled();
    expect(pause).toHaveBeenCalledTimes(3);
    await expect(sink.prepareInstrument('01')).resolves.toBeUndefined();
  });

  it('resumes a suspended context', async () => {
    const { sink, ctx } = await makeSink();
    ctx.state = 'suspended';
    expect(sink.needsResume).toBe(true);
    ctx.resume.mockImplementationOnce(async () => {
      ctx.state = 'running';
    });
    await expect(sink.ensureAudioContextRunning()).resolves.toBe(true);
    expect(sink.needsResume).toBe(false);
  });
});
