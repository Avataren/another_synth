use crate::PortId;
use wasm_bindgen::prelude::*;

#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
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
