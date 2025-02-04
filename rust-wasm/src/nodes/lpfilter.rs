use std::any::Any;
use std::collections::HashMap;
use std::simd::f32x4;

use crate::graph::{ModulationProcessor, ModulationSource, ModulationType};
use crate::traits::{AudioNode, PortId};

/// A low‑pass state variable filter that recalculates coefficients every sample,
/// applies parameter smoothing, and flushes denormals.
pub struct LpFilter {
    /// Sample rate (Hz)
    sample_rate: f32,
    /// Base cutoff (Hz) before modulation
    base_cutoff: f32,
    /// Base resonance before modulation
    base_resonance: f32,
    /// Current (smoothed) cutoff
    cutoff: f32,
    /// Current (smoothed) resonance
    resonance: f32,
    /// Enabled flag
    enabled: bool,
    // Filter state variables
    s1: f32,
    s2: f32,
    // Filter coefficients
    g: f32,
    k: f32,
    a1: f32,
    a2: f32,
    a3: f32,
    /// Smoothing factor (0.0 = immediate change)
    smoothing_factor: f32,
}

impl LpFilter {
    pub fn new(sample_rate: f32) -> Self {
        let base_cutoff = 10000.0;
        let base_resonance = 0.0;
        let mut filter = Self {
            sample_rate,
            base_cutoff,
            base_resonance,
            cutoff: base_cutoff,
            resonance: base_resonance,
            enabled: true,
            s1: 0.0,
            s2: 0.0,
            g: 0.0,
            k: 0.0,
            a1: 0.0,
            a2: 0.0,
            a3: 0.0,
            smoothing_factor: 0.01,
        };
        filter.update_coefficients();
        filter
    }

    /// Set the base cutoff and resonance (before modulation)
    pub fn set_params(&mut self, cutoff: f32, resonance: f32) {
        self.base_cutoff = cutoff.clamp(20.0, 20000.0);
        self.base_resonance = resonance.clamp(0.0, 1.2);
    }

    /// Update filter coefficients based on the current cutoff and resonance.
    #[inline]
    fn update_coefficients(&mut self) {
        self.g = (std::f32::consts::PI * self.cutoff / self.sample_rate).tan();
        self.k = 2.0 - 2.0 * self.resonance;
        let a = 1.0 / (1.0 + self.g * (self.g + self.k));
        self.a1 = self.g * a;
        self.a2 = self.g * self.a1;
        self.a3 = self.g * self.a2;
    }
}

impl ModulationProcessor for LpFilter {
    fn get_modulation_type(&self, port: PortId) -> ModulationType {
        match port {
            PortId::AudioInput0 => ModulationType::Additive,
            PortId::CutoffMod => ModulationType::VCA,
            PortId::ResonanceMod => ModulationType::Additive,
            _ => ModulationType::VCA,
        }
    }
}

impl AudioNode for LpFilter {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::AudioInput0, false);
        ports.insert(PortId::AudioOutput0, true);
        ports.insert(PortId::CutoffMod, false);
        ports.insert(PortId::ResonanceMod, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Obtain modulation buffers via the trait's process_modulations.
        let audio_in = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::AudioInput0),
            0.0,
            PortId::AudioInput0,
        );
        let cutoff_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::CutoffMod),
            1.0,
            PortId::CutoffMod,
        );
        let resonance_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::ResonanceMod),
            0.0,
            PortId::ResonanceMod,
        );

        const DENORMAL_THRESHOLD: f32 = 1e-20;

        if let Some(out_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
            let audio_in_slice = &audio_in[..];
            let cutoff_slice = &cutoff_mod[..];
            let resonance_slice = &resonance_mod[..];

            // Process samples in blocks of 4 using SIMD.
            for i in (0..buffer_size).step_by(4) {
                let end = (i + 4).min(buffer_size);
                let block_len = end - i;

                // Load SIMD chunks.
                let input_chunk = f32x4::from_array({
                    let mut arr = [0.0; 4];
                    arr[..block_len].copy_from_slice(&audio_in_slice[i..end]);
                    arr
                });
                let cutoff_chunk = f32x4::from_array({
                    let mut arr = [1.0; 4];
                    arr[..block_len].copy_from_slice(&cutoff_slice[i..end]);
                    arr
                });
                let resonance_chunk = f32x4::from_array({
                    let mut arr = [0.0; 4];
                    arr[..block_len].copy_from_slice(&resonance_slice[i..end]);
                    arr
                });

                // Convert SIMD vectors to arrays once for the inner loop.
                let cutoff_arr = cutoff_chunk.to_array();
                let resonance_arr = resonance_chunk.to_array();
                let input_arr = input_chunk.to_array();

                let mut output_chunk = [0.0f32; 4];

                for j in 0..block_len {
                    // Compute target parameters.
                    let target_cutoff = (self.base_cutoff * cutoff_arr[j]).clamp(20.0, 20000.0);
                    let target_resonance = (self.base_resonance + resonance_arr[j]).clamp(0.0, 1.2);

                    // Smoothly update parameters.
                    self.cutoff += self.smoothing_factor * (target_cutoff - self.cutoff);
                    self.resonance += self.smoothing_factor * (target_resonance - self.resonance);
                    self.update_coefficients();

                    let x = input_arr[j];

                    // State variable filter algorithm.
                    let hp = (x - self.k * self.s1 - self.s2) * self.a1;
                    let bp = self.g * hp + self.s1;
                    let lp = self.g * bp + self.s2;

                    // Update filter state.
                    self.s1 = self.g * hp + bp;
                    self.s2 = self.g * bp + lp;

                    // Flush denormals.
                    if self.s1.abs() < DENORMAL_THRESHOLD {
                        self.s1 = 0.0;
                    }
                    if self.s2.abs() < DENORMAL_THRESHOLD {
                        self.s2 = 0.0;
                    }

                    output_chunk[j] = lp;
                }

                out_buffer[i..end].copy_from_slice(&output_chunk[..block_len]);
            }
        }
    }

    fn reset(&mut self) {
        self.s1 = 0.0;
        self.s2 = 0.0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn is_active(&self) -> bool {
        self.enabled
    }
    fn set_active(&mut self, active: bool) {
        self.enabled = active;
    }
    fn node_type(&self) -> &str {
        "lpfilter"
    }
}
