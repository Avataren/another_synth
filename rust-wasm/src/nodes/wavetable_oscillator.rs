use std::any::Any;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::simd::{f32x4, Simd};
use wasm_bindgen::prelude::*;
use web_sys::console;

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
    // Cached vectors to avoid reallocation
    voice_weights: Vec<f32>,
    voice_offsets: Vec<f32>,
    // Morph parameter.
    wavetable_index: f32,
    // Name of the morph collection to use.
    collection_name: String,
    // The bank of wavetable morph collections.
    wavetable_bank: Rc<RefCell<WavetableSynthBank>>,
    // Precalculated constants.
    two_pi: f32,
    feedback_divisor: f32,
    cent_ratio: f32,     // 2^(1/1200)
    semitone_ratio: f32, // 2^(1/12)
    // === Scratch buffers to avoid repeated allocations in process ===
    scratch_phase_mod: Vec<f32>,
    scratch_gain_mod: Vec<f32>,
    scratch_feedback_mod: Vec<f32>,
    scratch_mod_index: Vec<f32>,
    scratch_wavetable_index: Vec<f32>,
    scratch_detune_mod: Vec<f32>,
    scratch_freq: Vec<f32>,
}

impl ModulationProcessor for WavetableOscillator {}

impl WavetableOscillator {
    pub fn new(sample_rate: f32, bank: Rc<RefCell<WavetableSynthBank>>) -> Self {
        let initial_capacity = 128;
        Self {
            sample_rate,
            gain: 1.0,
            active: true,
            feedback_amount: 0.0,
            last_output: 0.0,
            hard_sync: false,
            last_gate_value: 0.0,
            frequency: 440.0,
            gate_buffer: vec![0.0; initial_capacity],
            phase_mod_amount: 0.0,
            detune: 0.0,
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
            scratch_phase_mod: vec![0.0; initial_capacity],
            scratch_gain_mod: vec![0.0; initial_capacity],
            scratch_feedback_mod: vec![0.0; initial_capacity],
            scratch_mod_index: vec![0.0; initial_capacity],
            scratch_wavetable_index: vec![0.0; initial_capacity],
            scratch_detune_mod: vec![0.0; initial_capacity],
            scratch_freq: vec![440.0; initial_capacity],
        }
    }

    /// Ensure that the given scratch buffer has at least `size` elements.
    /// If already large enough, the first `size` elements are set to `default_val`.
    fn ensure_buffer(buf: &mut Vec<f32>, size: usize, default_val: f32) {
        if buf.len() < size {
            console::log_1(&format!("Resizing buffer from {} to {}", buf.len(), size).into());
            buf.resize(size, default_val);
        } else {
            buf[..size].fill(default_val);
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
            if self.spread == 0.0 {
                self.voice_phases = vec![0.0; new_voice_count];
            } else {
                self.voice_phases = (0..new_voice_count)
                    .map(|i| i as f32 / new_voice_count as f32)
                    .collect();
            }
        } else if self.spread == 0.0 {
            let common_phase = self.voice_phases[0];
            for phase in self.voice_phases.iter_mut() {
                *phase = common_phase;
            }
        }
        self.update_voice_unison_values();
    }

