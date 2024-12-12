use crate::processing::{AudioProcessor, ProcessContext};
use crate::traits::{AudioNode, PortId};
use std::any::Any;
use std::collections::HashMap;
use wasm_bindgen::JsValue;
use web_sys::console;

pub struct ModulatableOscillator {
    phase: f32,
    frequency: f32,
    phase_mod_amount: f32,
    freq_mod_amount: f32,
    sample_rate: f32,
}

impl ModulatableOscillator {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            phase: 0.0,
            frequency: 440.0,
            phase_mod_amount: 1.0,
            freq_mod_amount: 1.0,
            sample_rate,
        }
    }
}

impl AudioNode for ModulatableOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::Frequency, false);
        ports.insert(PortId::FrequencyMod, false);
        ports.insert(PortId::PhaseMod, false); // Phase modulation input
        ports.insert(PortId::ModIndex, false); // Modulation index control
        ports.insert(PortId::GainMod, false);
        ports.insert(PortId::AudioOutput0, true);
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

    fn reset(&mut self) {
        AudioProcessor::reset(self);
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
}

impl AudioProcessor for ModulatableOscillator {
    fn get_default_values(&self) -> HashMap<PortId, f32> {
        let mut defaults = HashMap::new();
        defaults.insert(PortId::Frequency, self.frequency);
        defaults.insert(PortId::FrequencyMod, 0.0);
        defaults.insert(PortId::PhaseMod, 0.0);
        defaults.insert(PortId::ModIndex, 1.0);
        defaults.insert(PortId::GainMod, 1.0);
        defaults
    }

    fn process(&mut self, context: &mut ProcessContext) {
        use std::simd::{f32x4, StdFloat};

        context.process_by_chunks(4, |offset, inputs, outputs| {
            // Get base frequency
            let freq = if let Some(input) = inputs.get(&PortId::Frequency) {
                input.get_simd(offset)
            } else {
                f32x4::splat(self.frequency)
            };

            // Get modulation inputs
            let fm = inputs
                .get(&PortId::FrequencyMod)
                .map_or(f32x4::splat(0.0), |input| input.get_simd(offset));

            let pm = inputs
                .get(&PortId::PhaseMod)
                .map_or(f32x4::splat(0.0), |input| input.get_simd(offset));

            let mod_index = inputs
                .get(&PortId::ModIndex)
                .map_or(f32x4::splat(1.0), |input| input.get_simd(offset));

            let gain = inputs
                .get(&PortId::GainMod)
                .map_or(f32x4::splat(1.0), |input| input.get_simd(offset));

            // Calculate frequency with modulation
            let modulated_freq =
                freq * (f32x4::splat(1.0) + fm * f32x4::splat(self.freq_mod_amount));

            // Calculate phase increment
            let phase_inc = f32x4::splat(2.0 * std::f32::consts::PI) * modulated_freq
                / f32x4::splat(self.sample_rate);

            // Apply phase modulation with modulation index
            let modulated_pm = pm * mod_index * f32x4::splat(self.phase_mod_amount);

            let mut phases = [0.0f32; 4];
            let two_pi = 2.0 * std::f32::consts::PI;

            for i in 0..4 {
                // Add phase modulation
                self.phase += modulated_pm.to_array()[i];
                phases[i] = self.phase;
                // Increment phase
                self.phase += phase_inc.to_array()[i];
                // Wrap phase
                if self.phase >= two_pi {
                    self.phase -= two_pi;
                }
            }

            // Generate output
            let phase_simd = f32x4::from_array(phases);
            let final_output = phase_simd.sin() * gain;

            if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
                output.write_simd(offset, final_output);
            }
        });
    }

    fn reset(&mut self) {
        self.phase = 0.0;
    }
}
