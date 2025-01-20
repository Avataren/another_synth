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
}

impl AudioProcessor for Mixer {
    fn get_default_values(&self) -> HashMap<PortId, f32> {
        let mut defaults = HashMap::new();
        defaults.insert(PortId::GainMod, 1.0);
        defaults.insert(PortId::StereoPan, 0.0); // Center position
        defaults
    }

    fn process(&mut self, context: &mut ProcessContext) {
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

            // Convert -1 to 1 range to 0 to 1 range for the constant power calculation
            let normalized_pan = (pan + f32x4::splat(1.0)) * f32x4::splat(0.5);

            // Calculate pan angles using constant power law
            let pan_angle = normalized_pan * f32x4::splat(PI / 2.0);
            let left_gain = pan_angle.cos();
            let right_gain = pan_angle.sin();

            // Get mono input
            let input_mono = inputs
                .get(&PortId::AudioInput0)
                .map_or(f32x4::splat(0.0), |input| input.get_simd(offset));

            // Apply gain and panning
            let output_l = input_mono * gain_mod * left_gain;
            let output_r = input_mono * gain_mod * right_gain;

            // Write outputs
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
