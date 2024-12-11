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

    pub fn get_multiple_buffers_mut<'a>(&'a mut self, indices: &[usize]) -> Vec<(usize, &'a mut [f32])> {
      // SAFETY: This is safe because we know:
      // 1. All indices are valid (enforced by the AudioGraph's buffer management)
      // 2. No indices are duplicated (enforced by the AudioGraph's node buffer allocation)
      // 3. The returned references won't outlive self
      let buffers_ptr = self.buffers.as_mut_ptr();

      indices.iter().map(|&idx| {
          unsafe {
              let buffer = &mut *buffers_ptr.add(idx);
              (idx, buffer.as_mut_slice())
          }
      }).collect()
  }
}
