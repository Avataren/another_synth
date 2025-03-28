use rustfft::num_traits::Float;
use std::any::Any;
use std::cell::RefCell;
use std::collections::HashMap;
use std::f32::consts::{E, PI};
use std::rc::Rc;
use std::simd::{f32x4, LaneCount, Simd, SupportedLaneCount};
use wasm_bindgen::prelude::*;
use web_sys::console;

use crate::graph::{
    ModulationProcessor, ModulationSource, ModulationTransformation, ModulationType,
};
use crate::{AudioNode, PortId};

use super::morph_wavetable::{WavetableMorphCollection, WavetableSynthBank};

#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct WavetableOscillatorStateUpdate {
    pub phase_mod_amount: f32,
    pub detune: f32, // Base detune offset in cents
    pub hard_sync: bool,
    pub gain: f32,
    pub active: bool,
    pub feedback_amount: f32,
    pub unison_voices: u32,
    pub spread: f32, // Maximum total detuning width for unison voices, in cents
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
        spread: f32, // In cents (total width, e.g., 20 means +/- 10 cents)
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
    smoothing_coeff: f32,

    // Parameter Targets
    target_gain: f32,
    target_feedback_amount: f32,
    target_phase_mod_amount: f32,
    target_detune: f32, // Base detune offset in cents
    target_spread: f32, // Max total detuning width in cents
    target_wavetable_index: f32,
    target_frequency: f32,

    // Smoothed Parameters
    smoothed_gain: f32,
    smoothed_feedback_amount: f32,
    smoothed_phase_mod_amount: f32,
    smoothed_detune: f32, // Base detune offset in cents
    smoothed_spread: f32, // Max total detuning width in cents
    smoothed_wavetable_index: f32,
    smoothed_frequency: f32,

    // Core state (partially mirrored)
    gain: f32,
    active: bool,
    feedback_amount: f32,
    hard_sync: bool,
    last_gate_value: f32,
    frequency: f32,
    phase_mod_amount: f32,
    detune: f32, // Cents
    spread: f32, // Cents
    wavetable_index: f32,

    // Unison state
    unison_voices: usize,
    voice_phases: Vec<f32>,
    voice_last_outputs: Vec<f32>,
    voice_weights: Vec<f32>,
    voice_offsets: Vec<f32>, // Cached unison offsets relative to base detune, in SEMITONES

    // Wavetable data
    collection_name: String,
    wavetable_bank: Rc<RefCell<WavetableSynthBank>>,

    // Precalculated constants
    two_pi_recip: f32,
    feedback_divisor: f32,
    cent_ratio: f32,
    semitone_ratio: f32,
    sample_rate_recip: f32,

    // Scratch buffers
    mod_scratch_add: Vec<f32>,
    mod_scratch_mult: Vec<f32>,
    gate_buffer: Vec<f32>,
    scratch_freq: Vec<f32>,
    scratch_phase_mod: Vec<f32>,
    scratch_gain_mod: Vec<f32>,
    scratch_feedback_mod: Vec<f32>,
    scratch_mod_index: Vec<f32>,
    scratch_wavetable_index: Vec<f32>,
    scratch_detune_mod: Vec<f32>, // Modulation offset in SEMITONES
    global_freq_buffer: Vec<f32>,
}

impl ModulationProcessor for WavetableOscillator {}

