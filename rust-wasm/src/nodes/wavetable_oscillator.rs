use std::any::Any;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use std::simd::{f32x4, LaneCount, Simd, SupportedLaneCount}; // Import Simd
use wasm_bindgen::prelude::*;
use web_sys::console;

// Make sure ModulationProcessor trait is accessible
use crate::graph::{
    ModulationProcessor, ModulationSource, ModulationTransformation, ModulationType,
};
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
    // last_output: f32, // Global last_output only needed if feedback used it, now per-voice
    hard_sync: bool,
    last_gate_value: f32,
    frequency: f32, // Base frequency if GlobalFrequency not connected
    // Modulation parameters.
    phase_mod_amount: f32,
    detune: f32, // In cents
    // Unison parameters.
    unison_voices: usize,
    spread: f32,
    voice_phases: Vec<f32>,
    voice_last_outputs: Vec<f32>, // Per-voice feedback state.
    voice_weights: Vec<f32>,      // Cached to avoid reallocation
    voice_offsets: Vec<f32>,      // Cached to avoid reallocation
    // Morph parameter.
    wavetable_index: f32,
    // Name of the morph collection to use.
    collection_name: String,
    // The bank of wavetable morph collections.
    wavetable_bank: Rc<RefCell<WavetableSynthBank>>,
    // Precalculated constants.
    two_pi_recip: f32, // Use 1.0 / (2.0 * PI) for multiplication
    feedback_divisor: f32,
    cent_ratio: f32,     // 2^(1/1200)
    semitone_ratio: f32, // 2^(1/12)
    sample_rate_recip: f32,

    // === Scratch buffers to avoid repeated allocations in process ===
    // Buffers for accumulation results
    mod_scratch_add: Vec<f32>,
    mod_scratch_mult: Vec<f32>,
    // Buffers holding the final, modulated per-sample values
    gate_buffer: Vec<f32>,             // Combined gate input
    scratch_freq: Vec<f32>,            // Final frequency after modulation
    scratch_phase_mod: Vec<f32>,       // Final phase modulation value (additive)
    scratch_gain_mod: Vec<f32>,        // Final gain multiplier
    scratch_feedback_mod: Vec<f32>,    // Final feedback amount multiplier
    scratch_mod_index: Vec<f32>,       // Final phase modulation index multiplier
    scratch_wavetable_index: Vec<f32>, // Final wavetable index
    scratch_detune_mod: Vec<f32>,      // Final detune offset (in semitones)

    // Buffer for GlobalFrequency input if present
    global_freq_buffer: Vec<f32>,
}

// Implement the trait for the struct
impl ModulationProcessor for WavetableOscillator {}

impl WavetableOscillator {
    pub fn new(sample_rate: f32, bank: Rc<RefCell<WavetableSynthBank>>) -> Self {
        let initial_capacity = 128; // Default buffer size, adjust as needed
        Self {
            sample_rate,
            gain: 1.0,
            active: true,
            feedback_amount: 0.0,
            // last_output: 0.0,
            hard_sync: false,
            last_gate_value: 0.0,
            frequency: 440.0,
            phase_mod_amount: 0.0,
            detune: 0.0,
            unison_voices: 1,
            spread: 0.1,
            voice_phases: vec![0.0; 1],
            voice_last_outputs: vec![0.0; 1],
            voice_weights: Vec::with_capacity(16), // Preallocate reasonable capacity
            voice_offsets: Vec::with_capacity(16), // Preallocate reasonable capacity
            wavetable_index: 0.0,
            collection_name: "default".to_string(),
            wavetable_bank: bank,
            two_pi_recip: 1.0 / (2.0 * PI),
            feedback_divisor: PI * 1.5, // Or 1.0 if scaling elsewhere
            cent_ratio: 2.0_f32.powf(1.0 / 1200.0),
            semitone_ratio: 2.0_f32.powf(1.0 / 12.0),
            sample_rate_recip: 1.0 / sample_rate,

            // Initialize scratch buffers
            mod_scratch_add: vec![0.0; initial_capacity],
            mod_scratch_mult: vec![1.0; initial_capacity],
            gate_buffer: vec![0.0; initial_capacity],
            scratch_freq: vec![440.0; initial_capacity],
            scratch_phase_mod: vec![0.0; initial_capacity],
            scratch_gain_mod: vec![1.0; initial_capacity],
            scratch_feedback_mod: vec![0.0; initial_capacity],
            scratch_mod_index: vec![0.0; initial_capacity],
            scratch_wavetable_index: vec![0.0; initial_capacity],
            scratch_detune_mod: vec![0.0; initial_capacity],
            global_freq_buffer: vec![440.0; initial_capacity],
        }
    }

