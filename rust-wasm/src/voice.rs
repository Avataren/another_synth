use web_sys::console;

use crate::{
    AudioGraph, Envelope, EnvelopeConfig, MacroManager, ModulatableOscillator, ModulationTarget,
    NodeId, PortId,
};

#[derive(Debug)]
pub struct Voice {
    pub id: usize,
    sample_rate: f32,
    pub graph: AudioGraph,
    pub output_node: NodeId,

    // Voice state
    pub current_gate: f32,
    pub current_frequency: f32,
    pub active: bool,
    macro_manager: MacroManager,
}

impl Voice {
    pub fn new(id: usize, sample_rate: f32) -> Self {
        let buffer_size = 128;
        let mut graph = AudioGraph::new(buffer_size);
        // Create macro_manager by passing a mutable reference to graph.buffer_pool.
        // After construction, macro_manager stores only indices, not references.
        let macro_manager = MacroManager::new(4, &mut graph.buffer_pool, buffer_size);

        Self {
            id,
            sample_rate,
            graph,
            output_node: NodeId(0),
            current_gate: 0.0,
            current_frequency: 440.0,
            active: false,
            macro_manager,
        }
    }

    pub fn update_active_state(&mut self) {
        self.active = self.current_gate > 0.0 || self.has_active_envelopes();
    }

    fn has_active_envelopes(&self) -> bool {
        self.graph.nodes.iter().any(|node| {
            if let Some(env) = node.as_any().downcast_ref::<Envelope>() {
                env.is_active()
            } else {
                false
            }
        })
    }

    pub fn is_active(&self) -> bool {
        self.active
    }

    pub fn get_current_gate(&self) -> f32 {
        self.current_gate
    }

    pub fn get_current_frequency(&self) -> f32 {
        self.current_frequency
    }

    pub fn add_macro_modulation(
        &mut self,
        macro_index: usize,
        target_node: NodeId,
        target_port: PortId,
        amount: f32,
    ) -> Result<(), String> {
        // First add the modulation target to the macro manager to get the buffer
        self.macro_manager.add_modulation(
            macro_index,
            ModulationTarget {
                node_id: target_node,
                port_id: target_port,
                amount,
            },
        )?;

        // Get the buffer index that the macro manager is using
        let buffer_idx = self
            .macro_manager
            .get_macro_buffer_idx(macro_index)
            .ok_or_else(|| "Failed to get macro buffer index".to_string())?;

        // Add to input connections using the same buffer
        self.graph
            .input_connections
            .entry(target_node)
            .or_default()
            .push((target_port, buffer_idx, amount));

        Ok(())
    }

    pub fn clear_macros(&mut self) {
        self.macro_manager.clear(&mut self.graph.buffer_pool);
    }

    pub fn update_macro(&mut self, macro_index: usize, values: &[f32]) -> Result<(), String> {
        self.macro_manager
            .update_macro(macro_index, values, &mut self.graph.buffer_pool)
    }

    pub fn process_audio(&mut self, output_left: &mut [f32], output_right: &mut [f32]) {
        self.graph.set_gate(&[self.current_gate]);
        self.graph.set_frequency(&[self.current_frequency]);

        self.graph
            .process_audio_with_macros(Some(&self.macro_manager), output_left, output_right);

        self.update_active_state();
    }
}
