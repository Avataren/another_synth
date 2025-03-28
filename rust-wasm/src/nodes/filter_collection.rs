#![allow(clippy::excessive_precision)]
#![allow(clippy::inline_always)]

use once_cell::sync::Lazy;
use rustfft::num_traits::Float;
use rustfft::{num_complex::Complex, FftPlanner}; // Still needed for frequency response
use std::any::Any;
use std::collections::HashMap;
use std::f32::consts::PI;
use std::f64::consts::PI as PI64; // Use f64 PI for coefficient calculation
use wasm_bindgen::prelude::wasm_bindgen;

// Import necessary items from other modules (adjust paths as needed)
use crate::biquad::{Biquad, CascadedBiquad, Filter, FilterType};
use crate::graph::{
    ModulationProcessor, ModulationSource, ModulationTransformation, ModulationType,
};
use crate::traits::{AudioNode, PortId};

/// Biquad‑specific slope selection.
#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FilterSlope {
    Db12,
    Db24,
}

/// Helper: map a normalized resonance (0–1) to a Q factor for Biquad filters.
#[inline(always)]
fn normalized_resonance_to_q(normalized: f32) -> f32 {
    let norm_clamped = normalized.clamp(0.0, 1.0);
    0.707 + norm_clamped.powf(1.5) * 9.3
}

/// Fast tanh approximation using a precomputed lookup table with linear interpolation.
static TANH_LUT: Lazy<[f32; 1024]> = Lazy::new(|| {
    let mut lut = [0.0; 1024];
    let x_min = -5.0;
    let x_max = 5.0;
    let step = (x_max - x_min) / 1023.0;
    for i in 0..1024 {
        let x = x_min + i as f32 * step;
        lut[i] = x.tanh();
    }
    lut
});

#[inline(always)]
fn fast_tanh(x: f32) -> f32 {
    const LUT_SIZE_MINUS_1_F: f32 = 1023.0;
    const LUT_SIZE_MINUS_1_U: usize = 1023;
    const X_MIN: f32 = -5.0;
    const X_MAX: f32 = 5.0;
    const INV_RANGE: f32 = 1.0 / (X_MAX - X_MIN);

    let clamped = x.clamp(X_MIN, X_MAX);
    let normalized = (clamped - X_MIN) * INV_RANGE * LUT_SIZE_MINUS_1_F;
    let index_f = normalized.floor();
    let index = index_f as usize;
    let frac = normalized - index_f;

    let y0 = TANH_LUT[index];
    if index < LUT_SIZE_MINUS_1_U {
        let y1 = TANH_LUT[index + 1];
        y0 + (y1 - y0) * frac
    } else {
        y0
    }
}

// Removed MAX_OVERSAMPLING

/// Precomputed maximum delay line length for the comb filter.
/// Adjusted to not depend on oversampling. Uses a reasonable max sample rate.
static MAX_COMB_BUFFER_SIZE: Lazy<usize> = Lazy::new(|| {
    let sample_rate = 96000.0; // Assume a max practical sample rate for sizing
    let min_freq = 10.0;
    (sample_rate / min_freq).ceil() as usize + 8 // Removed os_factor multiplication
});

// --- Removed DecimationFilter ---
// --- Removed Upsampler ---

// --- Filter Collection (Simplified) ---
#[derive(Clone)]
pub struct FilterCollection {
    sample_rate: f32,
    base_cutoff: f32,
    base_resonance: f32,
    base_gain_db: f32,
    comb_base_frequency: f32,
    comb_dampening: f32,
    keyboard_tracking_sensitivity: f32,
    filter_type: FilterType,
    slope: FilterSlope,
    // Removed oversampling_factor
    // Removed use_linear_upsampling
    enabled: bool,

    smoothed_cutoff: f32,
    smoothed_resonance: f32,
    smoothing_factor: f32,

    biquad: Biquad,
    cascaded: Option<CascadedBiquad>,
    ladder_stages: [f32; 4],

    comb_buffer: Vec<f32>,
    comb_buffer_index: usize,
    comb_last_output: f32,
    comb_dc_prev: f32,
    comb_dc_state: f32,

    // Removed aa_downsampling_filter
    // Removed upsampler_state
    mod_scratch_add: Vec<f32>,
    mod_scratch_mult: Vec<f32>,
    audio_in_buffer: Vec<f32>,
    scratch_cutoff_add: Vec<f32>,
    scratch_cutoff_mult: Vec<f32>,
    scratch_res_add: Vec<f32>,
    scratch_res_mult: Vec<f32>,
    scratch_freq_add: Vec<f32>,
    scratch_freq_mult: Vec<f32>,
    scratch_global_freq_add: Vec<f32>,
    scratch_global_freq_mult: Vec<f32>,
}

