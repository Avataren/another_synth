use crate::PortId;
use serde::Serialize;
use std::ops::Deref;
use wasm_bindgen::prelude::*;

#[derive(Clone)]
pub struct ModulationSource {
    pub buffer: Vec<f32>,
    pub amount: f32,
    pub mod_type: ModulationType,
    pub transformation: ModulationTransformation,
}

#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct NodeId(pub usize);

impl Default for NodeId {
    fn default() -> Self {
        NodeId(0)
    }
}

impl From<usize> for NodeId {
    fn from(value: usize) -> Self {
        NodeId(value)
    }
}

impl From<NodeId> for usize {
    fn from(id: NodeId) -> Self {
        id.0
    }
}

impl Deref for NodeId {
    type Target = usize;

    fn deref(&self) -> &Self::Target {
        &self.0
    }
}

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

#[derive(Clone, Copy, Debug, PartialEq)]
#[repr(u8)]
pub enum ModulationType {
    VCA = 0,
    Bipolar = 1,
    Additive = 2,
}

impl Default for ModulationType {
    fn default() -> Self {
        ModulationType::Additive
    }
}

#[derive(Copy, Clone, Debug, Serialize)]
#[wasm_bindgen]
#[repr(u32)]
pub enum ModulationTransformation {
    None,
    Invert,
    Square,
    Cube,
}

impl ModulationTransformation {
    #[inline]
    pub fn apply(&self, x: f32) -> f32 {
        match self {
            ModulationTransformation::None => x,
            ModulationTransformation::Invert => 1.0 - x,
            ModulationTransformation::Square => x * x,
            ModulationTransformation::Cube => x * x * x,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Connection {
    pub from_node: NodeId,
    pub from_port: PortId,
    pub to_node: NodeId,
    pub to_port: PortId,
    pub amount: f32,
    pub modulation_type: ModulationType,
    pub modulation_transform: ModulationTransformation,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct ConnectionKey {
    pub from_node: NodeId,
    pub from_port: PortId,
    pub to_node: NodeId,
    pub to_port: PortId,
}

impl ConnectionKey {
    pub fn new(from_node: NodeId, from_port: PortId, to_node: NodeId, to_port: PortId) -> Self {
        Self {
            from_node,
            from_port,
            to_node,
            to_port,
        }
    }
}
