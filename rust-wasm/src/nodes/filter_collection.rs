use once_cell::sync::Lazy;
use std::any::Any;
use std::collections::HashMap;
use wasm_bindgen::prelude::wasm_bindgen;

// Import the biquad types (including FilterType) without redefining them.
use crate::biquad::{Biquad, CascadedBiquad, Filter, FilterType};
use crate::graph::{ModulationProcessor, ModulationSource};
use crate::traits::{AudioNode, PortId};

/// Biquad‑specific slope selection.
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub enum FilterSlope {
    Db12,
    Db24,
}

/// Helper: map a normalized resonance (0–1) to a Q factor.
fn normalized_resonance_to_q(normalized: f32) -> f32 {
    0.707 + 9.293 * normalized
}

/// Fast tanh approximation using a precomputed lookup table with linear interpolation.
/// The table spans from -5.0 to 5.0 (beyond which tanh saturates).
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

fn fast_tanh(x: f32) -> f32 {
    const LUT_SIZE: usize = 1024;
    const X_MIN: f32 = -5.0;
    const X_MAX: f32 = 5.0;
    // Clamp x to the LUT range.
    let clamped = x.clamp(X_MIN, X_MAX);
    let normalized = (clamped - X_MIN) / (X_MAX - X_MIN) * (LUT_SIZE as f32 - 1.0);
    let index = normalized.floor() as usize;
    let frac = normalized - (index as f32);
    if index < LUT_SIZE - 1 {
        TANH_LUT[index] * (1.0 - frac) + TANH_LUT[index + 1] * frac
    } else {
        TANH_LUT[LUT_SIZE - 1]
    }
}

/// Maximum allowed oversampling factor.
static MAX_OVERSAMPLING: Lazy<u32> = Lazy::new(|| 16);

/// Precomputed maximum delay line length for the comb filter.
/// Assumes a typical sample rate of 48000 Hz and a minimum frequency of 20 Hz.
static MAX_COMB_BUFFER_SIZE: Lazy<usize> = Lazy::new(|| {
    let sample_rate = 48000.0;
    ((sample_rate * (*MAX_OVERSAMPLING as f32)) / 20.0).ceil() as usize + 1
});

/// Coefficients for a 6th-order anti-aliasing filter (Butterworth lowpass)
struct AntiAliasingFilter {
    b: [f32; 3],
    a: [f32; 2],
    x1: [f32; 3],
    x2: [f32; 3],
    y1: [f32; 3],
    y2: [f32; 3],
}

