use std::any::Any;
use std::collections::HashMap;
use std::simd::f32x4;

use wasm_bindgen::prelude::wasm_bindgen;

use crate::biquad::biquad::Filter;
use crate::biquad::{Biquad, CascadedBiquad, FilterType};

use crate::graph::{ModulationProcessor, ModulationSource};
use crate::traits::{AudioNode, PortId};

/// Enum for selecting the filter slope.
#[derive(Clone, Copy)]
#[wasm_bindgen]
pub enum FilterSlope {
    Db12,
    Db24,
}

/// Helper: map a normalized resonance (0–1) to a Q factor.
/// For a Butterworth response, resonance = 0 gives Q ≃ 0.707,
/// and increasing resonance raises Q.
fn normalized_resonance_to_q(normalized: f32) -> f32 {
    0.707 + 9.293 * normalized
}

/// A biquad‑based filter node that reuses your biquad implementation.
/// This node supports multiple filter types (LowPass, HighPass, etc.)
/// and allows switching between a single‑stage (12 dB/octave) and a
/// cascaded (24 dB/octave) filter response.
pub struct BiquadFilter {
    // Audio processing parameters.
    sample_rate: f32,
    filter_type: FilterType,
    base_cutoff: f32,
    base_resonance: f32, // normalized (0–1)
    base_gain_db: f32,
    // Smoothed parameters.
    cutoff: f32,
    resonance: f32,
    smoothing_factor: f32,
    enabled: bool,
    // Filter slope: 12 dB (single stage) or 24 dB (cascaded).
    slope: FilterSlope,
    // Single‑stage biquad (12 dB/octave).
    biquad: Biquad,
    // Optional cascaded biquad for 24 dB/octave.
    cascaded: Option<CascadedBiquad>,
}

impl BiquadFilter {
    pub fn new(sample_rate: f32) -> Self {
        let base_cutoff = 20000.0;
        let base_resonance = 0.0;
        let base_gain_db = 0.0;
        let cutoff = base_cutoff;
        let resonance = base_resonance;
        let filter_type = FilterType::LowPass; // default type
        let initial_q = normalized_resonance_to_q(resonance);
        let biquad = Biquad::new(filter_type, sample_rate, cutoff, initial_q, base_gain_db);
        Self {
            sample_rate,
            filter_type,
            base_cutoff,
            base_resonance,
            base_gain_db,
            cutoff,
            resonance,
            smoothing_factor: 0.1,
            enabled: true,
            slope: FilterSlope::Db12,
            biquad,
            cascaded: None,
        }
    }

    /// Set the base cutoff (Hz) and resonance (normalized 0–1).
    pub fn set_params(&mut self, cutoff: f32, resonance: f32) {
        self.base_cutoff = cutoff.clamp(0.0, 20000.0);
        self.base_resonance = resonance.clamp(0.0, 1.0);
    }

    /// Set the filter type (LowPass, HighPass, Notch, etc.).
    pub fn set_filter_type(&mut self, filter_type: FilterType) {
        self.filter_type = filter_type;
        self.biquad.filter_type = filter_type;
        self.biquad.update_coefficients();
        if let Some(ref mut cascaded) = self.cascaded {
            cascaded.first.filter_type = filter_type;
            cascaded.second.filter_type = filter_type;
            cascaded.first.update_coefficients();
            cascaded.second.update_coefficients();
        }
    }

    /// Set the base gain in dB (used for shelf/peaking filters).
    pub fn set_gain_db(&mut self, gain_db: f32) {
        self.base_gain_db = gain_db;
    }

    /// Set the filter slope: 12 dB (single‑stage) or 24 dB (cascaded).
    pub fn set_filter_slope(&mut self, slope: FilterSlope) {
        self.slope = slope;
        match self.slope {
            FilterSlope::Db12 => {
                // Clear cascaded stage if switching back to 12 dB.
                self.cascaded = None;
            }
            FilterSlope::Db24 => {
                if self.cascaded.is_none() {
                    // Compute overall Q and derive a per‑stage Q.
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
            }
        }
    }
}

/// Reuse your existing modulation processing implementation.
impl ModulationProcessor for BiquadFilter {}

impl AudioNode for BiquadFilter {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        // Example port IDs; adjust according to your framework.
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
        // Process audio input as before (assumed to be additive).
        // (For audio input, the neutral value is 0.0 so that the signals add up.)
        let audio_in = self.process_modulations(buffer_size, inputs.get(&PortId::AudioInput0), 0.0);

        // For parameters like cutoff and resonance, use the extended modulation processor
        // which returns separate additive and multiplicative components.
        let mod_cut = self.process_modulations_ex(buffer_size, inputs.get(&PortId::CutoffMod));
        let mod_res = self.process_modulations_ex(buffer_size, inputs.get(&PortId::ResonanceMod));

        if let Some(out_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
            let audio_in_slice = &audio_in[..];

            // Process samples in blocks of 4 using SIMD.
            for i in (0..buffer_size).step_by(4) {
                let end = (i + 4).min(buffer_size);
                let block_len = end - i;

                // Load the audio input chunk.
                let input_chunk = f32x4::from_array({
                    let mut arr = [0.0; 4];
                    arr[..block_len].copy_from_slice(&audio_in_slice[i..end]);
                    arr
                });

                // Compute the average additive and multiplicative contributions for cutoff.
                let avg_cut_add: f32 =
                    mod_cut.additive[i..end].iter().sum::<f32>() / block_len as f32;
                let avg_cut_mult: f32 =
                    mod_cut.multiplicative[i..end].iter().sum::<f32>() / block_len as f32;
                // The final cutoff target: base plus additive, then scaled.
                let target_cutoff = (self.base_cutoff + avg_cut_add) * avg_cut_mult;

                // Do the same for resonance.
                let avg_res_add: f32 =
                    mod_res.additive[i..end].iter().sum::<f32>() / block_len as f32;
                let avg_res_mult: f32 =
                    mod_res.multiplicative[i..end].iter().sum::<f32>() / block_len as f32;
                let target_resonance = (self.base_resonance + avg_res_add) * avg_res_mult;

                // Smooth the parameters.
                self.cutoff += self.smoothing_factor * (target_cutoff - self.cutoff);
                self.resonance += self.smoothing_factor * (target_resonance - self.resonance);
                self.cutoff = self.cutoff.clamp(20.0, 20000.0);
                self.resonance = self.resonance.clamp(0.0, 1.0);

                // Compute Q values for the biquad(s).
                let overall_q = normalized_resonance_to_q(self.resonance);
                let stage_q = overall_q.sqrt();

                // Update the single‑stage (12 dB/octave) coefficients.
                self.biquad.frequency = self.cutoff;
                self.biquad.Q = overall_q;
                self.biquad.gain_db = self.base_gain_db;
                self.biquad.filter_type = self.filter_type;
                self.biquad.update_coefficients();

                // Update cascaded coefficients if in 24 dB/octave mode.
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

                // Process each sample in the block with the updated coefficients.
                let input_arr = input_chunk.to_array();
                for j in 0..block_len {
                    let x = input_arr[j];
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
                    out_buffer[i + j] = y;
                }
            }
        }
    }

    fn reset(&mut self) {
        self.biquad.reset();
        if let Some(ref mut cascaded) = self.cascaded {
            cascaded.reset();
        }
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
        "biquadfilter"
    }
}
