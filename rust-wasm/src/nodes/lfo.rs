use std::any::Any;
use std::collections::HashMap;
use std::simd::f32x4;
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
    Envelope, // Trigger lfo on gate
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
        LFO_TABLES.get_or_init(LfoTables::new);

        Self {
            phase: 0.0,
            frequency: 1.0,
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

    pub fn advance_phase(&mut self) {
        let phase_increment = self.frequency / self.sample_rate;
        self.phase = (self.phase + phase_increment) % 1.0;
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

    fn get_sample(&mut self, current_freq: f32) -> f32 {
        let tables = LFO_TABLES.get().unwrap();
        let table = tables.get_table(self.waveform);

        let table_phase = self.phase;
        let table_index = table_phase * TABLE_SIZE as f32;

        let index1 = (table_index as usize) & TABLE_MASK;
        let index2 = (index1 + 1) & TABLE_MASK;
        let fraction = table_index - table_index.floor();

        let sample1 = table[index1];
        let sample2 = table[index2];
        let mut sample = sample1 + (sample2 - sample1) * fraction;

        if self.use_absolute {
            sample = sample.abs();
        }
        if self.use_normalized {
            sample = (sample + 1.0) * 0.5;
        }

        let phase_increment = current_freq / self.sample_rate;
        self.phase = (self.phase + phase_increment) % 1.0;

        sample
    }

    pub fn get_waveform_data(waveform: LfoWaveform, buffer_size: usize) -> Vec<f32> {
        let tables = LFO_TABLES.get_or_init(LfoTables::new);
        let table = tables.get_table(waveform);
        let mut buffer = vec![0.0; buffer_size];
        let phase_increment = 1.0 / buffer_size as f32;
        let mut phase = 0.0;

        for buffer_value in buffer.iter_mut() {
            let table_index = phase * TABLE_SIZE as f32;
            let index1 = (table_index as usize) & TABLE_MASK;
            let index2 = (index1 + 1) & TABLE_MASK;
            let fraction = table_index - table_index.floor();

            let sample1 = table[index1];
            let sample2 = table[index2];
            *buffer_value = sample1 + (sample2 - sample1) * fraction;

            phase += phase_increment;
            if phase >= 1.0 {
                phase -= 1.0;
            }
        }

        buffer
    }

    pub fn is_active(&self) -> bool {
        self.active && self.trigger_mode == LfoTriggerMode::None
    }
}

impl ModulationProcessor for Lfo {
    fn get_modulation_type(&self, port: PortId) -> ModulationType {
        match port {
            PortId::Frequency => ModulationType::VCA,
            PortId::Gate => ModulationType::Additive,
            _ => ModulationType::VCA,
        }
    }
}

impl AudioNode for Lfo {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::Frequency, false);
        ports.insert(PortId::Gate, false);
        ports.insert(PortId::AudioOutput0, true);
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Helper function to process inputs
        let process_input = |sources: Option<&Vec<ModulationSource>>, default: f32| -> Vec<f32> {
            let mut result = vec![default; buffer_size];

            if let Some(sources) = sources {
                for source in sources {
                    match source.mod_type {
                        ModulationType::Additive => {
                            for (res, &src) in result.iter_mut().zip(source.buffer.iter()) {
                                *res += src * source.amount;
                            }
                        }
                        ModulationType::Bipolar => {
                            for (res, &src) in result.iter_mut().zip(source.buffer.iter()) {
                                *res *= 1.0 + (src * source.amount);
                            }
                        }
                        ModulationType::VCA => {
                            for (res, &src) in result.iter_mut().zip(source.buffer.iter()) {
                                *res *= 1.0 + (src * source.amount);
                            }
                        }
                    }
                }
            }

            result
        };

        // Process inputs
        let freq_input = process_input(inputs.get(&PortId::Frequency), self.frequency);
        let gate_input = process_input(inputs.get(&PortId::Gate), 0.0);

        // Process in chunks
        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            for i in (0..buffer_size).step_by(4) {
                let end = (i + 4).min(buffer_size);

                // Handle gate input for trigger mode
                let mut gate_chunk = [0.0; 4];
                gate_chunk[0..end - i].copy_from_slice(&gate_input[i..end]);
                let gate_values = f32x4::from_array(gate_chunk);
                let gate_array = gate_values.to_array();

                for j in 0..(end - i) {
                    let current_gate = gate_array[j];
                    match self.trigger_mode {
                        LfoTriggerMode::Envelope => {
                            if current_gate > 0.0 && self.last_gate <= 0.0 {
                                self.reset();
                            }
                        }
                        LfoTriggerMode::None => {}
                    }
                    self.last_gate = current_gate;
                }

                // Generate output with frequency modulation
                let mut values = [0.0f32; 4];
                let mut freq_chunk = [self.frequency; 4];
                freq_chunk[0..end - i].copy_from_slice(&freq_input[i..end]);

                for j in 0..(end - i) {
                    values[j] = self.get_sample(freq_chunk[j]);
                }

                output[i..end].copy_from_slice(&values[0..end - i]);
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