impl AntiAliasingFilter {
    fn new(cutoff_normalized: f32) -> Self {
        // Design a 2nd-order Butterworth lowpass filter
        let c = 1.0 / (cutoff_normalized * std::f32::consts::PI).tan();
        let csq = c * c;
        let scale = 1.0 / (1.0 + std::f32::consts::SQRT_2 * c + csq);

        let b0 = scale;
        let b1 = 2.0 * scale;
        let b2 = scale;
        let a1 = 2.0 * (1.0 - csq) * scale;
        let a2 = (1.0 - std::f32::consts::SQRT_2 * c + csq) * scale;

        Self {
            b: [b0, b1, b2],
            a: [a1, a2],
            x1: [0.0; 3],
            x2: [0.0; 3],
            y1: [0.0; 3],
            y2: [0.0; 3],
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        // Cascaded 6th-order filter (three 2nd-order sections)
        let mut output = input;

        for i in 0..3 {
            let y = self.b[0] * output + self.b[1] * self.x1[i] + self.b[2] * self.x2[i]
                - self.a[0] * self.y1[i]
                - self.a[1] * self.y2[i];

            self.x2[i] = self.x1[i];
            self.x1[i] = output;
            self.y2[i] = self.y1[i];
            self.y1[i] = y;

            output = y;
        }

        output
    }

    fn reset(&mut self) {
        self.x1 = [0.0; 3];
        self.x2 = [0.0; 3];
        self.y1 = [0.0; 3];
        self.y2 = [0.0; 3];
    }
}

/// A unified filter collection that supports biquad‑based filters,
/// an inline Moog‑style ladder filter implementation, and a self‑resonating comb filter.
pub struct FilterCollection {
    // Common audio parameters.
    sample_rate: f32,
    base_cutoff: f32,
    base_resonance: f32, // normalized (0–1)
    base_gain_db: f32,
    // Smoothed parameters.
    cutoff: f32,
    resonance: f32,
    smoothing_factor: f32,
    enabled: bool,
    // The unified filter type.
    filter_type: FilterType,
    // Biquad‑specific fields.
    slope: FilterSlope,
    biquad: Biquad,
    cascaded: Option<CascadedBiquad>,
    // Ladder filter state stored inline.
    ladder_stages: [f32; 4],
    ladder_gain: f32,
    // Oversampling factor (1 = no oversampling, 2 = 2x, 4 = 4x, etc.)
    oversampling_factor: u32,
    // Keyboard tracking sensitivity (0 = no tracking, 1 = full tracking)
    keyboard_tracking_sensitivity: f32,
    // --- New fields for the self‑resonating comb filter ---
    comb_buffer: Vec<f32>,
    comb_buffer_index: usize,
    comb_last_output: f32,
    comb_dampening: f32,        // Dampening factor for high frequencies (0.0–1.0)
    comb_target_frequency: f32, // Dedicated pitch parameter for the comb filter
    // --- New fields for the DC blocker in the comb filter ---
    comb_dc_prev: f32,
    comb_dc_state: f32,
    // --- Anti-aliasing filters for oversampling ---
    aa_upsampling_filter: AntiAliasingFilter,
    aa_downsampling_filter: AntiAliasingFilter,
    // --- Hermite interpolation state for comb filter ---
    comb_prev_samples: [f32; 4],
}

impl FilterCollection {
    pub fn new(sample_rate: f32) -> Self {
        let base_cutoff = 20000.0;
        let base_resonance = 0.0;
        let base_gain_db = 4.8;
        let cutoff = base_cutoff;
        let resonance = base_resonance;
        // Default filter type is LowPass (a biquad‑style filter).
        let filter_type = FilterType::LowPass;
        // Default biquad slope is 12 dB/octave.
        let slope = FilterSlope::Db12;
        let initial_q = normalized_resonance_to_q(resonance);
        let biquad = Biquad::new(filter_type, sample_rate, cutoff, initial_q, base_gain_db);

        // Initialize anti-aliasing filters
        // Cutoff at 0.45 of Nyquist for the upsampling filter
        let aa_upsampling_filter = AntiAliasingFilter::new(0.45);
        // Cutoff at 0.4 of Nyquist for the downsampling filter
        let aa_downsampling_filter = AntiAliasingFilter::new(0.4);

        Self {
            sample_rate,
            base_cutoff,
            base_resonance,
            base_gain_db,
            cutoff,
            resonance,
            smoothing_factor: 0.1,
            enabled: true,
            filter_type,
            slope,
            biquad,
            cascaded: None,
            // Initialize ladder filter state.
            ladder_stages: [0.0; 4],
            ladder_gain: 10f32.powf(base_gain_db / 20.0),
            // Default oversampling factor is clamped to at least 1.
            oversampling_factor: 1,
            keyboard_tracking_sensitivity: 0.0,
            // --- Initialize comb filter state ---
            // Allocate a fixed-size comb buffer based on the precomputed maximum.
            comb_buffer: vec![0.0; *MAX_COMB_BUFFER_SIZE],
            comb_buffer_index: 0,
            comb_last_output: 0.0,
            comb_dampening: 0.5,
            comb_target_frequency: 220.0,
            // --- Initialize DC blocker state ---
            comb_dc_prev: 0.0,
            comb_dc_state: 0.0,
            // --- Initialize anti-aliasing filters ---
            aa_upsampling_filter,
            aa_downsampling_filter,
            // --- Initialize Hermite interpolation state ---
            comb_prev_samples: [0.0; 4],
        }
    }

    /// Set the oversampling factor (1 = no oversampling, 2 = 2x, 4 = 4x, etc.)
    /// Clamps the factor between 1 and our pre-allocated maximum.
    pub fn set_oversampling_factor(&mut self, factor: u32) {
        let new_factor = factor.clamp(1, *MAX_OVERSAMPLING);
        if new_factor != self.oversampling_factor {
            self.oversampling_factor = new_factor;
            // Reset anti-aliasing filters when changing oversampling factor
            self.aa_upsampling_filter.reset();
            self.aa_downsampling_filter.reset();
        }
    }

    /// Set the base cutoff (Hz) and resonance (normalized 0–1) for all filters.
    pub fn set_params(&mut self, cutoff: f32, resonance: f32) {
        self.base_cutoff = cutoff.clamp(20.0, 20000.0);
        self.base_resonance = resonance.clamp(0.0, 1.0);
    }

