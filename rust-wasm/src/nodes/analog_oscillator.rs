use std::any::Any;
use std::collections::HashMap;
use std::simd::{f32x4, Simd};
use std::sync::Arc;
use wasm_bindgen::prelude::*;
use web_sys::console;

use crate::graph::{ModulationProcessor, ModulationSource};
use crate::{AudioNode, PortId};

use super::{Waveform, WavetableBank};

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
    pub unison_voices: u32,
    pub spread: f32,
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

/// Helper struct that holds both an additive and a multiplicative modulation buffer.
pub struct ModulationEx {
    pub additive: Vec<f32>,
    pub multiplicative: Vec<f32>,
}

/// AnalogOscillator implements an analog‑style oscillator with unison and modulation.
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
    // Per-voice feedback state.
    voice_last_outputs: Vec<f32>,

    wavetable_banks: Arc<HashMap<Waveform, Arc<WavetableBank>>>,

    // Scratch buffers for modulation processing.
    scratch_global_freq: Vec<f32>,  // For GlobalFrequency
    scratch_freq_mod: Vec<f32>,     // For FrequencyMod
    scratch_phase_mod: Vec<f32>,    // For PhaseMod
    scratch_gain_mod: Vec<f32>,     // For GainMod
    scratch_mod_index: Vec<f32>,    // For ModIndex
    scratch_feedback_mod: Vec<f32>, // For FeedbackMod
    scratch_detune_mod: Vec<f32>,   // For DetuneMod
}

impl ModulationProcessor for AnalogOscillator {}

