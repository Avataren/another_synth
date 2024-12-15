use wasm_bindgen::prelude::wasm_bindgen;

use crate::processing::{AudioProcessor, ProcessContext};
use crate::traits::{AudioNode, PortId};
use std::any::Any;
use std::collections::HashMap;
use std::usize;

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
    }

    fn get_detuned_frequency(&self, base_freq: f32) -> f32 {
        // Convert cents to frequency multiplier: 2^(cents/1200)
        let multiplier = 2.0f32.powf(self.detune / 1200.0);
        base_freq * multiplier
    }
}

impl AudioNode for ModulatableOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::GlobalFrequency, false);
        ports.insert(PortId::FrequencyMod, true);
        ports.insert(PortId::PhaseMod, true);
        ports.insert(PortId::GainMod, true);
        ports.insert(PortId::AudioOutput0, true);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, &[f32]>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        let default_values = self.get_default_values();
        let mut context = ProcessContext::new(inputs, outputs, buffer_size, &default_values);
        AudioProcessor::process(self, &mut context);
    }

    fn reset(&mut self) {
        AudioProcessor::reset(self);
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
}

impl AudioProcessor for ModulatableOscillator {
    fn get_default_values(&self) -> HashMap<PortId, f32> {
        let mut defaults = HashMap::new();
        defaults.insert(PortId::Frequency, self.frequency);
        defaults.insert(PortId::FrequencyMod, 0.0);
        defaults.insert(PortId::PhaseMod, 0.0);
        defaults.insert(PortId::ModIndex, 1.0);
        defaults.insert(PortId::GainMod, 1.0);
        defaults
    }

    fn process(&mut self, context: &mut ProcessContext) {
        use std::simd::{f32x4, StdFloat};

        context.process_by_chunks(4, |offset, inputs, outputs| {
            // Get base frequency and apply frequency modulation
            let base_freq = if let Some(input) = inputs.get(&PortId::GlobalFrequency) {
                input.get_simd(offset)
            } else {
                f32x4::splat(self.frequency)
            };

            // Apply detune
            let detuned_freq = f32x4::from_array([
                self.get_detuned_frequency(base_freq.to_array()[0]),
                self.get_detuned_frequency(base_freq.to_array()[1]),
                self.get_detuned_frequency(base_freq.to_array()[2]),
                self.get_detuned_frequency(base_freq.to_array()[3]),
            ]);

            let freq_mod = inputs
                .get(&PortId::FrequencyMod)
                .map_or(f32x4::splat(0.0), |input| input.get_simd(offset));

            let modulated_freq =
                detuned_freq * (f32x4::splat(1.0) + freq_mod * f32x4::splat(self.freq_mod_amount));

            // Calculate phase increment for each sample
            let phase_inc = f32x4::splat(2.0 * std::f32::consts::PI) * modulated_freq
                / f32x4::splat(self.sample_rate);

            // Get phase modulation and mod index
            let pm = inputs
                .get(&PortId::PhaseMod)
                .map_or(f32x4::splat(0.0), |input| input.get_simd(offset));

            let base_mod_index = self.get_default_values()[&PortId::ModIndex];
            let mod_index = if let Some(input) = inputs.get(&PortId::ModIndex) {
                let value = input.get_simd(offset);
                f32x4::splat(base_mod_index) + value
            } else {
                f32x4::splat(base_mod_index)
            };

            // Calculate modulated phase mod
            let modulated_pm = pm * mod_index * f32x4::splat(self.phase_mod_amount);

            // Calculate phases for the 4-sample chunk
            let mut phases = [0.0f32; 4];
            let two_pi = 2.0 * std::f32::consts::PI;

            for (i, phase) in phases.iter_mut().enumerate() {
                // Store the current phase plus modulation for output
                let current_phase = self.phase + modulated_pm.to_array()[i];
                *phase = current_phase;

                // Increment base phase for next sample (don't add modulation here)
                self.phase += phase_inc.to_array()[i];

                // Wrap phase between 0 and 2π
                while self.phase >= two_pi {
                    self.phase -= two_pi;
                }
                while self.phase < 0.0 {
                    self.phase += two_pi;
                }
            }

            // Convert phases to SIMD vector and generate sine output
            let phase_simd = f32x4::from_array(phases);
            let sine_output = phase_simd.sin();

            // Apply gain modulation on top of base gain
            let gain_mod = inputs
                .get(&PortId::GainMod)
                .map_or(f32x4::splat(1.0), |input| input.get_simd(offset));

            let final_output = sine_output * gain_mod * f32x4::splat(self.gain);

            // Write output
            if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
                output.write_simd(offset, final_output);
            }
        });
    }

    fn reset(&mut self) {
        self.phase = 0.0;
    }
}
