use core::simd::Simd;
use std::any::Any;
use std::collections::HashMap;
use std::simd::StdFloat;
use std::sync::Arc;
use wasm_bindgen::prelude::*; // Needed for SIMD types and .floor()

use crate::graph::{ModulationProcessor, ModulationSource};
use crate::{AudioNode, PortId};

use super::{Waveform, WavetableBank};

/// AnalogOscillatorStateUpdate: State update parameters for the oscillator.
/// It contains modulation parameters (phase_mod_amount, detune, etc.) and unison settings.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy)]
pub struct AnalogOscillatorStateUpdate {
    pub phase_mod_amount: f32,
    pub detune: f32,
    pub hard_sync: bool,
    pub gain: f32,
    pub active: bool,
    pub feedback_amount: f32,
    pub waveform: Waveform,
    pub unison_voices: u32, // number of voices in unison
    pub spread: f32,        // spread in cents (maximum additional detune per voice)
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

/// AnalogOscillator: Implements an analog-style oscillator with unison and modulation.
pub struct AnalogOscillator {
    // Core oscillator state.
    phase: f32,
    sample_rate: f32,
    gain: f32,
    active: bool,
    feedback_amount: f32,
    last_output: f32,
    hard_sync: bool,
    last_gate_value: f32,
    frequency: f32,
    waveform: Waveform,
    gate_buffer: Vec<f32>,

    // Modulation parameters.
    phase_mod_amount: f32,
    detune: f32,
    // Unison parameters.
    unison_voices: usize,
    spread: f32,
    voice_phases: Vec<f32>,

    wavetable_banks: Arc<HashMap<Waveform, Arc<WavetableBank>>>,
}

impl ModulationProcessor for AnalogOscillator {}

impl AnalogOscillator {
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
        self.gain = params.gain;
        self.feedback_amount = params.feedback_amount;
        self.hard_sync = params.hard_sync;
        self.active = params.active;
        self.waveform = params.waveform;
        self.phase_mod_amount = params.phase_mod_amount;
        self.detune = params.detune;
        self.spread = params.spread;
        let new_voice_count = if params.unison_voices == 0 {
            1
        } else {
            params.unison_voices as usize
        };
        if new_voice_count != self.unison_voices {
            self.unison_voices = new_voice_count;
            self.voice_phases = vec![self.phase; new_voice_count];
        }
    }

