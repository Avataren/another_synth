use std::any::Any;
use std::collections::HashMap;
use std::simd::{f32x4, StdFloat};
use wasm_bindgen::prelude::wasm_bindgen;

use crate::graph::{ModulationProcessor, ModulationSource};
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
    pub feedback_amount: f32,
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
        feedback_amount: f32,
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
            feedback_amount,
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
    feedback_amount: f32,
    last_output: f32,
    last_feedback: f32,
    hard_sync: bool,
    last_gate_value: f32,
}

impl ModulatableOscillator {
    pub fn new(sample_rate: f32) -> Self {
        Self {
            phase: 0.0,
            frequency: 440.0,
            phase_mod_amount: 0.0,
            freq_mod_amount: 1.0,
            detune: 0.0,
            gain: 1.0,
            sample_rate,
            active: true,
            feedback_amount: 0.0,
            last_output: 0.0,
            last_feedback: 0.0,
            hard_sync: false,
            last_gate_value: 0.0,
        }
    }

    pub fn update_params(&mut self, params: &OscillatorStateUpdate) {
        self.phase_mod_amount = params.phase_mod_amount;
        self.freq_mod_amount = params.freq_mod_amount;
        self.detune = params.detune;
        self.gain = params.gain;
        self.feedback_amount = params.feedback_amount;
        self.hard_sync = params.hard_sync;
        self.set_active(params.active);
    }

    fn get_detuned_frequency(&self, base_freq: f32) -> f32 {
        let multiplier = 2.0f32.powf(self.detune / 1200.0);
        base_freq * multiplier
    }

    fn check_gate(&mut self, gate: f32) {
        if self.hard_sync && gate > 0.0 && self.last_gate_value <= 0.0 {
            self.phase = 0.0;
        }
        self.last_gate_value = gate;
    }
}

impl ModulationProcessor for ModulatableOscillator {}

impl AudioNode for ModulatableOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::GlobalFrequency, false);
        ports.insert(PortId::FrequencyMod, false);
        ports.insert(PortId::PhaseMod, false);
        ports.insert(PortId::ModIndex, false);
        ports.insert(PortId::GainMod, false);
        ports.insert(PortId::FeedbackMod, false);
        ports.insert(PortId::AudioOutput0, true);
        ports.insert(PortId::Gate, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &std::collections::HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut std::collections::HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        const TWO_PI: f32 = 2.0 * std::f32::consts::PI;

        // Process modulation inputs for each port
        let freq_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::FrequencyMod), 1.0);
        let phase_mod = self.process_modulations(buffer_size, inputs.get(&PortId::PhaseMod), 0.0);
        let gain_mod = self.process_modulations(buffer_size, inputs.get(&PortId::GainMod), 1.0);
        let mod_index = self.process_modulations(buffer_size, inputs.get(&PortId::ModIndex), 1.0);
        let feedback_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::FeedbackMod), 1.0);

        // Process gate input for hard sync
        let mut gate_buffer = vec![0.0; buffer_size];
        if let Some(sources) = inputs.get(&PortId::Gate) {
            for source in sources {
                for (dest, &src) in gate_buffer.iter_mut().zip(source.buffer.iter()) {
                    *dest += src * source.amount;
                }
            }
        }

        // Get base frequency
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
            let use_scalar = (self.feedback_amount != 0.0)
                || (!feedback_mod.is_empty() && feedback_mod.iter().any(|&v| v != 0.0))
                || self.hard_sync;

            if use_scalar {
                // Scalar processing branch
                for i in 0..buffer_size {
                    // Check gate for hard sync
                    self.check_gate(gate_buffer[i]);

                    let freq_sample = base_freq[i];
                    let freq_mod_sample = freq_mod[i];
                    let phase_mod_sample = phase_mod[i];
                    let gain_mod_sample = gain_mod[i];
                    let mod_index_sample = mod_index[i];
                    let feedback_mod_sample = feedback_mod[i];

                    let detuned_freq = self.get_detuned_frequency(freq_sample);
                    let modulated_freq = detuned_freq * freq_mod_sample;
                    let phase_inc = TWO_PI * modulated_freq / self.sample_rate;
                    self.phase += phase_inc;

                    let input_phase_mod =
                        phase_mod_sample * self.phase_mod_amount * mod_index_sample;
                    let effective_feedback = self.feedback_amount * feedback_mod_sample;
                    let feedback_val = self.last_output * effective_feedback;

                    let modulated_phase = self.phase + input_phase_mod + feedback_val;
                    let sine = modulated_phase.sin();
                    let sample = sine * self.gain * gain_mod_sample;

                    self.last_feedback = self.last_output;
                    self.last_output = sample;
                    output[i] = sample;

                    if self.phase >= TWO_PI {
                        self.phase -= TWO_PI;
                    }
                }
            } else {
                // SIMD processing branch
                let mut i = 0;
                while i < buffer_size {
                    let chunk_size = (buffer_size - i).min(4);

                    let mut freq_chunk = [0.0; 4];
                    let mut freq_mod_chunk = [0.0; 4];
                    let mut phase_mod_chunk = [0.0; 4];
                    let mut gain_mod_chunk = [1.0; 4];
                    let mut mod_index_chunk = [1.0; 4];

                    for j in 0..chunk_size {
                        freq_chunk[j] = base_freq[i + j];
                        freq_mod_chunk[j] = freq_mod[i + j];
                        phase_mod_chunk[j] = phase_mod[i + j];
                        gain_mod_chunk[j] = gain_mod[i + j];
                        mod_index_chunk[j] = mod_index[i + j];
                    }

                    let base_freq_simd = f32x4::from_array(freq_chunk);
                    let freq_mod_simd = f32x4::from_array(freq_mod_chunk);
                    let phase_mod_simd = f32x4::from_array(phase_mod_chunk);
                    let gain_mod_simd = f32x4::from_array(gain_mod_chunk);
                    let mod_index_simd = f32x4::from_array(mod_index_chunk);

                    let base_freq_arr = base_freq_simd.to_array();
                    let mut detuned_array = [0.0; 4];
                    for k in 0..chunk_size {
                        detuned_array[k] = self.get_detuned_frequency(base_freq_arr[k]);
                    }
                    let detuned_freq_simd = f32x4::from_array(detuned_array);

                    let modulated_freq = detuned_freq_simd * freq_mod_simd;
                    let phase_inc =
                        f32x4::splat(TWO_PI) * modulated_freq / f32x4::splat(self.sample_rate);
                    let phase_inc_arr = phase_inc.to_array();

                    let mut phases_arr = [0.0; 4];
                    let mut current_phase = self.phase;
                    for k in 0..chunk_size {
                        current_phase += phase_inc_arr[k];
                        phases_arr[k] = current_phase;
                    }
                    let phases_simd = f32x4::from_array(phases_arr);

                    let mod_depth = f32x4::splat(self.phase_mod_amount) * mod_index_simd;
                    let scaled_phase_mod = phase_mod_simd * mod_depth;
                    let modulated_phase = phases_simd + scaled_phase_mod;

                    let sine = modulated_phase.sin();
                    let result = sine * f32x4::splat(self.gain) * gain_mod_simd;

                    let result_arr = result.to_array();
                    for j in 0..chunk_size {
                        output[i + j] = result_arr[j];
                    }

                    self.phase = current_phase % TWO_PI;

                    i += chunk_size;
                }
            }
        }
    }

    fn reset(&mut self) {
        self.phase = 0.0;
        self.last_output = 0.0;
        self.last_feedback = 0.0;
        self.last_gate_value = 0.0;
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
