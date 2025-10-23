#[cfg(feature = "wasm")]
pub mod wasm;

#[cfg(feature = "wasm")]
pub use wasm::*;

#[cfg(not(feature = "wasm"))]
pub mod native;

#[cfg(not(feature = "wasm"))]
pub use native::*;
