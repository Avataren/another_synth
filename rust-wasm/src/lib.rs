#![feature(portable_simd)]

mod nodes;
mod traits;
mod utils;

pub use nodes::*;
pub use traits::*;
pub use utils::*;

use std::f32::consts::PI;
use utils::buffer_ops::multiply_buffers;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct AudioProcessor {
    phase: f32,
    sample_rate: f32,
    gate_buffer: [f32; 128],
    freq_buffer: [f32; 128],
    gain_envelope: Envelope,
    mod_envelopes: Vec<Envelope>,
    gain_buffer: Vec<f32>,
    mod_buffers: Vec<Vec<f32>>,
    osc_buffer: Vec<f32>,
}

#[wasm_bindgen]
impl AudioProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let sample_rate = 44100.0;
        let envelope_config = EnvelopeConfig::default();
        let initial_mod_envelopes = 1; // Start with 1 modulation envelope
        let default_buffer_size = 128;

        let mut mod_envelopes = Vec::with_capacity(initial_mod_envelopes);
        let mut mod_buffers = Vec::with_capacity(initial_mod_envelopes);

        for _ in 0..initial_mod_envelopes {
            mod_envelopes.push(Envelope::new(sample_rate, envelope_config.clone()));
            mod_buffers.push(vec![0.0; default_buffer_size]);
        }

        Self {
            phase: 0.0,
            sample_rate,
            gate_buffer: [0.0; 128],
            freq_buffer: [0.0; 128],
            gain_envelope: Envelope::new(sample_rate, envelope_config.clone()),
            mod_envelopes,
            gain_buffer: vec![0.0; default_buffer_size],
            mod_buffers,
            osc_buffer: vec![0.0; default_buffer_size],
        }
    }

    #[wasm_bindgen]
    pub fn init(&mut self, sample_rate: f32) {
        self.phase = 0.0;
        self.sample_rate = sample_rate;
        let envelope_config = EnvelopeConfig::default();

        self.gain_envelope = Envelope::new(sample_rate, envelope_config.clone());
        for envelope in self.mod_envelopes.iter_mut() {
            *envelope = Envelope::new(sample_rate, envelope_config.clone());
        }
    }

    #[wasm_bindgen]
    pub fn update_gain_envelope(&mut self, attack: f32, decay: f32, sustain: f32, release: f32) {
        let config = EnvelopeConfig {
            attack,
            decay,
            sustain,
            release,
            attack_curve: 0.0,
            decay_curve: 0.0,
            release_curve: 0.0,
            attack_smoothing_samples: 16,
        };
        self.gain_envelope.update_config(config);
    }

    #[wasm_bindgen]
    pub fn update_mod_envelope(
        &mut self,
        envelope_index: usize,
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
    ) {
        if envelope_index >= self.mod_envelopes.len() {
            return;
        }

        let config = EnvelopeConfig {
            attack,
            decay,
            sustain,
            release,
            attack_curve: 0.0,
            decay_curve: 0.0,
            release_curve: 0.0,
            attack_smoothing_samples: 16,
        };
        self.mod_envelopes[envelope_index].update_config(config);
    }

    #[wasm_bindgen]
    pub fn process_audio(
        &mut self,
        _input_left: &[f32],
        _input_right: &[f32],
        gate: &[f32],
        frequency_param: &[f32],
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        let buffer_size = output_left.len();

        // Safety check for buffer sizes
        if buffer_size == 0
            || output_right.len() != buffer_size
            || (gate.len() != 1 && gate.len() != buffer_size)
            || (frequency_param.len() != 1 && frequency_param.len() != buffer_size)
        {
            return;
        }

        // Resize buffers if needed
        if self.gain_buffer.len() < buffer_size {
            self.gain_buffer.resize(buffer_size, 0.0);
            self.osc_buffer.resize(buffer_size, 0.0);
            for buffer in self.mod_buffers.iter_mut() {
                buffer.resize(buffer_size, 0.0);
            }
        }

        // Update k-rate buffers
        if frequency_param.len() == 1 {
            self.freq_buffer[..buffer_size].fill(frequency_param[0]);
        }

        // Fill gate buffer for k-rate
        if gate.len() == 1 {
            self.gate_buffer[..buffer_size].fill(gate[0]);
        }

        // Generate oscillator samples
        for i in 0..buffer_size {
            let freq = if frequency_param.len() == 1 {
                self.freq_buffer[i]
            } else {
                frequency_param[i]
            };

            let increment = 2.0 * PI * freq / self.sample_rate;
            self.osc_buffer[i] = self.phase.sin();

            self.phase += increment;
            if self.phase > 2.0 * PI {
                self.phase -= 2.0 * PI;
            }
        }

        // Process gain envelope with either k-rate or a-rate gate
        self.gain_envelope.process_buffer(
            &[if gate.len() == 1 {
                &self.gate_buffer[..buffer_size]
            } else {
                gate
            }],
            &mut [&mut self.gain_buffer[..buffer_size]],
            buffer_size,
        );

        // Apply gain envelope using SIMD
        multiply_buffers(
            &self.osc_buffer[..buffer_size],
            &self.gain_buffer[..buffer_size],
            output_left,
        );
        multiply_buffers(
            &self.osc_buffer[..buffer_size],
            &self.gain_buffer[..buffer_size],
            output_right,
        );
    }
}
