// src/audio/audioProcessorLoader.ts
import { useAudioSystemStore } from 'src/stores/audio-system-store';
import { loadWasmBinary } from 'src/utils/wasm-loader';

export async function createStandardAudioWorklet(
  audioContext: AudioContext,
): Promise<AudioWorkletNode> {
  // Load the AudioWorklet processor
  await audioContext.audioWorklet.addModule('src/audio/synth-worklet.ts?worklet');

  // Create the AudioWorkletNode
  const workletNode = new AudioWorkletNode(
    audioContext,
    'synth-audio-processor',
  );

  // Load the WASM binary as an ArrayBuffer

  // Listen for messages from the processor
  workletNode.port.onmessage = (event) => {
    if (event.data.type === 'ready') {

    }
  };

  return workletNode;
}

export async function createAudioWorkletWithWasm(
  audioContext: AudioContext,
  wasmMemory: WebAssembly.Memory,
): Promise<AudioWorkletNode> {
  // Load the AudioWorklet processor
  await audioContext.audioWorklet.addModule('src/audio/processor.ts?worklet');
  const { getNextMemorySegment } = useAudioSystemStore();

  // Create the AudioWorkletNode
  const workletNode = new AudioWorkletNode(
    audioContext,
    'wasm-audio-processor',
  );

  // Load the WASM binary as an ArrayBuffer
  const wasmBinary = await loadWasmBinary('wasm/release.wasm');

  // Listen for messages from the processor
  workletNode.port.onmessage = (event) => {
    if (event.data.type === 'ready') {
      console.log('AudioWorkletProcessor is ready, sending WASM and memory');
      const memSegment = getNextMemorySegment();
      //console.log('memSegment:', memSegment);
      workletNode.port.postMessage({
        type: 'initialize',
        wasmBinary,
        memory: wasmMemory,
        memorySegment: {
          audioBufferPtr: memSegment?.audioBufferPtr,
          envelope1Ptr: memSegment?.envelope1Ptr,
          frequencyPtr: memSegment?.parameterPtrs.frequency,
          gainPtr: memSegment?.parameterPtrs.gain,
          detunePtr: memSegment?.parameterPtrs.detune,
          gatePtr: memSegment?.parameterPtrs.gate,
          offsetsPtr: memSegment?.offsetsPtr,
        },
      });
    }
  };

  return workletNode;
}
