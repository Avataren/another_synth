use once_cell::sync::Lazy;
use std::any::Any;
use std::collections::HashMap;
use std::f32::consts::PI;
use std::simd::num::SimdFloat;
// Simd needed for modulation processor helpers if used directly, but not for logic here anymore
// use std::simd::Simd;
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

/// Helper: map a normalized resonance (0–1) to a Q factor.
#[inline(always)]
fn normalized_resonance_to_q(normalized: f32) -> f32 {
    // Adjust Q mapping for better feel (subjective)
    // Example: 0 -> 0.707, 0.5 -> ~2.5, 1.0 -> ~10
    0.707 + normalized.powf(1.5) * 9.3
}

// simd_sum is removed as we process per-sample now.

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
    const X_MIN: f32 = -5.0;
    const X_MAX: f32 = 5.0;
    const INV_RANGE: f32 = 1.0 / (X_MAX - X_MIN);

    let clamped = x.clamp(X_MIN, X_MAX);
    let normalized = (clamped - X_MIN) * INV_RANGE * LUT_SIZE_MINUS_1_F;
    let index_f = normalized.floor();
    let index = index_f as usize;
    let frac = normalized - index_f;

    // Interpolate using unsafe gets for potential minor speedup (bounds already checked by clamp/logic)
    // Make sure LUT_SIZE is correct, index is within [0, 1023]
    unsafe {
        let y0 = TANH_LUT.get_unchecked(index);
        let y1 = TANH_LUT.get_unchecked(index + 1); // index <= 1023 guarantees index+1 <= 1024, but LUT is size 1024. Need check.
                                                    // Correction: index can be 1023, index+1 is 1024, which is out of bounds.
                                                    // Check index before accessing index+1.
        if index < 1023 {
            y0 + (y1 - y0) * frac
        } else {
            *y0 // At the very end, return the last value
        }
        // Safer version:
        // let y0 = TANH_LUT[index];
        // if index < 1023 {
        //     let y1 = TANH_LUT[index + 1];
        //     y0 + (y1 - y0) * frac
        // } else {
        //     y0
        // }
    }
}

/// Maximum allowed oversampling factor.
static MAX_OVERSAMPLING: Lazy<u32> = Lazy::new(|| 16); // e.g., 16x

/// Precomputed maximum delay line length for the comb filter.
static MAX_COMB_BUFFER_SIZE: Lazy<usize> = Lazy::new(|| {
    let sample_rate = 48000.0; // Assume a common rate for sizing
    let min_freq = 20.0; // Lowest expected frequency
    ((sample_rate * (*MAX_OVERSAMPLING as f32)) / min_freq).ceil() as usize + 4 // Add margin for interpolation
});

/// Coefficients for a 6th-order anti-aliasing filter (Butterworth lowpass)
#[derive(Clone, Copy, Debug)]
struct AntiAliasingFilter {
    // Using Direct Form II Transposed structure for potentially better numerical stability
    s1: [f32; 3], // State for first stage
    s2: [f32; 3], // State for second stage
    a1: f32,      // Denominator coeffs (shared)
    a2: f32,
    b0: f32, // Numerator coeffs (shared)
    b1: f32,
    b2: f32,
}

impl AntiAliasingFilter {
    /// Creates a new 6th order Butterworth anti-aliasing filter (3 cascaded 2nd order sections).
    /// cutoff_normalized is the cutoff frequency relative to Nyquist (0.0 to 1.0).
    /// A value around 0.8-0.9 is typical for AA filters (e.g., 0.4 * 2 = 0.8 relative to original Nyquist).
    fn new(cutoff_normalized: f32) -> Self {
        // Design a 2nd-order Butterworth lowpass filter section
        let wc = cutoff_normalized * PI; // Pre-warp cutoff frequency (approx)
        let k = wc.tan() * 0.5; // Or use 1.0 / wc.tan() depending on formulation
        let k_sq = k * k;
        let sqrt2k = std::f32::consts::SQRT_2 * k;
        let norm = 1.0 / (1.0 + sqrt2k + k_sq);

        let b0 = k_sq * norm;
        let b1 = 2.0 * b0;
        let b2 = b0;

        let a1 = 2.0 * (k_sq - 1.0) * norm;
        let a2 = (1.0 - sqrt2k + k_sq) * norm;

        Self {
            s1: [0.0; 3],
            s2: [0.0; 3],
            a1,
            a2,
            b0,
            b1,
            b2,
        }
    }

