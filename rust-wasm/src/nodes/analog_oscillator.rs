use std::any::Any;
use std::collections::HashMap;
use std::sync::Arc;
use wasm_bindgen::prelude::*;

use crate::graph::{ModulationProcessor, ModulationSource};
use crate::{AudioNode, PortId};

use super::{Waveform, WavetableBank};

/// This struct now includes unison parameters: the number of voices and the spread (in cents).
#[derive(Debug, Clone, Copy)]
#[wasm_bindgen]
pub struct AnalogOscillatorStateUpdate {
    pub phase_mod_amount: f32,
    pub detune: f32,
    pub hard_sync: bool,
    pub gain: f32,
    pub active: bool,
    pub feedback_amount: f32,
    pub waveform: Waveform,
    pub unison_voices: u32, // number of voices in unison
    pub spread: f32,        // spread in cents (the maximum additional detune per voice)
}

#[wasm_bindgen]
impl AnalogOscillatorStateUpdate {
    #[wasm_bindgen(constructor)]
    pub fn new(
        phase_mod_amount: f32,
        detune: f32,
        hard_sync: bool,
        gain: f32,
        active: bool,
        feedback_amount: f32,
        waveform: Waveform,
        unison_voices: u32,
        spread: f32,
    ) -> Self {
        Self {
            phase_mod_amount,
            detune,
            hard_sync,
            gain,
            active,
            feedback_amount,
            waveform,
            unison_voices,
            spread,
        }
    }
}

pub struct AnalogOscillator {
    // Core oscillator state.
    phase: f32, // Base phase (used only for initialization)
    sample_rate: f32,
    gain: f32,
    active: bool,
    feedback_amount: f32,
    last_output: f32,
    hard_sync: bool,
    last_gate_value: f32,
    frequency: f32, // Base frequency (Hz)
    waveform: Waveform,
    gate_buffer: Vec<f32>, // Pre-allocated gate modulation buffer

    // Modulation parameters.
    phase_mod_amount: f32,
    detune: f32,
    // Unison parameters.
    unison_voices: usize,
    spread: f32,            // Spread in cents: maximum detune offset for voices.
    voice_phases: Vec<f32>, // Phase for each voice.

    wavetable_banks: Arc<HashMap<Waveform, Arc<WavetableBank>>>,
}

// Implement the trait using your new process_modulations implementation.
impl ModulationProcessor for AnalogOscillator {}

impl AnalogOscillator {
    /// Create a new oscillator. The caller must provide the number of unison voices and the spread.
    pub fn new(
        sample_rate: f32,
        waveform: Waveform,
        wavetable_banks: Arc<HashMap<Waveform, Arc<WavetableBank>>>,
    ) -> Self {
        Self {
            phase: 0.0,
            sample_rate,
            gain: 1.0,
            active: true,
            feedback_amount: 0.0,
            last_output: 0.0,
            hard_sync: false,
            last_gate_value: 0.0,
            frequency: 440.0,
            waveform,
            gate_buffer: vec![0.0; 1024],
            phase_mod_amount: 0.0,
            detune: 0.0,
            unison_voices: 1,
            spread: 0.1,
            voice_phases: vec![0.0; 1],
            wavetable_banks,
        }
    }

    pub fn update_params(&mut self, params: &AnalogOscillatorStateUpdate) {
        // console::log_1(&format!("### Updating params: {:#?}", params).into());
        self.gain = params.gain;
        self.feedback_amount = params.feedback_amount;
        self.hard_sync = params.hard_sync;
        self.active = params.active;
        self.waveform = params.waveform;
        // Update modulation parameters.
        self.phase_mod_amount = params.phase_mod_amount;
        self.detune = params.detune;
        // Update unison settings.
        self.spread = params.spread;
        // Ensure at least one voice is active.
        let new_voice_count = if params.unison_voices == 0 {
            1
        } else {
            params.unison_voices as usize
        };
        if new_voice_count != self.unison_voices {
            self.unison_voices = new_voice_count;
            // Initialize each voice's phase to the current base phase.
            self.voice_phases = vec![self.phase; new_voice_count];
        }
    }

    // Checks the gate value for hard-sync. On a rising edge, reset all voice phases.
    fn check_gate(&mut self, gate: f32) {
        if self.hard_sync && gate > 0.0 && self.last_gate_value <= 0.0 {
            for phase in self.voice_phases.iter_mut() {
                *phase = 0.0;
            }
        }
        self.last_gate_value = gate;
    }
}

/// Cubic interpolation for improved wavetable quality.
fn cubic_interp(samples: &[f32], pos: f32) -> f32 {
    let n = samples.len();
    let i = pos.floor() as isize;
    let frac = pos - (i as f32);
    // Wrap indices using modular arithmetic.
    let idx = |j: isize| -> f32 {
        let index = ((i + j).rem_euclid(n as isize)) as usize;
        samples[index]
    };
    let p0 = idx(-1);
    let p1 = idx(0);
    let p2 = idx(1);
    let p3 = idx(2);
    let a = -0.5 * p0 + 1.5 * p1 - 1.5 * p2 + 0.5 * p3;
    let b = p0 - 2.5 * p1 + 2.0 * p2 - 0.5 * p3;
    let c = -0.5 * p0 + 0.5 * p2;
    let d = p1;
    a * frac * frac * frac + b * frac * frac + c * frac + d
}

