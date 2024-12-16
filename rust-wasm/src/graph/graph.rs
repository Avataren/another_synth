/// AudioGraph is a flexible audio processing system that manages interconnected audio nodes and their buffer routing.
///
/// Core concepts:
/// - Nodes: Audio processing units (oscillators, envelopes, etc.) that can have multiple inputs and outputs
/// - Connections: Routes that carry audio/control signals between nodes' ports
/// - Buffer Pool: A memory manager that pre-allocates and reuses audio buffers
/// - Processing Order: A topologically sorted sequence of nodes ensuring correct signal flow
///
/// The system works by:
/// 1. Construction:
///    - Nodes are added to the graph and assigned unique IDs
///    - Each node's ports get dedicated buffers from the buffer pool
///    - Connections are established between nodes, recording source/destination ports
///    - Processing order is computed to handle dependencies correctly
///
/// 2. Runtime Processing:
///    - Global inputs (gate, frequency) are written to their dedicated buffers
///    - Nodes are processed in topological order
///    - For each node:
///      - Input buffers are prepared (either from source nodes or global inputs)
///      - Node processes its inputs and writes to its output buffers
///      - Output buffers are available for downstream nodes
///    - Final node's output is copied to the main output buffers
///
/// Key optimizations:
/// - Buffer pool prevents audio buffer allocations during processing
/// - Pre-computed processing order eliminates runtime dependency checks
/// - Vec-based storage enables efficient node lookup
/// - Connection information is cached to minimize lookup overhead
/// - Temporary buffers are reused across processing cycles
///
/// The system maintains thread safety through Rust's ownership system and provides
/// real-time safety by avoiding allocations in the processing path. It supports
/// arbitrary node graphs as long as they don't contain feedback loops.
use super::{
    buffer_pool::AudioBufferPool,
    types::{Connection, ConnectionId, NodeId},
};
use crate::{AudioNode, MacroManager, PortId};
use std::collections::HashMap;

