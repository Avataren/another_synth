use super::types::{ModulationMacro, ModulationTarget};
use crate::graph::AudioBufferPool;
use crate::PortId;
use std::collections::HashMap;
use std::simd::f32x4;

#[derive(Debug)]
pub struct MacroManager {
    macros: Vec<ModulationMacro>,
    buffer_pool: Option<*mut AudioBufferPool>,
    buffer_size: usize,
}

impl MacroManager {
    pub fn new(num_macros: usize, buffer_pool: &mut AudioBufferPool, buffer_size: usize) -> Self {
        let mut macros = Vec::with_capacity(num_macros);

        // Allocate and initialize buffers for each macro
        for i in 0..num_macros {
            let buffer_idx = buffer_pool.acquire(buffer_size);
            // Initialize buffer to zeros
            buffer_pool.fill(buffer_idx, 0.0);
            macros.push(ModulationMacro::new(buffer_idx));
        }

        Self {
            macros,
            buffer_pool: Some(buffer_pool as *mut AudioBufferPool),
            buffer_size,
        }
    }

    pub fn has_active_macros(&self) -> bool {
        self.macros.iter().any(|m| !m.get_targets().is_empty())
    }

    pub fn add_modulation(
        &mut self,
        macro_index: usize,
        target: ModulationTarget,
    ) -> Result<(), String> {
        self.macros
            .get_mut(macro_index)
            .ok_or_else(|| "Invalid macro index".to_string())
            .map(|macro_mod| macro_mod.add_target(target))
    }

    pub fn update_macro(&mut self, macro_index: usize, values: &[f32]) -> Result<(), String> {
        if values.is_empty() {
            return Ok(());
        }

        // Validate macro index first
        let macro_mod = self
            .macros
            .get(macro_index)
            .ok_or_else(|| format!("Invalid macro index: {}", macro_index))?;

        let buffer_idx = macro_mod.get_value_buffer_idx();

        if let Some(pool_ptr) = self.buffer_pool {
            unsafe {
                // Validate pool pointer
                if pool_ptr.is_null() {
                    return Err("Buffer pool pointer is null".to_string());
                }

                let pool = &mut *pool_ptr;

                // Safety check: validate buffer index
                if buffer_idx >= pool.buffers.len() {
                    return Err(format!(
                        "Buffer index {} out of bounds (pool size: {})",
                        buffer_idx,
                        pool.buffers.len()
                    ));
                }

                // Safety check: validate buffer sizes
                let dest_buffer_size = pool.buffers[buffer_idx].len();
                if values.len() > dest_buffer_size {
                    return Err(format!(
                        "Source values too large: {} vs buffer size: {}",
                        values.len(),
                        dest_buffer_size
                    ));
                }

                // Prepare temporary buffer of the correct size
                let mut temp_buffer = vec![0.0; dest_buffer_size];
                let copy_len = values.len().min(dest_buffer_size);
                temp_buffer[..copy_len].copy_from_slice(&values[..copy_len]);

                // Copy into the buffer pool
                pool.copy_in(buffer_idx, &temp_buffer);
            }
        } else {
            return Err("Buffer pool is uninitialized".to_string());
        }

        Ok(())
    }

    pub fn get_macro_max_value(&self, macro_index: usize) -> f32 {
        if let Some(macro_mod) = self.macros.get(macro_index) {
            if let Some(pool) = self.buffer_pool {
                unsafe {
                    let buffer = (*pool).copy_out(macro_mod.get_value_buffer_idx());
                    buffer.iter().fold(0.0f32, |max, &val| max.max(val))
                }
            } else {
                0.0
            }
        } else {
            0.0
        }
    }