impl FilterCollection {
    pub fn new(sample_rate: f32) -> Self {
        let initial_capacity = 128;
        let base_cutoff = 20000.0;
        let base_resonance = 0.0;
        let base_gain_db = 0.0;
        let comb_base_frequency = 220.0;
        let filter_type = FilterType::LowPass;
        let slope = FilterSlope::Db12;
        let initial_q = normalized_resonance_to_q(base_resonance);

        Self {
            sample_rate,
            base_cutoff,
            base_resonance,
            base_gain_db,
            comb_base_frequency,
            comb_dampening: 0.5,
            keyboard_tracking_sensitivity: 0.0,
            filter_type,
            slope,
            // Removed oversampling_factor
            // Removed use_linear_upsampling
            enabled: true,
            smoothed_cutoff: base_cutoff,
            smoothed_resonance: base_resonance,
            smoothing_factor: 0.05,
            // Initialize biquad directly with base sample_rate
            biquad: Biquad::new(
                filter_type,
                sample_rate, // Use base sample rate
                base_cutoff,
                initial_q,
                base_gain_db,
            ),
            cascaded: None, // Cascaded filter setup happens later if needed
            ladder_stages: [0.0; 4],
            comb_buffer: vec![0.0; *MAX_COMB_BUFFER_SIZE],
            comb_buffer_index: 0,
            comb_last_output: 0.0,
            comb_dc_prev: 0.0,
            comb_dc_state: 0.0,
            // Removed aa_downsampling_filter initialization
            // Removed upsampler_state initialization
            mod_scratch_add: vec![0.0; initial_capacity],
            mod_scratch_mult: vec![1.0; initial_capacity],
            audio_in_buffer: vec![0.0; initial_capacity],
            scratch_cutoff_add: vec![0.0; initial_capacity],
            scratch_cutoff_mult: vec![1.0; initial_capacity],
            scratch_res_add: vec![0.0; initial_capacity],
            scratch_res_mult: vec![1.0; initial_capacity],
            scratch_freq_add: vec![440.0; initial_capacity],
            scratch_freq_mult: vec![1.0; initial_capacity],
            scratch_global_freq_add: vec![440.0; initial_capacity],
            scratch_global_freq_mult: vec![1.0; initial_capacity],
        }
    }

