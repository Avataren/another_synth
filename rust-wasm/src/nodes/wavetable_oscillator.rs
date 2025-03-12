// wavetable_oscillator.rs
use std::any::Any;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::simd::{f32x4, Simd};
use wasm_bindgen::prelude::*;

use crate::graph::{ModulationProcessor, ModulationSource};
use crate::{AudioNode, PortId};

use super::morph_wavetable::{WavetableMorphCollection, WavetableSynthBank};

use std::f32::consts::PI;

#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct WavetableOscillatorStateUpdate {
    pub phase_mod_amount: f32,
    pub detune: f32, // In cents
    pub hard_sync: bool,
    pub gain: f32,
    pub active: bool,
    pub feedback_amount: f32,
    pub unison_voices: u32,
    pub spread: f32,
    pub wavetable_index: f32,
}

#[wasm_bindgen]
impl WavetableOscillatorStateUpdate {
    #[wasm_bindgen(constructor)]
    pub fn new(
        phase_mod_amount: f32,
        detune: f32, // In cents
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

pub struct WavetableOscillator {
    sample_rate: f32,
    gain: f32,
    active: bool,
    feedback_amount: f32,
    last_output: f32,
    hard_sync: bool,
    last_gate_value: f32,
    frequency: f32,
    gate_buffer: Vec<f32>,
    // Modulation parameters.
    phase_mod_amount: f32,
    detune: f32, // In cents
    // Unison parameters.
    unison_voices: usize,
    spread: f32,
    voice_phases: Vec<f32>,
    // Avoid reallocation with cached vectors
    voice_weights: Vec<f32>,
    voice_offsets: Vec<f32>,
    // Morph parameter.
    wavetable_index: f32,
    // Name of the morph collection to use.
    collection_name: String,
    // The bank of wavetable morph collections.
    wavetable_bank: Rc<RefCell<WavetableSynthBank>>,
    // Constants precalculated
    two_pi: f32,
    feedback_divisor: f32,
    cent_ratio: f32,     // 2^(1/1200) for cents calculation
    semitone_ratio: f32, // 2^(1/12) for semitone calculation
}

impl ModulationProcessor for WavetableOscillator {}

impl WavetableOscillator {
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
            gate_buffer: Vec::with_capacity(1024),
            phase_mod_amount: 0.0,
            detune: 0.0, // In cents
            unison_voices: 1,
            spread: 0.1,
            voice_phases: vec![0.0; 1],
            voice_weights: Vec::with_capacity(16),
            voice_offsets: Vec::with_capacity(16),
            wavetable_index: 0.0,
            collection_name: "default".to_string(),
            wavetable_bank: bank,
            two_pi: 2.0 * PI,
            feedback_divisor: PI * 1.5,
            cent_ratio: 2.0_f32.powf(1.0 / 1200.0),
            semitone_ratio: 2.0_f32.powf(1.0 / 12.0),
        }
    }

    pub fn set_current_wavetable(&mut self, collection_name: &str) {
        self.collection_name = collection_name.to_string();
    }

    pub fn update_params(&mut self, params: &WavetableOscillatorStateUpdate) {
        self.gain = params.gain;
        self.feedback_amount = params.feedback_amount;
        self.hard_sync = params.hard_sync;
        self.active = params.active;
        self.phase_mod_amount = params.phase_mod_amount;
        self.detune = params.detune; // In cents
        self.spread = params.spread;
        self.wavetable_index = params.wavetable_index;
        let new_voice_count = if params.unison_voices == 0 {
            1
        } else {
            params.unison_voices as usize
        };
        if new_voice_count != self.unison_voices {
            self.unison_voices = new_voice_count;
            // Reuse the first phase when changing voice count
            let first_phase = self.voice_phases[0];
            self.voice_phases.resize(new_voice_count, first_phase);

            // Pre-calculate voice weights and offsets since they only change when unison voice count changes
            self.update_voice_unison_values();
        }
    }

    fn update_voice_unison_values(&mut self) {
        self.voice_weights.clear();
        self.voice_offsets.clear();

        let center_index = (self.unison_voices as f32 - 1.0) / 2.0;
        let sigma = self.unison_voices as f32 / 4.0;
        let sigma_2x = 2.0 * sigma * sigma;

        for voice in 0..self.unison_voices {
            let voice_f = voice as f32;
            // Gaussian distribution for weights
            let weight = (-((voice_f - center_index).powi(2)) / sigma_2x).exp();
            self.voice_weights.push(weight);

            // Calculate stereo spread offsets
            let offset = if self.unison_voices > 1 {
                self.spread * (2.0 * (voice_f / ((self.unison_voices - 1) as f32)) - 1.0)
            } else {
                0.0
            };
            self.voice_offsets.push(offset);
        }
    }

