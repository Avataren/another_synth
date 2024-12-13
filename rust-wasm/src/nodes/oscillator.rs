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
        ports.insert(PortId::FrequencyMod, true);
        ports.insert(PortId::PhaseMod, true);
        ports.insert(PortId::GainMod, true);
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
        defaults.insert(PortId::ModIndex, 0.0);
        defaults.insert(PortId::GainMod, 1.0);
        defaults
    }

    fn process(&mut self, context: &mut ProcessContext) {
        use std::simd::{f32x4, StdFloat};

        context.process_by_chunks(4, |offset, inputs, outputs| {
            // Get base frequency and apply frequency modulation
            let base_freq = if let Some(input) = inputs.get(&PortId::Frequency) {
                input.get_simd(offset)
            } else {
                f32x4::splat(self.frequency)
            };

            let freq_mod = inputs
                .get(&PortId::FrequencyMod)
                .map_or(f32x4::splat(0.0), |input| input.get_simd(offset));

            let modulated_freq =
                base_freq * (f32x4::splat(1.0) + freq_mod * f32x4::splat(self.freq_mod_amount));

            // Calculate phase increment for each sample
            let phase_inc = f32x4::splat(2.0 * std::f32::consts::PI) * modulated_freq
                / f32x4::splat(self.sample_rate);

            // Get phase modulation and mod index
            let pm = inputs
                .get(&PortId::PhaseMod)
                .map_or(f32x4::splat(0.0), |input| input.get_simd(offset));

            // Get mod index and log its state
            let base_mod_index = self.get_default_values()[&PortId::ModIndex];
            let mod_index = if let Some(input) = inputs.get(&PortId::ModIndex) {
                let value = input.get_simd(offset);
                // console::log_1(
                //     &format!(
                //         "Mod index at offset {}: base={}, input={:?}",
                //         offset,
                //         base_mod_index,
                //         value.to_array()
                //     )
                //     .into(),
                // );
                f32x4::splat(base_mod_index) + value
            } else {
                // console::log_1(
                //     &format!(
                //         "Using default mod index {} at offset {}",
                //         base_mod_index, offset
                //     )
                //     .into(),
                // );
                f32x4::splat(base_mod_index)
            };

            // Calculate modulated phase mod with logging
            let modulated_pm = {
                let result = pm * mod_index * f32x4::splat(self.phase_mod_amount);
                if offset % 64 == 0 {
                    // Reduce log frequency
                    // console::log_1(
                    //     &format!(
                    //         "Phase mod calc: pm={:?}, mod_index={:?}, amount={}, result={:?}",
                    //         pm.to_array(),
                    //         mod_index.to_array(),
                    //         self.phase_mod_amount,
                    //         result.to_array()
                    //     )
                    //     .into(),
                    // );
                }
                result
            };

            // Calculate phases for the 4-sample chunk
            let mut phases = [0.0f32; 4];
            let two_pi = 2.0 * std::f32::consts::PI;

            for i in 0..4 {
                // Add phase modulation to current phase
                self.phase += modulated_pm.to_array()[i];

                // Store the current phase
                phases[i] = self.phase;

                // Increment phase for next sample
                self.phase += phase_inc.to_array()[i];

                // Wrap phase between 0 and 2π
                while self.phase >= two_pi {
                    self.phase -= two_pi;
                }
                while self.phase < 0.0 {
                    self.phase += two_pi;
                }
            }

            // Convert phases to SIMD vector and generate sine output
            let phase_simd = f32x4::from_array(phases);
            let sine_output = phase_simd.sin();

            // Apply gain modulation
            let gain = inputs
                .get(&PortId::GainMod)
                .map_or(f32x4::splat(1.0), |input| input.get_simd(offset));

            let final_output = sine_output * gain;

            // Write output
            if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
                output.write_simd(offset, final_output);
            }
        });
    }

    fn reset(&mut self) {
        self.phase = 0.0;
    }
}
