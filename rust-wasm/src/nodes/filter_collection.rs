#![allow(clippy::excessive_precision)] // Allow high precision constants
#![allow(clippy::inline_always)] // Allow inline(always) where used intentionally

use once_cell::sync::Lazy;
use std::any::Any;
use std::collections::HashMap;
use std::f32::consts::PI;
// SIMD not used in the per-sample processing logic directly anymore
// use std::simd::num::SimdFloat;
// use std::simd::Simd;
use rustfft::{num_complex::Complex, FftPlanner}; // Ensure FFT is imported
use wasm_bindgen::prelude::wasm_bindgen;
// use web_sys::console; // For debugging

// Import the biquad types and modulation processing traits
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
    // Adjust Q mapping for better feel (subjective)
    // Example: 0 -> 0.707, 0.5 -> ~2.5, 1.0 -> ~10
    // Clamp input just in case
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
    let index = index_f as usize; // Cast is safe due to clamp and range
    let frac = normalized - index_f;

    // Use safe indexing, performance difference is likely negligible
    let y0 = TANH_LUT[index];
    if index < LUT_SIZE_MINUS_1_U {
        let y1 = TANH_LUT[index + 1];
        // Linear interpolation: y0 * (1.0 - frac) + y1 * frac
        y0 + (y1 - y0) * frac
    } else {
        // At the very end of the LUT (index == 1023)
        y0
    }
}

/// Maximum allowed oversampling factor.
static MAX_OVERSAMPLING: Lazy<u32> = Lazy::new(|| 16); // e.g., 16x

/// Precomputed maximum delay line length for the comb filter.
/// Increased margin slightly for safety with interpolation.
static MAX_COMB_BUFFER_SIZE: Lazy<usize> = Lazy::new(|| {
    let sample_rate = 48000.0; // Assume a common rate for sizing
    let min_freq = 10.0; // Lower min frequency for safety with longer delays
                         // Calculate max delay in samples = max_effective_sr / min_freq
    ((sample_rate * (*MAX_OVERSAMPLING as f32)) / min_freq).ceil() as usize + 8 // Add margin for interpolation & safety
});

// --- Fixed Anti-Aliasing / Decimation Filter ---
/// A 6th-order Butterworth lowpass filter implemented as 3 cascaded Biquads.
/// Used for anti-aliasing during downsampling in oversampling.
#[derive(Clone, Debug)]
struct DecimationFilter {
    sections: [Biquad; 3],
    os_factor: u32,
    sample_rate: f32,
}

impl DecimationFilter {
    /// Creates a new 6th order Butterworth anti-aliasing filter.
    /// `sample_rate`: The *original* sample rate (before oversampling).
    /// `os_factor`: The oversampling factor (e.g., 2, 4, 8).
    fn new(sample_rate: f32, os_factor: u32) -> Self {
        let os_factor = os_factor.max(1);
        let effective_sr = sample_rate * os_factor as f32;

        // Target cutoff frequency: slightly below original Nyquist
        // Ensure cutoff is well below effective Nyquist / 2
        let target_cutoff = (sample_rate * 0.5 * 0.9).min(effective_sr * 0.49);

        // Butterworth Q factors for 3 cascaded 2nd-order sections (6th order total)
        // Q values for sqrt(2) normalization at cutoff
        let q_factors = [0.517_638_1, 0.707_106_8, 1.931_851_7];

        let mut sections = [
            Biquad::new(
                FilterType::LowPass,
                effective_sr,
                target_cutoff,
                q_factors[0],
                0.0,
            ),
            Biquad::new(
                FilterType::LowPass,
                effective_sr,
                target_cutoff,
                q_factors[1],
                0.0,
            ),
            Biquad::new(
                FilterType::LowPass,
                effective_sr,
                target_cutoff,
                q_factors[2],
                0.0,
            ),
        ];

        // Ensure coefficients are calculated
        for section in &mut sections {
            section.update_coefficients();
        }

        Self {
            sections,
            os_factor,
            sample_rate,
        }
    }

    /// Updates the filter coefficients if the sample rate or OS factor changes.
    fn update(&mut self, sample_rate: f32, os_factor: u32) {
        let os_factor = os_factor.max(1);
        if self.sample_rate == sample_rate && self.os_factor == os_factor {
            return; // No change needed
        }
        self.sample_rate = sample_rate;
        self.os_factor = os_factor;

        let effective_sr = sample_rate * os_factor as f32;
        let target_cutoff = (sample_rate * 0.5 * 0.9).min(effective_sr * 0.49);
        let q_factors = [0.517_638_1, 0.707_106_8, 1.931_851_7];

        for (i, section) in self.sections.iter_mut().enumerate() {
            section.sample_rate = effective_sr;
            section.frequency = target_cutoff;
            section.q = q_factors[i];
            section.gain_db = 0.0; // AA filter shouldn't add gain
            section.filter_type = FilterType::LowPass;
            section.update_coefficients();
        }
        self.reset(); // Reset state after changing coefficients
    }

    /// Process a single sample through the 3 cascaded sections.
    #[inline(always)]
    fn process(&mut self, mut input: f32) -> f32 {
        // Process through each biquad section
        input = self.sections[0].process(input);
        input = self.sections[1].process(input);
        input = self.sections[2].process(input);
        input
    }

    /// Reset the internal state of all biquad sections.
    fn reset(&mut self) {
        for section in &mut self.sections {
            section.reset();
        }
    }
}