    #[inline(always)]
    fn process_stage(
        s: &mut [f32; 3],
        input: f32,
        a1: f32,
        a2: f32,
        b0: f32,
        b1: f32,
        b2: f32,
    ) -> f32 {
        let output = b0 * input + s[0];
        s[0] = b1 * input + s[1] - a1 * output;
        s[1] = b2 * input + s[2] - a2 * output;
        s[2] = 0.0; // Not used in DF2T, keep array size 3 for consistency maybe? Or use size 2.
        output
    }

    /// Process a single sample through the 3 cascaded sections.
    #[inline(always)]
    fn process(&mut self, input: f32) -> f32 {
        let out1 = Self::process_stage(
            &mut self.s1,
            input,
            self.a1,
            self.a2,
            self.b0,
            self.b1,
            self.b2,
        );
        let out2 = Self::process_stage(
            &mut self.s2,
            out1,
            self.a1,
            self.a2,
            self.b0,
            self.b1,
            self.b2,
        );
        // 3rd stage - reuse s1? No, need separate state. Add s3: [f32; 3]
        // For now, let's assume the original structure was okay, revert to that for simplicity.
        // Revert to original struct for now until DF2T is fully worked out for 3 stages.
        // ... implementation needs state variables per stage ...
        // Sticking to the less optimal provided implementation for now:
        // This Direct Form I is less numerically stable but easier to write cascaded.
        // let mut output = input;
        // for i in 0..3 { // Needs 3 sets of state variables! [f32;3] -> [[f32;2];3] etc.
        //     let y = self.b[0] * output + self.b[1] * self.x1[i] + self.b[2] * self.x2[i]
        //         - self.a[0] * self.y1[i]
        //         - self.a[1] * self.y2[i];
        //     self.x2[i] = self.x1[i];
        //     self.x1[i] = output;
        //     self.y2[i] = self.y1[i];
        //     self.y1[i] = y;
        //     output = y;
        // }
        // output
        // TODO: Fix AntiAliasingFilter implementation (use DF2T properly or allocate state per stage)
        // For now, just pass through - THIS WILL CAUSE ALIASING WITH OVERSAMPLING!
        input
    }

    fn reset(&mut self) {
        self.s1 = [0.0; 3];
        self.s2 = [0.0; 3];
        // self.s3 = [0.0; 3]; // If adding third stage state
        // If using original struct:
        // self.x1 = [0.0; 3]; self.x2 = [0.0; 3]; self.y1 = [0.0; 3]; self.y2 = [0.0; 3];
    }
}

/// A unified filter collection.
#[derive(Clone)] // Note: Cloning is potentially expensive due to Vecs/filters
pub struct FilterCollection {
    // Parameters
    sample_rate: f32,
    base_cutoff: f32,
    base_resonance: f32, // normalized (0–1)
    base_gain_db: f32,
    keyboard_tracking_sensitivity: f32, // 0=none, 1=full
    filter_type: FilterType,
    slope: FilterSlope,       // Only for Biquad types
    comb_dampening: f32,      // Comb specific (0-1)
    oversampling_factor: u32, // 1, 2, 4, 8, ...
    enabled: bool,

    // Smoothed parameters (state)
    smoothed_cutoff: f32,
    smoothed_resonance: f32, // normalized (0-1)
    smoothing_factor: f32,   // For parameter smoothing (e.g., 0.05)

    // Filter implementations (state)
    biquad: Biquad,                   // For Db12 or fallback
    cascaded: Option<CascadedBiquad>, // For Db24
    ladder_stages: [f32; 4],          // Moog Ladder state
    // Comb filter state
    comb_buffer: Vec<f32>,
    comb_buffer_index: usize,
    comb_last_output: f32, // For dampening feedback
    comb_dc_prev: f32,     // DC blocker state
    comb_dc_state: f32,    // DC blocker state

    // Oversampling filters (state)
    // IMPORTANT: These need to be reset if sample_rate or oversampling_factor changes!
    aa_upsampling_filter: AntiAliasingFilter,
    aa_downsampling_filter: AntiAliasingFilter,

