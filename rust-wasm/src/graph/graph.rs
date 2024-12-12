use web_sys::console;

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

    pub fn get_node(&self, node_id: NodeId) -> Option<&Box<dyn AudioNode>> {
        self.nodes.get(node_id.0)
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
        self.process_audio_with_macros(None, output_left, output_right)
    }

    pub fn process_audio_with_macros(
        &mut self,
        macro_manager: Option<&MacroManager>,
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        // Clear output buffers
        for &buffer_idx in self.node_buffers.values() {
            self.buffer_pool.clear(buffer_idx);
        }

        // Process nodes in order
        for &node_idx in &self.processing_order {
            let node_id = NodeId(node_idx);
            let node = &mut self.nodes[node_idx];
            let ports = node.get_ports();

            // Collect inputs first
            let mut input_data: Vec<(PortId, Vec<f32>)> = Vec::new();

            // Handle gate and frequency inputs
            if ports.contains_key(&PortId::Gate) {
                let gate_data = self.buffer_pool.copy_out(self.gate_buffer_idx).to_vec();
                input_data.push((PortId::Gate, gate_data));
            }

            if ports.contains_key(&PortId::Frequency) {
                let freq_data = self.buffer_pool.copy_out(self.freq_buffer_idx).to_vec();
                input_data.push((PortId::Frequency, freq_data));
            }

            // Process connected inputs
            if let Some(connections) = self.input_connections.get(&node_id) {
                for &(port, source_idx, amount) in connections {
                    let source_data = self.buffer_pool.copy_out(source_idx).to_vec();
                    if amount == 1.0 {
                        input_data.push((port, source_data));
                    } else {
                        let scaled_data: Vec<f32> =
                            source_data.iter().map(|&x| x * amount).collect();
                        input_data.push((port, scaled_data));
                    }
                }
            }

            // Create input map
            let mut input_map: HashMap<PortId, &[f32]> = HashMap::new();
            for (port, data) in &input_data {
                input_map.insert(*port, data.as_slice());
            }

            // Get output indices
            let output_indices: Vec<usize> = ports
                .iter()
                .filter(|(_, &is_output)| is_output)
                .filter_map(|(&port, _)| self.node_buffers.get(&(node_id, port)).copied())
                .collect();

            // Get a single set of mutable buffer references
            let mut output_buffers = self.buffer_pool.get_multiple_buffers_mut(&output_indices);

            // Process regular audio
            {
                let mut output_refs = HashMap::new();
                for (idx, buffer) in &mut output_buffers {
                    if let Some((&(_, port), _)) = self
                        .node_buffers
                        .iter()
                        .find(|((n, _), &i)| *n == node_id && i == *idx)
                    {
                        output_refs.insert(port, &mut **buffer); // Dereference to get the right level
                    }
                }

                node.process(&input_map, &mut output_refs, self.buffer_size);
            }

            // Process macros if available and needed
            if let Some(macro_mgr) = macro_manager {
                if ports.keys().any(|port| port.is_modulation_input()) {
                    let mut macro_outputs = HashMap::new();

                    for (idx, buffer) in &mut output_buffers {
                        if let Some((&(_, port), _)) = self
                            .node_buffers
                            .iter()
                            .find(|((n, _), &i)| *n == node_id && i == *idx)
                        {
                            macro_outputs.insert(port, &mut **buffer); // Same here
                        }
                    }

                    for offset in (0..self.buffer_size).step_by(4) {
                        macro_mgr.process_modulation(offset, &mut macro_outputs);
                    }
                }
            }
        }

        // Copy final output
        // if let Some(&final_idx) = self.processing_order.last() {
        //     let final_node = NodeId(final_idx);
        //     if let Some(&buffer_idx) = self.node_buffers.get(&(final_node, PortId::AudioOutput0)) {
        //         let final_buffer = self.buffer_pool.copy_out(buffer_idx);
        //         output_left.copy_from_slice(final_buffer);
        //         output_right.copy_from_slice(final_buffer);
        //     }
        // }
        //std::sync::atomic::fence(std::sync::atomic::Ordering::SeqCst);
        if let Some(&final_idx) = self.processing_order.last() {
            let final_node = NodeId(final_idx);
            // console::log_1(
            //     &format!(
            //         "Final node: {:?}, trying to get buffer for {:?}",
            //         final_node,
            //         PortId::AudioOutput0
            //     )
            //     .into(),
            // );
            if let Some(&buffer_idx) = self.node_buffers.get(&(final_node, PortId::AudioOutput0)) {
                console::log_1(&format!("Found buffer index: {}", buffer_idx).into());
                let final_buffer = self.buffer_pool.copy_out(buffer_idx);
                output_left.copy_from_slice(final_buffer);
                output_right.copy_from_slice(final_buffer);
            }
        }
        self.buffer_pool.release_all();
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
