mod patch;
mod patch_loader;

#[cfg(all(feature = "wasm", target_arch = "wasm32"))]
pub mod wasm;

#[cfg(feature = "native-host")]
pub mod native;

#[cfg(all(feature = "wasm", not(feature = "native-host"), target_arch = "wasm32"))]
pub use wasm::*;

#[cfg(feature = "native-host")]
pub use native::*;

// Re-export common types for both
pub use crate::graph::{ModulationTransformation, ModulationType};
pub use crate::traits::PortId;
