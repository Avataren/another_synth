#![feature(portable_simd)]

mod nodes;
mod traits;
mod utils;

pub use nodes::*;
pub use traits::*;
pub use utils::*;

use std::f32::consts::PI;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct AudioProcessor {
    phase: f32,
    sample_rate: f32,
    gate_buffer: [f32; 128],
    freq_buffer: [f32; 128],
    envelope: Envelope,
}

#[wasm_bindgen]
impl AudioProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let sample_rate = 44100.0;
        let envelope_config = EnvelopeConfig::default();

        Self {
            phase: 0.0,
            sample_rate,
            gate_buffer: [0.0; 128],
            freq_buffer: [0.0; 128],
            envelope: Envelope::new(sample_rate, envelope_config),
        }
    }

    #[wasm_bindgen]
    pub fn init(&mut self, sample_rate: f32) {
        self.phase = 0.0;
        self.sample_rate = sample_rate;
        let envelope_config = EnvelopeConfig::default();
        self.envelope = Envelope::new(sample_rate, envelope_config);
    }

    #[wasm_bindgen]
    pub fn update_envelope(&mut self, attack: f32, decay: f32, sustain: f32, release: f32) {
        let config = EnvelopeConfig {
            attack,
            decay,
            sustain,
            release,
            attack_curve: 0.0,
            decay_curve: 0.0,
            release_curve: 0.0,
        };
        self.envelope.update_config(config);
    }

    #[wasm_bindgen]
    pub fn process_audio(
        &mut self,
        _input_left: &[f32],
        _input_right: &[f32],
        gate_param: &[f32],
        frequency_param: &[f32],
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        let buffer_size = output_left.len();

        // Safety check for buffer sizes
        if buffer_size == 0
            || output_right.len() != buffer_size
            || (gate_param.len() != 1 && gate_param.len() != buffer_size)
            || (frequency_param.len() != 1 && frequency_param.len() != buffer_size)
        {
            return;
        }

        // Update k-rate buffers
        if frequency_param.len() == 1 {
            self.freq_buffer[..buffer_size].fill(frequency_param[0]);
        }

        // Create temporary buffer for envelope
        let mut envelope_buffer = vec![0.0; buffer_size];

        // Process envelope
        {
            let envelope_input = &[if gate_param.len() == 1 {
                self.gate_buffer[..buffer_size].fill(gate_param[0]);
                &self.gate_buffer[..buffer_size]
            } else {
                gate_param
            }];

            let envelope_output = &mut [&mut envelope_buffer[..]];
            self.envelope
                .process_buffer(envelope_input, envelope_output, buffer_size);
        }

        // Main processing loop with envelope
        for i in 0..buffer_size {
            let freq = if frequency_param.len() == 1 {
                self.freq_buffer[i]
            } else {
                frequency_param[i]
            };

            let increment = 2.0 * PI * freq / self.sample_rate;
            let sample = self.phase.sin();

            // Apply envelope to oscillator output
            output_left[i] = sample * envelope_buffer[i];
            output_right[i] = sample * envelope_buffer[i];

            self.phase += increment;
            if self.phase > 2.0 * PI {
                self.phase -= 2.0 * PI;
            }
        }
    }
}
