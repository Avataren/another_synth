use rustc_hash::FxHashMap;
use rustfft::num_traits::Float;
use std::any::Any;
use std::cell::RefCell;
use std::f32::consts::PI;
use std::rc::Rc;
use std::simd::Simd;
use wasm_bindgen::prelude::*;
use web_sys::console;

use crate::graph::{ModulationProcessor, ModulationSource};
use crate::{AudioNode, PortId};

use super::morph_wavetable::{WavetableMorphCollection, WavetableSynthBank};

#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct WavetableOscillatorStateUpdate {
    pub phase_mod_amount: f32,
    pub detune: f32,
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

pub struct WavetableOscillator {
    sample_rate: f32,
    smoothing_coeff: f32,

    target_gain: f32,
    target_feedback_amount: f32,
    target_phase_mod_amount: f32,
    target_detune: f32,
    target_spread: f32,
    target_wavetable_index: f32,
    target_frequency: f32,

    smoothed_gain: f32,
    smoothed_feedback_amount: f32,
    smoothed_phase_mod_amount: f32,
    smoothed_spread: f32,
    smoothed_wavetable_index: f32,
    smoothed_frequency: f32,

    gain: f32,
    active: bool,
    feedback_amount: f32,
    hard_sync: bool,
    last_gate_value: f32,
    frequency: f32,
    phase_mod_amount: f32,
    detune: f32,
    spread: f32,
    wavetable_index: f32,

    unison_voices: usize,
    voice_phases: Vec<f32>,
    voice_last_outputs: Vec<f32>,
    voice_weights: Vec<f32>,
    voice_offsets: Vec<f32>,

    collection_name: String,
    wavetable_bank: Rc<RefCell<WavetableSynthBank>>,

    two_pi_recip: f32,
    feedback_divisor: f32,
    cent_ratio: f32,
    semitone_ratio: f32,
    sample_rate_recip: f32,

    mod_scratch_add: Vec<f32>,
    mod_scratch_mult: Vec<f32>,
    gate_buffer: Vec<f32>,
    scratch_freq: Vec<f32>,
    scratch_phase_mod: Vec<f32>,
    scratch_gain_mod: Vec<f32>,
    scratch_feedback_mod: Vec<f32>,
    scratch_mod_index: Vec<f32>,
    scratch_wavetable_index: Vec<f32>,
    scratch_detune_mod: Vec<f32>,
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
        let initial_detune = 0.0;
        let initial_spread = 10.0;
        let initial_wt_index = 0.0;
        let max_spread_cents = 100.0;

