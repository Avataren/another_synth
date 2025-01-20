// src/audio/audio-processor-loader.ts
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import type { LayoutUpdateMessage } from './types/synth-layout';

export async function createStandardAudioWorklet(audioContext: AudioContext): Promise<AudioWorkletNode> {
  await audioContext.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/synth-worklet.js`);

  const workletNode = new AudioWorkletNode(audioContext, 'synth-audio-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2],  // Specify stereo output
  });
  const store = useAudioSystemStore();

  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      reject(new Error('Timeout waiting for synth initialization'));
    }, 5000); // 5 second timeout

    // Handle messages from the worklet
    workletNode.port.onmessage = async (event) => {
      if (event.data.type === 'ready') {
        console.log('AudioWorkletProcessor is ready, sending WASM...');
        try {
          const wasmUrl = `${import.meta.env.BASE_URL}wasm/audio_processor_bg.wasm`;
          const response = await fetch(wasmUrl);
          const wasmBytes = await response.arrayBuffer();
          workletNode.port.postMessage({ type: 'wasm-binary', wasmBytes }, [wasmBytes]);
        } catch (error) {
          clearTimeout(timeoutId);
          reject(error);
        }
      }
      else if (event.data.type === 'synthLayout') {
        console.log('Received synth layout:', event.data);

        // Update both the store and the instrument
        const layoutMessage = event.data as LayoutUpdateMessage;
        store.updateSynthLayout(layoutMessage.layout);
        store.currentInstrument?.updateLayout(layoutMessage.layout);

        // Now that we have the layout, the synth is fully initialized
        clearTimeout(timeoutId);
        resolve(workletNode);
      }
    };

    workletNode.port.onmessageerror = (error) => {
      clearTimeout(timeoutId);
      reject(error);
    };
  });
}

export async function createEffectsAudioWorklet(
  audioContext: AudioContext,
): Promise<AudioWorkletNode> {
  await audioContext.audioWorklet.addModule(`${import.meta.env.BASE_URL}worklets/effects-worklet.js`);
  return new AudioWorkletNode(audioContext, 'effects-audio-processor');
}