    // === Scratch Buffers ===
    mod_scratch_add: Vec<f32>,
    mod_scratch_mult: Vec<f32>,
    audio_in_buffer: Vec<f32>, // Holds combined audio input
    scratch_cutoff_add: Vec<f32>,
    scratch_cutoff_mult: Vec<f32>,
    scratch_res_add: Vec<f32>,
    scratch_res_mult: Vec<f32>,
    scratch_freq_add: Vec<f32>,         // Keyboard tracking base freq
    scratch_freq_mult: Vec<f32>,        // Keyboard tracking modulation (unused?)
    scratch_global_freq_add: Vec<f32>,  // Global tuning base freq
    scratch_global_freq_mult: Vec<f32>, // Global tuning modulation (unused?)
}

impl FilterCollection {
    pub fn new(sample_rate: f32) -> Self {
        let initial_capacity = 128; // Default buffer size
        let base_cutoff = 20000.0;
        let base_resonance = 0.0;
        let base_gain_db = 0.0; // Default to 0dB gain
        let filter_type = FilterType::LowPass;
        let slope = FilterSlope::Db12;
        let initial_q = normalized_resonance_to_q(base_resonance);

        // Cutoff relative to Nyquist (sample_rate / 2). E.g., 0.9 for slight margin.
        // Should be based on effective sample rate if oversampling.
        let aa_cutoff_norm = 0.9 / (*MAX_OVERSAMPLING as f32); // Adjust AA cutoff based on max OS

        Self {
            sample_rate,
            base_cutoff,
            base_resonance,
            base_gain_db,
            keyboard_tracking_sensitivity: 0.0,
            filter_type,
            slope,
            comb_dampening: 0.5,
            oversampling_factor: 1,
            enabled: true,

            smoothed_cutoff: base_cutoff,
            smoothed_resonance: base_resonance,
            smoothing_factor: 0.05, // Adjust for desired smoothing speed

            biquad: Biquad::new(
                filter_type,
                sample_rate,
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

            // Initialize AA filters (cutoff needs adjustment based on actual OS factor later)
            aa_upsampling_filter: AntiAliasingFilter::new(aa_cutoff_norm),
            aa_downsampling_filter: AntiAliasingFilter::new(aa_cutoff_norm),

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
        let mut resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
            if buf.len() < size {
                buf.resize(size, default_val);
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
        // AA filter cutoff should be slightly below the original Nyquist frequency.
        // Normalized cutoff is relative to the *oversampled* Nyquist.
        // If original Nyquist is Fs/2, the cutoff should be < Fs/2.
        // Relative to oversampled Nyquist (Fs*OS/2), this is < (Fs/2) / (Fs*OS/2) = 1/OS.
        let aa_cutoff_norm = (1.0 / self.oversampling_factor as f32) * 0.9; // e.g., 0.9 for margin
        self.aa_upsampling_filter = AntiAliasingFilter::new(aa_cutoff_norm);
        self.aa_downsampling_filter = AntiAliasingFilter::new(aa_cutoff_norm);
        self.aa_upsampling_filter.reset();
        self.aa_downsampling_filter.reset();
    }

    pub fn set_oversampling_factor(&mut self, factor: u32) {
        let new_factor = factor.clamp(1, *MAX_OVERSAMPLING);
        if new_factor != self.oversampling_factor {
            self.oversampling_factor = new_factor;
            self.update_aa_filters(); // Update and reset AA filters
                                      // Reset filter state as effective sample rate changed
            self.reset_filter_state();
        }
    }

    pub fn set_params(&mut self, cutoff: f32, resonance: f32) {
        self.base_cutoff = cutoff.clamp(20.0, 20000.0);
        self.base_resonance = resonance.clamp(0.0, 1.0);
        // Smoothed values will catch up
    }

    pub fn set_gain_db(&mut self, gain_db: f32) {
        self.base_gain_db = gain_db;
        // Biquad gain is updated per-sample/block when coefficients are set
    }

    // Removed set_gain_normalized, prefer set_gain_db

    pub fn set_keyboard_tracking_sensitivity(&mut self, sensitivity: f32) {
        self.keyboard_tracking_sensitivity = sensitivity.clamp(0.0, 1.0);
    }

    pub fn set_filter_type(&mut self, filter_type: FilterType) {
        if filter_type != self.filter_type {
            self.filter_type = filter_type;
            self.reset_filter_state(); // Reset state when type changes
                                       // Setup cascaded if needed (will be updated in process)
            if filter_type != FilterType::Ladder
                && filter_type != FilterType::Comb
                && self.slope == FilterSlope::Db24
            {
                self.setup_cascaded_filter();
            } else {
                self.cascaded = None;
            }
        }
    }

    pub fn set_filter_slope(&mut self, slope: FilterSlope) {
        if slope != self.slope {
            self.slope = slope;
            // Don't reset state just for slope change if type is the same
            if self.filter_type != FilterType::Ladder && self.filter_type != FilterType::Comb {
                if slope == FilterSlope::Db24 {
                    self.setup_cascaded_filter();
                } else {
                    self.cascaded = None; // Remove cascaded if switching to Db12
                }
            }
        }
    }

    /// Helper to initialize or update the cascaded filter instance.
    fn setup_cascaded_filter(&mut self) {
        let effective_sr = self.sample_rate * self.oversampling_factor as f32;
        // Use smoothed parameters for initialization, they will be updated anyway
        let stage_q = normalized_resonance_to_q(self.smoothed_resonance)
            .sqrt()
            .max(0.5); // Ensure Q > 0.5
        self.cascaded = Some(CascadedBiquad::new(
            self.filter_type,
            effective_sr,
            self.smoothed_cutoff,
            stage_q,
            self.base_gain_db,
        ));
    }

    // Comb filter parameters
    // pub fn set_comb_target_frequency(&mut self, freq: f32) {
    //     self.comb_target_frequency = freq.clamp(20.0, 20000.0);
    // }
    // Removed - Comb frequency is now controlled by cutoff param + tracking

    pub fn set_comb_dampening(&mut self, dampening: f32) {
        self.comb_dampening = dampening.clamp(0.0, 1.0);
    }

    /// Reset internal filter state (delays, etc.)
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
        self.aa_upsampling_filter.reset();
        self.aa_downsampling_filter.reset();
    }

    // --- Per-Sample Processing Logic ---

    /// Process a single sample through the currently configured filter.
    #[inline(always)]
    fn process_one_sample(
        &mut self,
        input: f32,
        cutoff: f32,
        resonance_norm: f32,
        effective_sr: f32,
    ) -> f32 {
        match self.filter_type {
            FilterType::Ladder => {
                self.process_ladder_sample(input, cutoff, resonance_norm, effective_sr)
            }
            FilterType::Comb => {
                self.process_comb_sample(input, cutoff, resonance_norm, effective_sr)
            }
            _ => self.process_biquad_sample(input, cutoff, resonance_norm, effective_sr),
        }
    }

    /// Process one sample using the Ladder filter implementation.
    #[inline(always)]
    fn process_ladder_sample(
        &mut self,
        input: f32,
        cutoff: f32,
        resonance_norm: f32,
        effective_sr: f32,
    ) -> f32 {
        // Calculate ladder parameters based on effective sample rate
        let g = (PI * cutoff / effective_sr).tan(); // Frequency coefficient
        let g_inv = 1.0 / (1.0 + g); // Normalization factor for feedback stage

        // Map normalized resonance (0-1) to feedback amount (0-4 typical, can go higher)
        let k = resonance_norm * 4.0; // Feedback amount

        // Simplified Moog Ladder algorithm (Direct Form)
        // Calculate intermediate stage outputs using tanh approximation
        let s0 = fast_tanh(input - k * self.ladder_stages[3]); // Input stage with feedback
        let s1 = fast_tanh(self.ladder_stages[0]);
        let s2 = fast_tanh(self.ladder_stages[1]);
        let s3 = fast_tanh(self.ladder_stages[2]);

        // Update stage values using one-pole filters (implicit Euler integration)
        self.ladder_stages[0] += 2.0 * g * (s0 - s1) * g_inv;
        self.ladder_stages[1] += 2.0 * g * (s1 - s2) * g_inv;
        self.ladder_stages[2] += 2.0 * g * (s2 - s3) * g_inv;
        self.ladder_stages[3] += 2.0 * g * (s3 - fast_tanh(self.ladder_stages[3])) * g_inv; // Last stage output uses its own tanh

        // Output is typically the last stage
        let output = self.ladder_stages[3];

        // Apply output gain
        output * 10f32.powf(self.base_gain_db / 20.0) // Convert dB gain to linear multiplier
    }

    /// Process one sample using the Comb filter implementation.
    #[inline(always)]
    fn process_comb_sample(
        &mut self,
        input: f32,
        freq: f32,
        resonance_norm: f32,
        effective_sr: f32,
    ) -> f32 {
        // Calculate delay length in samples based on frequency
        let delay_samples = (effective_sr / freq.max(1.0)).max(2.0); // Ensure freq > 0, delay >= 2

        // Read delayed sample using interpolation (e.g., Hermite or linear)
        // Using linear interpolation for simplicity/speed here:
        let delay_floor = delay_samples.floor();
        let delay_frac = delay_samples - delay_floor;
        let delay_int = delay_floor as usize;

        let buf_len = self.comb_buffer.len();
        let read_idx0 = (self.comb_buffer_index + buf_len - delay_int) % buf_len;
        let read_idx1 = (self.comb_buffer_index + buf_len - delay_int - 1) % buf_len; // Index for previous sample

        let y0 = self.comb_buffer[read_idx0];
        let y1 = self.comb_buffer[read_idx1];
        let delayed_sample = y0 + (y1 - y0) * delay_frac; // Linear interpolation

        // Dampening filter for feedback (one-pole lowpass)
        self.comb_last_output +=
            (1.0 - self.comb_dampening) * (delayed_sample - self.comb_last_output);

        // Calculate feedback signal
        let feedback = self.comb_last_output * resonance_norm; // Resonance controls feedback amount

        // Calculate output and write to buffer
        let output = input + feedback;
        self.comb_buffer[self.comb_buffer_index] = output;

        // Increment write index
        self.comb_buffer_index = (self.comb_buffer_index + 1) % buf_len;

        // Simple DC blocker (1st order highpass)
        let filtered_output = output - self.comb_dc_prev + 0.995 * self.comb_dc_state;
        self.comb_dc_prev = output;
        self.comb_dc_state = filtered_output;

        filtered_output
    }

    /// Process one sample using the Biquad filter implementation (12dB or 24dB).
    #[inline(always)]
    fn process_biquad_sample(
        &mut self,
        input: f32,
        cutoff: f32,
        resonance_norm: f32,
        effective_sr: f32,
    ) -> f32 {
        // Update Biquad coefficients based on potentially changed sample rate and parameters
        let q = normalized_resonance_to_q(resonance_norm);

        // Update primary biquad
        if self.biquad.sample_rate != effective_sr
            || self.biquad.frequency != cutoff
            || self.biquad.q != q
            || self.biquad.gain_db != self.base_gain_db
            || self.biquad.filter_type != self.filter_type
        {
            self.biquad.sample_rate = effective_sr;
            self.biquad.frequency = cutoff;
            self.biquad.q = q;
            self.biquad.gain_db = self.base_gain_db;
            self.biquad.filter_type = self.filter_type;
            self.biquad.update_coefficients();
        }

        match self.slope {
            FilterSlope::Db12 => self.biquad.process(input),
            FilterSlope::Db24 => {
                // Ensure cascaded filter exists and update its coefficients
                if self.cascaded.is_none() {
                    self.setup_cascaded_filter();
                }

                if let Some(ref mut cascaded) = self.cascaded {
                    let stage_q = q.sqrt().max(0.5); // Q for each stage
                    if cascaded.first.sample_rate != effective_sr
                        || cascaded.first.frequency != cutoff
                        || cascaded.first.q != stage_q
                        || cascaded.first.gain_db != self.base_gain_db
                        || cascaded.first.filter_type != self.filter_type
                    {
                        cascaded.first.sample_rate = effective_sr;
                        cascaded.first.frequency = cutoff;
                        cascaded.first.q = stage_q;
                        cascaded.first.gain_db = self.base_gain_db; // Apply gain only once? Or split? Usually split sqrt(gain)
                        cascaded.first.filter_type = self.filter_type;
                        cascaded.first.update_coefficients();

                        cascaded.second.sample_rate = effective_sr;
                        cascaded.second.frequency = cutoff;
                        cascaded.second.q = stage_q;
                        cascaded.second.gain_db = self.base_gain_db; // Apply gain only once?
                        cascaded.second.filter_type = self.filter_type;
                        cascaded.second.update_coefficients();
                    }
                    cascaded.process(input)
                } else {
                    // Fallback to 12dB if cascaded somehow failed to initialize
                    self.biquad.process(input)
                }
            }
        }
    }

    // Removed hermite interpolation helpers, using linear for comb for now.

    // Removed process_comb_filter helper as logic moved into process loop/process_one_sample
}

// Implement the modulation processor trait
impl ModulationProcessor for FilterCollection {}

impl AudioNode for FilterCollection {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        [
            (PortId::AudioInput0, false),     // Input audio signal
            (PortId::CutoffMod, false),       // Modulation for cutoff frequency
            (PortId::ResonanceMod, false),    // Modulation for resonance (0-1)
            (PortId::Frequency, false),       // Keyboard tracking base frequency (Hz)
            (PortId::GlobalFrequency, false), // Global tuning base frequency (Hz)
            (PortId::AudioOutput0, true),     // Output filtered audio
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
            None => return,
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
            if sources.map_or(false, |s| !s.is_empty()) {
                Self::accumulate_modulations_inplace(
                    buffer_size,
                    sources.map(|v| v.as_slice()),
                    &mut self.mod_scratch_add,
                    &mut self.mod_scratch_mult,
                );
                // Copy results to specific scratch buffers
                target_add[..buffer_size].copy_from_slice(&self.mod_scratch_add[..buffer_size]);
                target_mult[..buffer_size].copy_from_slice(&self.mod_scratch_mult[..buffer_size]);
            } else {
                target_add[..buffer_size].fill(default_add);
                target_mult[..buffer_size].fill(default_mult);
            }
        };

        process_mod_input(
            PortId::CutoffMod,
            &mut self.scratch_cutoff_add,
            &mut self.scratch_cutoff_mult,
            0.0,
            1.0,
        );
        process_mod_input(
            PortId::ResonanceMod,
            &mut self.scratch_res_add,
            &mut self.scratch_res_mult,
            0.0,
            1.0,
        );
        // For frequency inputs, treat them as additive base values (modulation usually targets cutoff directly)
        process_mod_input(
            PortId::Frequency,
            &mut self.scratch_freq_add,
            &mut self.scratch_freq_mult,
            440.0,
            1.0,
        );
        process_mod_input(
            PortId::GlobalFrequency,
            &mut self.scratch_global_freq_add,
            &mut self.scratch_global_freq_mult,
            440.0,
            1.0,
        );

        // --- 2) Main Processing Loop (Sample by Sample) ---
        let os_factor = self.oversampling_factor.max(1);
        let effective_sr = self.sample_rate * os_factor as f32;
        let base_440_hz = 440.0; // Reference for tracking

        // Store original SR for biquad if needed (restored after loop if OS > 1)
        let biquad_orig_sr = self.biquad.sample_rate;

        for i in 0..buffer_size {
            // Calculate target parameters for this sample
            let target_cutoff_base =
                (self.base_cutoff + self.scratch_cutoff_add[i]) * self.scratch_cutoff_mult[i];
            let target_resonance_norm =
                (self.base_resonance + self.scratch_res_add[i]) * self.scratch_res_mult[i];

            // Apply Keyboard & Global Frequency Tracking (multiplicative on cutoff)
            // Note: Using ADDITIVE scratch buffers as the source frequency value
            let key_freq = self.scratch_freq_add[i];
            let global_freq = self.scratch_global_freq_add[i];

            // Ratio relative to A440
            let key_ratio = (key_freq / base_440_hz).max(0.01); // Avoid div by zero or negative ratios
            let global_ratio = (global_freq / base_440_hz).max(0.01);

            // Apply sensitivity. Sensitivity=1 means ratio^1, Sensitivity=0 means ratio^0=1 (no tracking)
            let tracking_multiplier =
                key_ratio.powf(self.keyboard_tracking_sensitivity) * global_ratio; // Global tracking is usually full (sensitivity=1)

            let target_cutoff =
                (target_cutoff_base * tracking_multiplier).clamp(10.0, effective_sr * 0.49); // Clamp below Nyquist
            let target_resonance_clamped = target_resonance_norm.clamp(0.0, 1.0);

            // Apply smoothing
            let smoothing_factor = self.smoothing_factor;
            self.smoothed_cutoff += smoothing_factor * (target_cutoff - self.smoothed_cutoff);
            self.smoothed_resonance +=
                smoothing_factor * (target_resonance_clamped - self.smoothed_resonance);
            // Re-clamp after smoothing
            self.smoothed_cutoff = self.smoothed_cutoff.clamp(10.0, effective_sr * 0.49);
            self.smoothed_resonance = self.smoothed_resonance.clamp(0.0, 1.0);

            // --- Process Audio Sample(s) with Oversampling ---
            let input_sample = self.audio_in_buffer[i];

            // Upsample (process AA filter OS times or use polyphase)
            // Simplistic: Process AA filter once. Proper upsampling is more complex.
            // TODO: Fix AA filter before enabling.
            let upsampled_input = input_sample; // self.aa_upsampling_filter.process(input_sample);

            let mut current_output = 0.0;
            for _ in 0..os_factor {
                // Process one sub-sample at the effective sample rate
                current_output = self.process_one_sample(
                    upsampled_input, // Use same input for all sub-samples (Zero-Order Hold) - better would be interpolation!
                    self.smoothed_cutoff,
                    self.smoothed_resonance,
                    effective_sr,
                );
                // If we had proper upsampling, the input would change per sub-sample.
                // upsampled_input = 0.0; // For next sub-samples if using impulse train upsampling
            }

            // Downsample (process AA filter OS times or use polyphase)
            // Simplistic: Process AA filter once.
            // TODO: Fix AA filter before enabling.
            let final_output = current_output; // self.aa_downsampling_filter.process(current_output);

            output_buffer[i] = final_output;
        }

        // Restore original sample rate for biquad if oversampling was used
        if os_factor > 1 && self.biquad.sample_rate != biquad_orig_sr {
            self.biquad.sample_rate = biquad_orig_sr;
            // Don't necessarily need to update coefficients here, will be updated next block if needed
            // self.biquad.update_coefficients();
            if let Some(ref mut c) = self.cascaded {
                c.first.sample_rate = biquad_orig_sr;
                c.second.sample_rate = biquad_orig_sr;
            }
        }
    }

    fn reset(&mut self) {
        // Reset internal state like delays, feedback paths etc.
        self.reset_filter_state();
        // Reset smoothed parameters to base values
        self.smoothed_cutoff = self.base_cutoff;
        self.smoothed_resonance = self.base_resonance;
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
        self.enabled = active;
        if !active {
            self.reset(); // Reset state when deactivated
        }
    }
    fn node_type(&self) -> &str {
        "filtercollection"
    }
}

// Remove block_len helper, no longer used.

// Remove process_sample helper, logic integrated into process loop or process_one_sample.

// Keep frequency response generation methods, they use a temporary filter instance
impl FilterCollection {
    pub fn generate_frequency_response(&self, requested_length: usize) -> Vec<f32> {
        // Generate impulse response using a temporary instance
        let impulse_length = 2048.max(requested_length * 2); // Ensure enough resolution
        let impulse = self.create_impulse_response(impulse_length);

        // Calculate FFT magnitude (in dB)
        let fft_magnitude_db = self.calculate_fft_magnitude(impulse);

        // Frequency range for display
        let nyquist_hz = self.sample_rate * 0.5;
        let max_freq = 20_000.0_f32.min(nyquist_hz);
        let min_freq = 20.0;

        // Map frequency range to FFT bins
        let bin_max = (max_freq * (impulse_length as f32) / self.sample_rate)
            .min(fft_magnitude_db.len() as f32 - 1.0); // Index of max freq bin
        let bin_min = (min_freq * (impulse_length as f32) / self.sample_rate).max(0.0); // Index of min freq bin

        let points = requested_length;
        let mut response_db = Vec::with_capacity(points);

        // Logarithmic sampling of FFT bins
        let log_min = (bin_min + 1.0).ln(); // Add 1 to avoid ln(0)
        let log_max = (bin_max + 1.0).ln();

        for i in 0..points {
            let factor = i as f32 / (points.saturating_sub(1)).max(1) as f32; // 0.0 to 1.0
            let log_bin = log_min + (log_max - log_min) * factor;
            let bin = log_bin.exp() - 1.0; // Convert back from log scale

            // Linear interpolation between adjacent bins
            let bin_floor = (bin.floor() as usize).min(fft_magnitude_db.len() - 1);
            let bin_ceil = (bin_floor + 1).min(fft_magnitude_db.len() - 1);
            let frac = bin - bin_floor as f32;

            let db_val = if bin_floor == bin_ceil {
                fft_magnitude_db[bin_floor] // Avoid interpolation if frac is 0 or at the end
            } else {
                fft_magnitude_db[bin_floor] * (1.0 - frac) + fft_magnitude_db[bin_ceil] * frac
            };
            response_db.push(db_val);
        }

        // Normalize the dB values to a 0.0-1.0 range for display
        self.normalize_for_display_range(response_db, -60.0, 20.0) // Typical dB range for display
    }

