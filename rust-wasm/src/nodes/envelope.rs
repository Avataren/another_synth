use std::any::Any;
use std::collections::HashMap;
use wasm_bindgen::prelude::wasm_bindgen;
use web_sys::console;

use crate::graph::{ModulationProcessor, ModulationSource};
use crate::traits::{AudioNode, PortId};
use crate::utils::curves::get_curved_value;

// Resolution of our lookup tables.
const CURVE_TABLE_SIZE: usize = 1024;

#[derive(Debug, Clone, Copy, PartialEq)]
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
            attack: 0.00,
            decay: 0.1,
            sustain: 0.5,
            release: 0.1,
            attack_curve: 0.0,
            decay_curve: 0.0,
            release_curve: 0.0,
            attack_smoothing_samples: 0,
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
    // Lookup tables for the curves.
    attack_table: Vec<f32>,
    decay_table: Vec<f32>,
    release_table: Vec<f32>,
    // Debug flag to avoid spamming the console during attack.
    debug_logged_attack: bool,
}

impl Envelope {
    pub fn new(sample_rate: f32, config: EnvelopeConfig) -> Self {
        let mut env = Self {
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
            attack_table: Vec::with_capacity(CURVE_TABLE_SIZE),
            decay_table: Vec::with_capacity(CURVE_TABLE_SIZE),
            release_table: Vec::with_capacity(CURVE_TABLE_SIZE),
            debug_logged_attack: false,
        };
        if env.config.attack <= 0.0005 {
            env.config.attack = 0.0005;
        }
        env.update_lookup_tables();
        env
    }

    /// Precompute lookup tables for the attack, decay, and release curves.
    pub fn update_lookup_tables(&mut self) {
        self.attack_table.clear();
        self.decay_table.clear();
        self.release_table.clear();

        for i in 0..CURVE_TABLE_SIZE {
            let pos = i as f32 / (CURVE_TABLE_SIZE - 1) as f32;
            // For attack, store the curved value.
            self.attack_table
                .push(get_curved_value(pos, self.config.attack_curve));
            // For decay and release, store the raw curved value.
            self.decay_table
                .push(get_curved_value(pos, self.config.decay_curve));
            self.release_table
                .push(get_curved_value(pos, self.config.release_curve));
        }
    }

    pub fn update_config(&mut self, config: EnvelopeConfig) {
        self.config = config;
        if self.config.attack <= 0.0005 {
            self.config.attack = 0.0005;
        }
        self.smoothing_counter = 0;
        self.update_lookup_tables();
    }

    pub fn get_phase(&self) -> EnvelopePhase {
        self.phase
    }

    pub fn is_active(&self) -> bool {
        !matches!(self.phase, EnvelopePhase::Idle)
    }

    /// Helper: look up the curve value from a given table.
    fn lookup_value(table: &Vec<f32>, position: f32) -> f32 {
        let clamped = position.clamp(0.0, 1.0);
        let index = (clamped * (CURVE_TABLE_SIZE - 1) as f32).round() as usize;
        table[index]
    }

    /// Process one sample by stepping the envelope state machine.
    /// Now accepts separate additive and multiplicative modulation parameters for the attack phase.
    fn process_sample(&mut self, increment: f32, attack_mod_add: f32, attack_mod_mul: f32) -> f32 {
        match self.phase {
            EnvelopePhase::Attack => {
                let base_attack_time = self.config.attack;
                // First add the additive modulation, then scale by the multiplicative modulation.
                let modulated_attack_time =
                    ((base_attack_time + attack_mod_add).max(0.0001)) * attack_mod_mul;
                self.position += increment / modulated_attack_time;

                // Log once per attack phase.
                if !self.debug_logged_attack {
                    console::log_1(
                        &format!(
                            "Attack Phase: additive: {:.3}, multiplicative: {:.3}, modulated_attack_time: {:.3}, position: {:.3}",
                            attack_mod_add, attack_mod_mul, modulated_attack_time, self.position
                        )
                        .into(),
                    );
                    self.debug_logged_attack = true;
                }

                if self.position >= 1.0 {
                    self.position = 0.0;
                    self.value = 1.0;
                    self.phase = EnvelopePhase::Decay;
                    self.debug_logged_attack = false; // reset for next attack
                    1.0
                } else {
                    let curve_value = Self::lookup_value(&self.attack_table, self.position);
                    self.value = curve_value;
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
                    let decay_pos = Self::lookup_value(&self.decay_table, self.position);
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
                    let release_progress = Self::lookup_value(&self.release_table, self.position);
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

    /// Respond to gate changes.
    fn trigger(&mut self, gate: f32) {
        if gate > 0.0 && self.last_gate_value <= 0.0 {
            console::log_1(&"Gate on detected, starting attack".into());
            self.debug_logged_attack = false;
            self.pre_attack_value = self.value;
            self.phase = EnvelopePhase::Attack;
            self.smoothing_counter = self.config.attack_smoothing_samples;
            self.position = 0.0;
        } else if gate <= 0.0 && self.last_gate_value > 0.0 {
            console::log_1(&"Gate off detected, starting release".into());
            self.phase = EnvelopePhase::Release;
            self.release_level = self.value; // store current value for release
            self.position = 0.0;
        }
        self.last_gate_value = gate;
    }

    /// Generate a preview buffer of envelope values for visualization.
    pub fn preview(&self, preview_duration: f32) -> Vec<f32> {
        let total_samples = (self.sample_rate * preview_duration).ceil() as usize;
        let mut preview_values = Vec::with_capacity(total_samples);
        // Use a temporary envelope instance so that preview simulation does not affect real-time processing.
        let mut sim_env = Envelope::new(self.sample_rate, self.config.clone());
        sim_env.trigger(1.0);

        for i in 0..total_samples {
            let t = i as f32 / self.sample_rate;
            // After a hold period (attack + decay + 1 second), simulate gate-off to trigger the release phase.
            if t > (self.config.attack + self.config.decay + 1.0)
                && sim_env.phase != EnvelopePhase::Release
            {
                sim_env.trigger(0.0);
            }
            let increment = 1.0 / self.sample_rate;
            // For preview, use zero additive and unity multiplicative modulation.
            let value = sim_env.process_sample(increment, 0.0, 1.0);
            preview_values.push(value);
        }

        preview_values
    }
}

// Use the new mixed-mode modulation processor.
impl ModulationProcessor for Envelope {}

impl AudioNode for Envelope {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::Gate, false);
        ports.insert(PortId::AudioOutput0, true);
        // Added AttackMod port for modulation of the attack phase.
        ports.insert(PortId::AttackMod, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        use std::simd::f32x4;

        // Process gate modulations.
        let gate_buffer = self.process_modulations(buffer_size, inputs.get(&PortId::Gate), 0.0);
        // Use process_modulations_ex to separate additive and multiplicative modulation for attack.
        let modulation_result =
            self.process_modulations_ex(buffer_size, inputs.get(&PortId::AttackMod));

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
                    // Retrieve additive and multiplicative attack modulation values.
                    let attack_mod_add = modulation_result.additive[i + j];
                    let attack_mod_mul = modulation_result.multiplicative[i + j];

                    values[j] = self.process_sample(increment, attack_mod_add, attack_mod_mul);
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