    // Ensure scratch buffers are large enough
    fn ensure_scratch_buffers(&mut self, size: usize) {
        let mut resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
            if buf.len() < size {
                let new_size = size.next_power_of_two();
                buf.resize(new_size, default_val);
            }
        };
        resize_if_needed(&mut self.mod_scratch_add, 0.0);
        resize_if_needed(&mut self.mod_scratch_mult, 1.0);
        resize_if_needed(&mut self.audio_in_buffer, 0.0);
        resize_if_needed(&mut self.scratch_cutoff_add, 0.0);
        resize_if_needed(&mut self.scratch_cutoff_mult, 1.0);
        resize_if_needed(&mut self.scratch_res_add, 0.0);
        resize_if_needed(&mut self.scratch_res_mult, 1.0);
        resize_if_needed(&mut self.scratch_freq_add, 440.0);
        resize_if_needed(&mut self.scratch_freq_mult, 1.0);
        resize_if_needed(&mut self.scratch_global_freq_add, 440.0);
        resize_if_needed(&mut self.scratch_global_freq_mult, 1.0);
    }

    // Removed update_aa_filters
    // Removed set_oversampling_factor
    // Removed set_linear_upsampling

    // Updates base filter parameters
    pub fn set_params(&mut self, cutoff: f32, resonance: f32) {
        // Clamp cutoff to base sample rate Nyquist limit
        self.base_cutoff = cutoff.clamp(10.0, self.sample_rate * 0.4999);
        self.base_resonance = resonance.max(0.0);
    }

    pub fn set_gain_db(&mut self, gain_db: f32) {
        self.base_gain_db = gain_db;
    }

    pub fn set_keyboard_tracking_sensitivity(&mut self, sensitivity: f32) {
        self.keyboard_tracking_sensitivity = sensitivity.clamp(0.0, 1.0);
    }

    // Sets the core filter algorithm type
    pub fn set_filter_type(&mut self, filter_type: FilterType) {
        if filter_type != self.filter_type {
            self.filter_type = filter_type;
            self.reset_filter_state(); // Reset state when type changes
                                       // Re-setup cascaded if needed for the new type and current slope
            if filter_type != FilterType::Ladder
                && filter_type != FilterType::Comb
                && self.slope == FilterSlope::Db24
            {
                self.setup_cascaded_filter();
            } else {
                self.cascaded = None; // Not applicable or handled differently
            }
        }
    }

    // Sets the filter slope (12dB or 24dB)
    pub fn set_filter_slope(&mut self, slope: FilterSlope) {
        if slope != self.slope {
            let old_slope = self.slope;
            self.slope = slope;
            // Only manage cascaded biquad setup if NOT Ladder or Comb
            if self.filter_type != FilterType::Ladder && self.filter_type != FilterType::Comb {
                if slope == FilterSlope::Db24 && old_slope == FilterSlope::Db12 {
                    self.setup_cascaded_filter(); // Create cascaded for 24dB
                    if let Some(ref mut c) = self.cascaded {
                        c.reset(); // Reset the new cascaded filter state
                    }
                } else if slope == FilterSlope::Db12 && old_slope == FilterSlope::Db24 {
                    self.cascaded = None; // Remove cascaded for 12dB
                    self.biquad.reset(); // Reset the single biquad state
                }
            }
            // If type is Ladder or Comb, slope might be ignored or handled internally,
            // but we still reset state for consistency if slope changes.
            self.reset_filter_state();
        }
    }

    // Sets up the cascaded biquad filter for 24dB slope (if applicable)
    fn setup_cascaded_filter(&mut self) {
        // Only setup if 24dB slope AND not Ladder/Comb type
        if self.slope != FilterSlope::Db24
            || self.filter_type == FilterType::Ladder
            || self.filter_type == FilterType::Comb
        {
            self.cascaded = None;
            return;
        }

        // Use base sample rate directly
        let sr = self.sample_rate;
        let q_overall = normalized_resonance_to_q(self.smoothed_resonance);
        // Calculate Q for each stage (sqrt of overall Q, minimum value for stability)
        let stage_q = q_overall.sqrt().max(0.501);

        if let Some(ref mut cascaded) = self.cascaded {
            // Update existing cascaded filter parameters
            cascaded.first.sample_rate = sr;
            cascaded.second.sample_rate = sr;
            cascaded.first.frequency = self.smoothed_cutoff;
            cascaded.second.frequency = self.smoothed_cutoff;
            cascaded.first.q = stage_q;
            cascaded.second.q = stage_q;
            cascaded.first.gain_db = 0.0; // Gain usually applied on the second stage
            cascaded.second.gain_db = self.base_gain_db;
            cascaded.first.filter_type = self.filter_type;
            cascaded.second.filter_type = self.filter_type;
            cascaded.first.update_coefficients();
            cascaded.second.update_coefficients();
        } else {
            // Create a new cascaded filter
            self.cascaded = Some(CascadedBiquad::new_with_gain_split(
                self.filter_type,
                sr,
                self.smoothed_cutoff,
                stage_q,
                0.0,               // Gain on first stage
                self.base_gain_db, // Gain on second stage
            ));
            // Ensure the new filter starts clean
            if let Some(ref mut c) = self.cascaded {
                c.reset();
            }
        }
    }

    // Set parameters specific to the Comb filter
    pub fn set_comb_target_frequency(&mut self, freq: f32) {
        self.comb_base_frequency = freq.clamp(10.0, self.sample_rate * 0.499);
    }

    pub fn set_comb_dampening(&mut self, dampening: f32) {
        self.comb_dampening = dampening.clamp(0.0, 1.0);
    }

    // Resets the internal state of all active filter components
    fn reset_filter_state(&mut self) {
        self.biquad.reset();
        if let Some(ref mut cascaded) = self.cascaded {
            cascaded.reset();
        }
        self.ladder_stages = [0.0; 4];
        self.comb_buffer.fill(0.0);
        self.comb_buffer_index = 0;
        self.comb_last_output = 0.0;
        self.comb_dc_prev = 0.0;
        self.comb_dc_state = 0.0;
        // Removed reset calls for aa_downsampling_filter and upsampler_state
    }

    // Process a single sample using the Ladder filter algorithm
    #[inline(always)]
    fn process_ladder_sample(
        &mut self,
        input: f32,
        cutoff: f32,
        resonance_norm: f32,
        sample_rate: f32, // Use base sample rate
    ) -> f32 {
        // Moog Ladder Filter calculation (simplified)
        let g = (PI * cutoff / sample_rate).tan(); // Use base sample rate
        let g_inv = 1.0 / (1.0 + g);
        let k = resonance_norm.max(0.0) * 4.0; // Resonance feedback gain

        // Calculate stage input with feedback
        let stage_input = input - k * self.ladder_stages[3]; // Feedback from the last stage

        // Apply tanh approximation (non-linearity)
        let v0 = fast_tanh(stage_input);
        let v1 = fast_tanh(self.ladder_stages[0]);
        let v2 = fast_tanh(self.ladder_stages[1]);
        let v3 = fast_tanh(self.ladder_stages[2]);
        let v4 = fast_tanh(self.ladder_stages[3]);

        // Update stages using one-pole filters
        self.ladder_stages[0] += 2.0 * g * (v0 - v1) * g_inv;
        self.ladder_stages[1] += 2.0 * g * (v1 - v2) * g_inv;
        self.ladder_stages[2] += 2.0 * g * (v2 - v3) * g_inv;
        self.ladder_stages[3] += 2.0 * g * (v3 - v4) * g_inv;

        // Output is the final stage
        let output = self.ladder_stages[3];

        // Apply overall gain
        output * 10f32.powf(self.base_gain_db / 20.0)
    }

    // Process a single sample using the Comb filter algorithm
    #[inline(always)]
    fn process_comb_sample(
        &mut self,
        input: f32,
        freq: f32,
        resonance_norm: f32,
        sample_rate: f32, // Use base sample rate
                          // Removed os_factor parameter
    ) -> f32 {
        // Calculate delay time in samples based on frequency
        let delay_samples = (sample_rate / freq.max(1.0)).max(2.0); // Use base sample rate

        let clamped_res = resonance_norm.max(0.0);
        // Removed substep_resonance calculation

        let clamped_dampening = self.comb_dampening.clamp(0.0, 1.0);
        // Removed substep_dampening_coeff calculation

        let alpha = clamped_dampening; // Damping filter coefficient

        // Calculate read indices for fractional delay interpolation
        let delay_floor = delay_samples.floor();
        let delay_frac = delay_samples - delay_floor;
        let delay_int = delay_floor as usize;

        let buf_len = self.comb_buffer.len();
        let read_idx0 = (self.comb_buffer_index + buf_len - delay_int) % buf_len;
        let read_idx1 = (self.comb_buffer_index + buf_len - (delay_int + 1)) % buf_len;

        // Linear interpolation for fractional delay
        let y0 = self.comb_buffer[read_idx0];
        let y1 = self.comb_buffer[read_idx1];
        let delayed_sample = y0 + (y1 - y0) * delay_frac;

        // Apply damping (low-pass filtering) to the delayed signal before feedback
        self.comb_last_output = alpha * self.comb_last_output + (1.0 - alpha) * delayed_sample;

        // Calculate feedback amount
        let feedback = self.comb_last_output * clamped_res; // Use direct resonance

        // Calculate value to write into the buffer (input + feedback)
        let buffer_write_val = input + feedback;

        // Write to comb buffer and advance write index
        self.comb_buffer[self.comb_buffer_index] = buffer_write_val;
        self.comb_buffer_index = (self.comb_buffer_index + 1) % buf_len;

        // Output of the comb filter is the value just written (can be configured differently)
        let comb_output = buffer_write_val;

        // Simple DC blocking filter on the output
        let filtered_output = comb_output - self.comb_dc_prev + 0.995 * self.comb_dc_state;
        self.comb_dc_prev = comb_output;
        self.comb_dc_state = filtered_output;

        filtered_output
    }

    // Process a single sample using the Biquad or Cascaded Biquad filter
    #[inline(always)]
    fn process_biquad_sample(
        &mut self,
        input: f32,
        cutoff: f32,
        resonance_norm: f32,
        sample_rate: f32, // Use base sample rate
    ) -> f32 {
        let q = normalized_resonance_to_q(resonance_norm.clamp(0.0, 1.0));

        // Check if the main biquad parameters need updating
        let biquad_needs_update = self.biquad.sample_rate != sample_rate
            || (self.biquad.frequency - cutoff).abs() > 1e-3
            || (self.biquad.q - q).abs() > 1e-3
            || self.biquad.gain_db != self.base_gain_db // Gain check needed for 12dB mode
            || self.biquad.filter_type != self.filter_type;

        // Update the single biquad if needed (always used as fallback or for 12dB)
        if biquad_needs_update {
            self.biquad.sample_rate = sample_rate;
            self.biquad.frequency = cutoff;
            self.biquad.q = q;
            // Gain applied differently depending on slope
            self.biquad.gain_db = if self.slope == FilterSlope::Db12 {
                self.base_gain_db // Apply full gain on single biquad for 12dB
            } else {
                0.0 // No gain if it's the first stage of a (potential) 24dB filter
            };
            self.biquad.filter_type = self.filter_type;
            self.biquad.update_coefficients();
        }

        match self.slope {
            FilterSlope::Db12 => {
                // Use the single biquad for 12dB slope
                self.biquad.process(input)
            }
            FilterSlope::Db24 => {
                // Use cascaded biquad for 24dB slope
                let stage_q = q.sqrt().max(0.501); // Q for each of the two stages

                // Check if cascaded filter needs setup or update
                let needs_setup_or_update = match self.cascaded {
                    None => true, // Needs setup if it doesn't exist
                    Some(ref c) => {
                        // Check if parameters differ significantly
                        c.first.sample_rate != sample_rate
                            || (c.first.frequency - cutoff).abs() > 1e-3
                            || (c.first.q - stage_q).abs() > 1e-3
                            || c.second.gain_db != self.base_gain_db // Gain is on second stage
                            || c.first.filter_type != self.filter_type
                    }
                };

                if needs_setup_or_update {
                    // Use setup_cascaded_filter which uses smoothed parameters initially
                    self.setup_cascaded_filter();

                    // Explicitly update the cascaded filter with current (non-smoothed) values
                    if let Some(ref mut cascaded) = self.cascaded {
                        cascaded.first.sample_rate = sample_rate;
                        cascaded.second.sample_rate = sample_rate;
                        cascaded.first.frequency = cutoff;
                        cascaded.second.frequency = cutoff;
                        cascaded.first.q = stage_q;
                        cascaded.second.q = stage_q;
                        cascaded.first.gain_db = 0.0; // No gain on first stage
                        cascaded.second.gain_db = self.base_gain_db; // Full gain on second stage
                        cascaded.first.filter_type = self.filter_type;
                        cascaded.second.filter_type = self.filter_type;
                        cascaded.first.update_coefficients();
                        cascaded.second.update_coefficients();
                    }
                }

                // Process through the cascaded filter if available, otherwise fallback (shouldn't happen if setup is correct)
                if let Some(ref mut cascaded) = self.cascaded {
                    cascaded.process(input)
                } else {
                    // Fallback to single biquad process - indicates an issue in logic if reached in 24dB mode
                    // For safety, process using the single biquad (effectively 12dB)
                    self.biquad.process(input)
                }
            }
        }
    }
}

