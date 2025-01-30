use crate::graph::{ModulationSource, ModulationType};
// in src/nodes/lpfilter.rs
use crate::processing::{AudioProcessor, ProcessContext};
use crate::traits::{AudioNode, PortId};
use std::any::Any;
use std::collections::HashMap;

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
        // Allow resonance to go slightly above 1 for self-oscillation
        self.resonance = resonance.clamp(0.0, 1.2);
        self.update_coefficients();
    }

    fn update_coefficients(&mut self) {
        // Calculate filter coefficients
        // g = tan(π * cutoff / sampleRate)
        self.g = (std::f32::consts::PI * self.cutoff / self.sample_rate).tan();

        // k = 2.0 - 2.0 * resonance
        self.k = 2.0 - 2.0 * self.resonance;

        // Precalculate coefficients for efficiency
        let a = 1.0 / (1.0 + self.g * (self.g + self.k));
        self.a1 = self.g * a;
        self.a2 = self.g * self.a1;
        self.a3 = self.g * self.a2;
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
        audio_inputs: &HashMap<PortId, Vec<f32>>,
        mod_inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        use std::simd::{f32x4, StdFloat};

        // Process in chunks
        for i in (0..buffer_size).step_by(4) {
            let end = (i + 4).min(buffer_size);

            // Get input audio
            let mut input_chunk = [0.0; 4];
            if let Some(input) = audio_inputs.get(&PortId::AudioInput0) {
                input_chunk[0..end - i].copy_from_slice(&input[i..end]);
            }
            let input = f32x4::from_array(input_chunk);

            // Process modulations
            let mut cutoff_mod = [1.0; 4];
            let mut resonance_mod = [0.0; 4];
            let mut gain_mod = [1.0; 4];

            if let Some(sources) = mod_inputs.get(&PortId::CutoffMod) {
                for source in sources {
                    let mut chunk = [0.0; 4];
                    chunk[0..end - i].copy_from_slice(&source.buffer[i..end]);
                    let mod_chunk = f32x4::from_array(chunk);
                    let current = f32x4::from_array(cutoff_mod);

                    let processed = match source.mod_type {
                        ModulationType::VCA => {
                            f32x4::splat(1.0) + (mod_chunk * f32x4::splat(source.amount))
                        }
                        ModulationType::Bipolar => {
                            current
                                * (f32x4::splat(1.0) + (mod_chunk * f32x4::splat(source.amount)))
                        }
                        _ => current + (mod_chunk * f32x4::splat(source.amount)),
                    };
                    cutoff_mod.copy_from_slice(&processed.to_array());
                }
            }

            if let Some(sources) = mod_inputs.get(&PortId::ResonanceMod) {
                for source in sources {
                    let mut chunk = [0.0; 4];
                    chunk[0..end - i].copy_from_slice(&source.buffer[i..end]);
                    let mod_chunk = f32x4::from_array(chunk);
                    let current = f32x4::from_array(resonance_mod);

                    let processed = match source.mod_type {
                        ModulationType::Additive => {
                            current + (mod_chunk * f32x4::splat(source.amount))
                        }
                        _ => mod_chunk * f32x4::splat(source.amount),
                    };
                    resonance_mod.copy_from_slice(&processed.to_array());
                }
            }

            if let Some(sources) = mod_inputs.get(&PortId::GainMod) {
                for source in sources {
                    let mut chunk = [0.0; 4];
                    chunk[0..end - i].copy_from_slice(&source.buffer[i..end]);
                    let mod_chunk = f32x4::from_array(chunk);
                    let current = f32x4::from_array(gain_mod);

                    let processed = match source.mod_type {
                        ModulationType::VCA => {
                            f32x4::splat(1.0) + (mod_chunk * f32x4::splat(source.amount))
                        }
                        _ => current * mod_chunk * f32x4::splat(source.amount),
                    };
                    gain_mod.copy_from_slice(&processed.to_array());
                }
            }

            // Process each sample
            let mut output = [0.0f32; 4];
            for j in 0..(end - i) {
                // Apply modulation
                let cutoff = (self.cutoff * cutoff_mod[j]).clamp(20.0, 20000.0);
                let resonance = (self.resonance + resonance_mod[j]).clamp(0.0, 1.2);

                // Update coefficients if modulation is present
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

                // Output lowpass signal
                output[j] = lp * gain_mod[j];
            }

            // Write output
            if let Some(out_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                out_buffer[i..end].copy_from_slice(&output[0..end - i]);
            }
        }
    }

    // Other methods remain the same
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

impl AudioProcessor for LpFilter {
    fn get_default_values(&self) -> HashMap<PortId, f32> {
        let mut defaults = HashMap::new();
        defaults.insert(PortId::CutoffMod, 1.0);
        defaults.insert(PortId::ResonanceMod, 0.0);
        defaults.insert(PortId::GainMod, 1.0);
        defaults
    }

    fn process(&mut self, context: &mut ProcessContext) {
        use std::simd::{f32x4, StdFloat};

        context.process_by_chunks(4, |offset, inputs, outputs| {
            // Get input samples and modulation
            let input = inputs
                .get(&PortId::AudioInput0)
                .map_or(f32x4::splat(0.0), |input| input.get_simd(offset));

            let cutoff_mod = inputs
                .get(&PortId::CutoffMod)
                .map_or(f32x4::splat(1.0), |input| input.get_simd(offset));

            let resonance_mod = inputs
                .get(&PortId::ResonanceMod)
                .map_or(f32x4::splat(0.0), |input| input.get_simd(offset));

            let gain_mod = inputs
                .get(&PortId::GainMod)
                .map_or(f32x4::splat(1.0), |input| input.get_simd(offset));

            // Process each sample
            let mut output = [0.0f32; 4];
            for i in 0..4 {
                // Apply modulation
                let cutoff = (self.cutoff * cutoff_mod.to_array()[i]).clamp(20.0, 20000.0);
                let resonance = (self.resonance + resonance_mod.to_array()[i]).clamp(0.0, 1.2);

                // Update coefficients if modulation is present
                if cutoff != self.cutoff || resonance != self.resonance {
                    self.cutoff = cutoff;
                    self.resonance = resonance;
                    self.update_coefficients();
                }

                let x = input.to_array()[i];

                // State variable filter algorithm
                let hp = (x - self.k * self.s1 - self.s2) * self.a1;
                let bp = self.g * hp + self.s1;
                let lp = self.g * bp + self.s2;

                // Update state
                self.s1 = self.g * hp + bp;
                self.s2 = self.g * bp + lp;

                // Output lowpass signal
                output[i] = lp * gain_mod.to_array()[i];
            }

            // Write output
            if let Some(out_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                out_buffer.write_simd(offset, f32x4::from_array(output));
            }
        });
    }

    fn reset(&mut self) {
        self.s1 = 0.0;
        self.s2 = 0.0;
    }
}
