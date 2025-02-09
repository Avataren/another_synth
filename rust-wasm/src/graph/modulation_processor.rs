use super::ModulationSource;
use crate::{graph::ModulationType, PortId};
use std::simd::{f32x4, StdFloat};

pub trait ModulationProcessor {
    #[inline]
    fn get_modulation_type(&self, port: PortId) -> ModulationType {
        match port {
            PortId::FrequencyMod => ModulationType::Bipolar,
            PortId::PhaseMod => ModulationType::Additive,
            PortId::ModIndex | PortId::GainMod | _ => ModulationType::VCA,
        }
    }

    fn process_modulations(
        &self,
        buffer_size: usize,
        sources: Option<&Vec<ModulationSource>>,
        initial_value: f32,
        port: PortId,
    ) -> Vec<f32> {
        let mut output = vec![initial_value; buffer_size];

        let Some(mod_sources) = sources else {
            return output;
        };
        if mod_sources.is_empty() {
            return output;
        };

        let preferred_type = self.get_modulation_type(port);
        let chunks = buffer_size / 4;
        let remainder = buffer_size % 4;

        // Process in SIMD chunks
        for source in mod_sources {
            let amount_splat = f32x4::splat(source.amount);

            // Pre-calculate constants for frequency cents
            let (cents_mul, div_1200) = if matches!(preferred_type, ModulationType::FrequencyCents)
            {
                (f32x4::splat(100.0), f32x4::splat(1200.0))
            } else {
                (f32x4::splat(0.0), f32x4::splat(0.0))
            };

            // Main SIMD loop
            for i in 0..chunks {
                let idx = i * 4;
                let current = f32x4::from_slice(&output[idx..]);
                let modulation = f32x4::from_slice(&source.buffer[idx..]);

                let processed = match preferred_type {
                    ModulationType::VCA => current * modulation * amount_splat,
                    ModulationType::FrequencyCents => {
                        let cents = modulation * amount_splat * cents_mul;
                        (cents / div_1200).exp2()
                    }
                    ModulationType::Bipolar => {
                        current * (f32x4::splat(1.0) + (modulation * amount_splat))
                    }
                    ModulationType::Additive => current + (modulation * amount_splat),
                };

                processed.copy_to_slice(&mut output[idx..idx + 4]);
            }

            // Handle remaining elements
            if remainder > 0 {
                let start = chunks * 4;
                for i in 0..remainder {
                    let idx = start + i;
                    let current = output[idx];
                    let modulation = source.buffer[idx];

                    output[idx] = match preferred_type {
                        ModulationType::VCA => current * modulation * source.amount,
                        ModulationType::FrequencyCents => {
                            let cents = modulation * source.amount * 100.0;
                            (cents / 1200.0).exp2()
                        }
                        ModulationType::Bipolar => current * (1.0 + (modulation * source.amount)),
                        ModulationType::Additive => current + (modulation * source.amount),
                    };
                }
            }
        }

        output
    }
}
