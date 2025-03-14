use core::simd::Simd;
use std::any::Any;
use std::collections::HashMap;
use std::simd::StdFloat;

use crate::graph::ModulationSource;
use crate::{AudioNode, PortId};

/// Modes for the arpeggiator.
#[derive(Clone, Copy, PartialEq, Eq)]
pub enum ArpeggiatorMode {
    /// Runs continuously.
    FreeRunning,
    /// Plays the pattern forward then in reverse.
    PingPong,
    /// Resets the progression on a gate trigger.
    Trigger,
}

/// A generator node that produces a modulation signal (in cents) according to an arpeggiator pattern.
/// This output can be routed (for example) to modulate an oscillator’s detune parameter.
/// In Trigger mode, a gate input (PortId::Gate) is used to reset the progression on a rising edge.
/// Optionally, it can output a gate signal (via PortId::GateOut) that can be used to trigger envelopes.
pub struct ArpeggiatorGenerator {
    /// Whether the arpeggiator is enabled.
    enabled: bool,
    /// The arpeggiator pattern (values in cents).
    pattern: Vec<f32>,
    /// Number of samples per arpeggiator step.
    step_samples: usize,
    /// A counter tracking the current sample position.
    sample_counter: usize,
    /// The selected arpeggiator mode.
    mode: ArpeggiatorMode,
    /// The previous gate state (for trigger mode edge detection).
    prev_gate_active: bool,
    /// Flag to control whether the node writes a gate signal.
    gate_output_enabled: bool,
    /// Field for storing the previous step index (for potential further extensions).
    prev_step: usize,
}

impl ArpeggiatorGenerator {
    /// Creates a new arpeggiator generator.
    pub fn new() -> Self {
        Self {
            enabled: false,
            pattern: Vec::new(),
            step_samples: 0,
            sample_counter: 0,
            mode: ArpeggiatorMode::FreeRunning,
            prev_gate_active: false,
            gate_output_enabled: false,
            prev_step: 0,
        }
    }

    /// Enable the arpeggiator with a given pattern (in cents) and step duration (in samples).
    pub fn enable(&mut self, pattern: Vec<f32>, step_samples: usize) {
        self.enabled = true;
        self.pattern = pattern;
        self.step_samples = step_samples;
        self.sample_counter = 0;
        self.prev_step = 0;
    }

    /// Disable the arpeggiator.
    pub fn disable(&mut self) {
        self.enabled = false;
    }

    /// Set the arpeggiator mode.
    pub fn set_mode(&mut self, mode: ArpeggiatorMode) {
        self.mode = mode;
    }

    /// Set the arpeggiator pattern and reset the progression.
    pub fn set_pattern(&mut self, pattern: Vec<f32>) {
        self.pattern = pattern;
        self.sample_counter = 0;
        self.prev_step = 0;
    }

    /// Set the delay time between steps (in samples) and reset the progression.
    pub fn set_delay_time(&mut self, delay_samples: usize) {
        self.step_samples = delay_samples;
        self.sample_counter = 0;
        self.prev_step = 0;
    }

    /// Enable or disable gate output.
    pub fn set_gate_output_enabled(&mut self, enabled: bool) {
        self.gate_output_enabled = enabled;
    }

    /// Computes the modulation value (in cents) for the given sample index.
    #[inline]
    fn modulation_value(&self, sample_index: usize) -> f32 {
        if !self.enabled || self.pattern.is_empty() || self.step_samples == 0 {
            return 0.0;
        }
        match self.mode {
            ArpeggiatorMode::FreeRunning | ArpeggiatorMode::Trigger => {
                let step = (sample_index / self.step_samples) % self.pattern.len();
                self.pattern[step]
            }
            ArpeggiatorMode::PingPong => {
                let n = self.pattern.len();
                if n == 1 {
                    return self.pattern[0];
                }
                let period = 2 * n - 2;
                let pos = (sample_index / self.step_samples) % period;
                let step = if pos < n { pos } else { period - pos };
                self.pattern[step]
            }
        }
    }

    /// Process modulation from a gate input.
    /// If no gate input is provided, returns a vector filled with the default value.
    fn process_modulations(
        &self,
        buffer_size: usize,
        maybe_sources: Option<&Vec<ModulationSource>>,
        default: f32,
    ) -> Vec<f32> {
        if let Some(sources) = maybe_sources {
            let buf = &sources[0].buffer;
            if buf.len() >= buffer_size {
                buf[..buffer_size].to_vec()
            } else {
                vec![default; buffer_size]
            }
        } else {
            vec![default; buffer_size]
        }
    }

