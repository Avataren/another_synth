use std::any::Any;
use std::collections::HashMap;
use std::simd::f32x4;
use wasm_bindgen::prelude::wasm_bindgen;
use web_sys::console;

use crate::graph::{ModulationProcessor, ModulationSource, ModulationType};
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

#[wasm_bindgen]
impl EnvelopeConfig {
    #[wasm_bindgen(constructor)]
    pub fn new(
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
        attack_curve: f32,
        decay_curve: f32,
        release_curve: f32,
        attack_smoothing_samples: usize,
        active: bool,
    ) -> Self {
        EnvelopeConfig {
            attack,
            decay,
            sustain,
            release,
            attack_curve,
            decay_curve,
            release_curve,
            attack_smoothing_samples,
            active,
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
        self.smoothing_counter = 0;
    }

    pub fn get_phase(&self) -> EnvelopePhase {
        self.phase
    }

    pub fn is_active(&self) -> bool {
        !matches!(self.phase, EnvelopePhase::Idle)
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
                    1.0
                } else {
                    self.value = get_curved_value(self.position, self.config.attack_curve);
                    if self.smoothing_counter > 0 {
                        let smoothing_factor =
                            (self.config.attack_smoothing_samples - self.smoothing_counter) as f32
                                / self.config.attack_smoothing_samples as f32;
                        self.value = self.pre_attack_value * (1.0 - smoothing_factor)
                            + self.value * smoothing_factor;
                        self.smoothing_counter -= 1;
                    }
                    self.value
                }
            }
            EnvelopePhase::Decay => {
                let decay_time = self.config.decay.max(0.0001);
                self.position += increment / decay_time;

                if self.position >= 1.0 {
                    self.position = 0.0;
                    self.value = self.config.sustain;
                    self.phase = EnvelopePhase::Sustain;
                    self.value
                } else {
                    let decay_pos = get_curved_value(self.position, self.config.decay_curve);
                    self.value = 1.0 - (decay_pos * (1.0 - self.config.sustain));
                    self.value
                }
            }
            EnvelopePhase::Sustain => {
                self.value = self.config.sustain;
                self.value
            }
            EnvelopePhase::Release => {
                let release_time = self.config.release.max(0.0001);
                self.position += increment / release_time;

                if self.position >= 1.0 {
                    self.position = 0.0;
                    self.value = 0.0;
                    self.phase = EnvelopePhase::Idle;
                    0.0
                } else {
                    let release_progress =
                        get_curved_value(self.position, self.config.release_curve);
                    self.value = self.release_level * (1.0 - release_progress);
                    self.value.clamp(0.0, 1.0)
                }
            }
            EnvelopePhase::Idle => {
                self.value = 0.0;
                0.0
            }
        }
    }

    fn trigger(&mut self, gate: f32) {
        if gate > 0.0 && self.last_gate_value <= 0.0 {
            // Gate on - start attack
            self.pre_attack_value = self.value;
            self.phase = EnvelopePhase::Attack;
            self.smoothing_counter = self.config.attack_smoothing_samples;
            self.position = 0.0;
        } else if gate <= 0.0 && self.last_gate_value > 0.0 {
            // Gate off - start release
            self.phase = EnvelopePhase::Release;
            self.release_level = self.value; // Store current value for release
            self.position = 0.0;
        }
        self.last_gate_value = gate;
    }
}

// Use the new mixed-mode modulation processor.
impl ModulationProcessor for Envelope {}

impl AudioNode for Envelope {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::Gate, false);
        ports.insert(PortId::AudioOutput0, true);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        use std::simd::f32x4;

        // Combine all gate sources using the new modulation processor.
        let gate_buffer = self.process_modulations(buffer_size, inputs.get(&PortId::Gate), 0.0);

        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            for i in (0..buffer_size).step_by(4) {
                let end = (i + 4).min(buffer_size);

                // Copy gate values for this chunk.
                let mut gate_chunk = [0.0; 4];
                gate_chunk[0..(end - i)].copy_from_slice(&gate_buffer[i..end]);
                let gate_values = f32x4::from_array(gate_chunk);
                let gate_array = gate_values.to_array();

                let mut values = [0.0f32; 4];

                for j in 0..(end - i) {
                    // Convert gate to binary: any non-zero value triggers the gate.
                    let current_gate = if gate_array[j] > 0.0 { 1.0 } else { 0.0 };

                    // Check for gate changes and trigger the envelope.
                    if current_gate != self.last_gate_value {
                        self.trigger(current_gate);
                    }
                    self.last_gate_value = current_gate;

                    let increment = 1.0 / self.sample_rate;
                    values[j] = self.process_sample(increment);
                }

                let values_simd = f32x4::from_array(values);
                output[i..end].copy_from_slice(&values_simd.to_array()[0..(end - i)]);
            }
        }
    }

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