    // Reset voice phases on a rising gate edge.
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

/// A simple SIMD-based exponential approximation for a 4-lane SIMD vector.
/// Approximates exp(x) ≈ 1 + x + 0.5*x² + 0.16666667*x³.
#[inline(always)]
fn simd_exp(x: Simd<f32, 4>) -> Simd<f32, 4> {
    let one = Simd::splat(1.0);
    let half = Simd::splat(0.5);
    let one_sixth = Simd::splat(0.16666667);
    one + x + half * x * x + one_sixth * x * x * x
}

impl AudioNode for AnalogOscillator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::GlobalFrequency, false);
        ports.insert(PortId::FrequencyMod, false);
        ports.insert(PortId::PhaseMod, false);
        ports.insert(PortId::ModIndex, false);
        ports.insert(PortId::DetuneMod, true);
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
            self.phase_mod_amount,
        );
        let feedback_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::FeedbackMod), 1.0);
        let detune_mod = self.process_modulations(buffer_size, inputs.get(&PortId::DetuneMod), 0.0);

        // Prepare the gate buffer.
        if self.gate_buffer.len() < buffer_size {
            self.gate_buffer.resize(buffer_size, 0.0);
        } else {
            self.gate_buffer[..buffer_size].fill(0.0);
        }
        if let Some(sources) = inputs.get(&PortId::GlobalGate) {
            for source in sources {
                for (i, &src) in source.buffer.iter().take(buffer_size).enumerate() {
                    self.gate_buffer[i] += src * source.amount;
                }
            }
        }

        // Base frequency: from modulation or default.
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

        // Precompute constants.
        let cent_ratio = 2.0_f32.powf(1.0 / 1200.0);
        let semitone_ratio = 2.0_f32.powf(1.0 / 12.0);
        let ln_semitone_ratio = semitone_ratio.ln();
        let sample_rate_recip = 1.0 / self.sample_rate;
        let two_pi = 2.0 * std::f32::consts::PI;
        let feedback_divisor = std::f32::consts::PI * 1.5;
        let cents_factor = cent_ratio.powf(self.detune);

        // Precompute per-voice detune offsets.
        let voice_offsets: Vec<f32> = if self.unison_voices > 1 {
            (0..self.unison_voices)
                .map(|voice| {
                    (self.spread * (2.0 * (voice as f32 / ((self.unison_voices - 1) as f32)) - 1.0))
                        * 0.01
                })
                .collect()
        } else {
            vec![0.0]
        };

        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            for i in 0..buffer_size {
                let gate_val = self.gate_buffer[i];
                self.check_gate(gate_val);

                // Retrieve per-sample modulation values.
                let freq_sample = base_freq[i];
                let freq_mod_sample = freq_mod[i];
                let phase_mod_sample = phase_mod[i];
                let gain_mod_sample = gain_mod[i];
                let mod_index_sample = mod_index[i];
                let feedback_mod_sample = feedback_mod[i];
                let detune_mod_sample = detune_mod[i];

                let modulated_freq = freq_sample * freq_mod_sample;
                let freq_with_cents = modulated_freq * cents_factor;
                let ext_phase_mod = (phase_mod_sample * mod_index_sample) / two_pi;
                let effective_feedback = self.feedback_amount * feedback_mod_sample;
                let feedback_val = (self.last_output * effective_feedback) / feedback_divisor;

                let mut sample_sum = 0.0;

                // --- SIMD-accelerated voice loop ---
                let mut voice = 0;
                if self.unison_voices >= 4 {
                    while voice + 4 <= self.unison_voices {
                        // Load 4 voice offsets.
                        let offs = Simd::from_slice(&voice_offsets[voice..voice + 4]);
                        // Broadcast the current detune modulation sample.
                        let detune_mod_simd = Simd::splat(detune_mod_sample);
                        // Compute per-voice total detune.
                        let voice_detune = detune_mod_simd + offs;
                        // Compute semitone factor: semitone_ratio.powf(voice_detune)
                        // using the identity: powf(x) = exp(ln(x)*voice_detune)
                        let exp_arg = voice_detune * Simd::splat(ln_semitone_ratio);
                        let semitone_factors = simd_exp(exp_arg);
                        let effective_freqs = Simd::splat(freq_with_cents) * semitone_factors;
                        let phase_incs = effective_freqs * Simd::splat(sample_rate_recip);

                        // Load current voice phases.
                        let mut phases = Simd::from_slice(&self.voice_phases[voice..voice + 4]);
                        // Update phases: phases = (phases + phase_incs) mod 1.0.
                        phases = phases + phase_incs;
                        phases = phases - phases.floor();
                        // Write back updated phases.
                        self.voice_phases[voice..voice + 4].copy_from_slice(&phases.to_array());

                        // Extract SIMD lanes for further table lookup.
                        let phases_arr = phases.to_array();
                        let eff_freqs_arr = effective_freqs.to_array();
                        for lane in 0..4 {
                            let phase = phases_arr[lane] + ext_phase_mod + feedback_val;
                            let normalized_phase = phase.rem_euclid(1.0);
                            let table = bank.select_table(eff_freqs_arr[lane]);
                            let pos = normalized_phase * (table.table_size as f32);
                            let voice_sample = cubic_interp(&table.samples, pos);
                            sample_sum += voice_sample;
                        }
                        voice += 4;
                    }
                }
                // --- Fallback scalar voice loop for remaining voices ---
                for v in voice..self.unison_voices {
                    let voice_offset = voice_offsets[v];
                    let voice_detune = detune_mod_sample + voice_offset;
                    let semitone_factor = semitone_ratio.powf(voice_detune);
                    let effective_freq = freq_with_cents * semitone_factor;
                    let phase_inc = effective_freq * sample_rate_recip;
                    self.voice_phases[v] = (self.voice_phases[v] + phase_inc).rem_euclid(1.0);
                    let table = bank.select_table(effective_freq);
                    let modulated_phase = self.voice_phases[v] + ext_phase_mod + feedback_val;
                    let normalized_phase = modulated_phase.rem_euclid(1.0);
                    let pos = normalized_phase * (table.table_size as f32);
                    let voice_sample = cubic_interp(&table.samples, pos);
                    sample_sum += voice_sample;
                }

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
