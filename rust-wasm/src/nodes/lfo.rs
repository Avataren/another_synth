use std::any::Any;
use std::collections::HashMap;
use std::sync::OnceLock;

use crate::processing::{AudioProcessor, ProcessContext};
use crate::traits::{AudioNode, PortId};

// Define waveform types
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum LfoWaveform {
    Sine,
    Triangle,
    Square,
    Saw,
}

// Lookup table structure
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

// Global static tables using OnceLock for lazy initialization
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

            // Sine: starts at 0, goes up to 1, down to -1, back to 0
            sine[i] = phase.sin();

            // Triangle: starts at 0, goes up to 1, down to -1, back to 0
            triangle[i] = if normalized_phase < 0.25 {
                4.0 * normalized_phase
            } else if normalized_phase < 0.75 {
                2.0 - 4.0 * normalized_phase
            } else {
                -4.0 + 4.0 * normalized_phase
            };

            // Square: starts at 1, switches to -1 halfway
            square[i] = if normalized_phase < 0.5 { 1.0 } else { -1.0 };

            // Saw: starts at 0, ramps up to 1, then jumps to -1
            saw[i] = if normalized_phase < 0.999 {
                -1.0 + 2.0 * normalized_phase
            } else {
                -1.0 // Ensure we end at -1 for clean looping
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
        // Initialize tables if not already done
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

    pub fn reset(&mut self) {
        self.phase = 0.0;
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

        // Only advance phase if we're running (handles envelope mode)
        // if self.trigger_mode != LfoTriggerMode::Envelope || self.last_gate > 0.0 {
        let phase_increment = current_freq / self.sample_rate;
        self.phase = (self.phase + phase_increment) % 1.0;
        // }

        sample
    }

    /// Get raw waveform data for visualization
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

    // pub fn set_is_active(&mut self, is_active: bool) {
    //     self.is_active = is_active;
    // }
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
        inputs: &HashMap<PortId, &[f32]>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        let default_values = self.get_default_values();
        let mut context = ProcessContext::new(inputs, outputs, buffer_size, &default_values);
        AudioProcessor::process(self, &mut context);
    }

    fn reset(&mut self) {
        AudioProcessor::reset(self);
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
}

impl AudioProcessor for Lfo {
    fn get_default_values(&self) -> HashMap<PortId, f32> {
        let mut defaults = HashMap::new();
        defaults.insert(PortId::Frequency, self.frequency);
        defaults.insert(PortId::Gate, 0.0);
        defaults
    }

    fn process(&mut self, context: &mut ProcessContext) {
        // Handle gate input for resetting phase
        if let Some(gate) = context.inputs.get(&PortId::Gate) {
            for offset in (0..context.buffer_size).step_by(4) {
                let gate_values = gate.get_simd(offset);
                let gate_array = gate_values.to_array();

                for (i, &current_gate) in gate_array.iter().enumerate() {
                    if offset + i < context.buffer_size {
                        match self.trigger_mode {
                            LfoTriggerMode::Envelope => {
                                // Reset phase on rising edge
                                if current_gate > 0.0 && self.last_gate <= 0.0 {
                                    self.reset();
                                }
                            }
                            LfoTriggerMode::None => {}
                        }
                        self.last_gate = current_gate;
                    }
                }
            }
        }

        // Generate output samples with frequency modulation
        if let Some(output) = context.outputs.get_mut(&PortId::AudioOutput0) {
            for offset in (0..context.buffer_size).step_by(4) {
                let mut values = [0.0f32; 4];

                // Get frequency modulation if connected
                let base_freq = self.frequency;
                let freq_mod = if let Some(freq_input) = context.inputs.get(&PortId::Frequency) {
                    freq_input.get_simd(offset)
                } else {
                    std::simd::f32x4::splat(0.0)
                };

                for (i, value) in values.iter_mut().enumerate() {
                    if offset + i < context.buffer_size {
                        // Apply frequency modulation
                        let current_freq = base_freq * (1.0 + freq_mod.to_array()[i]);
                        *value = self.get_sample(current_freq);
                    }
                }
                output.write_simd(offset, std::simd::f32x4::from_array(values));
            }
        }
    }