/// A unified filter collection supporting Biquad, Ladder, and Comb filters.
#[derive(Clone)] // Note: Cloning is potentially expensive due to Vecs/filters
pub struct FilterCollection {
    // Parameters
    sample_rate: f32,
    base_cutoff: f32,                   // Base cutoff for Biquad/Ladder (Hz)
    base_resonance: f32,                // Base resonance for all types (normalized 0–1+)
    base_gain_db: f32,                  // Base gain for Biquad/Ladder
    comb_base_frequency: f32,           // Base frequency for Comb filter (Hz) <--- ADDED
    comb_dampening: f32,                // Comb specific dampening (0-1, 0=bright, 1=dull)
    keyboard_tracking_sensitivity: f32, // Cutoff/Freq tracking sensitivity (0=none, 1=full)
    filter_type: FilterType,            // Current active filter type
    slope: FilterSlope,                 // Slope for Biquad types (Db12/Db24)
    oversampling_factor: u32,           // Oversampling multiplier (1, 2, 4, ...)
    enabled: bool,                      // Is the filter active?

    // Smoothed parameters (internal state)
    smoothed_cutoff: f32,    // Smoothed cutoff for Biquad/Ladder
    smoothed_resonance: f32, // Smoothed resonance for all types
    smoothing_factor: f32,   // Smoothing coefficient (e.g., 0.05)

    // Filter implementations (internal state)
    biquad: Biquad,                   // For Db12 or fallback
    cascaded: Option<CascadedBiquad>, // For Db24
    ladder_stages: [f32; 4],          // Moog Ladder state
    // Comb filter state
    comb_buffer: Vec<f32>,    // Delay line buffer
    comb_buffer_index: usize, // Current write index
    comb_last_output: f32,    // State for dampening filter feedback
    comb_dc_prev: f32,        // DC blocker state (previous input)
    comb_dc_state: f32,       // DC blocker state (previous output)

    // --- Fixed Oversampling filters (internal state) ---
    aa_downsampling_filter: DecimationFilter,
    // Optional: AA for upsampling, often less critical for ZOH/linear but good practice
    // aa_upsampling_filter: DecimationFilter,

    // === Scratch Buffers (internal state) ===
    // These hold per-sample modulation values for the current block
    mod_scratch_add: Vec<f32>, // General purpose scratch for modulation accumulation
    mod_scratch_mult: Vec<f32>, // General purpose scratch for modulation accumulation
    audio_in_buffer: Vec<f32>, // Combined audio input for the block
    scratch_cutoff_add: Vec<f32>, // Additive cutoff modulation
    scratch_cutoff_mult: Vec<f32>, // Multiplicative cutoff modulation
    scratch_res_add: Vec<f32>, // Additive resonance modulation
    scratch_res_mult: Vec<f32>, // Multiplicative resonance modulation
    scratch_freq_add: Vec<f32>, // Base frequency from Keyboard tracking input (Hz)
    scratch_freq_mult: Vec<f32>, // Multiplicative modulation on Keyboard tracking (unused?)
    scratch_global_freq_add: Vec<f32>, // Base frequency from Global tuning input (Hz)
    scratch_global_freq_mult: Vec<f32>, // Multiplicative modulation on Global tuning (unused?)
}

impl FilterCollection {
    pub fn new(sample_rate: f32) -> Self {
        let initial_capacity = 128; // Default buffer size, will resize if needed
        let base_cutoff = 20000.0;
        let base_resonance = 0.0;
        let base_gain_db = 0.0; // Default to 0dB gain
        let comb_base_frequency = 220.0; // Default to A3 for comb <--- ADDED Default
        let filter_type = FilterType::LowPass;
        let slope = FilterSlope::Db12;
        let initial_q = normalized_resonance_to_q(base_resonance);
        let initial_os_factor = 1; // Start with no oversampling

        Self {
            sample_rate,
            base_cutoff,
            base_resonance,
            base_gain_db,
            comb_base_frequency, // <--- ADDED Init
            comb_dampening: 0.5,
            keyboard_tracking_sensitivity: 0.0,
            filter_type,
            slope,
            oversampling_factor: initial_os_factor,
            enabled: true,

            smoothed_cutoff: base_cutoff,       // Init smoothed value
            smoothed_resonance: base_resonance, // Init smoothed value
            smoothing_factor: 0.05,             // Adjust for desired smoothing speed

            biquad: Biquad::new(
                filter_type,
                sample_rate, // Initial SR, will be updated if OS > 1
                base_cutoff,
                initial_q,
                base_gain_db,
            ),
            cascaded: None, // Initialize Db24 only when needed
            ladder_stages: [0.0; 4],

            comb_buffer: vec![0.0; *MAX_COMB_BUFFER_SIZE],
            comb_buffer_index: 0,
            comb_last_output: 0.0,
            comb_dc_prev: 0.0,
            comb_dc_state: 0.0,

            // Initialize AA filters for the initial OS factor
            aa_downsampling_filter: DecimationFilter::new(sample_rate, initial_os_factor),
            // aa_upsampling_filter: DecimationFilter::new(sample_rate, initial_os_factor),

            // Init scratch buffers
            mod_scratch_add: vec![0.0; initial_capacity],
            mod_scratch_mult: vec![1.0; initial_capacity],
            audio_in_buffer: vec![0.0; initial_capacity],
            scratch_cutoff_add: vec![0.0; initial_capacity],
            scratch_cutoff_mult: vec![1.0; initial_capacity],
            scratch_res_add: vec![0.0; initial_capacity],
            scratch_res_mult: vec![1.0; initial_capacity],
            scratch_freq_add: vec![440.0; initial_capacity], // Default A4
            scratch_freq_mult: vec![1.0; initial_capacity],
            scratch_global_freq_add: vec![440.0; initial_capacity], // Default A4
            scratch_global_freq_mult: vec![1.0; initial_capacity],
        }
    }

