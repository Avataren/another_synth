use std::any::Any;
use std::collections::HashMap;
use std::simd::num::SimdFloat;
use std::simd::{f32x4, StdFloat};
use std::sync::OnceLock;

use web_sys::console;

use crate::graph::{ModulationProcessor, ModulationSource, ModulationType};
use crate::traits::{AudioNode, PortId};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LfoWaveform {
    Sine,
    Triangle,
    Square,
    Saw,
}

struct LfoTables {
    sine: Vec<f32>,
    triangle: Vec<f32>,
    square: Vec<f32>,
    saw: Vec<f32>,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LfoTriggerMode {
    None,     // LFO runs freely (loops continuously)
    Envelope, // Trigger LFO on gate (repeats waveform)
    OneShot,  // Trigger LFO on gate, play once, then hold the final sample
}

impl LfoTriggerMode {
    pub fn from_u8(value: u8) -> Self {
        match value {
            0 => LfoTriggerMode::None,
            1 => LfoTriggerMode::Envelope,
            2 => LfoTriggerMode::OneShot,
            _ => LfoTriggerMode::None,
        }
    }
}

static LFO_TABLES: OnceLock<LfoTables> = OnceLock::new();

const TABLE_SIZE: usize = 1024;
const TABLE_MASK: usize = TABLE_SIZE - 1;

impl LfoTables {
    fn new() -> Self {
        let mut sine = vec![0.0; TABLE_SIZE];
        let mut triangle = vec![0.0; TABLE_SIZE];
        let mut square = vec![0.0; TABLE_SIZE];
        let mut saw = vec![0.0; TABLE_SIZE];

        for i in 0..TABLE_SIZE {
            let phase = 2.0 * std::f32::consts::PI * (i as f32) / (TABLE_SIZE as f32);
            let normalized_phase = i as f32 / (TABLE_SIZE as f32);

            sine[i] = phase.sin();
            triangle[i] = if normalized_phase < 0.25 {
                4.0 * normalized_phase
            } else if normalized_phase < 0.75 {
                2.0 - 4.0 * normalized_phase
            } else {
                -4.0 + 4.0 * normalized_phase
            };

            square[i] = if normalized_phase < 0.5 { 1.0 } else { -1.0 };

            // For saw, use TABLE_SIZE-1 so that when i == TABLE_SIZE-1, the value is exactly 1.0.
            let saw_phase = i as f32 / ((TABLE_SIZE - 1) as f32);
            saw[i] = -1.0 + 2.0 * saw_phase;
        }

        Self {
            sine,
            triangle,
            square,
            saw,
        }
    }

    fn get_table(&self, waveform: LfoWaveform) -> &[f32] {
        match waveform {
            LfoWaveform::Sine => &self.sine,
            LfoWaveform::Triangle => &self.triangle,
            LfoWaveform::Square => &self.square,
            LfoWaveform::Saw => &self.saw,
        }
    }
}

pub struct Lfo {
    phase: f32,
    frequency: f32,
    gain: f32,
    waveform: LfoWaveform,
    phase_offset: f32,
    sample_rate: f32,
    use_absolute: bool,
    use_normalized: bool,
    pub trigger_mode: LfoTriggerMode,
    last_gate: f32,
    active: bool,
    /// When in OneShot mode, once the cycle completes (phase reaches 1.0)
    /// we store the final sample here to hold it for subsequent calls.
    oneshot_final_sample: Option<f32>,
}

impl Lfo {
    pub fn new(sample_rate: f32) -> Self {
        // Initialize the lookup tables once.
        LFO_TABLES.get_or_init(LfoTables::new);

        Self {
            phase: 0.0,
            frequency: 1.0,
            gain: 1.0,
            waveform: LfoWaveform::Sine,
            phase_offset: 0.0,
            sample_rate,
            use_absolute: false,
            use_normalized: false,
            trigger_mode: LfoTriggerMode::None,
            last_gate: 0.0,
            active: true,
            oneshot_final_sample: None,
        }
    }

    /// Advances the phase using the current frequency, equal to one bufferts worth.
    pub fn advance_phase_one_buffer(&mut self) {
        self.advance_phase_with(self.frequency * 128.0);
    }

    /// Advances the phase by the specified frequency (wrapping at 1.0).
    fn advance_phase_with(&mut self, current_freq: f32) {
        let phase_increment = current_freq / self.sample_rate;
        self.phase = (self.phase + phase_increment) % 1.0;
    }

