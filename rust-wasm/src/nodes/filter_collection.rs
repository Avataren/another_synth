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
#[derive(Clone, Copy)]
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
        // Design a 2nd-order Butterworth lowpass filter.
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
#[derive(Clone)]
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
    // --- Fields for the self‑resonating comb filter ---
    comb_buffer: Vec<f32>,
    comb_buffer_index: usize,
    comb_last_output: f32,
    comb_dampening: f32,        // Dampening factor (0.0–1.0)
    comb_target_frequency: f32, // Comb filter pitch (Hz)
    // --- DC blocker for the comb filter ---
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
        let filter_type = FilterType::LowPass;
        let slope = FilterSlope::Db12;
        let initial_q = normalized_resonance_to_q(resonance);
        let biquad = Biquad::new(filter_type, sample_rate, cutoff, initial_q, base_gain_db);

        // Initialize anti-aliasing filters.
        let aa_upsampling_filter = AntiAliasingFilter::new(0.45);
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
            ladder_stages: [0.0; 4],
            ladder_gain: 10f32.powf(base_gain_db / 20.0),
            oversampling_factor: 1,
            keyboard_tracking_sensitivity: 0.0,
            comb_buffer: vec![0.0; *MAX_COMB_BUFFER_SIZE],
            comb_buffer_index: 0,
            comb_last_output: 0.0,
            comb_dampening: 0.5,
            comb_target_frequency: 220.0,
            comb_dc_prev: 0.0,
            comb_dc_state: 0.0,
            aa_upsampling_filter,
            aa_downsampling_filter,
            comb_prev_samples: [0.0; 4],
        }
    }

    /// Set the oversampling factor (1 = no oversampling, 2 = 2x, etc.),
    /// clamping it between 1 and the maximum.
    pub fn set_oversampling_factor(&mut self, factor: u32) {
        let new_factor = factor.clamp(1, *MAX_OVERSAMPLING);
        if new_factor != self.oversampling_factor {
            self.oversampling_factor = new_factor;
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
        self.ladder_gain = 10f32.powf(gain_db / 20.0);
        self.biquad.gain_db = gain_db;
        if let Some(cascaded) = &mut self.cascaded {
            cascaded.first.gain_db = gain_db;
            cascaded.second.gain_db = gain_db;
        }
    }

    pub fn set_gain_normalized(&mut self, normalized: f32) {
        let norm = normalized.clamp(0.0, 2.0);
        let gain_db = norm * 24.0 - 12.0;
        self.set_gain_db(gain_db);
    }

    /// Set the keyboard tracking sensitivity (0 = none, 1 = full).
    pub fn set_keyboard_tracking_sensitivity(&mut self, sensitivity: f32) {
        self.keyboard_tracking_sensitivity = sensitivity.clamp(0.0, 1.0);
    }

    /// Set the filter type. For biquad‑style filters, the biquad branch is used;
    /// for Ladder and Comb, the inline branches are used.
    pub fn set_filter_type(&mut self, filter_type: FilterType) {
        self.filter_type = filter_type;
        if let FilterType::Ladder = filter_type {
            // Nothing extra for ladder.
        } else if let FilterType::Comb = filter_type {
            // Nothing extra for comb.
        } else {
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

    /// Set the biquad filter slope (only used for biquad‑style filters).
    pub fn set_filter_slope(&mut self, slope: FilterSlope) {
        self.slope = slope;
        if let FilterType::Ladder = self.filter_type {
            // Ladder filter ignores slope.
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

    /// Set the target frequency (Hz) for the comb filter.
    pub fn set_comb_target_frequency(&mut self, freq: f32) {
        self.comb_target_frequency = freq;
    }

    /// Set the comb filter's dampening factor.
    pub fn set_comb_dampening(&mut self, dampening: f32) {
        self.comb_dampening = dampening;
    }

    /// Cubic Hermite interpolation for better quality delay line interpolation.
    fn hermite_interpolate(&self, frac: f32, xm1: f32, x0: f32, x1: f32, x2: f32) -> f32 {
        let c = (x1 - xm1) * 0.5;
        let v = x0 - x1;
        let w = c + v;
        let a = w + v + (x2 - x0) * 0.5;
        let b_neg = w + a;
        (((a * frac) - b_neg) * frac + c) * frac + x0
    }

    /// Get a delayed sample using Hermite interpolation.
    fn get_delay_sample(&self, delay_float: f32) -> f32 {
        let delay_int = delay_float.floor() as usize;
        let frac = delay_float - delay_int as f32;
        let buf_len = self.comb_buffer.len();

        let idx_m1 = (self.comb_buffer_index + buf_len - delay_int - 1) % buf_len;
        let idx_0 = (self.comb_buffer_index + buf_len - delay_int) % buf_len;
        let idx_1 = (idx_0 + 1) % buf_len;
        let idx_2 = (idx_0 + 2) % buf_len;

        let xm1 = self.comb_buffer[idx_m1];
        let x0 = self.comb_buffer[idx_0];
        let x1 = self.comb_buffer[idx_1];
        let x2 = self.comb_buffer[idx_2];

        self.hermite_interpolate(frac, xm1, x0, x1, x2)
    }

    /// Helper method for processing the self‑resonating comb filter.
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

        // Calculate frequency modulation.
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
        let delay_float = (effective_sr / effective_frequency).max(2.0);

        // Calculate resonance and dampening parameters for oversampling.
        let substep_resonance = self.resonance.powf(1.0 / (os_factor as f32));
        let substep_dampening = self.comb_dampening.powf(1.0 / (os_factor as f32));

        let buf_len = self.comb_buffer.len();

        for j in i..end {
            let input_sample = audio_in[j];
            let filtered_input = self.aa_upsampling_filter.process(input_sample);
            let mut last_output = 0.0;

            for _ in 0..os_factor {
                let delayed_sample = self.get_delay_sample(delay_float);
                self.comb_last_output = (1.0 - substep_dampening) * delayed_sample
                    + substep_dampening * self.comb_last_output;
                let new_val = filtered_input + substep_resonance * self.comb_last_output;
                self.comb_buffer[self.comb_buffer_index] = new_val;
                self.comb_buffer_index = (self.comb_buffer_index + 1) % buf_len;
                last_output = delayed_sample;
            }

            let downsampled = self.aa_downsampling_filter.process(last_output);
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
        ports.insert(PortId::Frequency, false); // Keyboard tracking.
        ports.insert(PortId::GlobalFrequency, false); // Global tuning.
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
        let mod_keyboard = self.process_modulations_ex(buffer_size, inputs.get(&PortId::Frequency));
        let mod_global =
            self.process_modulations_ex(buffer_size, inputs.get(&PortId::GlobalFrequency));

        if let Some(out_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
            for i in (0..buffer_size).step_by(4) {
                let end = (i + 4).min(buffer_size);
                let avg_cut_add: f32 =
                    mod_cut.additive[i..end].iter().sum::<f32>() / (end - i) as f32;
                let avg_cut_mult: f32 =
                    mod_cut.multiplicative[i..end].iter().sum::<f32>() / (end - i) as f32;
                let avg_keyboard: f32 =
                    mod_keyboard.additive[i..end].iter().sum::<f32>() / (end - i) as f32;
                let avg_global: f32 =
                    mod_global.additive[i..end].iter().sum::<f32>() / (end - i) as f32;

                let mut target_cutoff = (self.base_cutoff + avg_cut_add) * avg_cut_mult;
                let global_factor = if avg_global > 0.0 {
                    avg_global / 440.0
                } else {
                    1.0
                };
                target_cutoff *= global_factor;
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
                    mod_res.additive[i..end].iter().sum::<f32>() / (end - i) as f32;
                let avg_res_mult: f32 =
                    mod_res.multiplicative[i..end].iter().sum::<f32>() / (end - i) as f32;
                let target_resonance = (self.base_resonance + avg_res_add) * avg_res_mult;

                self.cutoff += self.smoothing_factor * (target_cutoff - self.cutoff);
                self.resonance += self.smoothing_factor * (target_resonance - self.resonance);
                self.cutoff = self.cutoff.clamp(20.0, 20000.0);
                self.resonance = self.resonance.clamp(0.0, 1.0);

                match self.filter_type {
                    FilterType::Ladder => {
                        let f_norm = (self.cutoff / (self.sample_rate * 0.5)).clamp(0.0, 1.0);
                        let p = f_norm * (1.8 - 0.8 * f_norm);
                        let k = 8.0 * self.resonance * (1.0 - 0.5 * p);
                        for j in i..end {
                            let os_factor = self.oversampling_factor.max(1);
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
                            let filtered_output = self.aa_downsampling_filter.process(final_output);
                            out_buffer[j] = filtered_output * self.ladder_gain;
                        }
                    }
                    FilterType::Comb => {
                        self.process_comb_filter(
                            &audio_in,
                            out_buffer,
                            i,
                            end,
                            avg_keyboard,
                            avg_global,
                        );
                    }
                    _ => {
                        let os_factor = self.oversampling_factor.max(1);
                        self.biquad.frequency = self.cutoff;
                        self.biquad.q = normalized_resonance_to_q(self.resonance);
                        self.biquad.gain_db = self.base_gain_db;
                        self.biquad.filter_type = self.filter_type;
                        self.biquad.update_coefficients();
                        if let FilterSlope::Db24 = self.slope {
                            if let Some(ref mut cascaded) = self.cascaded {
                                cascaded.first.frequency = self.cutoff;
                                cascaded.first.q = normalized_resonance_to_q(self.resonance).sqrt();
                                cascaded.first.gain_db = self.base_gain_db;
                                cascaded.first.filter_type = self.filter_type;
                                cascaded.first.update_coefficients();
                                cascaded.second.frequency = self.cutoff;
                                cascaded.second.q =
                                    normalized_resonance_to_q(self.resonance).sqrt();
                                cascaded.second.gain_db = self.base_gain_db;
                                cascaded.second.filter_type = self.filter_type;
                                cascaded.second.update_coefficients();
                            }
                        }

                        if os_factor == 1 {
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
                            let effective_sr = self.sample_rate * os_factor as f32;
                            let orig_sr = self.biquad.sample_rate;
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
                                let filtered_input = self.aa_upsampling_filter.process(audio_in[j]);
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
                                let filtered_output =
                                    self.aa_downsampling_filter.process(final_output);
                                out_buffer[j] = filtered_output;
                            }
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
        self.ladder_stages = [0.0; 4];
        self.comb_buffer.fill(0.0);
        self.comb_buffer_index = 0;
        self.comb_last_output = 0.0;
        self.comb_dc_prev = 0.0;
        self.comb_dc_state = 0.0;
        self.aa_upsampling_filter.reset();
        self.aa_downsampling_filter.reset();
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

impl FilterCollection {
    /// Process a single sample through the filter using the current settings.
    fn process_sample(&mut self, input: f32) -> f32 {
        match self.filter_type {
            FilterType::Ladder => {
                let os_factor = self.oversampling_factor.max(1);
                let filtered_input = self.aa_upsampling_filter.process(input);
                let f_norm = (self.cutoff / (self.sample_rate * 0.5)).clamp(0.0, 1.0);
                let p = f_norm * (1.8 - 0.8 * f_norm);
                let k = 8.0 * self.resonance * (1.0 - 0.5 * p);
                let inner_p = p / os_factor as f32;
                let mut final_output = 0.0;
                for _ in 0..os_factor {
                    let x = filtered_input - k * self.ladder_stages[3];
                    self.ladder_stages[0] += inner_p * (fast_tanh(x) - self.ladder_stages[0]);
                    self.ladder_stages[1] +=
                        inner_p * (fast_tanh(self.ladder_stages[0]) - self.ladder_stages[1]);
                    self.ladder_stages[2] +=
                        inner_p * (fast_tanh(self.ladder_stages[1]) - self.ladder_stages[2]);
                    self.ladder_stages[3] +=
                        inner_p * (fast_tanh(self.ladder_stages[2]) - self.ladder_stages[3]);
                    final_output = self.ladder_stages[3];
                }
                let filtered_output = self.aa_downsampling_filter.process(final_output);
                filtered_output * self.ladder_gain
            }
            FilterType::Comb => {
                let os_factor = self.oversampling_factor.max(1);
                let filtered_input = self.aa_upsampling_filter.process(input);
                let effective_sr = self.sample_rate * os_factor as f32;
                let delay = (effective_sr / self.comb_target_frequency).max(2.0);
                let mut last_output = 0.0;
                for _ in 0..os_factor {
                    let delayed_sample = self.get_delay_sample(delay);
                    self.comb_last_output = (1.0 - self.comb_dampening) * delayed_sample
                        + self.comb_dampening * self.comb_last_output;
                    let new_val = filtered_input
                        + self.resonance.powf(1.0 / (os_factor as f32)) * self.comb_last_output;
                    let buf_len = self.comb_buffer.len();
                    self.comb_buffer[self.comb_buffer_index] = new_val;
                    self.comb_buffer_index = (self.comb_buffer_index + 1) % buf_len;
                    last_output = delayed_sample;
                }
                let downsampled = self.aa_downsampling_filter.process(last_output);
                let filtered = downsampled - self.comb_dc_prev + 0.995 * self.comb_dc_state;
                self.comb_dc_prev = downsampled;
                self.comb_dc_state = filtered;
                filtered
            }
            _ => {
                let os_factor = self.oversampling_factor.max(1);
                self.biquad.frequency = self.cutoff;
                self.biquad.q = normalized_resonance_to_q(self.resonance);
                self.biquad.gain_db = self.base_gain_db;
                self.biquad.filter_type = self.filter_type;
                self.biquad.update_coefficients();

                if os_factor == 1 {
                    match self.slope {
                        FilterSlope::Db12 => self.biquad.process(input),
                        FilterSlope::Db24 => {
                            if let Some(ref mut cascaded) = self.cascaded {
                                cascaded.process(input)
                            } else {
                                self.biquad.process(input)
                            }
                        }
                    }
                } else {
                    let orig_sr = self.biquad.sample_rate;
                    self.biquad.sample_rate = self.sample_rate * os_factor as f32;
                    self.biquad.update_coefficients();
                    let filtered_input = self.aa_upsampling_filter.process(input);
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
                    let filtered_output = self.aa_downsampling_filter.process(final_output);
                    self.biquad.sample_rate = orig_sr;
                    self.biquad.update_coefficients();
                    filtered_output
                }
            }
        }
    }

    pub fn generate_frequency_response(&self, requested_length: usize) -> Vec<f32> {
        // Generate impulse response
        let impulse_length = 2048;
        let impulse = self.create_impulse_response(impulse_length);

        // Calculate FFT magnitude (in dB), truncated to 0..Nyquist.
        let fft_magnitude_db = self.calculate_fft_magnitude(impulse);

        // Nyquist frequency is sample_rate / 2.
        let nyquist_hz = self.sample_rate * 0.5;
        // Clamp to 20 kHz or Nyquist, whichever is smaller.
        let max_freq = 20_000.0_f32.min(nyquist_hz);
        let min_freq = 20.0;

        // Determine FFT bin indices corresponding to min_freq and max_freq.
        // (Note: FFT bins are linearly spaced, but we want a log–spaced frequency axis.)
        let bin_min = min_freq * (impulse_length as f32) / self.sample_rate;
        // Ensure we never go out-of-bounds by subtracting a small amount.
        let bin_max = (max_freq * (impulse_length as f32) / self.sample_rate)
            .min(fft_magnitude_db.len() as f32 - 1.0);

        let points = requested_length; //.min(512);
        let mut response_db = Vec::with_capacity(points);

        // Logarithmically sample from bin_min to bin_max.
        // This guarantees that the frequencies used are strictly between min_freq and max_freq.
        for i in 0..points {
            let t = i as f32 / (points - 1) as f32;
            // Compute the bin index on a logarithmic scale.
            let bin = bin_min * (bin_max / bin_min).powf(t);
            let bin_floor = bin.floor() as usize;
            let bin_ceil = (bin_floor + 1).min(fft_magnitude_db.len() - 1);
            let frac = bin - bin_floor as f32;
            let db_val =
                fft_magnitude_db[bin_floor] * (1.0 - frac) + fft_magnitude_db[bin_ceil] * frac;
            response_db.push(db_val);
        }

        // Normalize the dB values to a 0–1 range for UI.
        self.normalize_for_display_range(response_db, -40.0, 40.0)
    }

    // Example of a specialized normalization that uses a given dB range.
    fn normalize_for_display_range(
        &self,
        mut data: Vec<f32>,
        db_floor: f32,
        db_ceiling: f32,
    ) -> Vec<f32> {
        for value in &mut data {
            let clamped_db = value.clamp(db_floor, db_ceiling);
            let ratio = (clamped_db - db_floor) / (db_ceiling - db_floor);
            // Typically, 0 dB is near the top, so we might NOT invert it:
            *value = ratio;
        }
        data
    }

    // Create impulse response with a completely new filter
    fn create_impulse_response(&self, length: usize) -> Vec<f32> {
        // Create an entirely new filter with the same settings
        let mut new_filter = FilterCollection::new(self.sample_rate);

        // Copy only necessary parameters, avoid any shared references
        new_filter.base_cutoff = self.base_cutoff;
        new_filter.base_resonance = self.base_resonance;
        new_filter.base_gain_db = self.base_gain_db;
        new_filter.cutoff = self.base_cutoff;
        new_filter.resonance = self.base_resonance;
        new_filter.filter_type = self.filter_type;
        new_filter.slope = self.slope;
        new_filter.oversampling_factor = self.oversampling_factor;
        new_filter.ladder_gain = 10f32.powf(self.base_gain_db / 20.0);
        new_filter.comb_target_frequency = self.comb_target_frequency;
        new_filter.comb_dampening = self.comb_dampening;

        // Explicitly initialize filter settings
        new_filter.set_filter_type(self.filter_type);
        new_filter.set_filter_slope(self.slope);

        // Generate impulse response
        let mut response = Vec::with_capacity(length);
        for i in 0..length {
            let input = if i == 0 { 1.0 } else { 0.0 };
            response.push(new_filter.process_sample(input));
        }

        response
    }

    // Separate function to calculate FFT magnitudes from impulse response
    fn calculate_fft_magnitude(&self, impulse_response: Vec<f32>) -> Vec<f32> {
        let fft_length = impulse_response.len();

        // Create the standard FFT planner.
        let mut planner = rustfft::FftPlanner::<f32>::new();
        let fft = planner.plan_fft_forward(fft_length);

        // Convert impulse response to complex numbers.
        let mut buffer: Vec<rustfft::num_complex::Complex<f32>> = impulse_response
            .into_iter()
            .map(|x| rustfft::num_complex::Complex { re: x, im: 0.0 })
            .collect();

        // Process the FFT.
        fft.process(&mut buffer);

        // Calculate magnitude in dB for all bins.
        let epsilon = 1e-10;
        let mut result: Vec<f32> = buffer
            .into_iter()
            .map(|c| 20.0 * ((c.norm() + epsilon).log10()))
            .collect();

        // Truncate to the first half (0..Nyquist). For a 2048 sample FFT, that's indices [0..1024].
        let half_len = fft_length / 2;
        result.truncate(half_len);

        result
    }
}
