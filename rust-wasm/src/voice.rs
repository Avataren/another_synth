use crate::{
    AudioGraph, Connection, Envelope, EnvelopeConfig, MacroManager, ModulatableOscillator,
    ModulationTarget, NodeId, PortId,
};

#[derive(Debug)]
pub struct Voice {
    pub id: usize,
    sample_rate: f32,
    pub graph: AudioGraph,
    pub oscillator_id: NodeId,
    pub envelope_id: NodeId,

    // Voice state
    pub current_gate: f32,
    pub current_frequency: f32,
    pub current_gain: f32,
    pub active: bool,
    macro_manager: MacroManager,
}

impl Voice {
    pub fn new(id: usize, sample_rate: f32, envelope_config: EnvelopeConfig) -> Self {
        let buffer_size = 128;
        let mut graph = AudioGraph::new(buffer_size);

        // Create and initialize macro manager
        let macro_manager = MacroManager::new(4, &mut graph.buffer_pool, buffer_size);

        let oscillator_id = graph.add_node(Box::new(ModulatableOscillator::new(sample_rate)));
        let envelope_id = {
            let env = Box::new(Envelope::new(sample_rate, envelope_config));
            graph.add_node(env)
        };

        graph.connect(Connection {
            from_node: envelope_id,
            from_port: PortId::AudioOutput0,
            to_node: oscillator_id,
            to_port: PortId::GainMod,
            amount: 1.0,
        });

        Self {
            id,
            sample_rate,
            graph,
            oscillator_id,
            envelope_id,
            current_gate: 0.0,
            current_frequency: 440.0,
            current_gain: 1.0,
            active: false,
            macro_manager,
        }
    }

    pub fn clear_macros(&mut self) {
        self.macro_manager.clear();
    }

    pub fn update_active_state(&mut self) {
        if let Some(node) = self.graph.get_node(self.envelope_id) {
            if let Some(env) = node.as_any().downcast_ref::<Envelope>() {
                // Voice is active if gate is high or envelope is still producing sound
                self.active = self.current_gate > 0.0 || env.is_active();
            }
        }
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
    pub fn get_current_gain(&self) -> f32 {
        self.current_gain
    }

    pub fn update_macro(&mut self, macro_index: usize, values: &[f32]) -> Result<(), String> {
        self.macro_manager.update_macro(macro_index, values)
    }

    pub fn add_macro_modulation(
        &mut self,
        macro_index: usize,
        target_node: NodeId,
        target_port: PortId,
        amount: f32,
    ) -> Result<(), String> {
        self.macro_manager.add_modulation(
            macro_index,
            ModulationTarget {
                node_id: target_node,
                port_id: target_port,
                amount,
            },
        )
    }

    pub fn process_audio(&mut self, output_left: &mut [f32], output_right: &mut [f32]) {
        use web_sys::console;

        // First, ensure all gates and frequencies are set
        self.graph.set_gate(&[self.current_gate]);
        self.graph.set_frequency(&[self.current_frequency]);

        // Process audio with optional macro support
        if self.macro_manager.has_active_macros() {
            self.graph.process_audio_with_macros(
                Some(&self.macro_manager),
                output_left,
                output_right,
            );
        } else {
            self.graph.process_audio(output_left, output_right);
        }

        // Update voice state after processing
        self.update_active_state();
    }
}
