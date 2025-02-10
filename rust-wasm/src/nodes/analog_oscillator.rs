use std::any::Any;
use std::collections::HashMap;
use wasm_bindgen::prelude::*;
use web_sys::console;

use crate::graph::{ModulationProcessor, ModulationSource, ModulationType};
use crate::{AudioNode, PortId};

use super::{Waveform, WAVETABLE_BANKS};
#[derive(Debug, Clone, Copy)]
#[wasm_bindgen]
pub struct AnalogOscillatorStateUpdate {
    pub phase_mod_amount: f32,
    pub freq_mod_amount: f32,
    pub detune: f32,
    pub hard_sync: bool,
    pub gain: f32,
    pub active: bool,
    pub feedback_amount: f32,
    pub waveform: Waveform,
}

#[wasm_bindgen]
impl AnalogOscillatorStateUpdate {
    #[wasm_bindgen(constructor)]
    pub fn new(
        phase_mod_amount: f32,
        freq_mod_amount: f32,
        detune: f32,
        hard_sync: bool,
        gain: f32,
        active: bool,
        feedback_amount: f32,
        waveform: Waveform,
    ) -> Self {
        Self {
            phase_mod_amount,
            freq_mod_amount,
            detune,
            hard_sync,
            gain,
            active,
            feedback_amount,
            waveform,
        }
    }
}

pub struct AnalogOscillator {
    // Core oscillator state.
    phase: f32, // Normalized phase [0, 1)
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
    freq_mod_amount: f32,
    detune: f32,
}

impl AnalogOscillator {
    pub fn new(sample_rate: f32, waveform: Waveform) -> Self {
        let max_block_size = 1024;
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
            gate_buffer: vec![0.0; max_block_size],
            phase_mod_amount: 0.0,
            freq_mod_amount: 1.0,
            detune: 0.0,
        }
    }

    pub fn update_params(&mut self, params: &AnalogOscillatorStateUpdate) {
        console::log_1(&format!("### Updating params: {:#?}", params).into());
        self.gain = params.gain;
        self.feedback_amount = params.feedback_amount;
        self.hard_sync = params.hard_sync;
        self.active = params.active;
        self.waveform = params.waveform;
        // Update modulation parameters.
        self.phase_mod_amount = params.phase_mod_amount;
        //self.freq_mod_amount = params.freq_mod_amount;
        self.detune = params.detune;
        // self.last_output = 0.0;
    }

    // Checks the gate value for hard-sync.
    fn check_gate(&mut self, gate: f32) {
        if self.hard_sync && gate > 0.0 && self.last_gate_value <= 0.0 {
            self.phase = 0.0;
        }
        self.last_gate_value = gate;
    }
}

// Cubic interpolation for improved quality.
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
        ports.insert(PortId::Gate, false);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        //log self.phase_mod_amount, self.freq_mod_amount, self.detune
        // console::log_1(&format!("###phase_mod_amount: {:#?}", self.phase_mod_amount).into());
        use std::f32::consts::PI;
        const TWO_PI: f32 = 2.0 * PI;

        // Process modulation inputs.
        let freq_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::FrequencyMod),
            1.0,
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
        let feedback_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::FeedbackMod),
            1.0,
            PortId::FeedbackMod,
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

        // Get base frequency.
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
        let bank = WAVETABLE_BANKS
            .get(&self.waveform)
            .expect("Wavetable bank not found");

        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            for i in 0..buffer_size {
                // --- Hard Sync ---
                self.check_gate(self.gate_buffer[i]);

                // --- Retrieve modulation values for this sample ---
                let freq_sample = base_freq[i];
                let freq_mod_sample = freq_mod[i];
                let phase_mod_sample = phase_mod[i];
                let gain_mod_sample = gain_mod[i];
                let mod_index_sample = mod_index[i];
                let feedback_mod_sample = feedback_mod[i];

                // --- Frequency Calculation & Phase Increment ---
                // Apply detune (in cents) to the base frequency.
                let detuned_freq = freq_sample * 2.0f32.powf(self.detune / 1200.0);
                // Multiply by any frequency modulation.
                let effective_freq = detuned_freq * freq_mod_sample * self.freq_mod_amount;
                // In a sine oscillator the phase increment is TWO_PI * f / sample_rate.
                // We keep our internal phase in radians.
                let phase_inc = TWO_PI * effective_freq / self.sample_rate;
                self.phase += phase_inc;
                if self.phase >= TWO_PI {
                    self.phase -= TWO_PI;
                }

                // --- Modulation: Using Radians for Phase Arithmetic ---
                // In your sine oscillator the modulation amounts (both external and feedback)
                // are in radians. We do the same here.
                let external_phase_mod =
                    phase_mod_sample * self.phase_mod_amount * mod_index_sample;
                let effective_feedback = self.feedback_amount * feedback_mod_sample;
                let feedback_val = self.last_output * effective_feedback;

                // Combine the base phase (in radians) with modulation.
                let modulated_phase = self.phase + external_phase_mod + feedback_val;

                // --- Convert to Normalized Phase for Wavetable Lookup ---
                // Instead of using .fract(), use rem_euclid to ensure the result is always in [0, TWO_PI)
                let normalized_phase = modulated_phase.rem_euclid(TWO_PI) / TWO_PI;

                // --- Wavetable Lookup ---
                // Select the appropriate wavetable for the effective frequency.
                //let table = bank.select_table(effective_freq);
                //let normalized_freq = effective_freq / self.sample_rate; // freq / SR
                let table = bank.select_table(effective_freq); // or pass normalized_freq if your code changed

                // Map the normalized phase (0–1) to an index into the table.
                let pos = normalized_phase * (table.table_size as f32);
                let sample = cubic_interp(&table.samples, pos);

                // --- Output ---
                output[i] = sample * self.gain * gain_mod_sample;

                // Store the current sample for feedback in the next iteration.
                self.last_output = sample;
            }
        }
    }

    fn reset(&mut self) {
        self.phase = 0.0;
        self.last_output = 0.0;
        self.last_gate_value = 0.0;
    }

    /// Returns the `AnalogOscillator` as a mutable reference to a trait object of type `dyn Any`.
    /*************  ✨ Codeium Command ⭐  *************/
    /******  3bc1c3db-1e79-4ada-9e46-1917317be46a  *******/
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

impl ModulationProcessor for AnalogOscillator {
    fn get_modulation_type(&self, port: PortId) -> ModulationType {
        match port {
            PortId::FrequencyMod => ModulationType::FrequencyCents,
            PortId::PhaseMod => ModulationType::Additive,
            PortId::ModIndex | PortId::GainMod | PortId::FeedbackMod => ModulationType::VCA,
            PortId::Gate => ModulationType::Additive,
            _ => ModulationType::VCA,
        }
    }
}
