use std::any::Any;
use std::collections::HashMap;
use std::simd::f32x4;

use crate::biquad::biquad::Filter;
use crate::biquad::{Biquad, CascadedBiquad, FilterType};

use crate::graph::{ModulationProcessor, ModulationSource};
use crate::traits::{AudioNode, PortId};

/// Enum for selecting the filter slope.
#[derive(Clone, Copy)]
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
/// and allows switching between a single-stage (12 dB/octave) and a
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
    // Single-stage biquad (12 dB/octave).
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
            slope: FilterSlope::Db24, // default to 12 dB/octave
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

    /// Set the filter slope: 12 dB (single-stage) or 24 dB (cascaded).
    pub fn set_filter_slope(&mut self, slope: FilterSlope) {
        self.slope = slope;
        match self.slope {
            FilterSlope::Db12 => {
                // Clear cascaded stage if switching back to 12 dB.
                self.cascaded = None;
            }
            FilterSlope::Db24 => {
                if self.cascaded.is_none() {
                    self.cascaded = Some(CascadedBiquad::new(
                        self.filter_type,
                        self.sample_rate,
                        self.cutoff,
                        normalized_resonance_to_q(self.resonance),
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
        // Process modulation inputs:
        // - Audio input: additive (default 0.0)
        // - Cutoff modulation: multiplies base cutoff (default 1.0)
        // - Resonance modulation: adds to base resonance (default 0.0)
        let audio_in = self.process_modulations(buffer_size, inputs.get(&PortId::AudioInput0), 0.0);
        let cutoff_mod = self.process_modulations(buffer_size, inputs.get(&PortId::CutoffMod), 1.0);
        let resonance_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::ResonanceMod), 0.0);

        if let Some(out_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
            let audio_in_slice = &audio_in[..];
            let cutoff_slice = &cutoff_mod[..];
            let resonance_slice = &resonance_mod[..];

            // Process in blocks of 4 samples using SIMD to unpack modulation arrays.
            for i in (0..buffer_size).step_by(4) {
                let end = (i + 4).min(buffer_size);
                let block_len = end - i;

                let input_chunk = f32x4::from_array({
                    let mut arr = [0.0; 4];
                    arr[..block_len].copy_from_slice(&audio_in_slice[i..end]);
                    arr
                });
                let cutoff_chunk = f32x4::from_array({
                    let mut arr = [1.0; 4];
                    arr[..block_len].copy_from_slice(&cutoff_slice[i..end]);
                    arr
                });
                let resonance_chunk = f32x4::from_array({
                    let mut arr = [0.0; 4];
                    arr[..block_len].copy_from_slice(&resonance_slice[i..end]);
                    arr
                });

                let input_arr = input_chunk.to_array();
                let cutoff_arr = cutoff_chunk.to_array();
                let resonance_arr = resonance_chunk.to_array();
                let mut output_chunk = [0.0f32; 4];

                for j in 0..block_len {
                    // Compute target cutoff and resonance per sample.
                    let target_cutoff = self.base_cutoff * cutoff_arr[j];
                    let target_resonance = self.base_resonance + resonance_arr[j];

                    // Smooth the parameters.
                    self.cutoff += self.smoothing_factor * (target_cutoff - self.cutoff);
                    self.resonance += self.smoothing_factor * (target_resonance - self.resonance);
                    self.cutoff = self.cutoff.clamp(0.0, 20000.0);
                    self.resonance = self.resonance.clamp(0.0, 1.0);

                    let q = normalized_resonance_to_q(self.resonance);

                    // Update single-stage biquad parameters.
                    self.biquad.frequency = self.cutoff;
                    self.biquad.Q = q;
                    self.biquad.gain_db = self.base_gain_db;
                    self.biquad.filter_type = self.filter_type;
                    self.biquad.update_coefficients();

                    let x = input_arr[j];
                    // Process using the selected slope.
                    let y = match self.slope {
                        FilterSlope::Db12 => self.biquad.process(x),
                        FilterSlope::Db24 => {
                            if let Some(ref mut cascaded) = self.cascaded {
                                // Update both stages' parameters.
                                cascaded.first.frequency = self.cutoff;
                                cascaded.first.Q = q;
                                cascaded.first.gain_db = self.base_gain_db;
                                cascaded.first.filter_type = self.filter_type;
                                cascaded.first.update_coefficients();

                                cascaded.second.frequency = self.cutoff;
                                cascaded.second.Q = q;
                                cascaded.second.gain_db = self.base_gain_db;
                                cascaded.second.filter_type = self.filter_type;
                                cascaded.second.update_coefficients();

                                cascaded.process(x)
                            } else {
                                // Fallback to single-stage.
                                self.biquad.process(x)
                            }
                        }
                    };
                    output_chunk[j] = y;
                }
                out_buffer[i..end].copy_from_slice(&output_chunk[..block_len]);
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
