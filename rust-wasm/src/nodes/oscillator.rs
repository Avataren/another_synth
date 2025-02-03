use std::any::Any;
use std::collections::HashMap;
use std::simd::{f32x4, StdFloat};
use wasm_bindgen::prelude::wasm_bindgen;
use web_sys::console;

use crate::graph::{ModulationProcessor, ModulationSource, ModulationType};
use crate::traits::{AudioNode, PortId};

#[wasm_bindgen]
pub struct OscillatorStateUpdate {
    pub phase_mod_amount: f32,
    pub freq_mod_amount: f32,
    pub detune_oct: f32,
    pub detune_semi: f32,
    pub detune_cents: f32,
    pub detune: f32,
    pub hard_sync: bool,
    pub gain: f32,
    pub active: bool,
}

#[wasm_bindgen]
impl OscillatorStateUpdate {
    #[wasm_bindgen(constructor)]
    pub fn new(
        phase_mod_amount: f32,
        freq_mod_amount: f32,
        detune_oct: f32,
        detune_semi: f32,
        detune_cents: f32,
        detune: f32,
        hard_sync: bool,
        gain: f32,
        active: bool,
    ) -> Self {
        Self {
            phase_mod_amount,
            freq_mod_amount,
            detune_oct,
            detune_semi,
            detune_cents,
            detune,
            hard_sync,
            gain,
            active,
        }
    }
}

pub struct ModulatableOscillator {
    phase: f32,
    frequency: f32,
    phase_mod_amount: f32,
    freq_mod_amount: f32,
    detune: f32,
    gain: f32,
    sample_rate: f32,
    active: bool,
}

impl ModulatableOscillator {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            phase: 0.0,
            frequency: 440.0,
            phase_mod_amount: 1.0,
            freq_mod_amount: 1.0,
            detune: 0.0,
            gain: 1.0,
            sample_rate,
            active: true,
        }
    }

    pub fn update_params(&mut self, params: &OscillatorStateUpdate) {
        self.phase_mod_amount = params.phase_mod_amount;
        self.freq_mod_amount = params.freq_mod_amount;
        self.detune = params.detune;
        self.gain = params.gain;
        self.set_active(params.active);
    }

    fn get_detuned_frequency(&self, base_freq: f32) -> f32 {
        let multiplier = 2.0f32.powf(self.detune / 1200.0);
        base_freq * multiplier
    }
}

impl ModulationProcessor for ModulatableOscillator {
    fn get_modulation_type(&self, port: PortId) -> ModulationType {
        match port {
            PortId::FrequencyMod => ModulationType::Bipolar,
            PortId::PhaseMod => ModulationType::Additive,
            PortId::ModIndex => ModulationType::VCA,
            PortId::GainMod => ModulationType::VCA,
            _ => ModulationType::VCA,
        }
    }
}

impl AudioNode for ModulatableOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::GlobalFrequency, false);
        ports.insert(PortId::FrequencyMod, false);
        ports.insert(PortId::PhaseMod, false);
        ports.insert(PortId::ModIndex, false);
        ports.insert(PortId::GainMod, false);
        ports.insert(PortId::AudioOutput0, true);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        use std::simd::f32x4;
        const TWO_PI: f32 = 2.0 * std::f32::consts::PI;

        // Process modulations using the trait
        let freq_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::FrequencyMod),
            0.0,
            PortId::FrequencyMod,
        );
        let phase_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::PhaseMod),
            0.0,
            PortId::PhaseMod,
        );
        let gain_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::GainMod),
            1.0,
            PortId::GainMod,
        );
        let mod_index = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::ModIndex),
            1.0,
            PortId::ModIndex,
        );

        // Get base frequency directly from input
        let base_freq = if let Some(freq_sources) = inputs.get(&PortId::GlobalFrequency) {
            if !freq_sources.is_empty() {
                freq_sources[0].buffer.clone()
            } else {
                vec![self.frequency; buffer_size]
            }
        } else {
            vec![self.frequency; buffer_size]
        };

        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            for i in (0..buffer_size).step_by(4) {
                let end = (i + 4).min(buffer_size);

                // Get frequency chunk
                let mut freq_chunk = [0.0; 4];
                freq_chunk[0..end - i].copy_from_slice(&base_freq[i..end]);
                let base_freq = f32x4::from_array(freq_chunk);

                // Get modulation chunks
                let mut freq_mod_chunk = [0.0; 4];
                freq_mod_chunk[0..end - i].copy_from_slice(&freq_mod[i..end]);
                let freq_mod_chunk = f32x4::from_array(freq_mod_chunk);

                let mut phase_chunk = [0.0; 4];
                phase_chunk[0..end - i].copy_from_slice(&phase_mod[i..end]);
                let phase_mod_simd = f32x4::from_array(phase_chunk);

                let mut gain_chunk = [1.0; 4];
                gain_chunk[0..end - i].copy_from_slice(&gain_mod[i..end]);
                let gain_mod_chunk = f32x4::from_array(gain_chunk);

                let mut mod_index_chunk = [1.0; 4];
                mod_index_chunk[0..end - i].copy_from_slice(&mod_index[i..end]);
                let mod_index_vec = f32x4::from_array(mod_index_chunk);

                // Calculate modulated frequency
                let detuned_freq = f32x4::from_array([
                    self.get_detuned_frequency(base_freq.to_array()[0]),
                    self.get_detuned_frequency(base_freq.to_array()[1]),
                    self.get_detuned_frequency(base_freq.to_array()[2]),
                    self.get_detuned_frequency(base_freq.to_array()[3]),
                ]);

                let modulated_freq = detuned_freq * (f32x4::splat(1.0) + freq_mod_chunk);
                let phase_inc =
                    f32x4::splat(TWO_PI) * modulated_freq / f32x4::splat(self.sample_rate);

                // Generate phases
                let phases = f32x4::from_array([
                    self.phase,
                    self.phase + phase_inc.to_array()[0],
                    self.phase + phase_inc.to_array()[0] + phase_inc.to_array()[1],
                    self.phase
                        + phase_inc.to_array()[0]
                        + phase_inc.to_array()[1]
                        + phase_inc.to_array()[2],
                ]);

                // Apply phase modulation
                let phase_mod_depth = mod_index_vec * f32x4::splat(self.phase_mod_amount);
                let scaled_phase_mod = phase_mod_simd * phase_mod_depth;
                let modulated_phase = phases + scaled_phase_mod;

                // Generate final output
                let sine = modulated_phase.sin();
                let result = sine * f32x4::splat(self.gain) * gain_mod_chunk;

                // Write output
                let output_array = result.to_array();
                output[i..end].copy_from_slice(&output_array[0..end - i]);

                // Update phase
                self.phase += phase_inc.to_array()[0..end - i].iter().sum::<f32>();
                self.phase %= TWO_PI;
            }
        }
    }

    fn reset(&mut self) {
        self.phase = 0.0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn is_active(&self) -> bool {
        self.active
    }

    fn set_active(&mut self, active: bool) {
        self.active = active;
    }

    fn node_type(&self) -> &str {
        "oscillator"
    }
}
