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
                match source.mod_type {
                    ModulationType::VCA => {
                        for i in 0..buffer_size {
                            multiplicative[i] *= source.buffer[i] * source.amount;
                        }
                    }
                    ModulationType::Bipolar => {
                        for i in 0..buffer_size {
                            multiplicative[i] *= 1.0 + source.buffer[i] * source.amount;
                        }
                    }
                    ModulationType::Additive => {
                        for i in 0..buffer_size {
                            additive[i] += source.buffer[i] * source.amount;
                        }
                    }
                    ModulationType::FrequencyCents => {
                        for i in 0..buffer_size {
                            let cents = source.buffer[i] * source.amount * 100.0;
                            multiplicative[i] *= (cents / 1200.0).exp2();
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
