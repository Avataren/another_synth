use rustc_hash::FxHashMap;
use std::any::Any;
// Keep for potential output writing optimization
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::wasm_bindgen;
// use web_sys::console; // Uncomment for debugging

// Import necessary types
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

#[cfg_attr(feature = "wasm", wasm_bindgen)]
#[derive(Debug, Clone)]
pub struct EnvelopeConfig {
    pub attack: f32,  // Time in seconds
    pub decay: f32,   // Time in seconds
    pub sustain: f32, // Level (0.0 to 1.0)
    pub release: f32, // Time in seconds
    pub attack_curve: f32,
    pub decay_curve: f32,
    pub release_curve: f32,
    pub attack_smoothing_samples: usize, // Number of samples for smoothing start of attack
    pub active: bool,                    // Whether the node is active (used by graph)
}

// Sensible defaults
impl Default for EnvelopeConfig {
    fn default() -> Self {
        Self {
            attack: 0.001, // Slightly more than 0 to avoid clicks/pops
            decay: 0.1,
            sustain: 0.8,
            release: 0.2,
            attack_curve: 0.0,  // Linear
            decay_curve: 0.0,   // Linear
            release_curve: 0.0, // Linear
            attack_smoothing_samples: 0,
            active: true,
        }
    }
}

#[cfg(feature = "wasm")]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
impl EnvelopeConfig {
    #[cfg_attr(feature = "wasm", wasm_bindgen(constructor))]
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
            // Ensure minimum attack time to prevent discontinuities
            attack: attack.max(0.0001),
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
    // State
    phase: EnvelopePhase,
    value: f32,               // Current output value
    release_level: f32,       // Value when release phase started
    position: f32,            // Position within the current phase (0.0 to 1.0)
    last_gate_value: f32,     // Previous gate value to detect changes
    smoothing_counter: usize, // Remaining samples for attack smoothing
    pre_attack_value: f32,    // Value before attack started (for smoothing)

    // Configuration & Timing
    sample_rate: f32,
    sample_rate_recip: f32, // Store 1.0 / sample_rate
    config: EnvelopeConfig, // Holds A, D, S, R times/levels and curves

    // Lookup tables for curves
    attack_table: Vec<f32>,
    decay_table: Vec<f32>,
    release_table: Vec<f32>,

    // === Scratch Buffers ===
    // For intermediate modulation results
    mod_scratch_add: Vec<f32>,
    mod_scratch_mult: Vec<f32>,
    // For final processed inputs
    gate_buffer: Vec<f32>,        // Final gate signal after modulation (if any)
    scratch_attack_add: Vec<f32>, // Additive component of attack modulation
    scratch_attack_mult: Vec<f32>, // Multiplicative component of attack modulation

                                  // Debug flag
                                  // debug_logged_attack: bool, // Can be useful for debugging specific phases
}

impl Envelope {
    pub fn new(sample_rate: f32, config: EnvelopeConfig) -> Self {
        let initial_capacity = 128; // Default buffer size
        let mut env = Self {
            phase: EnvelopePhase::Idle,
            value: 0.0,
            release_level: 0.0,
            position: 0.0,
            last_gate_value: 0.0,
            smoothing_counter: 0,
            pre_attack_value: 0.0,
            sample_rate,
            sample_rate_recip: 1.0 / sample_rate,
            // Ensure minimum attack time on initial config
            config: EnvelopeConfig {
                attack: config.attack.max(0.001),
                ..config
            },
            attack_table: Vec::with_capacity(CURVE_TABLE_SIZE),
            decay_table: Vec::with_capacity(CURVE_TABLE_SIZE),
            release_table: Vec::with_capacity(CURVE_TABLE_SIZE),
            // Initialize scratch buffers
            mod_scratch_add: vec![0.0; initial_capacity],
            mod_scratch_mult: vec![1.0; initial_capacity],
            gate_buffer: vec![0.0; initial_capacity],
            scratch_attack_add: vec![0.0; initial_capacity],
            scratch_attack_mult: vec![1.0; initial_capacity],
            // debug_logged_attack: false,
        };
        env.update_lookup_tables();
        env
    }

