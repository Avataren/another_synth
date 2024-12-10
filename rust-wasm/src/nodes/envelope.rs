use std::any::Any;
// src/nodes/envelope.rs
use std::collections::HashMap;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::utils::curves::get_curved_value;
use crate::traits::{AudioNode, PortId};
use std::simd::f32x4;

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
            let smoothing_factor = (self.config.attack_smoothing_samples - self.smoothing_counter) as f32
                / self.config.attack_smoothing_samples as f32;
            self.value = self.pre_attack_value * (1.0 - smoothing_factor) + target_value * smoothing_factor;
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
    ports.insert(PortId::Gate, false);        // Input, not required
    ports.insert(PortId::AudioOutput0, true); // Required output
    ports
}

  fn process(&mut self, inputs: &HashMap<PortId, &[f32]>, outputs: &mut HashMap<PortId, &mut [f32]>, buffer_size: usize) {
      let gate_input = inputs.get(&PortId::Gate).unwrap();
      let output = outputs.get_mut(&PortId::AudioOutput0).unwrap();

      let chunk_size = 4;
      let chunks = buffer_size / chunk_size;
      let remainder = buffer_size % chunk_size;

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

      for i in (buffer_size - remainder)..buffer_size {
          if gate_input[i] != self.last_gate_value {
              self.trigger(gate_input[i]);
          }

          let increment = 1.0 / self.sample_rate;
          output[i] = self.process_sample(increment);
      }
  }

  fn as_any_mut(&mut self) -> &mut dyn Any {
    self
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