impl AudioNode for AnalogOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::GlobalFrequency, false);
        ports.insert(PortId::FrequencyMod, false);
        ports.insert(PortId::PhaseMod, false);
        ports.insert(PortId::ModIndex, false);
        ports.insert(PortId::GainMod, false);
        ports.insert(PortId::FeedbackMod, false);
        ports.insert(PortId::AudioOutput0, true);
        ports.insert(PortId::GlobalGate, false);
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
        let mod_index = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::ModIndex),
            self.phase_mod_amount, // additive base for phase modulation
        );
        let feedback_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::FeedbackMod), 1.0);

        // Prepare the gate buffer.
        if self.gate_buffer.len() < buffer_size {
            self.gate_buffer.resize(buffer_size, 0.0);
        }
        for v in self.gate_buffer.iter_mut().take(buffer_size) {
            *v = 0.0;
        }
        if let Some(sources) = inputs.get(&PortId::GlobalGate) {
            for source in sources {
                for (i, &src) in source.buffer.iter().enumerate().take(buffer_size) {
                    self.gate_buffer[i] += src * source.amount;
                }
            }
        }

        // Get base frequency (from modulation or default).
        let base_freq = if let Some(freq_sources) = inputs.get(&PortId::GlobalFrequency) {
            if !freq_sources.is_empty() && !freq_sources[0].buffer.is_empty() {
                freq_sources[0].buffer.clone()
            } else {
                vec![self.frequency; buffer_size]
            }
        } else {
            vec![self.frequency; buffer_size]
        };

        // Retrieve the wavetable bank.
        let waveform = self.waveform;
        let bank = self
            .wavetable_banks
            .get(&waveform)
            .expect("Wavetable bank not found")
            .clone();

        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            for i in 0..buffer_size {
                let gate_val = self.gate_buffer[i];
                self.check_gate(gate_val);

                // Retrieve modulation values for this sample.
                let freq_sample = base_freq[i];
                let freq_mod_sample = freq_mod[i];
                let phase_mod_sample = phase_mod[i];
                let gain_mod_sample = gain_mod[i];
                let mod_index_sample = mod_index[i];
                let feedback_mod_sample = feedback_mod[i];

                // Set up weighted sum variables.
                let sample_sum = 0.0;
                let total_weight = 0.0;
                // Use a Gaussian curve for voice weighting, centered on the middle voice.
                let center_index = (self.unison_voices as f32 - 1.0) / 2.0;
                // Sigma controls the spread of the Gaussian; adjust as needed.
                let sigma = self.unison_voices as f32 / 4.0;

                // Instead of accumulating with Gaussian weights, we now simply sum all voices equally.
                let mut sample_sum = 0.0;
                // Process each unison voice.
                for voice in 0..self.unison_voices {
                    // Compute a per-voice detune offset.
                    // This produces a linear spread from -spread to +spread.
                    let voice_offset = if self.unison_voices > 1 {
                        self.spread
                            * (2.0 * (voice as f32 / ((self.unison_voices - 1) as f32)) - 1.0)
                    } else {
                        0.0
                    };

                    // Combine the global detune with the per-voice offset.
                    let total_detune = self.detune + voice_offset;
                    // Convert cents to a frequency multiplier.
                    let detuned_freq = freq_sample * 2.0_f32.powf(total_detune / 1200.0);
                    let effective_freq = detuned_freq * freq_mod_sample;
                    let phase_inc = effective_freq / self.sample_rate;

                    // Update this voice's phase.
                    self.voice_phases[voice] += phase_inc;
                    if self.voice_phases[voice] >= 1.0 {
                        self.voice_phases[voice] -= 1.0;
                    }

                    // Select the appropriate wavetable.
                    let table = bank.select_table(effective_freq);

                    // Apply phase modulation and feedback.
                    let external_phase_mod =
                        (phase_mod_sample * mod_index_sample) / (2.0 * std::f32::consts::PI);
                    let effective_feedback = self.feedback_amount * feedback_mod_sample;
                    let feedback_val =
                        (self.last_output * effective_feedback) / (std::f32::consts::PI * 1.5);

                    let modulated_phase =
                        self.voice_phases[voice] + external_phase_mod + feedback_val;
                    let normalized_phase = modulated_phase.rem_euclid(1.0);
                    let pos = normalized_phase * (table.table_size as f32);
                    let voice_sample = cubic_interp(&table.samples, pos);

                    sample_sum += voice_sample;
                }

                // Simply average the sum over the number of voices.
                let final_sample = sample_sum / self.unison_voices as f32;
                output[i] = final_sample * self.gain * gain_mod_sample;
                self.last_output = final_sample;
            }
        }
    }

    fn reset(&mut self) {
        self.phase = 0.0;
        self.last_output = 0.0;
        self.last_gate_value = 0.0;
        // Reset all voice phases.
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
        "analog_oscillator"
    }
}
