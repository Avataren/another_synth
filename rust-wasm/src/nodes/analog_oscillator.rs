use std::any::Any;
use std::collections::HashMap;
use std::simd::{f32x4, Simd}; // Import Simd
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use web_sys::console;

// Import necessary items from modulation processor and graph types
use crate::graph::{
    ModulationProcessor, ModulationSource, ModulationTransformation, ModulationType,
};
use crate::{AudioNode, PortId};

use super::{Waveform, Wavetable, WavetableBank}; // Assuming Wavetable struct exists

#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct AnalogOscillatorStateUpdate {
    pub phase_mod_amount: f32,
    pub detune: f32, // Base detune in cents
    pub hard_sync: bool,
    pub gain: f32,
    pub active: bool,
    pub feedback_amount: f32,
    pub waveform: Waveform,
    pub unison_voices: u32,
    pub spread: f32, // Spread in semitones
}

#[wasm_bindgen]
impl AnalogOscillatorStateUpdate {
    #[wasm_bindgen(constructor)]
    pub fn new(
        phase_mod_amount: f32,
        detune: f32, // In cents
        hard_sync: bool,
        gain: f32,
        active: bool,
        feedback_amount: f32,
        waveform: Waveform,
        unison_voices: u32,
        spread: f32, // In semitones
    ) -> Self {
        Self {
            phase_mod_amount,
            detune,
            hard_sync,
            gain,
            active,
            feedback_amount,
            waveform,
            unison_voices,
            spread,
        }
    }
}

/// AnalogOscillator implements an analog‑style oscillator with unison and modulation.
pub struct AnalogOscillator {
    // Core oscillator state.
    sample_rate: f32,
    gain: f32,
    active: bool,
    feedback_amount: f32,
    hard_sync: bool,
    last_gate_value: f32,
    frequency: f32, // Base frequency if GlobalFrequency not connected
    waveform: Waveform,

    // Modulation parameters.
    phase_mod_amount: f32,
    detune: f32, // Base detune in cents

    // Unison parameters.
    unison_voices: usize,
    spread: f32, // Spread in semitones
    voice_phases: Vec<f32>,
    voice_last_outputs: Vec<f32>, // Per-voice feedback state.
    voice_offsets: Vec<f32>,      // Cached unison offsets in semitones

    // Wavetable data access.
    wavetable_banks: Arc<HashMap<Waveform, Arc<WavetableBank>>>,

    // Precalculated constants
    sample_rate_recip: f32,
    semitone_ratio: f32,
    cent_ratio: f32,
    two_pi_recip: f32,
    feedback_divisor: f32,

    // === Scratch buffers to avoid repeated allocations ===
    mod_scratch_add: Vec<f32>,
    mod_scratch_mult: Vec<f32>,
    gate_buffer: Vec<f32>,
    scratch_freq: Vec<f32>,
    scratch_phase_mod: Vec<f32>,
    scratch_gain_mod: Vec<f32>,
    scratch_mod_index: Vec<f32>,
    scratch_feedback_mod: Vec<f32>,
    scratch_detune_mod: Vec<f32>,
    global_freq_buffer: Vec<f32>,
}

impl ModulationProcessor for AnalogOscillator {}

