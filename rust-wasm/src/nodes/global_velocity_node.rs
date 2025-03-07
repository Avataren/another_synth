use core::simd::Simd;
use std::any::Any;
use std::collections::HashMap;

use crate::graph::ModulationSource;
use crate::impulse_generator::js_fallback_fill;
use crate::{AudioNode, PortId};
use getrandom::fill;

pub struct GlobalVelocityNode {
    base_velocity: Vec<f32>,
    sensitivity: f32,
    /// Interpolation factor between base_velocity and the random value.
    /// 0.0 means no randomization; 1.0 means fully using the random value.
    randomize: f32,
    /// Precomputed random numbers (each in [0, 1]).
    random_numbers: Vec<f32>,
    /// Index into the random_numbers vector.
    random_index: usize,
    /// The current random value, updated on gate events.
    current_random_value: f32,
    /// Holds the previous gate value to detect rising edges.
    prev_gate_value: f32,
}

impl GlobalVelocityNode {
    pub fn new(initial_freq: f32, buffer_size: usize) -> Self {
        // Precompute 1024 random numbers.
        let num_random = 1024;
        let mut random_numbers = vec![0f32; num_random];
        // 4 bytes per f32.
        let mut buf = vec![0u8; num_random * 4];
        if let Err(e) = fill(&mut buf) {
            js_fallback_fill(&mut buf).expect(&format!(
                "Fallback for random number generation failed: {}",
                e
            ));
        }
        for i in 0..num_random {
            let start = i * 4;
            let bytes = [buf[start], buf[start + 1], buf[start + 2], buf[start + 3]];
            let num = u32::from_le_bytes(bytes);
            random_numbers[i] = (num as f32) / (u32::MAX as f32);
        }

        Self {
            base_velocity: vec![initial_freq; buffer_size],
            sensitivity: 1.0,
            randomize: 0.0, // default: no randomization
            random_numbers,
            random_index: 0,
            // Initialize with the first random number.
            current_random_value: 0.0,
            prev_gate_value: 0.0,
        }
    }

    pub fn set_velocity(&mut self, velocity: &[f32]) {
        if velocity.len() == 1 {
            self.base_velocity.fill(velocity[0]);
        } else if velocity.len() == self.base_velocity.len() {
            self.base_velocity.copy_from_slice(velocity);
        } else {
            self.base_velocity.fill(velocity[0]);
        }
    }

    pub fn set_sensitivity(&mut self, sensitivity: f32) {
        self.sensitivity = sensitivity;
    }

    /// Sets the randomization amount (0.0 to 1.0).
    pub fn set_randomize(&mut self, randomize: f32) {
        self.randomize = randomize.clamp(0.0, 1.0);
    }
}

impl AudioNode for GlobalVelocityNode {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::AudioOutput0, true);
        // Declare a gate port. The false value indicates it isn't an audio output.
        ports.insert(PortId::Gate, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        let output = outputs
            .get_mut(&PortId::AudioOutput0)
            .expect("Expected AudioOutput0 output port");

        // Build the gate buffer from all gate sources.
        let mut gate_buffer = vec![0.0; buffer_size];
        if let Some(sources) = inputs.get(&PortId::Gate) {
            for source in sources {
                for (dest, &src) in gate_buffer.iter_mut().zip(source.buffer.iter()) {
                    *dest += src * source.amount;
                }
            }
        }

        let exp = 1.0 / self.sensitivity;
        let rnd_len = self.random_numbers.len();

        for i in 0..buffer_size {
            let gate_val = gate_buffer[i];
            // Determine if the gate is on (using 0.5 as threshold).
            let gate_on = gate_val > 0.5;
            let prev_gate_on = self.prev_gate_value > 0.5;
            // Detect rising edge: current gate is on, but previous was off.
            if gate_on && !prev_gate_on {
                // Update the random value.
                self.random_index = (self.random_index + 1) % rnd_len;
                self.current_random_value = self.random_numbers[self.random_index];
            }
            // Update previous gate value.
            self.prev_gate_value = gate_val;

            let base_val = self.base_velocity[i];
            // Interpolate between base velocity and the current random value.
            let mixed =
                (1.0 - self.randomize) * base_val + self.randomize * self.current_random_value;
            // Apply the sensitivity curve if needed.
            let result = if (self.sensitivity - 1.0).abs() < 1e-5 {
                mixed
            } else {
                mixed.powf(exp)
            };
            // Clamp the output to guarantee the value stays in [0, 1].
            output[i] = result.clamp(0.0, 1.0);
        }
    }

    fn reset(&mut self) {}
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn is_active(&self) -> bool {
        true
    }
    fn set_active(&mut self, _active: bool) {}
    fn node_type(&self) -> &str {
        "global_velocity"
    }
}