impl WavetableOscillator {
    pub fn new(sample_rate: f32, bank: Rc<RefCell<WavetableSynthBank>>) -> Self {
        let initial_capacity = 128;
        let initial_frequency = 440.0;
        let initial_gain = 1.0;
        let initial_feedback = 0.0;
        let initial_phase_mod = 0.0;
        let initial_detune = 0.0; // Cents
        let initial_spread = 10.0; // Cents (e.g., +/- 5 cents range)
        let initial_wt_index = 0.0;
        let max_spread_cents = 100.0; // Limit total spread to 1 semitone

        let smoothing_time_ms = 5.0;
        let smoothing_time_samples = sample_rate * (smoothing_time_ms / 1000.0);
        let smoothing_coeff = if smoothing_time_samples > 0.0 {
            1.0 - (-1.0 / smoothing_time_samples).exp()
        } else {
            1.0
        };

        Self {
            sample_rate,
            smoothing_coeff,

            target_gain: initial_gain,
            target_feedback_amount: initial_feedback,
            target_phase_mod_amount: initial_phase_mod,
            target_detune: initial_detune,
            target_spread: initial_spread.clamp(0.0, max_spread_cents),
            target_wavetable_index: initial_wt_index,
            target_frequency: initial_frequency,

            smoothed_gain: initial_gain,
            smoothed_feedback_amount: initial_feedback,
            smoothed_phase_mod_amount: initial_phase_mod,
            smoothed_detune: initial_detune,
            smoothed_spread: initial_spread.clamp(0.0, max_spread_cents),
            smoothed_wavetable_index: initial_wt_index,
            smoothed_frequency: initial_frequency,

            gain: initial_gain,
            active: true,
            feedback_amount: initial_feedback,
            hard_sync: false,
            last_gate_value: 0.0,
            frequency: initial_frequency,
            phase_mod_amount: initial_phase_mod,
            detune: initial_detune,
            spread: initial_spread.clamp(0.0, max_spread_cents),
            wavetable_index: initial_wt_index,

            unison_voices: 1,
            voice_phases: vec![0.0; 1],
            voice_last_outputs: vec![0.0; 1],
            voice_weights: Vec::with_capacity(16),
            voice_offsets: Vec::with_capacity(16), // Calculated as semitones

            collection_name: "default".to_string(),
            wavetable_bank: bank,

            two_pi_recip: 1.0 / (PI * 2.0),
            feedback_divisor: PI * 1.5,
            cent_ratio: 2.0_f32.powf(1.0 / 1200.0),
            semitone_ratio: 2.0_f32.powf(1.0 / 12.0),
            sample_rate_recip: 1.0 / sample_rate,

            mod_scratch_add: vec![0.0; initial_capacity],
            mod_scratch_mult: vec![1.0; initial_capacity],
            gate_buffer: vec![0.0; initial_capacity],
            scratch_freq: vec![initial_frequency; initial_capacity],
            scratch_phase_mod: vec![0.0; initial_capacity],
            scratch_gain_mod: vec![initial_gain; initial_capacity],
            scratch_feedback_mod: vec![initial_feedback; initial_capacity],
            scratch_mod_index: vec![initial_phase_mod; initial_capacity],
            scratch_wavetable_index: vec![initial_wt_index; initial_capacity],
            scratch_detune_mod: vec![0.0; initial_capacity], // Semitones modulation
            global_freq_buffer: vec![initial_frequency; initial_capacity],
        }
    }

    fn ensure_scratch_buffers(&mut self, size: usize) {
        let mut resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
            if buf.len() < size {
                buf.resize(size, default_val);
            }
        };

        resize_if_needed(&mut self.mod_scratch_add, 0.0);
        resize_if_needed(&mut self.mod_scratch_mult, 1.0);
        resize_if_needed(&mut self.gate_buffer, 0.0);
        resize_if_needed(&mut self.scratch_freq, self.smoothed_frequency);
        resize_if_needed(&mut self.scratch_phase_mod, 0.0);
        resize_if_needed(&mut self.scratch_gain_mod, self.smoothed_gain);
        resize_if_needed(
            &mut self.scratch_feedback_mod,
            self.smoothed_feedback_amount,
        );
        resize_if_needed(&mut self.scratch_mod_index, self.smoothed_phase_mod_amount);
        resize_if_needed(
            &mut self.scratch_wavetable_index,
            self.smoothed_wavetable_index,
        );
        resize_if_needed(&mut self.scratch_detune_mod, 0.0); // Default detune mod is 0 semitones
        resize_if_needed(&mut self.global_freq_buffer, self.smoothed_frequency);
    }

    pub fn set_current_wavetable(&mut self, collection_name: &str) {
        self.collection_name = collection_name.to_string();
    }

    pub fn update_params(&mut self, params: &WavetableOscillatorStateUpdate) {
        self.target_gain = params.gain;
        self.target_feedback_amount = params.feedback_amount;
        self.target_phase_mod_amount = params.phase_mod_amount;
        self.target_detune = params.detune; // Base detune in cents

        // Spread is max total width in cents, clamp it reasonably (e.g., 0-100 cents = 1 semitone)
        let max_spread_cents = 100.0;
        self.target_spread = params.spread.clamp(0.0, max_spread_cents);
        self.target_wavetable_index = params.wavetable_index;

        self.hard_sync = params.hard_sync;
        self.active = params.active;

        let new_voice_count = if params.unison_voices == 0 {
            1
        } else {
            params.unison_voices as usize
        };
        if new_voice_count != self.unison_voices {
            self.unison_voices = new_voice_count;
            self.voice_phases.resize(new_voice_count, 0.0);
            self.voice_last_outputs.resize(new_voice_count, 0.0);
            self.voice_weights.reserve(new_voice_count);
            self.voice_offsets.reserve(new_voice_count);
            self.update_voice_unison_values(self.target_spread); // Update immediately on resize
        }
    }

    // Calculates unison offsets in SEMITONES based on current spread (total width in CENTS)
    fn update_voice_unison_values(&mut self, current_spread_cents: f32) {
        self.voice_weights.clear();
        self.voice_offsets.clear();
        let num_voices = self.unison_voices;
        let half_spread_cents = current_spread_cents / 2.0;

        for voice in 0..num_voices {
            self.voice_weights.push(1.0); // Equal weight for now

            let offset_semitones = if num_voices > 1 {
                let normalized_pos_sym = (voice as f32 / (num_voices - 1) as f32) * 2.0 - 1.0;
                let offset_cents = normalized_pos_sym * half_spread_cents;
                offset_cents / 100.0
            } else {
                0.0
            };
            self.voice_offsets.push(offset_semitones);
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
}

#[inline(always)]
fn get_collection_from_bank<'a>(
    bank: &'a RefCell<WavetableSynthBank>,
    name: &str,
) -> Rc<WavetableMorphCollection> {
    let borrowed_bank = bank.borrow();
    borrowed_bank
        .get_collection(name)
        .unwrap_or_else(|| panic!("Wavetable collection '{}' not found", name))
        .clone()
}

