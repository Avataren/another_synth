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
///
use super::{
    buffer_pool::AudioBufferPool,
    types::{Connection, ConnectionKey, NodeId},
    ModulationSource,
};
use crate::{graph::ModulationType, nodes::GlobalFrequencyNode, nodes::GlobalVelocityNode};
use crate::{AudioNode, MacroManager, PortId};
use std::collections::HashMap;

pub struct AudioGraph {
    pub(crate) nodes: Vec<Box<dyn AudioNode>>,
    pub(crate) connections: HashMap<ConnectionKey, Connection>,
    pub(crate) processing_order: Vec<usize>,
    pub(crate) buffer_size: usize,
    pub(crate) buffer_pool: AudioBufferPool,
    pub(crate) node_buffers: HashMap<(NodeId, PortId), usize>,
    pub(crate) gate_buffer_idx: usize,
    // We now include the source node in the tuple so we can identify which connection to remove.
    pub(crate) input_connections:
        HashMap<NodeId, Vec<(PortId, usize, f32, NodeId, ModulationType)>>,
    pub(crate) temp_buffer_indices: Vec<usize>,
    pub(crate) global_frequency_node: Option<NodeId>,
    pub(crate) global_velocity_node: Option<NodeId>,
    pub(crate) output_node: Option<NodeId>,
}

impl AudioGraph {
    pub fn new(buffer_size: usize) -> Self {
        let mut buffer_pool = AudioBufferPool::new(buffer_size, 32);
        let gate_buffer_idx = buffer_pool.acquire(buffer_size);

        let mut graph = Self {
            nodes: Vec::new(),
            connections: HashMap::new(),
            processing_order: Vec::new(),
            buffer_size,
            buffer_pool,
            node_buffers: HashMap::new(),
            gate_buffer_idx,
            input_connections: HashMap::new(),
            temp_buffer_indices: Vec::new(),
            global_frequency_node: None,
            global_velocity_node: None,
            output_node: None,
        };

        // Create and add the GlobalFrequencyNode:
        let global_node = Box::new(GlobalFrequencyNode::new(440.0, buffer_size));
        let global_node_id = graph.add_node(global_node);
        graph.global_frequency_node = Some(global_node_id);
        // Create and add the GlobalVelocityNode:
        let global_velocity_node = Box::new(GlobalVelocityNode::new(1.0, buffer_size));
        let global_velocity_node_id = graph.add_node(global_velocity_node);
        graph.global_velocity_node = Some(global_velocity_node_id);

        graph
    }

    pub fn clear(&mut self) {
        // Clear all connections and nodes.
        self.connections.clear();
        self.input_connections.clear();
        self.nodes.clear();
        self.processing_order.clear();
        self.output_node = None;
        // Release all buffers back to the pool.
        self.buffer_pool.release_all();
    }

    pub fn set_output_node(&mut self, node: NodeId) {
        self.output_node = Some(node);
        self.update_processing_order();
    }

    pub fn add_node(&mut self, node: Box<dyn AudioNode>) -> NodeId {
        let id = NodeId(self.nodes.len());
        // Allocate buffers for each port.
        for (port, _) in node.get_ports() {
            let buffer_idx = self.buffer_pool.acquire(self.buffer_size);
            self.node_buffers.insert((id, port), buffer_idx);
        }
        self.nodes.push(node);
        self.update_processing_order();

        // Auto-connect the GlobalFrequency node if the new node accepts it.
        if let Some(ref ports) = self.nodes.last().map(|n| n.get_ports()) {
            if ports.contains_key(&PortId::GlobalFrequency) {
                if let Some(global_node_id) = self.global_frequency_node {
                    // Create a connection from the global frequency node's output
                    self.add_connection(Connection {
                        from_node: global_node_id,
                        from_port: PortId::GlobalFrequency,
                        to_node: id,
                        to_port: PortId::GlobalFrequency,
                        amount: 1.0,
                        modulation_type: ModulationType::Additive,
                    });
                }
            }
        }

        id
    }

    // pub fn add_node(&mut self, node: Box<dyn AudioNode>) -> NodeId {
    //     let id = NodeId(self.nodes.len());
    //     // Allocate buffers for each port.
    //     for (port, _) in node.get_ports() {
    //         let buffer_idx = self.buffer_pool.acquire(self.buffer_size);
    //         self.node_buffers.insert((id, port), buffer_idx);
    //     }
    //     self.nodes.push(node);
    //     self.update_processing_order();
    //     id
    // }

