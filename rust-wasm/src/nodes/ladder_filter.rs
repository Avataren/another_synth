use std::any::Any;
use std::f32::consts::PI; // Import PI for calculations

// Import necessary types
use crate::graph::{ModulationProcessor, ModulationSource};
use crate::traits::{AudioNode, PortId};
// Import the fast_tanh function if it's in a shared utils module, otherwise define it here or copy it.
// Assuming it might be available via crate::utils::math::fast_tanh
// use crate::utils::math::fast_tanh;

// If fast_tanh is not in utils, define it here (copy from filter_collection example)
use once_cell::sync::Lazy;
use rustc_hash::FxHashMap;
static TANH_LUT: Lazy<[f32; 1024]> = Lazy::new(|| {
    let mut lut = [0.0; 1024];
    let x_min = -5.0;
    let x_max = 5.0;
    let step = (x_max - x_min) / 1023.0;
    for i in 0..1024 {
        let x = x_min + i as f32 * step;
        lut[i] = x.tanh();
    }
    lut
});

#[inline(always)]
fn fast_tanh(x: f32) -> f32 {
    const LUT_SIZE_MINUS_1_F: f32 = 1023.0;
    const X_MIN: f32 = -5.0;
    const X_MAX: f32 = 5.0;
    const INV_RANGE: f32 = 1.0 / (X_MAX - X_MIN);

    let clamped = x.clamp(X_MIN, X_MAX);
    let normalized = (clamped - X_MIN) * INV_RANGE * LUT_SIZE_MINUS_1_F;
    let index_f = normalized.floor();
    let index = index_f as usize;
    let frac = normalized - index_f;

    unsafe {
        let y0 = TANH_LUT.get_unchecked(index);
        if index < 1023 {
            let y1 = TANH_LUT.get_unchecked(index + 1);
            y0 + (y1 - y0) * frac
        } else {
            *y0
        }
    }
}
// End of fast_tanh definition if copied

/// A 24 dB/octave Moog‑style ladder filter node.
pub struct LadderFilter {
    // Parameters
    sample_rate: f32,
    base_cutoff: f32,    // Hz
    base_resonance: f32, // normalized (0–1)
    base_gain_db: f32,   // Gain in dB (applied at output)
    enabled: bool,

    // Smoothed parameters (state)
    smoothed_cutoff: f32,
    smoothed_resonance: f32, // normalized (0-1)
    smoothing_factor: f32,   // e.g., 0.05

    // Filter state (left channel)
    stages: [f32; 4], // State variables for the four 1-pole stages

    // Filter state (right channel)
    stages_r: [f32; 4], // State variables for the four 1-pole stages (right)

    // === Scratch Buffers ===
    mod_scratch_add: Vec<f32>,
    mod_scratch_mult: Vec<f32>,
    audio_in_buffer: Vec<f32>,   // Holds combined audio input (left)
    audio_in_buffer_r: Vec<f32>, // Holds combined audio input (right)
    scratch_cutoff_add: Vec<f32>,
    scratch_cutoff_mult: Vec<f32>,
    scratch_res_add: Vec<f32>,
    scratch_res_mult: Vec<f32>,
    // Optionally add gain modulation scratch buffers if gain is modulated
    // scratch_gain_add: Vec<f32>,
    // scratch_gain_mult: Vec<f32>,
}

impl LadderFilter {
    /// Create a new LadderFilter with the given sample rate.
    pub fn new(sample_rate: f32) -> Self {
        let initial_capacity = 128; // Default buffer size
        let base_cutoff = 20000.0;
        let base_resonance = 0.0;
        let base_gain_db = 0.0; // Default to 0dB gain

        Self {
            sample_rate,
            base_cutoff,
            base_resonance,
            base_gain_db,
            enabled: true,

            smoothed_cutoff: base_cutoff,
            smoothed_resonance: base_resonance,
            smoothing_factor: 0.05, // Adjust for desired smoothing speed

            stages: [0.0; 4],
            stages_r: [0.0; 4],

            // Initialize scratch buffers
            mod_scratch_add: vec![0.0; initial_capacity],
            mod_scratch_mult: vec![1.0; initial_capacity],
            audio_in_buffer: vec![0.0; initial_capacity],
            audio_in_buffer_r: vec![0.0; initial_capacity],
            scratch_cutoff_add: vec![0.0; initial_capacity],
            scratch_cutoff_mult: vec![1.0; initial_capacity],
            scratch_res_add: vec![0.0; initial_capacity],
            scratch_res_mult: vec![1.0; initial_capacity],
            // scratch_gain_add: vec![0.0; initial_capacity],
            // scratch_gain_mult: vec![1.0; initial_capacity],
        }
    }