    fn reset(&mut self) {
        self.phase = 0.0;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_lfo_frequency() {
        let mut lfo = Lfo::new(44100.0);
        let mut output = vec![0.0; 44100];

        // Test with 1 Hz frequency
        for i in 0..44100 {
            output[i] = lfo.get_sample(1.0);
        }

        // Check if we completed one cycle
        assert!((output[0] - output[44099]).abs() < 0.01);
    }

    #[test]
    fn test_waveform_ranges() {
        let mut lfo = Lfo::new(44100.0);
        let mut min: f32 = 1.0;
        let mut max: f32 = -1.0;
        let frequency = 1.0;
        // Test range for all waveforms
        for waveform in &[
            LfoWaveform::Sine,
            LfoWaveform::Triangle,
            LfoWaveform::Square,
            LfoWaveform::Saw,
        ] {
            lfo.set_waveform(*waveform);
            lfo.reset();

            for _ in 0..1000 {
                let sample = lfo.get_sample(frequency);
                min = min.min(sample);
                max = max.max(sample);
            }
        }

        assert!(min >= -1.0 && max <= 1.0);
    }

    #[test]
    fn test_all_waveforms_basic_shape() {
        let sample_rate = 44100.0;
        let frequency = 1.0; // 1 Hz for easy cycle counting
        let mut lfo = Lfo::new(sample_rate);

        // Test points we want to verify for each waveform
        let test_points = vec![
            (0.0, "start"),           // Start of cycle
            (0.25, "quarter"),        // Quarter cycle
            (0.5, "half"),            // Half cycle
            (0.75, "three-quarters"), // Three-quarters cycle
        ];

        // Expected values for each waveform at these points
        let expectations = vec![
            // Sine wave expectations (starts at 0, peaks at 1)
            (
                LfoWaveform::Sine,
                vec![
                    (0.0, 0.0),   // Start at zero
                    (0.25, 1.0),  // Peak at quarter
                    (0.5, 0.0),   // Zero at half
                    (0.75, -1.0), // Trough at three-quarters
                ],
            ),
            // Triangle wave expectations (starts at 0, peaks at 1)
            (
                LfoWaveform::Triangle,
                vec![
                    (0.0, 0.0),   // Start at zero
                    (0.25, 1.0),  // Peak at quarter
                    (0.5, 0.0),   // Zero at half
                    (0.75, -1.0), // Trough at three-quarters
                ],
            ),
            // Square wave expectations (starts at 1)
            (
                LfoWaveform::Square,
                vec![
                    (0.0, 1.0),   // Start high
                    (0.25, 1.0),  // Still high
                    (0.5, -1.0),  // Low
                    (0.75, -1.0), // Still low
                ],
            ),
            // Saw wave expectations (starts at -1, ramps up)
            (
                LfoWaveform::Saw,
                vec![
                    (0.0, -1.0),  // Start at bottom
                    (0.25, -0.5), // Quarter up
                    (0.5, 0.0),   // Middle
                    (0.75, 0.5),  // Three-quarters up
                ],
            ),
        ];

        for (waveform, expected_values) in expectations {
            println!("\nTesting {:?} waveform", waveform);
            lfo.set_waveform(waveform);
            lfo.reset();

            for ((cycle_point, point_name), (_, expected_value)) in
                test_points.iter().zip(expected_values.iter())
            {
                // Calculate how many samples to advance
                let samples_to_advance = (cycle_point * sample_rate / frequency) as usize;

                // Advance to the test point
                for _ in 0..samples_to_advance {
                    lfo.get_sample(frequency);
                }

                // Get one more sample at our test point
                let value = lfo.get_sample(frequency);

                println!(
                    "  At {} cycle ({}): got {}, expected {}",
                    point_name, cycle_point, value, expected_value
                );

                assert!(
                    (value - expected_value).abs() < 0.1,
                    "Waveform {:?} at {} cycle: expected {}, got {}",
                    waveform,
                    point_name,
                    expected_value,
                    value
                );

                // Reset for next test point
                lfo.reset();
            }
        }
    }

    // #[test]
    // fn test_waveform_frequency_accuracy() {
    //     let sample_rate = 44100.0;
    //     let frequency = 1.0;
    //     let mut lfo = Lfo::new(sample_rate);
    //     lfo.set_frequency(frequency);

    //     // Test each waveform
    //     for waveform in &[
    //         LfoWaveform::Sine,
    //         LfoWaveform::Triangle,
    //         LfoWaveform::Square,
    //         LfoWaveform::Saw,
    //     ] {
    //         println!("\nTesting {:?} frequency accuracy", waveform);
    //         lfo.set_waveform(*waveform);
    //         lfo.reset();

    //         let mut samples = Vec::new();
    //         // Collect exactly one second of samples
    //         for _ in 0..(sample_rate as usize) {
    //             samples.push(lfo.get_sample());
    //         }

    //         // Print some key points for debugging
    //         println!("Sample points:");
    //         for i in (0..10).map(|x| (x as f32 * sample_rate / 10.0) as usize) {
    //             println!("At {:.2}s: {:.3}", i as f32 / sample_rate, samples[i]);
    //         }

    //         // Count cycles based on waveform type
    //         let mut cycles = 0;
    //         let mut last_value = samples[0];

    //         match waveform {
    //             LfoWaveform::Square => {
    //                 // Count falling edges (1 to -1)
    //                 for sample in samples.iter().skip(1) {
    //                     if last_value > 0.0 && *sample <= 0.0 {
    //                         cycles += 1;
    //                         println!(
    //                             "Found square cycle at transition {} -> {}",
    //                             last_value, sample
    //                         );
    //                     }
    //                     last_value = *sample;
    //                 }
    //             }
    //             LfoWaveform::Sine | LfoWaveform::Triangle => {
    //                 // Look for completion of first quadrant (rising through zero)
    //                 let mut prev_rising = false;
    //                 let mut was_negative = false;

    //                 for sample in samples.iter() {
    //                     let rising = *sample > last_value;

    //                     // Detect zero crossing while rising
    //                     if rising && !prev_rising && was_negative {
    //                         cycles += 1;
    //                         println!("Found cycle zero crossing: {} -> {}", last_value, sample);
    //                     }

    //                     prev_rising = rising;
    //                     was_negative = last_value < 0.0;
    //                     last_value = *sample;
    //                 }
    //             }
    //             LfoWaveform::Saw => {
    //                 // For saw wave, we need to track the entire phase
    //                 let mut last_sample = samples[0];
    //                 let mut highest_seen = f32::NEG_INFINITY;

    //                 for sample in samples.iter().skip(1) {
    //                     // Track highest point to know when we're near completion
    //                     highest_seen = highest_seen.max(*sample);

    //                     // If we were near the top and suddenly jumped to near bottom,
    //                     // that's our cycle completion
    //                     if highest_seen > 0.9 && last_sample > 0.9 && *sample < -0.9 {
    //                         cycles += 1;
    //                         println!("Found saw reset: {} -> {}", last_sample, sample);
    //                     }

    //                     last_sample = *sample;
    //                 }
    //             }
    //         }

    //         // Report and verify cycles
    //         println!("Found {} cycles", cycles);
    //         assert_eq!(
    //             cycles, 1,
    //             "{:?} waveform should complete 1 cycle at 1 Hz (got {} cycles)",
    //             waveform, cycles
    //         );

    //         // Verify amplitude range
    //         let max = samples.iter().fold(f32::NEG_INFINITY, |a, &b| a.max(b));
    //         let min = samples.iter().fold(f32::INFINITY, |a, &b| a.min(b));
    //         println!("Range for {:?}: min={}, max={}", waveform, min, max);

    //         match waveform {
    //             LfoWaveform::Square => {
    //                 assert!((max - 1.0).abs() < 0.01, "Square wave should reach 1.0");
    //                 assert!((min + 1.0).abs() < 0.01, "Square wave should reach -1.0");
    //             }
    //             _ => {
    //                 assert!(max <= 1.0 && max > 0.9, "Should reach close to 1.0");
    //                 assert!(min >= -1.0 && min < -0.9, "Should reach close to -1.0");
    //             }
    //         }
    //     }
    // }

    #[test]
    fn test_lfo_frequency_accuracy() {
        let sample_rate = 44100.0;
        let mut lfo = Lfo::new(sample_rate);

        // Test with 0.5 Hz
        let frequency = 0.5;

        println!("LFO settings:");
        println!("Sample rate: {}", sample_rate);
        println!("Frequency: {} Hz", 0.5);
        println!("Expected cycle time: {} samples", sample_rate / 0.5);

        let mut samples = Vec::new();

        // Collect 2 seconds worth of samples
        let num_samples = (sample_rate as usize * 2);
        for _ in 0..num_samples {
            samples.push(lfo.get_sample(frequency));
        }

        // Print phase info every quarter second
        for i in 0..8 {
            let idx = (sample_rate * 0.25 * i as f32) as usize;
            if idx < samples.len() {
                println!("At {}s: value={}", i as f32 * 0.25, samples[idx]);
            }
        }

        // Find upward zero crossings (where the signal starts rising from 0)
        let mut crossings = 0;
        let tolerance = 0.0001;
        let mut last_crossing = 0;

        for i in 1..samples.len() {
            // Look for points where we're near zero and the slope is positive
            if samples[i - 1].abs() < tolerance && samples[i] > samples[i - 1] {
                crossings += 1;
                let crossing_time = i as f32 / sample_rate;
                println!(
                    "Rising from zero at t={}s (sample {}): {} -> {}",
                    crossing_time,
                    i,
                    samples[i - 1],
                    samples[i]
                );

                if last_crossing > 0 {
                    let period = (i - last_crossing) as f32 / sample_rate;
                    println!("Period since last crossing: {}s (expected 2.0s)", period);
                }
                last_crossing = i;
            }
        }

        assert_eq!(
            crossings, 2,
            "Expected 2 rises from zero for 0.5 Hz over 2 seconds"
        );

        // Also verify value range
        let max = samples.iter().fold(f32::NEG_INFINITY, |a, &b| a.max(b));
        let min = samples.iter().fold(f32::INFINITY, |a, &b| a.min(b));

        println!("Value range: min={}, max={}", min, max);

        assert!(max <= 1.0 && max > 0.9, "Maximum should be close to 1.0");
        assert!(min >= -1.0 && min < -0.9, "Minimum should be close to -1.0");
    }

    #[test]
    fn test_phase_increment() {
        let sample_rate = 44100.0;
        let frequency = 0.5;
        let mut lfo = Lfo::new(sample_rate);

        // Calculate how many samples we expect per cycle
        let samples_per_cycle = sample_rate / frequency;
        println!("Expected samples per cycle: {}", samples_per_cycle);

        // Track phase progression
        let mut phases = Vec::new();
        for _ in 0..samples_per_cycle as usize {
            phases.push(lfo.phase);
            lfo.get_sample(frequency);
        }

        // Check phase values at key points
        let quarter_cycle = samples_per_cycle as usize / 4;
        println!("Phase values:");
        println!("At start: {}", phases[0]);
        println!("At 1/4 cycle: {}", phases[quarter_cycle]);
        println!("At 1/2 cycle: {}", phases[quarter_cycle * 2]);
        println!("At 3/4 cycle: {}", phases[quarter_cycle * 3]);
        println!("At end: {}", phases[phases.len() - 1]);

        // Verify phase reaches expected values
        assert!(
            (phases[quarter_cycle] - 0.25).abs() < 0.01,
            "Should reach 0.25 phase at quarter cycle"
        );
        assert!(
            (phases[quarter_cycle * 2] - 0.5).abs() < 0.01,
            "Should reach 0.5 phase at half cycle"
        );
        assert!(
            (phases[quarter_cycle * 3] - 0.75).abs() < 0.01,
            "Should reach 0.75 phase at three-quarter cycle"
        );
    }

    #[test]
    fn test_normalized_lfo_range() {
        let mut lfo = Lfo::new(44100.0);
        let frequency = 1.0;
        lfo.set_use_normalized(true);

        let mut samples = Vec::new();
        for _ in 0..44100 {
            samples.push(lfo.get_sample(frequency));
        }

        let max = samples.iter().fold(f32::NEG_INFINITY, |a, &b| a.max(b));
        let min = samples.iter().fold(f32::INFINITY, |a, &b| a.min(b));

        println!("Normalized range - Max: {}, Min: {}", max, min);
        assert!(
            max <= 1.0 && max > 0.9,
            "Normalized max should be close to 1.0"
        );
        assert!(
            min >= 0.0 && min < 0.1,
            "Normalized min should be close to 0.0"
        );
    }
}