impl ModulationProcessor for FilterCollection {}

impl AudioNode for FilterCollection {
    // Define input and output ports
    fn get_ports(&self) -> HashMap<PortId, bool> {
        [
            (PortId::AudioInput0, false),     // Input, not an output
            (PortId::CutoffMod, false),       // Input
            (PortId::ResonanceMod, false),    // Input
            (PortId::Frequency, false),       // Input (for key tracking)
            (PortId::GlobalFrequency, false), // Input (for global pitch)
            (PortId::AudioOutput0, true),     // Output
        ]
        .iter()
        .cloned()
        .collect()
    }

    // Main audio processing block
    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // If the filter is disabled, output silence and return
        if !self.enabled {
            if let Some(output_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                output_buffer[..buffer_size].fill(0.0);
            }
            return;
        }

        // Make sure internal scratch buffers are large enough
        self.ensure_scratch_buffers(buffer_size);

        // Get the output buffer slice
        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buffer) => buffer,
            None => return, // No output buffer provided, nothing to do
        };

        // --- 1. Prepare Input Audio Buffer ---
        // Clear or fill with input audio
        self.audio_in_buffer[..buffer_size].fill(0.0); // Start with silence
        if let Some(audio_sources) = inputs.get(&PortId::AudioInput0) {
            // Accumulate audio from all connected sources
            for source in audio_sources {
                Self::apply_add(
                    &source.buffer,                           // Source audio buffer
                    &mut self.audio_in_buffer[..buffer_size], // Target buffer
                    source.amount,         // Modulation amount (usually 1.0 for audio)
                    source.transformation, // Transformation (usually None for audio)
                );
            }
        }

        // --- 2. Prepare Modulation Buffers ---
        // Helper function to process modulation inputs for a given port
        let mut process_mod_input = |port_id: PortId,
                                     target_add: &mut [f32],
                                     target_mult: &mut [f32],
                                     default_add: f32,
                                     default_mult: f32| {
            let sources = inputs.get(&port_id);
            // If there are modulation sources connected to this port
            if sources.map_or(false, |s| !s.is_empty()) {
                // Accumulate modulation values into temporary scratch buffers
                Self::accumulate_modulations_inplace(
                    buffer_size,
                    sources.map(|v| v.as_slice()), // Get sources as slice if present
                    &mut self.mod_scratch_add,     // Temp buffer for additive mods
                    &mut self.mod_scratch_mult,    // Temp buffer for multiplicative mods
                );
                // Copy results to the specific target buffers for this parameter
                target_add[..buffer_size].copy_from_slice(&self.mod_scratch_add[..buffer_size]);
                target_mult[..buffer_size].copy_from_slice(&self.mod_scratch_mult[..buffer_size]);
            } else {
                // No sources connected, fill with default values (no modulation)
                target_add[..buffer_size].fill(default_add);
                target_mult[..buffer_size].fill(default_mult);
            }
        };

        // Process modulation for Cutoff, Resonance, and Frequency (for tracking)
        process_mod_input(
            PortId::CutoffMod,             // Port ID
            &mut self.scratch_cutoff_add,  // Target additive buffer
            &mut self.scratch_cutoff_mult, // Target multiplicative buffer
            0.0,                           // Default add value
            1.0,                           // Default mult value
        );
        process_mod_input(
            PortId::ResonanceMod,
            &mut self.scratch_res_add,
            &mut self.scratch_res_mult,
            0.0,
            1.0,
        );
        process_mod_input(
            PortId::Frequency, // For per-voice key tracking
            &mut self.scratch_freq_add,
            &mut self.scratch_freq_mult,
            440.0, // Default frequency (A4)
            1.0,
        );
        process_mod_input(
            PortId::GlobalFrequency, // For global pitch/tuning affecting tracking
            &mut self.scratch_global_freq_add,
            &mut self.scratch_global_freq_mult,
            440.0, // Default global frequency (A4)
            1.0,
        );

        // --- 3. Process Audio Samples ---
        // Removed os_factor and effective_sr calculation
        let sample_rate = self.sample_rate;
        let base_440_hz = 440.0; // Reference frequency for tracking calculations
        let smoothing_factor = self.smoothing_factor; // Parameter smoothing coefficient

        // Removed upsample_fn

        // Process each sample in the buffer
        for i in 0..buffer_size {
            // --- Calculate Target Parameters for this sample ---
            // Apply modulation to base cutoff and resonance
            let target_cutoff_base =
                (self.base_cutoff + self.scratch_cutoff_add[i]) * self.scratch_cutoff_mult[i];
            let target_resonance_norm =
                (self.base_resonance + self.scratch_res_add[i]) * self.scratch_res_mult[i];

            // Calculate keyboard tracking multiplier
            let key_freq = self.scratch_freq_add[i].max(10.0); // Per-voice frequency
            let global_freq = self.scratch_global_freq_add[i].max(10.0); // Global reference freq
            let key_ratio = key_freq / base_440_hz; // Ratio relative to A4
            let global_ratio = global_freq / base_440_hz; // Global ratio relative to A4
                                                          // Combine ratios based on sensitivity
            let tracking_multiplier =
                key_ratio.powf(self.keyboard_tracking_sensitivity) * global_ratio;

            // Calculate final target cutoff and clamp to Nyquist limit
            // Use base sample rate Nyquist limit
            let max_freq_limit = sample_rate * 0.499;
            let target_cutoff =
                (target_cutoff_base * tracking_multiplier).clamp(10.0, max_freq_limit);

            // Calculate target frequency for Comb filter (if used)
            let target_comb_freq =
                (self.comb_base_frequency * tracking_multiplier).clamp(10.0, max_freq_limit);

            // Clamp resonance (allow slightly above 1.0 for potential extreme effects)
            let target_resonance_clamped = target_resonance_norm.clamp(0.0, 1.05);

            // --- Smooth Parameters ---
            // Apply simple one-pole smoothing to cutoff and resonance
            self.smoothed_cutoff += smoothing_factor * (target_cutoff - self.smoothed_cutoff);
            self.smoothed_cutoff = self.smoothed_cutoff.clamp(10.0, max_freq_limit); // Re-clamp after smoothing

            self.smoothed_resonance +=
                smoothing_factor * (target_resonance_clamped - self.smoothed_resonance);
            self.smoothed_resonance = self.smoothed_resonance.clamp(0.0, 1.05); // Re-clamp

            // --- Process Single Sample ---
            let input_sample = self.audio_in_buffer[i];
            // Removed oversampling loop
            // Removed call to upsample_fn

            // Call the appropriate filter processing function based on type
            let current_output = match self.filter_type {
                FilterType::Ladder => self.process_ladder_sample(
                    input_sample,
                    self.smoothed_cutoff,
                    self.smoothed_resonance,
                    sample_rate, // Pass base sample rate
                ),
                FilterType::Comb => self.process_comb_sample(
                    input_sample,
                    target_comb_freq, // Comb uses target freq directly (less sensitive to smoothing artifacts)
                    self.smoothed_resonance,
                    sample_rate, // Pass base sample rate
                ),
                _ => self.process_biquad_sample(
                    // Handles LowPass, HighPass, etc.
                    input_sample,
                    self.smoothed_cutoff,
                    self.smoothed_resonance,
                    sample_rate, // Pass base sample rate
                ),
            };

            // --- Final Output ---
            // Removed decimation filter processing
            let final_output = current_output; // No downsampling needed

            // Write the final processed sample to the output buffer
            output_buffer[i] = final_output;
        }
    }

    // Reset filter state and smoothed parameters
    fn reset(&mut self) {
        self.reset_filter_state(); // Reset internal filter states (biquad, ladder, comb)
                                   // Reset smoothed parameters to base values
        self.smoothed_cutoff = self.base_cutoff;
        self.smoothed_resonance = self.base_resonance;
    }

    // --- Boilerplate for AudioNode trait ---
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn is_active(&self) -> bool {
        self.enabled
    }
    fn set_active(&mut self, active: bool) {
        if !active && self.enabled {
            // If becoming inactive, reset state
            self.reset();
        }
        self.enabled = active;
    }
    fn node_type(&self) -> &str {
        "filtercollection"
    }
}

