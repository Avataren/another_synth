use core::simd::Simd;
use std::any::Any;
use std::collections::HashMap;

use crate::graph::ModulationSource;
use crate::{AudioNode, PortId}; // Assume this trait exists

/// GlobalVelocityNode encapsulates the velocity buffer.
pub struct GlobalVelocityNode {
    base_velocity: Vec<f32>,
    /// A sensitivity factor: 1.0 is linear.
    /// Values lower than 1.0 result in a less sensitive response (e.g. 0.5 -> exponent 2.0).
    /// Values greater than 1.0 result in a more sensitive response.
    sensitivity: f32,
}

impl GlobalVelocityNode {
    pub fn new(initial_freq: f32, buffer_size: usize) -> Self {
        Self {
            base_velocity: vec![initial_freq; buffer_size],
            sensitivity: 1.5,
        }
    }

    /// Updates the base frequency buffer (for example, from host automation).
    pub fn set_velocity(&mut self, velocity: &[f32]) {
        if velocity.len() == 1 {
            self.base_velocity.fill(velocity[0]);
        } else if velocity.len() == self.base_velocity.len() {
            self.base_velocity.copy_from_slice(velocity);
        } else {
            self.base_velocity.fill(velocity[0]);
        }
    }

    /// Sets the sensitivity parameter.
    pub fn set_sensitivity(&mut self, sensitivity: f32) {
        self.sensitivity = sensitivity;
    }
}

impl AudioNode for GlobalVelocityNode {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::AudioOutput0, true);
        ports
    }

    fn process(
        &mut self,
        _inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        let output = outputs
            .get_mut(&PortId::AudioOutput0)
            .expect("Expected AudioOutput0 output port");

        // For linear mapping, we can simply copy the buffer.
        if (self.sensitivity - 1.0).abs() < 1e-5 {
            const LANES: usize = 4;
            type Vf32 = Simd<f32, LANES>;
            let mut i = 0;
            while i + LANES <= buffer_size {
                let result = Vf32::from_slice(&self.base_velocity[i..i + LANES]);
                output[i..i + LANES].copy_from_slice(&result.to_array());
                i += LANES;
            }
            while i < buffer_size {
                output[i] = self.base_velocity[i];
                i += 1;
            }
        } else {
            // Apply the sensitivity curve: output = velocity^(1/sensitivity)
            let exp = 1.0 / self.sensitivity;
            for i in 0..buffer_size {
                output[i] = self.base_velocity[i].powf(exp);
            }
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
