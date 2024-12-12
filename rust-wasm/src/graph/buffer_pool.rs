use std::collections::HashSet;

use web_sys::console;

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
            // console::log_1(&format!("Reusing buffer {} (in_use: {:?})", index, self.in_use).into());
            index
        } else {
            let index = self.buffers.len();
            // console::log_1(
            //     &format!("Creating new buffer {} (in_use: {:?})", index, self.in_use).into(),
            // );
            self.buffers.push(vec![0.0; buffer_size]);
            index
        };
        self.in_use.insert(index);
        // console::log_1(
        //     &format!(
        //         "After acquire: in_use={:?}, available={:?}",
        //         self.in_use, self.available
        //     )
        //     .into(),
        // );
        index
    }

    pub fn release(&mut self, index: usize) {
        if self.in_use.remove(&index) {
            // console::log_1(
            //     &format!(
            //         "Released buffer {} (in_use before: {:?})",
            //         index, self.in_use
            //     )
            //     .into(),
            // );
            self.available.push(index);
            // console::log_1(
            //     &format!(
            //         "After release: in_use={:?}, available={:?}",
            //         self.in_use, self.available
            //     )
            //     .into(),
            // );
        } else {
            // console::log_1(
            //     &format!(
            //         "Attempted to release already-released buffer {} (in_use: {:?})",
            //         index, self.in_use
            //     )
            //     .into(),
            // );
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

    pub fn get_multiple_buffers_mut<'a>(
        &'a mut self,
        indices: &[usize],
    ) -> Vec<(usize, &'a mut [f32])> {
        let mut result = Vec::new();

        // Handle the simple case - just one buffer
        if indices.len() == 1 {
            let idx = indices[0];
            if idx >= self.buffers.len() {
                panic!(
                    "Buffer index {} out of bounds (total: {})",
                    idx,
                    self.buffers.len()
                );
            }
            result.push((idx, self.buffers[idx].as_mut_slice()));
            return result;
        }

        // For multiple buffers, check if any are repeated
        for (i, &idx1) in indices.iter().enumerate() {
            for &idx2 in indices.iter().skip(i + 1) {
                if idx1 == idx2 {
                    panic!("Cannot get multiple mutable references to the same buffer");
                }
            }
        }

        // All indices are unique, we can get them one by one
        for &idx in indices {
            if idx >= self.buffers.len() {
                panic!(
                    "Buffer index {} out of bounds (total: {})",
                    idx,
                    self.buffers.len()
                );
            }
            // Safety: we checked for duplicates above, so this won't create aliasing refs
            unsafe {
                let buffer = &mut *self.buffers.as_mut_ptr().add(idx);
                result.push((idx, buffer.as_mut_slice()));
            }
        }

        result
    }
    // pub fn get_multiple_buffers_mut<'a>(
    //     &'a mut self,
    //     indices: &[usize],
    // ) -> Vec<(usize, &'a mut [f32])> {
    //     let mut result = Vec::new();
    //     console::log_1(
    //         &format!(
    //             "indices {:?}, buffer length: {:?}",
    //             indices,
    //             self.buffers.len()
    //         )
    //         .into(),
    //     );
    //     for &idx in indices {
    //         if idx >= self.buffers.len() {
    //             panic!(
    //                 "Buffer index {} out of bounds in get_multiple_buffers_mut",
    //                 idx
    //             );
    //         }
    //         let buffer = unsafe {
    //             // SAFETY: We ensure each index is accessed only once, and all indices are valid.
    //             &mut *self.buffers.as_mut_ptr().add(idx)
    //         };
    //         result.push((idx, buffer.as_mut_slice()));
    //     }

    //     result
    // }
}
