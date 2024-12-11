use crate::{
    AudioGraph, AudioNode, Connection, Envelope, EnvelopeConfig, ModulatableOscillator, NodeId,
    PortId,
};

#[derive(Debug)]
pub struct Voice {
    pub id: usize,
    #[allow(dead_code)]
    sample_rate: f32,
    pub graph: AudioGraph,
    pub oscillator_id: NodeId,
    pub envelope_id: NodeId,

    // Voice state
    pub current_gate: f32,
    pub current_frequency: f32,
    pub current_gain: f32,
    pub active: bool,
}

impl Voice {
    pub fn new(id: usize, sample_rate: f32, envelope_config: EnvelopeConfig) -> Self {
        let buffer_size = 128;
        let mut graph = AudioGraph::new(buffer_size);

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
        }
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
}
