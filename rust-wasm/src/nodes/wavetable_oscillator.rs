use std::any::Any;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use web_sys::console;

// These are assumed to be defined elsewhere in your codebase:
use crate::graph::{ModulationProcessor, ModulationSource};
use crate::{AudioNode, PortId};

use super::morph_wavetable::WavetableSynthBank;

// Import the bank and related types from our wavetable module.

#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct WavetableOscillatorStateUpdate {
    pub phase_mod_amount: f32,
    pub detune: f32,
    pub hard_sync: bool,
    pub gain: f32,
    pub active: bool,
    pub feedback_amount: f32,
    pub unison_voices: u32,   // number of voices in unison
    pub spread: f32,          // spread in cents (max detune per voice)
    pub wavetable_index: f32, // morph parameter: 0.0–1.0 for interpolation between waveforms
}

#[wasm_bindgen]
impl WavetableOscillatorStateUpdate {
    #[wasm_bindgen(constructor)]
    pub fn new(
        phase_mod_amount: f32,
        detune: f32,
        hard_sync: bool,
        gain: f32,
        active: bool,
        feedback_amount: f32,
        unison_voices: u32,
        spread: f32,
        wavetable_index: f32,
    ) -> Self {
        Self {
            phase_mod_amount,
            detune,
            hard_sync,
            gain,
            active,
            feedback_amount,
            unison_voices,
            spread,
            wavetable_index,
        }
    }
}

/// The wavetable oscillator uses a bank of morph collections and selects one by name.
/// (The bank is stored by value here to avoid Arc.)
pub struct WavetableOscillator {
    sample_rate: f32,
    gain: f32,
    active: bool,
    feedback_amount: f32,
    last_output: f32,
    hard_sync: bool,
    last_gate_value: f32,
    frequency: f32, // base frequency in Hz
    gate_buffer: Vec<f32>,
    // Modulation parameters.
    phase_mod_amount: f32,
    detune: f32,
    // Unison parameters.
    unison_voices: usize,
    spread: f32,
    voice_phases: Vec<f32>,
    // Morph parameter.
    wavetable_index: f32,
    // Name of the morph collection to use.
    collection_name: String,
    // The bank of wavetable morph collections.
    wavetable_bank: WavetableSynthBank,
}

impl ModulationProcessor for WavetableOscillator {}

impl WavetableOscillator {
    /// Create a new oscillator.
    /// - `sample_rate`: audio sample rate.
    /// - `bank`: the wavetable synth bank (passed by value).
    /// - `collection_name`: the name of the morph collection to use (e.g., "default").
    pub fn new(sample_rate: f32, bank: WavetableSynthBank) -> Self {
        Self {
            sample_rate,
            gain: 1.0,
            active: true,
            feedback_amount: 0.0,
            last_output: 0.0,
            hard_sync: false,
            last_gate_value: 0.0,
            frequency: 440.0,
            gate_buffer: vec![0.0; 1024],
            phase_mod_amount: 0.0,
            detune: 0.0,
            unison_voices: 1,
            spread: 0.1,
            voice_phases: vec![0.0; 1],
            wavetable_index: 0.0,
            collection_name: "default".to_string(),
            wavetable_bank: bank,
        }
    }

    /// Update oscillator parameters.
    pub fn update_params(&mut self, params: &WavetableOscillatorStateUpdate) {
        console::log_1(&format!("Updating params: {:#?}", params).into());
        self.gain = params.gain;
        self.feedback_amount = params.feedback_amount;
        self.hard_sync = params.hard_sync;
        self.active = params.active;
        self.phase_mod_amount = params.phase_mod_amount;
        self.detune = params.detune;
        self.spread = params.spread;
        self.wavetable_index = params.wavetable_index;
        let new_voice_count = if params.unison_voices == 0 {
            1
        } else {
            params.unison_voices as usize
        };
        if new_voice_count != self.unison_voices {
            self.unison_voices = new_voice_count;
            self.voice_phases = vec![self.voice_phases[0]; new_voice_count];
        }
    }

    /// Check the gate for hard sync.
    fn check_gate(&mut self, gate: f32) {
        if self.hard_sync && gate > 0.0 && self.last_gate_value <= 0.0 {
            for phase in self.voice_phases.iter_mut() {
                *phase = 0.0;
            }
        }
        self.last_gate_value = gate;
    }
}

