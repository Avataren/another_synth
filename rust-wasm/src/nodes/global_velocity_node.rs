use core::simd::Simd;
use std::any::Any;
use std::collections::HashMap;

use crate::graph::ModulationSource;
use crate::{AudioNode, PortId}; // Assume this trait exists

/// GlobalVelocityNode encapsulates the velocity buffer.
pub struct GlobalVelocityNode {
    base_velocity: Vec<f32>,
}

impl GlobalVelocityNode {
    pub fn new(initial_freq: f32, buffer_size: usize) -> Self {
        Self {
            base_velocity: vec![initial_freq; buffer_size],
        }
    }

    /// Updates the base frequency buffer (for example, from host automation).
    pub fn set_velocity(&mut self, velocity: &[f32]) {
        if velocity.len() == 1 {
            // Fill the entire buffer with the single frequency value.
            self.base_velocity.fill(velocity[0]);
        } else if velocity.len() == self.base_velocity.len() {
            self.base_velocity.copy_from_slice(velocity);
        } else {
            // Optionally, handle the case where a differently sized buffer is provided.
            // For now, fill the existing buffer.
            self.base_velocity.fill(velocity[0]);
        }
    }
}

impl AudioNode for GlobalVelocityNode {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        // This node outputs the global frequency signal.
        ports.insert(PortId::GlobalVelocity, true);
        ports
    }

    fn process(
        &mut self,
        _inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Get the output buffer for the global frequency.
        let output = outputs
            .get_mut(&PortId::GlobalVelocity)
            .expect("Expected GlobalVelocity output port");

        // If no modulation is applied, we can optimize using SIMD.
        const LANES: usize = 4;
        type Vf32 = Simd<f32, LANES>;
        let mut i = 0;
        while i + LANES <= buffer_size {
            let result = Vf32::from_slice(&self.base_velocity[i..i + LANES]);
            output[i..i + LANES].copy_from_slice(&result.to_array());
            i += LANES;
        }
    }

    fn reset(&mut self) {
        // No dynamic state to reset for this node.
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn is_active(&self) -> bool {
        true
    }
    fn set_active(&mut self, _active: bool) {
        // Always active.
    }
    fn node_type(&self) -> &str {
        "global_velocity"
    }
}
