use std::any::Any;
use std::collections::HashMap;
use std::simd::f32x4;
use wasm_bindgen::prelude::wasm_bindgen;

use crate::graph::ModulationSource;
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
    pub active: bool,
}

impl Default for EnvelopeConfig {
    fn default() -> Self {
        Self {
            attack: 0.001,
            decay: 0.25,
            sustain: 0.25,
            release: 0.5,
            attack_curve: 0.0,
            decay_curve: 0.0,
            release_curve: 0.0,
            attack_smoothing_samples: 16,
            active: true,
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
    smoothing_counter: usize,
    pre_attack_value: f32,
    active: bool,
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
            smoothing_counter: 0,
            pre_attack_value: 0.0,
            active: true,
        }
    }

    pub fn update_config(&mut self, config: EnvelopeConfig) {
        self.config = config;
    }

    pub fn get_phase(&self) -> EnvelopePhase {
        self.phase
    }

    pub fn is_active(&self) -> bool {
        !matches!(self.phase, EnvelopePhase::Idle)
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
        audio_inputs: &HashMap<PortId, Vec<f32>>,
        _mod_inputs: &HashMap<PortId, Vec<ModulationSource>>, // Envelope doesn't use modulation
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        use std::simd::f32x4;

        // Process in chunks of 4 samples
        for i in (0..buffer_size).step_by(4) {
            let end = (i + 4).min(buffer_size);

            // Get gate values
            let mut gate_chunk = [0.0; 4];
            if let Some(gate_input) = audio_inputs.get(&PortId::Gate) {
                gate_chunk[0..end - i].copy_from_slice(&gate_input[i..end]);
            }
            let gate_values = f32x4::from_array(gate_chunk);
            let gate_array = gate_values.to_array();

            let mut values = [0.0f32; 4];

            // Process each sample in the chunk
            for j in 0..(end - i) {
                if gate_array[j] != self.last_gate_value {
                    self.trigger(gate_array[j]);
                }

                let increment = 1.0 / self.sample_rate;
                values[j] = self.process_sample(increment);
            }

            // Write output
            if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
                let values_simd = f32x4::from_array(values);
                output[i..end].copy_from_slice(&values_simd.to_array()[0..end - i]);
            }
        }
    }

    // Rest of the implementation remains the same
    fn reset(&mut self) {
        self.phase = EnvelopePhase::Idle;
        self.value = 0.0;
        self.release_level = 0.0;
        self.position = 0.0;
        self.last_gate_value = 0.0;
        self.smoothing_counter = 0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn is_active(&self) -> bool {
        self.active
    }

    fn set_active(&mut self, active: bool) {
        self.active = active;
    }

    fn node_type(&self) -> &str {
        "envelope"
    }
}

impl AudioProcessor for Envelope {
    fn get_default_values(&self) -> HashMap<PortId, f32> {
        let mut defaults = HashMap::new();
        defaults.insert(PortId::Gate, 0.0);
        defaults
    }

    // fn prepare(&mut self, sample_rate: f32, _buffer_size: usize) {
    //     self.sample_rate = sample_rate;
    // }

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

#[cfg(test)]
mod envelope_tests {
    use super::*;

    fn run_envelope_for_samples(env: &mut Envelope, gate: f32, samples: usize) -> Vec<f32> {
        let increment = 1.0 / env.sample_rate;
        let mut results = Vec::with_capacity(samples);

        // If gate changes, trigger envelope
        if gate != env.last_gate_value {
            env.trigger(gate);
        }

        for _ in 0..samples {
            let val = env.process_sample(increment);
            results.push(val);
        }

        results
    }

    #[test]
    fn test_envelope_idle_to_attack() {
        let sample_rate = 48000.0;
        let config = EnvelopeConfig {
            attack: 0.01,
            decay: 0.1,
            sustain: 0.5,
            release: 0.3,
            attack_curve: 0.0,
            decay_curve: 0.0,
            release_curve: 0.0,
            attack_smoothing_samples: 0,
            active: true,
        };
        let mut env = Envelope::new(sample_rate, config);

        // Initially idle, envelope should be at 0.0
        assert_eq!(env.value, 0.0);
        assert_eq!(matches!(env.phase, EnvelopePhase::Idle), true);

        // Trigger the gate (go high)
        let results = run_envelope_for_samples(&mut env, 1.0, (sample_rate * 0.01) as usize); // attack time worth of samples
                                                                                              // After full attack time, envelope should be at or near 1.0 and be in Decay phase.
        assert!(
            results.last().unwrap() >= &0.99,
            "Envelope should reach near 1.0 after attack"
        );
        assert_eq!(matches!(env.phase, EnvelopePhase::Decay), true);
    }

