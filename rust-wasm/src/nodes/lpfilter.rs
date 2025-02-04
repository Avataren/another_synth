use std::any::Any;
use std::collections::HashMap;
use std::simd::f32x4;

use crate::graph::{ModulationProcessor, ModulationSource, ModulationType};
use crate::traits::{AudioNode, PortId};

/// A TPT (Two-Pole, Two-Integrator) state variable filter that lets you set
/// cutoff anywhere from 0 to 20 kHz and a normalized resonance from 0 to 1.
/// Here, resonance = 0 yields a Butterworth (no resonance) response and resonance = 1
/// gives maximum resonance (leading to self-oscillation at the extreme).
pub struct LpFilter {
    /// Sample rate (Hz)
    sample_rate: f32,
    /// Base cutoff (Hz) before modulation (0–20 kHz)
    base_cutoff: f32,
    /// Base resonance (normalized 0–1) before modulation
    base_resonance: f32,
    /// Smoothed cutoff
    cutoff: f32,
    /// Smoothed resonance
    resonance: f32,
    /// Enabled flag
    enabled: bool,
    // --- Filter state ---
    /// Band-pass state
    bp: f32,
    /// Low-pass state
    lp: f32,
    // --- Coefficients ---
    /// \(g = \tan(\pi \,fc/fs)\) (with fc clamped to 99% of Nyquist)
    g: f32,
    /// Feedback coefficient, computed as \(k = 2*(1-resonance)\).  
    /// Thus, resonance = 0 ⇒ k = 2 (Butterworth response, no peaking),  
    /// resonance = 1 ⇒ k = 0 (maximum resonance/self-oscillation).
    k: f32,
    /// Normalization factor: \(a = \frac{1}{1+g\,(g+k)}\)
    a: f32,
    /// Parameter smoothing factor (0.0 = immediate change)
    smoothing_factor: f32,
}

impl LpFilter {
    pub fn new(sample_rate: f32) -> Self {
        // Default parameters: cutoff = 1 kHz, resonance = 0 (no peak)
        let base_cutoff = 1000.0;
        let base_resonance = 0.0;
        let mut filter = Self {
            sample_rate,
            base_cutoff,
            base_resonance,
            cutoff: base_cutoff,
            resonance: base_resonance,
            enabled: true,
            bp: 0.0,
            lp: 0.0,
            g: 0.0,
            k: 0.0,
            a: 0.0,
            smoothing_factor: 0.1,
        };
        filter.update_coefficients();
        filter
    }

    /// Set the base cutoff (0–20 kHz) and resonance (0–1, normalized).
    pub fn set_params(&mut self, cutoff: f32, resonance: f32) {
        self.base_cutoff = cutoff.clamp(0.0, 20000.0);
        self.base_resonance = resonance.clamp(0.0, 1.0);
    }

    /// Update coefficients based on the current (smoothed) cutoff and resonance.
    #[inline]
    fn update_coefficients(&mut self) {
        let nyquist = self.sample_rate / 2.0;
        // Clamp the cutoff to 99% of Nyquist to avoid extreme tan() values.
        let fc = self.cutoff.clamp(0.0, nyquist * 0.99);
        self.g = (std::f32::consts::PI * fc / self.sample_rate).tan();
        // Invert the resonance mapping:
        // For resonance = 0: k = 2.0 (Butterworth, minimal peak)
        // For resonance = 1: k = 0.0 (maximum resonance, self-oscillation threshold)
        self.k = 2.0 * (1.0 - self.resonance);
        self.a = 1.0 / (1.0 + self.g * (self.g + self.k));
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
        // Retrieve modulation buffers.
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

            // Process in blocks of 4 samples using SIMD for unpacking.
            // State propagation is handled sample-by-sample.
            for i in (0..buffer_size).step_by(4) {
                let end = (i + 4).min(buffer_size);
                let block_len = end - i;

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

                let input_arr = input_chunk.to_array();
                let cutoff_arr = cutoff_chunk.to_array();
                let resonance_arr = resonance_chunk.to_array();

                let mut output_chunk = [0.0f32; 4];

                for j in 0..block_len {
                    // Compute per-sample target parameters.
                    let target_cutoff = self.base_cutoff * cutoff_arr[j];
                    let target_resonance = self.base_resonance + resonance_arr[j];

                    // Smooth parameters.
                    self.cutoff += self.smoothing_factor * (target_cutoff - self.cutoff);
                    self.resonance += self.smoothing_factor * (target_resonance - self.resonance);
                    self.cutoff = self.cutoff.clamp(0.0, 20000.0);
                    self.resonance = self.resonance.clamp(0.0, 1.0);
                    self.update_coefficients();

                    let x = input_arr[j];

                    // TPT SVF equations:
                    //   hp = (x - lp - k*bp) * a
                    //   bp += g * hp
                    //   lp += g * bp
                    let hp = (x - self.lp - self.k * self.bp) * self.a;
                    self.bp += self.g * hp;
                    self.lp += self.g * self.bp;

                    // Flush denormals.
                    if self.bp.abs() < DENORMAL_THRESHOLD {
                        self.bp = 0.0;
                    }
                    if self.lp.abs() < DENORMAL_THRESHOLD {
                        self.lp = 0.0;
                    }

                    output_chunk[j] = self.lp;
                }

                out_buffer[i..end].copy_from_slice(&output_chunk[..block_len]);
            }
        }
    }

    fn reset(&mut self) {
        self.bp = 0.0;
        self.lp = 0.0;
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
