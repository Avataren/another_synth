use core::simd::Simd;
use std::any::Any;
use std::collections::HashMap;
use std::simd::StdFloat;

use crate::graph::{ModulationProcessor, ModulationSource};
use crate::{AudioNode, PortId};

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
            self.base_frequency.fill(freq[0]);
        } else if freq.len() == self.base_frequency.len() {
            self.base_frequency.copy_from_slice(freq);
        } else {
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
        let output = outputs
            .get_mut(&PortId::GlobalFrequency)
            .expect("Expected GlobalFrequency output port");

        // If no detune modulation is present, use the SIMD‑optimized branch.
        if inputs.get(&PortId::DetuneMod).is_none() {
            // The static detune is in cents.
            let detune_factor = 2.0_f32.powf(self.detune / 1200.0);
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
            // When modulation is present, process both additive and multiplicative modulations.
            // The additive modulation is now in semitones.
            let mod_result =
                self.process_modulations_ex(buffer_size, inputs.get(&PortId::DetuneMod));
            const LANES: usize = 4;
            type Vf32 = Simd<f32, LANES>;

            let mut i = 0;
            while i + LANES <= buffer_size {
                let additive = Vf32::from_slice(&mod_result.additive[i..i + LANES]);
                let multiplicative = Vf32::from_slice(&mod_result.multiplicative[i..i + LANES]);
                let base_freq = Vf32::from_slice(&self.base_frequency[i..i + LANES]);
                let static_detune = Vf32::splat(self.detune);

                // Convert additive (semitones) to cents by multiplying by 100.
                let additive_in_cents = additive * Vf32::splat(100.0);
                // Effective detune (in cents) is the static detune plus the additive modulation (converted to cents).
                let effective_detune = static_detune + additive_in_cents;
                // Convert effective detune (cents) to a scaling factor: factor = 2^(cents/1200)
                let exp_arg = effective_detune / Vf32::splat(1200.0);
                let detune_factor = exp_arg.exp2();
                let final_factor = detune_factor * multiplicative;
                let result = base_freq * final_factor;
                output[i..i + LANES].copy_from_slice(&result.to_array());
                i += LANES;
            }
            for j in i..buffer_size {
                // Convert additive (semitones) to cents.
                let additive_in_cents = mod_result.additive[j] * 100.0;
                let effective_detune = self.detune + additive_in_cents;
                let detune_factor = 2.0_f32.powf(effective_detune / 1200.0);
                output[j] = self.base_frequency[j] * detune_factor * mod_result.multiplicative[j];
            }
        }
    }

    fn reset(&mut self) {
        // No dynamic state to reset.
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

/// Implement the modulation trait so we can use process_modulations_ex.
impl ModulationProcessor for GlobalFrequencyNode {}