// --- Frequency Response Generation Methods (Simplified) ---
impl FilterCollection {
    // Generates a frequency response curve for visualization
    pub fn generate_frequency_response(&self, requested_length: usize) -> Vec<f32> {
        // 1. Get Impulse Response
        // Use a sufficient length for FFT resolution, max with requested * 4
        let impulse_length = 4096.max(requested_length * 4);
        let impulse = self.create_impulse_response(impulse_length);

        // 2. Calculate FFT Magnitude Spectrum
        let fft_magnitude_db = self.calculate_fft_magnitude(impulse);

        // 3. Interpolate FFT results onto a Logarithmic Scale for display
        let nyquist_hz = self.sample_rate * 0.5;
        let max_freq_hz = 20_000.0_f32.min(nyquist_hz); // Display up to 20kHz or Nyquist
        let min_freq_hz = 20.0_f32; // Start display from 20Hz
        let fft_bins = fft_magnitude_db.len(); // Number of bins (FFT length / 2)

        // Calculate corresponding FFT bin indices for min/max display frequencies
        let bin_max =
            (max_freq_hz * (fft_bins as f32 * 2.0) / self.sample_rate).min(fft_bins as f32 - 1.0);
        let bin_min = (min_freq_hz * (fft_bins as f32 * 2.0) / self.sample_rate).max(0.0);

        let points = requested_length; // Number of points for the final response curve
        let mut response_db_interpolated = Vec::with_capacity(points);

        // Calculate logarithmic range for interpolation
        let log_bin_min = (bin_min.max(0.0) + 1.0).ln(); // Add 1 to avoid log(0)
        let log_bin_max = (bin_max.max(0.0) + 1.0).ln();
        let log_range = (log_bin_max - log_bin_min).max(0.0);

        // Interpolate magnitude values at logarithmically spaced points
        for i in 0..points {
            // Determine position on the logarithmic scale (0.0 to 1.0)
            let factor = if points > 1 {
                i as f32 / (points - 1) as f32
            } else {
                0.0 // Avoid division by zero if only one point requested
            };
            // Map log factor back to linear bin index
            let log_bin = log_bin_min + log_range * factor;
            let bin = log_bin.exp() - 1.0; // Subtract 1 back

            // Find surrounding FFT bins and interpolation fraction
            let bin_floor = (bin.floor().max(0.0) as usize).min(fft_bins.saturating_sub(1));
            let bin_ceil = (bin_floor + 1).min(fft_bins.saturating_sub(1));
            let frac = bin - bin_floor as f32;

            // Perform linear interpolation between dB magnitudes of surrounding bins
            let db_val =
                if bin_floor >= fft_magnitude_db.len() || bin_ceil >= fft_magnitude_db.len() {
                    // Handle edge case where calculated bin is out of bounds
                    *fft_magnitude_db.last().unwrap_or(&-120.0) // Default to last value or silence
                } else if bin_floor == bin_ceil {
                    // If bin falls exactly on an index
                    fft_magnitude_db[bin_floor]
                } else {
                    // Linear interpolation
                    fft_magnitude_db[bin_floor] * (1.0 - frac) + fft_magnitude_db[bin_ceil] * frac
                };
            response_db_interpolated.push(db_val);
        }

        // 4. Normalize the interpolated dB values to a 0.0-1.0 range for display
        self.normalize_for_display_range(response_db_interpolated, -60.0, 18.0) // e.g., -60dB to +18dB range
    }