    #[inline(always)]
    fn check_gate(&mut self, gate: f32) {
        if self.hard_sync && gate > 0.0 && self.last_gate_value <= 0.0 {
            for phase in self.voice_phases.iter_mut() {
                *phase = 0.0;
            }
        }
        self.last_gate_value = gate;
    }

    #[inline(always)]
    fn process_modulation_simd(
        &self,
        buffer_size: usize,
        base: f32,
        additive: &[f32],
        multiplicative: &[f32],
    ) -> Vec<f32> {
        let mut result = Vec::with_capacity(buffer_size);
        let base_simd = Simd::splat(base);

        // Process in chunks of 4
        let chunks = buffer_size / 4;
        for c in 0..chunks {
            let i = c * 4;
            let add_simd = f32x4::from_slice(&additive[i..i + 4]);
            let mul_simd = f32x4::from_slice(&multiplicative[i..i + 4]);

            // (base + add) * mul
            let combined = (base_simd + add_simd) * mul_simd;

            // Store results
            let mut arr = [0.0f32; 4];
            combined.copy_to_slice(&mut arr);
            result.extend_from_slice(&arr);
        }

        // Handle remaining elements
        for i in (chunks * 4)..buffer_size {
            result.push((base + additive[i]) * multiplicative[i]);
        }

        result
    }
}

fn get_collection_from_bank(
    bank: &RefCell<WavetableSynthBank>,
    name: &str,
) -> Rc<WavetableMorphCollection> {
    // Borrow the bank once and use result
    let borrowed = bank.borrow();
    borrowed
        .get_collection(name)
        .unwrap_or_else(|| panic!("Wavetable collection '{}' not found", name))
}

