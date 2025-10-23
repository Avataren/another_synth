#![feature(portable_simd)]
#![feature(map_many_mut)]

mod audio;
mod audio_engine;
mod biquad;
mod effect_stack;
mod graph;
mod impulse_generator;
mod macros;
mod nodes;
mod processing;
mod traits;
mod utils;
mod voice;

pub use graph::AudioGraph;
pub use graph::{Connection, ConnectionId, NodeId};
pub use macros::{MacroManager, ModulationTarget};
pub use nodes::{Envelope, EnvelopeConfig};
pub use traits::{AudioNode, PortId};
pub use utils::*;
pub use voice::Voice;

pub use audio_engine::{
    AudioEngine,
    LfoUpdateParams,
    NoiseUpdateParams,
    WasmModulationType,
    WasmNoiseType,
};
