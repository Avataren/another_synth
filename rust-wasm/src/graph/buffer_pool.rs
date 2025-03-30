use std::collections::HashSet;

pub struct AudioBufferPool {
    pub buffers: Vec<Vec<f32>>,
    available: Vec<usize>,
    in_use: HashSet<usize>,
}

impl AudioBufferPool {
    pub fn new(buffer_size: usize, initial_capacity: usize) -> Self {
        let mut buffers = Vec::with_capacity(initial_capacity);
        let mut available = Vec::with_capacity(initial_capacity);
        let in_use = HashSet::with_capacity(initial_capacity); // Initialize empty HashSet

        // Initialize all buffers as available
        for i in 0..initial_capacity {
            buffers.push(vec![0.0; buffer_size]);
            available.push(i);
        }

        Self {
            buffers,
            available,
            in_use, // Initially empty since no buffers are in use
        }
    }

    pub(crate) fn get_buffer_mut(&mut self, index: usize) -> &mut Vec<f32> {
        &mut self.buffers[index]
    }

    pub fn acquire(&mut self, buffer_size: usize) -> usize {
        let index = if let Some(index) = self.available.pop() {
            index
        } else {
            let index = self.buffers.len();
            self.buffers.push(vec![0.0; buffer_size]);
            index
        };
        self.in_use.insert(index);
        index
    }

    pub fn get_multiple_buffers<'a>(
        &'a self,
        indices: &[usize],
    ) -> Result<Vec<(usize, &'a [f32])>, String> {
        let mut result = Vec::with_capacity(indices.len());
        let mut requested_indices = HashSet::new(); // To check for duplicates if necessary, though not strictly needed for immutable borrows

        for &idx in indices {
            if idx >= self.buffers.len() {
                return Err(format!(
                    "Immutable buffer index {} out of bounds (total: {})",
                    idx,
                    self.buffers.len()
                ));
            }
            if !requested_indices.insert(idx) {
                // Allow duplicate requests for immutable slices if needed,
                // or return error: return Err(format!("Duplicate index requested: {}", idx));
            }
            // Safety: Bounds check done above. Multiple immutable borrows are safe.
            result.push((idx, self.buffers[idx].as_slice()));
        }
        Ok(result)
    }

    pub fn get_multiple_buffers_mut<'a>(
        &'a mut self,
        indices: &[usize],
    ) -> Result<Vec<(usize, &'a mut [f32])>, String> {
        // Return Result for consistency
        let mut result = Vec::new();
        let mut requested_indices = HashSet::new(); // Check for duplicates is crucial here

        for &idx in indices {
            if idx >= self.buffers.len() {
                return Err(format!(
                    "Mutable buffer index {} out of bounds (total: {})",
                    idx,
                    self.buffers.len()
                ));
            }
            if !requested_indices.insert(idx) {
                // Cannot provide multiple mutable references to the same buffer
                return Err(format!("Duplicate mutable index requested: {}", idx));
            }
        }

        // All indices unique and bounds checked. Now get references using unsafe.
        for &idx in indices {
            // Safety: We checked for duplicates and bounds above.
            unsafe {
                let buffer = &mut *self.buffers.as_mut_ptr().add(idx);
                result.push((idx, buffer.as_mut_slice()));
            }
        }
        Ok(result)
    }

    pub fn release(&mut self, index: usize) {
        if self.in_use.remove(&index) {
            self.available.push(index);
        }
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

    pub fn release_all(&mut self) {
        // Clear the in-use set and mark all buffers as available
        self.in_use.clear();
        self.available.clear();
        for i in 0..self.buffers.len() {
            self.available.push(i);
        }
    }
}
