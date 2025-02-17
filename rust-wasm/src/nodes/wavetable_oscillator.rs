use std::any::Any;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use wasm_bindgen::prelude::*;
use web_sys::console;

// These are assumed to be defined elsewhere in your codebase:
use crate::graph::{ModulationProcessor, ModulationSource};
use crate::{AudioNode, PortId};

use super::morph_wavetable::{WavetableMorphCollection, WavetableSynthBank};

/// A helper function implementing a simple polyBLEP correction.
/// This function returns a correction value to subtract from discontinuous
/// waveforms (e.g. sawtooth). The parameter `t` is the (normalized) phase,
/// and `dt` is the phase increment per sample.
fn poly_blep(t: f32, dt: f32) -> f32 {
    if t < dt {
        // scale t to [0,1]
        let t = t / dt;
        return t + t - t * t - 1.0;
    } else if t > 1.0 - dt {
        let t = (t - 1.0) / dt;
        return t * t + t + t + 1.0;
    }
    0.0
}

/// A simple one-pole lowpass filter that carries its state.
/// (In production you may want a higher-order filter.)
fn simple_lowpass_filter_in_place(
    buffer: &mut [f32],
    oversample_factor: usize,
    sample_rate: f32,
    state: &mut f32,
) {
    // For oversampled data the effective cutoff should be scaled.
    let cutoff = (sample_rate * 0.45) / (oversample_factor as f32);
    let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff.max(1.0));
    let dt = 1.0 / (sample_rate * oversample_factor as f32);
    let alpha = dt / (rc + dt);
    let mut prev = *state;
    for x in buffer.iter_mut() {
        let out = prev + alpha * (*x - prev);
        *x = out;
        prev = out;
    }
    *state = prev;
}

#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct WavetableOscillatorStateUpdate {
    pub phase_mod_amount: f32,
    pub detune: f32,
    pub hard_sync: bool,
    pub gain: f32,
    pub active: bool,
    pub feedback_amount: f32,
    pub unison_voices: u32,   // number of voices in unison
    pub spread: f32,          // spread in cents (max detune per voice)
    pub wavetable_index: f32, // morph parameter: 0.0–1.0 for interpolation between waveforms
}

#[wasm_bindgen]
impl WavetableOscillatorStateUpdate {
    #[wasm_bindgen(constructor)]
    pub fn new(
        phase_mod_amount: f32,
        detune: f32,
        hard_sync: bool,
        gain: f32,
        active: bool,
        feedback_amount: f32,
        unison_voices: u32,
        spread: f32,
        wavetable_index: f32,
    ) -> Self {
        Self {
            phase_mod_amount,
            detune,
            hard_sync,
            gain,
            active,
            feedback_amount,
            unison_voices,
            spread,
            wavetable_index,
        }
    }
}

/// The wavetable oscillator uses a bank of morph collections and selects one by name.
/// (The bank is stored by value here to avoid Arc.)
pub struct WavetableOscillator {
    sample_rate: f32,
    gain: f32,
    active: bool,
    feedback_amount: f32,
    last_output: f32,
    hard_sync: bool,
    last_gate_value: f32,
    frequency: f32, // base frequency in Hz
    gate_buffer: Vec<f32>,
    // Modulation parameters.
    phase_mod_amount: f32,
    detune: f32,
    // Unison parameters.
    unison_voices: usize,
    spread: f32,
    voice_phases: Vec<f32>,
    // Morph parameter.
    wavetable_index: f32,
    // Name of the morph collection to use.
    collection_name: String,
    // The bank of wavetable morph collections.
    wavetable_bank: Rc<RefCell<WavetableSynthBank>>,
    // --- New fields for improved quality ---
    /// Oversampling factor (1 = no oversampling, 2 = 2×, 4 = 4×, etc.)
    oversample_factor: usize,
    /// When true, apply polyBLEP correction at waveform discontinuities.
    use_polyblep: bool,
    filter_prev: f32,
}

impl ModulationProcessor for WavetableOscillator {}

impl WavetableOscillator {
    /// Create a new oscillator.
    /// - `sample_rate`: audio sample rate.
    /// - `bank`: the wavetable synth bank (passed by value).
    /// - `collection_name`: the name of the morph collection to use (e.g., "default").
    pub fn new(sample_rate: f32, bank: Rc<RefCell<WavetableSynthBank>>) -> Self {
        Self {
            sample_rate,
            gain: 1.0,
            active: true,
            feedback_amount: 0.0,
            last_output: 0.0,
            hard_sync: false,
            last_gate_value: 0.0,
            frequency: 440.0,
            gate_buffer: vec![0.0; 1024],
            phase_mod_amount: 0.0,
            detune: 0.0,
            unison_voices: 1,
            spread: 0.1,
            voice_phases: vec![0.0; 1],
            wavetable_index: 0.0,
            collection_name: "default".to_string(),
            wavetable_bank: bank,
            oversample_factor: 4, // change to 2, 4, etc. to enable oversampling
            use_polyblep: false,  // set true if your waveform has discontinuities (e.g. saw)
            filter_prev: 0.0,
        }
    }