    /// Ensure all scratch buffers have at least `size` capacity.
    fn ensure_scratch_buffers(&mut self, size: usize) {
        let resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
            if buf.len() < size {
                buf.resize(size, default_val);
            }
        };
        resize_if_needed(&mut self.mod_scratch_add, 0.0);
        resize_if_needed(&mut self.mod_scratch_mult, 1.0);
        resize_if_needed(&mut self.audio_in_buffer, 0.0);
        resize_if_needed(&mut self.audio_in_buffer_r, 0.0);
        resize_if_needed(&mut self.scratch_cutoff_add, 0.0);
        resize_if_needed(&mut self.scratch_cutoff_mult, 1.0);
        resize_if_needed(&mut self.scratch_res_add, 0.0);
        resize_if_needed(&mut self.scratch_res_mult, 1.0);
        // resize_if_needed(&mut self.scratch_gain_add, 0.0);
        // resize_if_needed(&mut self.scratch_gain_mult, 1.0);
    }

    /// Set the base cutoff (Hz) and resonance (normalized 0–1).
    pub fn set_params(&mut self, cutoff: f32, resonance: f32) {
        // Clamp base frequency to avoid issues near 0 Hz or Nyquist
        self.base_cutoff = cutoff.clamp(10.0, self.sample_rate * 0.49);
        self.base_resonance = resonance.clamp(0.0, 1.0);
        // Smoothed values will catch up in the process loop
    }

    /// Set the base output gain in dB.
    pub fn set_gain_db(&mut self, gain_db: f32) {
        self.base_gain_db = gain_db;
        // Actual gain multiplier applied per-sample based on this base value (and maybe modulation)
    }

    // Removed set_gain_normalized, prefer set_gain_db

    /// Reset the filter's internal state variables.
    pub fn reset_state(&mut self) {
        self.stages = [0.0; 4];
        self.stages_r = [0.0; 4];
        // Reset smoothed parameters to base values
        self.smoothed_cutoff = self.base_cutoff;
        self.smoothed_resonance = self.base_resonance;
    }

    /// Process a single audio sample through the ladder filter (left channel).
    #[inline(always)]
    fn process_one_sample(&mut self, input: f32, cutoff: f32, resonance_norm: f32) -> f32 {
        // --- Calculate Coefficients ---
        // Thermal voltage (VT) - typically 26mV, influences saturation. Not explicitly modelled here.
        // let vt = 0.026;

        // Map cutoff frequency to filter coefficient 'g'. Pre-warp frequency.
        // This uses the relationship derived from the analog circuit's time constant.
        let g = (PI * cutoff / self.sample_rate).tan(); // Similar to one-pole cutoff coef
        let g_inv = 1.0 / (1.0 + g); // Normalization for feedback stage in implicit Euler

        // Map normalized resonance (0-1) to feedback amount 'k'.
        // The factor 4.0 is common, but can be tuned. Higher values increase resonance intensity.
        let k = resonance_norm * 4.0;

        // --- Filter Stages (Implicit Euler Integration with Tanh Saturation) ---
        // Feedback is taken from the output of the last stage (stages[3])
        let feedback_signal = k * self.stages[3];
        let input_stage_value = input - feedback_signal;

        // Process each stage using the fast_tanh approximation
        // This implements y[n] = y[n-1] + g * (tanh(x[n]) - tanh(y[n-1])) with feedback implicit
        // Or simplified: y[n] = y[n-1] + 2.0*g/(1+g) * (tanh(x[n]) - tanh(y[n-1]))
        // Let's use the structure from FilterCollection's ladder for consistency:
        let s0 = fast_tanh(input_stage_value);
        let s1 = fast_tanh(self.stages[0]);
        let s2 = fast_tanh(self.stages[1]);
        let s3 = fast_tanh(self.stages[2]);
        let s4 = fast_tanh(self.stages[3]); // tanh of previous output

        let stage_update_factor = 2.0 * g * g_inv; // Combine factors

        self.stages[0] += stage_update_factor * (s0 - s1);
        self.stages[1] += stage_update_factor * (s1 - s2);
        self.stages[2] += stage_update_factor * (s2 - s3);
        self.stages[3] += stage_update_factor * (s3 - s4);

        // Output is the signal from the last stage
        let output = self.stages[3];

        // Apply output gain (converted from dB)
        output * 10f32.powf(self.base_gain_db / 20.0)
    }

    /// Process a single audio sample through the ladder filter (right channel).
    #[inline(always)]
    fn process_one_sample_r(&mut self, input: f32, cutoff: f32, resonance_norm: f32) -> f32 {
        let g = (PI * cutoff / self.sample_rate).tan();
        let g_inv = 1.0 / (1.0 + g);
        let k = resonance_norm * 4.0;

        let feedback_signal = k * self.stages_r[3];
        let input_stage_value = input - feedback_signal;

        let s0 = fast_tanh(input_stage_value);
        let s1 = fast_tanh(self.stages_r[0]);
        let s2 = fast_tanh(self.stages_r[1]);
        let s3 = fast_tanh(self.stages_r[2]);
        let s4 = fast_tanh(self.stages_r[3]);

        let stage_update_factor = 2.0 * g * g_inv;

        self.stages_r[0] += stage_update_factor * (s0 - s1);
        self.stages_r[1] += stage_update_factor * (s1 - s2);
        self.stages_r[2] += stage_update_factor * (s2 - s3);
        self.stages_r[3] += stage_update_factor * (s3 - s4);

        let output = self.stages_r[3];
        output * 10f32.powf(self.base_gain_db / 20.0)
    }
}

