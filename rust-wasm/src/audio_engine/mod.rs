#[cfg(feature = "wasm")]
pub mod wasm;

#[cfg(feature = "wasm")]
pub use wasm::*;

#[cfg(not(feature = "wasm"))]
#[derive(Debug, Default)]
pub struct AudioEngine {
    sample_rate: f32,
    num_voices: usize,
}

#[cfg(not(feature = "wasm"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasmNoiseType {
    White,
    Pink,
    Brownian,
}

#[cfg(not(feature = "wasm"))]
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WasmModulationType {
    VCA,
    Bipolar,
    Additive,
}

#[cfg(not(feature = "wasm"))]
#[derive(Debug, Clone, Copy)]
pub struct NoiseUpdateParams {
    pub noise_type: WasmNoiseType,
    pub cutoff: f32,
    pub gain: f32,
    pub enabled: bool,
}

#[cfg(not(feature = "wasm"))]
#[derive(Debug, Clone, Copy)]
pub struct LfoUpdateParams {
    pub lfo_id: usize,
    pub frequency: f32,
    pub phase_offset: f32,
    pub waveform: u8,
    pub use_absolute: bool,
    pub use_normalized: bool,
    pub trigger_mode: u8,
    pub gain: f32,
    pub active: bool,
    pub loop_mode: usize,
    pub loop_start: f32,
    pub loop_end: f32,
}

#[cfg(not(feature = "wasm"))]
impl AudioEngine {
    pub fn new(sample_rate: f32, num_voices: usize) -> Self {
        Self {
            sample_rate,
            num_voices,
        }
    }

    pub fn init(&mut self, sample_rate: f32, num_voices: usize) {
        self.sample_rate = sample_rate;
        self.num_voices = num_voices;
    }

    pub fn process_with_frame(
        &mut self,
        _frame: &crate::automation::AutomationFrame,
        _master_gain: f32,
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        output_left.fill(0.0);
        output_right.fill(0.0);
    }

    pub fn sample_rate(&self) -> f32 {
        self.sample_rate
    }

    pub fn num_voices(&self) -> usize {
        self.num_voices
    }
}