    // Normalizes dB values to a 0.0-1.0 range based on floor and ceiling
    fn normalize_for_display_range(
        &self,
        mut data: Vec<f32>,
        db_floor: f32,
        db_ceiling: f32,
    ) -> Vec<f32> {
        let range = (db_ceiling - db_floor).max(1e-6); // Avoid division by zero
        for value in &mut data {
            // Clamp dB value to the display range
            let clamped_db = value.clamp(db_floor, db_ceiling);
            // Normalize to 0.0 - 1.0
            *value = (clamped_db - db_floor) / range;
        }
        data
    }

    // Creates the impulse response of the filter with current settings
    fn create_impulse_response(&self, length: usize) -> Vec<f32> {
        // Create a temporary copy of the filter to avoid modifying the main state
        let mut temp_filter = FilterCollection::new(self.sample_rate);
        temp_filter.base_cutoff = self.base_cutoff;
        temp_filter.base_resonance = self.base_resonance;
        temp_filter.base_gain_db = self.base_gain_db;
        temp_filter.comb_base_frequency = self.comb_base_frequency;
        temp_filter.comb_dampening = self.comb_dampening;
        temp_filter.filter_type = self.filter_type;
        temp_filter.slope = self.slope;
        temp_filter.keyboard_tracking_sensitivity = self.keyboard_tracking_sensitivity;
        // Set smoothed params directly to base values for impulse response generation
        temp_filter.smoothed_cutoff = self.base_cutoff;
        temp_filter.smoothed_resonance = self.base_resonance;
        // No oversampling params to set
        // No aa_filters to update

        // Ensure filter type and slope (and potentially cascaded setup) are correct
        temp_filter.set_filter_type(self.filter_type);
        temp_filter.set_filter_slope(self.slope); // This will handle cascaded setup if needed
        temp_filter.reset_filter_state(); // Start from a clean state

        let mut response = Vec::with_capacity(length);
        let sample_rate = temp_filter.sample_rate; // Use base sample rate
        let impulse_comb_freq = temp_filter.comb_base_frequency; // Use base comb freq

        // Removed os_factor, effective_sr, upsample_fn

        // Generate response by processing an impulse
        for i in 0..length {
            let input = if i == 0 { 1.0 } else { 0.0 }; // Impulse at time 0

            // Removed oversampling loop
            // Removed upsampling call

            // Process the single sample directly
            let current_output = match temp_filter.filter_type {
                FilterType::Ladder => temp_filter.process_ladder_sample(
                    input,
                    temp_filter.smoothed_cutoff, // Use non-modulated cutoff
                    temp_filter.smoothed_resonance, // Use non-modulated resonance
                    sample_rate,                 // Pass base sample rate
                ),
                FilterType::Comb => temp_filter.process_comb_sample(
                    input,
                    impulse_comb_freq, // Use non-modulated comb freq
                    temp_filter.smoothed_resonance,
                    sample_rate, // Pass base sample rate
                ),
                _ => temp_filter.process_biquad_sample(
                    input,
                    temp_filter.smoothed_cutoff,
                    temp_filter.smoothed_resonance,
                    sample_rate, // Pass base sample rate
                ),
            };

            // Removed decimation filter call
            let final_output = current_output;
            response.push(final_output);
        }
        response
    }