    pub fn set_gain(&mut self, gain: f32) {
        self.gain = gain;
    }

    pub fn set_frequency(&mut self, freq: f32) {
        self.frequency = freq.max(0.0);
    }

    pub fn set_waveform(&mut self, waveform: LfoWaveform) {
        self.waveform = waveform;
    }

    pub fn set_phase_offset(&mut self, offset: f32) {
        self.phase_offset = offset;
    }

    pub fn set_use_absolute(&mut self, use_absolute: bool) {
        self.use_absolute = use_absolute;
    }

    pub fn set_use_normalized(&mut self, use_normalized: bool) {
        self.use_normalized = use_normalized;
    }

    pub fn set_trigger_mode(&mut self, mode: LfoTriggerMode) {
        self.reset();
        if (mode == LfoTriggerMode::Envelope) {
            self.trigger_mode = LfoTriggerMode::OneShot;
        } else {
            self.trigger_mode = LfoTriggerMode::None;
        }
    }

    /// Returns a sample and advances the phase.
    /// This version wraps the phase (used in free‑running and envelope modes).
    fn get_sample(&mut self, current_freq: f32) -> f32 {
        let tables = LFO_TABLES.get().unwrap();
        let table = tables.get_table(self.waveform);

        // Apply phase offset; wrap phase to [0.0, 1.0).
        let effective_phase = (self.phase + self.phase_offset) % 1.0;
        let table_index = effective_phase * TABLE_SIZE as f32;
        let index1 = (table_index as usize) & TABLE_MASK;
        let index2 = (index1 + 1) & TABLE_MASK;
        let fraction = table_index - table_index.floor();

        let mut sample = table[index1] + (table[index2] - table[index1]) * fraction;
        if self.use_absolute {
            sample = sample.abs();
        }
        if self.use_normalized {
            sample = (sample + 1.0) * 0.5;
        }

        self.advance_phase_with(current_freq);

        sample
    }

    /// In OneShot mode, the LFO runs from phase 0 to 1 once.
    /// Once 1.0 is reached, the final sample is stored and held.
    fn get_sample_one_shot(&mut self, current_freq: f32) -> f32 {
        // If we've already finished the cycle, simply return the held final sample.
        if let Some(final_sample) = self.oneshot_final_sample {
            return final_sample;
        }

        let phase_increment = current_freq / self.sample_rate;
        let tables = LFO_TABLES.get().unwrap();
        let table = tables.get_table(self.waveform);

        // Only the fractional part of the phase_offset matters.
        let offset = self.phase_offset.fract();
        // Compute the lookup phase without affecting the LFO's internal phase.
        let effective_phase = (self.phase + offset) % 1.0;

        // In one-shot mode we use TABLE_SIZE-1 so that an effective phase of 1.0 maps
        // exactly to the final table entry.
        let table_index = effective_phase * ((TABLE_SIZE - 1) as f32);
        let index1 = table_index.floor() as usize;
        let index2 = if index1 + 1 < TABLE_SIZE {
            index1 + 1
        } else {
            index1
        };
        let fraction = table_index - table_index.floor();

        let mut sample = table[index1] + (table[index2] - table[index1]) * fraction;
        if self.use_absolute {
            sample = sample.abs();
        }
        if self.use_normalized {
            sample = (sample + 1.0) * 0.5;
        }

        // Advance the internal phase but clamp it to 1.0.
        self.phase = (self.phase + phase_increment).min(1.0);
        if self.phase >= 1.0 {
            self.oneshot_final_sample = Some(sample);
        }
        sample
    }

