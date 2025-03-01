use std::any::Any;
use std::collections::HashMap;
use std::simd::num::SimdFloat;
use std::simd::{f32x4, StdFloat};
use std::sync::OnceLock;

use wasm_bindgen::prelude::wasm_bindgen;
use web_sys::console;

use crate::graph::{ModulationProcessor, ModulationSource, ModulationType};
use crate::traits::{AudioNode, PortId};

#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LfoWaveform {
    Sine,
    Triangle,
    Square,
    Saw,
    InverseSaw,
}

impl LfoWaveform {
    /// Returns the waveform‑specific normalized phase offset.
    /// For normalized mode, we want –0.25 for sine/triangle,
    /// and 0.0 for pulse (Square), saw, and inverse saw.
    fn normalized_phase_offset(self) -> f32 {
        match self {
            LfoWaveform::Sine => -0.25,
            LfoWaveform::Triangle => -0.25,
            _ => 0.0,
        }
    }
}

struct LfoTables {
    sine: Vec<f32>,
    triangle: Vec<f32>,
    square: Vec<f32>,
    saw: Vec<f32>,
    inverse_saw: Vec<f32>,
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

#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LfoLoopMode {
    Off = 0,
    Loop = 1,
    PingPong = 2,
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
        let mut inverse_saw = vec![0.0; TABLE_SIZE];

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

