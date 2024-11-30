// Should be default import for init
import init, { WasmAudio } from 'app/public/wasm/wasm_audio_worklet';

export async function createAudioWorkletWithWasm(
  audioContext: AudioContext,
): Promise<WasmAudio> {
  try {
    console.log('createAudioWorkletWithWasm called');
    // Initialize the WASM module first
    await init();

    // Create and return the WasmAudio instance
    return await WasmAudio.new(audioContext);

  } catch (error) {
    console.error('Failed to create audio worklet:', error);
    throw error;
  }
}