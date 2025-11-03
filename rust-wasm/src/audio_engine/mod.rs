#[cfg(feature = "wasm")]
pub mod wasm;

#[cfg(feature = "wasm")]
pub use wasm::*;

#[cfg(feature = "native-host")]
pub mod native;

#[cfg(feature = "native-host")]
pub use native::*;

// Re-export common types for both
pub use crate::graph::{ModulationTransformation, ModulationType};
pub use crate::traits::PortId;
