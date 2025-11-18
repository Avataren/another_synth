use crate::PortId;
use serde::{Deserialize, Serialize};
use std::ops::Deref;
use uuid::Uuid;
#[cfg(feature = "wasm")]
use wasm_bindgen::prelude::*;

#[derive(Clone)] // Clone might not be possible/needed anymore if nodes don't own it
                 // Let's keep it for now but review if it causes issues later.
pub struct ModulationSource {
    pub buffer: Vec<f32>, // Owned Vec<f32>
    pub amount: f32,
    pub mod_type: ModulationType,
    pub transformation: ModulationTransformation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub struct NodeId(pub Uuid);

impl Default for NodeId {
    fn default() -> Self {
        NodeId(Uuid::nil())
    }
}

impl NodeId {
    pub fn new() -> Self {
        NodeId(Uuid::new_v4())
    }

    pub fn from_string(s: &str) -> Result<Self, uuid::Error> {
        Ok(NodeId(Uuid::parse_str(s)?))
    }

    pub fn to_string(&self) -> String {
        self.0.to_string()
    }
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
pub struct WasmNodeId {
    inner: NodeId,
}

#[cfg(feature = "wasm")]
#[wasm_bindgen]
impl WasmNodeId {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Self {
        WasmNodeId {
            inner: NodeId::new(),
        }
    }

    #[wasm_bindgen(js_name = fromString)]
    pub fn from_string(s: &str) -> Result<WasmNodeId, JsValue> {
        NodeId::from_string(s)
            .map(|inner| WasmNodeId { inner })
            .map_err(|e| JsValue::from_str(&e.to_string()))
    }

    #[wasm_bindgen(js_name = toString)]
    pub fn to_string(&self) -> String {
        self.inner.to_string()
    }
}

#[cfg(feature = "wasm")]
impl From<NodeId> for WasmNodeId {
    fn from(inner: NodeId) -> Self {
        WasmNodeId { inner }
    }
}

#[cfg(feature = "wasm")]
impl From<WasmNodeId> for NodeId {
    fn from(wasm: WasmNodeId) -> Self {
        wasm.inner
    }
}

#[cfg_attr(feature = "wasm", wasm_bindgen)]
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

#[derive(Copy, Clone, Debug, Serialize, PartialEq)]
#[cfg_attr(feature = "wasm", wasm_bindgen)]
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
