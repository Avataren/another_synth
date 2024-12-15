export default interface OscillatorState {
    id?: number,
    phase_mod_amount?: number,
    freq_mod_amount?: number,
    detune_oct?: number,
    detune_semi?: number,
    detune_cents?: number,
    detune?: number,
    hard_sync?: boolean,
    gain?: number,
    active?: boolean,
};