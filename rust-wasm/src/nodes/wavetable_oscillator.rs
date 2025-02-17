// wavetable_oscillator.rs

use std::any::Any;
use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;
use wasm_bindgen::prelude::*;

use crate::graph::{ModulationProcessor, ModulationSource};
use crate::{AudioNode, PortId};

// Use the new morph collection which now holds mipmapped wavetables.
use super::morph_wavetable::{WavetableMorphCollection, WavetableSynthBank};

use std::f32::consts::PI;

#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct WavetableOscillatorStateUpdate {
    pub phase_mod_amount: f32,
    pub detune: f32,
    pub hard_sync: bool,
    pub gain: f32,
    pub active: bool,
    pub feedback_amount: f32,
    pub unison_voices: u32,
    pub spread: f32,
    pub wavetable_index: f32,
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

/// The wavetable oscillator now uses precomputed mipmapped wavetables for band limiting.
/// (All anti-aliasing is done ahead of time.)
pub struct WavetableOscillator {
    sample_rate: f32,
    gain: f32,
    active: bool,
    feedback_amount: f32,
    last_output: f32,
    hard_sync: bool,
    last_gate_value: f32,
    frequency: f32,
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
    wavetable_bank: Rc<RefCell<WavetableSynthBank>>,
}

impl ModulationProcessor for WavetableOscillator {}

impl WavetableOscillator {
    /// Create a new oscillator.
    pub fn new(sample_rate: f32, bank: Rc<RefCell<WavetableSynthBank>>) -> Self {
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

    pub fn set_current_wavetable(&mut self, collection_name: &str) {
        self.collection_name = collection_name.to_string();
    }

    /// Update oscillator parameters.
    pub fn update_params(&mut self, params: &WavetableOscillatorStateUpdate) {
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

fn get_collection_from_bank(
    bank: &RefCell<WavetableSynthBank>,
    name: &str,
) -> Rc<WavetableMorphCollection> {
    bank.borrow()
        .get_collection(name)
        .expect("Wavetable collection not found")
}

impl AudioNode for WavetableOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::GlobalFrequency, false);
        ports.insert(PortId::FrequencyMod, false);
        ports.insert(PortId::PhaseMod, false);
        ports.insert(PortId::ModIndex, false);
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
        // --- 1) Process modulations ---
        let freq_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::FrequencyMod), 1.0);
        let phase_mod = self.process_modulations(buffer_size, inputs.get(&PortId::PhaseMod), 0.0);
        let gain_mod = self.process_modulations(buffer_size, inputs.get(&PortId::GainMod), 1.0);
        let feedback_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::FeedbackMod), 1.0);
        let mod_index = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::ModIndex),
            self.phase_mod_amount,
        );
        let wavetable_index_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::WavetableIndex),
            self.wavetable_index,
        );

        // --- 2) Prepare gate buffer ---
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

        // --- 3) Base frequency (from GlobalFrequency or default) ---
        let base_freq = if let Some(freq_sources) = inputs.get(&PortId::GlobalFrequency) {
            if !freq_sources.is_empty() && !freq_sources[0].buffer.is_empty() {
                freq_sources[0].buffer.clone()
            } else {
                vec![self.frequency; buffer_size]
            }
        } else {
            vec![self.frequency; buffer_size]
        };

        // --- 4) Get the active mipmapped wavetable collection ---
        let collection = get_collection_from_bank(&self.wavetable_bank, &self.collection_name);

        // --- 5) Main synthesis loop (without oversampling) ---
        for i in 0..buffer_size {
            // Check for hard sync via the gate.
            self.check_gate(self.gate_buffer[i]);

            // Per-sample modulation values.
            let freq_sample = base_freq[i];
            let phase_mod_sample = phase_mod[i];
            let gain_mod_sample = gain_mod[i];
            let feedback_mod_sample = feedback_mod[i];
            let wavetable_index_sample = wavetable_index_mod[i];
            let mod_index_sample = mod_index[i];

            // Compute external phase modulation and feedback.
            let ext_phase = (phase_mod_sample * mod_index_sample) / (2.0 * PI);
            let fb = (self.last_output * self.feedback_amount * feedback_mod_sample) / (PI * 1.5);

            let mut sample_sum = 0.0;
            let mut total_weight = 0.0;

            // Sum contributions from all unison voices.
            for voice in 0..self.unison_voices {
                let voice_f = voice as f32;
                let center_index = (self.unison_voices as f32 - 1.0) / 2.0;
                let sigma = self.unison_voices as f32 / 4.0;
                let weight = (-((voice_f - center_index).powi(2)) / (2.0 * sigma * sigma)).exp();
                total_weight += weight;

                // Compute detune for this voice.
                let voice_offset = if self.unison_voices > 1 {
                    self.spread * (2.0 * (voice_f / ((self.unison_voices - 1) as f32)) - 1.0)
                } else {
                    0.0
                };
                let total_detune = self.detune + voice_offset;
                let detuned_freq = freq_sample * 2.0_f32.powf(total_detune / 1200.0);
                let effective_freq = detuned_freq * freq_mod[i];

                // Compute current phase (including external modulation and feedback).
                let phase = (self.voice_phases[voice] + ext_phase + fb).rem_euclid(1.0);

                // --- Lookup sample using mipmapped wavetable lookup ---
                let wv_sample =
                    collection.lookup_sample(phase, wavetable_index_sample, effective_freq);
                sample_sum += wv_sample * weight;

                // Update voice’s stored phase.
                let phase_inc = effective_freq / self.sample_rate;
                self.voice_phases[voice] = (self.voice_phases[voice] + phase_inc).rem_euclid(1.0);
            }

            let final_sample = (sample_sum / total_weight) * self.gain * gain_mod_sample;
            if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
                output[i] = final_sample;
            }
            self.last_output = final_sample;
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
