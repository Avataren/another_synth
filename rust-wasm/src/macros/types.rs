use crate::{graph::ModulationType, NodeId, PortId};

#[derive(Debug, Clone)]
pub struct ModulationTarget {
    pub node_id: NodeId,
    pub port_id: PortId,
    pub amount: f32,
    pub modulation_type: ModulationType,
}

#[derive(Debug)]
pub struct ModulationMacro {
    value_buffer_idx: usize,
    targets: Vec<ModulationTarget>,
}

impl ModulationMacro {
    pub fn new(buffer_idx: usize) -> Self {
        Self {
            value_buffer_idx: buffer_idx,
            targets: Vec::with_capacity(4), // Reasonable default capacity
        }
    }

    pub fn add_target(&mut self, target: ModulationTarget) {
        self.targets.push(target);
    }

    pub fn get_targets(&self) -> &[ModulationTarget] {
        &self.targets
    }

    pub fn get_value_buffer_idx(&self) -> usize {
        self.value_buffer_idx
    }
}
