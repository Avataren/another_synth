use super::{
    buffer_pool::AudioBufferPool,
    types::{Connection, ConnectionId, NodeId},
};
use crate::{AudioNode, PortId};
use std::collections::HashMap;

// In graph/graph.rs
pub struct AudioGraph {
    pub(crate) nodes: HashMap<NodeId, Box<dyn AudioNode>>,
    pub(crate) connections: HashMap<ConnectionId, Connection>,
    pub(crate) processing_order: Vec<NodeId>,
    pub(crate) buffer_size: usize,
    pub(crate) buffer_pool: AudioBufferPool,
    pub(crate) node_buffers: HashMap<(NodeId, PortId), usize>,
    pub(crate) gate_buffer_idx: usize,
    pub(crate) freq_buffer_idx: usize,
}

impl AudioGraph {
    pub fn new(buffer_size: usize) -> Self {
        let mut buffer_pool = AudioBufferPool::new(buffer_size, 32); // Pre-allocate 32 buffers
        let gate_buffer_idx = buffer_pool.acquire(buffer_size);
        let freq_buffer_idx = buffer_pool.acquire(buffer_size);

        Self {
            nodes: HashMap::new(),
            connections: HashMap::new(),
            processing_order: Vec::new(),
            buffer_size,
            buffer_pool,
            node_buffers: HashMap::new(),
            gate_buffer_idx,
            freq_buffer_idx,
        }
    }

    pub fn add_node(&mut self, node: Box<dyn AudioNode>) -> NodeId {
        let id = NodeId(self.nodes.len());

        // Allocate buffers for each port
        for (port, _) in node.get_ports() {
            let buffer_idx = self.buffer_pool.acquire(self.buffer_size);
            self.node_buffers.insert((id, port), buffer_idx);
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

    pub fn get_node_mut(&mut self, node_id: NodeId) -> Option<&mut Box<dyn AudioNode>> {
        self.nodes.get_mut(&node_id)
    }

    fn has_audio_inputs(&self, node_id: NodeId) -> bool {
        self.connections
            .values()
            .any(|conn| conn.to_node == node_id && conn.to_port.is_audio_input())
    }

    fn update_processing_order(&mut self) {
        self.processing_order.clear();
        let mut visited = HashMap::new();

        let nodes: Vec<NodeId> = self.nodes.keys().copied().collect();

        for &node_id in &nodes {
            visited.insert(node_id, false);
        }

        // First visit nodes with no audio inputs
        for &node_id in &nodes {
            if !visited[&node_id] && !self.has_audio_inputs(node_id) {
                self.visit_node(node_id, &mut visited);
            }
        }

        // Then visit any remaining unvisited nodes
        for &node_id in &nodes {
            if !visited[&node_id] {
                self.visit_node(node_id, &mut visited);
            }
        }
    }

    fn visit_node(&mut self, node_id: NodeId, visited: &mut HashMap<NodeId, bool>) {
        if visited[&node_id] {
            return;
        }

        visited.insert(node_id, true);

        let upstream_nodes: Vec<NodeId> = self
            .connections
            .values()
            .filter(|conn| conn.to_node == node_id)
            .map(|conn| conn.from_node)
            .collect();

        for next_node in upstream_nodes {
            if !visited[&next_node] {
                self.visit_node(next_node, visited);
            }
        }

        self.processing_order.push(node_id);
    }

    // Modify set_gate and set_frequency to use new methods
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
        // Clear all node buffers
        for &buffer_idx in self.node_buffers.values() {
            self.buffer_pool.clear(buffer_idx);
        }

        // Process nodes in order
        for &node_id in &self.processing_order.clone() {
            let mut temp_buffers = Vec::new();
            let mut output_buffer_indices = Vec::new();
            let mut buffer_to_port = Vec::new(); // Track which buffer goes with which port

            // First collect all the buffers we'll need
            if let Some(node) = self.nodes.get(&node_id) {
                let ports = node.get_ports();
                if ports.contains_key(&PortId::Gate) {
                    temp_buffers.push(self.buffer_pool.copy_out(self.gate_buffer_idx).to_vec());
                    buffer_to_port.push((temp_buffers.len() - 1, PortId::Gate));
                }
                if ports.contains_key(&PortId::Frequency) {
                    temp_buffers.push(self.buffer_pool.copy_out(self.freq_buffer_idx).to_vec());
                    buffer_to_port.push((temp_buffers.len() - 1, PortId::Frequency));
                }

                // Collect outputs we'll need
                for (&port, &required) in &ports {
                    if required {
                        if let Some(&buffer_idx) = self.node_buffers.get(&(node_id, port)) {
                            output_buffer_indices.push((port, buffer_idx));
                        }
                    }
                }
            }

            // Handle connections
            for connection in self.connections.values() {
                if connection.to_node == node_id {
                    if let Some(&buffer_idx) = self
                        .node_buffers
                        .get(&(connection.from_node, connection.from_port))
                    {
                        temp_buffers.push(self.buffer_pool.copy_out(buffer_idx).to_vec());
                        buffer_to_port.push((temp_buffers.len() - 1, connection.to_port));
                    }
                }
            }

            // Now build the input map after all buffers are collected
            let input_map: HashMap<PortId, &[f32]> = buffer_to_port
                .iter()
                .map(|(buffer_idx, port)| (*port, temp_buffers[*buffer_idx].as_slice()))
                .collect();

            // Create temporary output buffers
            let mut output_buffers: HashMap<PortId, Vec<f32>> = output_buffer_indices
                .iter()
                .map(|(port, _)| (*port, vec![0.0; self.buffer_size]))
                .collect();

            // Process the node with temporary buffers
            if let Some(node) = self.nodes.get_mut(&node_id) {
                let mut output_refs: HashMap<PortId, &mut [f32]> = output_buffers
                    .iter_mut()
                    .map(|(port, buffer)| (*port, buffer.as_mut_slice()))
                    .collect();

                node.process(&input_map, &mut output_refs, self.buffer_size);
            }

            // Copy output buffers back to pool
            for ((_port, buffer_idx), buffer) in
                output_buffer_indices.iter().zip(output_buffers.values())
            {
                self.buffer_pool.copy_in(*buffer_idx, buffer);
            }
        }

        // Copy final output
        if let Some(&final_node) = self.processing_order.last() {
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
        self.buffer_pool.release(self.gate_buffer_idx);
        self.buffer_pool.release(self.freq_buffer_idx);
    }
}
