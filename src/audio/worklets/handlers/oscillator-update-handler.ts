import { type AudioEngine, type OscillatorStateUpdate } from 'app/public/wasm/audio_processor';

export default class OscillatorUpdateHandler {
    UpdateOscillator(engine: AudioEngine, stateUpdate: OscillatorStateUpdate, oscillatorId: number, numVoices: number) {
        for (let i = 0; i < numVoices; i++) {
            engine.update_oscillator(i, oscillatorId, stateUpdate);
        }
    }
}