    // Calculates the FFT magnitude spectrum (in dB) from an impulse response
    fn calculate_fft_magnitude(&self, impulse_response: Vec<f32>) -> Vec<f32> {
        let fft_length = impulse_response.len();
        if fft_length == 0 {
            return vec![]; // Handle empty input
        }

        // Setup FFT planner
        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(fft_length);

        // Prepare buffer for FFT (convert real impulse response to complex)
        let mut buffer: Vec<Complex<f32>> = impulse_response
            .into_iter()
            .map(|x| Complex { re: x, im: 0.0 })
            .collect();

        // Perform FFT
        fft.process(&mut buffer);

        // Calculate magnitude in dB for the first half of the spectrum (positive frequencies)
        let half_len = fft_length / 2;
        let epsilon = 1e-10; // Small value to avoid log10(0)
        let magnitude_db: Vec<f32> = buffer
            .iter()
            .take(half_len) // Only need the first half (up to Nyquist)
            .map(|c| {
                let norm_sq = c.norm_sqr(); // Magnitude squared (re*re + im*im)
                10.0 * (norm_sq + epsilon).log10() // Convert to dB: 10 * log10(magnitude^2)
            })
            .collect();

        magnitude_db
    }
}

// =======================================================================
// Unit Tests (Adjusted for Non-Oversampled Filter)
// =======================================================================

#[cfg(test)]
mod tests {
    use super::*;
    use rustfft::{num_complex::Complex, FftPlanner};
    use std::f32::consts::PI;

    const TEST_SAMPLE_RATE: f32 = 48000.0;
    const FFT_LEN: usize = 8192; // Good resolution for FFT tests

    // Helper to get magnitude at a specific frequency from FFT results (linear interpolation)
    fn get_fft_magnitude_at_freq(
        fft_magnitudes_db: &[f32],
        freq_hz: f32,
        sample_rate: f32,
        fft_len: usize,
    ) -> Option<f32> {
        if fft_magnitudes_db.is_empty() {
            return None;
        }
        let bin_index_f = freq_hz * fft_len as f32 / sample_rate;
        let bin_index0 = bin_index_f.floor() as usize;
        // Ensure indices are within bounds
        let bin_index1 = (bin_index0 + 1).min(fft_magnitudes_db.len() - 1);
        let bin_index0 = bin_index0.min(fft_magnitudes_db.len() - 1); // Clamp lower bound too

        let frac = bin_index_f - bin_index0 as f32;

        // Linear interpolation between bins
        let mag0 = fft_magnitudes_db[bin_index0];
        let mag1 = fft_magnitudes_db[bin_index1];
        Some(mag0 + (mag1 - mag0) * frac)
    }