impl AudioNode for WavetableOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        [
            (PortId::GlobalFrequency, false),
            (PortId::FrequencyMod, false),
            (PortId::PhaseMod, false),
            (PortId::ModIndex, false),
            (PortId::WavetableIndex, false),
            (PortId::GainMod, false),
            (PortId::FeedbackMod, false),
            (PortId::DetuneMod, false), // Mod offset in SEMITONES
            (PortId::GlobalGate, false),
            (PortId::AudioOutput0, true),
        ]
        .iter()
        .cloned()
        .collect()
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        if !self.active {
            if let Some(output_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                output_buffer[..buffer_size].fill(0.0);
            }
            return;
        }

        self.ensure_scratch_buffers(buffer_size);

        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buffer) => buffer,
            None => return,
        };

        let alpha = self.smoothing_coeff * buffer_size as f32;
        let effective_alpha = alpha.min(1.0);

        self.smoothed_gain += effective_alpha * (self.target_gain - self.smoothed_gain);
        self.smoothed_feedback_amount +=
            effective_alpha * (self.target_feedback_amount - self.smoothed_feedback_amount);
        self.smoothed_phase_mod_amount +=
            effective_alpha * (self.target_phase_mod_amount - self.smoothed_phase_mod_amount);
        self.smoothed_detune += effective_alpha * (self.target_detune - self.smoothed_detune); // Cents
        let previous_smoothed_spread = self.smoothed_spread;
        self.smoothed_spread += effective_alpha * (self.target_spread - self.smoothed_spread); // Cents
        self.smoothed_wavetable_index +=
            effective_alpha * (self.target_wavetable_index - self.smoothed_wavetable_index);

        if (self.smoothed_spread - previous_smoothed_spread).abs() > 1e-4
            || self.voice_offsets.len() != self.unison_voices
        {
            self.update_voice_unison_values(self.smoothed_spread); // Pass spread in CENTS
        }

        let mut process_mod_input =
            |port_id: PortId, base_value: f32, target_scratch: &mut [f32]| {
                let sources = inputs.get(&port_id);
                if sources.map_or(false, |s| !s.is_empty()) {
                    Self::accumulate_modulations_inplace(
                        buffer_size,
                        sources.map(|v| v.as_slice()),
                        &mut self.mod_scratch_add,
                        &mut self.mod_scratch_mult,
                    );
                    Self::combine_modulation_inplace(
                        &mut target_scratch[..buffer_size],
                        buffer_size,
                        base_value,
                        &self.mod_scratch_add,
                        &self.mod_scratch_mult,
                    );
                } else {
                    target_scratch[..buffer_size].fill(base_value);
                }
            };

        process_mod_input(PortId::PhaseMod, 0.0, &mut self.scratch_phase_mod);
        process_mod_input(
            PortId::GainMod,
            self.smoothed_gain,
            &mut self.scratch_gain_mod,
        );
        process_mod_input(
            PortId::FeedbackMod,
            self.smoothed_feedback_amount,
            &mut self.scratch_feedback_mod,
        );
        process_mod_input(
            PortId::ModIndex,
            self.smoothed_phase_mod_amount,
            &mut self.scratch_mod_index,
        );
        process_mod_input(
            PortId::WavetableIndex,
            self.smoothed_wavetable_index,
            &mut self.scratch_wavetable_index,
        );
        // DetuneMod provides an offset in SEMITONES, additive from 0
        process_mod_input(PortId::DetuneMod, 0.0, &mut self.scratch_detune_mod);

        self.gate_buffer[..buffer_size].fill(0.0);
        if let Some(gate_sources) = inputs.get(&PortId::GlobalGate) {
            for source in gate_sources {
                Self::apply_add(
                    &source.buffer,
                    &mut self.gate_buffer[..buffer_size],
                    source.amount,
                    source.transformation,
                );
            }
        }

        let freq_mod_sources = inputs.get(&PortId::FrequencyMod);
        let has_freq_mod = freq_mod_sources.map_or(false, |s| !s.is_empty());

        if has_freq_mod {
            Self::accumulate_modulations_inplace(
                buffer_size,
                freq_mod_sources.map(|v| v.as_slice()),
                &mut self.mod_scratch_add,
                &mut self.mod_scratch_mult,
            );
        } else {
            self.mod_scratch_add[..buffer_size].fill(0.0);
            self.mod_scratch_mult[..buffer_size].fill(1.0);
        }

        let base_freq_for_mod =
            if let Some(global_freq_sources) = inputs.get(&PortId::GlobalFrequency) {
                if !global_freq_sources.is_empty() && !global_freq_sources[0].buffer.is_empty() {
                    let src_buf = &global_freq_sources[0].buffer;
                    let len_to_copy = std::cmp::min(buffer_size, src_buf.len());
                    self.global_freq_buffer[..len_to_copy].copy_from_slice(&src_buf[..len_to_copy]);
                    if len_to_copy < buffer_size {
                        let last_val = src_buf.last().cloned().unwrap_or(self.smoothed_frequency);
                        self.global_freq_buffer[len_to_copy..buffer_size].fill(last_val);
                    }
                    Self::combine_modulation_inplace_varying_base(
                        &mut self.scratch_freq[..buffer_size],
                        buffer_size,
                        &self.global_freq_buffer,
                        &self.mod_scratch_add,
                        &self.mod_scratch_mult,
                    );
                    self.smoothed_frequency
                } else {
                    self.smoothed_frequency
                }
            } else {
                self.smoothed_frequency
            };

        if inputs
            .get(&PortId::GlobalFrequency)
            .map_or(true, |gfs| gfs.is_empty() || gfs[0].buffer.is_empty())
        {
            Self::combine_modulation_inplace(
                &mut self.scratch_freq[..buffer_size],
                buffer_size,
                base_freq_for_mod,
                &self.mod_scratch_add,
                &self.mod_scratch_mult,
            );
        }

        if self.voice_offsets.len() != self.unison_voices {
            console::warn_1(
                &format!(
                    "Warning: Correcting voice offset count mismatch ({} vs {}) before loop.",
                    self.voice_offsets.len(),
                    self.unison_voices
                )
                .into(),
            );
            self.update_voice_unison_values(self.smoothed_spread); // Pass CENTS
            if self.voice_offsets.len() != self.unison_voices {
                console::error_1(
                    &"Error: Failed to correct voice offset count. Aborting process.".into(),
                );
                output_buffer[..buffer_size].fill(0.0);
                return;
            }
        }

        // Base detune factor from smoothed_detune (in cents)
        let base_detune_factor = self.cent_ratio.powf(self.smoothed_detune);
        let collection = get_collection_from_bank(&self.wavetable_bank, &self.collection_name);
        let max_wt_index = collection.num_tables() as f32 - 1.0001; // Use num_tables() from Rc

        let sample_rate_recip = self.sample_rate_recip;
        let semitone_ratio = self.semitone_ratio;
        let two_pi_recip = self.two_pi_recip;
        let feedback_divisor = self.feedback_divisor;
        let total_weight: f32 = self.voice_weights.iter().sum(); // Assuming weights are updated
        let total_weight_recip = if total_weight == 0.0 {
            1.0
        } else {
            1.0 / total_weight
        };

        for i in 0..buffer_size {
            self.check_gate(self.gate_buffer[i]);

            let current_freq = self.scratch_freq[i];
            let phase_mod_signal = self.scratch_phase_mod[i];
            let phase_mod_index = self.scratch_mod_index[i];
            let current_feedback = self.scratch_feedback_mod[i];
            let current_gain = self.scratch_gain_mod[i];
            // Use smoothed WT index from scratch buffer, clamped
            let wt_index_sample = self.scratch_wavetable_index[i].clamp(0.0, max_wt_index);
            let detune_mod_sample = self.scratch_detune_mod[i]; // Modulation offset in SEMITONES

            let base_freq = current_freq;
            let ext_phase_offset = (phase_mod_signal * phase_mod_index) * two_pi_recip;

            let final_sample = if self.unison_voices == 1 {
                let unison_offset_semitones = self.voice_offsets[0]; // Is 0.0 for single voice
                let total_semitone_offset = unison_offset_semitones + detune_mod_sample;
                let semitone_factor = semitone_ratio.powf(total_semitone_offset);
                let effective_freq = base_freq * base_detune_factor * semitone_factor;

                let phase_inc = effective_freq * sample_rate_recip;
                let voice_fb = (self.voice_last_outputs[0] * current_feedback) / feedback_divisor;
                let phase_before_update = self.voice_phases[0];
                let phase = (phase_before_update + ext_phase_offset + voice_fb).rem_euclid(1.0);

                let wv_sample = collection.lookup_sample(phase, wt_index_sample, effective_freq);

                self.voice_phases[0] = (phase_before_update + phase_inc).rem_euclid(1.0);
                self.voice_last_outputs[0] = wv_sample;

                wv_sample * current_gain // Apply gain (already includes base + mod)
            } else {
                let mut sample_sum = 0.0;
                for voice in 0..self.unison_voices {
                    let unison_offset_semitones = self.voice_offsets[voice]; // From spread (cents) -> semitones
                    let total_semitone_offset = unison_offset_semitones + detune_mod_sample; // Add mod (semitones)
                    let semitone_factor = semitone_ratio.powf(total_semitone_offset);

                    // Apply base detune (cents) factor AND semitone factor
                    let effective_freq = base_freq * base_detune_factor * semitone_factor;

                    let phase_inc = effective_freq * sample_rate_recip;

                    let voice_fb =
                        (self.voice_last_outputs[voice] * current_feedback) / feedback_divisor;
                    let phase_before_update = self.voice_phases[voice];
                    let phase = (phase_before_update + ext_phase_offset + voice_fb).rem_euclid(1.0);

                    let wv_sample =
                        collection.lookup_sample(phase, wt_index_sample, effective_freq);

                    // Accumulate using weights (currently all 1.0)
                    sample_sum += wv_sample * self.voice_weights[voice];

                    self.voice_phases[voice] = (phase_before_update + phase_inc).rem_euclid(1.0);
                    self.voice_last_outputs[voice] = wv_sample;
                }
                // Normalize by total weight and apply gain
                (sample_sum * total_weight_recip) * current_gain
            };

            output_buffer[i] = final_sample;
        }
    }

    fn reset(&mut self) {
        self.last_gate_value = 0.0;
        for phase in self.voice_phases.iter_mut() {
            *phase = 0.0;
        }
        for output in self.voice_last_outputs.iter_mut() {
            *output = 0.0;
        }

        let initial_frequency = self.frequency;
        let initial_gain = 1.0;
        let initial_feedback = 0.0;
        let initial_phase_mod = 0.0;
        let initial_detune = 0.0; // Cents
        let initial_spread = 10.0; // Cents
        let initial_wt_index = 0.0;
        let max_spread_cents = 100.0;

        self.target_gain = initial_gain;
        self.target_feedback_amount = initial_feedback;
        self.target_phase_mod_amount = initial_phase_mod;
        self.target_detune = initial_detune;
        self.target_spread = initial_spread.clamp(0.0, max_spread_cents);
        self.target_wavetable_index = initial_wt_index;
        self.target_frequency = initial_frequency;

        self.smoothed_gain = initial_gain;
        self.smoothed_feedback_amount = initial_feedback;
        self.smoothed_phase_mod_amount = initial_phase_mod;
        self.smoothed_detune = initial_detune;
        self.smoothed_spread = initial_spread.clamp(0.0, max_spread_cents);
        self.smoothed_wavetable_index = initial_wt_index;
        self.smoothed_frequency = initial_frequency;

        // Update offsets based on reset smoothed spread (in CENTS)
        self.update_voice_unison_values(self.smoothed_spread);
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
        if !active {
            self.reset();
        }
    }
    fn node_type(&self) -> &str {
        "wavetable_oscillator"
    }
}
