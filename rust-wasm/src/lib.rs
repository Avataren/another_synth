// src/lib.rs
#![feature(portable_simd)]

mod audio;
mod graph;
mod nodes;
mod processing;
mod traits;
mod utils;
pub use graph::{Connection, ConnectionId, NodeId};
pub use nodes::EnvelopeConfig;
// Be more specific with exports to avoid conflicts
pub use graph::AudioGraph;
pub use nodes::{Envelope, ModulatableOscillator};
pub use traits::{AudioNode, PortId};
pub use utils::*; // Add this export

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct AudioProcessor {
    graph: AudioGraph,
    sample_rate: f32,
}

#[wasm_bindgen]
impl AudioProcessor {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        let sample_rate = 44100.0;
        Self {
            graph: AudioGraph::new(128),
            sample_rate,
        }
    }

    #[wasm_bindgen]
    pub fn init(&mut self, sample_rate: f32) {
        self.sample_rate = sample_rate;
        self.graph = AudioGraph::new(128);
    }

    #[wasm_bindgen]
    pub fn process_audio(
        &mut self,
        gate: &[f32],
        frequency_param: &[f32],
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        self.graph.set_gate(gate);
        self.graph.set_frequency(frequency_param);
        self.graph.process_audio(output_left, output_right);
    }

    //todo dereference NodeId and return usize instead!
    #[wasm_bindgen]
    pub fn add_envelope(&mut self) -> NodeId {
        let env = Box::new(Envelope::new(self.sample_rate, EnvelopeConfig::default()));
        self.graph.add_node(env)
    }

    //todo dereference NodeId and return usize instead!
    #[wasm_bindgen]
    pub fn add_oscillator(&mut self) -> NodeId {
        let osc = Box::new(ModulatableOscillator::new(self.sample_rate));
        self.graph.add_node(osc)
    }

    #[wasm_bindgen]
    pub fn connect_nodes(
        &mut self,
        from_node: NodeId,
        from_port: PortId,
        to_node: NodeId,
        to_port: PortId,
        amount: f32,
    ) -> ConnectionId {
        let connection = Connection {
            from_node,
            from_port,
            to_node,
            to_port,
            amount,
        };
        self.graph.connect(connection)
    }

    #[wasm_bindgen]
    pub fn update_envelope(
        &mut self,
        node_id: NodeId,
        attack: f32,
        decay: f32,
        sustain: f32,
        release: f32,
    ) -> Result<(), String> {
        if let Some(node) = self.graph.get_node_mut(node_id) {
            if let Some(env) = node.as_any_mut().downcast_mut::<Envelope>() {
                let mut config = EnvelopeConfig::default();
                config.attack = attack;
                config.decay = decay;
                config.sustain = sustain;
                config.release = release;
                env.update_config(config);
                Ok(())
            } else {
                Err("Node is not an Envelope".to_string())
            }
        } else {
            Err("Node not found".to_string())
        }
    }
}
