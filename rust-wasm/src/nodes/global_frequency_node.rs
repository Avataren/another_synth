#![feature(portable_simd)]

use core::simd::Simd;
use std::any::Any;
use std::collections::HashMap;

use crate::graph::{ModulationProcessor, ModulationSource};
use crate::{AudioNode, PortId}; // Assume this trait exists

/// GlobalFrequencyNode encapsulates the s‑rate frequency buffer and applies a detune factor.
/// The detune parameter (in cents) is modulated via the PortId::DetuneMod input.
pub struct GlobalFrequencyNode {
    base_frequency: Vec<f32>,
    /// Base detune value in cents.
    detune: f32,
}

impl GlobalFrequencyNode {
    /// Creates a new GlobalFrequencyNode with the given initial frequency and buffer size.
    pub fn new(initial_freq: f32, buffer_size: usize) -> Self {
        Self {
            base_frequency: vec![initial_freq; buffer_size],
            detune: 0.0,
        }
    }

    /// Sets the base (static) detune parameter in cents.
    pub fn set_detune(&mut self, detune: f32) {
        self.detune = detune;
    }

    /// Updates the base frequency buffer (for example, from host automation).
    pub fn set_base_frequency(&mut self, freq: &[f32]) {
        if freq.len() == 1 {
            // Fill the entire buffer with the single frequency value.
            self.base_frequency.fill(freq[0]);
        } else if freq.len() == self.base_frequency.len() {
            self.base_frequency.copy_from_slice(freq);
        } else {
            // Optionally, handle the case where a differently sized buffer is provided.
            // For now, fill the existing buffer.
            self.base_frequency.fill(freq[0]);
        }
    }
}

impl AudioNode for GlobalFrequencyNode {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        // This node outputs the global frequency signal.
        ports.insert(PortId::GlobalFrequency, true);
        // And it accepts modulation on its detune parameter.
        ports.insert(PortId::DetuneMod, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Get the output buffer for the global frequency.
        let output = outputs
            .get_mut(&PortId::GlobalFrequency)
            .expect("Expected GlobalFrequency output port");

        // Process the detune modulation using our dedicated modulation trait.
        // This call returns a Vec<f32> of effective detune values (in cents) per sample.
        let effective_detune =
            self.process_modulations(buffer_size, inputs.get(&PortId::DetuneMod), self.detune);

        // If no modulation is applied, we can optimize using SIMD.
        if inputs.get(&PortId::DetuneMod).is_none() {
            let constant_detune = self.detune;
            let detune_factor = 2.0_f32.powf(constant_detune / 1200.0);
            const LANES: usize = 4;
            type Vf32 = Simd<f32, LANES>;
            let factor = Vf32::splat(detune_factor);

            let mut i = 0;
            while i + LANES <= buffer_size {
                let freqs = Vf32::from_slice(&self.base_frequency[i..i + LANES]);
                let result = freqs * factor;
                output[i..i + LANES].copy_from_slice(&result.to_array());
                i += LANES;
            }
            for j in i..buffer_size {
                output[j] = self.base_frequency[j] * detune_factor;
            }
        } else {
            // When modulation is present, process sample-by-sample.
            for i in 0..buffer_size {
                let factor = 2.0_f32.powf(effective_detune[i] / 12.0); // modulate detune in semitones
                output[i] = self.base_frequency[i] * factor;
            }
        }
    }

    fn reset(&mut self) {
        // No dynamic state to reset for this node.
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn is_active(&self) -> bool {
        true
    }
    fn set_active(&mut self, _active: bool) {
        // Always active.
    }
    fn node_type(&self) -> &str {
        "global_frequency"
    }
}

/// Implement the modulation trait so we can use process_modulations
impl ModulationProcessor for GlobalFrequencyNode {}
