//! Audio buffering and state management
//!
//! Handles buffering between different block sizes and manages audio rendering state.

use crate::audio_renderer::AudioRenderer;

/// State management for audio processing with arbitrary block sizes
pub(crate) struct AudioBuffer<R: AudioRenderer> {
    pub(crate) renderer: R,
    pub(crate) engine_block_size: usize,
    pub(crate) carry_left: Vec<f32>,
    pub(crate) carry_right: Vec<f32>,
    pub(crate) carry_available: usize,
    pub(crate) carry_index: usize,
    pub(crate) call_count: usize,
}

impl<R: AudioRenderer> AudioBuffer<R> {
    pub(crate) fn new(renderer: R, engine_block_size: usize) -> Self {
        let engine_block_size = engine_block_size.max(1);

        Self {
            renderer,
            engine_block_size,
            carry_left: vec![0.0; engine_block_size],
            carry_right: vec![0.0; engine_block_size],
            carry_available: 0,
            carry_index: 0,
            call_count: 0,
        }
    }
}

unsafe impl<R: AudioRenderer> Send for AudioBuffer<R> {}