    #[test]
    fn test_filter_collection_lowpass_response_12db() {
        let cutoff_hz = 1000.0;
        let resonance_norm = 0.0; // Q = 0.707

        // --- Create Filter ---
        let mut fc = FilterCollection::new(TEST_SAMPLE_RATE);
        // fc.set_oversampling_factor(1); // Not needed anymore
        fc.set_filter_type(FilterType::LowPass);
        fc.set_filter_slope(FilterSlope::Db12);
        fc.set_params(cutoff_hz, resonance_norm);
        fc.set_gain_db(0.0);
        fc.reset(); // Ensure smoothed params match base params immediately
        fc.smoothed_cutoff = cutoff_hz;
        fc.smoothed_resonance = resonance_norm;

        // --- Get Frequency Response ---
        let ir = fc.create_impulse_response(FFT_LEN);
        let mag_db = fc.calculate_fft_magnitude(ir);

        // --- Frequencies to Check ---
        let freq_passband = cutoff_hz * 0.1; // 100 Hz
        let freq_cutoff = cutoff_hz; // 1000 Hz
        let freq_stopband1 = cutoff_hz * 2.0; // 2000 Hz (1 octave above cutoff)
        let freq_stopband2 = cutoff_hz * 4.0; // 4000 Hz (2 octaves above cutoff)

        // --- Get Magnitudes at Check Frequencies ---
        let mag_pass =
            get_fft_magnitude_at_freq(&mag_db, freq_passband, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_cutoff =
            get_fft_magnitude_at_freq(&mag_db, freq_cutoff, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_stop1 =
            get_fft_magnitude_at_freq(&mag_db, freq_stopband1, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_stop2 =
            get_fft_magnitude_at_freq(&mag_db, freq_stopband2, TEST_SAMPLE_RATE, FFT_LEN).unwrap();

        println!(
            "LPF 12dB Response @{:.1}Hz Res={:.2}: Pass={:.2}dB, Cutoff={:.2}dB, Stop1={:.2}dB, Stop2={:.2}dB",
            cutoff_hz, resonance_norm, mag_pass, mag_cutoff, mag_stop1, mag_stop2
        );

        // --- Assertions ---
        // Passband should be close to 0dB gain
        assert!(
            mag_pass.abs() < 1.0,
            "Passband gain ({:.2}dB) should be close to 0dB",
            mag_pass
        );

        // Cutoff frequency should be around -3dB for Q=0.707 (Butterworth)
        assert!(
            (mag_cutoff - -3.0).abs() < 1.0,
            "Cutoff gain ({:.2}dB) should be near -3dB",
            mag_cutoff
        );

        // Stopband attenuation should be approx -12dB per octave
        let attenuation1 = mag_pass - mag_stop1; // Attenuation from passband to 1 octave above cutoff
        assert!(
            (attenuation1 - 12.0).abs() < 2.0, // Allow some tolerance
            "Attenuation at 1 octave ({:.2}dB) should be near 12dB",
            attenuation1
        );

        let attenuation2 = mag_pass - mag_stop2; // Attenuation from passband to 2 octaves above cutoff
        assert!(
            (attenuation2 - 24.0).abs() < 3.0, // Allow slightly more tolerance further out
            "Attenuation at 2 octaves ({:.2}dB) should be near 24dB",
            attenuation2
        );
    }

    #[test]
    fn test_filter_collection_lowpass_response_24db_resonance() {
        let cutoff_hz = 1000.0;
        let resonance_norm = 0.7; // Higher resonance -> peak near cutoff
                                  // Calculate expected Q values based on helper function
        let q_overall = normalized_resonance_to_q(resonance_norm); // Approx 0.707 + 0.7^1.5 * 9.3 = 6.2
        let stage_q = q_overall.sqrt().max(0.501); // Approx 2.49

        // --- Create Filter ---
        let mut fc = FilterCollection::new(TEST_SAMPLE_RATE);
        fc.set_filter_type(FilterType::LowPass);
        fc.set_filter_slope(FilterSlope::Db24); // Use cascaded filter
        fc.set_params(cutoff_hz, resonance_norm);
        fc.set_gain_db(0.0); // Gain is applied internally in cascaded setup
        fc.reset();
        fc.smoothed_cutoff = cutoff_hz;
        fc.smoothed_resonance = resonance_norm;
        // Make sure cascaded filter is set up correctly after reset and setting params
        fc.setup_cascaded_filter();

        // --- Get Frequency Response ---
        let ir = fc.create_impulse_response(FFT_LEN);
        let mag_db = fc.calculate_fft_magnitude(ir);

        // --- Frequencies to Check ---
        let freq_passband = cutoff_hz * 0.1; // 100 Hz
        let freq_peak_near_cutoff = cutoff_hz * 0.95; // Check slightly below cutoff for peak
        let freq_cutoff = cutoff_hz; // 1000 Hz
        let freq_stopband1 = cutoff_hz * 2.0; // 2000 Hz (1 octave above cutoff)
        let freq_stopband2 = cutoff_hz * 4.0; // 4000 Hz (2 octaves above cutoff)

        // --- Get Magnitudes ---
        let mag_pass =
            get_fft_magnitude_at_freq(&mag_db, freq_passband, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_peak =
            get_fft_magnitude_at_freq(&mag_db, freq_peak_near_cutoff, TEST_SAMPLE_RATE, FFT_LEN)
                .unwrap();
        let mag_cutoff =
            get_fft_magnitude_at_freq(&mag_db, freq_cutoff, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_stop1 =
            get_fft_magnitude_at_freq(&mag_db, freq_stopband1, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_stop2 =
            get_fft_magnitude_at_freq(&mag_db, freq_stopband2, TEST_SAMPLE_RATE, FFT_LEN).unwrap();

        println!(
            "LPF 24dB Response @{:.1}Hz Res={:.2}: Pass={:.2}dB, Peak={:.2}dB, Cutoff={:.2}dB, Stop1={:.2}dB, Stop2={:.2}dB",
            cutoff_hz, resonance_norm, mag_pass, mag_peak, mag_cutoff, mag_stop1, mag_stop2
        );

        // --- Assertions ---
        // Passband still near 0dB
        assert!(
            mag_pass.abs() < 1.5, // Allow slightly more deviation due to resonance influence
            "Passband gain ({:.2}dB) should be close to 0dB",
            mag_pass
        );

        // Should be a peak near the cutoff due to high resonance
        // Theoretical peak for Q=6.2 is > 15dB. Let's check it's significantly positive.
        assert!(
            mag_peak > 10.0,
            "Expected resonant peak near cutoff ({:.2}dB), but peak is too low",
            mag_peak
        );

        // Magnitude AT cutoff frequency will be lower than the peak for high Q
        assert!(
            mag_cutoff < mag_peak,
            "Magnitude at cutoff ({:.2}dB) should be lower than peak ({:.2}dB)",
            mag_cutoff,
            mag_peak
        );

        // Stopband attenuation should be approx -24dB per octave
        // Measure attenuation from the peak for a more robust check with resonance
        let attenuation1 = mag_peak - mag_stop1;
        assert!(
            attenuation1 > 20.0, // Should be significantly more than 24dB below the *peak* 1 octave away
            "Attenuation at 1 octave below peak ({:.2}dB) is too low",
            attenuation1
        );

        let attenuation2 = mag_peak - mag_stop2;
        assert!(
            attenuation2 > 40.0, // Should be > 48dB below peak 2 octaves away
            "Attenuation at 2 octaves below peak ({:.2}dB) is too low",
            attenuation2
        );
    }

    // Add more tests for other filter types (HPF, BPF, Notch, Ladder, Comb)
    // Add tests for parameter smoothing, modulation, keyboard tracking if desired.
}
