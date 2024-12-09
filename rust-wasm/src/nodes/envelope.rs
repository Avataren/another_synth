use crate::traits::AudioNode;
use crate::utils::curves::get_curved_value;
use std::simd::f32x4;

#[derive(Debug, Clone, Copy)]
pub enum EnvelopePhase {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[derive(Debug, Clone)]
pub struct EnvelopeConfig {
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
    pub attack_curve: f32,
    pub decay_curve: f32,
    pub release_curve: f32,
}

impl Default for EnvelopeConfig {
    fn default() -> Self {
        Self {
            attack: 0.01,
            decay: 0.1,
            sustain: 0.5,
            release: 0.3,
            attack_curve: 0.0,
            decay_curve: 0.0,
            release_curve: 0.0,
        }
    }
}

pub struct Envelope {
    phase: EnvelopePhase,
    value: f32,
    release_level: f32,
    sample_rate: f32,
    config: EnvelopeConfig,
    position: f32,
    last_gate_value: f32,
}

impl Envelope {
    pub fn new(sample_rate: f32, config: EnvelopeConfig) -> Self {
        Self {
            phase: EnvelopePhase::Idle,
            value: 0.0,
            release_level: 0.0,
            sample_rate,
            config,
            position: 0.0,
            last_gate_value: 0.0,
        }
    }

    pub fn update_config(&mut self, config: EnvelopeConfig) {
        self.config = config;
    }

    fn trigger(&mut self, gate: f32) {
        if gate > 0.0 && self.last_gate_value <= 0.0 {
            // Retrigger on any new gate-on, regardless of current phase
            self.reset();
            self.phase = EnvelopePhase::Attack;
        } else if gate <= 0.0 && self.last_gate_value > 0.0 {
            self.phase = EnvelopePhase::Release;
            self.release_level = self.value;
            self.position = 0.0;
        }
        self.last_gate_value = gate;
    }

    fn process_sample(&mut self, increment: f32) -> f32 {
        match self.phase {
            EnvelopePhase::Attack => {
                let attack_time = self.config.attack.max(0.0001);
                self.position += increment / attack_time;

                if self.position >= 1.0 {
                    self.position = 0.0;
                    self.value = 1.0;
                    self.phase = EnvelopePhase::Decay;
                } else {
                    self.value = get_curved_value(self.position, self.config.attack_curve);
                }
            }
            EnvelopePhase::Decay => {
                let decay_time = self.config.decay.max(0.0001);
                self.position += increment / decay_time;

                if self.position >= 1.0 {
                    self.position = 0.0;
                    self.value = self.config.sustain;
                    self.phase = EnvelopePhase::Sustain;
                } else {
                    let decay_pos = get_curved_value(self.position, self.config.decay_curve);
                    self.value = 1.0 - (decay_pos * (1.0 - self.config.sustain));
                }
            }
            EnvelopePhase::Sustain => {
                self.value = self.config.sustain;
            }
            EnvelopePhase::Release => {
                let release_time = self.config.release.max(0.0001);
                self.position += increment / release_time;

                if self.position >= 1.0 {
                    self.position = 0.0;
                    self.value = 0.0;
                    self.phase = EnvelopePhase::Idle;
                } else {
                    let release_pos = get_curved_value(self.position, self.config.release_curve);
                    self.value = self.release_level * (1.0 - release_pos);
                }
            }
            EnvelopePhase::Idle => {
                self.value = 0.0;
            }
        }

        self.value.clamp(0.0, 1.0)
    }
}

impl AudioNode for Envelope {
    fn process_buffer(
        &mut self,
        inputs: &[&[f32]],
        outputs: &mut [&mut [f32]],
        buffer_size: usize,
    ) {
        let gate_input = inputs[0];
        let output = &mut outputs[0];

        let chunk_size = 4;
        let chunks = buffer_size / chunk_size;
        let remainder = buffer_size % chunk_size;

        // Process SIMD chunks
        for chunk in 0..chunks {
            let gate_values = f32x4::from_slice(&gate_input[chunk * chunk_size..]);
            let gate_array = gate_values.to_array();
            let mut values = [0.0f32; 4];

            for i in 0..chunk_size {
                if gate_array[i] != self.last_gate_value {
                    self.trigger(gate_array[i]);
                }

                let increment = 1.0 / self.sample_rate;
                values[i] = self.process_sample(increment);
            }

            let values_simd = f32x4::from_array(values);
            values_simd.copy_to_slice(&mut output[chunk * chunk_size..(chunk + 1) * chunk_size]);
        }

        // Handle remaining samples
        for i in (buffer_size - remainder)..buffer_size {
            if gate_input[i] != self.last_gate_value {
                self.trigger(gate_input[i]);
            }

            let increment = 1.0 / self.sample_rate;
            output[i] = self.process_sample(increment);
        }
    }

    fn reset(&mut self) {
        self.phase = EnvelopePhase::Idle;
        self.value = 0.0;
        self.release_level = 0.0;
        self.position = 0.0;
        self.last_gate_value = 0.0;
    }
}
