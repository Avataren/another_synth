// src/processing/mod.rs
use crate::audio::{AudioInput, AudioOutput};
use crate::traits::PortId;
use std::collections::HashMap;

pub struct ProcessContext<'a> {
    pub inputs: HashMap<PortId, AudioInput<'a>>,
    pub outputs: HashMap<PortId, AudioOutput<'a>>,
    pub buffer_size: usize,
    // pub sample_rate: f32,
}

impl<'a> ProcessContext<'a> {
    pub fn new(
        inputs: &'a HashMap<PortId, &[f32]>,
        outputs: &'a mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
        default_values: &HashMap<PortId, f32>,
    ) -> Self {
        let inputs: HashMap<_, _> = inputs
            .iter()
            .map(|(&port, &buffer)| {
                let default = default_values.get(&port).copied().unwrap_or(0.0);
                (port, AudioInput::new(Some(buffer), default))
            })
            .collect();

        let outputs: HashMap<_, _> = outputs
            .iter_mut()
            .map(|(&port, buffer)| (port, AudioOutput::new(buffer)))
            .collect();

        Self {
            inputs,
            outputs,
            buffer_size,
        }
    }

    pub fn process_by_chunks<F>(&mut self, chunk_size: usize, mut process_fn: F)
    where
        F: FnMut(usize, &HashMap<PortId, AudioInput>, &mut HashMap<PortId, AudioOutput>),
    {
        let full_chunks = self.buffer_size / chunk_size;

        for chunk in 0..full_chunks {
            let offset = chunk * chunk_size;
            process_fn(offset, &self.inputs, &mut self.outputs);
        }
    }
}

pub trait AudioProcessor {
    fn get_default_values(&self) -> HashMap<PortId, f32>;
    // fn prepare(&mut self, sample_rate: f32, buffer_size: usize);
    fn process(&mut self, context: &mut ProcessContext);
    fn reset(&mut self);
}
