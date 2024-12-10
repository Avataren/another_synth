pub(crate) struct AudioBufferPool {
    buffers: Vec<Vec<f32>>,
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

    pub fn copy_in(&mut self, index: usize, data: &[f32]) {
        let buffer = &mut self.buffers[index];
        buffer[..data.len()].copy_from_slice(data);
    }

    pub fn copy_out(&self, index: usize) -> &[f32] {
        &self.buffers[index]
    }

    pub fn clear(&mut self, index: usize) {
        self.buffers[index].fill(0.0);
    }
}