// Implement the modulation processor trait
impl ModulationProcessor for LadderFilter {}

impl AudioNode for LadderFilter {
    fn get_ports(&self) -> FxHashMap<PortId, bool> {
        [
            (PortId::AudioInput0, false),  // Input audio signal (left)
            (PortId::AudioInput1, false),  // Input audio signal (right)
            (PortId::CutoffMod, false),    // Modulation for cutoff frequency
            (PortId::ResonanceMod, false), // Modulation for resonance (0-1)
            // (PortId::GainMod, false),   // Optional: Modulation for gain
            (PortId::AudioOutput0, true),  // Output filtered audio (left)
            (PortId::AudioOutput1, true),  // Output filtered audio (right)
        ]
        .iter()
        .cloned()
        .collect()
    }

    fn process(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // --- 0) Early exit and Buffer Preparation ---
        if !self.enabled {
            if let Some(output_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                output_buffer[..buffer_size].fill(0.0);
            }
            if let Some(output_buffer) = outputs.get_mut(&PortId::AudioOutput1) {
                output_buffer[..buffer_size].fill(0.0);
            }
            return;
        }

        self.ensure_scratch_buffers(buffer_size);

        // Check that we have at least one output
        let has_out0 = outputs.contains_key(&PortId::AudioOutput0);
        let has_out1 = outputs.contains_key(&PortId::AudioOutput1);
        if !has_out0 && !has_out1 {
            return;
        }

        // --- 1) Process Modulation Inputs ---

        // Audio Input Left (simple additive mix)
        self.audio_in_buffer[..buffer_size].fill(0.0);
        if let Some(audio_sources) = inputs.get(&PortId::AudioInput0) {
            for source in audio_sources {
                Self::apply_add(
                    &source.buffer,
                    &mut self.audio_in_buffer[..buffer_size],
                    source.amount,
                    source.transformation,
                );
            }
        }

        // Audio Input Right (simple additive mix)
        self.audio_in_buffer_r[..buffer_size].fill(0.0);
        if let Some(audio_sources) = inputs.get(&PortId::AudioInput1) {
            for source in audio_sources {
                Self::apply_add(
                    &source.buffer,
                    &mut self.audio_in_buffer_r[..buffer_size],
                    source.amount,
                    source.transformation,
                );
            }
        }

        // Generic modulation input processing helper
        let mut process_mod_input = |port_id: PortId,
                                     target_add: &mut [f32],
                                     target_mult: &mut [f32],
                                     default_add: f32,
                                     default_mult: f32| {
            let sources = inputs.get(&port_id);
            if sources.map_or(false, |s| !s.is_empty()) {
                Self::accumulate_modulations_inplace(
                    buffer_size,
                    sources.map(|v| v.as_slice()),
                    &mut self.mod_scratch_add,
                    &mut self.mod_scratch_mult,
                );
                target_add[..buffer_size].copy_from_slice(&self.mod_scratch_add[..buffer_size]);
                target_mult[..buffer_size].copy_from_slice(&self.mod_scratch_mult[..buffer_size]);
            } else {
                target_add[..buffer_size].fill(default_add);
                target_mult[..buffer_size].fill(default_mult);
            }
        };

        process_mod_input(
            PortId::CutoffMod,
            &mut self.scratch_cutoff_add,
            &mut self.scratch_cutoff_mult,
            0.0,
            1.0,
        );
        process_mod_input(
            PortId::ResonanceMod,
            &mut self.scratch_res_add,
            &mut self.scratch_res_mult,
            0.0,
            1.0,
        );
        // Process gain mod if enabled
        // process_mod_input(PortId::GainMod, &mut self.scratch_gain_add, &mut self.scratch_gain_mult, 0.0, 1.0);

        // Initialize output buffers
        if let Some(buf) = outputs.get_mut(&PortId::AudioOutput0) {
            buf[..buffer_size].fill(0.0);
        }
        if let Some(buf) = outputs.get_mut(&PortId::AudioOutput1) {
            buf[..buffer_size].fill(0.0);
        }

        // --- 2) Main Processing Loop (Sample by Sample) ---
        // Ladder filter state is highly sensitive, process sample-by-sample
        for i in 0..buffer_size {
            // Calculate target parameters for this sample
            let target_cutoff =
                (self.base_cutoff + self.scratch_cutoff_add[i]) * self.scratch_cutoff_mult[i];
            let target_resonance =
                (self.base_resonance + self.scratch_res_add[i]) * self.scratch_res_mult[i];

            // Clamp target values
            let target_cutoff_clamped = target_cutoff.clamp(10.0, self.sample_rate * 0.49);
            let target_resonance_clamped = target_resonance.clamp(0.0, 1.0); // Resonance is normalized

            // Apply smoothing
            let smoothing_factor = self.smoothing_factor;
            self.smoothed_cutoff +=
                smoothing_factor * (target_cutoff_clamped - self.smoothed_cutoff);
            self.smoothed_resonance +=
                smoothing_factor * (target_resonance_clamped - self.smoothed_resonance);

            // Re-clamp smoothed values to ensure stability
            self.smoothed_cutoff = self.smoothed_cutoff.clamp(10.0, self.sample_rate * 0.49);
            self.smoothed_resonance = self.smoothed_resonance.clamp(0.0, 1.0);

            // Process left channel
            let input_sample_l = self.audio_in_buffer[i];
            let filtered_sample_l = self.process_one_sample(
                input_sample_l,
                self.smoothed_cutoff,
                self.smoothed_resonance,
            );

            // Process right channel
            let input_sample_r = self.audio_in_buffer_r[i];
            let filtered_sample_r = self.process_one_sample_r(
                input_sample_r,
                self.smoothed_cutoff,
                self.smoothed_resonance,
            );

            // Write outputs
            if let Some(buf) = outputs.get_mut(&PortId::AudioOutput0) {
                buf[i] = filtered_sample_l;
            }
            if let Some(buf) = outputs.get_mut(&PortId::AudioOutput1) {
                buf[i] = filtered_sample_r;
            }
        }
    }