    /// Ensure all scratch buffers have at least `size` capacity.
    /// Resizes if needed. Call this at the start of `process`.
    fn ensure_scratch_buffers(&mut self, size: usize) {
        // Helper closure to resize a specific buffer
        let mut resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
            if buf.len() < size {
                // Optionally log resizing if it's unexpected during runtime
                // console::log_1(&format!("Resizing buffer from {} to {}", buf.len(), size).into());
                buf.resize(size, default_val);
            }
        };

        resize_if_needed(&mut self.mod_scratch_add, 0.0);
        resize_if_needed(&mut self.mod_scratch_mult, 1.0);
        resize_if_needed(&mut self.gate_buffer, 0.0); // Reset gate buffer later
        resize_if_needed(&mut self.scratch_freq, self.frequency); // Default to base freq
        resize_if_needed(&mut self.scratch_phase_mod, 0.0);
        resize_if_needed(&mut self.scratch_gain_mod, self.gain); // Default to base gain
        resize_if_needed(&mut self.scratch_feedback_mod, self.feedback_amount); // Default to base feedback
        resize_if_needed(&mut self.scratch_mod_index, self.phase_mod_amount); // Default to base mod index
        resize_if_needed(&mut self.scratch_wavetable_index, self.wavetable_index); // Default to base WT index
        resize_if_needed(&mut self.scratch_detune_mod, 0.0); // Default to zero detune mod
        resize_if_needed(&mut self.global_freq_buffer, self.frequency);
    }

    pub fn set_current_wavetable(&mut self, collection_name: &str) {
        self.collection_name = collection_name.to_string();
        // Note: Could potentially pre-fetch the Rc<WavetableMorphCollection> here
        // if the bank allows it, to avoid the RefCell borrow in the audio thread.
        // However, this requires the bank structure to support it.
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

        // Resize voice-specific buffers only if the count actually changes
        if new_voice_count != self.unison_voices {
            self.unison_voices = new_voice_count;
            // Resize and reinitialize phases based on new count and spread
            if self.spread == 0.0 {
                self.voice_phases.resize(new_voice_count, 0.0); // All start at 0 if spread is 0
            } else {
                self.voice_phases = (0..new_voice_count)
                    .map(|i| i as f32 / new_voice_count as f32) // Initial spread
                    .collect();
            }
            self.voice_last_outputs.resize(new_voice_count, 0.0);

            // Also resize cached weights/offsets if needed (or just clear and let update handle it)
            self.voice_weights.reserve(new_voice_count);
            self.voice_offsets.reserve(new_voice_count);
        } else if self.spread == 0.0 {
            // If voice count didn't change but spread became 0, reset phases
            if !self.voice_phases.is_empty() {
                let common_phase = self.voice_phases[0]; // Keep existing phase? Or reset to 0? Let's reset.
                for phase in self.voice_phases.iter_mut() {
                    *phase = 0.0; // Reset phases if spread is zero
                }
            }
        }
        // Always update weights/offsets based on current spread/count
        self.update_voice_unison_values();
    }

    /// Updates the cached `voice_weights` and `voice_offsets` based on
    /// current `unison_voices` and `spread`.
    fn update_voice_unison_values(&mut self) {
        self.voice_weights.clear();
        self.voice_offsets.clear();
        let num_voices = self.unison_voices; // Cache locally

        for voice in 0..num_voices {
            self.voice_weights.push(1.0); // Currently using equal weight

            let offset = if num_voices > 1 {
                // Calculate offset: maps voice index [0, num_voices-1] to [-spread/2, +spread/2] semitones
                let normalized_pos = voice as f32 / (num_voices - 1) as f32; // 0.0 to 1.0
                self.spread * (normalized_pos - 0.5) // Map to [-spread/2, +spread/2]
            } else {
                0.0 // No offset for single voice
            };
            // Store offset directly in semitones
            self.voice_offsets.push(offset);
        }
    }

    #[inline(always)]
    fn check_gate(&mut self, gate: f32) {
        if self.hard_sync && gate > 0.0 && self.last_gate_value <= 0.0 {
            // Reset all voice phases on rising edge if hard_sync is enabled
            for phase in self.voice_phases.iter_mut() {
                *phase = 0.0;
            }
        }
        self.last_gate_value = gate;
    }

    // process_modulation_simd_in_place is removed, use ModulationProcessor::combine_modulation_inplace instead
}

