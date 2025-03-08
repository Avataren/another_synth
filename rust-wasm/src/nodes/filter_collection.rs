use once_cell::sync::Lazy;
use std::any::Any;
use std::collections::HashMap;
use std::simd::f32x4;
use wasm_bindgen::prelude::wasm_bindgen;

// Import the biquad types (including FilterType) without redefining them.
use crate::biquad::{Biquad, CascadedBiquad, Filter, FilterType};
use crate::graph::{ModulationProcessor, ModulationSource};
use crate::traits::{AudioNode, PortId};

/// Biquad‑specific slope selection.
#[derive(Clone, Copy)]
#[wasm_bindgen]
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

/// A unified filter collection that supports both biquad‑based filters and an inline
/// Moog‑style ladder filter implementation.
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
    // New: oversampling factor (1 = no oversampling, 2 = 2x, 4 = 4x, etc.)
    oversampling_factor: u32,
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
            oversampling_factor: 1, // default: no oversampling
        }
    }

    /// Set the oversampling factor (1 = no oversampling, 2 = 2x, 4 = 4x, etc.)
    pub fn set_oversampling_factor(&mut self, factor: u32) {
        self.oversampling_factor = factor.max(1);
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
        //set cascaded gain to match biquad gain
        if let Some(cascaded) = &mut self.cascaded {
            cascaded.first.gain_db = gain_db;
            cascaded.second.gain_db = gain_db;
        }
    }

    pub fn set_gain_normalized(&mut self, normalized: f32) {
        let norm = normalized.clamp(0.0, 1.0);
        // Map normalized [0,1] to a dB range of [-12, +12]
        let gain_db = norm * 24.0 - 12.0;
        self.set_gain_db(gain_db);
    }

    /// Set the filter type.
    ///
    /// For biquad‑style types (e.g. LowPass, HighPass, etc.) the biquad branch is used;
    /// for FilterType::Ladder the inline ladder branch is used.
    pub fn set_filter_type(&mut self, filter_type: FilterType) {
        self.filter_type = filter_type;
        if let FilterType::Ladder = filter_type {
            // Nothing extra is needed here for ladder.
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

    /// Optionally set the biquad filter slope (only relevant for biquad‑style filters).
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
}

impl ModulationProcessor for FilterCollection {}

impl AudioNode for FilterCollection {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::AudioInput0, false);
        ports.insert(PortId::AudioOutput0, true);
        ports.insert(PortId::CutoffMod, false);
        ports.insert(PortId::ResonanceMod, false);
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

        if let Some(out_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
            for i in (0..buffer_size).step_by(4) {
                let end = (i + 4).min(buffer_size);
                // Compute average modulation for cutoff and resonance.
                let avg_cut_add: f32 =
                    mod_cut.additive[i..end].iter().sum::<f32>() / block_len(end, i);
                let avg_cut_mult: f32 =
                    mod_cut.multiplicative[i..end].iter().sum::<f32>() / block_len(end, i);
                let target_cutoff = (self.base_cutoff + avg_cut_add) * avg_cut_mult;

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
                        // Map cutoff relative to Nyquist so that a high cutoff is nearly transparent.
                        let f_norm = (self.cutoff / (self.sample_rate * 0.5)).clamp(0.0, 1.0);
                        let p = f_norm * (1.8 - 0.8 * f_norm);
                        // Boost the feedback factor to help trigger self-oscillation.
                        let k = 8.0 * self.resonance * (1.0 - 0.5 * p);
                        // For each sample in the current block:
                        for j in i..end {
                            // With oversampling, use substeps for integration.
                            let os_factor = self.oversampling_factor.max(1);
                            let inner_p = p / os_factor as f32;
                            // Process oversampled substeps.
                            for _ in 0..os_factor {
                                let x = audio_in[j] - k * self.ladder_stages[3];
                                self.ladder_stages[0] +=
                                    inner_p * (fast_tanh(x) - self.ladder_stages[0]);
                                self.ladder_stages[1] += inner_p
                                    * (fast_tanh(self.ladder_stages[0]) - self.ladder_stages[1]);
                                self.ladder_stages[2] += inner_p
                                    * (fast_tanh(self.ladder_stages[1]) - self.ladder_stages[2]);
                                self.ladder_stages[3] += inner_p
                                    * (fast_tanh(self.ladder_stages[2]) - self.ladder_stages[3]);
                            }
                            out_buffer[j] = self.ladder_stages[3] * self.ladder_gain;
                        }
                    }
                    // Biquad‑style filters.
                    _ => {
                        let overall_q = normalized_resonance_to_q(self.resonance);
                        let stage_q = overall_q.sqrt();
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
        // Reset the ladder filter state.
        self.ladder_stages = [0.0; 4];
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