    pub fn add_connection(&mut self, connection: Connection) {
        let key = ConnectionKey::new(
            connection.from_node,
            connection.from_port,
            connection.to_node,
            connection.to_port,
        );

        let source_buffer_idx = self.node_buffers[&(connection.from_node, connection.from_port)];
        let to_port = connection.to_port;
        let to_node = connection.to_node;
        let amount = connection.amount;

        self.connections.insert(key.clone(), connection.clone());

        // Update input_connections with the source node included.
        self.input_connections.entry(to_node).or_default().push((
            to_port,
            source_buffer_idx,
            amount,
            connection.from_node,
            connection.modulation_type,
        ));

        self.update_processing_order();
    }

    pub fn debug_connections(&self) -> Vec<(ConnectionKey, Connection)> {
        self.connections
            .iter()
            .map(|(k, v)| (k.clone(), v.clone()))
            .collect()
    }

    /// Removes a connection given the source node, target node, and target port.
    pub fn remove_specific_connection(
        &mut self,
        from_node: NodeId,
        to_node: NodeId,
        to_port: PortId,
    ) {
        // web_sys::console::log_1(
        //     &format!(
        //         "remove_specific_connection - Before remove: connections={:?}, inputs={:?}",
        //         self.connections, self.input_connections
        //     )
        //     .into(),
        // );

        // Remove matching connection(s) from the connections map.
        let to_remove: Vec<_> = self
            .connections
            .iter()
            .filter(|(_, conn)| {
                conn.from_node == from_node && conn.to_node == to_node && conn.to_port == to_port
            })
            .map(|(k, _)| k.clone())
            .collect();

        for key in to_remove {
            self.connections.remove(&key);
        }

        // Gather all buffer indices corresponding to outputs from `from_node`.
        let from_node_buffer_indices: Vec<usize> = self
            .node_buffers
            .iter()
            .filter(|((node_id, _), _)| *node_id == from_node)
            .map(|(_, &buf_idx)| buf_idx)
            .collect();

        // Update input_connections by removing entries matching the criteria.
        if let Some(inputs) = self.input_connections.get_mut(&to_node) {
            inputs.retain(|(port, buffer_idx, _amount, src_node, _mod_type)| {
                !(*port == to_port
                    && *src_node == from_node
                    && from_node_buffer_indices.contains(buffer_idx))
            });
            if inputs.is_empty() {
                self.input_connections.remove(&to_node);
            }
        }

        // if let Some(inputs) = self.input_connections.get_mut(&to_node) {
        //     inputs.retain(|(port, buffer_idx, _amount, src_node)| {
        //         !(*port == to_port
        //             && *src_node == from_node
        //             && from_node_buffer_indices.contains(buffer_idx))
        //     });
        //     if inputs.is_empty() {
        //         self.input_connections.remove(&to_node);
        //     }
        // }

        // web_sys::console::log_1(
        //     &format!(
        //         "remove_specific_connection - After remove: connections={:?}, inputs={:?}",
        //         self.connections, self.input_connections
        //     )
        //     .into(),
        // );
    }

    /// Removes a connection based on an entire Connection struct.
    pub fn remove_connection(&mut self, connection: &Connection) {
        // Remove the matching connection from the connections map.
        self.connections.retain(|_, existing| {
            !(existing.from_node == connection.from_node
                && existing.to_node == connection.to_node
                && existing.from_port == connection.from_port
                && existing.to_port == connection.to_port)
        });

        // Gather all buffer indices corresponding to outputs from connection.from_node.
        let from_node_buffer_indices: Vec<usize> = self
            .node_buffers
            .iter()
            .filter(|((node_id, _), _)| *node_id == connection.from_node)
            .map(|(_, &buf_idx)| buf_idx)
            .collect();

        // Update input_connections accordingly.
        if let Some(inputs) = self.input_connections.get_mut(&connection.to_node) {
            inputs.retain(|(port, buffer_idx, _amount, src_node, _mod_type)| {
                !(*port == connection.to_port
                    && *src_node == connection.from_node
                    && from_node_buffer_indices.contains(buffer_idx))
            });
            if inputs.is_empty() {
                self.input_connections.remove(&connection.to_node);
            }
        }

        // if let Some(inputs) = self.input_connections.get_mut(&connection.to_node) {
        //     inputs.retain(|(port, buffer_idx, _amount, src_node)| {
        //         !(*port == connection.to_port
        //             && *src_node == connection.from_node
        //             && from_node_buffer_indices.contains(buffer_idx))
        //     });
        //     if inputs.is_empty() {
        //         self.input_connections.remove(&connection.to_node);
        //     }
        // }

        self.update_processing_order();
    }

