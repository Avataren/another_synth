use std::simd::{f32x4, Simd, StdFloat};

#[derive(Clone)]
pub struct AudioBuffer {
    data: Vec<f32>,
    size: usize,
}

impl AudioBuffer {
    pub fn new(size: usize) -> Self {
        Self {
            data: vec![0.0; size],
            size,
        }
    }

    pub fn from_value(size: usize, value: f32) -> Self {
        Self {
            data: vec![value; size],
            size,
        }
    }

    pub fn clear(&mut self) {
        self.data.fill(0.0);
    }

    pub fn fill(&mut self, value: f32) {
        self.data.fill(value);
    }

    pub fn len(&self) -> usize {
        self.size
    }

    pub fn as_slice(&self) -> &[f32] {
        &self.data
    }

    pub fn as_mut_slice(&mut self) -> &mut [f32] {
        &mut self.data
    }
}

pub struct AudioInput<'a> {
    buffer: Option<&'a [f32]>,
    default_value: f32,
}

impl<'a> AudioInput<'a> {
    pub fn new(buffer: Option<&'a [f32]>, default_value: f32) -> Self {
        Self {
            buffer,
            default_value,
        }
    }

    pub fn get(&self, index: usize) -> f32 {
        self.buffer
            .and_then(|b| b.get(index))
            .copied()
            .unwrap_or(self.default_value)
    }

    pub fn get_simd(&self, index: usize) -> f32x4 {
        match self.buffer {
            Some(buffer) if index + 4 <= buffer.len() => {
                f32x4::from_slice(&buffer[index..index + 4])
            }
            Some(buffer) => {
                let mut values = [self.default_value; 4];
                for i in 0..4 {
                    if index + i < buffer.len() {
                        values[i] = buffer[index + i];
                    }
                }
                f32x4::from_array(values)
            }
            None => f32x4::splat(self.default_value),
        }
    }
}

pub struct AudioOutput<'a> {
    pub(crate) buffer: &'a mut [f32],
}

impl<'a> AudioOutput<'a> {
    pub fn new(buffer: &'a mut [f32]) -> Self {
        Self { buffer }
    }

    pub fn write_simd(&mut self, index: usize, values: f32x4) {
        if index + 4 <= self.buffer.len() {
            values.copy_to_slice(&mut self.buffer[index..index + 4]);
        } else {
            let array = values.to_array();
            for i in 0..self.buffer.len().saturating_sub(index) {
                self.buffer[index + i] = array[i];
            }
        }
    }
}