    pub fn set_current_wavetable(&mut self, collection_name: &str) {
        self.collection_name = collection_name.to_string();
    }

    /// Update oscillator parameters.
    pub fn update_params(&mut self, params: &WavetableOscillatorStateUpdate) {
        // console::log_1(&format!("Updating params: {:#?}", params).into());
        self.gain = params.gain;
        self.feedback_amount = params.feedback_amount;
        self.hard_sync = params.hard_sync;
        self.active = params.active;
        self.phase_mod_amount = params.phase_mod_amount;
        self.detune = params.detune;
        self.spread = params.spread;
        self.wavetable_index = params.wavetable_index;
        let new_voice_count = if params.unison_voices == 0 {
            1
        } else {
            params.unison_voices as usize
        };
        if new_voice_count != self.unison_voices {
            self.unison_voices = new_voice_count;
            self.voice_phases = vec![self.voice_phases[0]; new_voice_count];
        }
    }

    /// Check the gate for hard sync.
    fn check_gate(&mut self, gate: f32) {
        if self.hard_sync && gate > 0.0 && self.last_gate_value <= 0.0 {
            for phase in self.voice_phases.iter_mut() {
                *phase = 0.0;
            }
        }
        self.last_gate_value = gate;
    }
}

fn get_collection_from_bank(
    bank: &RefCell<WavetableSynthBank>,
    name: &str,
) -> Rc<WavetableMorphCollection> {
    bank.borrow()
        .get_collection(name)
        .expect("Wavetable collection not found")
}

