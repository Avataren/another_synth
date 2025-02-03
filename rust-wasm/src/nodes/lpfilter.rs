use std::any::Any;
use std::collections::HashMap;
use std::simd::{f32x4, StdFloat};

use crate::graph::{ModulationProcessor, ModulationSource, ModulationType};
use crate::traits::{AudioNode, PortId};

pub struct LpFilter {
    sample_rate: f32,
    cutoff: f32,
    resonance: f32,
    enabled: bool,
    // State variables
    s1: f32,
    s2: f32,
    // Coefficients
    g: f32,  // frequency coefficient
    k: f32,  // resonance coefficient
    a1: f32, // feedback coefficient 1
    a2: f32, // feedback coefficient 2
    a3: f32, // feedback coefficient 3
}

impl LpFilter {
    pub fn new(sample_rate: f32) -> Self {
        let mut filter = Self {
            sample_rate,
            cutoff: 1000.0,
            resonance: 0.0,
            enabled: true,
            s1: 0.0,
            s2: 0.0,
            g: 0.0,
            k: 0.0,
            a1: 0.0,
            a2: 0.0,
            a3: 0.0,
        };
        filter.update_coefficients();
        filter
    }

    pub fn set_params(&mut self, cutoff: f32, resonance: f32) {
        self.cutoff = cutoff.clamp(20.0, 20000.0);
        self.resonance = resonance.clamp(0.0, 1.2);
        self.update_coefficients();
    }

    fn update_coefficients(&mut self) {
        // Calculate filter coefficients
        self.g = (std::f32::consts::PI * self.cutoff / self.sample_rate).tan();
        self.k = 2.0 - 2.0 * self.resonance;

        // Precalculate coefficients for efficiency
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
            PortId::GainMod => ModulationType::VCA,
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
        ports.insert(PortId::GainMod, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Helper function to process inputs for a port
        let process_input = |sources: Option<&Vec<ModulationSource>>, default: f32| -> Vec<f32> {
            let mut result = vec![default; buffer_size];

            if let Some(sources) = sources {
                for source in sources {
                    match source.mod_type {
                        ModulationType::Additive => {
                            for (res, &src) in result.iter_mut().zip(source.buffer.iter()) {
                                *res += src * source.amount;
                            }
                        }
                        ModulationType::Bipolar => {
                            for (res, &src) in result.iter_mut().zip(source.buffer.iter()) {
                                *res *= 1.0 + (src * source.amount);
                            }
                        }
                        ModulationType::VCA => {
                            for (res, &src) in result.iter_mut().zip(source.buffer.iter()) {
                                *res *= 1.0 + (src * source.amount);
                            }
                        }
                    }
                }
            }

            result
        };

        // Process all inputs
        let audio_in = process_input(inputs.get(&PortId::AudioInput0), 0.0);
        let cutoff_mod = process_input(inputs.get(&PortId::CutoffMod), 1.0);
        let resonance_mod = process_input(inputs.get(&PortId::ResonanceMod), 0.0);
        let gain_mod = process_input(inputs.get(&PortId::GainMod), 1.0);

        // Process in chunks
        for i in (0..buffer_size).step_by(4) {
            let end = (i + 4).min(buffer_size);

            // Convert inputs to SIMD
            let input = {
                let mut chunk = [0.0; 4];
                chunk[0..end - i].copy_from_slice(&audio_in[i..end]);
                f32x4::from_array(chunk)
            };

            let cutoff_mod = {
                let mut chunk = [1.0; 4];
                chunk[0..end - i].copy_from_slice(&cutoff_mod[i..end]);
                f32x4::from_array(chunk)
            };

            let resonance_mod = {
                let mut chunk = [0.0; 4];
                chunk[0..end - i].copy_from_slice(&resonance_mod[i..end]);
                f32x4::from_array(chunk)
            };

            let gain_mod = {
                let mut chunk = [1.0; 4];
                chunk[0..end - i].copy_from_slice(&gain_mod[i..end]);
                f32x4::from_array(chunk)
            };

            // Process each sample in the chunk
            let mut output = [0.0f32; 4];
            for j in 0..(end - i) {
                // Apply modulation and clamp values
                let cutoff = (self.cutoff * cutoff_mod.to_array()[j]).clamp(20.0, 20000.0);
                let resonance = (self.resonance + resonance_mod.to_array()[j]).clamp(0.0, 1.2);

                // Update coefficients if modulation changed them
                if cutoff != self.cutoff || resonance != self.resonance {
                    self.cutoff = cutoff;
                    self.resonance = resonance;
                    self.update_coefficients();
                }

                let x = input.to_array()[j];

                // State variable filter algorithm
                let hp = (x - self.k * self.s1 - self.s2) * self.a1;
                let bp = self.g * hp + self.s1;
                let lp = self.g * bp + self.s2;

                // Update state
                self.s1 = self.g * hp + bp;
                self.s2 = self.g * bp + lp;

                // Apply gain modulation to output
                output[j] = lp * gain_mod.to_array()[j];
            }

            // Write output
            if let Some(out_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                out_buffer[i..end].copy_from_slice(&output[0..end - i]);
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
