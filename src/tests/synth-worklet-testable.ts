(globalThis as unknown as Record<string, unknown>).AudioWorkletProcessor =
  class {
    port = {
      postMessage: () => {},
    };
  };

(globalThis as unknown as Record<string, unknown>).registerProcessor = () => {};

const module = await import('../../src/audio/worklets/synth-worklet.js');

export const SynthAudioProcessor = module.SynthAudioProcessor;