    /// Ensure all scratch buffers have at least `size` capacity.
    fn ensure_scratch_buffers(&mut self, size: usize) {
        // Helper closure to resize vectors
        let mut resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
            if buf.len() < size {
                // Use resize_with for potentially better efficiency if growing significantly,
                // but resize is simpler here. Add some extra capacity to avoid frequent reallocs.
                let new_size = size.next_power_of_two(); // Grow to next power of 2
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

    /// Update AA filters based on current oversampling factor.
    fn update_aa_filters(&mut self) {
        self.aa_downsampling_filter
            .update(self.sample_rate, self.oversampling_factor);
        // self.aa_upsampling_filter.update(self.sample_rate, self.oversampling_factor);
    }

    pub fn set_oversampling_factor(&mut self, factor: u32) {
        let new_factor = factor.clamp(1, *MAX_OVERSAMPLING);
        if new_factor != self.oversampling_factor {
            self.oversampling_factor = new_factor;
            self.update_aa_filters(); // Update and reset AA filters
                                      // Reset filter state as effective sample rate changed for internal filters
            self.reset_filter_state();
            // Biquad/Cascaded sample rates will be updated within process loop
        }
    }

    /// Sets the base cutoff frequency (for Biquad/Ladder) and base resonance (for all).
    pub fn set_params(&mut self, cutoff: f32, resonance: f32) {
        // Clamp base cutoff for Biquad/Ladder
        self.base_cutoff = cutoff.clamp(10.0, self.sample_rate * 0.499);
        // Allow resonance potentially > 1.0 for comb self-oscillation, clamp base if desired for UI
        self.base_resonance = resonance.max(0.0); // Ensure non-negative
                                                  // Smoothed values will catch up in the process loop
    }

    /// Sets the base gain in dB (primarily for Biquad/Ladder).
    pub fn set_gain_db(&mut self, gain_db: f32) {
        self.base_gain_db = gain_db;
        // Gain applied per-sample in Ladder, updated in Biquad coeffs
    }

    /// Sets the keyboard tracking sensitivity (0=none, 1=full).
    pub fn set_keyboard_tracking_sensitivity(&mut self, sensitivity: f32) {
        self.keyboard_tracking_sensitivity = sensitivity.clamp(0.0, 1.0);
    }

    /// Sets the active filter type.
    pub fn set_filter_type(&mut self, filter_type: FilterType) {
        if filter_type != self.filter_type {
            self.filter_type = filter_type;
            self.reset_filter_state(); // Reset state when type changes significantly
                                       // Setup cascaded if needed for the new type (will be updated in process)
            if filter_type != FilterType::Ladder
                && filter_type != FilterType::Comb
                && self.slope == FilterSlope::Db24
            {
                // Re-create cascaded filter for the new type if necessary
                self.setup_cascaded_filter();
            } else {
                self.cascaded = None; // Not needed or handled differently
            }
        }
    }

    /// Sets the filter slope (only affects Biquad types).
    pub fn set_filter_slope(&mut self, slope: FilterSlope) {
        if slope != self.slope {
            let old_slope = self.slope;
            self.slope = slope;
            // Don't necessarily reset state just for slope change if type is the same,
            // but update cascaded setup.
            if self.filter_type != FilterType::Ladder && self.filter_type != FilterType::Comb {
                if slope == FilterSlope::Db24 && old_slope == FilterSlope::Db12 {
                    // Switching from 12 to 24: Setup cascaded
                    self.setup_cascaded_filter();
                    // Copy state from single biquad to first stage? Optional, reset might be safer.
                    if let Some(ref mut c) = self.cascaded {
                        c.reset();
                    }
                } else if slope == FilterSlope::Db12 && old_slope == FilterSlope::Db24 {
                    // Switching from 24 to 12: Remove cascaded
                    self.cascaded = None;
                    // Reset single biquad state? Optional.
                    self.biquad.reset();
                }
                // If slope changes but stays Db24, setup_cascaded_filter will handle updates if needed.
            }
        }
    }

    /// Helper to initialize or update the cascaded filter instance for 24dB Biquad modes.
    fn setup_cascaded_filter(&mut self) {
        // Ensure this is only called for relevant filter types and slope
        if self.slope != FilterSlope::Db24
            || self.filter_type == FilterType::Ladder
            || self.filter_type == FilterType::Comb
        {
            self.cascaded = None;
            return;
        }

        let effective_sr = self.sample_rate * self.oversampling_factor as f32;
        // Use smoothed parameters for initialization, they will be updated per-sample anyway
        let q_overall = normalized_resonance_to_q(self.smoothed_resonance);
        let stage_q = q_overall.sqrt().max(0.501); // Ensure Q slightly > 0.5 for stability

        // If cascaded exists, update it; otherwise create new.
        if let Some(ref mut cascaded) = self.cascaded {
            // Update existing cascaded filter
            cascaded.first.sample_rate = effective_sr;
            cascaded.second.sample_rate = effective_sr;
            cascaded.first.frequency = self.smoothed_cutoff; // Use smoothed value
            cascaded.second.frequency = self.smoothed_cutoff;
            cascaded.first.q = stage_q;
            cascaded.second.q = stage_q;
            cascaded.first.gain_db = 0.0; // No gain on first stage
            cascaded.second.gain_db = self.base_gain_db; // Full gain on second stage
            cascaded.first.filter_type = self.filter_type;
            cascaded.second.filter_type = self.filter_type;
            cascaded.first.update_coefficients();
            cascaded.second.update_coefficients();
        } else {
            // Create a new cascaded filter instance
            self.cascaded = Some(CascadedBiquad::new_with_gain_split(
                self.filter_type,
                effective_sr,
                self.smoothed_cutoff, // Use smoothed value for init
                stage_q,
                0.0,               // Gain on first stage
                self.base_gain_db, // Gain on second stage
            ));
            // Ensure coefficients are calculated and state reset for new instance
            if let Some(ref mut c) = self.cascaded {
                // new_with_gain_split already updates coefficients
                c.reset(); // Reset state of new filter
            }
        }
    }

    /// Sets the base frequency (Hz) specifically for the Comb filter. <--- ADDED
    pub fn set_comb_target_frequency(&mut self, freq: f32) {
        // Clamp to a reasonable audio range, ensure positive
        self.comb_base_frequency = freq.clamp(10.0, self.sample_rate * 0.499);
    }

    /// Sets the dampening factor for the Comb filter's feedback loop.
    /// `dampening`: 0 = no dampening (bright), 1 = max dampening (dull).
    pub fn set_comb_dampening(&mut self, dampening: f32) {
        self.comb_dampening = dampening.clamp(0.0, 1.0);
    }

    /// Reset internal filter state (delays, feedback paths etc.)
    fn reset_filter_state(&mut self) {
        self.biquad.reset();
        if let Some(ref mut cascaded) = self.cascaded {
            cascaded.reset();
        }
        self.ladder_stages = [0.0; 4];
        self.comb_buffer.fill(0.0); // Zero out delay line
        self.comb_buffer_index = 0;
        self.comb_last_output = 0.0;
        self.comb_dc_prev = 0.0;
        self.comb_dc_state = 0.0;
        self.aa_downsampling_filter.reset();
        // self.aa_upsampling_filter.reset();
    }

    // --- Per-Sample Processing Logic ---

    /// Process one sample using the Ladder filter implementation.
    #[inline(always)]
    fn process_ladder_sample(
        &mut self,
        input: f32,
        cutoff: f32,
        resonance_norm: f32, // 0-1+ range typical
        effective_sr: f32,
        // os_factor: u32 // Not strictly needed if g is calculated correctly
    ) -> f32 {
        // Calculate ladder parameters based on effective sample rate
        // Use frequency warping approximation for g
        let g = (PI * cutoff / effective_sr).tan(); // Frequency coefficient (pole position)
        let g_inv = 1.0 / (1.0 + g); // Normalization factor for feedback stage (stability)

        // Map normalized resonance (0-1+) to feedback amount (0-4 typical, allow higher)
        let k = resonance_norm.max(0.0) * 4.0; // Feedback amount

        // 4-Stage Moog Ladder Algorithm (Direct Form / simplified)
        // Input with feedback from the last stage
        let stage_input = input - k * self.ladder_stages[3];

        // Calculate voltage differences across stages, apply non-linearity (tanh)
        let v0 = fast_tanh(stage_input);
        let v1 = fast_tanh(self.ladder_stages[0]);
        let v2 = fast_tanh(self.ladder_stages[1]);
        let v3 = fast_tanh(self.ladder_stages[2]);
        let v4 = fast_tanh(self.ladder_stages[3]); // Last stage tanh for state update

        // Update stage values using one-pole filters (implicit Euler integration, adjusted)
        // Formula: y[n] = y[n-1] + 2 * g * (input_tanh - y_tanh[n-1]) / (1 + g)
        self.ladder_stages[0] += 2.0 * g * (v0 - v1) * g_inv;
        self.ladder_stages[1] += 2.0 * g * (v1 - v2) * g_inv;
        self.ladder_stages[2] += 2.0 * g * (v2 - v3) * g_inv;
        self.ladder_stages[3] += 2.0 * g * (v3 - v4) * g_inv; // Last stage updates based on v3 -> v4

        // Output is typically the last stage state
        let output = self.ladder_stages[3];

        // Apply output gain (convert dB gain to linear multiplier)
        output * 10f32.powf(self.base_gain_db / 20.0)
    }

    /// Process one sample using the Comb filter implementation. Corrected for oversampling.
    #[inline(always)]
    fn process_comb_sample(
        &mut self,
        input: f32,
        freq: f32, // Target frequency (derived from comb_base_frequency + tracking)
        resonance_norm: f32, // Smoothed, modulated resonance (0-1+, allows >1 for self-oscillation)
        effective_sr: f32,
        os_factor: u32, // Pass the oversampling factor
    ) -> f32 {
        // Calculate delay length in samples based on frequency at the effective sample rate
        // Ensure freq > 0, delay >= 2 (minimum delay for interpolation)
        let delay_samples = (effective_sr / freq.max(1.0)).max(2.0);

        // --- Calculate per-oversampling-step parameters ---
        let os_factor_f = os_factor as f32;

        // Apply resonance proportionally per step. Allow resonance > 1 for self-oscillation.
        let clamped_res = resonance_norm.max(0.0); // Ensure non-negative
        let substep_resonance = clamped_res.powf(1.0 / os_factor_f);

        // Dampening: 0 = bright/no dampening, 1 = max dampening (dull)
        // Map comb_dampening to the feedback filter coefficient (alpha).
        let clamped_dampening = self.comb_dampening.clamp(0.0, 1.0);
        let substep_dampening_coeff = clamped_dampening.powf(1.0 / os_factor_f);
        // One-pole lowpass: y[n] = alpha * y[n-1] + (1 - alpha) * x[n]
        let alpha = substep_dampening_coeff; // Alpha for the dampening filter

        // --- Read Delayed Sample (Linear Interpolation) ---
        let delay_floor = delay_samples.floor();
        let delay_frac = delay_samples - delay_floor;
        let delay_int = delay_floor as usize;

        let buf_len = self.comb_buffer.len();
        // Calculate read indices, ensuring they wrap correctly within the buffer length
        // Index for the integer part of the delay
        let read_idx0 = (self.comb_buffer_index + buf_len - delay_int) % buf_len;
        // Index for the sample before that (for interpolation)
        let read_idx1 = (self.comb_buffer_index + buf_len - (delay_int + 1)) % buf_len;

        // Read samples using safe indexing
        let y0 = self.comb_buffer[read_idx0];
        let y1 = self.comb_buffer[read_idx1];

        // Linear interpolation
        let delayed_sample = y0 + (y1 - y0) * delay_frac;

        // --- Apply Dampening Filter to the delayed signal ---
        // This filters the signal before it's used in the feedback loop.
        self.comb_last_output = alpha * self.comb_last_output + (1.0 - alpha) * delayed_sample;

        // --- Calculate Feedback Signal ---
        // Use the dampened signal and per-step resonance.
        let feedback = self.comb_last_output * substep_resonance;

        // --- Calculate Sample to Write to Buffer ---
        // Standard feedback comb: y[n] = x[n] + feedback_signal
        let buffer_write_val = input + feedback;
        // Optional: Clamp output before writing to buffer to prevent potential explosion
        // let buffer_write_val = buffer_write_val.clamp(-2.0, 2.0);

        // --- Write to Delay Buffer ---
        self.comb_buffer[self.comb_buffer_index] = buffer_write_val;

        // --- Increment Write Index ---
        self.comb_buffer_index = (self.comb_buffer_index + 1) % buf_len;

        // --- DC Blocker ---
        // The output *before* DC blocking is the value written to the buffer
        let comb_output = buffer_write_val;
        // Simple 1st order highpass DC blocker: y[n] = x[n] - x[n-1] + R * y[n-1]
        let filtered_output = comb_output - self.comb_dc_prev + 0.995 * self.comb_dc_state;
        self.comb_dc_prev = comb_output; // Store current output as previous input for next step
        self.comb_dc_state = filtered_output; // Store current filtered output for next step

        filtered_output // Return the DC-blocked signal
    }

    /// Process one sample using the Biquad filter implementation (12dB or 24dB).
    #[inline(always)]
    fn process_biquad_sample(
        &mut self,
        input: f32,
        cutoff: f32,
        resonance_norm: f32, // 0-1+ range (will be clamped for Q calc)
        effective_sr: f32,
        // os_factor: u32 // Not needed directly, handled by effective_sr
    ) -> f32 {
        // Update Biquad coefficients only if parameters or sample rate changed significantly
        // Clamp resonance for Q calculation if it can exceed 1.0
        let q = normalized_resonance_to_q(resonance_norm.clamp(0.0, 1.0));

        // Update primary biquad state if needed
        let biquad_needs_update = self.biquad.sample_rate != effective_sr
            || (self.biquad.frequency - cutoff).abs() > 1e-3 // Tolerate small float differences
            || (self.biquad.q - q).abs() > 1e-3
            || self.biquad.gain_db != self.base_gain_db
            || self.biquad.filter_type != self.filter_type;

        if biquad_needs_update {
            self.biquad.sample_rate = effective_sr;
            self.biquad.frequency = cutoff;
            self.biquad.q = q;
            self.biquad.gain_db = self.base_gain_db; // Apply full gain for 12dB mode
            self.biquad.filter_type = self.filter_type;
            self.biquad.update_coefficients();
        }

        match self.slope {
            FilterSlope::Db12 => self.biquad.process(input),
            FilterSlope::Db24 => {
                // Ensure cascaded filter exists and is up-to-date
                let stage_q = q.sqrt().max(0.501); // Q for each stage, ensure > 0.5

                // Check if cascaded needs setup or update
                let needs_setup_or_update = match self.cascaded {
                    None => true, // Needs setup if it doesn't exist
                    Some(ref c) => {
                        c.first.sample_rate != effective_sr
                                || (c.first.frequency - cutoff).abs() > 1e-3
                                || (c.first.q - stage_q).abs() > 1e-3
                                || c.second.gain_db != self.base_gain_db // Check gain on second stage
                                || c.first.filter_type != self.filter_type
                    }
                };

                if needs_setup_or_update {
                    // This will create or update the cascaded filter
                    self.setup_cascaded_filter();
                }

                // Process through the cascaded filter
                if let Some(ref mut cascaded) = self.cascaded {
                    cascaded.process(input)
                } else {
                    // Fallback to 12dB if cascaded somehow failed to initialize (should not happen)
                    // Log error maybe?
                    // web_sys::console::error_1(&"Cascaded filter missing in Db24 mode!".into());
                    self.biquad.process(input)
                }
            }
        }
    }
}

// Implement the modulation processor trait helper functions
impl ModulationProcessor for FilterCollection {}

impl AudioNode for FilterCollection {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        [
            (PortId::AudioInput0, false),     // Input audio signal
            (PortId::CutoffMod, false),       // Modulation for Biquad/Ladder cutoff frequency
            (PortId::ResonanceMod, false),    // Modulation for resonance (0-1+) for all types
            (PortId::Frequency, false), // Keyboard tracking base frequency (Hz) -> affects Cutoff & Comb Freq
            (PortId::GlobalFrequency, false), // Global tuning base frequency (Hz) -> affects Cutoff & Comb Freq
            (PortId::AudioOutput0, true),     // Output filtered audio
                                              // Potential future ports: CombFreqMod, CombDampMod, GainMod, etc.
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
        if !self.enabled {
            if let Some(output_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                output_buffer[..buffer_size].fill(0.0);
            }
            return;
        }

        self.ensure_scratch_buffers(buffer_size);

        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buffer) => buffer,
            None => return, // No output buffer provided
        };

        // --- 1) Process Modulation Inputs ---

        // Audio Input (assuming simple additive combination)
        self.audio_in_buffer[..buffer_size].fill(0.0); // Reset input buffer
        if let Some(audio_sources) = inputs.get(&PortId::AudioInput0) {
            for source in audio_sources {
                Self::apply_add(
                    &source.buffer,
                    &mut self.audio_in_buffer[..buffer_size],
                    source.amount,
                    source.transformation,
                );
            }
        }

        // Generic modulation input processing helper
        let mut process_mod_input = |port_id: PortId,
                                     target_add: &mut [f32],
                                     target_mult: &mut [f32],
                                     default_add: f32,
                                     default_mult: f32| {
            let sources = inputs.get(&port_id);
            // Check if there are actually sources connected
            if sources.map_or(false, |s| !s.is_empty()) {
                // Use the ModulationProcessor helper to combine sources
                Self::accumulate_modulations_inplace(
                    buffer_size,
                    sources.map(|v| v.as_slice()),
                    &mut self.mod_scratch_add, // Use general scratch buffers
                    &mut self.mod_scratch_mult,
                );
                // Copy results to specific scratch buffers for this parameter
                target_add[..buffer_size].copy_from_slice(&self.mod_scratch_add[..buffer_size]);
                target_mult[..buffer_size].copy_from_slice(&self.mod_scratch_mult[..buffer_size]);
            } else {
                // No sources connected, fill with default values
                target_add[..buffer_size].fill(default_add);
                target_mult[..buffer_size].fill(default_mult);
            }
        };

        // Process modulation for each parameter
        process_mod_input(
            PortId::CutoffMod, // Affects Biquad/Ladder cutoff
            &mut self.scratch_cutoff_add,
            &mut self.scratch_cutoff_mult,
            0.0, // Default additive cutoff mod
            1.0, // Default multiplicative cutoff mod
        );
        process_mod_input(
            PortId::ResonanceMod, // Affects all filter types
            &mut self.scratch_res_add,
            &mut self.scratch_res_mult,
            0.0, // Default additive resonance mod
            1.0, // Default multiplicative resonance mod
        );
        // For frequency inputs, we primarily care about the additive part as the base frequency
        process_mod_input(
            PortId::Frequency, // Keyboard tracking
            &mut self.scratch_freq_add,
            &mut self.scratch_freq_mult, // Multiplicative part usually unused for base freq
            440.0,                       // Default base frequency (A4)
            1.0,
        );
        process_mod_input(
            PortId::GlobalFrequency, // Global tuning
            &mut self.scratch_global_freq_add,
            &mut self.scratch_global_freq_mult, // Multiplicative part usually unused for base freq
            440.0,                              // Default base frequency (A4)
            1.0,
        );

        // --- 2) Main Processing Loop (Sample by Sample) ---
        let os_factor = self.oversampling_factor.max(1);
        let effective_sr = self.sample_rate * os_factor as f32;
        let base_440_hz = 440.0; // Reference frequency for tracking calculations
        let smoothing_factor = self.smoothing_factor; // Cache smoothing factor

        for i in 0..buffer_size {
            // --- Calculate Target Parameters for this Sample ---
            // Cutoff for Biquad/Ladder (base + modulation)
            let target_cutoff_base =
                (self.base_cutoff + self.scratch_cutoff_add[i]) * self.scratch_cutoff_mult[i];
            // Resonance for all types (base + modulation)
            let target_resonance_norm =
                (self.base_resonance + self.scratch_res_add[i]) * self.scratch_res_mult[i];

            // --- Apply Keyboard & Global Frequency Tracking ---
            // Note: Using ADDITIVE scratch buffers as the source frequency value (Hz)
            let key_freq = self.scratch_freq_add[i].max(10.0); // Ensure positive frequency
            let global_freq = self.scratch_global_freq_add[i].max(10.0);

            // Calculate frequency ratios relative to A440
            let key_ratio = key_freq / base_440_hz;
            let global_ratio = global_freq / base_440_hz;

            // Apply sensitivity. Sensitivity=1 means ratio^1, Sensitivity=0 means ratio^0=1 (no tracking)
            // Global tracking is usually full (sensitivity=1 implicitly).
            let tracking_multiplier =
                key_ratio.powf(self.keyboard_tracking_sensitivity) * global_ratio;

            // --- Calculate final effective parameters for this sample ---
            let max_freq_limit = effective_sr * 0.495; // Clamp slightly below Nyquist of effective SR

            // Effective Biquad/Ladder Cutoff (apply tracking, clamp)
            let target_cutoff =
                (target_cutoff_base * tracking_multiplier).clamp(10.0, max_freq_limit);

            // Effective Comb Frequency (use comb_base_frequency, apply tracking, clamp) <--- MODIFIED
            let target_comb_freq =
                (self.comb_base_frequency * tracking_multiplier).clamp(10.0, max_freq_limit);

            // Effective Resonance (clamp, allow slightly > 1.0 for comb self-resonance)
            let target_resonance_clamped = target_resonance_norm.clamp(0.0, 1.05);

            // --- Apply Parameter Smoothing (One-Pole LPF) ---
            // Smooth cutoff for Biquad/Ladder
            self.smoothed_cutoff += smoothing_factor * (target_cutoff - self.smoothed_cutoff);
            self.smoothed_cutoff = self.smoothed_cutoff.clamp(10.0, max_freq_limit); // Re-clamp after smoothing

            // Smooth resonance for all types
            self.smoothed_resonance +=
                smoothing_factor * (target_resonance_clamped - self.smoothed_resonance);
            self.smoothed_resonance = self.smoothed_resonance.clamp(0.0, 1.05); // Re-clamp after smoothing
                                                                                // Note: target_comb_freq is NOT smoothed, using the directly calculated value

            // --- Process Audio Sample(s) with Oversampling ---
            let input_sample = self.audio_in_buffer[i];

            // --- Upsample Input ---
            // Simple Zero-Order Hold: Use the same input sample for all oversampling steps.
            // Optional: Apply aa_upsampling_filter here if implemented and desired.
            // let upsampled_input = self.aa_upsampling_filter.process(input_sample);
            let upsampled_input = input_sample; // ZOH

            let mut current_output = 0.0;
            // --- Oversampling Loop ---
            for _k in 0..os_factor {
                // Loop variable k not needed inside
                // Process one sub-sample at the effective sample rate using calculated parameters
                current_output = match self.filter_type {
                    FilterType::Ladder => self.process_ladder_sample(
                        upsampled_input,         // Use ZOH input for all steps
                        self.smoothed_cutoff,    // Use smoothed B/L cutoff
                        self.smoothed_resonance, // Use smoothed resonance
                        effective_sr,
                    ),
                    FilterType::Comb => self.process_comb_sample(
                        upsampled_input,         // Use ZOH input for all steps
                        target_comb_freq, // Use directly calculated (tracked, unsmoothed) comb freq <--- MODIFIED
                        self.smoothed_resonance, // Use smoothed resonance
                        effective_sr,
                        os_factor, // Pass os_factor for correct param handling
                    ),
                    // All other types use the Biquad/Cascaded logic
                    _ => self.process_biquad_sample(
                        upsampled_input,         // Use ZOH input for all steps
                        self.smoothed_cutoff,    // Use smoothed B/L cutoff
                        self.smoothed_resonance, // Use smoothed resonance
                        effective_sr,
                    ),
                };

                // If not using ZOH, update upsampled_input for next step
                // e.g., for impulse train: if k == 0 { upsampled_input *= os_factor_f } else { upsampled_input = 0.0; }
                // Or use polyphase FIR for better quality upsampling.
            } // End of oversampling loop

            // --- Downsample Output ---
            // Apply the decimation filter before writing to the output buffer.
            let final_output = self.aa_downsampling_filter.process(current_output);

            // Write final processed sample to the output buffer
            output_buffer[i] = final_output;
        } // End of main processing loop (per sample)
    }

