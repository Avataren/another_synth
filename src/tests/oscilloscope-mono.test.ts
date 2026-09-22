import { afterEach, describe, expect, it, vi } from 'vitest';
import { mount } from '@vue/test-utils';
import OscilloscopeComponent from 'src/components/OscilloscopeComponent.vue';

/**
 * Mono mode for the oscilloscope (AHX preview fix): the AHX preview voice is
 * monophonic, so the waveform visualizer must tap the input node with ONE
 * analyser directly — no ChannelSplitter, no Left/Right canvas pair. The
 * default (mono=false) path must keep the stereo split exactly as before,
 * because IndexPage (native patch editor) relies on it.
 */

interface RecordingContext {
  createAnalyser: ReturnType<typeof vi.fn>;
  createChannelSplitter: ReturnType<typeof vi.fn>;
}

interface FakeAnalyser {
  fftSize: number;
  frequencyBinCount: number;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  getByteTimeDomainData: ReturnType<typeof vi.fn>;
}

function makeFakeAudioNode() {
  const analysers: FakeAnalyser[] = [];
  const createAnalyser = vi.fn((): FakeAnalyser => {
    const a: FakeAnalyser = {
      fftSize: 0,
      frequencyBinCount: 128,
      connect: vi.fn(),
      disconnect: vi.fn(),
      getByteTimeDomainData: vi.fn(),
    };
    analysers.push(a);
    return a;
  });
  const createChannelSplitter = vi.fn(() => ({
    connect: vi.fn(),
    disconnect: vi.fn(),
  }));
  const context: RecordingContext = { createAnalyser, createChannelSplitter };
  const connect = vi.fn();
  const node = {
    context,
    connect,
    disconnect: vi.fn(),
    numberOfOutputs: 1,
  } as unknown as AudioNode;
  return { node, context, createAnalyser, createChannelSplitter, connect, analysers };
}

/** jsdom keeps scheduling rAF forever; stop the loop after the first frame. */
function stopAfterFirstFrame() {
  let frames = 0;
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames += 1;
    if (frames > 1) return 0;
    cb(performance.now());
    return 0;
  });
}

afterEach(() => {
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});

describe('OscilloscopeComponent mono mode', () => {
  it('mono: one analyser directly on the input node, NO splitter, one canvas', () => {
    stopAfterFirstFrame();
    const fake = makeFakeAudioNode();
    const w = mount(OscilloscopeComponent, {
      props: { node: fake.node, mono: true },
    });

    expect(fake.createAnalyser).toHaveBeenCalledTimes(1);
    expect(fake.createChannelSplitter).not.toHaveBeenCalled();

    // The single analyser is connected directly to the input node.
    const analyser = fake.analysers[0];
    if (!analyser) throw new Error('expected one analyser to be created');
    expect(fake.connect).toHaveBeenCalledWith(analyser);
    expect(analyser.connect).not.toHaveBeenCalled();

    // fftSize matches the stereo path.
    expect(analyser.fftSize).toBe(2048);

    const canvases = w.findAll('canvas');
    expect(canvases).toHaveLength(1);
    expect(canvases.map((c) => c.attributes('data-label'))).toEqual(['Waveform']);
    w.unmount();
  });

  it('default (mono=false): stereo path unchanged — splitter + two analysers + two canvases', () => {
    stopAfterFirstFrame();
    const fake = makeFakeAudioNode();
    const w = mount(OscilloscopeComponent, {
      props: { node: fake.node },
    });

    expect(fake.createChannelSplitter).toHaveBeenCalledTimes(1);
    expect(fake.createAnalyser).toHaveBeenCalledTimes(2);
    expect(fake.connect).toHaveBeenCalledTimes(1); // node -> splitter

    const canvases = w.findAll('canvas');
    expect(canvases).toHaveLength(2);
    expect(canvases.map((c) => c.attributes('data-label'))).toEqual(['Left', 'Right']);
    w.unmount();
  });

  it('mono: node prop change reattaches a single analyser without a splitter', async () => {
    stopAfterFirstFrame();
    const first = makeFakeAudioNode();
    const w = mount(OscilloscopeComponent, {
      props: { node: first.node, mono: true },
    });
    expect(first.createChannelSplitter).not.toHaveBeenCalled();

    const second = makeFakeAudioNode();
    await w.setProps({ node: second.node });
    expect(second.createAnalyser).toHaveBeenCalledTimes(1);
    expect(second.createChannelSplitter).not.toHaveBeenCalled();
    expect(second.connect).toHaveBeenCalledTimes(1);
    // Old node's analyser was disconnected on cleanup.
    const oldAnalyser = first.analysers[0];
    if (!oldAnalyser) throw new Error('expected the old analyser to exist');
    expect(oldAnalyser.disconnect).toHaveBeenCalled();
    w.unmount();
  });
});
