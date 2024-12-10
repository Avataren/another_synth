use std::any::Any;
use std::collections::HashMap;
use std::simd::{f32x4, StdFloat};
use wasm_bindgen::prelude::wasm_bindgen;

use crate::processing::{AudioProcessor, ProcessContext};
use crate::traits::{AudioNode, PortId};
use crate::utils::curves::get_curved_value;

#[derive(Debug, Clone, Copy)]
pub enum EnvelopePhase {
    Idle,
    Attack,
    Decay,
    Sustain,
    Release,
}

#[wasm_bindgen]
#[derive(Debug, Clone)]
pub struct EnvelopeConfig {
    pub attack: f32,
    pub decay: f32,
    pub sustain: f32,
    pub release: f32,
    pub attack_curve: f32,
    pub decay_curve: f32,
    pub release_curve: f32,
    pub attack_smoothing_samples: usize,
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
            attack_smoothing_samples: 16,
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
    previous_values: Vec<f32>,
    smoothing_counter: usize,
    pre_attack_value: f32,
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
            previous_values: vec![0.0; 8],
            smoothing_counter: 0,
            pre_attack_value: 0.0,
        }
    }

    pub fn update_config(&mut self, config: EnvelopeConfig) {
        self.config = config;
    }

    fn trigger(&mut self, gate: f32) {
        if gate > 0.0 && self.last_gate_value <= 0.0 {
            self.pre_attack_value = self.value;
            self.phase = EnvelopePhase::Attack;
            self.smoothing_counter = self.config.attack_smoothing_samples;
        } else if gate <= 0.0 && self.last_gate_value > 0.0 {
            self.phase = EnvelopePhase::Release;
            self.release_level = self.value;
            self.position = 0.0;
        }
        self.last_gate_value = gate;
    }

    fn process_sample(&mut self, increment: f32) -> f32 {
        let target_value = match self.phase {
            EnvelopePhase::Attack => {
                let attack_time = self.config.attack.max(0.0001);
                self.position += increment / attack_time;

                if self.position >= 1.0 {
                    self.position = 0.0;
                    self.value = 1.0;
                    self.phase = EnvelopePhase::Decay;
                    1.0
                } else {
                    get_curved_value(self.position, self.config.attack_curve)
                }
            }
            EnvelopePhase::Decay => {
                let decay_time = self.config.decay.max(0.0001);
                self.position += increment / decay_time;

                if self.position >= 1.0 {
                    self.position = 0.0;
                    self.value = self.config.sustain;
                    self.phase = EnvelopePhase::Sustain;
                    self.config.sustain
                } else {
                    let decay_pos = get_curved_value(self.position, self.config.decay_curve);
                    1.0 - (decay_pos * (1.0 - self.config.sustain))
                }
            }
            EnvelopePhase::Sustain => self.config.sustain,
            EnvelopePhase::Release => {
                let release_time = self.config.release.max(0.0001);
                self.position += increment / release_time;

                if self.position >= 1.0 {
                    self.position = 0.0;
                    self.value = 0.0;
                    self.phase = EnvelopePhase::Idle;
                    0.0
                } else {
                    let release_pos = get_curved_value(self.position, self.config.release_curve);
                    self.release_level * (1.0 - release_pos)
                }
            }
            EnvelopePhase::Idle => 0.0,
        };

        if self.smoothing_counter > 0 {
            let smoothing_factor = (self.config.attack_smoothing_samples - self.smoothing_counter)
                as f32
                / self.config.attack_smoothing_samples as f32;
            self.value =
                self.pre_attack_value * (1.0 - smoothing_factor) + target_value * smoothing_factor;
            self.smoothing_counter -= 1;
        } else {
            self.value = target_value;
        }

        self.value.clamp(0.0, 1.0)
    }
}

impl AudioNode for Envelope {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::Gate, false);
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
        let mut context = ProcessContext::new(
            inputs,
            outputs,
            buffer_size,
            self.sample_rate,
            &default_values,
        );
        AudioProcessor::process(self, &mut context);
    }

    fn reset(&mut self) {
        AudioProcessor::reset(self);
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
}

impl AudioProcessor for Envelope {
    fn get_default_values(&self) -> HashMap<PortId, f32> {
        let mut defaults = HashMap::new();
        defaults.insert(PortId::Gate, 0.0);
        defaults
    }

    fn prepare(&mut self, sample_rate: f32, _buffer_size: usize) {
        self.sample_rate = sample_rate;
    }

    fn process(&mut self, context: &mut ProcessContext) {
        context.process_by_chunks(4, |offset, inputs, outputs| {
            // Get gate input
            let gate_values = inputs[&PortId::Gate].get_simd(offset);
            let gate_array = gate_values.to_array();
            let mut values = [0.0f32; 4];

            // Process each sample in the chunk
            for i in 0..4 {
                if gate_array[i] != self.last_gate_value {
                    self.trigger(gate_array[i]);
                }

                let increment = 1.0 / self.sample_rate;
                values[i] = self.process_sample(increment);
            }

            // Write output
            if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
                let values_simd = f32x4::from_array(values);
                output.write_simd(offset, values_simd);
            }
        });
    }

    fn reset(&mut self) {
        self.phase = EnvelopePhase::Idle;
        self.value = 0.0;
        self.release_level = 0.0;
        self.position = 0.0;
        self.last_gate_value = 0.0;
        self.smoothing_counter = 0;
    }
}
