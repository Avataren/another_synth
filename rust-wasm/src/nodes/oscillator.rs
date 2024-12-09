// src/nodes/oscillator.rs
use crate::traits::{AudioNode, Oscillator};
use std::f32::consts::PI;
use std::simd::f32x4;

pub struct SimpleOscillator {
    phase: f32,
    frequency: f32,
    sample_rate: f32,
}

impl SimpleOscillator {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            phase: 0.0,
            frequency: 440.0,
            sample_rate,
        }
    }
}

impl Oscillator for SimpleOscillator {
    fn set_frequency(&mut self, freq: f32) {
        self.frequency = freq;
    }
}

impl AudioNode for SimpleOscillator {
    fn process_buffer(
        &mut self,
        _inputs: &[&[f32]],
        outputs: &mut [&mut [f32]],
        buffer_size: usize,
    ) {
        let output = &mut outputs[0];
        let chunk_size = 4;
        let chunks = buffer_size / chunk_size;

        for chunk in 0..chunks {
            let mut phases = [0.0f32; 4];
            for i in 0..chunk_size {
                phases[i] = self.phase;
                self.phase += 2.0 * PI * self.frequency / self.sample_rate;
                if self.phase > 2.0 * PI {
                    self.phase -= 2.0 * PI;
                }
            }

            // Convert to SIMD, process, and convert back
            let phase_simd = f32x4::from_array(phases);
            let values = phase_simd.to_array();
            let mut samples = [0.0f32; 4];
            for i in 0..4 {
                samples[i] = values[i].sin();
            }
            let samples_simd = f32x4::from_array(samples);

            samples_simd.copy_to_slice(&mut output[chunk * chunk_size..(chunk + 1) * chunk_size]);
        }

        // Handle remaining samples
        for i in (chunks * chunk_size)..buffer_size {
            output[i] = self.phase.sin();
            self.phase += 2.0 * PI * self.frequency / self.sample_rate;
            if self.phase > 2.0 * PI {
                self.phase -= 2.0 * PI;
            }
        }
    }

    fn reset(&mut self) {
        self.phase = 0.0;
    }
}