    /// Set the base gain in dB for both filter types.
    pub fn set_gain_db(&mut self, gain_db: f32) {
        self.base_gain_db = gain_db;
        // Compute the ladder gain from the dB value.
        self.ladder_gain = 10f32.powf(gain_db / 20.0);
        self.biquad.gain_db = gain_db;
        // Set cascaded gain to match biquad gain.
        if let Some(cascaded) = &mut self.cascaded {
            cascaded.first.gain_db = gain_db;
            cascaded.second.gain_db = gain_db;
        }
    }

    pub fn set_gain_normalized(&mut self, normalized: f32) {
        let norm = normalized.clamp(0.0, 1.0);
        // Map normalized [0,1] to a dB range of [-12, +12].
        let gain_db = norm * 24.0 - 12.0;
        self.set_gain_db(gain_db);
    }

    /// Set the keyboard tracking sensitivity (0 = no tracking, 1 = full tracking).
    pub fn set_keyboard_tracking_sensitivity(&mut self, sensitivity: f32) {
        self.keyboard_tracking_sensitivity = sensitivity.clamp(0.0, 1.0);
    }

    /// Set the filter type.
    ///
    /// For biquad‑style types (e.g. LowPass, HighPass, etc.) the biquad branch is used;
    /// for FilterType::Ladder and FilterType::Comb the inline branches are used.
    pub fn set_filter_type(&mut self, filter_type: FilterType) {
        self.filter_type = filter_type;
        if let FilterType::Ladder = filter_type {
            // Nothing extra is needed here for ladder.
        } else if let FilterType::Comb = filter_type {
            // No extra initialization is required for the comb filter.
        } else {
            // For biquad‑style filters, update the biquad.
            self.biquad.filter_type = filter_type;
            self.biquad.update_coefficients();
            if let FilterSlope::Db24 = self.slope {
                if self.cascaded.is_none() {
                    let overall_q = normalized_resonance_to_q(self.resonance);
                    let stage_q = overall_q.sqrt();
                    self.cascaded = Some(CascadedBiquad::new(
                        filter_type,
                        self.sample_rate,
                        self.cutoff,
                        stage_q,
                        self.base_gain_db,
                    ));
                }
            } else {
                self.cascaded = None;
            }
        }
    }

    /// Set the biquad filter slope (only relevant for biquad‑style filters).
    pub fn set_filter_slope(&mut self, slope: FilterSlope) {
        self.slope = slope;
        if let FilterType::Ladder = self.filter_type {
            // Ladder filter does not use slope.
        } else {
            self.biquad.filter_type = self.filter_type;
            self.biquad.update_coefficients();
            if let FilterSlope::Db24 = self.slope {
                if self.cascaded.is_none() {
                    let overall_q = normalized_resonance_to_q(self.resonance);
                    let stage_q = overall_q.sqrt();
                    self.cascaded = Some(CascadedBiquad::new(
                        self.filter_type,
                        self.sample_rate,
                        self.cutoff,
                        stage_q,
                        self.base_gain_db,
                    ));
                }
            } else {
                self.cascaded = None;
            }
        }
    }

    /// Set the target frequency (in Hz) for the comb filter.
    pub fn set_comb_target_frequency(&mut self, freq: f32) {
        self.comb_target_frequency = freq;
    }

    pub fn set_comb_dampening(&mut self, dampening: f32) {
        self.comb_dampening = dampening;
    }

    /// Cubic Hermite interpolation for better quality delay line interpolation
    fn hermite_interpolate(&self, frac: f32, xm1: f32, x0: f32, x1: f32, x2: f32) -> f32 {
        let c = (x1 - xm1) * 0.5;
        let v = x0 - x1;
        let w = c + v;
        let a = w + v + (x2 - x0) * 0.5;
        let b_neg = w + a;

        return ((((a * frac) - b_neg) * frac + c) * frac + x0);
    }

    /// Get sample from delay line with interpolation
    fn get_delay_sample(&self, delay_float: f32) -> f32 {
        let delay_int = delay_float.floor() as usize;
        let frac = delay_float - delay_int as f32;
        let buf_len = self.comb_buffer.len();

        // Get four samples for cubic interpolation
        let idx_m1 = (self.comb_buffer_index + buf_len - delay_int - 1) % buf_len;
        let idx_0 = (self.comb_buffer_index + buf_len - delay_int) % buf_len;
        let idx_1 = (idx_0 + 1) % buf_len;
        let idx_2 = (idx_0 + 2) % buf_len;

        let xm1 = self.comb_buffer[idx_m1];
        let x0 = self.comb_buffer[idx_0];
        let x1 = self.comb_buffer[idx_1];
        let x2 = self.comb_buffer[idx_2];

        // Apply Hermite interpolation
        self.hermite_interpolate(frac, xm1, x0, x1, x2)
    }