pub struct AudioGraph {
    pub(crate) nodes: Vec<Box<dyn AudioNode>>,
    pub(crate) connections: HashMap<ConnectionId, Connection>,
    pub(crate) processing_order: Vec<usize>,
    pub(crate) buffer_size: usize,
    pub(crate) buffer_pool: AudioBufferPool,
    pub(crate) node_buffers: HashMap<(NodeId, PortId), usize>,
    pub(crate) gate_buffer_idx: usize,
    pub(crate) freq_buffer_idx: usize,
    pub(crate) input_connections: HashMap<NodeId, Vec<(PortId, usize, f32)>>,
    pub(crate) temp_buffer_indices: Vec<usize>,
    pub(crate) output_node: Option<NodeId>,
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
            output_node: None,
        }
    }

    pub fn clear(&mut self) {
        // Clear all connections
        self.connections.clear();
        self.input_connections.clear();

        // Clear nodes
        self.nodes.clear();
        self.processing_order.clear();

        // Reset output node
        self.output_node = None;

        // Release all buffers back to the pool
        self.buffer_pool.release_all();
    }

    pub fn set_output_node(&mut self, node: NodeId) {
        self.output_node = Some(node);
        self.update_processing_order();
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

    pub fn get_node(&self, node_id: NodeId) -> Option<&Box<dyn AudioNode>> {
        self.nodes.get(node_id.0)
    }

    pub fn get_node_mut(&mut self, node_id: NodeId) -> Option<&mut Box<dyn AudioNode>> {
        self.nodes.get_mut(node_id.0)
    }

    // fn has_audio_inputs(&self, node_id: NodeId) -> bool {
    //     self.connections
    //         .values()
    //         .any(|conn| conn.to_node == node_id && conn.to_port.is_audio_input())
    // }

    fn has_inputs(&self, node_id: NodeId) -> bool {
        self.connections
            .values()
            .any(|conn| conn.to_node == node_id)
    }

    fn is_connected_to_output(
        &self,
        node_id: NodeId,
        output_node: NodeId,
        visited: &mut Vec<bool>,
    ) -> bool {
        if node_id == output_node {
            return true;
        }

        if visited[node_id.0] {
            return false;
        }
        visited[node_id.0] = true;

        self.connections
            .values()
            .filter(|conn| conn.from_node == node_id)
            .any(|conn| self.is_connected_to_output(conn.to_node, output_node, visited))
    }

    fn update_processing_order(&mut self) {
        self.processing_order.clear();
        let mut visited = vec![false; self.nodes.len()];

        // If we have an output node, only process nodes connected to it
        if let Some(output_node) = self.output_node {
            for i in 0..self.nodes.len() {
                visited.fill(false);
                if self.is_connected_to_output(NodeId(i), output_node, &mut visited) {
                    self.visit_node(i, &mut visited);
                }
            }
        } else {
            // No output node set - process all nodes in topological order
            // First visit nodes with no inputs
            for i in 0..self.nodes.len() {
                let node_id = NodeId(i);
                if !visited[i] && !self.has_inputs(node_id) {
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

        // console::log_1(&format!("Processing order updated: {:?}", self.processing_order).into());
    }

    fn visit_node(&mut self, index: usize, visited: &mut [bool]) {
        if visited[index] {
            return;
        }

        visited[index] = true;

        // Visit all nodes that feed into this one first
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
        self.process_audio_with_macros(None, output_left, output_right);
    }

    pub fn process_audio_with_macros(
        &mut self,
        macro_manager: Option<&MacroManager>,
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        // Clear all node buffers at start of processing
        for &buffer_idx in self.node_buffers.values() {
            self.buffer_pool.clear(buffer_idx);
        }

        // Process each node in topological order
        for &node_idx in &self.processing_order {
            let node_id = NodeId(node_idx);
            let node = &mut self.nodes[node_idx];

            // Skip processing if node shouldn't be processed
            if !node.should_process() {
                // Clear output buffers for inactive nodes
                for (&(id, port), &buffer_idx) in self.node_buffers.iter() {
                    if id == node_id && port.is_audio_output() {
                        self.buffer_pool.clear(buffer_idx);
                    }
                }
                continue;
            }

            let ports = node.get_ports();

            // Collect inputs into input_data
            let mut input_data: Vec<(PortId, Vec<f32>)> = Vec::new();

            // Handle Gate input if the node has a Gate port
            if ports.contains_key(&PortId::Gate) {
                let gate_data = self.buffer_pool.copy_out(self.gate_buffer_idx).to_vec();
                input_data.push((PortId::Gate, gate_data));
            }

            // Handle Frequency input if the node has a Frequency port
            if ports.contains_key(&PortId::GlobalFrequency) {
                let freq_data = self.buffer_pool.copy_out(self.freq_buffer_idx).to_vec();
                input_data.push((PortId::GlobalFrequency, freq_data));
            }

            // Handle connections from upstream nodes
            if let Some(connections) = self.input_connections.get(&node_id) {
                for &(port, source_idx, amount) in connections {
                    let source_data = self.buffer_pool.copy_out(source_idx);
                    let processed = if amount == 1.0 {
                        source_data.to_vec()
                    } else {
                        source_data.iter().map(|x| x * amount).collect()
                    };
                    input_data.push((port, processed));
                }
            }

            // Build the input_map from input_data
            let mut input_map: HashMap<PortId, &[f32]> = HashMap::new();
            for (port, data) in &input_data {
                input_map.insert(*port, data.as_slice());
            }

            // Identify the outputs for this node
            let output_indices: Vec<usize> = ports
                .iter()
                .filter(|(_, &is_output)| is_output)
                .filter_map(|(&port, _)| self.node_buffers.get(&(node_id, port)).copied())
                .collect();

            // If this node expects modulation inputs, prepare macro data now
            let macro_data = if let Some(macro_mgr) = macro_manager {
                if ports.keys().any(|port| port.is_modulation_input()) {
                    Some(macro_mgr.prepare_macro_data(&self.buffer_pool))
                } else {
                    None
                }
            } else {
                None
            };

            {
                // Borrow output buffers mutably for processing
                let mut output_buffers = self.buffer_pool.get_multiple_buffers_mut(&output_indices);

                // Create a map of port IDs to mutable slices for output buffers
                let mut output_refs = HashMap::new();
                for (idx, buffer) in &mut output_buffers {
                    if let Some((&(n, p), _)) = self
                        .node_buffers
                        .iter()
                        .find(|((n, _), &i)| *n == node_id && i == *idx)
                    {
                        output_refs.insert(p, &mut **buffer);
                    }
                }

                // Process the node
                node.process(&input_map, &mut output_refs, self.buffer_size);

                // Apply macro modulation if available
                if let (Some(macro_mgr), Some(ref macro_data)) = (macro_manager, macro_data) {
                    for offset in (0..self.buffer_size).step_by(4) {
                        macro_mgr.apply_modulation(offset, macro_data, &mut output_refs);
                    }
                }
            }
        }

        // After all nodes are processed, copy the final node's output to the main outputs
        if let Some(output_node) = self.output_node {
            if let Some(node) = self.nodes.get(output_node.0) {
                if node.is_active() {
                    if let Some(&buffer_idx) =
                        self.node_buffers.get(&(output_node, PortId::AudioOutput0))
                    {
                        let final_buffer = self.buffer_pool.copy_out(buffer_idx);
                        output_left.copy_from_slice(final_buffer);
                        output_right.copy_from_slice(final_buffer);
                    }
                } else {
                    // If output node is inactive, clear the outputs
                    output_left.fill(0.0);
                    output_right.fill(0.0);
                }
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

impl std::fmt::Debug for AudioGraph {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AudioGraph")
            .field("buffer_size", &self.buffer_size)
            .field("num_nodes", &self.nodes.len())
            .field("num_connections", &self.connections.len())
            .finish()
    }
}
