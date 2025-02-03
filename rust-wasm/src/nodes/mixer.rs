use std::any::Any;
use std::collections::HashMap;
use std::simd::num::SimdFloat;
use std::simd::{f32x4, StdFloat};

use crate::graph::{ModulationProcessor, ModulationSource, ModulationType};
use crate::traits::{AudioNode, PortId};

pub struct Mixer {
    enabled: bool,
}

impl Mixer {
    pub fn new() -> Self {
        Self { enabled: true }
    }
}

impl ModulationProcessor for Mixer {
    fn get_modulation_type(&self, port: PortId) -> ModulationType {
        match port {
            PortId::AudioInput0 => ModulationType::Additive,
            PortId::FrequencyMod => ModulationType::Bipolar,
            PortId::PhaseMod => ModulationType::Additive,
            PortId::ModIndex => ModulationType::VCA,
            PortId::GainMod => ModulationType::VCA,
            PortId::StereoPan => ModulationType::Additive,
            _ => ModulationType::VCA,
        }
    }
}

impl AudioNode for Mixer {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::AudioInput0, false); // Left input
        ports.insert(PortId::AudioOutput0, true); // Left output
        ports.insert(PortId::AudioOutput1, true); // Right output
        ports.insert(PortId::GainMod, false); // For envelope control
        ports.insert(PortId::StereoPan, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Process modulations using the trait
        let gain_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::GainMod),
            1.0,
            PortId::GainMod,
        );

        // Process pan modulation using standard ModulationProcessor
        let pan_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::StereoPan),
            0.0,
            PortId::StereoPan,
        );

        let audio_in = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::AudioInput0),
            0.0,
            PortId::AudioInput0,
        );

        // Process in chunks
        for i in (0..buffer_size).step_by(4) {
            let end = (i + 4).min(buffer_size);

            // Load input chunks
            let input_chunk = {
                let mut chunk = [0.0; 4];
                chunk[0..end - i].copy_from_slice(&audio_in[i..end]);
                f32x4::from_array(chunk)
            };

            let gain_chunk = {
                let mut chunk = [1.0; 4];
                chunk[0..end - i].copy_from_slice(&gain_mod[i..end]);
                f32x4::from_array(chunk)
            };

            let pan_chunk = {
                let mut chunk = [0.0; 4];
                chunk[0..end - i].copy_from_slice(&pan_mod[i..end]);
                // Clamp pan values after all modulations are combined
                for v in &mut chunk {
                    *v = v.clamp(-1.0, 1.0);
                }
                f32x4::from_array(chunk)
            };

            // Convert pan from -1...1 to 0...1 range for constant power law
            let normalized_pan = (pan_chunk + f32x4::splat(1.0)) * f32x4::splat(0.5);

            // Calculate stereo gains using constant power law
            let right_gain = normalized_pan.sqrt();
            let left_gain = (f32x4::splat(1.0) - normalized_pan).sqrt();

            // Apply gain modulation and panning
            let output_l = input_chunk * gain_chunk * left_gain;
            let output_r = input_chunk * gain_chunk * right_gain;

            // Write outputs
            if let Some(out_l) = outputs.get_mut(&PortId::AudioOutput0) {
                out_l[i..end].copy_from_slice(&output_l.to_array()[0..end - i]);
            }
            if let Some(out_r) = outputs.get_mut(&PortId::AudioOutput1) {
                out_r[i..end].copy_from_slice(&output_r.to_array()[0..end - i]);
            }
        }
    }

    fn reset(&mut self) {}

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
        "mixer"
    }
}
