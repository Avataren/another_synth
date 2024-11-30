mod dependent_module;
mod gui;
mod oscillator;
mod wasm_audio;

pub use wasm_audio::WasmAudio;
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn init() {
    // Use web_sys console instead of console_log
    web_sys::console::log_1(&"Initializing WebAssembly audio module".into());
}
