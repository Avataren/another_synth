// src/traits/mod.rs
pub trait AudioNode {
    fn process_buffer(&mut self, inputs: &[&[f32]], outputs: &mut [&mut [f32]], buffer_size: usize);
    fn reset(&mut self);
}

pub trait Oscillator: AudioNode {
    fn set_frequency(&mut self, freq: f32);
}
