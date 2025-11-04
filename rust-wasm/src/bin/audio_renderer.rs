//! Audio renderer trait for playback systems

/// Trait for audio renderers that can be used with audio hosts
pub trait AudioRenderer: Send + 'static {
    /// Process a block of audio, filling the provided buffers
    fn process_block(&mut self, output_left: &mut [f32], output_right: &mut [f32]);
}