    fn update_voice_unison_values(&mut self) {
        self.voice_weights.clear();
        self.voice_offsets.clear();

        for voice in 0..self.unison_voices {
            self.voice_weights.push(1.0);
            let voice_f = voice as f32;
            let offset = if self.unison_voices > 1 {
                self.spread * (2.0 * (voice_f / ((self.unison_voices - 1) as f32)) - 1.0)
            } else {
                0.0
            };
            self.voice_offsets.push(offset * 0.01);
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
    fn process_modulation_simd_in_place(
        output: &mut [f32],
        base: f32,
        additive: &[f32],
        multiplicative: &[f32],
    ) {
        let len = output.len();
        let base_simd = f32x4::splat(base);
        let chunks = len / 4;
        for c in 0..chunks {
            let idx = c * 4;
            let add_simd = f32x4::from_slice(&additive[idx..idx + 4]);
            let mul_simd = f32x4::from_slice(&multiplicative[idx..idx + 4]);
            let combined = (base_simd + add_simd) * mul_simd;
            combined.copy_to_slice(&mut output[idx..idx + 4]);
        }
        for i in (chunks * 4)..len {
            output[i] = (base + additive[i]) * multiplicative[i];
        }
    }
}

fn get_collection_from_bank(
    bank: &RefCell<WavetableSynthBank>,
    name: &str,
) -> Rc<WavetableMorphCollection> {
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
        ports.insert(PortId::GlobalGate, false);
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

        // --- 1) Process modulations ---
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

        {
            // --- 2) Prepare scratch buffers and update them within this inner scope.
            // Self::ensure_buffer(&mut self.scratch_phase_mod, buffer_size, 0.0);
            // Self::ensure_buffer(&mut self.scratch_gain_mod, buffer_size, 1.0);
            // Self::ensure_buffer(
            //     &mut self.scratch_feedback_mod,
            //     buffer_size,
            //     self.feedback_amount,
            // );
            // Self::ensure_buffer(
            //     &mut self.scratch_mod_index,
            //     buffer_size,
            //     self.phase_mod_amount,
            // );
            // Self::ensure_buffer(
            //     &mut self.scratch_wavetable_index,
            //     buffer_size,
            //     self.wavetable_index,
            // );
            // Self::ensure_buffer(&mut self.scratch_detune_mod, buffer_size, 0.0);
            // Self::ensure_buffer(&mut self.gate_buffer, buffer_size, 0.0);
            // Self::ensure_buffer(&mut self.scratch_freq, buffer_size, self.frequency);

            Self::process_modulation_simd_in_place(
                &mut self.scratch_phase_mod[..buffer_size],
                0.0,
                &phase_mod_result.additive,
                &phase_mod_result.multiplicative,
            );
            Self::process_modulation_simd_in_place(
                &mut self.scratch_gain_mod[..buffer_size],
                1.0,
                &gain_mod_result.additive,
                &gain_mod_result.multiplicative,
            );
            Self::process_modulation_simd_in_place(
                &mut self.scratch_feedback_mod[..buffer_size],
                self.feedback_amount,
                &feedback_mod_result.additive,
                &feedback_mod_result.multiplicative,
            );
            Self::process_modulation_simd_in_place(
                &mut self.scratch_mod_index[..buffer_size],
                self.phase_mod_amount,
                &mod_index_result.additive,
                &mod_index_result.multiplicative,
            );
            Self::process_modulation_simd_in_place(
                &mut self.scratch_wavetable_index[..buffer_size],
                self.wavetable_index,
                &wavetable_index_mod_result.additive,
                &wavetable_index_mod_result.multiplicative,
            );
            Self::process_modulation_simd_in_place(
                &mut self.scratch_detune_mod[..buffer_size],
                0.0,
                &detune_mod_result.additive,
                &detune_mod_result.multiplicative,
            );

            if let Some(sources) = inputs.get(&PortId::GlobalGate) {
                for source in sources {
                    let min_len = std::cmp::min(buffer_size, source.buffer.len());
                    let amount_simd = f32x4::splat(source.amount);
                    self.gate_buffer[..min_len]
                        .chunks_exact_mut(4)
                        .enumerate()
                        .for_each(|(i, chunk)| {
                            let idx = i * 4;
                            let src_chunk = &source.buffer[idx..idx + 4];
                            let gate_simd = f32x4::from_slice(chunk);
                            let src_simd = f32x4::from_slice(src_chunk);
                            let result = gate_simd + (src_simd * amount_simd);
                            result.copy_to_slice(chunk);
                        });
                    let remainder = min_len % 4;
                    let start = min_len - remainder;
                    for i in start..min_len {
                        self.gate_buffer[i] += source.buffer[i] * source.amount;
                    }
                }
            }

            if let Some(freq_sources) = inputs.get(&PortId::GlobalFrequency) {
                if !freq_sources.is_empty() && !freq_sources[0].buffer.is_empty() {
                    let src = &freq_sources[0].buffer;
                    let len = std::cmp::min(buffer_size, src.len());
                    self.scratch_freq[..len].copy_from_slice(&src[..len]);
                    if len < buffer_size {
                        self.scratch_freq[len..buffer_size].fill(self.frequency);
                    }
                } else {
                    self.scratch_freq[..buffer_size].fill(self.frequency);
                }
            } else {
                self.scratch_freq[..buffer_size].fill(self.frequency);
            }
        } // <-- End of inner scope; no mutable borrows are active now.

        // --- 3) Pre-loop updates ---
        if self.voice_weights.len() != self.unison_voices {
            self.update_voice_unison_values();
        }
        let total_weight: f32 = self.voice_weights.iter().sum();
        let total_weight_recip = 1.0 / total_weight;
        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buffer) => buffer,
            None => return,
        };
        let sample_rate_recip = 1.0 / self.sample_rate;
        let cents_factor = self.cent_ratio.powf(self.detune);
        let collection = get_collection_from_bank(&self.wavetable_bank, &self.collection_name);

        // --- 4) Main synthesis loop ---
        for i in 0..buffer_size {
            // Each field is accessed directly (creating only a temporary borrow), so there are no long-lived borrows.
            self.check_gate(self.gate_buffer[i]);
            let wavetable_index_sample = self.scratch_wavetable_index[i].clamp(0.0, 1.0);
            let ext_phase = (self.scratch_phase_mod[i] * self.scratch_mod_index[i]) / self.two_pi;
            let fb = (self.last_output * self.scratch_feedback_mod[i]) / self.feedback_divisor;
            let modulated_freq = (self.scratch_freq[i] + freq_mod_result.additive[i])
                * freq_mod_result.multiplicative[i];

            let mut sample_sum = 0.0;
            for voice in 0..self.unison_voices {
                let weight = self.voice_weights[voice];
                let freq_with_cents = modulated_freq * cents_factor;
                let voice_detune_semitones = self.scratch_detune_mod[i] + self.voice_offsets[voice];
                let semitones_factor = self.semitone_ratio.powf(voice_detune_semitones);
                let effective_freq = freq_with_cents * semitones_factor;
                let phase = (self.voice_phases[voice] + ext_phase + fb).rem_euclid(1.0);
                let wv_sample =
                    collection.lookup_sample(phase, wavetable_index_sample, effective_freq);
                sample_sum += wv_sample * weight;
                let phase_inc = effective_freq * sample_rate_recip;
                self.voice_phases[voice] = (self.voice_phases[voice] + phase_inc).rem_euclid(1.0);
            }

            let final_sample =
                (sample_sum * total_weight_recip) * self.gain * self.scratch_gain_mod[i];
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
