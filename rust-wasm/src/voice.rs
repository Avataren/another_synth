use crate::{
    AudioGraph, Connection, Envelope, EnvelopeConfig, MacroManager, ModulatableOscillator,
    ModulationTarget, NodeId, PortId,
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
    pub fn clear_macros(&mut self) {
        self.macro_manager.clear();
    }

    pub fn update_active_state(&mut self) {
        // Update the voice's active state based on gate and envelope
        self.active = self.current_gate > 0.0 || self.has_active_envelopes();
    }

    fn has_active_envelopes(&self) -> bool {
        // Iterate through nodes to find and check envelopes
        // We could keep track of envelope IDs if needed
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
        // use web_sys::console;

        // Set the control values
        self.graph.set_gate(&[self.current_gate]);
        self.graph.set_frequency(&[self.current_frequency]);

        // Log max macro value for the first voice
        // let max_val = self.macro_manager.get_macro_max_value(0);
        // console::log_2(&"Max macro value:".into(), &max_val.into());

        // Process the audio
        self.graph
            .process_audio_with_macros(Some(&self.macro_manager), output_left, output_right);

        // Update state
        self.update_active_state();
    }

    // pub fn process_audio(&mut self, output_left: &mut [f32], output_right: &mut [f32]) {
    //     use web_sys::console;

    //     // First, ensure all gates and frequencies are set
    //     self.graph.set_gate(&[self.current_gate]);
    //     self.graph.set_frequency(&[self.current_frequency]);

    //     // Process audio with optional macro support
    //     if self.macro_manager.has_active_macros() {
    //         self.graph.process_audio_with_macros(
    //             Some(&self.macro_manager),
    //             output_left,
    //             output_right,
    //         );
    //     } else {
    //         self.graph.process_audio(output_left, output_right);
    //     }

    //     // Update voice state after processing
    //     self.update_active_state();
    // }
}