    pub fn process_modulation(&self, offset: usize, inputs: &mut HashMap<PortId, &mut [f32]>) {
        use web_sys::console;

        // if offset == 0 {
        //     for macro_mod in &self.macros {
        //         for target in macro_mod.get_targets() {
        //             console::log_3(
        //                 &"Macro target:".into(),
        //                 &format!("{:?}", target.port_id).into(),
        //                 &target.amount.into(),
        //             );
        //         }
        //     }
        // }

        if self.macros.iter().all(|m| m.get_targets().is_empty()) {
            return;
        }
        // Skip processing if offset is beyond buffer size
        if offset >= self.buffer_size {
            return;
        }

        unsafe {
            if let Some(pool) = self.buffer_pool {
                for (i, macro_mod) in self.macros.iter().enumerate() {
                    let buffer_idx = macro_mod.get_value_buffer_idx();
                    let buffer = (*pool).copy_out(buffer_idx);

                    // Skip if buffer is empty
                    if buffer.is_empty() {
                        continue;
                    }

                    let remaining = buffer.len() - offset;
                    let chunk_size = remaining.min(4);

                    let mut values = [0.0f32; 4];
                    values[..chunk_size].copy_from_slice(&buffer[offset..offset + chunk_size]);
                    let value = f32x4::from_array(values);

                    for target in macro_mod.get_targets() {
                        if let Some(input_buffer) = inputs.get_mut(&target.port_id) {
                            if offset < input_buffer.len() {
                                let amount_simd = f32x4::splat(target.amount);
                                let modulated = value * amount_simd;

                                let out_remaining = input_buffer.len() - offset;
                                let out_chunk_size = out_remaining.min(chunk_size);
                                let mod_array = modulated.to_array();

                                input_buffer[offset..offset + out_chunk_size]
                                    .copy_from_slice(&mod_array[..out_chunk_size]);
                            }
                        }
                    }
                }
            }
        }
    }

    pub fn clear(&mut self) {
        unsafe {
            if let Some(pool) = self.buffer_pool {
                for macro_mod in &self.macros {
                    (*pool).clear(macro_mod.get_value_buffer_idx());
                }
            }
        }
    }
}

