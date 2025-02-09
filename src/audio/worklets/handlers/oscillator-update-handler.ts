import { type AnalogOscillatorStateUpdate, type AudioEngine } from 'app/public/wasm/audio_processor';

export default class OscillatorUpdateHandler {
    UpdateOscillator(engine: AudioEngine, stateUpdate: AnalogOscillatorStateUpdate, oscillatorId: number, numVoices: number) {
        for (let i = 0; i < numVoices; i++) {
            engine.update_oscillator(i, oscillatorId, stateUpdate);
        }
    }
}