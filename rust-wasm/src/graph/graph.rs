use super::{
    buffer_pool::AudioBufferPool,
    types::{Connection, ConnectionId, NodeId},
};
use crate::{AudioNode, PortId};
use std::collections::HashMap;

pub struct AudioGraph {
    // Change from HashMap to Vec for nodes
    pub(crate) nodes: Vec<Box<dyn AudioNode>>,
    pub(crate) connections: HashMap<ConnectionId, Connection>,
    pub(crate) processing_order: Vec<usize>, // Changed from NodeId to direct indices
    pub(crate) buffer_size: usize,
    pub(crate) buffer_pool: AudioBufferPool,
    pub(crate) node_buffers: HashMap<(NodeId, PortId), usize>,
    pub(crate) gate_buffer_idx: usize,
    pub(crate) freq_buffer_idx: usize,
    pub(crate) input_connections: HashMap<NodeId, Vec<(PortId, usize, f32)>>,
    pub(crate) temp_buffer_indices: Vec<usize>,
}

impl AudioGraph {
    pub fn new(buffer_size: usize) -> Self {
        let mut buffer_pool = AudioBufferPool::new(buffer_size, 32);
        let gate_buffer_idx = buffer_pool.acquire(buffer_size);
        let freq_buffer_idx = buffer_pool.acquire(buffer_size);

        Self {
            nodes: Vec::new(),
            connections: HashMap::new(),
            processing_order: Vec::new(),
            buffer_size,
            buffer_pool,
            node_buffers: HashMap::new(),
            gate_buffer_idx,
            freq_buffer_idx,
            input_connections: HashMap::new(),
            temp_buffer_indices: Vec::new(),
        }
    }

    pub fn add_node(&mut self, node: Box<dyn AudioNode>) -> NodeId {
        let id = NodeId(self.nodes.len());

        // Allocate buffers for each port
        for (port, _) in node.get_ports() {
            let buffer_idx = self.buffer_pool.acquire(self.buffer_size);
            self.node_buffers.insert((id, port), buffer_idx);
        }

        self.nodes.push(node);
        self.update_processing_order();
        id
    }

    pub fn connect(&mut self, connection: Connection) -> ConnectionId {
        let id = ConnectionId(self.connections.len());
        self.connections.insert(id, connection.clone());

        // Update input connection mapping
        let source_buffer_idx = self.node_buffers[&(connection.from_node, connection.from_port)];
        self.input_connections
            .entry(connection.to_node)
            .or_default()
            .push((connection.to_port, source_buffer_idx, connection.amount));

        self.update_processing_order();
        id
    }

    pub fn get_node_mut(&mut self, node_id: NodeId) -> Option<&mut Box<dyn AudioNode>> {
        self.nodes.get_mut(node_id.0)
    }

    fn has_audio_inputs(&self, node_id: NodeId) -> bool {
        self.connections
            .values()
            .any(|conn| conn.to_node == node_id && conn.to_port.is_audio_input())
    }

    fn update_processing_order(&mut self) {
        self.processing_order.clear();
        let mut visited = vec![false; self.nodes.len()];

        // First visit nodes with no audio inputs
        for i in 0..self.nodes.len() {
            let node_id = NodeId(i);
            if !visited[i] && !self.has_audio_inputs(node_id) {
                self.visit_node(i, &mut visited);
            }
        }

        // Then visit any remaining unvisited nodes
        for i in 0..self.nodes.len() {
            if !visited[i] {
                self.visit_node(i, &mut visited);
            }
        }
    }

    fn visit_node(&mut self, index: usize, visited: &mut [bool]) {
        if visited[index] {
            return;
        }

        visited[index] = true;

        let node_id = NodeId(index);
        let upstream_nodes: Vec<usize> = self
            .connections
            .values()
            .filter(|conn| conn.to_node == node_id)
            .map(|conn| conn.from_node.0)
            .collect();

        for &next_node in &upstream_nodes {
            if !visited[next_node] {
                self.visit_node(next_node, visited);
            }
        }

        self.processing_order.push(index);
    }

    pub fn set_gate(&mut self, gate: &[f32]) {
        if gate.len() == 1 {
            self.buffer_pool.fill(self.gate_buffer_idx, gate[0]);
        } else {
            self.buffer_pool.copy_in(self.gate_buffer_idx, gate);
        }
    }

