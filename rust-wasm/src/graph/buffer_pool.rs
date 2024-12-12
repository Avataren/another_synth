pub struct AudioBufferPool {
    pub buffers: Vec<Vec<f32>>,
    available: Vec<usize>,
}

impl AudioBufferPool {
    pub fn new(buffer_size: usize, initial_capacity: usize) -> Self {
        let mut buffers = Vec::with_capacity(initial_capacity);
        let mut available = Vec::with_capacity(initial_capacity);

        for i in 0..initial_capacity {
            buffers.push(vec![0.0; buffer_size]);
            available.push(i);
        }

        Self { buffers, available }
    }

    pub(crate) fn get_buffer_mut(&mut self, index: usize) -> &mut Vec<f32> {
        &mut self.buffers[index]
    }

    pub fn acquire(&mut self, buffer_size: usize) -> usize {
        if let Some(index) = self.available.pop() {
            index
        } else {
            let index = self.buffers.len();
            self.buffers.push(vec![0.0; buffer_size]);
            index
        }
    }

    pub fn release(&mut self, index: usize) {
        self.available.push(index);
    }

    pub fn fill(&mut self, index: usize, value: f32) {
        self.buffers[index].fill(value);
    }

    // pub fn copy_in(&mut self, index: usize, data: &[f32]) {
    //     let buffer = &mut self.buffers[index];
    //     buffer[..data.len()].copy_from_slice(data);
    // }

    // pub fn copy_out(&self, index: usize) -> &[f32] {
    //     &self.buffers[index]
    // }
    pub fn copy_in(&mut self, index: usize, data: &[f32]) {
        if index >= self.buffers.len() {
            panic!(
                "Buffer index {} out of bounds. Total buffers: {}",
                index,
                self.buffers.len()
            );
        }

        let buffer = &mut self.buffers[index];
        if data.len() > buffer.len() {
            panic!(
                "Data size {} exceeds buffer size {} at index {}",
                data.len(),
                buffer.len(),
                index
            );
        }

        buffer[..data.len()].copy_from_slice(data);
    }

    pub fn copy_out(&self, index: usize) -> &[f32] {
        if index >= self.buffers.len() {
            // Return empty slice if index is invalid
            &[]
        } else {
            &self.buffers[index]
        }
    }

    pub fn clear(&mut self, index: usize) {
        self.buffers[index].fill(0.0);
    }

    pub fn get_multiple_buffers_mut<'a>(
        &'a mut self,
        indices: &[usize],
    ) -> Vec<(usize, &'a mut [f32])> {
        let mut result = Vec::new();

        for &idx in indices {
            if idx >= self.buffers.len() {
                panic!(
                    "Buffer index {} out of bounds in get_multiple_buffers_mut",
                    idx
                );
            }

            let buffer = unsafe {
                // SAFETY: We ensure each index is accessed only once, and all indices are valid.
                &mut *self.buffers.as_mut_ptr().add(idx)
            };
            result.push((idx, buffer.as_mut_slice()));
        }

        result
    }
}
