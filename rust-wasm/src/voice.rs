use crate::{
    nodes::{Lfo, LfoTriggerMode},
    AudioGraph, Envelope, MacroManager, ModulatableOscillator, ModulationTarget, NodeId, PortId,
};

#[derive(Debug)]
pub struct Voice {
    pub id: usize,
    pub graph: AudioGraph,
    pub output_node: NodeId,

    // Voice state
    pub current_gate: f32,
    pub current_frequency: f32,
    pub active: bool,
    macro_manager: MacroManager,
    pub oscillators: Vec<NodeId>,
    pub envelope: NodeId,
}

impl Voice {
    pub fn new(id: usize) -> Self {
        let buffer_size = 128;
        let mut graph = AudioGraph::new(buffer_size); // Pass sample_rate to graph
        let macro_manager = MacroManager::new(4, &mut graph.buffer_pool, buffer_size);
        let output_node = NodeId(0);
        graph.set_output_node(output_node);

        Self {
            id,
            graph,
            output_node,
            current_gate: 0.0,
            current_frequency: 440.0,
            active: false,
            macro_manager,
            oscillators: Vec::new(),
            envelope: NodeId(0),
        }
    }

    pub fn clear(&mut self) {
        // Clear the graph
        self.graph.clear();

        // Clear stored node references
        self.oscillators.clear();
        self.envelope = NodeId(0);
        self.output_node = NodeId(0);

        // Reset state
        self.current_gate = 0.0;
        self.current_frequency = 440.0;
        self.active = false;

        // Clear macro manager
        self.macro_manager.clear(&mut self.graph.buffer_pool);
    }

    pub fn set_output_node(&mut self, node: NodeId) {
        self.output_node = node;
        self.graph.set_output_node(node);
    }

    pub fn add_oscillator(&mut self, sample_rate: f32) -> NodeId {
        let osc = ModulatableOscillator::new(sample_rate);
        let osc_id = self.graph.add_node(Box::new(osc));
        self.oscillators.push(osc_id);
        osc_id
    }

    //todo: we'll still need to update some nodes I think, like LFOs without a trigger state
    // as they should evolve independently of the gain amplitude
    pub fn update_active_state(&mut self) {
        self.active = self.current_gate > 0.0 || self.has_active_envelopes();
    }

    //this doesn't quite work yet, dont use
    pub fn has_active_lfos(&self) -> bool {
        self.graph.nodes.iter().any(|node| {
            if let Some(lfo) = node.as_any().downcast_ref::<Lfo>() {
                lfo.is_active()
            } else {
                false
            }
        })
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
        // If the voice is inactive but has free-running LFOs, only update their phases
        if !self.active && self.has_free_running_lfos() {
            self.update_free_running_lfos();
        } else if self.active {
            // Normal processing path for active voices
            self.graph.set_gate(&[self.current_gate]);
            self.graph.set_frequency(&[self.current_frequency]);
            self.graph.process_audio_with_macros(
                Some(&self.macro_manager),
                output_left,
                output_right,
            );
        }

        self.update_active_state();
    }

    // New helper method to check for free-running LFOs
    fn has_free_running_lfos(&self) -> bool {
        self.graph.nodes.iter().any(|node| {
            if let Some(lfo) = node.as_any().downcast_ref::<Lfo>() {
                lfo.trigger_mode == LfoTriggerMode::None
            } else {
                false
            }
        })
    }

    // New method to only update LFO phases
    fn update_free_running_lfos(&mut self) {
        for node in &mut self.graph.nodes {
            if let Some(lfo) = node.as_any_mut().downcast_mut::<Lfo>() {
                if lfo.trigger_mode == LfoTriggerMode::None {
                    // Only advance the phase
                    lfo.advance_phase();
                }
            }
        }
    }
}