    pub fn connect(&mut self, connection: Connection) -> ConnectionKey {
        web_sys::console::log_1(
            &format!(
                "connect - Before connect: connections={:?}, inputs={:?}",
                self.connections, self.input_connections
            )
            .into(),
        );

        let key = ConnectionKey::new(
            connection.from_node,
            connection.from_port,
            connection.to_node,
            connection.to_port,
        );

        self.connections.insert(key.clone(), connection.clone());

        let source_buffer_idx = self.node_buffers[&(connection.from_node, connection.from_port)];
        let inputs = self
            .input_connections
            .entry(connection.to_node)
            .or_default();

        // Update an existing connection if one exists.
        let existing_idx = inputs.iter().position(|(port, _, _, src_node, _)| {
            *port == connection.to_port && *src_node == connection.from_node
        });

        if let Some(idx) = existing_idx {
            inputs[idx] = (
                connection.to_port,
                source_buffer_idx,
                connection.amount,
                connection.from_node,
                connection.modulation_type,
            );
        } else {
            inputs.push((
                connection.to_port,
                source_buffer_idx,
                connection.amount,
                connection.from_node,
                connection.modulation_type,
            ));
        }

        // let existing_idx = inputs.iter().position(|(port, _, _, src_node)| {
        //     *port == connection.to_port && *src_node == connection.from_node
        // });

        // if let Some(idx) = existing_idx {
        //     web_sys::console::log_1(
        //         &format!(
        //             "Updating existing connection at idx {}: old={:?}, new=({:?}, {:?}, {:?})",
        //             idx, inputs[idx], connection.to_port, source_buffer_idx, connection.amount
        //         )
        //         .into(),
        //     );
        //     inputs[idx] = (
        //         connection.to_port,
        //         source_buffer_idx,
        //         connection.amount,
        //         connection.from_node,
        //     );
        // } else {
        //     web_sys::console::log_1(
        //         &format!(
        //             "Adding new connection: ({:?}, {:?}, {:?})",
        //             connection.to_port, source_buffer_idx, connection.amount
        //         )
        //         .into(),
        //     );
        //     inputs.push((
        //         connection.to_port,
        //         source_buffer_idx,
        //         connection.amount,
        //         connection.from_node,
        //     ));
        // }

        web_sys::console::log_1(
            &format!(
                "connect - After connect: connections={:?}, inputs={:?}",
                self.connections, self.input_connections
            )
            .into(),
        );

        self.update_processing_order();
        key
    }

    pub fn get_node(&self, node_id: NodeId) -> Option<&Box<dyn AudioNode>> {
        self.nodes.get(node_id.0)
    }

    pub fn get_node_mut(&mut self, node_id: NodeId) -> Option<&mut Box<dyn AudioNode>> {
        self.nodes.get_mut(node_id.0)
    }

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
        let num_nodes = self.nodes.len();
        let mut in_degree = vec![0; num_nodes];

        // Compute in-degrees for each node.
        for conn in self.connections.values() {
            in_degree[conn.to_node.0] += 1;
        }

        // Start with all nodes that have no incoming connections.
        let mut queue: Vec<usize> = in_degree
            .iter()
            .enumerate()
            .filter_map(|(i, &deg)| if deg == 0 { Some(i) } else { None })
            .collect();

        self.processing_order.clear();

        // Process nodes in order.
        while let Some(node_index) = queue.pop() {
            self.processing_order.push(node_index);

            // For each connection from this node, reduce the in-degree of its destination.
            for conn in self.connections.values() {
                if conn.from_node.0 == node_index {
                    let dest = conn.to_node.0;
                    in_degree[dest] -= 1;
                    if in_degree[dest] == 0 {
                        queue.push(dest);
                    }
                }
            }
        }

