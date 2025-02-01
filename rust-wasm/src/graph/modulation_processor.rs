use crate::{graph::ModulationType, PortId};

use super::ModulationSource;

pub trait ModulationProcessor {
    // Allow nodes to specify what type of modulation to use for each port
    fn get_modulation_type(&self, port: PortId) -> ModulationType {
        match port {
            PortId::FrequencyMod => ModulationType::Bipolar,
            PortId::PhaseMod => ModulationType::Additive,
            PortId::ModIndex => ModulationType::VCA,
            PortId::GainMod => ModulationType::VCA,
            _ => ModulationType::VCA,
        }
    }

    fn process_modulations(
        &self,
        buffer_size: usize,
        sources: Option<&Vec<ModulationSource>>,
        initial_value: f32,
        port: PortId,
    ) -> Vec<f32> {
        use std::simd::{f32x4, StdFloat};
        use web_sys::console;

        let mut output = vec![initial_value; buffer_size];

        if let Some(mod_sources) = sources {
            // console::log_1(&format!(
            //     "Processing modulation for port {:?}, sources: {}",
            //     port,
            //     mod_sources.len()
            // ).into());

            for source in mod_sources {
                // console::log_1(&format!(
                //     "Source - amount: {}, mod_type: {:?}, buffer[0]: {}",
                //     source.amount,
                //     source.mod_type,
                //     source.buffer[0]
                // ).into());

                for i in (0..buffer_size).step_by(4) {
                    let end = (i + 4).min(buffer_size);

                    let mut current_chunk = [initial_value; 4];
                    current_chunk[0..end - i].copy_from_slice(&output[i..end]);
                    let current = f32x4::from_array(current_chunk);

                    let mut mod_chunk = [0.0; 4];
                    mod_chunk[0..end - i].copy_from_slice(&source.buffer[i..end]);
                    let modulation = f32x4::from_array(mod_chunk);

                    // Use the port's preferred modulation type
                    let preferred_type = self.get_modulation_type(port);
                    let processed = match preferred_type {
                        ModulationType::VCA => current * modulation * f32x4::splat(source.amount),
                        ModulationType::Bipolar => {
                            current
                                * (f32x4::splat(1.0) + (modulation * f32x4::splat(source.amount)))
                        }
                        ModulationType::Additive => {
                            current + (modulation * f32x4::splat(source.amount))
                        }
                    };

                    output[i..end].copy_from_slice(&processed.to_array()[0..end - i]);
                }
            }
        }

        output
    }
}