            let saw_phase = i as f32 / (TABLE_SIZE as f32);
            saw[i] = -1.0 + 2.0 * saw_phase;
            inverse_saw[i] = saw[i] * -1.0;
        }

        Self {
            sine,
            triangle,
            square,
            saw,
            inverse_saw,
        }
    }

    fn get_table(&self, waveform: LfoWaveform) -> &[f32] {
        match waveform {
            LfoWaveform::Sine => &self.sine,
            LfoWaveform::Triangle => &self.triangle,
            LfoWaveform::Square => &self.square,
            LfoWaveform::Saw => &self.saw,
            LfoWaveform::InverseSaw => &self.inverse_saw,
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
    /// In OneShot mode, once the cycle completes (phase reaches 1.0)
    /// we store the final sample here to hold it for subsequent calls.
    oneshot_final_sample: Option<f32>,

    // New fields for loop control.
    pub loop_mode: LfoLoopMode,
    pub loop_start: f32, // valid range: 0.0 to 1.0
    pub loop_end: f32,   // valid range: loop_start to 1.0
    pub direction: f32,  // Used in pingpong mode; 1.0 for forward, -1.0 for reverse
}

impl Lfo {
    pub fn new(sample_rate: f32) -> Self {
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
            loop_mode: LfoLoopMode::Off,
            loop_start: 0.0,
            loop_end: 0.999,
            direction: 1.0,
        }
    }

    /// Advances the phase for free‑running voices (even when inactive).
    pub fn advance_phase_one_buffer(&mut self) {
        let phase_increment = (self.frequency * 128.0) / self.sample_rate;
        self.phase = (self.phase + phase_increment) % 1.0;
    }

    /// Advances the phase by the specified frequency.
    fn advance_phase_with(&mut self, current_freq: f32) {
        let phase_increment = current_freq / self.sample_rate;

        if self.trigger_mode == LfoTriggerMode::Envelope {
            if self.loop_mode == LfoLoopMode::PingPong {
                if self.phase < self.loop_start {
                    self.phase += phase_increment;
                    if self.phase >= self.loop_end {
                        self.phase = self.loop_end;
                        self.direction = -1.0;
                    }
                    return;
                } else {
                    let new_phase = self.phase + phase_increment * self.direction;
                    if new_phase >= self.loop_end {
                        self.phase = self.loop_end;
                        self.direction = -1.0;
                    } else if new_phase <= self.loop_start {
                        self.phase = self.loop_start;
                        self.direction = 1.0;
                    } else {
                        self.phase = new_phase;
                    }
                    return;
                }
            } else {
                self.phase += phase_increment;
                if self.loop_mode == LfoLoopMode::Loop && self.phase >= self.loop_end {
                    self.phase = self.loop_start + (self.phase - self.loop_end);
                } else {
                    self.phase %= 1.0;
                }
                return;
            }
        }

        match self.loop_mode {
            LfoLoopMode::Off => {
                self.phase = (self.phase + phase_increment) % 1.0;
            }
            LfoLoopMode::Loop => {
                self.phase += phase_increment;
                if self.phase >= self.loop_end {
                    self.phase = self.loop_start + (self.phase - self.loop_end);
                }
            }
            LfoLoopMode::PingPong => {
                let new_phase = self.phase + phase_increment * self.direction;
                if new_phase >= self.loop_end {
                    self.phase = self.loop_end;
                    self.direction = -1.0;
                } else if new_phase <= self.loop_start {
                    self.phase = self.loop_start;
                    self.direction = 1.0;
                } else {
                    self.phase = new_phase;
                }
            }
        }
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
        self.trigger_mode = mode;
        self.reset();
    }

    pub fn set_loop_mode(&mut self, loop_mode: LfoLoopMode) {
        self.loop_mode = loop_mode;
    }

    pub fn set_loop_start(&mut self, start: f32) {
        self.loop_start = start.clamp(0.0, 1.0);
        if self.loop_end < self.loop_start {
            self.loop_end = self.loop_start;
        }
    }

    pub fn set_loop_end(&mut self, end: f32) {
        self.loop_end = end.clamp(0.0, 0.999);
        if self.loop_end < self.loop_start {
            self.loop_start = self.loop_end;
        }
    }

    /// Returns a sample and advances the phase.
    /// This version wraps the phase (used in free‑running and envelope modes).
    fn get_sample(&mut self, current_freq: f32) -> f32 {
        let tables = LFO_TABLES.get().unwrap();
        let table = tables.get_table(self.waveform);

        // Use waveform-specific normalized phase offset if requested.
        let extra_phase = if self.use_normalized {
            self.waveform.normalized_phase_offset()
        } else {
            0.0
        };
        let effective_phase = (self.phase + self.phase_offset + extra_phase).rem_euclid(1.0);
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
        if let Some(final_sample) = self.oneshot_final_sample {
            return final_sample;
        }
        let phase_increment = current_freq / self.sample_rate;
        let tables = LFO_TABLES.get().unwrap();
        let table = tables.get_table(self.waveform);
        let extra_phase = if self.use_normalized {
            self.waveform.normalized_phase_offset()
        } else {
            0.0
        };
        let effective_phase = (self.phase + self.phase_offset + extra_phase).rem_euclid(1.0);
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

        self.phase = (self.phase + phase_increment).min(1.0);
        if self.phase >= 1.0 {
            self.oneshot_final_sample = Some(sample);
        }
        sample
    }

    /// Returns waveform data as a vector of samples using SIMD processing.
    /// Now takes use_absolute and use_normalized into account.
    pub fn get_waveform_data(
        waveform: LfoWaveform,
        phase_offset: f32,
        buffer_size: usize,
        use_absolute: bool,
        use_normalized: bool,
    ) -> Vec<f32> {
        let tables = LFO_TABLES.get_or_init(LfoTables::new);
        let table = tables.get_table(waveform);
        let mut buffer = vec![0.0; buffer_size];
        let phase_increment = 1.0 / buffer_size as f32;
        let mut phase = 0.0;
        let table_size_f = TABLE_SIZE as f32;
        let mut i = 0;

        while i + 4 <= buffer_size {
            let phases = f32x4::from_array([
                phase,
                phase + phase_increment,
                phase + 2.0 * phase_increment,
                phase + 3.0 * phase_increment,
            ]);
            let extra_phase = if use_normalized {
                waveform.normalized_phase_offset()
            } else {
                0.0
            };
            let effective_phases = (phases + f32x4::splat(phase_offset + extra_phase))
                - (phases + f32x4::splat(phase_offset + extra_phase)).floor();
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

            let mut sample0 = table[i0] + (table[i0_next] - table[i0]) * fraction[0];
            let mut sample1 = table[i1] + (table[i1_next] - table[i1]) * fraction[1];
            let mut sample2 = table[i2] + (table[i2_next] - table[i2]) * fraction[2];
            let mut sample3 = table[i3] + (table[i3_next] - table[i3]) * fraction[3];

            if use_absolute {
                sample0 = sample0.abs();
                sample1 = sample1.abs();
                sample2 = sample2.abs();
                sample3 = sample3.abs();
            }

            if use_normalized {
                sample0 = (sample0 + 1.0) * 0.5;
                sample1 = (sample1 + 1.0) * 0.5;
                sample2 = (sample2 + 1.0) * 0.5;
                sample3 = (sample3 + 1.0) * 0.5;
            }

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

        while i < buffer_size {
            let extra_phase = if use_normalized {
                waveform.normalized_phase_offset()
            } else {
                0.0
            };
            let effective_phase = (phase + phase_offset + extra_phase).rem_euclid(1.0);
            let table_index = effective_phase * table_size_f;
            let index = (table_index as usize) & TABLE_MASK;
            let index_next = (index + 1) & TABLE_MASK;
            let fraction = table_index - table_index.floor();

            let mut sample = table[index] + (table[index_next] - table[index]) * fraction;

            if use_absolute {
                sample = sample.abs();
            }
            if use_normalized {
                sample = (sample + 1.0) * 0.5;
            }

            buffer[i] = sample;
            phase += phase_increment;
            if phase >= 1.0 {
                phase -= 1.0;
            }
            i += 1;
        }
        buffer
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
                for i in 0..buffer_size {
                    let effective_freq = self.frequency * freq_mod[i];
                    let sample = self.get_sample(effective_freq);
                    let effective_gain = self.gain * gain_mod[i];
                    output[i] = sample * effective_gain;
                }
            } else if self.trigger_mode == LfoTriggerMode::Envelope {
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

    /// Resets the LFO phase.
    /// In OneShot mode, also clears the stored final sample.
    fn reset(&mut self) {
        if self.trigger_mode == LfoTriggerMode::Envelope {
            self.phase = 0.0;
        } else if self.loop_mode != LfoLoopMode::Off {
            self.phase = self.loop_start;
        } else {
            self.phase = 0.0;
        }
        self.direction = 1.0;
        self.oneshot_final_sample = None;
    }

    fn node_type(&self) -> &str {
        "lfo"
    }
}