impl AudioNode for WavetableOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::GlobalFrequency, false);
        ports.insert(PortId::FrequencyMod, false);
        ports.insert(PortId::PhaseMod, false);
        ports.insert(PortId::WavetableIndex, false);
        ports.insert(PortId::GainMod, false);
        ports.insert(PortId::FeedbackMod, false);
        ports.insert(PortId::AudioOutput0, true);
        ports.insert(PortId::Gate, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Process modulation inputs.
        let freq_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::FrequencyMod), 1.0);
        let phase_mod = self.process_modulations(buffer_size, inputs.get(&PortId::PhaseMod), 0.0);
        let gain_mod = self.process_modulations(buffer_size, inputs.get(&PortId::GainMod), 1.0);
        let feedback_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::FeedbackMod), 1.0);
        let wavetable_index_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::WavetableIndex),
            self.wavetable_index,
        );

        // Prepare the gate buffer.
        if self.gate_buffer.len() < buffer_size {
            self.gate_buffer.resize(buffer_size, 0.0);
        }
        for v in self.gate_buffer.iter_mut().take(buffer_size) {
            *v = 0.0;
        }
        if let Some(sources) = inputs.get(&PortId::Gate) {
            for source in sources {
                for (i, &src) in source.buffer.iter().enumerate().take(buffer_size) {
                    self.gate_buffer[i] += src * source.amount;
                }
            }
        }

        // Base frequency from GlobalFrequency modulation or default.
        let base_freq = if let Some(freq_sources) = inputs.get(&PortId::GlobalFrequency) {
            if !freq_sources.is_empty() && !freq_sources[0].buffer.is_empty() {
                freq_sources[0].buffer.clone()
            } else {
                vec![self.frequency; buffer_size]
            }
        } else {
            vec![self.frequency; buffer_size]
        };

        // Use a raw pointer trick to obtain a collection reference without holding an immutable borrow on self.
        let bank_ptr: *const WavetableSynthBank = &self.wavetable_bank;
        let collection = unsafe {
            (*bank_ptr)
                .get_collection(&self.collection_name)
                .expect("Wavetable collection not found")
        };

        // Clone the gate buffer locally.
        let gate_buf = self.gate_buffer.clone();

        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            for i in 0..buffer_size {
                let gate_val = gate_buf[i];
                self.check_gate(gate_val);

                let freq_sample = base_freq[i];
                let phase_mod_sample = phase_mod[i];
                let gain_mod_sample = gain_mod[i];
                let feedback_mod_sample = feedback_mod[i];
                let wavetable_index_sample = wavetable_index_mod[i];

                let mut sample_sum = 0.0;
                let mut total_weight = 0.0;
                let center_index = (self.unison_voices as f32 - 1.0) / 2.0;
                let sigma = self.unison_voices as f32 / 4.0;

                for voice in 0..self.unison_voices {
                    let voice_f = voice as f32;
                    let distance = (voice_f - center_index).abs();
                    let weight = (-distance * distance / (2.0 * sigma * sigma)).exp();
                    total_weight += weight;

                    let voice_offset = if self.unison_voices > 1 {
                        self.spread * (2.0 * (voice_f / ((self.unison_voices - 1) as f32)) - 1.0)
                    } else {
                        0.0
                    };

                    let total_detune = self.detune + voice_offset;
                    let detuned_freq = freq_sample * 2.0_f32.powf(total_detune / 1200.0);
                    let effective_freq = detuned_freq * freq_mod[i];
                    let phase_inc = effective_freq / self.sample_rate;

                    self.voice_phases[voice] += phase_inc;
                    if self.voice_phases[voice] >= 1.0 {
                        self.voice_phases[voice] -= 1.0;
                    }

                    let external_phase_mod =
                        (phase_mod_sample * self.phase_mod_amount) / (2.0 * std::f32::consts::PI);
                    let effective_feedback = self.feedback_amount * feedback_mod_sample;
                    let feedback_val =
                        (self.last_output * effective_feedback) / (std::f32::consts::PI * 1.5);

                    let modulated_phase =
                        self.voice_phases[voice] + external_phase_mod + feedback_val;
                    let normalized_phase = modulated_phase.rem_euclid(1.0);

                    let voice_sample =
                        collection.lookup_sample(normalized_phase, wavetable_index_sample);
                    sample_sum += voice_sample * weight;
                }

                let final_sample = sample_sum / total_weight;
                output[i] = final_sample * self.gain * gain_mod_sample;
                self.last_output = final_sample;
            }
        }
    }

    fn reset(&mut self) {
        self.last_output = 0.0;
        self.last_gate_value = 0.0;
        for phase in self.voice_phases.iter_mut() {
            *phase = 0.0;
        }
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
        "wavetable_oscillator"
    }
}
