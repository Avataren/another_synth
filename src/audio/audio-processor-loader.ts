// src/audio/audio-processor-loader.ts
import { useLayoutStore } from 'src/stores/layout-store';
import { useNodeStateStore } from 'src/stores/node-state-store';
import type { LayoutUpdateMessage } from './types/synth-layout';

export async function createStandardAudioWorklet(
  audioContext: AudioContext
): Promise<AudioWorkletNode> {
  await audioContext.audioWorklet.addModule(
    `${import.meta.env.BASE_URL}worklets/synth-worklet.js`
  );

  const workletNode = new AudioWorkletNode(audioContext, 'synth-audio-processor', {
    numberOfInputs: 0,
    numberOfOutputs: 1,
    outputChannelCount: [2], // Specify stereo output
  });
  const layoutStore = useLayoutStore();
  const nodeStateStore = useNodeStateStore();
  workletNode.port.start();

  return new Promise((resolve, reject) => {
    let resolved = false;
    const resolveOnce = (fn: () => void) => {
      if (resolved) {
        return;
      }
      resolved = true;
      clearTimeout(timeoutId);
      fn();
    };
    const timeoutId = setTimeout(() => {
      resolveOnce(() => {
        reject(new Error('Timeout waiting for synth initialization'));
      });
    }, 5000); // 5 second timeout

    // Handle messages from the worklet
    const handleMessage = async (event: MessageEvent) => {
      const data = event.data;
      if (data.type === 'ready') {
        console.log('AudioWorkletProcessor is ready, sending WASM...');
        try {
          const wasmUrl = `${import.meta.env.BASE_URL}wasm/audio_processor_bg.wasm`;
          const response = await fetch(wasmUrl);
          const wasmBytes = await response.arrayBuffer();
          workletNode.port.postMessage(
            { type: 'wasm-binary', wasmBytes },
            [wasmBytes]
          );
          resolveOnce(() => resolve(workletNode));
        } catch (error) {
          resolveOnce(() => reject(error as Error));
        }
      } else if (data.type === 'synthLayout') {
        console.log('Received synth layout:', data);

        const layoutMessage = data as LayoutUpdateMessage;
        layoutStore.updateSynthLayout(layoutMessage.layout);
        nodeStateStore.initializeDefaultStates();
      } else if (data.type === 'stateUpdated') {
        // This is the pushed update from the worklet whenever state changes.
        console.log('Received automatic state update:', data);
        layoutStore.updateSynthLayout(data.state);
        nodeStateStore.initializeDefaultStates();
      }
    };
    const handleMessageError = (event: MessageEvent) => {
      resolveOnce(() => {
        reject(
          event.data instanceof Error
            ? event.data
            : new Error('Message port error while initializing synth worklet')
        );
      });
    };

    workletNode.port.addEventListener('message', handleMessage);
    workletNode.port.addEventListener('messageerror', handleMessageError as EventListener);
  });
}

export async function createEffectsAudioWorklet(
  audioContext: AudioContext
): Promise<AudioWorkletNode> {
  await audioContext.audioWorklet.addModule(
    `${import.meta.env.BASE_URL}worklets/effects-worklet.js`
  );
  return new AudioWorkletNode(audioContext, 'effects-audio-processor');
}
