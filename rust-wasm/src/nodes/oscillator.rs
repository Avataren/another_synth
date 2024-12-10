use crate::audio::{AudioInput, AudioOutput};
use crate::traits::{AudioNode, PortId};
use std::any::Any;
use std::collections::HashMap;
use std::f32::consts::PI;
use std::simd::{f32x4, Simd, StdFloat};

pub struct ModulatableOscillator {
    phase: f32,
    frequency: f32,
    phase_mod_amount: f32,
    freq_mod_amount: f32,
    gain_mod_amount: f32, // Add this
    sample_rate: f32,
}

impl ModulatableOscillator {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            phase: 0.0,
            frequency: 440.0,
            phase_mod_amount: 1.0,
            freq_mod_amount: 1.0,
            gain_mod_amount: 1.0,
            sample_rate,
        }
    }
}

impl AudioNode for ModulatableOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::Frequency, false); // Input, not required
        ports.insert(PortId::FrequencyMod, false); // Optional input
        ports.insert(PortId::PhaseMod, false); // Optional input
        ports.insert(PortId::GainMod, false); // Optional input
        ports.insert(PortId::AudioOutput0, true); // Required output
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, &[f32]>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Create views into our inputs with appropriate default values
        let freq_input = AudioInput::new(inputs.get(&PortId::Frequency).copied(), self.frequency);
        let freq_mod = AudioInput::new(inputs.get(&PortId::FrequencyMod).copied(), 0.0);
        let phase_mod = AudioInput::new(inputs.get(&PortId::PhaseMod).copied(), 0.0);
        let gain_mod = AudioInput::new(inputs.get(&PortId::GainMod).copied(), 1.0);

        let output_buffer = outputs.get_mut(&PortId::AudioOutput0).unwrap();
        let mut output = AudioOutput::new(output_buffer);

        let chunk_size = 4;
        let chunks = buffer_size / chunk_size;

        for chunk in 0..chunks {
            let offset = chunk * chunk_size;

            // Process frequency modulation
            let freq = freq_input.get_simd(offset);
            let fm = freq_mod.get_simd(offset);
            let modulated_freq =
                freq * (f32x4::splat(1.0) + fm * f32x4::splat(self.freq_mod_amount));

            // Calculate phase including modulation
            let pm = phase_mod.get_simd(offset);
            let phase_inc =
                f32x4::splat(2.0 * PI) * modulated_freq / f32x4::splat(self.sample_rate);

            let mut phases = [0.0f32; 4];
            for i in 0..4 {
                self.phase += pm.to_array()[i] * self.phase_mod_amount;
                phases[i] = self.phase;
                self.phase += phase_inc.to_array()[i];
                if self.phase >= 2.0 * PI {
                    self.phase -= 2.0 * PI;
                }
            }

            // Generate output
            let phase_simd = f32x4::from_array(phases);
            let sin_output = phase_simd.sin();
            let gain = gain_mod.get_simd(offset);
            let final_output = sin_output * gain;

            output.write_simd(offset, final_output);
        }

        // Handle remaining samples
        let start = chunks * chunk_size;
        for i in start..buffer_size {
            let freq = freq_input.get(i);
            let fm = freq_mod.get(i);
            let modulated_freq = freq * (1.0 + fm * self.freq_mod_amount);

            let pm = phase_mod.get(i);
            self.phase += pm * self.phase_mod_amount;

            let value = self.phase.sin() * gain_mod.get(i);
            output.buffer[i] = value;

            self.phase += 2.0 * PI * modulated_freq / self.sample_rate;
            if self.phase >= 2.0 * PI {
                self.phase -= 2.0 * PI;
            }
        }
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn reset(&mut self) {
        self.phase = 0.0;
    }
}