impl AudioNode for WavetableOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::GlobalFrequency, false);
        ports.insert(PortId::FrequencyMod, false);
        ports.insert(PortId::PhaseMod, false);
        ports.insert(PortId::ModIndex, false);
        ports.insert(PortId::WavetableIndex, false);
        ports.insert(PortId::GainMod, false);
        ports.insert(PortId::FeedbackMod, false);
        ports.insert(PortId::AudioOutput0, true);
        ports.insert(PortId::DetuneMod, true);
        ports.insert(PortId::Gate, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Early exit if inactive
        if !self.active {
            if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
                output.iter_mut().take(buffer_size).for_each(|x| *x = 0.0);
            }
            return;
        }

        // --- 1) Process modulations using process_modulations_ex ---
        let freq_mod_result =
            self.process_modulations_ex(buffer_size, inputs.get(&PortId::FrequencyMod));
        let phase_mod_result =
            self.process_modulations_ex(buffer_size, inputs.get(&PortId::PhaseMod));
        let gain_mod_result =
            self.process_modulations_ex(buffer_size, inputs.get(&PortId::GainMod));
        let feedback_mod_result =
            self.process_modulations_ex(buffer_size, inputs.get(&PortId::FeedbackMod));
        let mod_index_result =
            self.process_modulations_ex(buffer_size, inputs.get(&PortId::ModIndex));
        let wavetable_index_mod_result =
            self.process_modulations_ex(buffer_size, inputs.get(&PortId::WavetableIndex));
        let detune_mod_result =
            self.process_modulations_ex(buffer_size, inputs.get(&PortId::DetuneMod));

        // Use SIMD-optimized modulation processing
        // For frequency modulation, we'll handle the additive and multiplicative components separately
        let freq_mod_add = freq_mod_result.additive.clone();
        let freq_mod_mul = freq_mod_result.multiplicative.clone();

        let phase_mod = self.process_modulation_simd(
            buffer_size,
            0.0,
            &phase_mod_result.additive,
            &phase_mod_result.multiplicative,
        );

        let gain_mod = self.process_modulation_simd(
            buffer_size,
            1.0,
            &gain_mod_result.additive,
            &gain_mod_result.multiplicative,
        );

        // Fix for feedback modulation
        let feedback_mod = self.process_modulation_simd(
            buffer_size,
            self.feedback_amount,
            &feedback_mod_result.additive,
            &feedback_mod_result.multiplicative,
        );

        let mod_index = self.process_modulation_simd(
            buffer_size,
            self.phase_mod_amount,
            &mod_index_result.additive,
            &mod_index_result.multiplicative,
        );

        let wavetable_index_mod = self.process_modulation_simd(
            buffer_size,
            self.wavetable_index,
            &wavetable_index_mod_result.additive,
            &wavetable_index_mod_result.multiplicative,
        );

        let detune_mod = self.process_modulation_simd(
            buffer_size,
            0.0, // Base for detune mod is 0.0 semitones (property is separate)
            &detune_mod_result.additive,
            &detune_mod_result.multiplicative,
        );

        // --- 2) Prepare gate buffer ---
        if self.gate_buffer.len() < buffer_size {
            self.gate_buffer.resize(buffer_size, 0.0);
        } else {
            self.gate_buffer
                .iter_mut()
                .take(buffer_size)
                .for_each(|v| *v = 0.0);
        }

        if let Some(sources) = inputs.get(&PortId::Gate) {
            for source in sources {
                // SIMD processing for gate buffer
                let chunks = std::cmp::min(buffer_size, source.buffer.len()) / 4;
                let amount_simd = Simd::splat(source.amount);

                for c in 0..chunks {
                    let i = c * 4;
                    // Load gate and source values
                    let mut gate_values = [0.0f32; 4];
                    gate_values.copy_from_slice(&self.gate_buffer[i..i + 4]);
                    let gate_simd = f32x4::from_slice(&gate_values);

                    let src_simd = f32x4::from_slice(&source.buffer[i..i + 4]);
                    let result = gate_simd + (src_simd * amount_simd);

                    // Store results back
                    result.copy_to_slice(&mut self.gate_buffer[i..i + 4]);
                }

                // Handle remaining elements
                for i in (chunks * 4)..std::cmp::min(buffer_size, source.buffer.len()) {
                    self.gate_buffer[i] += source.buffer[i] * source.amount;
                }
            }
        }

        // --- 3) Base frequency (from GlobalFrequency or default) ---
        let mut base_freq = if let Some(freq_sources) = inputs.get(&PortId::GlobalFrequency) {
            if !freq_sources.is_empty() && !freq_sources[0].buffer.is_empty() {
                freq_sources[0].buffer.clone()
            } else {
                vec![self.frequency; buffer_size]
            }
        } else {
            vec![self.frequency; buffer_size]
        };

        // --- 4) Get the active mipmapped wavetable collection ---
        let collection = get_collection_from_bank(&self.wavetable_bank, &self.collection_name);

        // Ensure unison values are updated
        if self.voice_weights.len() != self.unison_voices {
            self.update_voice_unison_values();
        }

        // Calculate total weight once upfront
        let total_weight: f32 = self.voice_weights.iter().sum();
        let total_weight_recip = 1.0 / total_weight;

        // Get output buffer or return early
        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buffer) => buffer,
            None => return,
        };

        // Calculate lookup values for all samples in advance when possible
        let sample_rate_recip = 1.0 / self.sample_rate;

        // Precalculate cents factor for the detune property (in cents)
        let cents_factor = self.cent_ratio.powf(self.detune);

        // --- 6) Main synthesis loop ---
        for i in 0..buffer_size {
            // Check for hard sync via the gate.
            self.check_gate(self.gate_buffer[i]);

            // Per-sample modulation values
            let wavetable_index_sample = wavetable_index_mod[i].clamp(0.0, 1.0); // Clamp to valid range

            // Compute external phase modulation and feedback
            let ext_phase = (phase_mod[i] * mod_index[i]) / self.two_pi;

            // Use the modulated feedback value directly
            let fb = (self.last_output * feedback_mod[i]) / self.feedback_divisor;

            // Apply frequency modulation to base frequency
            // First add the additive component
            let modulated_freq = base_freq[i] + freq_mod_add[i];
            // Then multiply by the multiplicative component
            let modulated_freq = modulated_freq * freq_mod_mul[i];

            let mut sample_sum = 0.0;

            // Sum contributions from all unison voices
            for voice in 0..self.unison_voices {
                let weight = self.voice_weights[voice];

                // Apply cents-based detune from property
                let freq_with_cents = modulated_freq * cents_factor;

                // Apply semitone-based detune from modulation and voice spread
                let voice_detune_semitones = detune_mod[i] + self.voice_offsets[voice];
                let semitones_factor = self.semitone_ratio.powf(voice_detune_semitones);
                let effective_freq = freq_with_cents * semitones_factor;

                // Compute current phase (including external modulation and feedback)
                let phase = (self.voice_phases[voice] + ext_phase + fb).rem_euclid(1.0);

                // Lookup sample from the wavetable
                let wv_sample =
                    collection.lookup_sample(phase, wavetable_index_sample, effective_freq);
                sample_sum += wv_sample * weight;

                // Update voice phase using precalculated phase increment
                let phase_inc = effective_freq * sample_rate_recip;
                self.voice_phases[voice] = (self.voice_phases[voice] + phase_inc).rem_euclid(1.0);
            }

            // Apply total weight scaling, gain, and gain modulation
            let final_sample = (sample_sum * total_weight_recip) * self.gain * gain_mod[i];
            output_buffer[i] = final_sample;
            self.last_output = final_sample;
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
