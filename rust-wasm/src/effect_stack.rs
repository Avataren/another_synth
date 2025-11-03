use rustc_hash::FxHashMap;

use crate::{
    graph::{ModulationSource, ModulationTransformation, ModulationType},
    AudioNode, PortId,
};

pub struct Effect {
    pub node: Box<dyn AudioNode>,
}

pub struct EffectStack {
    pub effects: Vec<Effect>,
}

impl EffectStack {
    pub fn new(_buffer_size: usize) -> Self {
        Self {
            effects: Vec::new(),
        }
    }

    pub fn add_effect(&mut self, effect: Box<dyn AudioNode>) -> usize {
        let index = self.effects.len();
        self.effects.push(Effect { node: effect });
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
            effect.node.set_active(enabled);
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
        // FIXED: Use actual buffer lengths instead of self.buffer_size
        let actual_buffer_size = input_left
            .len()
            .min(input_right.len())
            .min(output_left.len())
            .min(output_right.len());

        if actual_buffer_size == 0 {
            return;
        }

        // If all effects are disabled, bypass processing entirely.
        if self.effects.iter().all(|e| !e.node.is_active()) {
            output_left[..actual_buffer_size].copy_from_slice(&input_left[..actual_buffer_size]);
            output_right[..actual_buffer_size].copy_from_slice(&input_right[..actual_buffer_size]);
            return;
        }

        // Start with the input signal in local working buffers.
        // FIXED: Use actual_buffer_size instead of self.buffer_size
        let mut current_left = input_left[..actual_buffer_size].to_vec();
        let mut current_right = input_right[..actual_buffer_size].to_vec();

        // Process each effect in order.
        for effect in &mut self.effects {
            // FIXED: Allocate buffers with actual_buffer_size
            let mut next_left = vec![0.0; actual_buffer_size];
            let mut next_right = vec![0.0; actual_buffer_size];

            if effect.node.is_active() {
                let mut inputs = FxHashMap::default();
                inputs.insert(
                    PortId::AudioInput0,
                    vec![ModulationSource {
                        buffer: current_left.clone(),
                        amount: 1.0,
                        mod_type: ModulationType::Additive,
                        transformation: ModulationTransformation::None,
                    }],
                );
                inputs.insert(
                    PortId::AudioInput1,
                    vec![ModulationSource {
                        buffer: current_right.clone(),
                        amount: 1.0,
                        mod_type: ModulationType::Additive,
                        transformation: ModulationTransformation::None,
                    }],
                );

                let mut outputs = FxHashMap::default();
                outputs.insert(PortId::AudioOutput0, next_left.as_mut_slice());
                outputs.insert(PortId::AudioOutput1, next_right.as_mut_slice());

                // FIXED: Pass actual_buffer_size to the effect
                effect
                    .node
                    .process(&inputs, &mut outputs, actual_buffer_size);
            } else {
                // Bypass the disabled effect: simply copy the current signal.
                next_left.copy_from_slice(&current_left);
                next_right.copy_from_slice(&current_right);
            }

            // Use the output from this stage as the input to the next effect.
            current_left = next_left;
            current_right = next_right;
        }

        // Finally, write the processed (or bypassed) signal to the output buffers.
        output_left[..actual_buffer_size].copy_from_slice(&current_left);
        output_right[..actual_buffer_size].copy_from_slice(&current_right);

        // CRITICAL: Zero out any remaining samples to prevent garbage data
        if actual_buffer_size < output_left.len() {
            output_left[actual_buffer_size..].fill(0.0);
        }
        if actual_buffer_size < output_right.len() {
            output_right[actual_buffer_size..].fill(0.0);
        }
    }
}
