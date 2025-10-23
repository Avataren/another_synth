#![allow(clippy::excessive_precision)]
#![allow(clippy::inline_always)]
// #![warn(unused_variables)] // Uncomment temporarily to help find unused variables

use once_cell::sync::Lazy;
use rustc_hash::FxHashMap;
use rustfft::num_traits::Float;
use rustfft::{num_complex::Complex, FftPlanner};
use std::any::Any;
use std::f32::consts::PI;
use wasm_bindgen::prelude::wasm_bindgen;

// Import necessary items from other modules (adjust paths as needed)
use crate::biquad::{Biquad, CascadedBiquad, Filter, FilterType};
use crate::graph::{
    ModulationProcessor, ModulationSource, ModulationTransformation, ModulationType,
};
use crate::traits::{AudioNode, PortId};

#[wasm_bindgen]
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum FilterSlope {
    Db12,
    Db24,
}

#[inline(always)]
fn normalized_resonance_to_q(normalized: f32) -> f32 {
    let norm_clamped = normalized.clamp(0.0, 1.0);
    0.5 + norm_clamped.powf(1.7) * 11.5
}

// --- Tanh LUT (unchanged) ---
static TANH_LUT: Lazy<[f32; 1024]> = Lazy::new(|| {
    let mut lut = [0.0; 1024];
    let x_min = -6.0;
    let x_max = 6.0;
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
    const X_MIN: f32 = -6.0;
    const X_MAX: f32 = 6.0;
    const RANGE: f32 = X_MAX - X_MIN;
    const INV_RANGE: f32 = 1.0 / RANGE;

    let clamped = x.clamp(X_MIN, X_MAX);
    let normalized = (clamped - X_MIN) * INV_RANGE;
    let index_f = normalized * LUT_SIZE_MINUS_1_F;
    let index = (index_f as usize).min(LUT_SIZE_MINUS_1_U);
    let frac = index_f - index as f32;

    let y0 = TANH_LUT[index];

    if index < LUT_SIZE_MINUS_1_U {
        let y1 = TANH_LUT[index + 1];
        // Manual lerp: y0 * (1.0 - frac) + y1 * frac
        y0.mul_add(1.0 - frac, y1 * frac)
    } else {
        y0
    }
}
// --- End Tanh LUT ---

const SAFE_NYQUIST_FACTOR: f32 = 0.49;

static MAX_COMB_BUFFER_SIZE: Lazy<usize> = Lazy::new(|| {
    let sample_rate = 96000.0;
    let min_freq = 10.0;
    (sample_rate / min_freq).ceil() as usize + 8
});

#[derive(Clone)]
pub struct FilterCollection {
    sample_rate: f32,
    base_cutoff: f32,
    base_resonance: f32,
    base_gain_db: f32,
    base_drive: f32,
    resonance_gain_compensation: f32,
    comb_base_frequency: f32,
    comb_dampening: f32,
    keyboard_tracking_sensitivity: f32,
    filter_type: FilterType,
    slope: FilterSlope,
    enabled: bool,

    smoothed_cutoff: f32,
    smoothed_resonance: f32,
    smoothing_factor: f32,

    biquad: Biquad,
    cascaded: Option<CascadedBiquad>,
    ladder_stages: [f32; 4],
    ladder_outputs: [f32; 4],

    comb_buffer: Vec<f32>,
    comb_buffer_index: usize,
    comb_last_output: f32,
    comb_dc_prev: f32,
    comb_dc_state: f32,

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

// =======================================================================
// Primary Implementation Block for FilterCollection
// =======================================================================
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
            base_drive: 0.0,
            resonance_gain_compensation: 0.5,
            comb_base_frequency,
            comb_dampening: 0.5,
            keyboard_tracking_sensitivity: 0.0,
            filter_type,
            slope,
            enabled: true,
            smoothed_cutoff: base_cutoff,
            smoothed_resonance: base_resonance,
            smoothing_factor: 0.02,
            biquad: Biquad::new(
                filter_type,
                sample_rate,
                base_cutoff,
                initial_q,
                base_gain_db,
            ),
            cascaded: None,
            ladder_stages: [0.0; 4],
            ladder_outputs: [0.0; 4],
            comb_buffer: vec![0.0; *MAX_COMB_BUFFER_SIZE],
            comb_buffer_index: 0,
            comb_last_output: 0.0,
            comb_dc_prev: 0.0,
            comb_dc_state: 0.0,
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

    fn ensure_scratch_buffers(&mut self, size: usize) {
        // (Implementation unchanged)
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

    pub fn set_params(&mut self, cutoff: f32, resonance: f32) {
        // (Implementation unchanged)
        let max_safe_cutoff = self.sample_rate * SAFE_NYQUIST_FACTOR;
        self.base_cutoff = cutoff.clamp(10.0, max_safe_cutoff);
        self.base_resonance = resonance.clamp(0.0, 1.0);
    }

    pub fn set_gain_db(&mut self, gain_db: f32) {
        // (Implementation unchanged)
        self.base_gain_db = gain_db;
    }

    pub fn set_drive(&mut self, drive: f32) {
        // (Implementation unchanged)
        self.base_drive = drive.clamp(0.0, 4.0); // Example range
    }

    pub fn set_resonance_gain_compensation(&mut self, comp: f32) {
        // (Implementation unchanged)
        self.resonance_gain_compensation = comp.clamp(0.0, 1.0);
    }

    pub fn set_keyboard_tracking_sensitivity(&mut self, sensitivity: f32) {
        // (Implementation unchanged)
        self.keyboard_tracking_sensitivity = sensitivity.clamp(0.0, 1.0);
    }

    pub fn set_filter_type(&mut self, filter_type: FilterType) {
        // (Implementation unchanged)
        if filter_type != self.filter_type {
            self.filter_type = filter_type;
            self.reset_filter_state();
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
        // (Implementation unchanged)
        if slope != self.slope {
            let old_slope = self.slope;
            self.slope = slope;
            if self.filter_type != FilterType::Ladder && self.filter_type != FilterType::Comb {
                if slope == FilterSlope::Db24 && old_slope == FilterSlope::Db12 {
                    self.setup_cascaded_filter();
                    // Reset state after setting up new configuration
                    if let Some(ref mut c) = self.cascaded {
                        c.reset();
                    }
                } else if slope == FilterSlope::Db12 && old_slope == FilterSlope::Db24 {
                    self.cascaded = None;
                    // Reset state for the single biquad
                    self.biquad.reset();
                }
            } else {
                // Reset ladder/comb state if slope changes (though slope doesn't apply)
                self.reset_filter_state();
            }
        }
    }

    fn setup_cascaded_filter(&mut self) {
        // (Implementation unchanged)
        if self.slope != FilterSlope::Db24
            || self.filter_type == FilterType::Ladder
            || self.filter_type == FilterType::Comb
        {
            self.cascaded = None;
            return;
        }

        let sr = self.sample_rate;
        let cutoff = self.smoothed_cutoff; // Use smoothed value
        let res = self.smoothed_resonance; // Use smoothed value
        let q_overall = normalized_resonance_to_q(res);
        let stage_q = q_overall.sqrt().max(0.501);

        if let Some(ref mut cascaded) = self.cascaded {
            cascaded.first.sample_rate = sr;
            cascaded.second.sample_rate = sr;
            cascaded.first.frequency = cutoff;
            cascaded.second.frequency = cutoff;
            cascaded.first.q = stage_q;
            cascaded.second.q = stage_q;
            cascaded.first.gain_db = 0.0;
            cascaded.second.gain_db = self.base_gain_db;
            cascaded.first.filter_type = self.filter_type;
            cascaded.second.filter_type = self.filter_type;
            cascaded.first.update_coefficients();
            cascaded.second.update_coefficients();
        } else {
            self.cascaded = Some(CascadedBiquad::new_with_gain_split(
                self.filter_type,
                sr,
                cutoff,
                stage_q,
                0.0,
                self.base_gain_db,
            ));
            // Reset state when creating new filter
            if let Some(ref mut c) = self.cascaded {
                c.reset();
            }
        }
    }

    pub fn set_comb_target_frequency(&mut self, freq: f32) {
        // (Implementation unchanged)
        let max_safe_freq = self.sample_rate * SAFE_NYQUIST_FACTOR;
        self.comb_base_frequency = freq.clamp(10.0, max_safe_freq);
    }

    pub fn set_comb_dampening(&mut self, dampening: f32) {
        // (Implementation unchanged)
        self.comb_dampening = dampening.clamp(0.0, 1.0);
    }

    fn reset_filter_state(&mut self) {
        // (Implementation unchanged)
        self.biquad.reset();
        if let Some(ref mut cascaded) = self.cascaded {
            cascaded.reset();
        }
        self.ladder_outputs.fill(0.0);
        self.ladder_stages.fill(0.0);
        self.comb_buffer.fill(0.0);
        self.comb_buffer_index = 0;
        self.comb_last_output = 0.0;
        self.comb_dc_prev = 0.0;
        self.comb_dc_state = 0.0;
    }

    #[inline(always)]
    fn process_ladder_sample(
        &mut self,
        input: f32,
        cutoff: f32,
        resonance_norm: f32,
        drive: f32,
        res_comp: f32,
        sample_rate: f32,
    ) -> f32 {
        // --- Parameter Calculation ---
        let effective_cutoff = cutoff.clamp(10.0, sample_rate * SAFE_NYQUIST_FACTOR);
        let wc = PI * effective_cutoff / sample_rate;
        let g = (wc * 0.5).tan(); // TPT pre-warping

        // --- Resonance & Compensation ---
        let k_resonance = resonance_norm.clamp(0.0, 1.0);
        // Moog resonance often goes up to 4x feedback
        let k = k_resonance.powf(1.5) * 4.0; // Enhanced resonance scaling
                                             // Compensation boosts the input signal path
        let comp_gain = (1.0 + res_comp * k).max(0.0);

        // --- Drive ---
        // Drive is applied as a gain *before* the tanh per stage
        let drive_gain = 1.0 + drive * 4.0; // Scaling for drive

        // --- State & Feedback ---
        // Get previous saturated outputs
        let s0 = self.ladder_stages[0];
        let s1 = self.ladder_stages[1];
        let s2 = self.ladder_stages[2];
        let s3 = self.ladder_stages[3];

        // Feedback comes from the previous sample's *saturated output* of the last stage
        let feedback = k * self.ladder_outputs[3]; // Use ladder_outputs[3]

        // --- Per-Stage Processing with Saturation ---

        // Stage 0
        let input0 = input * comp_gain - feedback; // Input signal * compensation - feedback
        let v0_linear_out = (s0 + g * input0) / (1.0 + g); // Linear TPT calculation
        let y0_saturated = fast_tanh(v0_linear_out * drive_gain); // Saturate and apply drive
        self.ladder_stages[0] = 2.0 * v0_linear_out - s0; // Update state based on linear output

        // Stage 1
        let input1 = y0_saturated; // Input is the saturated output of the previous stage
        let v1_linear_out = (s1 + g * input1) / (1.0 + g);
        let y1_saturated = fast_tanh(v1_linear_out * drive_gain);
        self.ladder_stages[1] = 2.0 * v1_linear_out - s1;

        // Stage 2
        let input2 = y1_saturated;
        let v2_linear_out = (s2 + g * input2) / (1.0 + g);
        let y2_saturated = fast_tanh(v2_linear_out * drive_gain);
        self.ladder_stages[2] = 2.0 * v2_linear_out - s2;

        // Stage 3
        let input3 = y2_saturated;
        let v3_linear_out = (s3 + g * input3) / (1.0 + g);
        let y3_saturated = fast_tanh(v3_linear_out * drive_gain); // Final stage output
        self.ladder_stages[3] = 2.0 * v3_linear_out - s3;

        // --- Store Saturated Outputs for Next Sample ---
        // self.ladder_outputs[0] = y0_saturated; // Only need the last one for feedback
        // self.ladder_outputs[1] = y1_saturated;
        // self.ladder_outputs[2] = y2_saturated;
        self.ladder_outputs[3] = y3_saturated; // Store the final saturated output

        // --- Return Filter Output ---
        y3_saturated // Output is the saturated result of the last stage
    }

    #[inline(always)]
    fn process_comb_sample(
        &mut self,
        input: f32,
        freq: f32,
        resonance_norm: f32,
        sample_rate: f32,
    ) -> f32 {
        // (Implementation unchanged)
        let clamped_freq = freq.clamp(10.0, sample_rate * SAFE_NYQUIST_FACTOR);
        let delay_samples = (sample_rate / clamped_freq).max(2.0);

        let clamped_res = resonance_norm.clamp(0.0, 0.995);
        let clamped_dampening = self.comb_dampening.clamp(0.0, 1.0);
        let alpha = clamped_dampening; // Use this variable

        let delay_floor = delay_samples.floor();
        let delay_frac = delay_samples - delay_floor;
        let delay_int = delay_floor as usize;

        let buf_len = self.comb_buffer.len();
        let read_idx0 = (self.comb_buffer_index + buf_len - (delay_int % buf_len)) % buf_len;
        let read_idx1 = (self.comb_buffer_index + buf_len - ((delay_int + 1) % buf_len)) % buf_len;

        let y0 = self.comb_buffer[read_idx0];
        let y1 = self.comb_buffer[read_idx1];
        // Manual lerp: y0 * (1.0 - delay_frac) + y1 * delay_frac
        let delayed_sample = y0.mul_add(1.0 - delay_frac, y1 * delay_frac);

        // Dampening filter in feedback path
        self.comb_last_output = self.comb_last_output * alpha + delayed_sample * (1.0 - alpha); // Correct one-pole LPF
        let feedback = self.comb_last_output * clamped_res;
        let buffer_write_val = input + feedback;

        self.comb_buffer[self.comb_buffer_index] = buffer_write_val;
        self.comb_buffer_index = (self.comb_buffer_index + 1) % buf_len;

        let comb_output = buffer_write_val;

        // DC blocker
        let filtered_output = comb_output - self.comb_dc_prev + 0.995 * self.comb_dc_state;
        self.comb_dc_prev = comb_output;
        self.comb_dc_state = filtered_output;

        filtered_output
    }

    #[inline(always)]
    fn process_biquad_sample(
        &mut self,
        input: f32,
        cutoff: f32,
        resonance_norm: f32,
        sample_rate: f32,
    ) -> f32 {
        let safe_cutoff = cutoff.clamp(10.0, sample_rate * SAFE_NYQUIST_FACTOR);
        let safe_resonance = resonance_norm.clamp(0.0, 1.0);
        let q = normalized_resonance_to_q(safe_resonance);

        const EPSILON: f32 = 1e-4;

        match self.slope {
            FilterSlope::Db12 => {
                let single_biquad_gain = self.base_gain_db;
                // Check if biquad parameters need updating
                let needs_update = self.biquad.sample_rate != sample_rate
                    || (self.biquad.frequency - safe_cutoff).abs() > EPSILON
                    || (self.biquad.q - q).abs() > EPSILON
                    || self.biquad.filter_type != self.filter_type
                    || (self.biquad.gain_db - single_biquad_gain).abs() > EPSILON; // Include gain check

                if needs_update {
                    // --- FIX: Assign fields directly and call update_coefficients ---
                    self.biquad.filter_type = self.filter_type;
                    self.biquad.sample_rate = sample_rate;
                    self.biquad.frequency = safe_cutoff;
                    self.biquad.q = q;
                    self.biquad.gain_db = single_biquad_gain;
                    self.biquad.update_coefficients();
                    // Consider resetting state if filter type changes drastically?
                    // if self.biquad.filter_type != old_filter_type { self.biquad.reset(); }
                    // --- End FIX ---
                }
                self.biquad.process(input)
            }
            FilterSlope::Db24 => {
                let stage_q = q.sqrt().max(0.501);
                let second_stage_gain = self.base_gain_db;

                // Check if cascaded filter needs setup or update
                let cascaded_needs_update = match self.cascaded {
                    None => true,
                    Some(ref c) => {
                        c.first.sample_rate != sample_rate
                            || (c.first.frequency - safe_cutoff).abs() > EPSILON
                            || (c.first.q - stage_q).abs() > EPSILON
                            || (c.second.gain_db - second_stage_gain).abs() > EPSILON
                            || c.first.filter_type != self.filter_type
                    }
                };

                if cascaded_needs_update {
                    // Setup/Update happens within setup_cascaded_filter call below or implicitly
                    // We can call setup_cascaded_filter here to ensure it's current
                    self.setup_cascaded_filter();
                    // Reset should be handled inside setup_cascaded_filter if created new
                }

                // Process through the cascaded filter
                if let Some(ref mut cascaded) = self.cascaded {
                    cascaded.process(input)
                } else {
                    // Fallback if cascaded is still None (shouldn't happen with logic above)
                    eprintln!(
                        "Warning: Cascaded filter expected but missing in 24dB mode (fallback)."
                    );
                    // --- FIX: Assign fields directly and call update_coefficients ---
                    self.biquad.filter_type = self.filter_type;
                    self.biquad.sample_rate = sample_rate;
                    self.biquad.frequency = safe_cutoff;
                    // Use the overall Q for the single biquad fallback, not stage_q
                    self.biquad.q = q;
                    self.biquad.gain_db = self.base_gain_db;
                    self.biquad.update_coefficients();
                    // --- End FIX ---
                    self.biquad.process(input) // Process with the single biquad
                }
            }
        }
    }
    // --- Frequency Response Methods ---

    pub fn generate_frequency_response(&self, requested_length: usize) -> Vec<f32> {
        let impulse_length = 4096.max(requested_length * 4);
        let impulse = self.create_impulse_response(impulse_length);
        let fft_magnitude_db = self.calculate_fft_magnitude(impulse);

        let nyquist_hz = self.sample_rate * 0.5;
        let max_freq_hz = 20_000.0_f32.min(nyquist_hz);
        let min_freq_hz = 20.0_f32;
        let fft_bins = fft_magnitude_db.len();

        let bin_max =
            (max_freq_hz * (fft_bins as f32 * 2.0) / self.sample_rate).min(fft_bins as f32 - 1.0);
        let bin_min = (min_freq_hz * (fft_bins as f32 * 2.0) / self.sample_rate).max(0.0);

        let points = requested_length;
        let mut response_db_interpolated = Vec::with_capacity(points);

        if fft_bins == 0 || points == 0 {
            return vec![0.0; points];
        }

        let log_bin_min = (bin_min.max(0.0) + 1.0).ln();
        let log_bin_max = (bin_max.max(0.0) + 1.0).ln();
        let log_range = (log_bin_max - log_bin_min).max(f32::EPSILON);

        for i in 0..points {
            let factor = if points > 1 {
                i as f32 / (points - 1) as f32
            } else {
                0.0
            };
            let log_bin = log_bin_min + log_range * factor;
            let bin = log_bin.exp() - 1.0;

            let bin_floor = (bin.floor().max(0.0) as usize).min(fft_bins.saturating_sub(1));
            let bin_ceil = (bin_floor + 1).min(fft_bins.saturating_sub(1));
            let frac = bin - bin_floor as f32;

            let db_val =
                if bin_floor >= fft_magnitude_db.len() || bin_ceil >= fft_magnitude_db.len() {
                    *fft_magnitude_db.last().unwrap_or(&-120.0)
                } else if bin_floor == bin_ceil {
                    fft_magnitude_db[bin_floor]
                } else {
                    let mag0 = fft_magnitude_db[bin_floor];
                    let mag1 = fft_magnitude_db[bin_ceil];
                    // Manual lerp: mag0 * (1.0 - frac) + mag1 * frac
                    mag0.mul_add(1.0 - frac, mag1 * frac)
                };
            response_db_interpolated.push(db_val);
        }
        self.normalize_for_display_range(response_db_interpolated, -60.0, 18.0)
    }

    fn normalize_for_display_range(
        &self,
        mut data: Vec<f32>,
        db_floor: f32,
        db_ceiling: f32,
    ) -> Vec<f32> {
        // (Implementation unchanged)
        let range = (db_ceiling - db_floor).max(1e-6);
        for value in &mut data {
            let clamped_db = value.clamp(db_floor, db_ceiling);
            *value = (clamped_db - db_floor) / range;
        }
        data
    }

    fn create_impulse_response(&self, length: usize) -> Vec<f32> {
        // (Implementation unchanged)
        let mut temp_filter = self.clone();
        temp_filter.reset();

        let max_safe_cutoff = temp_filter.sample_rate * SAFE_NYQUIST_FACTOR;
        temp_filter.smoothed_cutoff = temp_filter.base_cutoff.clamp(10.0, max_safe_cutoff);
        temp_filter.smoothed_resonance = temp_filter.base_resonance.clamp(0.0, 1.0);

        if temp_filter.filter_type != FilterType::Ladder
            && temp_filter.filter_type != FilterType::Comb
            && temp_filter.slope == FilterSlope::Db24
        {
            temp_filter.setup_cascaded_filter();
        }

        let mut response = Vec::with_capacity(length);
        let sample_rate = temp_filter.sample_rate;
        let impulse_comb_freq = temp_filter.comb_base_frequency;
        let impulse_drive = temp_filter.base_drive;
        let impulse_res_comp = temp_filter.resonance_gain_compensation;
        let output_gain = 10f32.powf(temp_filter.base_gain_db / 20.0);

        for i in 0..length {
            let input = if i == 0 { 1.0 } else { 0.0 };

            let filter_output = match temp_filter.filter_type {
                FilterType::Ladder => temp_filter.process_ladder_sample(
                    input,
                    temp_filter.smoothed_cutoff,
                    temp_filter.smoothed_resonance,
                    impulse_drive,
                    impulse_res_comp,
                    sample_rate,
                ),
                FilterType::Comb => temp_filter.process_comb_sample(
                    input,
                    impulse_comb_freq,
                    temp_filter.smoothed_resonance,
                    sample_rate,
                ),
                _ => temp_filter.process_biquad_sample(
                    input,
                    temp_filter.smoothed_cutoff,
                    temp_filter.smoothed_resonance,
                    sample_rate,
                ),
            };
            response.push(filter_output * output_gain);
        }
        response
    }

    fn calculate_fft_magnitude(&self, impulse_response: Vec<f32>) -> Vec<f32> {
        // (Implementation unchanged)
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

        let half_len = fft_length / 2;
        let epsilon = 1e-10;
        let magnitude_db: Vec<f32> = buffer
            .iter()
            .take(half_len)
            .map(|c| {
                let norm_sq = c.norm_sqr();
                10.0 * (norm_sq + epsilon).log10()
            })
            .collect();
        magnitude_db
    }
} // End of the main `impl FilterCollection` block

// =======================================================================
// ModulationProcessor Implementation (unchanged)
// =======================================================================
impl ModulationProcessor for FilterCollection {}

// =======================================================================
// AudioNode Implementation
// =======================================================================
impl AudioNode for FilterCollection {
    fn get_ports(&self) -> FxHashMap<PortId, bool> {
        // (Implementation unchanged)
        [
            (PortId::AudioInput0, false),
            (PortId::CutoffMod, false),
            (PortId::ResonanceMod, false),
            (PortId::Frequency, false),
            (PortId::GlobalFrequency, false),
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

        // --- 1. Prepare Input Audio Buffer ---
        // (Implementation unchanged)
        self.audio_in_buffer[..buffer_size].fill(0.0);
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

        // --- 2. Prepare Modulation Buffers ---
        // (Implementation unchanged)
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
        // Add DriveMod processing here if needed

        // --- 3. Process Audio Samples ---
        let sample_rate = self.sample_rate;
        let base_440_hz = 440.0;
        let smoothing_factor_cutoff = self.smoothing_factor;
        let smoothing_factor_res = self.smoothing_factor;
        let output_gain = 10f32.powf(self.base_gain_db / 20.0);
        let max_freq_limit = sample_rate * SAFE_NYQUIST_FACTOR;

        let current_drive = self.base_drive; // Add modulation lookup here if needed
        let current_res_comp = self.resonance_gain_compensation;

        for i in 0..buffer_size {
            // --- Calculate Target Parameters ---
            let target_cutoff_base =
                (self.base_cutoff + self.scratch_cutoff_add[i]) * self.scratch_cutoff_mult[i];
            let target_resonance_norm =
                (self.base_resonance + self.scratch_res_add[i]) * self.scratch_res_mult[i];

            // --- Keyboard Tracking ---
            let key_freq = (self.scratch_freq_add[i] * self.scratch_freq_mult[i]).max(10.0);
            let global_freq =
                (self.scratch_global_freq_add[i] * self.scratch_global_freq_mult[i]).max(10.0);
            let key_ratio = key_freq / base_440_hz;
            let global_ratio = global_freq / base_440_hz;
            let tracking_multiplier = {
                let effective_ratio = key_ratio * global_ratio;
                let sensitivity = self.keyboard_tracking_sensitivity;
                // Manual lerp: 1.0 * (1.0 - sensitivity) + effective_ratio * sensitivity
                let multiplier = (1.0 - sensitivity).mul_add(1.0, effective_ratio * sensitivity);
                multiplier.max(0.0) // Ensure non-negative
            };

            let target_cutoff =
                (target_cutoff_base * tracking_multiplier).clamp(10.0, max_freq_limit);
            let target_comb_freq =
                (self.comb_base_frequency * tracking_multiplier).clamp(10.0, max_freq_limit);
            let target_resonance_clamped = target_resonance_norm.clamp(0.0, 1.0);

            // --- Smooth Parameters (using manual lerp) ---
            let sm_cut = smoothing_factor_cutoff;
            self.smoothed_cutoff = self.smoothed_cutoff * (1.0 - sm_cut) + target_cutoff * sm_cut;
            let sm_res = smoothing_factor_res;
            self.smoothed_resonance =
                self.smoothed_resonance * (1.0 - sm_res) + target_resonance_clamped * sm_res;

            self.smoothed_cutoff = self.smoothed_cutoff.clamp(10.0, max_freq_limit);
            self.smoothed_resonance = self.smoothed_resonance.clamp(0.0, 1.0);

            // --- Process Single Sample ---
            let input_sample = self.audio_in_buffer[i];
            let filter_output = match self.filter_type {
                FilterType::Ladder => self.process_ladder_sample(
                    input_sample,
                    self.smoothed_cutoff,
                    self.smoothed_resonance,
                    current_drive,
                    current_res_comp,
                    sample_rate,
                ),
                FilterType::Comb => self.process_comb_sample(
                    input_sample,
                    target_comb_freq, // Use tracked comb freq
                    self.smoothed_resonance,
                    sample_rate,
                ),
                _ => self.process_biquad_sample(
                    input_sample,
                    self.smoothed_cutoff,
                    self.smoothed_resonance,
                    sample_rate,
                ),
            };

            // --- Final Output ---
            output_buffer[i] = filter_output * output_gain;
        }
    }

    fn reset(&mut self) {
        // (Implementation unchanged)
        self.reset_filter_state();
        let max_safe_cutoff = self.sample_rate * SAFE_NYQUIST_FACTOR;
        self.smoothed_cutoff = self.base_cutoff.clamp(10.0, max_safe_cutoff);
        self.smoothed_resonance = self.base_resonance.clamp(0.0, 1.0);
        if self.filter_type != FilterType::Ladder
            && self.filter_type != FilterType::Comb
            && self.slope == FilterSlope::Db24
        {
            self.setup_cascaded_filter();
        } else {
            self.cascaded = None;
        }
    }

    fn is_active(&self) -> bool {
        // (Implementation unchanged)
        self.enabled
    }

    fn set_active(&mut self, active: bool) {
        // (Implementation unchanged)
        if !active && self.enabled {
            self.reset();
        }
        self.enabled = active;
    }

    fn node_type(&self) -> &str {
        // (Implementation unchanged)
        "filtercollection"
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        // (Implementation unchanged)
        self
    }

    fn as_any(&self) -> &dyn Any {
        // (Implementation unchanged)
        self
    }
} // End of `impl AudioNode for FilterCollection` block

// =======================================================================
// Unit Tests
// =======================================================================
#[cfg(test)]
mod tests {
    use super::*;
    // Removed the Lerp trait definition - no longer needed

    const TEST_SAMPLE_RATE: f32 = 48000.0;
    const FFT_LEN: usize = 8192;

    // Helper using manual lerp
    fn get_fft_magnitude_at_freq(
        fft_magnitudes_db: &[f32],
        freq_hz: f32,
        sample_rate: f32,
        fft_len: usize,
    ) -> Option<f32> {
        let num_bins = fft_magnitudes_db.len();
        if num_bins == 0 || freq_hz < 0.0 || freq_hz > sample_rate * 0.5 {
            return None;
        }
        let bin_index_f = freq_hz * fft_len as f32 / sample_rate;

        if bin_index_f < 0.0 {
            return fft_magnitudes_db.first().copied();
        }
        if bin_index_f >= (num_bins - 1) as f32 {
            return fft_magnitudes_db.last().copied();
        }

        let bin_index0 = bin_index_f.floor() as usize;
        let bin_index1 = bin_index0 + 1;
        let frac = bin_index_f - bin_index0 as f32;

        let mag0 = fft_magnitudes_db[bin_index0];
        let mag1 = fft_magnitudes_db[bin_index1];
        // Manual lerp: mag0 * (1.0 - frac) + mag1 * frac
        Some(mag0.mul_add(1.0 - frac, mag1 * frac))
    }

    // --- All tests below are unchanged from the previous version ---
    // --- They should now compile and run correctly ---

    #[test]
    fn test_filter_collection_lowpass_response_12db() {
        let cutoff_hz = 1000.0;
        let resonance_norm = 0.0;
        let mut fc = FilterCollection::new(TEST_SAMPLE_RATE);
        fc.set_filter_type(FilterType::LowPass);
        fc.set_filter_slope(FilterSlope::Db12);
        fc.set_params(cutoff_hz, resonance_norm);
        fc.set_gain_db(0.0);

        let ir = fc.create_impulse_response(FFT_LEN);
        let mag_db = fc.calculate_fft_magnitude(ir);

        let mag_pass =
            get_fft_magnitude_at_freq(&mag_db, cutoff_hz * 0.1, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_cutoff =
            get_fft_magnitude_at_freq(&mag_db, cutoff_hz, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_stop1 =
            get_fft_magnitude_at_freq(&mag_db, cutoff_hz * 2.0, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_stop2 =
            get_fft_magnitude_at_freq(&mag_db, cutoff_hz * 4.0, TEST_SAMPLE_RATE, FFT_LEN).unwrap();

        println!("LPF 12dB Response @{:.1}Hz Res={:.2}: Pass={:.2}dB, Cutoff={:.2}dB, Stop1={:.2}dB, Stop2={:.2}dB", cutoff_hz, resonance_norm, mag_pass, mag_cutoff, mag_stop1, mag_stop2);

        assert!(
            mag_pass.abs() < 1.5,
            "Passband gain ({:.2}dB) should be near 0dB",
            mag_pass
        );
        assert!(
            (mag_cutoff - -6.0).abs() < 2.0,
            "Cutoff gain ({:.2}dB) should be near -6dB for low Q",
            mag_cutoff
        );
        let attenuation1 = mag_pass - mag_stop1;
        assert!(
            attenuation1 > 9.0 && attenuation1 < 15.0,
            "Attenuation at 1 octave ({:.2}dB) should be approx 12dB",
            attenuation1
        );
        let attenuation2 = mag_pass - mag_stop2;
        assert!(
            attenuation2 > 21.0 && attenuation2 < 28.0,
            "Attenuation at 2 octaves ({:.2}dB) should be approx 24dB",
            attenuation2
        );
    }
    #[test]
    fn test_filter_collection_lowpass_response_24db_resonance() {
        let cutoff_hz = 1000.0;
        let resonance_norm = 0.7;
        let mut fc = FilterCollection::new(TEST_SAMPLE_RATE);
        fc.set_filter_type(FilterType::LowPass);
        fc.set_filter_slope(FilterSlope::Db24);
        fc.set_params(cutoff_hz, resonance_norm);
        fc.set_gain_db(0.0);

        let ir = fc.create_impulse_response(FFT_LEN);
        let mag_db = fc.calculate_fft_magnitude(ir);

        let mag_pass =
            get_fft_magnitude_at_freq(&mag_db, cutoff_hz * 0.1, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_peak_freq = cutoff_hz * 0.9;
        let mag_peak =
            get_fft_magnitude_at_freq(&mag_db, mag_peak_freq, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_cutoff =
            get_fft_magnitude_at_freq(&mag_db, cutoff_hz, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_stop1 =
            get_fft_magnitude_at_freq(&mag_db, cutoff_hz * 2.0, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag_stop2 =
            get_fft_magnitude_at_freq(&mag_db, cutoff_hz * 4.0, TEST_SAMPLE_RATE, FFT_LEN).unwrap();

        println!("LPF 24dB Response @{:.1}Hz Res={:.2}: Pass={:.2}dB, Peak(~{:.1}Hz)={:.2}dB, Cutoff={:.2}dB, Stop1={:.2}dB, Stop2={:.2}dB", cutoff_hz, resonance_norm, mag_pass, mag_peak_freq, mag_peak, mag_cutoff, mag_stop1, mag_stop2);

        assert!(
            mag_pass.abs() < 2.0,
            "Passband gain ({:.2}dB) should be near 0dB",
            mag_pass
        );
        let expected_q = normalized_resonance_to_q(resonance_norm);
        let expected_peak_db = (20.0 * expected_q.log10()).max(0.0);
        println!(
            "Expected Q: {:.2}, Estimated single peak: {:.2}dB",
            expected_q, expected_peak_db
        );
        assert!(
            mag_peak > 3.0,
            "Expected resonant peak near cutoff ({:.2}dB), but peak is too low or flat",
            mag_peak
        );

        let attenuation1 = mag_pass - mag_stop1;
        assert!(
            attenuation1 > 18.0,
            "Attenuation at 1 octave ({:.2}dB) is too low (expected > ~24dB eventually)",
            attenuation1
        );
        let attenuation2 = mag_pass - mag_stop2;
        assert!(
            attenuation2 > 40.0,
            "Attenuation at 2 octaves ({:.2}dB) is too low (expected > ~48dB eventually)",
            attenuation2
        );
    }

    #[test]
    fn test_ladder_stability_high_cutoff_resonance() {
        let cutoff_hz = TEST_SAMPLE_RATE * SAFE_NYQUIST_FACTOR * 0.99;
        let resonance_norm = 0.95;
        let mut fc = FilterCollection::new(TEST_SAMPLE_RATE);
        fc.set_filter_type(FilterType::Ladder);
        fc.set_params(cutoff_hz, resonance_norm);
        fc.set_gain_db(0.0);

        let buffer_size = 512;
        let mut output_buffer = vec![0.0; buffer_size];
        let mut outputs = FxHashMap::default();
        outputs.insert(PortId::AudioOutput0, output_buffer.as_mut_slice());

        let audio_input_data = vec![0.0; buffer_size];
        let audio_source = ModulationSource {
            buffer: audio_input_data,
            amount: 1.0,
            mod_type: ModulationType::Additive,
            transformation: ModulationTransformation::None,
        };
        let mut inputs = FxHashMap::default();
        inputs.insert(PortId::AudioInput0, vec![audio_source]);

        for _ in 0..5 {
            fc.process(&inputs, &mut outputs, buffer_size);
        }

        let is_finite = output_buffer.iter().all(|&x| x.is_finite());
        assert!(
            is_finite,
            "Ladder filter output contains NaN or Inf at high cutoff/resonance"
        );

        let max_abs_val = output_buffer
            .iter()
            .fold(0.0f32, |max_val, &val| max_val.max(val.abs()));

        let expected_max =
            4.0 / (1.0 + fc.resonance_gain_compensation * resonance_norm * 4.0) * 1.5;
        println!(
            "Ladder max output at high settings: {:.4} (Expected limit ~{:.4})",
            max_abs_val, expected_max
        );
        assert!(max_abs_val < expected_max.max(2.0),
            "Ladder filter output magnitude ({:.2}) seems excessively high ({:.2}), potential instability?", max_abs_val, expected_max);
    }

    #[test]
    fn test_ladder_drive_effect() {
        let cutoff_hz = 500.0;
        let resonance_norm = 0.2;
        let mut fc_low_drive = FilterCollection::new(TEST_SAMPLE_RATE);
        fc_low_drive.set_filter_type(FilterType::Ladder);
        fc_low_drive.set_params(cutoff_hz, resonance_norm);
        fc_low_drive.set_drive(0.0);
        fc_low_drive.set_gain_db(0.0);

        let mut fc_high_drive = fc_low_drive.clone();
        fc_high_drive.set_drive(1.0);

        let buffer_size = 512;
        let mut input_buffer = vec![0.0; buffer_size];
        let freq = 100.0;
        for i in 0..buffer_size {
            input_buffer[i] = (2.0 * PI * freq * i as f32 / TEST_SAMPLE_RATE).sin() * 0.8;
        }

        let mut output_low = vec![0.0; buffer_size];
        let mut output_high = vec![0.0; buffer_size];
        let mut outputs_low = FxHashMap::default();
        let mut outputs_high = FxHashMap::default();
        outputs_low.insert(PortId::AudioOutput0, output_low.as_mut_slice());
        outputs_high.insert(PortId::AudioOutput0, output_high.as_mut_slice());

        let audio_source = ModulationSource {
            buffer: input_buffer.clone(),
            amount: 1.0,
            mod_type: ModulationType::Additive,
            transformation: ModulationTransformation::None,
        };
        let mut inputs = FxHashMap::default();
        inputs.insert(PortId::AudioInput0, vec![audio_source]);

        fc_low_drive.process(&inputs, &mut outputs_low, buffer_size);
        fc_high_drive.process(&inputs, &mut outputs_high, buffer_size);

        let rms_low = (output_low.iter().map(|x| x * x).sum::<f32>() / buffer_size as f32).sqrt();
        let rms_high = (output_high.iter().map(|x| x * x).sum::<f32>() / buffer_size as f32).sqrt();
        let peak_low = output_low.iter().fold(0.0, |a: f32, &b| a.max(b.abs()));
        let peak_high = output_high.iter().fold(0.0, |a: f32, &b| a.max(b.abs()));

        println!(
            "RMS Low Drive: {:.4}, RMS High Drive: {:.4}",
            rms_low, rms_high
        );
        println!(
            "Peak Low Drive: {:.4}, Peak High Drive: {:.4}",
            peak_low, peak_high
        );

        assert!(rms_high > rms_low * 1.1 || peak_high > peak_low * 1.1, "High drive should produce a noticeably different (likely louder or more distorted) output");
    }

    #[test]
    fn test_resonance_compensation() {
        let cutoff_hz = 1000.0;
        let mut fc_no_comp = FilterCollection::new(TEST_SAMPLE_RATE);
        fc_no_comp.set_filter_type(FilterType::Ladder);
        fc_no_comp.set_params(cutoff_hz, 0.9);
        fc_no_comp.set_resonance_gain_compensation(0.0);
        fc_no_comp.set_gain_db(0.0);

        let mut fc_with_comp = fc_no_comp.clone();
        fc_with_comp.set_resonance_gain_compensation(0.7);

        let ir_no_comp = fc_no_comp.create_impulse_response(FFT_LEN);
        let mag_db_no_comp = fc_no_comp.calculate_fft_magnitude(ir_no_comp);

        let ir_with_comp = fc_with_comp.create_impulse_response(FFT_LEN);
        let mag_db_with_comp = fc_with_comp.calculate_fft_magnitude(ir_with_comp);

        let pass_freq = cutoff_hz * 0.1;
        let pass_db_no_comp =
            get_fft_magnitude_at_freq(&mag_db_no_comp, pass_freq, TEST_SAMPLE_RATE, FFT_LEN)
                .unwrap();
        let pass_db_with_comp =
            get_fft_magnitude_at_freq(&mag_db_with_comp, pass_freq, TEST_SAMPLE_RATE, FFT_LEN)
                .unwrap();

        println!("Passband Gain (No Comp): {:.2} dB", pass_db_no_comp);
        println!("Passband Gain (With Comp): {:.2} dB", pass_db_with_comp);

        assert!(
            pass_db_no_comp < -6.0,
            "Expected significant gain reduction in passband without compensation (Got {:.2} dB)",
            pass_db_no_comp
        );
        assert!(
            pass_db_with_comp > -3.0 && pass_db_with_comp < 3.0,
            "Expected passband gain near 0dB with compensation (Got {:.2} dB)",
            pass_db_with_comp
        );
    }

    #[test]
    fn test_high_cutoff_no_resonance_artifact() {
        let cutoff_hz = 20000.0;
        let resonance_norm = 0.0;
        let mut fc = FilterCollection::new(TEST_SAMPLE_RATE);
        fc.set_filter_type(FilterType::Ladder);
        fc.set_params(cutoff_hz, resonance_norm);
        fc.set_gain_db(0.0);

        let ir = fc.create_impulse_response(FFT_LEN);
        let mag_db = fc.calculate_fft_magnitude(ir);

        let freq1 = cutoff_hz * 0.95;
        let freq2 = cutoff_hz;
        let freq3 = (cutoff_hz + TEST_SAMPLE_RATE * 0.5) * 0.5;
        let freq4 = TEST_SAMPLE_RATE * 0.5 * 0.98;

        let mag1 = get_fft_magnitude_at_freq(&mag_db, freq1, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag2 = get_fft_magnitude_at_freq(&mag_db, freq2, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag3 = get_fft_magnitude_at_freq(&mag_db, freq3, TEST_SAMPLE_RATE, FFT_LEN).unwrap();
        let mag4 = get_fft_magnitude_at_freq(&mag_db, freq4, TEST_SAMPLE_RATE, FFT_LEN).unwrap();

        println!("High Cutoff (20kHz), Res=0 Response: @{:.0}Hz={:.2}dB, @{:.0}Hz={:.2}dB, @{:.0}Hz={:.2}dB, @{:.0}Hz={:.2}dB",
                 freq1, mag1, freq2, mag2, freq3, mag3, freq4, mag4);

        let max_peak_allowed = 3.0;
        assert!(
            mag1 < max_peak_allowed,
            "Unexpected peak ({:.2}dB) below high cutoff with res=0",
            mag1
        );
        assert!(
            mag2 < max_peak_allowed,
            "Unexpected peak ({:.2}dB) at high cutoff with res=0",
            mag2
        );
        assert!(
            mag3 < max_peak_allowed,
            "Unexpected peak ({:.2}dB) between cutoff and Nyquist with res=0",
            mag3
        );
        assert!(
            mag4 < max_peak_allowed,
            "Unexpected peak ({:.2}dB) near Nyquist with res=0",
            mag4
        );

        assert!(mag4 < mag1 + 3.0, "Magnitude near Nyquist ({:.2}dB) should not be significantly higher than below cutoff ({:.2}dB) when res=0", mag4, mag1);
    }
}
