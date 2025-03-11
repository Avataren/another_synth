use crate::graph::ModulationType;

use super::ModulationSource;

pub struct ModulationResult {
    pub additive: Vec<f32>,
    pub multiplicative: Vec<f32>,
}

pub trait ModulationProcessor {
    fn process_modulations(
        &self,
        buffer_size: usize,
        sources: Option<&Vec<ModulationSource>>,
        initial_value: f32,
    ) -> Vec<f32> {
        let mut mult = vec![1.0; buffer_size];
        let mut add = vec![0.0; buffer_size];

        if let Some(sources) = sources {
            for source in sources {
                for i in 0..buffer_size {
                    let value = source.transformation.apply(source.buffer[i]);
                    match source.mod_type {
                        ModulationType::VCA => {
                            mult[i] *= value * source.amount;
                        }
                        ModulationType::Bipolar => {
                            mult[i] *= 1.0 + value * source.amount;
                        }
                        ModulationType::Additive => {
                            add[i] += value * source.amount;
                        }
                    }
                }
            }
        }

        let mut result = vec![0.0; buffer_size];
        for i in 0..buffer_size {
            result[i] = (add[i] + initial_value) * mult[i];
        }
        result
    }

    fn process_modulations_ex(
        &self,
        buffer_size: usize,
        sources: Option<&Vec<ModulationSource>>,
    ) -> ModulationResult {
        let mut additive = vec![0.0; buffer_size];
        let mut multiplicative = vec![1.0; buffer_size];

        if let Some(sources) = sources {
            for source in sources {
                for i in 0..buffer_size {
                    let value = source.transformation.apply(source.buffer[i]);
                    match source.mod_type {
                        ModulationType::VCA => {
                            multiplicative[i] *= value * source.amount;
                        }
                        ModulationType::Bipolar => {
                            multiplicative[i] *= 1.0 + value * source.amount;
                        }
                        ModulationType::Additive => {
                            additive[i] += value * source.amount;
                        }
                    }
                }
            }
        }

        ModulationResult {
            additive,
            multiplicative,
        }
    }
}
