// src/audio/audioProcessorLoader.ts
export async function createStandardAudioWorklet(audioContext: AudioContext): Promise<AudioWorkletNode> {
  await audioContext.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/synth-worklet.js`);
  const workletNode = new AudioWorkletNode(audioContext, 'synth-audio-processor');

  workletNode.port.onmessage = async (event) => {
    if (event.data.type === 'ready') {
      console.log('AudioWorkletProcessor is ready, compiling WASM...');
      // Fetch and compile the WASM module here
      const wasmUrl = `${import.meta.env.BASE_URL}wasm/audio_processor_bg.wasm`;
      console.log('wasmUrl:', wasmUrl);
      const response = await fetch(wasmUrl);
      const wasmBytes = await response.arrayBuffer();
      workletNode.port.postMessage({ type: 'wasm-binary', wasmBytes }, [wasmBytes]);

    }
  };
  return workletNode;
}

export async function createEffectsAudioWorklet(
  audioContext: AudioContext,
): Promise<AudioWorkletNode> {
  // Load the AudioWorklet processor
  await audioContext.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/effects-worklet.js`);

  // Create the AudioWorkletNode
  const workletNode = new AudioWorkletNode(
    audioContext,
    'effects-audio-processor',
  );

  return workletNode;
}