    /// Returns waveform data as a vector of samples using SIMD processing.
    pub fn get_waveform_data(
        waveform: LfoWaveform,
        phase_offset: f32,
        buffer_size: usize,
    ) -> Vec<f32> {
        let tables = LFO_TABLES.get_or_init(LfoTables::new);
        let table = tables.get_table(waveform);
        let mut buffer = vec![0.0; buffer_size];
        let phase_increment = 1.0 / buffer_size as f32;
        let mut phase = 0.0;
        let table_size_f = TABLE_SIZE as f32;
        let mut i = 0;

        // Process samples in SIMD blocks of 4.
        while i + 4 <= buffer_size {
            let phases = f32x4::from_array([
                phase,
                phase + phase_increment,
                phase + 2.0 * phase_increment,
                phase + 3.0 * phase_increment,
            ]);
            let effective_phases = (phases + f32x4::splat(phase_offset))
                - (phases + f32x4::splat(phase_offset)).floor();
            let table_indices = effective_phases * f32x4::splat(table_size_f);
            let index_f = table_indices.floor();
            let fraction = table_indices - index_f;
            let i0 = (index_f[0] as usize) & TABLE_MASK;
            let i1 = (index_f[1] as usize) & TABLE_MASK;
            let i2 = (index_f[2] as usize) & TABLE_MASK;
            let i3 = (index_f[3] as usize) & TABLE_MASK;
            let i0_next = (i0 + 1) & TABLE_MASK;
            let i1_next = (i1 + 1) & TABLE_MASK;
            let i2_next = (i2 + 1) & TABLE_MASK;
            let i3_next = (i3 + 1) & TABLE_MASK;

            let sample0 = table[i0] + (table[i0_next] - table[i0]) * fraction[0];
            let sample1 = table[i1] + (table[i1_next] - table[i1]) * fraction[1];
            let sample2 = table[i2] + (table[i2_next] - table[i2]) * fraction[2];
            let sample3 = table[i3] + (table[i3_next] - table[i3]) * fraction[3];

            buffer[i] = sample0;
            buffer[i + 1] = sample1;
            buffer[i + 2] = sample2;
            buffer[i + 3] = sample3;

            phase += 4.0 * phase_increment;
            if phase >= 1.0 {
                phase -= 1.0;
            }
            i += 4;
        }

        // Process any remaining samples.
        while i < buffer_size {
            let effective_phase = (phase + phase_offset) % 1.0;
            let table_index = effective_phase * table_size_f;
            let index = (table_index as usize) & TABLE_MASK;
            let index_next = (index + 1) & TABLE_MASK;
            let fraction = table_index - table_index.floor();
            buffer[i] = table[index] + (table[index_next] - table[index]) * fraction;
            phase += phase_increment;
            if phase >= 1.0 {
                phase -= 1.0;
            }
            i += 1;
        }
        buffer
    }

    /// Resets the LFO phase. In OneShot mode, also clears the stored final sample.
    fn reset(&mut self) {
        self.phase = 0.0;
        self.oneshot_final_sample = None;
    }
}

//
// === ModulationProcessor Implementation ===
//
impl ModulationProcessor for Lfo {}

//
// === AudioNode Implementation ===
//
impl AudioNode for Lfo {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::FrequencyMod, false);
        ports.insert(PortId::Gate, false);
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
        let freq_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::FrequencyMod), 1.0);
        let gate_mod = self.process_modulations(buffer_size, inputs.get(&PortId::Gate), 0.0);
        let gain_mod = self.process_modulations(buffer_size, inputs.get(&PortId::GainMod), 1.0);

        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            if self.trigger_mode == LfoTriggerMode::None {
                // Free‑running mode: run continuously without any gate trigger.
                for i in 0..buffer_size {
                    let effective_freq = self.frequency * freq_mod[i];
                    let sample = self.get_sample(effective_freq);
                    let effective_gain = self.gain * gain_mod[i];
                    output[i] = sample * effective_gain;
                }
            } else if self.trigger_mode == LfoTriggerMode::Envelope {
                // Envelope mode: reset on gate trigger; continuously wraps.
                for i in 0..buffer_size {
                    if gate_mod[i] > 0.0 && self.last_gate <= 0.0 {
                        self.reset();
                    }
                    self.last_gate = gate_mod[i];
                    let effective_freq = self.frequency * freq_mod[i];
                    let sample = self.get_sample(effective_freq);
                    let effective_gain = self.gain * gain_mod[i];
                    output[i] = sample * effective_gain;
                }
            } else if self.trigger_mode == LfoTriggerMode::OneShot {
                // OneShot mode: reset on gate trigger; once phase reaches 1.0, hold the final sample.
                for i in 0..buffer_size {
                    if gate_mod[i] > 0.0 && self.last_gate <= 0.0 {
                        self.reset();
                    }
                    self.last_gate = gate_mod[i];
                    let effective_freq = self.frequency * freq_mod[i];
                    let effective_gain = self.gain * gain_mod[i];
                    let sample = self.get_sample_one_shot(effective_freq);
                    output[i] = sample * effective_gain;
                }
            }
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

    fn should_process(&self) -> bool {
        self.active
    }

    fn reset(&mut self) {
        self.phase = 0.0;
        if self.trigger_mode == LfoTriggerMode::OneShot {
            self.oneshot_final_sample = None;
        }
    }

    fn node_type(&self) -> &str {
        "lfo"
    }
}