    /// Resets filter state and smoothed parameters.
    fn reset(&mut self) {
        // Reset internal state like delays, feedback paths etc.
        self.reset_filter_state();
        // Reset smoothed parameters back to base values
        self.smoothed_cutoff = self.base_cutoff;
        self.smoothed_resonance = self.base_resonance;
        // Reset AA filters too
        self.aa_downsampling_filter.reset();
        // self.aa_upsampling_filter.reset();
    }

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
            // Reset state only when turning off
            self.reset();
        }
        self.enabled = active;
    }
    fn node_type(&self) -> &str {
        "filtercollection"
    }
}

// --- Frequency Response Generation Methods ---
// Updated create_impulse_response to handle comb_base_frequency

impl FilterCollection {
    /// Generates the frequency response of the filter with current settings.
    pub fn generate_frequency_response(&self, requested_length: usize) -> Vec<f32> {
        // Generate impulse response using a temporary instance with current base settings
        let impulse_length = 4096.max(requested_length * 4); // Ensure enough FFT resolution
        let impulse = self.create_impulse_response(impulse_length);

        // Calculate FFT magnitude (in dB)
        let fft_magnitude_db = self.calculate_fft_magnitude(impulse);

        // Frequency range for display (logarithmic)
        let nyquist_hz = self.sample_rate * 0.5;
        let max_freq_hz = 20_000.0_f32.min(nyquist_hz);
        let min_freq_hz = 20.0_f32;

        // Map frequency range to FFT bin indices
        let fft_bins = fft_magnitude_db.len(); // Number of bins in the half-spectrum
                                               // Index corresponding to max frequency (ensure it's within bounds)
                                               // Bin index = Freq * FFT_Size / SampleRate. FFT_Size = impulse_length = fft_bins * 2
        let bin_max =
            (max_freq_hz * (fft_bins as f32 * 2.0) / self.sample_rate).min(fft_bins as f32 - 1.0);
        // Index corresponding to min frequency (ensure >= 0)
        let bin_min = (min_freq_hz * (fft_bins as f32 * 2.0) / self.sample_rate).max(0.0);

        let points = requested_length;
        let mut response_db_interpolated = Vec::with_capacity(points);

        // Logarithmic sampling of FFT bins for better visualization
        // Handle edge case where bin_min or bin_max might be 0
        let log_bin_min = (bin_min.max(0.0) + 1.0).ln(); // Add 1 to handle bin 0 -> ln(1)=0
        let log_bin_max = (bin_max.max(0.0) + 1.0).ln();
        let log_range = (log_bin_max - log_bin_min).max(0.0); // Avoid negative range if min > max

        for i in 0..points {
            // Calculate interpolation factor (0.0 to 1.0)
            let factor = if points > 1 {
                i as f32 / (points - 1) as f32
            } else {
                0.0
            };
            // Find the target bin index on a logarithmic scale
            let log_bin = log_bin_min + log_range * factor;
            // Convert back to linear bin index
            let bin = log_bin.exp() - 1.0;

            // Linear interpolation between adjacent FFT magnitude bins
            let bin_floor = (bin.floor().max(0.0) as usize).min(fft_bins.saturating_sub(1));
            let bin_ceil = (bin_floor + 1).min(fft_bins.saturating_sub(1));
            let frac = bin - bin_floor as f32;

            let db_val =
                if bin_floor >= fft_magnitude_db.len() || bin_ceil >= fft_magnitude_db.len() {
                    // Safety check for out-of-bounds, return floor value?
                    *fft_magnitude_db.last().unwrap_or(&-120.0) // Default to very low dB if empty
                } else if bin_floor == bin_ceil {
                    fft_magnitude_db[bin_floor] // Avoid interpolation if frac is 0 or at the end
                } else {
                    // Linear interpolation
                    fft_magnitude_db[bin_floor] * (1.0 - frac) + fft_magnitude_db[bin_ceil] * frac
                };
            response_db_interpolated.push(db_val);
        }

        // Normalize the dB values to a 0.0-1.0 range for display purposes
        self.normalize_for_display_range(response_db_interpolated, -60.0, 18.0) // Adjust dB range as needed
    }