    pub fn set_frequency(&mut self, freq: &[f32]) {
        if freq.len() == 1 {
            self.buffer_pool.fill(self.freq_buffer_idx, freq[0]);
        } else {
            self.buffer_pool.copy_in(self.freq_buffer_idx, freq);
        }
    }

    pub fn process_audio(&mut self, output_left: &mut [f32], output_right: &mut [f32]) {
        // Clear all node output buffers
        for &buffer_idx in self.node_buffers.values() {
            self.buffer_pool.clear(buffer_idx);
        }

        // Ensure we have enough temporary buffers
        let max_ports_per_node = self
            .nodes
            .iter()
            .map(|node| node.get_ports().len())
            .max()
            .unwrap_or(0);

        // Acquire temporary buffers as needed
        while self.temp_buffer_indices.len() < max_ports_per_node {
            let buffer_idx = self.buffer_pool.acquire(self.buffer_size);
            self.temp_buffer_indices.push(buffer_idx);
        }

        // Process nodes in order
        for &node_idx in &self.processing_order {
            let node = &mut self.nodes[node_idx];
            let node_id = NodeId(node_idx);
            let ports = node.get_ports();

            // First, collect all the input data into temporary vectors
            let mut input_buffers = Vec::new();

            // Handle gate and frequency inputs
            if ports.contains_key(&PortId::Gate) {
                let gate_data = self.buffer_pool.copy_out(self.gate_buffer_idx).to_vec();
                input_buffers.push((PortId::Gate, gate_data));
            }

            if ports.contains_key(&PortId::Frequency) {
                let freq_data = self.buffer_pool.copy_out(self.freq_buffer_idx).to_vec();
                input_buffers.push((PortId::Frequency, freq_data));
            }

            // Process connected inputs
            if let Some(connections) = self.input_connections.get(&node_id) {
                for &(port, source_idx, amount) in connections {
                    let source_data = self.buffer_pool.copy_out(source_idx).to_vec();
                    let mut input_data = vec![0.0; self.buffer_size];

                    if amount == 1.0 {
                        input_data.copy_from_slice(&source_data);
                    } else {
                        for (out, &inp) in input_data.iter_mut().zip(source_data.iter()) {
                            *out = inp * amount;
                        }
                    }

                    input_buffers.push((port, input_data));
                }
            }

            // Create input map from collected data
            let mut input_map = HashMap::new();
            for (port, buffer) in &input_buffers {
                input_map.insert(*port, buffer.as_slice());
            }

            // Get output buffer indices
            let output_indices: Vec<usize> = ports
                .iter()
                .filter(|(_, &is_output)| is_output)
                .filter_map(|(&port, _)| self.node_buffers.get(&(node_id, port)).copied())
                .collect();

            // Get all output buffers mutably at once
            let output_buffers = self.buffer_pool.get_multiple_buffers_mut(&output_indices);

            // Create output map with mutable references
            let mut output_refs: HashMap<PortId, &mut [f32]> = HashMap::new();
            for (idx, buffer) in output_buffers {
                if let Some((&(_, port), _)) = self
                    .node_buffers
                    .iter()
                    .find(|((n, _), &i)| *n == node_id && i == idx)
                {
                    output_refs.insert(port, buffer);
                }
            }

            // Process the node
            node.process(&input_map, &mut output_refs, self.buffer_size);
        }

        // Copy final output
        if let Some(&final_idx) = self.processing_order.last() {
            let final_node = NodeId(final_idx);
            if let Some(&buffer_idx) = self.node_buffers.get(&(final_node, PortId::AudioOutput0)) {
                let final_buffer = self.buffer_pool.copy_out(buffer_idx);
                output_left.copy_from_slice(final_buffer);
                output_right.copy_from_slice(final_buffer);
            }
        }
    }
}

impl Drop for AudioGraph {
    fn drop(&mut self) {
        // Clean up all allocated buffers
        for &buffer_idx in self.node_buffers.values() {
            self.buffer_pool.release(buffer_idx);
        }
        for &buffer_idx in &self.temp_buffer_indices {
            self.buffer_pool.release(buffer_idx);
        }
        self.buffer_pool.release(self.gate_buffer_idx);
        self.buffer_pool.release(self.freq_buffer_idx);
    }
}
