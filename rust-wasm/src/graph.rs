use std::collections::HashMap;
use wasm_bindgen::prelude::*;
// use web_sys;

#[wasm_bindgen]
extern "C" {
    #[wasm_bindgen(js_namespace = console)]
    fn log(s: &str);
}

use crate::{AudioNode, PortId};

#[wasm_bindgen]
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId(pub usize);

#[wasm_bindgen]
impl NodeId {
    pub fn as_number(&self) -> usize {
        self.0
    }
    pub fn from_number(value: usize) -> NodeId {
      NodeId(value)
  }
}

#[wasm_bindgen]
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct ConnectionId(pub usize);

pub struct Connection {
    pub from_node: NodeId,
    pub from_port: PortId,
    pub to_node: NodeId,
    pub to_port: PortId,
    pub amount: f32,
}


pub struct AudioGraph {
    pub nodes: HashMap<NodeId, Box<dyn AudioNode>>,
    connections: HashMap<ConnectionId, Connection>,
    processing_order: Vec<NodeId>,
    buffer_size: usize,
    sample_rate: f32,
    buffers: HashMap<(NodeId, PortId), Vec<f32>>,
    gate_buffer: Vec<f32>,
    freq_buffer: Vec<f32>,
}

impl AudioGraph {
    pub fn new(buffer_size: usize, sample_rate: f32) -> Self {
        Self {
            nodes: HashMap::new(),
            connections: HashMap::new(),
            processing_order: Vec::new(),
            buffer_size,
            sample_rate,
            buffers: HashMap::new(),
            gate_buffer: vec![0.0; buffer_size],
            freq_buffer: vec![0.0; buffer_size],
        }
    }

    pub fn get_node_mut(&mut self, node_id: NodeId) -> Option<&mut Box<dyn AudioNode>> {
        self.nodes.get_mut(&node_id)
    }

    pub fn add_node(&mut self, node: Box<dyn AudioNode>) -> NodeId {
        let id = NodeId(self.nodes.len());

        for (port, _) in node.get_ports() {
            self.buffers.insert((id, port), vec![0.0; self.buffer_size]);
        }

        self.nodes.insert(id, node);
        self.update_processing_order();
        id
    }

    pub fn connect(&mut self, connection: Connection) -> ConnectionId {
        let id = ConnectionId(self.connections.len());
        self.connections.insert(id, connection);
        self.update_processing_order();
        id
    }

    pub fn set_gate(&mut self, gate: &[f32]) {
        if gate.len() == 1 {
            self.gate_buffer.fill(gate[0]);
        } else {
            self.gate_buffer[..gate.len()].copy_from_slice(gate);
        }
    }

    pub fn set_frequency(&mut self, freq: &[f32]) {
        if freq.len() == 1 {
            self.freq_buffer.fill(freq[0]);
        } else {
            self.freq_buffer[..freq.len()].copy_from_slice(freq);
        }
    }

    fn update_processing_order(&mut self) {
      self.processing_order.clear();
      let mut visited = HashMap::new();

      // Debug print
      web_sys::console::log_1(&format!("Updating processing order. Current connections: {:?}",
          self.connections.values().map(|c| format!("{:?}->{:?}", c.from_node.0, c.to_node.0))
          .collect::<Vec<_>>()
      ).into());

      let nodes: Vec<NodeId> = self.nodes.keys().copied().collect();

      for &node_id in &nodes {
          visited.insert(node_id, false);
      }

      for &node_id in &nodes {
          if !visited[&node_id] && !self.has_audio_inputs(node_id) {
              self.visit_node(node_id, &mut visited);
          }
      }

      // Debug print
      web_sys::console::log_1(&format!("New processing order: {:?}",
          self.processing_order.iter().map(|n| n.0).collect::<Vec<_>>()
      ).into());
  }


    fn has_audio_inputs(&self, node_id: NodeId) -> bool {
        self.connections.values().any(|conn| {
            conn.to_node == node_id && conn.to_port.is_audio_input()
        })
    }

    fn visit_node(&mut self, node_id: NodeId, visited: &mut HashMap<NodeId, bool>) {
      if visited[&node_id] {
          return;
      }

      visited.insert(node_id, true);

      // First visit all upstream nodes (nodes that feed into this one)
      let upstream_nodes: Vec<NodeId> = self.connections.values()
          .filter(|conn| conn.to_node == node_id)
          .map(|conn| conn.from_node)
          .collect();

      for next_node in upstream_nodes {
          if !visited[&next_node] {
              self.visit_node(next_node, visited);
          }
      }

      // Then add this node to the processing order
      self.processing_order.push(node_id);
  }

  pub fn process_audio(&mut self, output_left: &mut [f32], output_right: &mut [f32]) {
    for buffer in self.buffers.values_mut() {
        buffer.fill(0.0);
    }

    for node_id in self.processing_order.clone() {

        let mut input_buffers: HashMap<PortId, Vec<f32>> = HashMap::new();

        if let Some(node) = self.nodes.get(&node_id) {
            let ports = node.get_ports();

            if ports.contains_key(&PortId::Gate) {
                input_buffers.insert(PortId::Gate, self.gate_buffer.clone());
            }
            if ports.contains_key(&PortId::Frequency) {
                input_buffers.insert(PortId::Frequency, self.freq_buffer.clone());
            }
        }

        for connection in self.connections.values() {
            if connection.to_node == node_id {
                if let Some(buffer) = self.buffers.get(&(connection.from_node, connection.from_port)) {
                    input_buffers.insert(connection.to_port, buffer.clone());
                }
            }
        }

        let input_slices: HashMap<PortId, &[f32]> = input_buffers
            .iter()
            .map(|(&port, buf)| (port, buf.as_slice()))
            .collect();

        let mut output_buffers: HashMap<PortId, Vec<f32>> = HashMap::new();

        if let Some(node) = self.nodes.get(&node_id) {
            for (&port, &required) in &node.get_ports() {
                if required {
                    output_buffers.insert(port, vec![0.0; self.buffer_size]);
                }
            }
        }

        let mut output_slices: HashMap<PortId, &mut [f32]> = output_buffers
            .iter_mut()
            .map(|(&port, buf)| (port, buf.as_mut_slice()))
            .collect();

        if let Some(node) = self.nodes.get_mut(&node_id) {
            node.process(&input_slices, &mut output_slices, self.buffer_size);
        }

        for (port, buffer) in output_buffers {
            if let Some(main_buffer) = self.buffers.get_mut(&(node_id, port)) {
                main_buffer.copy_from_slice(&buffer);
            }
        }
    }

    if let Some(&final_node) = self.processing_order.last() {
        if let Some(final_buffer) = self.buffers.get(&(final_node, PortId::AudioOutput0)) {
            output_left.copy_from_slice(final_buffer);
            output_right.copy_from_slice(final_buffer);
        }
    }
}
}
