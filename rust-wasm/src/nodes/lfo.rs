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

    /// Returns a sample and advances the phase. The frequency used for phase advancement
    /// is taken as the effective frequency for that sample.
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

// === Modulation Processor Implementation ===
//
// Here we override `get_modulation_type` for the ports we use in this node. In this
// refactoring we want frequency and gain modulation to be bipolar (i.e. to produce a
// multiplier of (1.0 + modulation)) while gate modulation remains additive.
impl ModulationProcessor for Lfo {
    fn get_modulation_type(&self, port: PortId) -> ModulationType {
        match port {
            PortId::FrequencyMod => ModulationType::VCA,
            PortId::Gate => ModulationType::Additive,
            PortId::GainMod => ModulationType::VCA,
            _ => ModulationType::VCA,
        }
    }
}

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
        // Use the modulation processor to obtain per‑sample modulation data.
        //
        // For frequency and gain modulation we choose an initial value of 1.0 so that,
        // when multiplied by the static parameter (self.frequency or self.gain),
        // no modulation results in an unchanged value.
        let freq_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::FrequencyMod),
            1.0,
            PortId::Frequency,
        );
        let gate_mod =
            self.process_modulations(buffer_size, inputs.get(&PortId::Gate), 0.0, PortId::Gate);
        let gain_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::GainMod),
            1.0,
            PortId::GainMod,
        );

        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            // Process each sample (you can still process in SIMD chunks for the gate if desired)
            for i in 0..buffer_size {
                // If using envelope trigger mode, check for a rising edge on the gate.
                if self.trigger_mode == LfoTriggerMode::Envelope {
                    if gate_mod[i] > 0.0 && self.last_gate <= 0.0 {
                        self.reset();
                    }
                    self.last_gate = gate_mod[i];
                }

                // Compute the effective frequency: apply frequency modulation
                let effective_freq = self.frequency * freq_mod[i];
                let sample = self.get_sample(effective_freq);

                // Compute the effective gain: multiply the static gain by the gain modulation.
                let effective_gain = self.gain * gain_mod[i];
                output[i] = sample * effective_gain;
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
