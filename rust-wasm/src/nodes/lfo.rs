use std::any::Any;
use std::collections::HashMap;
use std::simd::num::SimdFloat;
use std::simd::{f32x4, StdFloat};
use std::sync::OnceLock;

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
    None,     // LFO runs freely
    Envelope, // Trigger LFO on gate
}

impl LfoTriggerMode {
    pub fn from_u8(value: u8) -> Self {
        match value {
            0 => LfoTriggerMode::None,
            1 => LfoTriggerMode::Envelope,
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
            let normalized_phase = i as f32 / TABLE_SIZE as f32;

            sine[i] = phase.sin();
            triangle[i] = if normalized_phase < 0.25 {
                4.0 * normalized_phase
            } else if normalized_phase < 0.75 {
                2.0 - 4.0 * normalized_phase
            } else {
                -4.0 + 4.0 * normalized_phase
            };

            square[i] = if normalized_phase < 0.5 { 1.0 } else { -1.0 };
            saw[i] = if normalized_phase < 0.999 {
                -1.0 + 2.0 * normalized_phase
            } else {
                -1.0
            };
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
            trigger_mode: LfoTriggerMode::Envelope,
            last_gate: 0.0,
            active: false,
        }
    }

    /// Public method used by external callers (e.g. for free‑running LFOs).
    /// It always advances the phase using the current static frequency.
    pub fn advance_phase(&mut self) {
        self.advance_phase_with(self.frequency);
    }

    /// Private helper to advance the phase by a given frequency.
    /// This is used internally so that we can apply frequency modulation.
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

    pub fn set_use_absolute(&mut self, use_absolute: bool) {
        self.use_absolute = use_absolute;
    }

    pub fn set_use_normalized(&mut self, use_normalized: bool) {
        self.use_normalized = use_normalized;
    }

    pub fn set_trigger_mode(&mut self, mode: LfoTriggerMode) {
        self.trigger_mode = mode;
    }