        // If there is a cycle (or some nodes were not reached), add any remaining nodes.
        if self.processing_order.len() < num_nodes {
            for i in 0..num_nodes {
                if !self.processing_order.contains(&i) {
                    self.processing_order.push(i);
                }
            }
        }
    }

    fn visit_node(&mut self, index: usize, visited: &mut [bool]) {
        if visited[index] {
            return;
        }
        visited[index] = true;
        let node_id = NodeId(index);
        // Visit all upstream nodes first.
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
        if let Some(global_node_id) = self.global_frequency_node {
            if let Some(node) = self.get_node_mut(global_node_id) {
                if let Some(global_freq_node) =
                    node.as_any_mut().downcast_mut::<GlobalFrequencyNode>()
                {
                    global_freq_node.set_base_frequency(freq);
                }
            }
        }
    }

    pub fn set_velocity(&mut self, velocity: &[f32]) {
        if let Some(global_node_id) = self.global_frequency_node {
            if let Some(node) = self.get_node_mut(global_node_id) {
                if let Some(global_freq_node) =
                    node.as_any_mut().downcast_mut::<GlobalVelocityNode>()
                {
                    global_freq_node.set_velocity(velocity);
                }
            }
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
        // Prepare macro data once at the start.
        let macro_data = macro_manager.map(|m| m.prepare_macro_data(&mut self.buffer_pool));
        // Clear all node buffers at the start of processing.
        for &buffer_idx in self.node_buffers.values() {
            self.buffer_pool.clear(buffer_idx);
        }
        // Process each node in topological order.
        for &node_idx in &self.processing_order {
            let node_id = NodeId(node_idx);
            // Skip processing for nodes that shouldn’t process.
            if !self.nodes[node_idx].should_process() {
                for (&(id, port), &buffer_idx) in self.node_buffers.iter() {
                    if id == node_id && port.is_audio_output() {
                        self.buffer_pool.clear(buffer_idx);
                    }
                }
                continue;
            }

            let ports = self.nodes[node_idx].get_ports().clone();
            let mut inputs: HashMap<PortId, Vec<ModulationSource>> = HashMap::new();

            // Handle gate and frequency inputs.
            if ports.contains_key(&PortId::Gate) {
                inputs
                    .entry(PortId::Gate)
                    .or_default()
                    .push(ModulationSource {
                        buffer: self.buffer_pool.copy_out(self.gate_buffer_idx).to_vec(),
                        amount: 1.0,
                        mod_type: ModulationType::Additive,
                    });
            }
            // if ports.contains_key(&PortId::GlobalFrequency) {
            //     inputs
            //         .entry(PortId::GlobalFrequency)
            //         .or_default()
            //         .push(ModulationSource {
            //             buffer: self.buffer_pool.copy_out(self.freq_buffer_idx).to_vec(),
            //             amount: 1.0,
            //             mod_type: ModulationType::Additive,
            //         });
            // }

            // Process all connections.
            if let Some(connections) = self.input_connections.get(&node_id) {
                for &(port, source_idx, amount, _src_node, mod_type) in connections {
                    let buffer = self.buffer_pool.copy_out(source_idx).to_vec();
                    inputs.entry(port).or_default().push(ModulationSource {
                        buffer,
                        amount,
                        mod_type,
                    });
                }
            }

            // Get output buffers.
            let output_indices: Vec<usize> = ports
                .iter()
                .filter(|(_, &is_output)| is_output)
                .filter_map(|(&port, _)| self.node_buffers.get(&(node_id, port)).copied())
                .collect();

            let mut output_buffers = self.buffer_pool.get_multiple_buffers_mut(&output_indices);
            let mut outputs = HashMap::new();
            for (buffer_idx, buffer) in output_buffers.iter_mut() {
                if let Some(((node_id_key, port), _)) = self
                    .node_buffers
                    .iter()
                    .find(|((n, _), &idx)| idx == *buffer_idx && n.0 == node_idx)
                {
                    if ports.get(port) == Some(&true) {
                        outputs.insert(*port, &mut **buffer);
                    }
                }
            }

            // Process the node.
            self.nodes[node_idx].process(&inputs, &mut outputs, self.buffer_size);

            // Apply macro modulation if available.
            if let (Some(mgr), Some(ref data)) = (macro_manager, &macro_data) {
                for offset in (0..self.buffer_size).step_by(4) {
                    mgr.apply_modulation(offset, data, &mut outputs);
                }
            }
            drop(output_buffers);
        }

        // Handle final output.
        if let Some(output_node) = self.output_node {
            if let Some(node) = self.nodes.get(output_node.0) {
                if node.is_active() {
                    if let Some(&left_buffer_idx) =
                        self.node_buffers.get(&(output_node, PortId::AudioOutput0))
                    {
                        let left_buffer = self.buffer_pool.copy_out(left_buffer_idx);
                        output_left.copy_from_slice(left_buffer);
                        if let Some(&right_buffer_idx) =
                            self.node_buffers.get(&(output_node, PortId::AudioOutput1))
                        {
                            let right_buffer = self.buffer_pool.copy_out(right_buffer_idx);
                            output_right.copy_from_slice(right_buffer);
                        } else {
                            output_right.copy_from_slice(left_buffer);
                        }
                    }
                } else {
                    output_left.fill(0.0);
                    output_right.fill(0.0);
                }
            }
        }
    }
}

impl Drop for AudioGraph {
    fn drop(&mut self) {
        // Clean up all allocated buffers.
        for &buffer_idx in self.node_buffers.values() {
            self.buffer_pool.release(buffer_idx);
        }
        for &buffer_idx in &self.temp_buffer_indices {
            self.buffer_pool.release(buffer_idx);
        }
        self.buffer_pool.release(self.gate_buffer_idx);
        // self.buffer_pool.release(self.freq_buffer_idx);
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