    /// Normalizes dB values to a 0.0-1.0 range for display.
    fn normalize_for_display_range(
        &self,
        mut data: Vec<f32>,
        db_floor: f32,
        db_ceiling: f32,
    ) -> Vec<f32> {
        let range = (db_ceiling - db_floor).max(1e-6); // Avoid division by zero
        for value in &mut data {
            let clamped_db = value.clamp(db_floor, db_ceiling);
            // Map clamped value to 0.0-1.0 range
            *value = (clamped_db - db_floor) / range;
        }
        data
    }

    /// Creates an impulse response for the current filter settings using a temporary instance.
    fn create_impulse_response(&self, length: usize) -> Vec<f32> {
        // Create a temporary filter instance configured with current BASE settings
        // This reflects the "target" response, not the potentially smoothed real-time response.
        let mut temp_filter = FilterCollection::new(self.sample_rate);
        // Copy base parameters
        temp_filter.base_cutoff = self.base_cutoff;
        temp_filter.base_resonance = self.base_resonance;
        temp_filter.base_gain_db = self.base_gain_db;
        temp_filter.comb_base_frequency = self.comb_base_frequency; // <<< COPY COMB FREQ
        temp_filter.comb_dampening = self.comb_dampening;
        temp_filter.filter_type = self.filter_type;
        temp_filter.slope = self.slope;
        temp_filter.oversampling_factor = self.oversampling_factor; // Use current OS factor
        temp_filter.keyboard_tracking_sensitivity = self.keyboard_tracking_sensitivity;
        // Set smoothed params directly to base values for impulse response (no smoothing)
        temp_filter.smoothed_cutoff = self.base_cutoff;
        temp_filter.smoothed_resonance = self.base_resonance;

        // Ensure internal state matches settings (AA filters, cascaded setup)
        temp_filter.update_aa_filters(); // Initialize AA filters correctly
        temp_filter.set_filter_type(self.filter_type); // Setup cascaded if needed
        temp_filter.set_filter_slope(self.slope); // Redundant if type was set, but safe

        let mut response = Vec::with_capacity(length);
        let os_factor = temp_filter.oversampling_factor.max(1);
        let effective_sr = temp_filter.sample_rate * os_factor as f32;

        // Determine comb frequency for impulse (use base freq, no tracking/modulation for IR)
        let impulse_comb_freq = temp_filter.comb_base_frequency; // <<< USE BASE COMB FREQ

        // --- Generate Impulse Response ---
        for i in 0..length {
            // Create impulse: 1.0 at sample 0, 0.0 otherwise
            let input = if i == 0 { 1.0 } else { 0.0 };

            // --- Apply Oversampling for Impulse Response ---
            // Upsample (ZOH)
            let upsampled_input = input;
            // Optional: Use AA upsampling filter
            // let upsampled_input = temp_filter.aa_upsampling_filter.process(input);

            let mut current_output = 0.0;
            // --- Oversampling Loop ---
            for _k in 0..os_factor {
                // Loop var k not needed
                // Process sub-sample using BASE parameters (already set in smoothed vars)
                current_output = match temp_filter.filter_type {
                    FilterType::Ladder => temp_filter.process_ladder_sample(
                        upsampled_input,                // Use ZOH input
                        temp_filter.smoothed_cutoff,    // Use base cutoff
                        temp_filter.smoothed_resonance, // Use base resonance
                        effective_sr,
                    ),
                    FilterType::Comb => temp_filter.process_comb_sample(
                        upsampled_input,                // Use ZOH input
                        impulse_comb_freq,              // <<< USE BASE COMB FREQ FOR IMPULSE
                        temp_filter.smoothed_resonance, // Use base resonance
                        effective_sr,
                        os_factor, // Pass OS factor
                    ),
                    _ => temp_filter.process_biquad_sample(
                        upsampled_input,                // Use ZOH input
                        temp_filter.smoothed_cutoff,    // Use base cutoff
                        temp_filter.smoothed_resonance, // Use base resonance
                        effective_sr,
                    ),
                };
                // If not ZOH: update upsampled_input for next step (e.g., set to 0.0)
            } // End OS loop

            // Downsample using the AA filter
            let final_output = temp_filter.aa_downsampling_filter.process(current_output);
            response.push(final_output);
        }
        response
    }

    /// Calculates the FFT magnitude spectrum (in dB) from an impulse response.
    fn calculate_fft_magnitude(&self, impulse_response: Vec<f32>) -> Vec<f32> {
        let fft_length = impulse_response.len();
        if fft_length == 0 {
            return vec![];
        }

        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(fft_length);

        // Convert impulse response to complex buffer
        let mut buffer: Vec<Complex<f32>> = impulse_response
            .into_iter()
            .map(|x| Complex { re: x, im: 0.0 })
            .collect();

        // Perform FFT in-place
        fft.process(&mut buffer);

        // Calculate magnitude in dB for the first half of the spectrum (positive frequencies)
        let half_len = fft_length / 2;
        let epsilon = 1e-10; // Small value to prevent log10(0)

        let magnitude_db: Vec<f32> = buffer
            .iter()
            .take(half_len) // Only take the first half (0 to Nyquist)
            .map(|c| {
                let norm_sq = c.norm_sqr(); // Power = magnitude squared
                                            // Convert power to dB: 10 * log10(power)
                10.0 * (norm_sq + epsilon).log10()
                // Or convert amplitude to dB: 20 * log10(amplitude)
                // 20.0 * (c.norm() + epsilon).log10()
            })
            .collect();

        magnitude_db
    }
}