/// Helper to get the collection, handling the borrow and potential panic.
/// Keep this outside the main process loop if collection_name doesn't change per sample.
#[inline(always)]
fn get_collection_from_bank<'a>(
    bank: &'a RefCell<WavetableSynthBank>,
    name: &str,
) -> Rc<WavetableMorphCollection> {
    // Return Rc directly
    let borrowed_bank = bank.borrow(); // Borrow happens here
    borrowed_bank
        .get_collection(name)
        .unwrap_or_else(|| panic!("Wavetable collection '{}' not found", name))
        .clone() // Clone the Rc, cheap
}

impl AudioNode for WavetableOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        [
            (PortId::GlobalFrequency, false), // Input: Base frequency (optional)
            (PortId::FrequencyMod, false),    // Input: Modulation for frequency
            (PortId::PhaseMod, false),        // Input: Additive phase modulation signal
            (PortId::ModIndex, false),        // Input: Multiplier for PhaseMod amount
            (PortId::WavetableIndex, false),  // Input: Controls morphing between wavetables
            (PortId::GainMod, false),         // Input: Modulation for output gain
            (PortId::FeedbackMod, false),     // Input: Modulation for feedback amount
            (PortId::DetuneMod, false), // Input: Modulation for unison detune/spread (semitones)
            (PortId::GlobalGate, false), // Input: Gate signal for hard sync trigger
            (PortId::AudioOutput0, true), // Output: Synthesized audio
                                        // Note: DetuneMod was listed as output before, should be input
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
        // --- 0) Early exit and Buffer Preparation ---
        if !self.active {
            if let Some(output_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                output_buffer[..buffer_size].fill(0.0);
            }
            return;
        }

        // Ensure all scratch buffers are large enough for the current buffer_size
        self.ensure_scratch_buffers(buffer_size);

        // Get the output buffer, or return if it's not requested
        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buffer) => buffer,
            None => return, // No output requested
        };

        // --- 1) Process Modulation Inputs (Conditionally) ---

        // Helper closure to process a single modulation input port
        let mut process_mod_input =
            |port_id: PortId, base_value: f32, target_scratch: &mut [f32]| {
                let sources = inputs.get(&port_id);
                // Check if there are actually any sources connected
                if sources.map_or(false, |s| !s.is_empty()) {
                    // Accumulate modulation inplace using shared scratch buffers
                    Self::accumulate_modulations_inplace(
                        buffer_size,
                        sources.map(|v| v.as_slice()),
                        &mut self.mod_scratch_add, // Temporary buffer for additive part
                        &mut self.mod_scratch_mult, // Temporary buffer for multiplicative part
                    );
                    // Combine base value with accumulated modulation into the final target scratch buffer
                    Self::combine_modulation_inplace(
                        &mut target_scratch[..buffer_size],
                        buffer_size,
                        base_value,
                        &self.mod_scratch_add,
                        &self.mod_scratch_mult,
                    );
                } else {
                    // No modulation sources, just fill the target scratch buffer with the base value
                    target_scratch[..buffer_size].fill(base_value);
                }
            };

        // Process each modulation input using the helper
        process_mod_input(PortId::PhaseMod, 0.0, &mut self.scratch_phase_mod); // Phase mod is additive from 0
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
        process_mod_input(
            PortId::WavetableIndex,
            self.wavetable_index,
            &mut self.scratch_wavetable_index,
        );
        process_mod_input(PortId::DetuneMod, 0.0, &mut self.scratch_detune_mod); // Detune mod is additive from 0 semitones

        // --- 2) Handle Gate Input ---
        self.gate_buffer[..buffer_size].fill(0.0); // Reset gate buffer first
        if let Some(gate_sources) = inputs.get(&PortId::GlobalGate) {
            for source in gate_sources {
                // Simple additive mixing for gate, assuming ModulationType::Additive
                // Use apply_add which handles SIMD and transforms if needed
                // (Assuming gate doesn't usually use transforms other than None)
                Self::apply_add(
                    &source.buffer,
                    &mut self.gate_buffer[..buffer_size],
                    source.amount,
                    source.transformation, // Apply transform if specified
                );
            }
        }

        // --- 3) Handle Frequency Input (Special Case: Base + Modulation) ---
        let freq_mod_sources = inputs.get(&PortId::FrequencyMod);
        let has_freq_mod = freq_mod_sources.map_or(false, |s| !s.is_empty());

        // Accumulate frequency modulation if present
        if has_freq_mod {
            Self::accumulate_modulations_inplace(
                buffer_size,
                freq_mod_sources.map(|v| v.as_slice()),
                &mut self.mod_scratch_add,
                &mut self.mod_scratch_mult,
            );
        } else {
            // If no freq mod, ensure accumulators are identity (0.0 add, 1.0 mult)
            // accumulate_modulations_inplace already does this, but being explicit is ok
            self.mod_scratch_add[..buffer_size].fill(0.0);
            self.mod_scratch_mult[..buffer_size].fill(1.0);
        }

        // Determine the base frequency (Global input or internal fallback)
        if let Some(global_freq_sources) = inputs.get(&PortId::GlobalFrequency) {
            if !global_freq_sources.is_empty() && !global_freq_sources[0].buffer.is_empty() {
                let src_buf = &global_freq_sources[0].buffer;
                let len_to_copy = std::cmp::min(buffer_size, src_buf.len());
                // Copy global freq input to a temporary buffer
                self.global_freq_buffer[..len_to_copy].copy_from_slice(&src_buf[..len_to_copy]);
                // Handle if global freq buffer is shorter than needed
                if len_to_copy < buffer_size {
                    let last_val = src_buf.last().cloned().unwrap_or(self.frequency);
                    self.global_freq_buffer[len_to_copy..buffer_size].fill(last_val);
                }
                // Combine the varying base frequency with modulation
                Self::combine_modulation_inplace_varying_base(
                    &mut self.scratch_freq[..buffer_size],
                    buffer_size,
                    &self.global_freq_buffer, // Base is from global input
                    &self.mod_scratch_add,
                    &self.mod_scratch_mult,
                );
            } else {
                // Global port exists but no sources/empty buffer, use internal base freq
                Self::combine_modulation_inplace(
                    &mut self.scratch_freq[..buffer_size],
                    buffer_size,
                    self.frequency, // Base is internal value
                    &self.mod_scratch_add,
                    &self.mod_scratch_mult,
                );
            }
        } else {
            // No GlobalFrequency port connected, use internal base freq
            Self::combine_modulation_inplace(
                &mut self.scratch_freq[..buffer_size],
                buffer_size,
                self.frequency, // Base is internal value
                &self.mod_scratch_add,
                &self.mod_scratch_mult,
            );
        }

        // --- 4) Pre-loop Setup ---
        // Ensure unison weights/offsets are up-to-date (might be redundant if update_params handles it)
        if self.voice_weights.len() != self.unison_voices
            || self.voice_offsets.len() != self.unison_voices
        {
            self.update_voice_unison_values();
        }

        // Precompute values used repeatedly in the loop
        let total_weight: f32 = self.voice_weights.iter().sum(); // Could be cached if weights are static
        let total_weight_recip = if total_weight == 0.0 {
            1.0
        } else {
            1.0 / total_weight
        }; // Avoid div by zero
        let cents_factor = self.cent_ratio.powf(self.detune);
        // Get the wavetable collection - Moved outside loop
        let collection = get_collection_from_bank(&self.wavetable_bank, &self.collection_name);

        // Cache constants frequently used in loop
        let sample_rate_recip = self.sample_rate_recip;
        let two_pi_recip = self.two_pi_recip;
        let feedback_divisor = self.feedback_divisor;
        let semitone_ratio = self.semitone_ratio;

        // --- 5) Main Synthesis Loop ---
        for i in 0..buffer_size {
            // Check gate for hard sync
            self.check_gate(self.gate_buffer[i]);

            // Get per-sample modulated values from scratch buffers
            let current_freq = self.scratch_freq[i];
            let phase_mod_signal = self.scratch_phase_mod[i];
            let phase_mod_index = self.scratch_mod_index[i];
            let current_feedback = self.scratch_feedback_mod[i];
            let current_gain = self.scratch_gain_mod[i];
            let wt_index_sample = self.scratch_wavetable_index[i].clamp(0.0, 1.0); // Clamp WT index
            let detune_mod_sample = self.scratch_detune_mod[i]; // In semitones

            // Calculate external phase offset (applied equally to all voices)
            let ext_phase_offset = (phase_mod_signal * phase_mod_index) * two_pi_recip; // Use recip for multiplication

            let final_sample = if self.unison_voices == 1 {
                // --- Optimized Path for Single Voice ---
                let effective_freq = current_freq
                    * cents_factor
                    * semitone_ratio.powf(detune_mod_sample + self.voice_offsets[0]);
                let phase_inc = effective_freq * sample_rate_recip;
                let voice_fb = (self.voice_last_outputs[0] * current_feedback) / feedback_divisor;

                // Calculate current phase (wrapped)
                let phase = (self.voice_phases[0] + ext_phase_offset + voice_fb).rem_euclid(1.0);

                // Wavetable lookup
                let wv_sample = collection.lookup_sample(phase, wt_index_sample, effective_freq);

                // Update phase and feedback state
                self.voice_phases[0] = (self.voice_phases[0] + phase_inc).rem_euclid(1.0);
                self.voice_last_outputs[0] = wv_sample;

                // Apply gain
                wv_sample * current_gain
            } else {
                // --- Path for Multiple Unison Voices ---
                let mut sample_sum = 0.0;
                let base_freq_with_cents = current_freq * cents_factor;

                for voice in 0..self.unison_voices {
                    // Calculate voice-specific detune and frequency
                    // Offset is already in semitones, add modulation
                    let voice_detune_semitones = detune_mod_sample + self.voice_offsets[voice];
                    let semitones_factor = semitone_ratio.powf(voice_detune_semitones);
                    let effective_freq = base_freq_with_cents * semitones_factor;
                    let phase_inc = effective_freq * sample_rate_recip;

                    // Per-voice feedback calculation
                    let voice_fb =
                        (self.voice_last_outputs[voice] * current_feedback) / feedback_divisor;

                    // Calculate current phase (wrapped)
                    let phase =
                        (self.voice_phases[voice] + ext_phase_offset + voice_fb).rem_euclid(1.0);

                    // Wavetable lookup
                    let wv_sample =
                        collection.lookup_sample(phase, wt_index_sample, effective_freq);

                    // Add to sum with weight (currently weight is 1.0)
                    // sample_sum += wv_sample * self.voice_weights[voice]; // If weights != 1.0
                    sample_sum += wv_sample;

                    // Update phase and feedback state for this voice
                    self.voice_phases[voice] =
                        (self.voice_phases[voice] + phase_inc).rem_euclid(1.0);
                    self.voice_last_outputs[voice] = wv_sample;
                }

                // Normalize by total weight and apply gain
                (sample_sum * total_weight_recip) * current_gain
            };

            // Write final sample to output buffer
            output_buffer[i] = final_sample;
            // Removed self.last_output update as feedback is per-voice
        }
    }

    fn reset(&mut self) {
        // Reset phases
        for phase in self.voice_phases.iter_mut() {
            *phase = 0.0;
        }
        // Reset feedback history
        for output in self.voice_last_outputs.iter_mut() {
            *output = 0.0;
        }
        self.last_gate_value = 0.0;
        // Reset scratch buffers if necessary (might not be needed if process always overwrites)
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
            // Optionally reset state when deactivated
            self.reset();
        }
    }

    fn node_type(&self) -> &str {
        "wavetable_oscillator"
    }
}
