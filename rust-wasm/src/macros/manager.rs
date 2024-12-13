use super::types::{ModulationMacro, ModulationTarget};
use crate::graph::AudioBufferPool;
use crate::PortId;
use std::collections::HashMap;
use std::simd::f32x4;

#[derive(Debug)]
pub struct MacroManager {
    macros: Vec<ModulationMacro>,
    buffer_size: usize,
}

pub struct MacroData {
    // For each macro, store its targets and a copy of its entire buffer for this block
    // macros[i].0 = vector of targets, macros[i].1 = the macro's buffer values
    macros: Vec<(Vec<ModulationTarget>, Vec<f32>)>,
    buffer_size: usize,
}

impl MacroManager {
    pub fn new(num_macros: usize, buffer_pool: &mut AudioBufferPool, buffer_size: usize) -> Self {
        let mut macros = Vec::with_capacity(num_macros);

        for _ in 0..num_macros {
            let buffer_idx = buffer_pool.acquire(buffer_size);
            buffer_pool.fill(buffer_idx, 0.0);
            macros.push(ModulationMacro::new(buffer_idx));
        }

        Self {
            macros,
            buffer_size,
        }
    }

    pub fn add_modulation(
        &mut self,
        macro_index: usize,
        target: ModulationTarget,
    ) -> Result<(), String> {
        self.macros
            .get_mut(macro_index)
            .ok_or_else(|| format!("Invalid macro index: {}", macro_index))?
            .add_target(target);
        Ok(())
    }

    pub fn has_active_macros(&self) -> bool {
        self.macros.iter().any(|m| !m.get_targets().is_empty())
    }

    pub fn update_macro(
        &mut self,
        macro_index: usize,
        values: &[f32],
        buffer_pool: &mut AudioBufferPool,
    ) -> Result<(), String> {
        if values.is_empty() {
            return Ok(());
        }

        let macro_mod = self
            .macros
            .get(macro_index)
            .ok_or_else(|| format!("Invalid macro index: {}", macro_index))?;

        let buffer_idx = macro_mod.get_value_buffer_idx();
        if buffer_idx >= buffer_pool.buffers.len() {
            return Err(format!("Buffer index {} out of range", buffer_idx));
        }

        let dest_buffer_size = buffer_pool.buffers[buffer_idx].len();
        if values.len() > dest_buffer_size {
            return Err(format!(
                "Source values too large: {} vs buffer size: {}",
                values.len(),
                dest_buffer_size
            ));
        }

        let mut temp_buffer = vec![0.0; dest_buffer_size];
        temp_buffer[..values.len()].copy_from_slice(values);
        buffer_pool.copy_in(buffer_idx, &temp_buffer);

        Ok(())
    }

    pub fn clear(&mut self, buffer_pool: &mut AudioBufferPool) {
        for macro_mod in &self.macros {
            buffer_pool.clear(macro_mod.get_value_buffer_idx());
        }
    }

    /// Prepare all macro data for this block by copying it out from the buffer_pool once.
    pub fn prepare_macro_data(&self, buffer_pool: &AudioBufferPool) -> MacroData {
        let mut macros_data = Vec::with_capacity(self.macros.len());

        for m in &self.macros {
            let buffer_idx = m.get_value_buffer_idx();
            let buffer = buffer_pool.copy_out(buffer_idx).to_vec();
            let targets = m.get_targets().to_vec();
            macros_data.push((targets, buffer));
        }

        MacroData {
            macros: macros_data,
            buffer_size: self.buffer_size,
        }
    }

    /// Apply pre-fetched macro data to output buffers at a given offset.
    /// This does not access buffer_pool; it uses MacroData prepared beforehand.
    pub fn apply_modulation(
        &self,
        offset: usize,
        macro_data: &MacroData,
        outputs: &mut HashMap<PortId, &mut [f32]>,
    ) {
        if offset >= macro_data.buffer_size {
            return;
        }

        for (targets, buffer) in &macro_data.macros {
            if targets.is_empty() {
                continue;
            }

            if offset >= buffer.len() {
                continue;
            }

            let remaining = buffer.len() - offset;
            let chunk_size = remaining.min(4);
            let mut values = [0.0f32; 4];
            values[..chunk_size].copy_from_slice(&buffer[offset..offset + chunk_size]);

            let value = f32x4::from_array(values);

            for target in targets {
                if let Some(output_buffer) = outputs.get_mut(&target.port_id) {
                    if offset < output_buffer.len() {
                        let amount_simd = f32x4::splat(target.amount);
                        let modulated = value * amount_simd;

                        let out_remaining = output_buffer.len() - offset;
                        let out_chunk_size = out_remaining.min(chunk_size);

                        // Add modulation instead of replacing
                        for i in 0..out_chunk_size {
                            output_buffer[offset + i] += modulated.to_array()[i];
                        }
                    }
                }
            }
        }
    }
}
