use std::any::Any;
use std::collections::HashMap;
use std::f32::consts::PI;
use std::sync::OnceLock;

use web_sys::console;

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

// Global static tables using OnceLock for lazy initialization
static LFO_TABLES: OnceLock<LfoTables> = OnceLock::new();

const TABLE_SIZE: usize = 4096;
const TABLE_MASK: usize = TABLE_SIZE - 1;

impl LfoTables {
    fn new() -> Self {
        let mut sine = vec![0.0; TABLE_SIZE];
        let mut triangle = vec![0.0; TABLE_SIZE];
        let mut square = vec![0.0; TABLE_SIZE];
        let mut saw = vec![0.0; TABLE_SIZE];

        println!("Generating tables, size={}", TABLE_SIZE);

        for i in 0..TABLE_SIZE {
            let phase = 2.0 * std::f32::consts::PI * (i as f32) / (TABLE_SIZE as f32);

            sine[i] = phase.sin();

            // Print diagnostic values at key points
            if i == 0 || i == TABLE_SIZE / 4 || i == TABLE_SIZE / 2 || i == 3 * TABLE_SIZE / 4 {
                println!("Table index {}: phase={:.3}, sin={:.3}", i, phase, sine[i]);
            }
        }

        // Verify we can look up a complete cycle
        println!("Verifying sine values:");
        let phases = [0.0, 0.25, 0.5, 0.75, 1.0];
        for &p in &phases {
            let idx = (p * TABLE_SIZE as f32) as usize & TABLE_MASK;
            println!("Phase {:.2}: index={}, value={:.3}", p, idx, sine[idx]);
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
        }
    }

    pub fn set_frequency(&mut self, freq: f32) {
        console::log_1(
            &format!(
                "Setting LFO frequency to {} from:\n{:?}",
                freq,
                std::backtrace::Backtrace::capture()
            )
            .into(),
        );
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

    fn get_sample(&mut self) -> f32 {
        let tables = LFO_TABLES.get().unwrap();
        let table = tables.get_table(self.waveform);

        // Get the current phase for table lookup
        let table_phase = self.phase;
        let table_index = table_phase * TABLE_SIZE as f32;

        // Get indices for interpolation
        let index1 = (table_index as usize) & TABLE_MASK;
        let index2 = (index1 + 1) & TABLE_MASK;
        let fraction = table_index - table_index.floor();

        // Linear interpolation
        let sample1 = table[index1];
        let sample2 = table[index2];
        let mut sample = sample1 + (sample2 - sample1) * fraction;

        // Apply post-processing
        if self.use_absolute {
            sample = sample.abs();
        }
        if self.use_normalized {
            sample = (sample + 1.0) * 0.5;
        }

        // Update phase for next sample
        // For 0.5 Hz, we want to complete one cycle in 2 seconds
        // So we need to increment by frequency/sample_rate
        let phase_increment = self.frequency / self.sample_rate;
        self.phase = (self.phase + phase_increment) % 1.0;

        // For 1 Hz, we want a complete cycle (0 to 1.0) over sample_rate samples
        //let phase_increment = (self.frequency * 2.0 * std::f32::consts::PI) / self.sample_rate;
        //self.phase = (self.phase + phase_increment / (2.0 * std::f32::consts::PI)) % 1.0;

        sample
    }

    /// Get raw waveform data for visualization
    pub fn get_waveform_data(waveform: LfoWaveform, buffer_size: usize) -> Vec<f32> {
        let tables = LFO_TABLES.get_or_init(LfoTables::new);
        let table = tables.get_table(waveform);
        let mut buffer = vec![0.0; buffer_size];
        let phase_increment = 1.0 / buffer_size as f32;
        let mut phase = 0.0;

        for i in 0..buffer_size {
            let table_index = phase * TABLE_SIZE as f32;
            let index1 = (table_index as usize) & TABLE_MASK;
            let index2 = (index1 + 1) & TABLE_MASK;
            let fraction = table_index - table_index.floor();

            let sample1 = table[index1];
            let sample2 = table[index2];
            buffer[i] = sample1 + (sample2 - sample1) * fraction;

            phase += phase_increment;
            if phase >= 1.0 {
                phase -= 1.0;
            }
        }

        buffer
    }
}

impl AudioNode for Lfo {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        // ports.insert(PortId::Frequency, false);
        //ports.insert(PortId::Gate, false);
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
}

impl AudioProcessor for Lfo {
    fn get_default_values(&self) -> HashMap<PortId, f32> {
        let mut defaults = HashMap::new();
        defaults.insert(PortId::Frequency, self.frequency);
        defaults.insert(PortId::Gate, 0.0);
        defaults
    }

    fn process(&mut self, context: &mut ProcessContext) {
        if let Some(freq_input) = context.inputs.get(&PortId::Frequency) {
            console::log_1(
                &format!(
                    "LFO receiving unexpected frequency input: {}",
                    freq_input.get_simd(0).to_array()[0]
                )
                .into(),
            );
        }
        // Handle gate input for resetting phase
        if let Some(gate) = context.inputs.get(&PortId::Gate) {
            if gate.get_simd(0).to_array()[0] > 0.0 {
                self.reset();
            }
        }

        // Process frequency modulation
        if let Some(freq_input) = context.inputs.get(&PortId::Frequency) {
            let freq = freq_input.get_simd(0).to_array()[0];
            self.set_frequency(freq);
        }

        // Generate output samples
        if let Some(output) = context.outputs.get_mut(&PortId::AudioOutput0) {
            for offset in (0..context.buffer_size).step_by(4) {
                let mut values = [0.0f32; 4];
                for i in 0..4 {
                    if offset + i < context.buffer_size {
                        values[i] = self.get_sample();
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
        lfo.set_frequency(1.0);
        for i in 0..44100 {
            output[i] = lfo.get_sample();
        }

        // Check if we completed one cycle
        assert!((output[0] - output[44099]).abs() < 0.01);
    }

    #[test]
    fn test_waveform_ranges() {
        let mut lfo = Lfo::new(44100.0);
        let mut min: f32 = 1.0;
        let mut max: f32 = -1.0;

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
                let sample = lfo.get_sample();
                min = min.min(sample);
                max = max.max(sample);
            }
        }

        assert!(min >= -1.0 && max <= 1.0);
    }

    #[test]
    fn test_lfo_frequency_accuracy() {
        let sample_rate = 44100.0;
        let mut lfo = Lfo::new(sample_rate);

        // Test with 0.5 Hz
        lfo.set_frequency(0.5);

        println!("LFO settings:");
        println!("Sample rate: {}", sample_rate);
        println!("Frequency: {} Hz", 0.5);
        println!("Expected cycle time: {} samples", sample_rate / 0.5);

        let mut samples = Vec::new();

        // Collect 2 seconds worth of samples
        let num_samples = (sample_rate as usize * 2);
        for _ in 0..num_samples {
            samples.push(lfo.get_sample());
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
        lfo.set_frequency(frequency);

        // Calculate how many samples we expect per cycle
        let samples_per_cycle = sample_rate / frequency;
        println!("Expected samples per cycle: {}", samples_per_cycle);

        // Track phase progression
        let mut phases = Vec::new();
        for _ in 0..samples_per_cycle as usize {
            phases.push(lfo.phase);
            lfo.get_sample();
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
        lfo.set_use_normalized(true);

        let mut samples = Vec::new();
        for _ in 0..44100 {
            samples.push(lfo.get_sample());
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
