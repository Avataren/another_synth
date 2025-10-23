#![feature(portable_simd)]
#![feature(map_many_mut)]

#[cfg(feature = "wasm")]
mod audio;
#[cfg(feature = "wasm")]
mod audio_engine;
#[cfg(feature = "wasm")]
mod automation;
#[cfg(feature = "wasm")]
mod biquad;
#[cfg(feature = "wasm")]
mod effect_stack;
#[cfg(feature = "wasm")]
mod graph;
#[cfg(feature = "wasm")]
mod impulse_generator;
#[cfg(feature = "wasm")]
mod macros;
#[cfg(feature = "wasm")]
mod nodes;
#[cfg(feature = "wasm")]
mod processing;
#[cfg(feature = "wasm")]
mod traits;
#[cfg(feature = "wasm")]
mod utils;
#[cfg(feature = "wasm")]
mod voice;

#[cfg(feature = "wasm")]
pub use automation::{
    apply_connection_update as apply_modulation_update,
    AutomationAdapter,
    AutomationFrame,
    ConnectionUpdate,
};
#[cfg(feature = "wasm")]
pub use graph::AudioGraph;
#[cfg(feature = "wasm")]
pub use graph::{Connection, ConnectionId, NodeId};
#[cfg(feature = "wasm")]
pub use macros::{MacroManager, ModulationTarget};
#[cfg(feature = "wasm")]
pub use nodes::{Envelope, EnvelopeConfig};
#[cfg(feature = "wasm")]
pub use traits::{AudioNode, PortId};
#[cfg(feature = "wasm")]
pub use utils::*;
#[cfg(feature = "wasm")]
pub use voice::Voice;

#[cfg(feature = "wasm")]
pub use audio_engine::{
    AudioEngine,
    LfoUpdateParams,
    NoiseUpdateParams,
    WasmModulationType,
    WasmNoiseType,
};

