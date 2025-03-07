use std::any::Any;
use std::collections::HashMap;

use wasm_bindgen::prelude::wasm_bindgen;

use crate::graph::{ModulationProcessor, ModulationSource};
use crate::traits::{AudioNode, PortId};

/// A 24 dB/octave Moog‑style ladder filter node with an added gain parameter.
/// This filter is implemented as four cascaded one‑pole stages with a tanh nonlinearity
/// and includes a gain control to adjust the output level.
pub struct LadderFilter {
    sample_rate: f32,
    base_cutoff: f32,    // Hz
    base_resonance: f32, // normalized (0–1)
    base_gain_db: f32,   // Gain in dB
    gain: f32,           // Amplitude multiplier derived from base_gain_db
    // Smoothed parameters.
    cutoff: f32,
    resonance: f32,
    smoothing_factor: f32,
    enabled: bool,
    // Four filter stages (state variables).
    stages: [f32; 4],
}

impl LadderFilter {
    /// Create a new LadderFilter with the given sample rate.
    pub fn new(sample_rate: f32) -> Self {
        let base_cutoff = 20000.0;
        let base_resonance = 0.0;
        let base_gain_db = 0.0;
        let gain = 10f32.powf(base_gain_db / 20.0);
        Self {
            sample_rate,
            base_cutoff,
            base_resonance,
            base_gain_db,
            gain,
            cutoff: base_cutoff,
            resonance: base_resonance,
            smoothing_factor: 0.1,
            enabled: true,
            stages: [0.0; 4],
        }
    }

    /// Set the base cutoff (Hz) and resonance (normalized 0–1).
    pub fn set_params(&mut self, cutoff: f32, resonance: f32) {
        self.base_cutoff = cutoff.clamp(20.0, 20000.0);
        self.base_resonance = resonance.clamp(0.0, 1.0);
    }

    /// Set the base gain in dB.
    pub fn set_gain_db(&mut self, gain_db: f32) {
        self.base_gain_db = gain_db;
        self.gain = 10f32.powf(gain_db / 20.0);
    }

    /// Set the gain using a normalized value between 0.0 and 1.0.
    /// This maps 0.0 to -12 dB and 1.0 to +12 dB. Adjust the mapping as needed.
    pub fn set_gain_normalized(&mut self, normalized: f32) {
        let norm = normalized.clamp(0.0, 1.0);
        // Map normalized [0,1] to a dB range of [-12, +12]
        let gain_db = norm * 24.0 - 12.0;
        self.set_gain_db(gain_db);
    }

    /// Reset the filter state.
    pub fn reset_state(&mut self) {
        self.stages = [0.0; 4];
    }
}

impl ModulationProcessor for LadderFilter {}

impl AudioNode for LadderFilter {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        // Define the port IDs: one for audio input, one for audio output,
        // and two for modulation (cutoff and resonance).
        ports.insert(PortId::AudioInput0, false);
        ports.insert(PortId::AudioOutput0, true);
        ports.insert(PortId::CutoffMod, false);
        ports.insert(PortId::ResonanceMod, false);
        // Optionally, if we decide to modulate gain
        // ports.insert(PortId::Gain, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Process the audio input. (The neutral value for audio is 0.0 so that signals add.)
        let audio_in = self.process_modulations(buffer_size, inputs.get(&PortId::AudioInput0), 0.0);

        // Process modulation for cutoff and resonance.
        let mod_cut = self.process_modulations_ex(buffer_size, inputs.get(&PortId::CutoffMod));
        let mod_res = self.process_modulations_ex(buffer_size, inputs.get(&PortId::ResonanceMod));

        // If you decide to modulate gain too, you could process it here:
        // let mod_gain = self.process_modulations_ex(buffer_size, inputs.get(&PortId::Gain));

        if let Some(out_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
            // Process samples in blocks (here, blocks of 4 samples as in your biquad).
            for i in (0..buffer_size).step_by(4) {
                let end = (i + 4).min(buffer_size);
                let block_len = end - i;

                // Average the additive and multiplicative contributions for cutoff.
                let avg_cut_add: f32 =
                    mod_cut.additive[i..end].iter().sum::<f32>() / block_len as f32;
                let avg_cut_mult: f32 =
                    mod_cut.multiplicative[i..end].iter().sum::<f32>() / block_len as f32;
                let target_cutoff = (self.base_cutoff + avg_cut_add) * avg_cut_mult;

                // Average the contributions for resonance.
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

                // Compute the filter coefficient.
                // Here we scale the cutoff by an empirical factor (1.16) relative to the sample rate.
                let f = (self.cutoff * 1.16 / self.sample_rate).min(1.0);
                // Calculate the feedback amount from resonance.
                let feedback = self.resonance * (1.0 - 0.15 * f * f);

                // Process each sample in the block.
                for j in 0..block_len {
                    // Apply feedback from the output of the fourth stage.
                    let x = audio_in[i + j] - feedback * self.stages[3];

                    // Cascade four one-pole filters with a tanh nonlinearity.
                    self.stages[0] += f * ((x).tanh() - (self.stages[0]).tanh());
                    self.stages[1] += f * ((self.stages[0]).tanh() - (self.stages[1]).tanh());
                    self.stages[2] += f * ((self.stages[1]).tanh() - (self.stages[2]).tanh());
                    self.stages[3] += f * ((self.stages[2]).tanh() - (self.stages[3]).tanh());

                    // Apply the gain parameter to the output.
                    out_buffer[i + j] = self.stages[3] * self.gain;
                }
            }
        }
    }

    fn reset(&mut self) {
        self.reset_state();
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
        "ladderfilter"
    }
}
