#[cfg(feature = "wasm")]
pub mod wasm;

#[cfg(feature = "wasm")]
pub use wasm::*;

#[cfg(feature = "native-host")]
pub mod native;