    /// Ensure all scratch buffers have at least `size` capacity.
    fn ensure_scratch_buffers(&mut self, size: usize) {
        let resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
            if buf.len() < size {
                buf.resize(size, default_val);
            }
        };
        resize_if_needed(&mut self.mod_scratch_add, 0.0);
        resize_if_needed(&mut self.mod_scratch_mult, 1.0);
        resize_if_needed(&mut self.gate_buffer, 0.0); // Reset later
        resize_if_needed(&mut self.scratch_attack_add, 0.0);
        resize_if_needed(&mut self.scratch_attack_mult, 1.0);
    }

    /// Precompute lookup tables for the attack, decay, and release curves.
    pub fn update_lookup_tables(&mut self) {
        self.attack_table.clear();
        self.decay_table.clear();
        self.release_table.clear();
        let size_minus_1 = (CURVE_TABLE_SIZE - 1) as f32;

        for i in 0..CURVE_TABLE_SIZE {
            let pos = i as f32 / size_minus_1;
            // Attack: curve maps input position [0,1] to output level [0,1]
            self.attack_table
                .push(get_curved_value(pos, self.config.attack_curve));
            // Decay: curve maps input position [0,1] to amount decayed [0,1]
            self.decay_table
                .push(get_curved_value(pos, self.config.decay_curve));
            // Release: curve maps input position [0,1] to amount released [0,1]
            self.release_table
                .push(get_curved_value(pos, self.config.release_curve));
        }
    }

    /// Update the envelope's configuration.
    pub fn update_config(&mut self, config: EnvelopeConfig) {
        self.config = EnvelopeConfig {
            attack: config.attack.max(0.001), // Enforce minimum attack time
            ..config
        };
        // Reset smoothing if config changes during attack? Or let it finish? Let it finish.
        // self.smoothing_counter = 0;
        self.update_lookup_tables();
    }

    pub fn get_phase(&self) -> EnvelopePhase {
        self.phase
    }

    // Renamed from is_active to avoid conflict with AudioNode trait method
    pub fn is_processing_active(&self) -> bool {
        !matches!(self.phase, EnvelopePhase::Idle) || self.value > 1e-6 // Consider active if value is non-zero
    }

    /// Helper: look up the curve value from a given table using linear interpolation.
    #[inline(always)]
    fn lookup_value_interpolated(table: &[f32], position: f32) -> f32 {
        let table_len = table.len();
        if table_len == 0 {
            return 0.0;
        } // Should not happen if initialized

        let scaled_pos = position.clamp(0.0, 1.0) * (table_len - 1) as f32;
        let index_f = scaled_pos.floor();
        let index0 = index_f as usize;
        let frac = scaled_pos - index_f;

        // Basic bounds check (should be optimized away by clamp if table_len > 0)
        if index0 >= table_len - 1 {
            table[table_len - 1]
        } else {
            let val0 = table[index0];
            let val1 = table[index0 + 1];
            val0 + (val1 - val0) * frac // Linear interpolation
        }
    }

    /// Process one sample by stepping the envelope state machine.
    /// Takes modulated attack components as input for the current sample.
    #[inline(always)]
    fn process_sample(&mut self, attack_mod_add: f32, attack_mod_mul: f32) -> f32 {
        let increment = self.sample_rate_recip; // Use precalculated reciprocal

        match self.phase {
            EnvelopePhase::Attack => {
                // Calculate modulated attack time for this sample
                let modulated_attack_time =
                    (self.config.attack + attack_mod_add).max(0.0001) * attack_mod_mul.max(0.0); // Ensure > 0

                // Calculate position increment based on modulated time
                let pos_increment = if modulated_attack_time > 1e-9 {
                    // Avoid division by zero/tiny
                    increment / modulated_attack_time
                } else {
                    1.0 // Effectively instant attack if time is ~0
                };
                self.position += pos_increment;

                // Transition check
                if self.position >= 1.0 {
                    self.position = 0.0;
                    self.value = 1.0; // Ensure exactly 1.0 at end of attack
                    self.phase = EnvelopePhase::Decay;
                    // self.debug_logged_attack = false; // reset for next attack
                    1.0
                } else {
                    // Lookup curved value based on position
                    let curve_value =
                        Self::lookup_value_interpolated(&self.attack_table, self.position);
                    self.value = curve_value;

                    // Apply smoothing if active
                    if self.smoothing_counter > 0 {
                        let smoothing_factor =
                            (self.config.attack_smoothing_samples - self.smoothing_counter) as f32
                                / self.config.attack_smoothing_samples as f32;
                        // Interpolate between value before attack and current curved value
                        self.value = self.pre_attack_value * (1.0 - smoothing_factor)
                            + self.value * smoothing_factor;
                        self.smoothing_counter -= 1;
                    }
                    self.value
                }
            }
            EnvelopePhase::Decay => {
                let decay_time = self.config.decay.max(0.0001); // Ensure > 0
                self.position += increment / decay_time;

                // Transition check
                if self.position >= 1.0 {
                    self.position = 0.0;
                    self.value = self.config.sustain; // Ensure exactly sustain level
                    self.phase = EnvelopePhase::Sustain;
                    self.value
                } else {
                    // Lookup curved decay amount (0 to 1)
                    let decay_amount =
                        Self::lookup_value_interpolated(&self.decay_table, self.position);
                    // Interpolate from 1.0 down to sustain level
                    self.value = 1.0 - (decay_amount * (1.0 - self.config.sustain));
                    self.value
                }
            }
            EnvelopePhase::Sustain => {
                // Value remains constant at sustain level
                self.value = self.config.sustain;
                self.value
            }
            EnvelopePhase::Release => {
                let release_time = self.config.release.max(0.0001); // Ensure > 0
                self.position += increment / release_time;

                // Transition check
                if self.position >= 1.0 {
                    self.position = 0.0;
                    self.value = 0.0; // Ensure exactly 0.0 at end of release
                    self.phase = EnvelopePhase::Idle;
                    0.0
                } else {
                    // Lookup curved release amount (0 to 1)
                    let release_amount =
                        Self::lookup_value_interpolated(&self.release_table, self.position);
                    // Interpolate from release_level down to 0.0
                    self.value = self.release_level * (1.0 - release_amount);
                    self.value.max(0.0) // Ensure value doesn't go below 0
                }
            }
            EnvelopePhase::Idle => {
                // Value remains 0.0
                self.value = 0.0;
                0.0
            }
        }
    }

    /// Respond to gate changes.
    #[inline(always)]
    fn trigger(&mut self, gate_on: bool) {
        if gate_on && self.last_gate_value <= 0.0 {
            // Rising edge
            // console::log_1(&"Gate ON".into());
            // self.debug_logged_attack = false; // Reset debug flag
            self.pre_attack_value = self.value; // Store value for smoothing
            self.phase = EnvelopePhase::Attack;
            self.position = 0.0; // Reset position for attack phase
                                 // Start smoothing counter if enabled
            self.smoothing_counter = if self.value < 1.0 {
                // Only smooth if not already at peak
                self.config.attack_smoothing_samples
            } else {
                0
            };
        } else if !gate_on && self.last_gate_value > 0.0 {
            // Falling edge
            // console::log_1(&"Gate OFF".into());
            // Only start release if not already idle (e.g., from very short note)
            if self.phase != EnvelopePhase::Idle {
                self.phase = EnvelopePhase::Release;
                self.release_level = self.value; // Store current value to release from
                self.position = 0.0; // Reset position for release phase
            }
        }
        // Update last_gate_value (store > 0.0 as 1.0 for consistent check)
        self.last_gate_value = if gate_on { 1.0 } else { 0.0 };
    }

    /// Generate a preview buffer of envelope values for visualization.
    /// NOTE: This still uses a separate simulation and doesn't use the new modulation infra.
    /// It's intended for offline preview, not real-time processing.
    pub fn preview(&self, preview_duration: f32) -> Vec<f32> {
        let total_samples = (self.sample_rate * preview_duration).ceil() as usize;
        let mut preview_values = Vec::with_capacity(total_samples);

        // Use a temporary envelope instance for simulation
        let mut sim_env = Envelope::new(self.sample_rate, self.config.clone());
        sim_env.trigger(true); // Start with gate on

        let hold_duration = self.config.attack + self.config.decay + 0.5; // Duration before gate off

        for i in 0..total_samples {
            let t = i as f32 * sim_env.sample_rate_recip;

            // Simulate gate-off after hold duration
            if t >= hold_duration && sim_env.last_gate_value > 0.0 {
                sim_env.trigger(false);
            }

            // Process sample with no modulation for preview
            let value = sim_env.process_sample(0.0, 1.0);
            preview_values.push(value);
        }
        preview_values
    }
}