impl AnalogOscillator {
    pub fn new(
        sample_rate: f32,
        waveform: Waveform,
        wavetable_banks: Arc<HashMap<Waveform, Arc<WavetableBank>>>,
    ) -> Self {
        let initial_capacity = 128; // Default buffer size
        let initial_voice_count = 1;

        Self {
            sample_rate,
            gain: 1.0,
            active: true,
            feedback_amount: 0.0,
            hard_sync: false,
            last_gate_value: 0.0,
            frequency: 440.0,
            waveform,
            phase_mod_amount: 0.0,
            detune: 0.0,
            unison_voices: initial_voice_count,
            spread: 0.1,
            voice_phases: vec![0.0; initial_voice_count],
            voice_last_outputs: vec![0.0; initial_voice_count],
            voice_offsets: Vec::with_capacity(16),
            wavetable_banks,
            sample_rate_recip: 1.0 / sample_rate,
            semitone_ratio: 2.0_f32.powf(1.0 / 12.0),
            cent_ratio: 2.0_f32.powf(1.0 / 1200.0),
            two_pi_recip: 1.0 / (2.0 * std::f32::consts::PI),
            feedback_divisor: std::f32::consts::PI * 1.5,
            mod_scratch_add: vec![0.0; initial_capacity],
            mod_scratch_mult: vec![1.0; initial_capacity],
            gate_buffer: vec![0.0; initial_capacity],
            scratch_freq: vec![440.0; initial_capacity],
            scratch_phase_mod: vec![0.0; initial_capacity],
            scratch_gain_mod: vec![1.0; initial_capacity],
            scratch_mod_index: vec![0.0; initial_capacity],
            scratch_feedback_mod: vec![0.0; initial_capacity],
            scratch_detune_mod: vec![0.0; initial_capacity],
            global_freq_buffer: vec![440.0; initial_capacity],
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
        resize_if_needed(&mut self.scratch_freq, self.frequency);
        resize_if_needed(&mut self.scratch_phase_mod, 0.0);
        resize_if_needed(&mut self.scratch_gain_mod, self.gain);
        resize_if_needed(&mut self.scratch_mod_index, self.phase_mod_amount);
        resize_if_needed(&mut self.scratch_feedback_mod, self.feedback_amount);
        resize_if_needed(&mut self.scratch_detune_mod, 0.0);
        resize_if_needed(&mut self.global_freq_buffer, self.frequency);
    }

    pub fn update_params(&mut self, params: &AnalogOscillatorStateUpdate) {
        self.gain = params.gain;
        self.feedback_amount = params.feedback_amount;
        self.hard_sync = params.hard_sync;
        self.active = params.active;
        self.waveform = params.waveform;
        self.phase_mod_amount = params.phase_mod_amount;
        self.detune = params.detune;
        self.spread = params.spread;

        let new_voice_count = if params.unison_voices == 0 {
            1
        } else {
            params.unison_voices as usize
        };

        if new_voice_count != self.unison_voices {
            self.unison_voices = new_voice_count;
            self.voice_phases.resize(new_voice_count, 0.0);
            self.voice_last_outputs.resize(new_voice_count, 0.0);
            self.voice_offsets.reserve(new_voice_count);
        }
        self.update_voice_unison_offsets();
    }

    fn update_voice_unison_offsets(&mut self) {
        self.voice_offsets.clear();
        let num_voices = self.unison_voices;

        for voice in 0..num_voices {
            let offset = if num_voices > 1 {
                let normalized_pos = if num_voices > 1 {
                    voice as f32 / (num_voices - 1) as f32
                } else {
                    0.5
                }; // Center if only one voice exists in calculation logic
                self.spread * (normalized_pos - 0.5)
            } else {
                0.0
            };
            self.voice_offsets.push(offset);
        }
        // Ensure offsets always match voice count, even if count is 1
        if self.voice_offsets.len() != num_voices {
            self.voice_offsets.resize(num_voices, 0.0); // Should not happen with clear/push logic, but safe
        }
    }

    // --- Removed check_gate method ---
    // /// Reset voice phases on a rising gate edge if hard_sync is enabled.
    // #[inline(always)]
    // fn check_gate(&mut self, gate: f32) {
    //     if self.hard_sync && gate > 0.0 && self.last_gate_value <= 0.0 {
    //         for phase in self.voice_phases.iter_mut() {
    //             *phase = 0.0;
    //         }
    //     }
    //     self.last_gate_value = gate;
    // }
}

#[inline(always)]
fn cubic_interp(samples: &[f32], pos: f32) -> f32 {
    let n = samples.len();
    if n == 0 {
        return 0.0;
    }
    let n_f32 = n as f32;
    let wrapped_pos = pos * n_f32;

    let i = wrapped_pos.floor() as isize;
    let frac = wrapped_pos - (i as f32);

    let idx = |j: isize| -> f32 {
        let index = (i + j).rem_euclid(n as isize) as usize;
        samples[index]
    };

    let p0 = idx(-1);
    let p1 = idx(0);
    let p2 = idx(1);
    let p3 = idx(2);

    0.5 * ((2.0 * p1)
        + (-p0 + p2) * frac
        + (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3) * frac * frac
        + (-p0 + 3.0 * p1 - 3.0 * p2 + p3) * frac * frac * frac)
}

impl AudioNode for AnalogOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        [
            (PortId::GlobalFrequency, false),
            (PortId::FrequencyMod, false),
            (PortId::PhaseMod, false),
            (PortId::ModIndex, false),
            (PortId::DetuneMod, false),
            (PortId::GainMod, false),
            (PortId::FeedbackMod, false),
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

        // --- 1) Process Modulation Inputs ---
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
        process_mod_input(PortId::GainMod, self.gain, &mut self.scratch_gain_mod);
        process_mod_input(
            PortId::FeedbackMod,
            self.feedback_amount,
            &mut self.scratch_feedback_mod,
        );
        process_mod_input(
            PortId::ModIndex,
            self.phase_mod_amount,
            &mut self.scratch_mod_index,
        );
        process_mod_input(PortId::DetuneMod, 0.0, &mut self.scratch_detune_mod);

        // --- 2) Handle Gate Input ---
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

        // --- 3) Handle Frequency Input ---
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

        if let Some(global_freq_sources) = inputs.get(&PortId::GlobalFrequency) {
            if !global_freq_sources.is_empty() && !global_freq_sources[0].buffer.is_empty() {
                let src_buf = &global_freq_sources[0].buffer;
                let len_to_copy = std::cmp::min(buffer_size, src_buf.len());
                self.global_freq_buffer[..len_to_copy].copy_from_slice(&src_buf[..len_to_copy]);
                if len_to_copy < buffer_size {
                    let last_val = src_buf.last().cloned().unwrap_or(self.frequency);
                    self.global_freq_buffer[len_to_copy..buffer_size].fill(last_val);
                }
                Self::combine_modulation_inplace_varying_base(
                    &mut self.scratch_freq[..buffer_size],
                    buffer_size,
                    &self.global_freq_buffer,
                    &self.mod_scratch_add,
                    &self.mod_scratch_mult,
                );
            } else {
                Self::combine_modulation_inplace(
                    &mut self.scratch_freq[..buffer_size],
                    buffer_size,
                    self.frequency,
                    &self.mod_scratch_add,
                    &self.mod_scratch_mult,
                );
            }
        } else {
            Self::combine_modulation_inplace(
                &mut self.scratch_freq[..buffer_size],
                buffer_size,
                self.frequency,
                &self.mod_scratch_add,
                &self.mod_scratch_mult,
            );
        }

        // --- 4) Pre-loop Setup ---
        if self.voice_offsets.len() != self.unison_voices {
            // This should ideally not happen if update_params is called correctly,
            // but it's a safeguard.
            console::warn_1(&"Warning: Voice offsets recalculated in process loop.".into());
            self.update_voice_unison_offsets();
        }

        let base_detune_factor = self.cent_ratio.powf(self.detune);
        let current_bank = match self.wavetable_banks.get(&self.waveform) {
            Some(bank) => bank,
            None => {
                console::error_1(
                    &format!(
                        "Error: Wavetable bank not found for waveform {:?}",
                        self.waveform
                    )
                    .into(),
                );
                output_buffer[..buffer_size].fill(0.0);
                return;
            }
        };

        let sample_rate_recip = self.sample_rate_recip;
        let semitone_ratio = self.semitone_ratio;
        let two_pi_recip = self.two_pi_recip;
        let feedback_divisor = self.feedback_divisor;
        let unison_voices_f32 = self.unison_voices as f32;

        // --- 5) Main Synthesis Loop ---
        for i in 0..buffer_size {
            // --- Gate Check (Inlined) ---
            let current_gate = self.gate_buffer[i];
            let is_rising_edge = current_gate > 0.0 && self.last_gate_value <= 0.0;

            if self.hard_sync && is_rising_edge {
                // Phase reset requires mutable borrow of self.voice_phases
                for phase in self.voice_phases.iter_mut() {
                    *phase = 0.0;
                }
            }
            // Update last_gate_value requires mutable borrow of self.last_gate_value
            // This happens *after* the check and potential mutation above.
            self.last_gate_value = current_gate;
            // --- End Gate Check ---

            // Get per-sample modulated values (immutable borrows of self fields)
            let current_freq = self.scratch_freq[i];
            let phase_mod_signal = self.scratch_phase_mod[i];
            let phase_mod_index = self.scratch_mod_index[i];
            let current_feedback = self.scratch_feedback_mod[i];
            let current_gain = self.scratch_gain_mod[i];
            let detune_mod_sample = self.scratch_detune_mod[i]; // In semitones

            let base_freq_detuned = current_freq * base_detune_factor;
            let ext_phase_offset = (phase_mod_signal * phase_mod_index) * two_pi_recip;

            let mut sample_sum = 0.0;

            // Optimize for single voice case
            if self.unison_voices == 1 {
                let voice_detune_semitones = detune_mod_sample + self.voice_offsets[0]; // Offset is 0
                let semitone_factor = semitone_ratio.powf(voice_detune_semitones);
                let effective_freq = base_freq_detuned * semitone_factor;
                let phase_inc = effective_freq * sample_rate_recip;

                // Mutable borrows for feedback/phase update happen here, scoped per-voice
                let voice_fb = (self.voice_last_outputs[0] * current_feedback) / feedback_divisor;
                // Note: voice_phases[0] might have been reset just above by the gate check
                let phase = (self.voice_phases[0] + ext_phase_offset + voice_fb).rem_euclid(1.0);

                let table = current_bank.select_table(effective_freq);
                let voice_sample = cubic_interp(&table.samples, phase);

                // Update state requires mutable borrows
                self.voice_phases[0] = (self.voice_phases[0] + phase_inc).rem_euclid(1.0);
                self.voice_last_outputs[0] = voice_sample;
                sample_sum = voice_sample;
            } else {
                // Multiple voices
                // Ensure voice_offsets has the correct length before accessing
                if self.voice_offsets.len() < self.unison_voices {
                    // This indicates a logic error somewhere, potentially in update_params
                    // or how unison_voices is managed. Log an error and skip processing
                    // for this sample to avoid panic.
                    console::error_1(&format!("Error: Mismatch between unison_voices ({}) and voice_offsets length ({}). Skipping sample.", self.unison_voices, self.voice_offsets.len()).into());
                    output_buffer[i] = 0.0; // Output silence for this sample
                    continue; // Skip to the next sample
                }

                for v in 0..self.unison_voices {
                    // Immutable borrow for voice_offsets
                    let voice_detune_semitones = detune_mod_sample + self.voice_offsets[v];
                    let semitone_factor = semitone_ratio.powf(voice_detune_semitones);
                    let effective_freq = base_freq_detuned * semitone_factor;
                    let phase_inc = effective_freq * sample_rate_recip;

                    // Mutable borrows for feedback/phase update, scoped per-voice iteration
                    let voice_fb =
                        (self.voice_last_outputs[v] * current_feedback) / feedback_divisor;
                    // Note: voice_phases[v] might have been reset just above by the gate check
                    let phase =
                        (self.voice_phases[v] + ext_phase_offset + voice_fb).rem_euclid(1.0);

                    let table = current_bank.select_table(effective_freq);
                    let voice_sample = cubic_interp(&table.samples, phase);

                    // Update state requires mutable borrows
                    self.voice_phases[v] = (self.voice_phases[v] + phase_inc).rem_euclid(1.0);
                    self.voice_last_outputs[v] = voice_sample;

                    sample_sum += voice_sample;
                }
            }

            let final_sample = (sample_sum / unison_voices_f32) * current_gain;
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
        "analog_oscillator"
    }
}