    /// Returns a sample and advances the phase.
    /// This method is used in the scalar (envelope‑trigger) path.
    fn get_sample(&mut self, current_freq: f32) -> f32 {
        let tables = LFO_TABLES.get().unwrap();
        let table = tables.get_table(self.waveform);

        let table_phase = self.phase;
        let table_index = table_phase * TABLE_SIZE as f32;
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

    /// Returns waveform data from the corresponding lookup table.
    /// This version uses SIMD to fill the buffer in blocks of 4 samples at a time.
    pub fn get_waveform_data(waveform: LfoWaveform, buffer_size: usize) -> Vec<f32> {
        let tables = LFO_TABLES.get_or_init(LfoTables::new);
        let table = tables.get_table(waveform);
        let mut buffer = vec![0.0; buffer_size];
        let phase_increment = 1.0 / buffer_size as f32;
        let mut phase = 0.0;
        let table_size_f = TABLE_SIZE as f32;
        let mut i = 0;

        // Process in SIMD blocks of 4 samples.
        while i + 4 <= buffer_size {
            let phases = f32x4::from_array([
                phase,
                phase + phase_increment,
                phase + 2.0 * phase_increment,
                phase + 3.0 * phase_increment,
            ]);
            let table_indices = phases * f32x4::splat(table_size_f);
            let index_f = table_indices.floor();
            let fraction = table_indices - index_f;

            // Compute the lookup indices (wrapping around via TABLE_MASK)
            let i0 = (index_f[0] as usize) & TABLE_MASK;
            let i1 = (index_f[1] as usize) & TABLE_MASK;
            let i2 = (index_f[2] as usize) & TABLE_MASK;
            let i3 = (index_f[3] as usize) & TABLE_MASK;
            let i0_next = (i0 + 1) & TABLE_MASK;
            let i1_next = (i1 + 1) & TABLE_MASK;
            let i2_next = (i2 + 1) & TABLE_MASK;
            let i3_next = (i3 + 1) & TABLE_MASK;

            // Linear interpolation for each lane.
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
            let table_index = phase * table_size_f;
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

    pub fn is_active(&self) -> bool {
        self.active && self.trigger_mode == LfoTriggerMode::None
    }
}

// === Modulation Processor Implementation ===
//
// Here we override `get_modulation_type` for the ports we use in this node.
impl ModulationProcessor for Lfo {}

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
        // Retrieve per‑sample modulation arrays.
        // For frequency and gain modulation we start with a “neutral” multiplier (1.0).
        let freq_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::FrequencyMod), 1.0);
        let gate_mod = self.process_modulations(buffer_size, inputs.get(&PortId::Gate), 0.0);
        let gain_mod = self.process_modulations(buffer_size, inputs.get(&PortId::GainMod), 1.0);

        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            // Free‑running mode: use SIMD processing.
            if self.trigger_mode == LfoTriggerMode::None {
                let table = LFO_TABLES.get().unwrap().get_table(self.waveform);
                let table_size_f = TABLE_SIZE as f32;
                let sample_rate = self.sample_rate;
                let base_frequency = self.frequency;
                let mut phase = self.phase;
                let mut i = 0;
                while i + 4 <= buffer_size {
                    // Compute per‑sample effective frequencies.
                    let freq0 = base_frequency * freq_mod[i];
                    let freq1 = base_frequency * freq_mod[i + 1];
                    let freq2 = base_frequency * freq_mod[i + 2];
                    let freq3 = base_frequency * freq_mod[i + 3];
                    let inc0 = freq0 / sample_rate;
                    let inc1 = freq1 / sample_rate;
                    let inc2 = freq2 / sample_rate;
                    let inc3 = freq3 / sample_rate;

                    // Compute the phases for the four samples.
                    let p0 = phase;
                    let p1 = p0 + inc0;
                    let p2 = p1 + inc1;
                    let p3 = p2 + inc2;
                    let phases = f32x4::from_array([p0, p1, p2, p3]);

                    // Lookup table index and interpolation.
                    let table_indices = phases * f32x4::splat(table_size_f);
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

                    // Apply use_absolute / normalized settings.
                    let mut sample_vec = f32x4::from_array([sample0, sample1, sample2, sample3]);
                    if self.use_absolute {
                        sample_vec = sample_vec.abs();
                    }
                    if self.use_normalized {
                        sample_vec = (sample_vec + f32x4::splat(1.0)) * f32x4::splat(0.5);
                    }

                    // Apply gain modulation.
                    let gain0 = self.gain * gain_mod[i];
                    let gain1 = self.gain * gain_mod[i + 1];
                    let gain2 = self.gain * gain_mod[i + 2];
                    let gain3 = self.gain * gain_mod[i + 3];
                    let gain_vec = f32x4::from_array([gain0, gain1, gain2, gain3]);
                    sample_vec = sample_vec * gain_vec;

                    // Store the computed samples.
                    let out = sample_vec.to_array();
                    output[i] = out[0];
                    output[i + 1] = out[1];
                    output[i + 2] = out[2];
                    output[i + 3] = out[3];

                    // Advance phase: note that the final phase for this block is computed as:
                    // p3 + inc3.
                    phase = p3 + inc3;
                    if phase >= 1.0 {
                        phase %= 1.0;
                    }
                    i += 4;
                }
                self.phase = phase;
                // Process any remaining samples in scalar.
                for j in i..buffer_size {
                    let freq = base_frequency * freq_mod[j];
                    let inc = freq / sample_rate;
                    let table_index = phase * table_size_f;
                    let index = (table_index as usize) & TABLE_MASK;
                    let index_next = (index + 1) & TABLE_MASK;
                    let fraction = table_index - table_index.floor();
                    let mut sample = table[index] + (table[index_next] - table[index]) * fraction;
                    if self.use_absolute {
                        sample = sample.abs();
                    }
                    if self.use_normalized {
                        sample = (sample + 1.0) * 0.5;
                    }
                    let effective_gain = self.gain * gain_mod[j];
                    output[j] = sample * effective_gain;
                    phase += inc;
                    if phase >= 1.0 {
                        phase -= 1.0;
                    }
                }
                self.phase = phase;
            } else {
                // In envelope‑trigger mode we check for rising edges on each sample.
                // Use scalar processing.
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
            }
        }
    }

    fn reset(&mut self) {
        self.phase = 0.0;
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
        "lfo"
    }
}