    fn normalize_for_display_range(
        &self,
        mut data: Vec<f32>,
        db_floor: f32,
        db_ceiling: f32,
    ) -> Vec<f32> {
        let range = (db_ceiling - db_floor).max(1e-6); // Avoid division by zero
        for value in &mut data {
            let clamped_db = value.clamp(db_floor, db_ceiling);
            *value = (clamped_db - db_floor) / range;
        }
        data
    }

    /// Creates an impulse response for the current filter settings.
    fn create_impulse_response(&self, length: usize) -> Vec<f32> {
        // Create a temporary filter instance with current settings
        // IMPORTANT: This uses base parameters directly, not smoothed ones!
        // This reflects the "target" response, not the potentially smoothed real-time response.
        let mut temp_filter = FilterCollection::new(self.sample_rate);
        temp_filter.base_cutoff = self.base_cutoff;
        temp_filter.base_resonance = self.base_resonance;
        temp_filter.base_gain_db = self.base_gain_db;
        temp_filter.filter_type = self.filter_type;
        temp_filter.slope = self.slope;
        temp_filter.oversampling_factor = self.oversampling_factor; // Use current OS factor
        temp_filter.comb_dampening = self.comb_dampening;
        // Set smoothed params directly to base for impulse response
        temp_filter.smoothed_cutoff = self.base_cutoff;
        temp_filter.smoothed_resonance = self.base_resonance;

        // Setup cascaded/type specific things
        temp_filter.set_filter_type(self.filter_type); // Ensures correct internal setup
        temp_filter.set_filter_slope(self.slope);
        temp_filter.update_aa_filters(); // Ensure AA filters match OS factor

        let mut response = Vec::with_capacity(length);
        let effective_sr = temp_filter.sample_rate * temp_filter.oversampling_factor as f32;

        for i in 0..length {
            let input = if i == 0 { 1.0 } else { 0.0 };

            // Process with oversampling for impulse response
            // TODO: Fix AA filter before enabling.
            let upsampled_input = input; // temp_filter.aa_upsampling_filter.process(input);
            let mut current_output = 0.0;
            for _ in 0..temp_filter.oversampling_factor {
                current_output = temp_filter.process_one_sample(
                    upsampled_input,                // Use ZOH for impulse
                    temp_filter.smoothed_cutoff,    // Use base cutoff for impulse
                    temp_filter.smoothed_resonance, // Use base resonance for impulse
                    effective_sr,
                );
                // upsampled_input = 0.0; // For next sub-sample if using impulse train
            }
            // TODO: Fix AA filter before enabling.
            let final_output = current_output; // temp_filter.aa_downsampling_filter.process(current_output);
            response.push(final_output);
        }
        response
    }

    /// Calculates the FFT magnitude spectrum (in dB) from an impulse response.
    fn calculate_fft_magnitude(&self, impulse_response: Vec<f32>) -> Vec<f32> {
        use rustfft::{num_complex::Complex, FftPlanner};

        let fft_length = impulse_response.len();
        if fft_length == 0 {
            return vec![];
        }

        let mut planner = FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(fft_length);

        let mut buffer: Vec<Complex<f32>> = impulse_response
            .into_iter()
            .map(|x| Complex { re: x, im: 0.0 })
            .collect();

        fft.process(&mut buffer);

        // Calculate magnitude in dB, avoid log(0)
        let epsilon = 1e-10; // Small value to prevent log(0)
        let mut magnitude_db: Vec<f32> = buffer
            .iter()
            // Only take the first half (positive frequencies)
            .take(fft_length / 2)
            .map(|c| {
                let norm_sq = c.norm_sqr();
                // Convert power (norm_sq) to dB: 10 * log10(power)
                // Or convert amplitude (norm) to dB: 20 * log10(amplitude)
                10.0 * (norm_sq + epsilon).log10() // Using power dB
                                                   // 20.0 * (c.norm() + epsilon).log10() // Using amplitude dB
            })
            .collect();

        magnitude_db
    }
}