        let smoothing_time_ms = 1.0;
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
            voice_offsets: Vec::with_capacity(16),

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
            scratch_detune_mod: vec![0.0; initial_capacity],
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
        resize_if_needed(&mut self.scratch_detune_mod, 0.0);
        resize_if_needed(&mut self.global_freq_buffer, self.smoothed_frequency);
    }

    pub fn set_current_wavetable(&mut self, collection_name: &str) {
        self.collection_name = collection_name.to_string();
    }

    pub fn update_params(&mut self, params: &WavetableOscillatorStateUpdate) {
        self.target_gain = params.gain;
        self.target_feedback_amount = params.feedback_amount;
        self.target_phase_mod_amount = params.phase_mod_amount;
        self.target_detune = params.detune;
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
            self.update_voice_unison_values(self.target_spread);
        }
    }

    fn update_voice_unison_values(&mut self, current_spread_cents: f32) {
        self.voice_weights.clear();
        self.voice_offsets.clear();
        let num_voices = self.unison_voices;
        let half_spread_cents = current_spread_cents / 2.0;

        for voice in 0..num_voices {
            self.voice_weights.push(1.0);
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

    fn process_simd_single_voice(
        &mut self,
        output_buffer: &mut [f32],
        buffer_size: usize,
        max_wt_index: f32,
        sample_rate_recip: f32,
        semitone_ratio: f32,
        two_pi_recip: f32,
        feedback_divisor: f32,
        base_detune_factor: f32,
    ) {
        type F32x4 = Simd<f32, 4>;
        let mut phase = self.voice_phases[0];
        let mut last_output = self.voice_last_outputs[0];

        let lanes = 4;
        let chunks = buffer_size / lanes;

        for chunk in 0..chunks {
            let base = chunk * lanes;
            let freq_vec = F32x4::from_array([
                self.scratch_freq[base],
                self.scratch_freq[base + 1],
                self.scratch_freq[base + 2],
                self.scratch_freq[base + 3],
            ]);
            let phase_mod_vec = F32x4::from_array([
                self.scratch_phase_mod[base],
                self.scratch_phase_mod[base + 1],
                self.scratch_phase_mod[base + 2],
                self.scratch_phase_mod[base + 3],
            ]);
            let mod_index_vec = F32x4::from_array([
                self.scratch_mod_index[base],
                self.scratch_mod_index[base + 1],
                self.scratch_mod_index[base + 2],
                self.scratch_mod_index[base + 3],
            ]);
            let gain_vec = F32x4::from_array([
                self.scratch_gain_mod[base],
                self.scratch_gain_mod[base + 1],
                self.scratch_gain_mod[base + 2],
                self.scratch_gain_mod[base + 3],
            ]);
            let feedback_vec = F32x4::from_array([
                self.scratch_feedback_mod[base],
                self.scratch_feedback_mod[base + 1],
                self.scratch_feedback_mod[base + 2],
                self.scratch_feedback_mod[base + 3],
            ]);
            let wt_index_vec = F32x4::from_array([
                self.scratch_wavetable_index[base].clamp(0.0, max_wt_index),
                self.scratch_wavetable_index[base + 1].clamp(0.0, max_wt_index),
                self.scratch_wavetable_index[base + 2].clamp(0.0, max_wt_index),
                self.scratch_wavetable_index[base + 3].clamp(0.0, max_wt_index),
            ]);
            let detune_mod_vec = F32x4::from_array([
                self.scratch_detune_mod[base],
                self.scratch_detune_mod[base + 1],
                self.scratch_detune_mod[base + 2],
                self.scratch_detune_mod[base + 3],
            ]);

            let unison_offset = self.voice_offsets[0];
            let total_semitone_offset = F32x4::splat(unison_offset) + detune_mod_vec;
            let mut semitone_factors_array = [0.0; 4];
            for j in 0..lanes {
                semitone_factors_array[j] = semitone_ratio.powf(total_semitone_offset[j]);
            }
            let semitone_factors = F32x4::from_array(semitone_factors_array);
            let effective_freq = freq_vec * F32x4::splat(base_detune_factor) * semitone_factors;
            let phase_inc = effective_freq * F32x4::splat(sample_rate_recip);

            let mut chunk_results = [0.0; 4];
            for j in 0..lanes {
                phase = (phase + phase_inc[j]).rem_euclid(1.0);
                let ext_phase_offset = (phase_mod_vec[j] * mod_index_vec[j]) * two_pi_recip;
                let voice_fb = (last_output * feedback_vec[j]) / feedback_divisor;
                let lookup_phase = (phase + ext_phase_offset + voice_fb).rem_euclid(1.0);
                let sample = {
                    let coll =
                        get_collection_from_bank(&self.wavetable_bank, &self.collection_name);
                    coll.lookup_sample(lookup_phase, wt_index_vec[j], effective_freq[j])
                };
                last_output = sample;
                chunk_results[j] = sample * gain_vec[j];
            }
            output_buffer[base..base + lanes].copy_from_slice(&chunk_results);
        }
        let remainder = buffer_size % lanes;
        let rem_base = chunks * lanes;
        for i in 0..remainder {
            let idx = rem_base + i;
            self.check_gate(self.gate_buffer[idx]);
            let current_freq = self.scratch_freq[idx];
            let phase_mod_signal = self.scratch_phase_mod[idx];
            let phase_mod_index = self.scratch_mod_index[idx];
            let current_feedback = self.scratch_feedback_mod[idx];
            let current_gain = self.scratch_gain_mod[idx];
            let wt_index_sample = self.scratch_wavetable_index[idx].clamp(0.0, max_wt_index);
            let detune_mod_sample = self.scratch_detune_mod[idx];
            let total_semitone_offset = self.voice_offsets[0] + detune_mod_sample;
            let semitone_factor = semitone_ratio.powf(total_semitone_offset);
            let effective_freq = current_freq * base_detune_factor * semitone_factor;
            let phase_inc = effective_freq * sample_rate_recip;
            phase = (phase + phase_inc).rem_euclid(1.0);
            let ext_phase_offset = (phase_mod_signal * phase_mod_index) * two_pi_recip;
            let voice_fb = (last_output * current_feedback) / feedback_divisor;
            let lookup_phase = (phase + ext_phase_offset + voice_fb).rem_euclid(1.0);
            let sample = {
                let coll = get_collection_from_bank(&self.wavetable_bank, &self.collection_name);
                coll.lookup_sample(lookup_phase, wt_index_sample, effective_freq)
            };
            last_output = sample;
            output_buffer[idx] = sample * current_gain;
        }
        self.voice_phases[0] = phase;
        self.voice_last_outputs[0] = last_output;
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
    fn get_ports(&self) -> FxHashMap<PortId, bool> {
        [
            (PortId::GlobalFrequency, false),
            (PortId::FrequencyMod, false),
            (PortId::PhaseMod, false),
            (PortId::ModIndex, false),
            (PortId::WavetableIndex, false),
            (PortId::GainMod, false),
            (PortId::FeedbackMod, false),
            (PortId::DetuneMod, false),
            (PortId::GlobalGate, false),
            (PortId::AudioOutput0, true),
        ]
        .iter()
        .cloned()
        .collect()
    }

    fn process(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
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
        let previous_smoothed_spread = self.smoothed_spread;
        self.smoothed_spread += effective_alpha * (self.target_spread - self.smoothed_spread);
        self.smoothed_wavetable_index +=
            effective_alpha * (self.target_wavetable_index - self.smoothed_wavetable_index);

        if (self.smoothed_spread - previous_smoothed_spread).abs() > 1e-4
            || self.voice_offsets.len() != self.unison_voices
        {
            self.update_voice_unison_values(self.smoothed_spread);
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
            self.update_voice_unison_values(self.smoothed_spread);
            if self.voice_offsets.len() != self.unison_voices {
                console::error_1(
                    &"Error: Failed to correct voice offset count. Aborting process.".into(),
                );
                output_buffer[..buffer_size].fill(0.0);
                return;
            }
        }

        let base_detune_factor = self.cent_ratio.powf(self.target_detune);
        let collection = get_collection_from_bank(&self.wavetable_bank, &self.collection_name);
        let max_wt_index = collection.num_tables() as f32 - 1.0001;
        let sample_rate_recip = self.sample_rate_recip;
        let semitone_ratio = self.semitone_ratio;
        let two_pi_recip = self.two_pi_recip;
        let feedback_divisor = self.feedback_divisor;
        let total_weight: f32 = self.voice_weights.iter().sum();
        let total_weight_recip = if total_weight == 0.0 {
            1.0
        } else {
            1.0 / total_weight
        };

        if self.unison_voices == 1 {
            self.process_simd_single_voice(
                output_buffer,
                buffer_size,
                max_wt_index,
                sample_rate_recip,
                semitone_ratio,
                two_pi_recip,
                feedback_divisor,
                base_detune_factor,
            );
        } else {
            for i in 0..buffer_size {
                self.check_gate(self.gate_buffer[i]);

                let current_freq = self.scratch_freq[i];
                let phase_mod_signal = self.scratch_phase_mod[i];
                let phase_mod_index = self.scratch_mod_index[i];
                let current_feedback = self.scratch_feedback_mod[i];
                let current_gain = self.scratch_gain_mod[i];
                let wt_index_sample = self.scratch_wavetable_index[i].clamp(0.0, max_wt_index);
                let detune_mod_sample = self.scratch_detune_mod[i];

                let mut sample_sum = 0.0;
                for voice in 0..self.unison_voices {
                    let unison_offset_semitones = self.voice_offsets[voice];
                    let total_semitone_offset = unison_offset_semitones + detune_mod_sample;
                    let semitone_factor = semitone_ratio.powf(total_semitone_offset);
                    let effective_freq = current_freq * base_detune_factor * semitone_factor;
                    let phase_inc = effective_freq * sample_rate_recip;
                    let old_phase = self.voice_phases[voice];
                    let new_phase_acc = (old_phase + phase_inc).rem_euclid(1.0);
                    let voice_fb =
                        (self.voice_last_outputs[voice] * current_feedback) / feedback_divisor;
                    let lookup_phase =
                        (new_phase_acc + phase_mod_signal * phase_mod_index + voice_fb)
                            .rem_euclid(1.0);
                    let wv_sample =
                        collection.lookup_sample(lookup_phase, wt_index_sample, effective_freq);
                    sample_sum += wv_sample * self.voice_weights[voice];
                    self.voice_phases[voice] = new_phase_acc;
                    self.voice_last_outputs[voice] = wv_sample;
                }
                output_buffer[i] = (sample_sum * total_weight_recip) * current_gain;
            }
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
        let initial_detune = 0.0;
        let initial_spread = 10.0;
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
        self.smoothed_spread = initial_spread.clamp(0.0, max_spread_cents);
        self.smoothed_wavetable_index = initial_wt_index;
        self.smoothed_frequency = initial_frequency;

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