// Implement the trait for the struct
impl ModulationProcessor for Envelope {}

impl AudioNode for Envelope {
    fn get_ports(&self) -> FxHashMap<PortId, bool> {
        [
            (PortId::CombinedGate, false), // Input for gate signal
            (PortId::AttackMod, false),    // Input for attack time modulation
            (PortId::AudioOutput0, true),  // Output envelope value
        ]
        .iter()
        .cloned()
        .collect()
    }

    fn process(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // --- 0) Early exit and Buffer Preparation ---
        if !self.config.active {
            // Use config active flag now
            if let Some(output_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                output_buffer[..buffer_size].fill(0.0);
            }
            return;
        }

        self.ensure_scratch_buffers(buffer_size);

        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buffer) => buffer,
            None => return,
        };

        // --- 1) Process Gate Input ---
        // Assuming gate is primarily additive and doesn't need complex modulation processing.
        // Directly sum sources into gate_buffer. If transforms/types were needed, use full modulation path.
        self.gate_buffer[..buffer_size].fill(0.0); // Reset buffer
        if let Some(gate_sources) = inputs.get(&PortId::CombinedGate) {
            for source in gate_sources {
                // Apply source buffer additively (respecting amount and transform)
                Self::apply_add(
                    &source.buffer,
                    &mut self.gate_buffer[..buffer_size],
                    source.amount,
                    source.transformation,
                );
            }
        }

        // --- 2) Process Attack Modulation Input ---
        let attack_mod_sources = inputs.get(&PortId::AttackMod);
        if attack_mod_sources.map_or(false, |s| !s.is_empty()) {
            // Accumulate modulation into shared scratch buffers
            Self::accumulate_modulations_inplace(
                buffer_size,
                attack_mod_sources.map(|v| v.as_slice()),
                &mut self.mod_scratch_add,
                &mut self.mod_scratch_mult,
            );
            // Copy results to dedicated attack scratch buffers
            self.scratch_attack_add[..buffer_size]
                .copy_from_slice(&self.mod_scratch_add[..buffer_size]);
            self.scratch_attack_mult[..buffer_size]
                .copy_from_slice(&self.mod_scratch_mult[..buffer_size]);
        } else {
            // No attack modulation, set defaults (0.0 additive, 1.0 multiplicative)
            self.scratch_attack_add[..buffer_size].fill(0.0);
            self.scratch_attack_mult[..buffer_size].fill(1.0);
        }

        // --- 3) Main Processing Loop (Sample by Sample) ---
        // Envelope state is inherently sequential, so process sample-by-sample.
        for i in 0..buffer_size {
            // Determine gate state for this sample (simple threshold)
            let current_gate_on = self.gate_buffer[i] > 0.0; // Or use a small threshold like 0.01?

            // Check for gate changes and trigger state transitions
            self.trigger(current_gate_on);

            // Get modulated attack parameters for this sample
            let attack_mod_add = self.scratch_attack_add[i];
            let attack_mod_mul = self.scratch_attack_mult[i];

            // Process the envelope state machine for one sample
            let current_value = self.process_sample(attack_mod_add, attack_mod_mul);

            // Write the output value
            output_buffer[i] = current_value;
        }

        // The SIMD block from the original code was mainly for input/output copying,
        // which is less relevant now that processing is sample-by-sample due to statefulness.
        // If writing the output was found to be a bottleneck, a SIMD write could be reintroduced
        // after the scalar loop, but it's unlikely to be the main cost here.
    }

    fn reset(&mut self) {
        self.phase = EnvelopePhase::Idle;
        self.value = 0.0;
        self.release_level = 0.0;
        self.position = 0.0;
        self.last_gate_value = 0.0;
        self.smoothing_counter = 0;
        self.pre_attack_value = 0.0;
        // Scratch buffers get reset/overwritten at the start of process
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    // Use the config field for the node's active state
    fn is_active(&self) -> bool {
        self.config.active
    }

    fn set_active(&mut self, active: bool) {
        self.config.active = active;
        if !active {
            self.reset(); // Reset state when deactivated
        }
    }

    fn node_type(&self) -> &str {
        "envelope"
    }
}
