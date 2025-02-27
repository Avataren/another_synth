export default interface OscillatorState {
    id?: number,
    phase_mod_amount: number,
    freq_mod_amount: number,
    detune_oct: number,
    detune_semi: number,
    detune_cents: number,
    detune: number,
    hard_sync: boolean,
    gain: number,
    feedback_amount: number,
    waveform: number,
    active: boolean,
    unison_voices: number,
    spread: number,
    wave_index: number
};