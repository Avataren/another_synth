use std::any::Any;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

// These are assumed to be defined elsewhere in your codebase:
use crate::graph::{ModulationProcessor, ModulationSource};
use crate::{AudioNode, PortId};

use super::morph_wavetable::{WavetableMorphCollection, WavetableSynthBank};

use std::f32::consts::PI;

/// A helper sinc function.
fn sinc(x: f32) -> f32 {
    if x.abs() < 1e-6 {
        1.0
    } else {
        x.sin() / x
    }
}

/// A FIR lowpass filter based on a windowed-sinc design.
/// This filter maintains an internal delay line (state) so that it can process data in blocks.
pub struct FIRFilter {
    coeffs: Vec<f32>,
    delay_line: Vec<f32>, // Holds the last (N-1) samples from the previous block.
}

impl FIRFilter {
    /// Create a new FIR lowpass filter.
    ///
    /// * `num_taps` - Number of filter taps (e.g. 64).
    /// * `oversample_factor` - The oversampling factor.
    ///
    /// The cutoff is chosen such that (in Hz) it is near 0.45× the base sample rate.
    /// In the oversampled domain (sample_rate * oversample_factor), the normalized cutoff is:
    /// f_c = (0.45 * sample_rate) / (sample_rate * oversample_factor/2) = 0.9 / oversample_factor.
    pub fn new(num_taps: usize, oversample_factor: usize) -> Self {
        // Compute normalized cutoff frequency (cycles/sample, with Nyquist = 0.5).
        let f_c = (0.9 / oversample_factor as f32).min(0.5);
        let center = (num_taps - 1) as f32 / 2.0;
        let mut coeffs = Vec::with_capacity(num_taps);
        for n in 0..num_taps {
            let n_f = n as f32;
            let x = n_f - center;
            // Ideal lowpass impulse response (sinc) with cutoff f_c.
            let ideal = if x == 0.0 {
                2.0 * f_c
            } else {
                2.0 * f_c * sinc(2.0 * PI * f_c * x)
            };
            // Hamming window
            let window = 0.54 - 0.46 * ((2.0 * PI * n_f) / ((num_taps - 1) as f32)).cos();
            coeffs.push(ideal * window);
        }
        // Normalize coefficients so that their sum is 1.0.
        let sum: f32 = coeffs.iter().sum();
        for coef in coeffs.iter_mut() {
            *coef /= sum;
        }
        Self {
            coeffs,
            delay_line: vec![0.0; num_taps - 1],
        }
    }

    /// Process a block of input samples.
    /// This method applies the FIR filter on the input block while preserving state across blocks.
    pub fn process_block(&mut self, input: &[f32]) -> Vec<f32> {
        let num_taps = self.coeffs.len();
        let mut output = Vec::with_capacity(input.len());

        // Create an extended buffer by prepending the previous delay_line.
        let mut extended = self.delay_line.clone();
        extended.extend_from_slice(input);

        // Convolve the filter kernel with the extended input.
        for i in 0..input.len() {
            let mut y = 0.0;
            for j in 0..num_taps {
                y += self.coeffs[j] * extended[i + j];
            }
            output.push(y);
        }
        // Update delay_line with the last (num_taps - 1) samples of the extended buffer.
        let new_delay_start = extended.len() - (num_taps - 1);
        self.delay_line
            .copy_from_slice(&extended[new_delay_start..]);
        output
    }
}

/// A state update message for the oscillator.
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
    /// FIR filter for anti-aliasing when decimating oversampled data.
    fir_filter: FIRFilter,
}

impl ModulationProcessor for WavetableOscillator {}

impl WavetableOscillator {
    /// Create a new oscillator.
    /// - `sample_rate`: audio sample rate.
    /// - `bank`: the wavetable synth bank (passed by value).
    /// - The FIR filter is initialized with a chosen number of taps.
    pub fn new(sample_rate: f32, bank: Rc<RefCell<WavetableSynthBank>>) -> Self {
        let oversample_factor = 4; // For example, 4× oversampling.
        let num_taps = 32; // Choose a filter length (more taps → sharper cutoff).
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
            oversample_factor,
            fir_filter: FIRFilter::new(num_taps, oversample_factor),
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
            let ext_phase = (phase_mod_sample * mod_index_sample) / (2.0 * PI);
            // Compute feedback (applied once per sample).
            let fb = (self.last_output * self.feedback_amount * feedback_mod_sample) / (PI * 1.5);

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

        // --- 7) Filter the oversampled buffer using the high-quality FIR filter ---
        let filtered_oversampled = self.fir_filter.process_block(&oversampled_buffer);

        // --- 8) Decimate oversampled buffer to produce final output ---
        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            for i in 0..buffer_size {
                // Here we decimate by taking the first sub-sample of each block.
                let sample = filtered_oversampled[i * os_factor];
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
        // Optionally, clear the FIR filter delay line:
        self.fir_filter.delay_line.fill(0.0);
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