impl AudioNode for WavetableOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::GlobalFrequency, false);
        ports.insert(PortId::FrequencyMod, false);
        ports.insert(PortId::PhaseMod, false);
        // New modulator to control phase modulation depth:
        ports.insert(PortId::ModIndex, false);
        ports.insert(PortId::WavetableIndex, false);
        ports.insert(PortId::GainMod, false);
        ports.insert(PortId::FeedbackMod, false);
        ports.insert(PortId::AudioOutput0, true);
        ports.insert(PortId::Gate, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // --- 1) Process modulations ---
        let freq_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::FrequencyMod), 1.0);
        let phase_mod = self.process_modulations(buffer_size, inputs.get(&PortId::PhaseMod), 0.0);
        let gain_mod = self.process_modulations(buffer_size, inputs.get(&PortId::GainMod), 1.0);
        let feedback_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::FeedbackMod), 1.0);
        let mod_index = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::ModIndex),
            self.phase_mod_amount,
        );
        let wavetable_index_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::WavetableIndex),
            self.wavetable_index,
        );

        // --- 2) Prepare gate buffer ---
        if self.gate_buffer.len() < buffer_size {
            self.gate_buffer.resize(buffer_size, 0.0);
        }
        for v in self.gate_buffer.iter_mut().take(buffer_size) {
            *v = 0.0;
        }
        if let Some(sources) = inputs.get(&PortId::Gate) {
            for source in sources {
                for (i, &src) in source.buffer.iter().enumerate().take(buffer_size) {
                    self.gate_buffer[i] += src * source.amount;
                }
            }
        }

        // --- 3) Base frequency (from GlobalFrequency or default) ---
        let base_freq = if let Some(freq_sources) = inputs.get(&PortId::GlobalFrequency) {
            if !freq_sources.is_empty() && !freq_sources[0].buffer.is_empty() {
                freq_sources[0].buffer.clone()
            } else {
                vec![self.frequency; buffer_size]
            }
        } else {
            vec![self.frequency; buffer_size]
        };

        // --- 4) Get the active wavetable collection ---
        let collection = get_collection_from_bank(&self.wavetable_bank, &self.collection_name);

        // --- 5) Prepare oversampled buffer ---
        let os_factor = self.oversample_factor;
        let oversampled_len = buffer_size * os_factor;
        let mut oversampled_buffer = vec![0.0_f32; oversampled_len];

        // --- 6) Main synthesis loop ---
        for i in 0..buffer_size {
            // Check for hard sync via the gate.
            let gate_val = self.gate_buffer[i];
            self.check_gate(gate_val);

            // Get per-sample modulation values.
            let freq_sample = base_freq[i];
            let phase_mod_sample = phase_mod[i];
            let gain_mod_sample = gain_mod[i]; // Now used per sub-sample below.
            let feedback_mod_sample = feedback_mod[i];
            let wavetable_index_sample = wavetable_index_mod[i];
            let mod_index_sample = mod_index[i];

            // Compute external phase modulation (applied once per sample).
            let ext_phase = (phase_mod_sample * mod_index_sample) / (2.0 * std::f32::consts::PI);
            // Compute feedback (applied once per sample).
            let fb = (self.last_output * self.feedback_amount * feedback_mod_sample)
                / (std::f32::consts::PI * 1.5);

            // For each oversampled sub-sample within this sample:
            for os in 0..os_factor {
                let mut sample_sum = 0.0;
                let mut total_weight = 0.0;

                // Sum contributions from all unison voices.
                for voice in 0..self.unison_voices {
                    let voice_f = voice as f32;
                    let center_index = (self.unison_voices as f32 - 1.0) / 2.0;
                    let sigma = self.unison_voices as f32 / 4.0;
                    let weight =
                        (-((voice_f - center_index).powi(2)) / (2.0 * sigma * sigma)).exp();
                    total_weight += weight;

                    // Compute detune for this voice.
                    let voice_offset = if self.unison_voices > 1 {
                        self.spread * (2.0 * (voice_f / ((self.unison_voices - 1) as f32)) - 1.0)
                    } else {
                        0.0
                    };
                    let total_detune = self.detune + voice_offset;
                    let detuned_freq = freq_sample * 2.0_f32.powf(total_detune / 1200.0);
                    let effective_freq = detuned_freq * freq_mod[i];
                    let phase_inc = effective_freq / self.sample_rate;
                    let dt_os = phase_inc / os_factor as f32;

                    // Use the stored phase for this voice (without mod offsets).
                    let start_phase = self.voice_phases[voice];
                    // Compute sub-sample phase:
                    let sub_phase =
                        (start_phase + ext_phase + fb + dt_os * (os as f32)).rem_euclid(1.0);
                    let wv_sample = collection.lookup_sample(sub_phase, wavetable_index_sample);
                    sample_sum += wv_sample * weight;
                }
                // Apply gain modulation per sub-sample and store.
                oversampled_buffer[i * os_factor + os] = sample_sum * gain_mod_sample;
            }

            // Update each voice’s stored phase (without including external mod or feedback).
            for voice in 0..self.unison_voices {
                let voice_offset = if self.unison_voices > 1 {
                    self.spread * (2.0 * (voice as f32 / ((self.unison_voices - 1) as f32)) - 1.0)
                } else {
                    0.0
                };
                let total_detune = self.detune + voice_offset;
                let detuned_freq = freq_sample * 2.0_f32.powf(total_detune / 1200.0);
                let effective_freq = detuned_freq * freq_mod[i];
                let phase_inc = effective_freq / self.sample_rate;
                self.voice_phases[voice] = (self.voice_phases[voice] + phase_inc).rem_euclid(1.0);
            }
            // (We could update self.last_output later during decimation.)
        }

        // --- 7) Filter the oversampled buffer (using persistent filter state) ---
        simple_lowpass_filter_in_place(
            &mut oversampled_buffer,
            os_factor,
            self.sample_rate,
            &mut self.filter_prev,
        );

        // --- 8) Decimate oversampled buffer to produce final output ---
        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            for i in 0..buffer_size {
                // Here we use a simple decimation: take the first sub-sample of each block.
                let sample = oversampled_buffer[i * os_factor];
                // Recompute total unison weight.
                let center_index = (self.unison_voices as f32 - 1.0) / 2.0;
                let sigma = self.unison_voices as f32 / 4.0;
                let mut total_weight = 0.0;
                for voice in 0..self.unison_voices {
                    let voice_f = voice as f32;
                    let weight =
                        (-((voice_f - center_index).powi(2)) / (2.0 * sigma * sigma)).exp();
                    total_weight += weight;
                }
                let final_sample = (sample / total_weight) * self.gain;
                output[i] = final_sample;
                self.last_output = final_sample;
            }
        }
    }

    fn reset(&mut self) {
        self.last_output = 0.0;
        self.last_gate_value = 0.0;
        for phase in self.voice_phases.iter_mut() {
            *phase = 0.0;
        }
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn is_active(&self) -> bool {
        self.active
    }

    fn set_active(&mut self, active: bool) {
        self.active = active;
    }

    fn node_type(&self) -> &str {
        "wavetable_oscillator"
    }
}
