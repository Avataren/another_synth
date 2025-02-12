use super::ModulationSource;
use crate::{graph::ModulationType, PortId};
use std::simd::{f32x4, StdFloat};

pub trait ModulationProcessor {
    #[inline]
    fn get_modulation_type(&self, port: PortId) -> ModulationType {
        match port {
            PortId::FrequencyMod => ModulationType::Bipolar,
            PortId::PhaseMod => ModulationType::Additive,
            PortId::ModIndex => ModulationType::Additive,
            PortId::GainMod | _ => ModulationType::VCA,
        }
    }

    fn process_modulations(
        &self,
        buffer_size: usize,
        sources: Option<&Vec<ModulationSource>>,
        initial_value: f32,
        port: PortId,
    ) -> Vec<f32> {
        let Some(sources) = sources else {
            return vec![initial_value; buffer_size];
        };
        if sources.is_empty() {
            return vec![initial_value; buffer_size];
        };

        // Determine proper starting value based on first modulation type
        // or mix of types
        let has_vca = sources
            .iter()
            .any(|s| matches!(s.mod_type, ModulationType::VCA));
        let has_bipolar = sources
            .iter()
            .any(|s| matches!(s.mod_type, ModulationType::Bipolar));
        let has_additive = sources
            .iter()
            .any(|s| matches!(s.mod_type, ModulationType::Additive));

        // For pure VCA/Bipolar modulation, start at 1.0
        // For pure additive modulation, start at initial_value
        // For mixed types, need both
        let starting_value = if has_vca || has_bipolar {
            1.0
        } else {
            initial_value
        };

        let mut output = vec![starting_value; buffer_size];
        let mut additive_accumulator = vec![0.0; buffer_size];

        // Process modulations by type
        for source in sources {
            match source.mod_type {
                ModulationType::VCA => {
                    for i in 0..buffer_size {
                        output[i] *= source.buffer[i] * source.amount;
                    }
                }
                ModulationType::Bipolar => {
                    for i in 0..buffer_size {
                        output[i] *= 1.0 + (source.buffer[i] * source.amount);
                    }
                }
                ModulationType::Additive => {
                    for i in 0..buffer_size {
                        additive_accumulator[i] += source.buffer[i] * source.amount;
                    }
                }
                ModulationType::FrequencyCents => {
                    for i in 0..buffer_size {
                        let cents = source.buffer[i] * source.amount * 100.0;
                        output[i] *= (cents / 1200.0).exp2();
                    }
                }
            }
        }

        // Final combination depends on what types we saw
        if has_additive {
            if has_vca || has_bipolar {
                // Mix multiplicative and additive
                for i in 0..buffer_size {
                    output[i] = output[i] * initial_value + additive_accumulator[i];
                }
            } else {
                // Pure additive
                for i in 0..buffer_size {
                    output[i] += additive_accumulator[i];
                }
            }
        }

        output
    }
}
