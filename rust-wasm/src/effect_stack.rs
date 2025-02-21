use std::collections::HashMap;

use crate::{
    graph::{AudioBufferPool, ModulationSource, ModulationType},
    AudioNode, PortId,
};

pub struct Effect {
    pub node: Box<dyn AudioNode>,
    enabled: bool,
}

pub struct EffectStack {
    pub effects: Vec<Effect>,
    buffer_pool: AudioBufferPool,
    buffer_size: usize,
    input_buffer_left: Vec<f32>,
    input_buffer_right: Vec<f32>,
}

impl EffectStack {
    pub fn new(buffer_size: usize) -> Self {
        Self {
            effects: Vec::new(),
            buffer_pool: AudioBufferPool::new(buffer_size, 32),
            buffer_size,
            input_buffer_left: vec![0.0; buffer_size],
            input_buffer_right: vec![0.0; buffer_size],
        }
    }

    pub fn add_effect(&mut self, effect: Box<dyn AudioNode>) -> usize {
        let index = self.effects.len();
        self.effects.push(Effect {
            node: effect,
            enabled: true,
        });
        index
    }

    pub fn remove_effect(&mut self, index: usize) {
        if index < self.effects.len() {
            self.effects.remove(index);
        }
    }

    pub fn reorder_effects(&mut self, from: usize, to: usize) {
        if from < self.effects.len() && to < self.effects.len() {
            let effect = self.effects.remove(from);
            self.effects.insert(to, effect);
        }
    }

    pub fn set_effect_enabled(&mut self, index: usize, enabled: bool) {
        if let Some(effect) = self.effects.get_mut(index) {
            effect.enabled = enabled;
        }
    }

    pub fn get_effect_count(&self) -> usize {
        self.effects.len()
    }

    pub fn process_audio(
        &mut self,
        input_left: &[f32],
        input_right: &[f32],
        output_left: &mut [f32],
        output_right: &mut [f32],
    ) {
        // Skip processing if no effects
        if self.effects.iter().all(|e| !e.enabled) {
            output_left.copy_from_slice(input_left);
            output_right.copy_from_slice(input_right);
            return;
        }

        // First copy input to working buffers
        self.input_buffer_left.copy_from_slice(input_left);
        self.input_buffer_right.copy_from_slice(input_right);

        // Process each effect
        let mut current_left = &self.input_buffer_left[..];
        let mut current_right = &self.input_buffer_right[..];

        for effect in &mut self.effects {
            if !effect.enabled {
                continue;
            }

            let mut inputs = HashMap::new();
            inputs.insert(
                PortId::AudioInput0,
                vec![ModulationSource {
                    buffer: current_left.to_vec(),
                    amount: 1.0,
                    mod_type: ModulationType::Additive,
                }],
            );
            inputs.insert(
                PortId::AudioInput1,
                vec![ModulationSource {
                    buffer: current_right.to_vec(),
                    amount: 1.0,
                    mod_type: ModulationType::Additive,
                }],
            );

            let mut outputs = HashMap::new();
            outputs.insert(PortId::AudioOutput0, &mut *output_left);
            outputs.insert(PortId::AudioOutput1, &mut *output_right);

            // Process the effect
            effect.node.process(&inputs, &mut outputs, self.buffer_size);

            // Update current buffers to read from outputs next time
            current_left = output_left;
            current_right = output_right;
        }
    }
}
