use std::any::Any;
// src/nodes/oscillator.rs
use std::collections::HashMap;
use crate::traits::{AudioNode, PortId};
use std::f32::consts::PI;
use std::simd::f32x4;

pub struct ModulatableOscillator {
  phase: f32,
  frequency: f32,
  phase_mod_amount: f32,
  freq_mod_amount: f32,
  gain_mod_amount: f32,  // Add this
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
      ports.insert(PortId::Frequency, false);     // Input, not required
      ports.insert(PortId::FrequencyMod, false);  // Optional input
      ports.insert(PortId::PhaseMod, false);      // Optional input
      ports.insert(PortId::GainMod, false);       // Optional input
      ports.insert(PortId::AudioOutput0, true);   // Required output
      ports
  }

  fn process(&mut self, inputs: &HashMap<PortId, &[f32]>, outputs: &mut HashMap<PortId, &mut [f32]>, buffer_size: usize) {
    let output = outputs.get_mut(&PortId::AudioOutput0).unwrap();
    let default_freq = [self.frequency];
    let default_zero = [0.0];
    let default_one = [1.0];

    let freq_input = inputs.get(&PortId::Frequency).copied().unwrap_or(&default_freq);
    let freq_mod = inputs.get(&PortId::FrequencyMod).copied().unwrap_or(&default_zero);
    let phase_mod = inputs.get(&PortId::PhaseMod).copied().unwrap_or(&default_zero);
    let gain_mod = inputs.get(&PortId::GainMod).copied().unwrap_or(&default_one);

    let chunk_size = 4;
    let chunks = buffer_size / chunk_size;

    for chunk in 0..chunks {
        let mut phases = [0.0f32; 4];
        for i in 0..chunk_size {
            let idx = chunk * chunk_size + i;
            let freq_idx = freq_input.get(idx).copied().unwrap_or(freq_input[0]);
            let fm_idx = freq_mod.get(idx).copied().unwrap_or(freq_mod[0]);
            let pm_idx = phase_mod.get(idx).copied().unwrap_or(phase_mod[0]);

            let modulated_freq = freq_idx * (1.0 + fm_idx * self.freq_mod_amount);
            self.phase += pm_idx * self.phase_mod_amount;
            phases[i] = self.phase;

            self.phase += 2.0 * PI * modulated_freq / self.sample_rate;
            if self.phase >= 2.0 * PI {
                self.phase -= 2.0 * PI;
            }
        }

        let phase_simd = f32x4::from_array(phases);
        let values = phase_simd.to_array();
        let mut samples = [0.0f32; 4];
        for i in 0..4 {
            let idx = chunk * chunk_size + i;
            let gain = gain_mod.get(idx).copied().unwrap_or(gain_mod[0]);
            samples[i] = values[i].sin() * gain;
        }
        let samples_simd = f32x4::from_array(samples);
        samples_simd.copy_to_slice(&mut output[chunk * chunk_size..(chunk + 1) * chunk_size]);
    }

    // Handle remaining samples
    for i in (chunks * chunk_size)..buffer_size {
        let freq = freq_input.get(i).copied().unwrap_or(freq_input[0]);
        let fm = freq_mod.get(i).copied().unwrap_or(freq_mod[0]);
        let pm = phase_mod.get(i).copied().unwrap_or(phase_mod[0]);
        let gain = gain_mod.get(i).copied().unwrap_or(gain_mod[0]);

        let modulated_freq = freq * (1.0 + fm * self.freq_mod_amount);
        self.phase += pm * self.phase_mod_amount;
        output[i] = self.phase.sin() * gain;

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