    /// Helper method for processing the self‑resonating comb filter.
    /// This version uses proper anti-aliasing and Hermite interpolation.
    fn process_comb_filter(
        &mut self,
        audio_in: &[f32],
        out_buffer: &mut [f32],
        i: usize,
        end: usize,
        avg_keyboard: f32,
        avg_global: f32,
    ) {
        let os_factor = self.oversampling_factor.max(1);
        let effective_sr = self.sample_rate * os_factor as f32;

        // Calculate frequency modulation
        let raw_global = if avg_global != 0.0 {
            avg_global / 440.0
        } else {
            1.0
        };
        let global_multiplier = (raw_global - 1.0) * self.keyboard_tracking_sensitivity + 1.0;

        let raw_keyboard = if avg_keyboard != 0.0 {
            avg_keyboard / 440.0
        } else {
            1.0
        };
        let keyboard_multiplier = (raw_keyboard - 1.0) * self.keyboard_tracking_sensitivity + 1.0;

        let tracking_multiplier = keyboard_multiplier * global_multiplier;
        let effective_frequency = self.comb_target_frequency * tracking_multiplier;

        // Calculate delay length (in samples) at the oversampled rate.
        let delay_float = effective_sr / effective_frequency;
        let delay_float = delay_float.max(2.0); // Ensure minimum delay of 2 samples

        // Calculate resonance and dampening parameters for oversampling
        let substep_resonance = self.resonance.powf(1.0 / (os_factor as f32));
        let substep_dampening = self.comb_dampening.powf(1.0 / (os_factor as f32));

        let buf_len = self.comb_buffer.len();

        // Process each sample with proper oversampling
        for j in i..end {
            let input_sample = audio_in[j];

            // Apply anti-aliasing filter before upsampling
            let filtered_input = self.aa_upsampling_filter.process(input_sample);

            // Process oversampled steps
            let mut last_output = 0.0;

            for _ in 0..os_factor {
                // Get delayed sample with Hermite interpolation
                let delayed_sample = self.get_delay_sample(delay_float);

                // Apply dampening filter
                self.comb_last_output = (1.0 - substep_dampening) * delayed_sample
                    + substep_dampening * self.comb_last_output;

                // Feedback with input sample
                let new_val = filtered_input + substep_resonance * self.comb_last_output;

                // Store in delay line
                self.comb_buffer[self.comb_buffer_index] = new_val;
                self.comb_buffer_index = (self.comb_buffer_index + 1) % buf_len;

                // Keep track of last output for downsampling
                last_output = delayed_sample;
            }

            // Apply anti-aliasing filter for downsampling
            let downsampled = self.aa_downsampling_filter.process(last_output);

            // Apply DC blocker to the output
            let filtered = downsampled - self.comb_dc_prev + 0.995 * self.comb_dc_state;
            self.comb_dc_prev = downsampled;
            self.comb_dc_state = filtered;

            out_buffer[j] = filtered;
        }
    }
}

impl ModulationProcessor for FilterCollection {}

impl AudioNode for FilterCollection {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::AudioInput0, false);
        ports.insert(PortId::AudioOutput0, true);
        ports.insert(PortId::CutoffMod, false);
        ports.insert(PortId::ResonanceMod, false);
        // Keyboard tracking input (for note‐based modulation).
        ports.insert(PortId::Frequency, false);
        // Global frequency input (for global tuning adjustments).
        ports.insert(PortId::GlobalFrequency, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        let audio_in = self.process_modulations(buffer_size, inputs.get(&PortId::AudioInput0), 0.0);
        let mod_cut = self.process_modulations_ex(buffer_size, inputs.get(&PortId::CutoffMod));
        let mod_res = self.process_modulations_ex(buffer_size, inputs.get(&PortId::ResonanceMod));
        // Process keyboard tracking modulation.
        let mod_keyboard = self.process_modulations_ex(buffer_size, inputs.get(&PortId::Frequency));
        // Process global frequency modulation.
        let mod_global =
            self.process_modulations_ex(buffer_size, inputs.get(&PortId::GlobalFrequency));

        if let Some(out_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
            for i in (0..buffer_size).step_by(4) {
                let end = (i + 4).min(buffer_size);
                // Compute average modulation for cutoff and resonance.
                let avg_cut_add: f32 =
                    mod_cut.additive[i..end].iter().sum::<f32>() / block_len(end, i);
                let avg_cut_mult: f32 =
                    mod_cut.multiplicative[i..end].iter().sum::<f32>() / block_len(end, i);
                // Retrieve average keyboard frequency modulation.
                let avg_keyboard: f32 =
                    mod_keyboard.additive[i..end].iter().sum::<f32>() / block_len(end, i);
                // Retrieve average global frequency modulation.
                let avg_global: f32 =
                    mod_global.additive[i..end].iter().sum::<f32>() / block_len(end, i);

                // Start from the base modulated cutoff.
                let mut target_cutoff = (self.base_cutoff + avg_cut_add) * avg_cut_mult;
                // Apply global frequency modulation.
                let global_factor = if avg_global > 0.0 {
                    avg_global / 440.0
                } else {
                    1.0
                };
                target_cutoff *= global_factor;
                // Only apply keyboard tracking if the filter type is Comb.
                if let FilterType::Comb = self.filter_type {
                    let keyboard_factor = if avg_keyboard > 0.0 {
                        (avg_keyboard / 440.0).powf(self.keyboard_tracking_sensitivity)
                    } else {
                        1.0
                    };
                    target_cutoff *= keyboard_factor;
                }
                let target_cutoff = target_cutoff.clamp(20.0, 20000.0);

                let avg_res_add: f32 =
                    mod_res.additive[i..end].iter().sum::<f32>() / block_len(end, i);
                let avg_res_mult: f32 =
                    mod_res.multiplicative[i..end].iter().sum::<f32>() / block_len(end, i);
                let target_resonance = (self.base_resonance + avg_res_add) * avg_res_mult;

                // Smooth the parameters.
                self.cutoff += self.smoothing_factor * (target_cutoff - self.cutoff);
                self.resonance += self.smoothing_factor * (target_resonance - self.resonance);
                self.cutoff = self.cutoff.clamp(20.0, 20000.0);
                self.resonance = self.resonance.clamp(0.0, 1.0);

                match self.filter_type {
                    FilterType::Ladder => {
                        // Ladder filter processing.
                        let f_norm = (self.cutoff / (self.sample_rate * 0.5)).clamp(0.0, 1.0);
                        let p = f_norm * (1.8 - 0.8 * f_norm);
                        let k = 8.0 * self.resonance * (1.0 - 0.5 * p);
                        for j in i..end {
                            let os_factor = self.oversampling_factor.max(1);

                            // Anti-aliasing filter before processing
                            let filtered_input = self.aa_upsampling_filter.process(audio_in[j]);
                            let inner_p = p / os_factor as f32;

                            let mut final_output = 0.0;

                            for _ in 0..os_factor {
                                let x = filtered_input - k * self.ladder_stages[3];
                                self.ladder_stages[0] +=
                                    inner_p * (fast_tanh(x) - self.ladder_stages[0]);
                                self.ladder_stages[1] += inner_p
                                    * (fast_tanh(self.ladder_stages[0]) - self.ladder_stages[1]);
                                self.ladder_stages[2] += inner_p
                                    * (fast_tanh(self.ladder_stages[1]) - self.ladder_stages[2]);
                                self.ladder_stages[3] += inner_p
                                    * (fast_tanh(self.ladder_stages[2]) - self.ladder_stages[3]);

                                final_output = self.ladder_stages[3];
                            }

                            // Anti-aliasing filter after processing
                            let filtered_output = self.aa_downsampling_filter.process(final_output);
                            out_buffer[j] = filtered_output * self.ladder_gain;
                        }
                    }
                    FilterType::Comb => {
                        // Improved self-resonating comb filter with proper anti-aliasing
                        self.process_comb_filter(
                            &audio_in,
                            out_buffer,
                            i,
                            end,
                            avg_keyboard,
                            avg_global,
                        );
                    }
                    // Biquad‑style filters.
                    _ => {
                        let overall_q = normalized_resonance_to_q(self.resonance);
                        let stage_q = overall_q.sqrt();
                        let os_factor = self.oversampling_factor.max(1);

                        // Setup biquad filters
                        self.biquad.frequency = self.cutoff;
                        self.biquad.Q = overall_q;
                        self.biquad.gain_db = self.base_gain_db;
                        self.biquad.filter_type = self.filter_type;
                        self.biquad.update_coefficients();

                        if let FilterSlope::Db24 = self.slope {
                            if let Some(ref mut cascaded) = self.cascaded {
                                cascaded.first.frequency = self.cutoff;
                                cascaded.first.Q = stage_q;
                                cascaded.first.gain_db = self.base_gain_db;
                                cascaded.first.filter_type = self.filter_type;
                                cascaded.first.update_coefficients();

                                cascaded.second.frequency = self.cutoff;
                                cascaded.second.Q = stage_q;
                                cascaded.second.gain_db = self.base_gain_db;
                                cascaded.second.filter_type = self.filter_type;
                                cascaded.second.update_coefficients();
                            }
                        }

                        if os_factor == 1 {
                            // No oversampling case - original code path
                            for j in i..end {
                                let x = audio_in[j];
                                let y = match self.slope {
                                    FilterSlope::Db12 => self.biquad.process(x),
                                    FilterSlope::Db24 => {
                                        if let Some(ref mut cascaded) = self.cascaded {
                                            cascaded.process(x)
                                        } else {
                                            self.biquad.process(x)
                                        }
                                    }
                                };
                                out_buffer[j] = y;
                            }
                        } else {
                            // With oversampling - use anti-aliasing filters
                            let effective_sr = self.sample_rate * os_factor as f32;

                            // Save original state to restore later
                            let orig_sr = self.sample_rate;
                            self.biquad.sample_rate = effective_sr;
                            self.biquad.update_coefficients();

                            if let FilterSlope::Db24 = self.slope {
                                if let Some(ref mut cascaded) = self.cascaded {
                                    cascaded.first.sample_rate = effective_sr;
                                    cascaded.first.update_coefficients();
                                    cascaded.second.sample_rate = effective_sr;
                                    cascaded.second.update_coefficients();
                                }
                            }

                            for j in i..end {
                                // Apply anti-aliasing filter before upsampling
                                let filtered_input = self.aa_upsampling_filter.process(audio_in[j]);

                                // Process through the filter at oversampled rate
                                // Only keep the final output after all oversampling steps
                                let mut final_output = 0.0;
                                for _ in 0..os_factor {
                                    final_output = match self.slope {
                                        FilterSlope::Db12 => self.biquad.process(filtered_input),
                                        FilterSlope::Db24 => {
                                            if let Some(ref mut cascaded) = self.cascaded {
                                                cascaded.process(filtered_input)
                                            } else {
                                                self.biquad.process(filtered_input)
                                            }
                                        }
                                    };
                                }

                                // Apply anti-aliasing filter for downsampling
                                let filtered_output =
                                    self.aa_downsampling_filter.process(final_output);
                                out_buffer[j] = filtered_output;
                            }

                            // Restore original sample rate
                            self.biquad.sample_rate = orig_sr;
                            self.biquad.update_coefficients();

                            if let FilterSlope::Db24 = self.slope {
                                if let Some(ref mut cascaded) = self.cascaded {
                                    cascaded.first.sample_rate = orig_sr;
                                    cascaded.first.update_coefficients();
                                    cascaded.second.sample_rate = orig_sr;
                                    cascaded.second.update_coefficients();
                                }
                            }
                        }
                    }
                }
            }
        }
    }

    fn reset(&mut self) {
        self.biquad.reset();
        if let Some(ref mut cascaded) = self.cascaded {
            cascaded.reset();
        }
        // Reset ladder filter state.
        self.ladder_stages = [0.0; 4];
        // Reset comb filter state.
        self.comb_buffer.fill(0.0);
        self.comb_buffer_index = 0;
        self.comb_last_output = 0.0;
        // Reset DC blocker state.
        self.comb_dc_prev = 0.0;
        self.comb_dc_state = 0.0;
        // Reset anti-aliasing filters
        self.aa_upsampling_filter.reset();
        self.aa_downsampling_filter.reset();
        // Reset Hermite interpolation state
        self.comb_prev_samples = [0.0; 4];
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
    }

    fn node_type(&self) -> &str {
        "filtercollection"
    }
}

/// Helper to calculate block length.
#[inline(always)]
fn block_len(end: usize, start: usize) -> f32 {
    (end - start) as f32
}
