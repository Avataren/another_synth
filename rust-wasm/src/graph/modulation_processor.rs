use super::ModulationSource;
use crate::{graph::ModulationType, PortId};
use std::simd::{f32x4, StdFloat};

pub trait ModulationProcessor {
    #[inline]
    fn get_modulation_type(&self, port: PortId) -> ModulationType {
        //this is not in use anymore! todo: remove and refactor nodes that use it
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
        _port: PortId,
    ) -> Vec<f32> {
        // If there are no sources, just return the base value.
        let sources = match sources {
            Some(s) if !s.is_empty() => s,
            _ => return vec![initial_value; buffer_size],
        };

        // We'll compute two vectors: one for multiplicative modulations and one for additive.
        let mut mult = vec![1.0; buffer_size];
        let mut add = vec![initial_value; buffer_size];

        for source in sources {
            match source.mod_type {
                ModulationType::VCA => {
                    for i in 0..buffer_size {
                        mult[i] *= source.buffer[i] * source.amount;
                    }
                }
                ModulationType::Bipolar => {
                    for i in 0..buffer_size {
                        mult[i] *= 1.0 + source.buffer[i] * source.amount;
                    }
                }
                ModulationType::Additive => {
                    for i in 0..buffer_size {
                        add[i] += source.buffer[i] * source.amount;
                    }
                }
                ModulationType::FrequencyCents => {
                    for i in 0..buffer_size {
                        let cents = source.buffer[i] * source.amount * 100.0;
                        mult[i] *= (cents / 1200.0).exp2();
                    }
                }
            }
        }

        // Combine additive and multiplicative contributions.
        let mut result = vec![0.0; buffer_size];
        for i in 0..buffer_size {
            result[i] = add[i] * mult[i];
        }
        result
    }
}
