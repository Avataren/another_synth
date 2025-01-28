use crate::processing::{AudioProcessor, ProcessContext};
use crate::traits::{AudioNode, PortId};
use std::any::Any;
use std::collections::HashMap;
use std::f32::consts::PI;

pub struct Mixer {
    enabled: bool,
}

impl Mixer {
    pub fn new() -> Self {
        Self { enabled: true }
    }
}

impl AudioNode for Mixer {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        // inputs
        ports.insert(PortId::AudioInput0, false); // Left input
                                                  // Stereo outputs
        ports.insert(PortId::AudioOutput0, true); // Left output
        ports.insert(PortId::AudioOutput1, true); // Right output
                                                  // Gain modulation
        ports.insert(PortId::GainMod, false);
        ports.insert(PortId::StereoPan, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, &[f32]>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        let default_values = self.get_default_values();
        let mut context = ProcessContext::new(inputs, outputs, buffer_size, &default_values);
        AudioProcessor::process(self, &mut context);
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

impl AudioProcessor for Mixer {
    fn get_default_values(&self) -> HashMap<PortId, f32> {
        let mut defaults = HashMap::new();
        defaults.insert(PortId::GainMod, 1.0);
        defaults.insert(PortId::StereoPan, 0.0); // Center position
        defaults
    }

    fn process(&mut self, context: &mut ProcessContext) {
        use std::simd::num::SimdFloat;
        use std::simd::{f32x4, StdFloat};

        context.process_by_chunks(4, |offset, inputs, outputs| {
            // Get gain modulation
            let gain_mod = inputs
                .get(&PortId::GainMod)
                .map_or(f32x4::splat(1.0), |input| input.get_simd(offset));

            // Get pan position (-1.0 = full left, 0.0 = center, 1.0 = full right)
            let pan = inputs
                .get(&PortId::StereoPan)
                .map_or(f32x4::splat(0.0), |input| input.get_simd(offset));

            // Clamp pan values to -1.0...1.0 range using simd_min and simd_max
            let pan = pan.simd_max(f32x4::splat(-1.0)).simd_min(f32x4::splat(1.0));

            // Convert pan position from -1...1 to 0...1 range
            let normalized_pan = (pan + f32x4::splat(1.0)) * f32x4::splat(0.5);

            // Calculate constant power gains using square root method
            // This ensures that left_gain² + right_gain² = 1 for all pan positions
            let right_gain = normalized_pan.sqrt();
            let left_gain = (f32x4::splat(1.0) - normalized_pan).sqrt();

            // Get mono input
            let input_mono = inputs
                .get(&PortId::AudioInput0)
                .map_or(f32x4::splat(0.0), |input| input.get_simd(offset));

            // Apply gain modulation and panning
            let output_l = input_mono * gain_mod * left_gain;
            let output_r = input_mono * gain_mod * right_gain;

            // Write to output buffers
            if let Some(out_l) = outputs.get_mut(&PortId::AudioOutput0) {
                out_l.write_simd(offset, output_l);
            }
            if let Some(out_r) = outputs.get_mut(&PortId::AudioOutput1) {
                out_r.write_simd(offset, output_r);
            }
        });
    }

    fn reset(&mut self) {}
}