impl Drop for MacroManager {
    fn drop(&mut self) {
        unsafe {
            if let Some(pool) = self.buffer_pool.take() {
                for macro_mod in &self.macros {
                    (*pool).release(macro_mod.get_value_buffer_idx());
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::graph::AudioBufferPool;
    use crate::NodeId;

    // Helper function to create AudioBufferPool for tests
    fn create_test_buffer_pool(buffer_size: usize) -> AudioBufferPool {
        AudioBufferPool::new(buffer_size, 16) // 16 initial buffers should be enough for tests
    }

    #[test]
    fn test_macro_initialization() {
        let mut buffer_pool = create_test_buffer_pool(128);
        let manager = MacroManager::new(4, &mut buffer_pool, 128);

        assert_eq!(manager.macros.len(), 4, "Should create 4 macros");

        // Check initial buffer values
        unsafe {
            if let Some(pool) = manager.buffer_pool {
                for macro_mod in &manager.macros {
                    let buffer = (*pool).copy_out(macro_mod.get_value_buffer_idx());
                    assert!(
                        buffer.iter().all(|&x| x == 0.0),
                        "Buffers should initialize to zero"
                    );
                }
            }
        }
    }

    #[test]
    fn test_macro_target_addition() {
        let mut buffer_pool = create_test_buffer_pool(128);
        let mut manager = MacroManager::new(4, &mut buffer_pool, 128);

        let target = ModulationTarget {
            node_id: NodeId(0),
            port_id: PortId::FrequencyMod,
            amount: 1.0,
        };

        assert!(manager.add_modulation(0, target.clone()).is_ok());

        assert_eq!(
            manager.macros[0].get_targets().len(),
            1,
            "Target should be added to macro"
        );

        assert!(manager.add_modulation(4, target.clone()).is_err());
    }

    #[test]
    fn test_macro_value_update() {
        let mut buffer_pool = create_test_buffer_pool(128);
        let mut manager = MacroManager::new(4, &mut buffer_pool, 128);
        let test_values = vec![0.5; 64];

        assert!(manager.update_macro(0, &test_values).is_ok());

        unsafe {
            if let Some(pool) = manager.buffer_pool {
                let buffer = (*pool).copy_out(manager.macros[0].get_value_buffer_idx());
                assert_eq!(
                    &buffer[..64],
                    test_values.as_slice(),
                    "Buffer should contain updated values"
                );
                assert!(
                    buffer[64..].iter().all(|&x| x == 0.0),
                    "Remaining buffer should be zero"
                );
            }
        }
    }

    #[test]
    fn test_macro_modulation_processing() {
        let mut buffer_pool = create_test_buffer_pool(128);
        let mut manager = MacroManager::new(4, &mut buffer_pool, 128);
        let mut target_buffer = vec![0.0; 128];
        let mut inputs = HashMap::new();

        let target = ModulationTarget {
            node_id: NodeId(0),
            port_id: PortId::FrequencyMod,
            amount: 0.5,
        };

        manager.add_modulation(0, target).unwrap();
        manager.update_macro(0, &vec![1.0; 128]).unwrap();

        // Create slice reference from Vec
        inputs.insert(PortId::FrequencyMod, target_buffer.as_mut_slice());
        manager.process_modulation(0, &mut inputs);

        assert_eq!(
            target_buffer[0], 0.5,
            "Modulation should apply correct amount"
        );
    }

    #[test]
    fn test_empty_macro_processing() {
        let mut buffer_pool = create_test_buffer_pool(128);
        let manager = MacroManager::new(4, &mut buffer_pool, 128);
        let mut target_buffer = vec![0.0; 128];
        let mut inputs = HashMap::new();

        // Create slice reference from Vec
        inputs.insert(PortId::FrequencyMod, target_buffer.as_mut_slice());

        // This should not panic
        manager.process_modulation(0, &mut inputs);

        assert!(target_buffer.iter().all(|&x| x == 0.0));
    }

    #[test]
    fn test_modulation_bounds() {
        let mut buffer_pool = create_test_buffer_pool(128);
        let mut manager = MacroManager::new(4, &mut buffer_pool, 128);
        let mut target_buffer = vec![0.0; 64]; // Smaller than macro buffer
        let mut inputs = HashMap::new();

        let target = ModulationTarget {
            node_id: NodeId(0),
            port_id: PortId::FrequencyMod,
            amount: 1.0,
        };

        manager.add_modulation(0, target).unwrap();
        manager.update_macro(0, &vec![1.0; 128]).unwrap();

        // Create slice reference from Vec
        inputs.insert(PortId::FrequencyMod, target_buffer.as_mut_slice());

        // Should handle mismatched buffer sizes without panicking
        manager.process_modulation(0, &mut inputs);
        manager.process_modulation(60, &mut inputs);
    }

    #[test]
    fn test_simd_chunk_processing() {
        let mut buffer_pool = create_test_buffer_pool(128);
        let mut manager = MacroManager::new(4, &mut buffer_pool, 128);
        let mut target_buffer = vec![0.0; 128];
        let mut inputs = HashMap::new();

        let target = ModulationTarget {
            node_id: NodeId(0),
            port_id: PortId::FrequencyMod,
            amount: 1.0,
        };

        let test_values: Vec<f32> = (0..128).map(|i| i as f32 / 128.0).collect();

        manager.add_modulation(0, target).unwrap();
        manager.update_macro(0, &test_values).unwrap();

        // Create slice reference from Vec
        inputs.insert(PortId::FrequencyMod, target_buffer.as_mut_slice());

        manager.process_modulation(0, &mut inputs);

        for i in 0..4 {
            assert_eq!(target_buffer[i], test_values[i]);
        }
    }
    #[test]
    fn test_macro_partial_update() {
        let mut buffer_pool = create_test_buffer_pool(128);
        let mut manager = MacroManager::new(4, &mut buffer_pool, 128);

        // Test updating with fewer values than buffer size
        let test_values = vec![0.5; 28];
        assert!(manager.update_macro(0, &test_values).is_ok());

        unsafe {
            if let Some(pool) = manager.buffer_pool {
                let buffer = (*pool).copy_out(manager.macros[0].get_value_buffer_idx());
                // First 28 values should be 0.5
                assert!(buffer[..28].iter().all(|&x| x == 0.5));
                // Rest should be 0.0
                assert!(buffer[28..].iter().all(|&x| x == 0.0));
            }
        }

        // Test updating with empty values (should not crash)
        assert!(manager.update_macro(0, &[]).is_ok());
    }
}
