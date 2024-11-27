// src/audio/audioProcessorLoader.ts
import { loadWasmBinary } from 'src/utils/wasm-loader';

const memory = new WebAssembly.Memory({ initial: 256, maximum: 1024, shared: true });

export async function createAudioWorkletWithWasm(
    audioContext: AudioContext,
): Promise<AudioWorkletNode> {
    // Load the AudioWorklet processor
    await audioContext.audioWorklet.addModule('src/audio/processor.js');

    // Create the AudioWorkletNode
    const workletNode = new AudioWorkletNode(audioContext, 'wasm-audio-processor');

    // Load the WASM binary as an ArrayBuffer
    const wasmBinary = await loadWasmBinary('/wasm/release.wasm');

    // Listen for messages from the processor
    workletNode.port.onmessage = (event) => {
        if (event.data.type === 'ready') {
            console.log('AudioWorkletProcessor is ready, sending WASM and memory');
            workletNode.port.postMessage('test');
            workletNode.port.postMessage({
                type: 'initialize',
                wasmBinary,
                memory: memory,
            });
        }
    };

    return workletNode;
}