impl AnalogOscillator {
    pub fn new(
        sample_rate: f32,
        waveform: Waveform,
        wavetable_banks: Arc<HashMap<Waveform, Arc<WavetableBank>>>,
    ) -> Self {
        let initial_capacity = 1024;
        let initial_voice_count = 1;
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
            gate_buffer: vec![0.0; initial_capacity],
            phase_mod_amount: 0.0,
            detune: 0.0,
            unison_voices: initial_voice_count,
            spread: 0.1,
            voice_phases: vec![0.0; initial_voice_count],
            voice_last_outputs: vec![0.0; initial_voice_count],
            wavetable_banks,
            // Initialize scratch buffers with the same initial capacity.
            scratch_global_freq: vec![440.0; initial_capacity],
            scratch_freq_mod: vec![1.0; initial_capacity],
            scratch_phase_mod: vec![0.0; initial_capacity],
            scratch_gain_mod: vec![1.0; initial_capacity],
            scratch_mod_index: vec![0.0; initial_capacity],
            scratch_feedback_mod: vec![1.0; initial_capacity],
            scratch_detune_mod: vec![0.0; initial_capacity],
        }
    }

    /// SIMD-accelerated helper that combines a base value with additive and multiplicative buffers.
    /// It computes (base + additive) * multiplicative for each sample.
    #[inline(always)]
    fn process_modulation_simd_in_place(
        output: &mut [f32],
        base: f32,
        additive: &[f32],
        multiplicative: &[f32],
    ) {
        let len = output.len();
        let base_simd = f32x4::splat(base);
        let chunks = len / 4;
        for c in 0..chunks {
            let idx = c * 4;
            let add_simd = f32x4::from_slice(&additive[idx..idx + 4]);
            let mul_simd = f32x4::from_slice(&multiplicative[idx..idx + 4]);
            let combined = (base_simd + add_simd) * mul_simd;
            combined.copy_to_slice(&mut output[idx..idx + 4]);
        }
        for i in (chunks * 4)..len {
            output[i] = (base + additive[i]) * multiplicative[i];
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
            self.voice_last_outputs = vec![0.0; new_voice_count];
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

/// Cubic interpolation for wavetable lookup.
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
        // --- 1) Process Gate Input ---
        if self.gate_buffer.len() < buffer_size {
            self.gate_buffer.resize(buffer_size, 0.0);
        } else {
            self.gate_buffer[..buffer_size].fill(0.0);
        }
        if let Some(gate_sources) = inputs.get(&PortId::GlobalGate) {
            for source in gate_sources {
                let min_len = std::cmp::min(buffer_size, source.buffer.len());
                for i in 0..min_len {
                    self.gate_buffer[i] += source.buffer[i] * source.amount;
                }
            }
        }

        // --- 2) Process GlobalFrequency Input ---
        if let Some(freq_sources) = inputs.get(&PortId::GlobalFrequency) {
            if !freq_sources.is_empty() && !freq_sources[0].buffer.is_empty() {
                let src = &freq_sources[0].buffer;
                let len = std::cmp::min(buffer_size, src.len());
                self.scratch_global_freq[..len].copy_from_slice(&src[..len]);
                if len < buffer_size {
                    self.scratch_global_freq[len..buffer_size].fill(self.frequency);
                }
            } else {
                self.scratch_global_freq[..buffer_size].fill(self.frequency);
            }
        } else {
            self.scratch_global_freq[..buffer_size].fill(self.frequency);
        }

        // --- 3) Process Modulation Inputs with SIMD ---
        let freq_mod = self.process_modulations_ex(buffer_size, inputs.get(&PortId::FrequencyMod));
        let phase_mod = self.process_modulations_ex(buffer_size, inputs.get(&PortId::PhaseMod));
        let gain_mod = self.process_modulations_ex(buffer_size, inputs.get(&PortId::GainMod));
        let mod_index = self.process_modulations_ex(buffer_size, inputs.get(&PortId::ModIndex));
        let feedback_mod =
            self.process_modulations_ex(buffer_size, inputs.get(&PortId::FeedbackMod));
        let detune_mod = self.process_modulations_ex(buffer_size, inputs.get(&PortId::DetuneMod));

        // Combine both additive and multiplicative parts.
        Self::process_modulation_simd_in_place(
            &mut self.scratch_freq_mod[..buffer_size],
            1.0,
            &freq_mod.additive,
            &freq_mod.multiplicative,
        );
        Self::process_modulation_simd_in_place(
            &mut self.scratch_phase_mod[..buffer_size],
            0.0,
            &phase_mod.additive,
            &phase_mod.multiplicative,
        );
        Self::process_modulation_simd_in_place(
            &mut self.scratch_gain_mod[..buffer_size],
            self.gain,
            &gain_mod.additive,
            &gain_mod.multiplicative,
        );
        Self::process_modulation_simd_in_place(
            &mut self.scratch_mod_index[..buffer_size],
            self.phase_mod_amount,
            &mod_index.additive,
            &mod_index.multiplicative,
        );
        Self::process_modulation_simd_in_place(
            &mut self.scratch_feedback_mod[..buffer_size],
            self.feedback_amount,
            &feedback_mod.additive,
            &feedback_mod.multiplicative,
        );
        Self::process_modulation_simd_in_place(
            &mut self.scratch_detune_mod[..buffer_size],
            0.0,
            &detune_mod.additive,
            &detune_mod.multiplicative,
        );

        // --- 4) Main Synthesis Loop ---
        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buf) => buf,
            None => return,
        };
        let sample_rate_recip = 1.0 / self.sample_rate;
        let semitone_ratio = 2.0_f32.powf(1.0 / 12.0);
        let cent_factor = 2.0_f32.powf(self.detune / 1200.0);

        for i in 0..buffer_size {
            self.check_gate(self.gate_buffer[i]);

            let freq_sample = self.scratch_global_freq[i];
            let freq_mod_sample = self.scratch_freq_mod[i];
            let phase_mod_sample = self.scratch_phase_mod[i];
            let gain_mod_sample = self.scratch_gain_mod[i];
            let mod_index_sample = self.scratch_mod_index[i];
            let feedback_mod_sample = self.scratch_feedback_mod[i];
            let detune_mod_sample = self.scratch_detune_mod[i];

            let modulated_freq = freq_sample * freq_mod_sample;
            let freq_with_cents = modulated_freq * cent_factor;
            let ext_phase_mod =
                (phase_mod_sample * mod_index_sample) / (2.0 * std::f32::consts::PI);
            let effective_feedback = feedback_mod_sample;

            let mut sample_sum = 0.0;

            for v in 0..self.unison_voices {
                let voice_offset = if self.unison_voices > 1 {
                    (self.spread * (2.0 * (v as f32 / ((self.unison_voices - 1) as f32)) - 1.0))
                        * 0.01
                } else {
                    0.0
                };
                let voice_detune = detune_mod_sample + voice_offset;
                let semitone_factor = semitone_ratio.powf(voice_detune);
                let effective_freq = freq_with_cents * semitone_factor;
                let phase_inc = effective_freq * sample_rate_recip;
                self.voice_phases[v] = (self.voice_phases[v] + phase_inc).rem_euclid(1.0);

                let voice_feedback_val = (self.voice_last_outputs[v] * effective_feedback)
                    / (std::f32::consts::PI * 1.5);

                let bank = self
                    .wavetable_banks
                    .get(&self.waveform)
                    .expect("Wavetable bank not found");
                let table = bank.select_table(effective_freq);
                let modulated_phase = self.voice_phases[v] + ext_phase_mod + voice_feedback_val;
                let normalized_phase = modulated_phase.rem_euclid(1.0);
                let pos = normalized_phase * (table.table_size as f32);
                let voice_sample = cubic_interp(&table.samples, pos);

                self.voice_last_outputs[v] = voice_sample;
                sample_sum += voice_sample;
            }

            // Corrected final sample calculation:
            let final_sample = (sample_sum / self.unison_voices as f32) * gain_mod_sample;
            output_buffer[i] = final_sample;
            self.last_output = final_sample;
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