    fn reset(&mut self) {
        self.reset_state();
    }

    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    fn as_any(&self) -> &dyn Any {
        self
    }

    fn is_active(&self) -> bool {
        self.enabled
    }

    fn set_active(&mut self, active: bool) {
        self.enabled = active;
        if !active {
            self.reset(); // Reset state when deactivated
        }
    }

    fn name(&self) -> &'static str {
        "Ladder Filter"
    }

    fn node_type(&self) -> &str {
        "ladderfilter"
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_SAMPLE_RATE: f32 = 48000.0;
    const EPSILON: f32 = 1e-6;

    #[test]
    fn test_ladder_filter_creation() {
        let filter = LadderFilter::new(TEST_SAMPLE_RATE);
        assert_eq!(filter.sample_rate, TEST_SAMPLE_RATE);
        assert_eq!(filter.base_cutoff, 20000.0);
        assert_eq!(filter.base_resonance, 0.0);
        assert!(filter.enabled);
    }

    #[test]
    fn test_ladder_filter_set_params() {
        let mut filter = LadderFilter::new(TEST_SAMPLE_RATE);

        // Test valid parameters
        filter.set_params(1000.0, 0.5);
        assert_eq!(filter.base_cutoff, 1000.0);
        assert_eq!(filter.base_resonance, 0.5);

        // Test clamping - cutoff too high
        filter.set_params(100000.0, 0.5);
        assert!(filter.base_cutoff < TEST_SAMPLE_RATE * 0.5);

        // Test clamping - cutoff too low
        filter.set_params(1.0, 0.5);
        assert!(filter.base_cutoff >= 10.0);

        // Test clamping - resonance too high
        filter.set_params(1000.0, 2.0);
        assert!(filter.base_resonance <= 1.0);

        // Test clamping - resonance negative
        filter.set_params(1000.0, -0.5);
        assert!(filter.base_resonance >= 0.0);
    }

    #[test]
    fn test_ladder_filter_gain() {
        let mut filter = LadderFilter::new(TEST_SAMPLE_RATE);

        filter.set_gain_db(6.0);
        assert_eq!(filter.base_gain_db, 6.0);

        filter.set_gain_db(-12.0);
        assert_eq!(filter.base_gain_db, -12.0);
    }

    #[test]
    fn test_ladder_filter_reset() {
        let mut filter = LadderFilter::new(TEST_SAMPLE_RATE);
        filter.set_params(1000.0, 0.5);

        // Process some samples to build up state
        for _ in 0..10 {
            filter.process_one_sample(1.0, 1000.0, 0.5);
        }

        // Verify state is non-zero
        let has_state = filter.stages.iter().any(|&s| s.abs() > EPSILON);
        assert!(has_state, "Filter should have built up state");

        // Reset
        filter.reset_state();

        // Verify all state is cleared
        for (i, &stage) in filter.stages.iter().enumerate() {
            assert_eq!(
                stage, 0.0,
                "Stage {} should be zero after reset",
                i
            );
        }
    }

    #[test]
    fn test_ladder_filter_stability() {
        let mut filter = LadderFilter::new(TEST_SAMPLE_RATE);
        filter.set_params(1000.0, 0.9);

        // Process extreme inputs
        for _ in 0..1000 {
            let output = filter.process_one_sample(100.0, 1000.0, 0.9);
            assert!(
                output.is_finite(),
                "Filter produced non-finite output"
            );
            assert!(
                output.abs() < 1000.0,
                "Filter output exploded: {}",
                output
            );
        }
    }

    #[test]
    fn test_ladder_filter_self_oscillation() {
        // At high resonance, filter should self-oscillate
        let mut filter = LadderFilter::new(TEST_SAMPLE_RATE);
        filter.set_params(1000.0, 1.0);

        // Feed impulse
        filter.process_one_sample(1.0, 1000.0, 1.0);

        // Continue processing zeros
        let mut max_output: f32 = 0.0;
        for _ in 0..100 {
            let output = filter.process_one_sample(0.0, 1000.0, 1.0);
            max_output = max_output.max(output.abs());
        }

        // Should have significant output from self-oscillation
        assert!(
            max_output > 0.01,
            "Filter should self-oscillate at high resonance, max output: {}",
            max_output
        );
    }

    #[test]
    fn test_ladder_filter_lowpass_behavior() {
        let mut filter = LadderFilter::new(TEST_SAMPLE_RATE);
        filter.set_params(1000.0, 0.5);

        // Generate low frequency sine wave (100 Hz)
        let mut low_freq_sum = 0.0;
        for i in 0..480 {
            let phase = 2.0 * std::f32::consts::PI * 100.0 * i as f32 / TEST_SAMPLE_RATE;
            let input = phase.sin();
            let output = filter.process_one_sample(input, 1000.0, 0.5);
            low_freq_sum += output.abs();
        }

        filter.reset_state();

        // Generate high frequency sine wave (5000 Hz)
        let mut high_freq_sum = 0.0;
        for i in 0..480 {
            let phase = 2.0 * std::f32::consts::PI * 5000.0 * i as f32 / TEST_SAMPLE_RATE;
            let input = phase.sin();
            let output = filter.process_one_sample(input, 1000.0, 0.5);
            high_freq_sum += output.abs();
        }

        // Low frequencies should pass more than high frequencies
        assert!(
            low_freq_sum > high_freq_sum,
            "Ladder filter should attenuate high frequencies more than low. Low: {}, High: {}",
            low_freq_sum,
            high_freq_sum
        );
    }

    #[test]
    fn test_ladder_filter_varying_cutoff() {
        let mut filter = LadderFilter::new(TEST_SAMPLE_RATE);

        // Process with varying cutoff frequencies
        for cutoff in [100.0, 500.0, 1000.0, 5000.0, 10000.0] {
            filter.reset_state();
            filter.set_params(cutoff, 0.5);

            // Process sine wave at half the cutoff frequency
            let test_freq = cutoff / 2.0;
            let mut sum = 0.0;
            for i in 0..480 {
                let phase = 2.0 * std::f32::consts::PI * test_freq * i as f32 / TEST_SAMPLE_RATE;
                let input = phase.sin();
                let output = filter.process_one_sample(input, cutoff, 0.5);
                sum += output.abs();
            }

            assert!(
                sum > 0.0,
                "Filter should pass frequency at half cutoff for cutoff {}",
                cutoff
            );
            assert!(
                sum.is_finite(),
                "Output should be finite for cutoff {}",
                cutoff
            );
        }
    }

    #[test]
    fn test_ladder_filter_denormals() {
        let mut filter = LadderFilter::new(TEST_SAMPLE_RATE);
        filter.set_params(1000.0, 0.5);

        // Process very small values
        for _ in 0..1000 {
            let output = filter.process_one_sample(1e-30, 1000.0, 0.5);
            assert!(
                output.abs() < 1e-10 || output == 0.0,
                "Should handle denormals gracefully"
            );
        }
    }

    #[test]
    fn test_fast_tanh() {
        // Test the fast_tanh approximation
        for x in [-5.0, -2.0, -1.0, 0.0, 1.0, 2.0, 5.0] {
            let result = fast_tanh(x);
            let expected = x.tanh();

            assert!(
                result.is_finite(),
                "fast_tanh should produce finite output for {}",
                x
            );

            // Should be reasonably close to actual tanh
            assert!(
                (result - expected).abs() < 0.1,
                "fast_tanh({}) = {}, expected close to {}",
                x,
                result,
                expected
            );
        }

        // Test clamping at extremes
        let extreme_pos = fast_tanh(10.0);
        let extreme_neg = fast_tanh(-10.0);
        assert!((extreme_pos - 1.0).abs() < 0.1);
        assert!((extreme_neg - (-1.0)).abs() < 0.1);
    }
}