    #[test]
    fn test_envelope_decay_to_sustain() {
        let sample_rate = 48000.0;
        let config = EnvelopeConfig {
            attack: 0.01,
            decay: 0.1,
            sustain: 0.5,
            release: 0.3,
            attack_curve: 0.0,
            decay_curve: 0.0,
            release_curve: 0.0,
            attack_smoothing_samples: 0,
            active: true,
        };
        let mut env = Envelope::new(sample_rate, config);

        // Attack phase: run a bit longer than strictly required to ensure we hit 1.0
        run_envelope_for_samples(&mut env, 1.0, (sample_rate * 0.01) as usize + 10);
        // Decay phase: also run a bit longer to ensure we reach sustain
        run_envelope_for_samples(&mut env, 1.0, (sample_rate * 0.1) as usize + 10);

        assert!(
            matches!(env.phase, EnvelopePhase::Sustain),
            "Envelope should be in Sustain phase after decay period"
        );
        let val = env.value;
        assert!(
            (val - 0.5).abs() < 0.05,
            "Value should be near the sustain level"
        );
    }

    #[test]
    fn test_envelope_sustain_held() {
        let sample_rate = 48000.0;
        let config = EnvelopeConfig {
            attack: 0.01,
            decay: 0.1,
            sustain: 0.5,
            release: 0.3,
            attack_curve: 0.0,
            decay_curve: 0.0,
            release_curve: 0.0,
            attack_smoothing_samples: 0,
            active: true,
        };
        let mut env = Envelope::new(sample_rate, config);

        // Attack + Decay
        run_envelope_for_samples(&mut env, 1.0, (sample_rate * 0.01) as usize);
        run_envelope_for_samples(&mut env, 1.0, (sample_rate * 0.1) as usize);

        // Now at sustain, hold for a bit
        let results = run_envelope_for_samples(&mut env, 1.0, (sample_rate * 0.05) as usize);
        // All values during sustain should be near the sustain level
        let average = results.iter().copied().sum::<f32>() / results.len() as f32;
        assert!(
            (average - 0.5).abs() < 0.01,
            "Average value during sustain should be near 0.5"
        );
    }

    #[test]
    fn test_envelope_release_to_idle() {
        let sample_rate = 48000.0;
        let config = EnvelopeConfig {
            attack: 0.01,
            decay: 0.1,
            sustain: 0.5,
            release: 0.3,
            attack_curve: 0.0,
            decay_curve: 0.0,
            release_curve: 0.0,
            attack_smoothing_samples: 0,
            active: true,
        };
        let mut env = Envelope::new(sample_rate, config);

        // Attack + Decay + Sustain
        run_envelope_for_samples(&mut env, 1.0, (sample_rate * 0.01) as usize + 10);
        run_envelope_for_samples(&mut env, 1.0, (sample_rate * 0.1) as usize + 10);
        run_envelope_for_samples(&mut env, 1.0, (sample_rate * 0.05) as usize);

        // Now release (gate low)
        let results = run_envelope_for_samples(&mut env, 0.0, (sample_rate * 0.3) as usize + 10);
        let final_val = *results.last().unwrap();
        assert!(
            final_val < 0.01,
            "Envelope should return close to 0.0 after release"
        );
        assert!(
            matches!(env.phase, EnvelopePhase::Idle),
            "Envelope should be in Idle phase after release"
        );
    }

    #[test]
    fn test_envelope_smoothing() {
        let sample_rate = 48000.0;
        let config = EnvelopeConfig {
            attack: 0.01,
            decay: 0.1,
            sustain: 0.5,
            release: 0.3,
            attack_curve: 0.0,
            decay_curve: 0.0,
            release_curve: 0.0,
            attack_smoothing_samples: 16,
            active: true,
        };
        let mut env = Envelope::new(sample_rate, config);

        // Trigger gate and run a few samples
        let results = run_envelope_for_samples(&mut env, 1.0, 20);

        // Instead of checking immediately at sample 0, let's check after a few samples
        // The smoothing should gradually increase the value; by sample 5 or so, we should have some noticeable rise.
        let avg_first_five = results[0..5].iter().sum::<f32>() / 5.0;
        assert!(
            avg_first_five > 0.0,
            "Should have started rising above 0.0 within the first few samples"
        );
    }
}