    /// Process the arpeggiator in modes that use SIMD block processing.
    fn process_simd(&mut self, outputs: &mut HashMap<PortId, &mut [f32]>, buffer_size: usize) {
        let output = outputs
            .get_mut(&PortId::AudioOutput0)
            .expect("Expected AudioOutput0 output port");
        const LANES: usize = 4;
        type Vf32 = Simd<f32, LANES>;
        let mut i = 0;
        while i + LANES <= buffer_size {
            let global_index = self.sample_counter + i;
            let global_index_end = self.sample_counter + i + LANES - 1;
            // Check if all samples in this block fall into the same arpeggiator step.
            let step_start = (global_index / self.step_samples) as usize;
            let step_end = (global_index_end / self.step_samples) as usize;
            if self.enabled && step_start == step_end {
                let value = self.modulation_value(global_index);
                let modulation_vec = Vf32::splat(value);
                output[i..i + LANES].copy_from_slice(&modulation_vec.to_array());
            } else {
                for j in i..i + LANES {
                    output[j] = self.modulation_value(self.sample_counter + j);
                }
            }
            i += LANES;
        }
        // Process any remaining samples.
        for j in i..buffer_size {
            output[j] = self.modulation_value(self.sample_counter + j);
        }
        self.sample_counter += buffer_size;
    }

    /// Process the node in Trigger mode (sample-by-sample) to detect gate edges.
    fn process_trigger_mode(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        let output = outputs
            .get_mut(&PortId::AudioOutput0)
            .expect("Expected AudioOutput0 output port");
        let gate_mod = self.process_modulations(buffer_size, inputs.get(&PortId::GlobalGate), 0.0);
        for j in 0..buffer_size {
            let current_gate = gate_mod[j] > 0.5;
            if !self.prev_gate_active && current_gate {
                self.sample_counter = 0;
            }
            self.prev_gate_active = current_gate;
            output[j] = self.modulation_value(self.sample_counter);
            self.sample_counter += 1;
        }
    }

    /// Process the node while optionally writing a gate signal.
    ///
    /// This method routes the modulation output as usual, and if the gate output is enabled,
    /// writes a gate signal on PortId::GateOut. In this example, the gate signal is high (1.0)
    /// during most of a step and goes low (0.0) for a brief gap at the end of the step.
    fn process_with_optional_gate(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // Process modulation output according to mode.
        if self.mode == ArpeggiatorMode::Trigger {
            self.process_trigger_mode(inputs, outputs, buffer_size);
        } else {
            self.process_simd(outputs, buffer_size);
        }

        // If gate output is enabled, write the gate signal.
        if self.gate_output_enabled {
            if let Some(gate_output) = outputs.get_mut(&PortId::ArpGate) {
                // Define a gap duration (in samples) at the end of each step.
                let gap_samples = 2;
                // Compute the starting index for the current block.
                let block_start = self.sample_counter - buffer_size;
                for j in 0..buffer_size {
                    let global_index = block_start + j;
                    let relative = global_index % self.step_samples;
                    // Output 0.0 (gate off) during the gap, 1.0 otherwise.
                    gate_output[j] = if relative >= self.step_samples - gap_samples {
                        0.0
                    } else {
                        1.0
                    };
                }
            }
        }
    }
}

impl AudioNode for ArpeggiatorGenerator {
    /// Define the node's ports.
    ///
    /// - PortId::AudioOutput0: modulation output (in cents).
    /// - PortId::Gate: optional gate input (for Trigger mode).
    /// - PortId::GateOut: optional gate trigger output.
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::AudioOutput0, true);
        ports.insert(PortId::GlobalGate, false);
        ports.insert(PortId::ArpGate, true);

        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        self.process_with_optional_gate(inputs, outputs, buffer_size);
    }

    fn reset(&mut self) {
        self.sample_counter = 0;
        self.prev_gate_active = false;
        self.prev_step = 0;
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
    fn as_any(&self) -> &dyn Any {
        self
    }
    fn is_active(&self) -> bool {
        true
    }
    fn set_active(&mut self, _active: bool) {
        // Always active.
    }
    fn node_type(&self) -> &str {
        "arpeggiator_generator"
    }
}
