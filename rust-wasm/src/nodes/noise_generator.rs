// --- ModulationProcessor Trait Definition ---
use crate::graph::{ModulationProcessor, ModulationSource};
use crate::traits::{AudioNode, PortId};
use core::simd::{f32x4, Simd};
use std::any::Any;
use std::collections::HashMap;
use std::simd::num::SimdFloat;
use std::simd::StdFloat;
use wasm_bindgen::prelude::wasm_bindgen; // Already used, keep

/// The type of noise to generate.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NoiseType {
    White = 0,
    Pink = 1,
    Brownian = 2,
}

/// Structure for external updates (e.g., from UI or automation).
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseUpdate {
    pub noise_type: NoiseType,
    pub cutoff: f32,
    pub gain: f32,
    pub enabled: bool,
}

// --- Noise Generation Constants ---
const PINK_P0: f32 = 0.99886;
const PINK_W0: f32 = 0.0555179;
const PINK_P1: f32 = 0.99332;
const PINK_W1: f32 = 0.0750759;
const PINK_P2: f32 = 0.96900;
const PINK_W2: f32 = 0.1538520;
const PINK_P3: f32 = 0.86650;
const PINK_W3: f32 = 0.3104856;
const PINK_P4: f32 = 0.55000;
const PINK_W4: f32 = 0.5329522;
const PINK_P5: f32 = -0.76160;
const PINK_W5: f32 = 0.0168980;
const PINK_W6_FACTOR: f32 = 0.115926;
const PINK_FINAL_WHITE_FACTOR: f32 = 0.5362;
const PINK_OUTPUT_SCALE: f32 = 0.15;
const BROWN_DECAY: f32 = 1.0 / 1.02;
const BROWN_WHITE_INPUT_SCALE: f32 = 0.02 / 1.02;
const BROWN_OUTPUT_SCALE: f32 = 4.57;

/// A noise generator node using SIMD for optimization.
pub struct NoiseGenerator {
    // Parameters
    sample_rate: f32,
    enabled: bool,
    base_gain: f32,
    noise_type: NoiseType,
    base_cutoff_normalized: f32,
    dc_offset: f32,

    // --- State ---
    rng_state: [u32; 4],
    lp_state: f32x4,
    lp_state_scalar: f32,
    pink_b: [f32x4; 7],
    pink_b_scalar: [f32; 7],
    brown_state: f32x4,
    brown_state_scalar: f32,

    // Scratch Buffers
    scratch_cutoff_add: Vec<f32>,
    scratch_cutoff_mult: Vec<f32>,
    scratch_gain_add: Vec<f32>,
    scratch_gain_vca: Vec<f32>,
}

// Implement the ModulationProcessor trait for NoiseGenerator
// The trait provides the default implementations for apply_*, transform_*, simd_process_*, combine_*
impl ModulationProcessor for NoiseGenerator {}

impl NoiseGenerator {
    // --- Constants ---
    const MIN_FREQUENCY_HZ: f32 = 10.0;
    const MAX_FREQUENCY_HZ_FACTOR: f32 = 0.499;
    const INITIAL_RNG_SEED: u32 = 123;
    const MAX_FILTER_ALPHA: f32 = 0.999;

    // --- Methods ---
    // (hz_to_normalized, new, ensure_scratch_buffers, update, set_*, reset_noise_state remain largely the same)
    #[inline(always)]
    fn hz_to_normalized(hz: f32, sample_rate: f32) -> f32 {
        let max_hz = sample_rate * Self::MAX_FREQUENCY_HZ_FACTOR;
        let clamped_hz = hz.clamp(Self::MIN_FREQUENCY_HZ, max_hz);
        (clamped_hz - Self::MIN_FREQUENCY_HZ) / (max_hz - Self::MIN_FREQUENCY_HZ)
    }

    pub fn new(sample_rate: f32) -> Self {
        assert!(sample_rate > 0.0, "Sample rate must be positive");
        let initial_capacity = 128;
        let initial_cutoff_hz = sample_rate * Self::MAX_FREQUENCY_HZ_FACTOR;
        let initial_cutoff_normalized = Self::hz_to_normalized(initial_cutoff_hz, sample_rate);

        Self {
            sample_rate,
            enabled: true,
            base_gain: 1.0,
            noise_type: NoiseType::White,
            base_cutoff_normalized: initial_cutoff_normalized,
            dc_offset: 0.0,
            rng_state: [Self::INITIAL_RNG_SEED, 362436069, 521288629, 88675123],
            lp_state: f32x4::splat(0.0),
            lp_state_scalar: 0.0,
            pink_b: [f32x4::splat(0.0); 7],
            pink_b_scalar: [0.0; 7],
            brown_state: f32x4::splat(0.0),
            brown_state_scalar: 0.0,
            scratch_cutoff_add: vec![0.0; initial_capacity],
            scratch_cutoff_mult: vec![1.0; initial_capacity],
            scratch_gain_add: vec![0.0; initial_capacity],
            scratch_gain_vca: vec![1.0; initial_capacity],
        }
    }

    fn ensure_scratch_buffers(&mut self, size: usize) {
        let resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
            if buf.len() < size {
                buf.resize(size, default_val);
            }
        };
        resize_if_needed(&mut self.scratch_cutoff_add, 0.0);
        resize_if_needed(&mut self.scratch_cutoff_mult, 1.0);
        resize_if_needed(&mut self.scratch_gain_add, 0.0);
        resize_if_needed(&mut self.scratch_gain_vca, 1.0);
    }

    pub fn update(&mut self, update: NoiseUpdate) {
        let old_type = self.noise_type;
        self.noise_type = update.noise_type;
        self.base_cutoff_normalized = Self::hz_to_normalized(update.cutoff, self.sample_rate);
        self.base_gain = update.gain.max(0.0);
        self.enabled = update.enabled;
        if old_type != self.noise_type {
            self.reset_noise_state();
        }
    }

    pub fn set_noise_type(&mut self, noise_type: NoiseType) {
        if noise_type != self.noise_type {
            self.noise_type = noise_type;
            self.reset_noise_state();
        }
    }

    pub fn set_base_cutoff(&mut self, cutoff_hz: f32) {
        self.base_cutoff_normalized = Self::hz_to_normalized(cutoff_hz, self.sample_rate);
    }

    pub fn set_base_gain(&mut self, gain: f32) {
        self.base_gain = gain.max(0.0);
    }

    pub fn set_seed(&mut self, seed: u32) {
        self.rng_state = [seed.max(1), 362436069, 521288629, 88675123];
        self.reset_noise_state();
    }

    pub fn set_dc_offset(&mut self, offset: f32) {
        self.dc_offset = offset.clamp(-1.0, 1.0);
    }

    fn reset_noise_state(&mut self) {
        self.lp_state = f32x4::splat(0.0);
        self.lp_state_scalar = 0.0;
        self.pink_b = [f32x4::splat(0.0); 7];
        self.pink_b_scalar = [0.0; 7];
        self.brown_state = f32x4::splat(0.0);
        self.brown_state_scalar = 0.0;
    }

    // --- Noise Generation Methods ---
    // (generate_random_*, get_white/pink/brownian_* remain the same)
    #[inline(always)]
    fn generate_random_numbers_simd(&mut self) -> f32x4 {
        let mut results = [0.0f32; 4];
        for result in results.iter_mut() {
            let t1 = self.rng_state[1].wrapping_mul(5);
            let temp = (t1 << 7 | t1 >> 25).wrapping_mul(9);
            let t = self.rng_state[1] << 9;
            self.rng_state[2] ^= self.rng_state[0];
            self.rng_state[3] ^= self.rng_state[1];
            self.rng_state[1] ^= self.rng_state[2];
            self.rng_state[0] ^= self.rng_state[3];
            self.rng_state[2] ^= t;
            self.rng_state[3] = self.rng_state[3].rotate_left(11);
            *result = (temp as f32 * (1.0 / u32::MAX as f32)) * 2.0 - 1.0;
        }
        f32x4::from_array(results)
    }

    #[inline(always)]
    fn generate_random_number_scalar(&mut self) -> f32 {
        let t1 = self.rng_state[1].wrapping_mul(5);
        let temp = (t1 << 7 | t1 >> 25).wrapping_mul(9);
        let t = self.rng_state[1] << 9;
        self.rng_state[2] ^= self.rng_state[0];
        self.rng_state[3] ^= self.rng_state[1];
        self.rng_state[1] ^= self.rng_state[2];
        self.rng_state[0] ^= self.rng_state[3];
        self.rng_state[2] ^= t;
        self.rng_state[3] = self.rng_state[3].rotate_left(11);
        (temp as f32 * (1.0 / u32::MAX as f32)) * 2.0 - 1.0
    }

    #[inline(always)]
    fn get_white_noise_simd(&mut self) -> f32x4 {
        self.generate_random_numbers_simd()
    }
    #[inline(always)]
    fn get_white_noise_scalar(&mut self) -> f32 {
        self.generate_random_number_scalar()
    }

    #[inline(always)]
    fn get_pink_noise_simd(&mut self) -> f32x4 {
        let white = self.get_white_noise_simd();
        let p0 = f32x4::splat(PINK_P0);
        let w0 = f32x4::splat(PINK_W0);
        let p1 = f32x4::splat(PINK_P1);
        let w1 = f32x4::splat(PINK_W1);
        let p2 = f32x4::splat(PINK_P2);
        let w2 = f32x4::splat(PINK_W2);
        let p3 = f32x4::splat(PINK_P3);
        let w3 = f32x4::splat(PINK_W3);
        let p4 = f32x4::splat(PINK_P4);
        let w4 = f32x4::splat(PINK_W4);
        let p5 = f32x4::splat(PINK_P5);
        let w5 = f32x4::splat(PINK_W5);
        let w6_factor = f32x4::splat(PINK_W6_FACTOR);
        let final_white_factor = f32x4::splat(PINK_FINAL_WHITE_FACTOR);
        let output_scale = f32x4::splat(PINK_OUTPUT_SCALE);

        self.pink_b[0] = p0.mul_add(self.pink_b[0], w0 * white);
        self.pink_b[1] = p1.mul_add(self.pink_b[1], w1 * white);
        self.pink_b[2] = p2.mul_add(self.pink_b[2], w2 * white);
        self.pink_b[3] = p3.mul_add(self.pink_b[3], w3 * white);
        self.pink_b[4] = p4.mul_add(self.pink_b[4], w4 * white);
        self.pink_b[5] = p5.mul_add(self.pink_b[5], w5 * white);
        let b6 = w6_factor * white;

        let pink_sum = self.pink_b[0]
            + self.pink_b[1]
            + self.pink_b[2]
            + self.pink_b[3]
            + self.pink_b[4]
            + self.pink_b[5]
            + b6
            + white * final_white_factor;

        pink_sum * output_scale
    }

    #[inline(always)]
    fn get_pink_noise_scalar(&mut self) -> f32 {
        let white = self.get_white_noise_scalar();
        self.pink_b_scalar[0] = PINK_P0.mul_add(self.pink_b_scalar[0], PINK_W0 * white);
        self.pink_b_scalar[1] = PINK_P1.mul_add(self.pink_b_scalar[1], PINK_W1 * white);
        self.pink_b_scalar[2] = PINK_P2.mul_add(self.pink_b_scalar[2], PINK_W2 * white);
        self.pink_b_scalar[3] = PINK_P3.mul_add(self.pink_b_scalar[3], PINK_W3 * white);
        self.pink_b_scalar[4] = PINK_P4.mul_add(self.pink_b_scalar[4], PINK_W4 * white);
        self.pink_b_scalar[5] = PINK_P5.mul_add(self.pink_b_scalar[5], PINK_W5 * white);
        let b6 = PINK_W6_FACTOR * white;
        let pink_sum = self.pink_b_scalar[0]
            + self.pink_b_scalar[1]
            + self.pink_b_scalar[2]
            + self.pink_b_scalar[3]
            + self.pink_b_scalar[4]
            + self.pink_b_scalar[5]
            + b6
            + white * PINK_FINAL_WHITE_FACTOR;
        pink_sum * PINK_OUTPUT_SCALE
    }

    #[inline(always)]
    fn get_brownian_noise_simd(&mut self) -> f32x4 {
        let white = self.get_white_noise_simd();
        let decay_simd = f32x4::splat(BROWN_DECAY);
        let input_scale_simd = f32x4::splat(BROWN_WHITE_INPUT_SCALE);
        let output_scale = f32x4::splat(BROWN_OUTPUT_SCALE);
        self.brown_state = decay_simd.mul_add(self.brown_state, input_scale_simd * white);
        self.brown_state * output_scale
    }

    #[inline(always)]
    fn get_brownian_noise_scalar(&mut self) -> f32 {
        let white = self.get_white_noise_scalar();
        self.brown_state_scalar =
            BROWN_DECAY.mul_add(self.brown_state_scalar, BROWN_WHITE_INPUT_SCALE * white);
        self.brown_state_scalar * BROWN_OUTPUT_SCALE
    }

    // --- Filters ---
    // (apply_filter_* remain the same)
    #[inline(always)]
    fn apply_filter_simd(&mut self, input_noise: f32x4, alpha: f32x4) -> f32x4 {
        let safe_alpha = alpha.simd_clamp(f32x4::splat(0.0), f32x4::splat(Self::MAX_FILTER_ALPHA));
        let one_minus_alpha = f32x4::splat(1.0) - safe_alpha;
        self.lp_state = safe_alpha.mul_add(input_noise, one_minus_alpha * self.lp_state);
        self.lp_state
    }

    #[inline(always)]
    fn apply_filter_scalar(&mut self, input_noise: f32, alpha: f32) -> f32 {
        let safe_alpha = alpha.clamp(0.0, Self::MAX_FILTER_ALPHA);
        let one_minus_alpha = 1.0 - safe_alpha;
        self.lp_state_scalar =
            safe_alpha.mul_add(input_noise, one_minus_alpha * self.lp_state_scalar);
        self.lp_state_scalar
    }

    // --- Cutoff Conversion ---
    // (normalized_cutoff_to_alpha_* remain the same)
    #[inline(always)]
    fn normalized_cutoff_to_alpha_simd(norm_cutoff: f32x4) -> f32x4 {
        let squared = norm_cutoff * norm_cutoff; // power 2 curve
        squared.simd_clamp(f32x4::splat(0.0), f32x4::splat(Self::MAX_FILTER_ALPHA))
    }

    #[inline(always)]
    fn normalized_cutoff_to_alpha_scalar(norm_cutoff: f32) -> f32 {
        let squared = norm_cutoff * norm_cutoff; // power 2 curve
        squared.clamp(0.0, Self::MAX_FILTER_ALPHA)
    }

    // --- REMOVED Modulation Helper Methods ---
    // apply_add, apply_mul, apply_bipolar, transform_simd, transform_scalar,
    // simd_process_unchecked, simd_process, combine_modulation_inplace*,
    // are now provided by the ModulationProcessor trait implementation.
}

// --- AudioNode Implementation ---

impl AudioNode for NoiseGenerator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        [
            (PortId::AudioOutput0, true),
            (PortId::CutoffMod, false),
            (PortId::GainMod, false),
        ]
        .iter()
        .cloned()
        .collect()
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        // --- 0) Early exit & Buffer Preparation ---
        if !self.enabled {
            if let Some(output_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                output_buffer[..buffer_size].fill(0.0);
            }
            return;
        }

        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buffer) => buffer,
            None => return,
        };

        self.ensure_scratch_buffers(buffer_size);

        // --- SIMD Constants ---
        const LANES: usize = 4;
        let simd_zero = f32x4::splat(0.0);
        let simd_one = f32x4::splat(1.0);
        let dc_offset_simd = f32x4::splat(self.dc_offset);
        let chunks = buffer_size / LANES;

        // --- 1) Modulation Processing ---

        let cutoff_sources = inputs.get(&PortId::CutoffMod).map(|v| v.as_slice());
        let gain_sources = inputs.get(&PortId::GainMod).map(|v| v.as_slice());

        // --- Accumulate using Trait Method ---
        // Use Self:: to call the method from the implemented trait
        Self::accumulate_modulations_inplace(
            buffer_size,
            cutoff_sources,
            &mut self.scratch_cutoff_add[..buffer_size],
            &mut self.scratch_cutoff_mult[..buffer_size],
        );
        Self::accumulate_modulations_inplace(
            buffer_size,
            gain_sources,
            &mut self.scratch_gain_add[..buffer_size],
            &mut self.scratch_gain_vca[..buffer_size],
        );

        // --- Combine Inplace (Manual Implementation to avoid borrow issues) ---
        // Although the trait provides combine_modulation_inplace, calling it here
        // with scratch_cutoff_mult as both target and mult_input causes borrow errors.
        // So, we manually implement the combination step.
        {
            // Combine Cutoff
            let base_cutoff_simd = Simd::<f32, LANES>::splat(self.base_cutoff_normalized);
            let add_buf = &self.scratch_cutoff_add[..buffer_size];
            let mult_buf = &mut self.scratch_cutoff_mult[..buffer_size]; // Target

            for i in 0..chunks {
                let offset = i * LANES;
                let add_simd = Simd::<f32, LANES>::from_slice(&add_buf[offset..offset + LANES]);
                let mult_simd = Simd::<f32, LANES>::from_slice(&mult_buf[offset..offset + LANES]); // Read current mult
                let combined = (base_cutoff_simd + add_simd) * mult_simd;
                combined.copy_to_slice(&mut mult_buf[offset..offset + LANES]); // Write back
            }
            let remainder_start = chunks * LANES;
            for i in remainder_start..buffer_size {
                let combined = (self.base_cutoff_normalized + add_buf[i]) * mult_buf[i];
                mult_buf[i] = combined;
            }
        }
        {
            // Combine Gain
            let base_gain_simd = Simd::<f32, LANES>::splat(self.base_gain);
            let add_buf = &self.scratch_gain_add[..buffer_size];
            let vca_buf = &mut self.scratch_gain_vca[..buffer_size]; // Target

            for i in 0..chunks {
                let offset = i * LANES;
                let add_simd = Simd::<f32, LANES>::from_slice(&add_buf[offset..offset + LANES]);
                let vca_simd = Simd::<f32, LANES>::from_slice(&vca_buf[offset..offset + LANES]); // Read current mult
                let combined = (base_gain_simd + add_simd) * vca_simd;
                combined.copy_to_slice(&mut vca_buf[offset..offset + LANES]); // Write back
            }
            let remainder_start = chunks * LANES;
            for i in remainder_start..buffer_size {
                let combined = (self.base_gain + add_buf[i]) * vca_buf[i];
                vca_buf[i] = combined;
            }
        }

        // --- 2) Main Processing Loop (SIMD) ---
        for i in 0..chunks {
            let offset = i * LANES;

            // Load FINAL combined parameters from scratch buffers
            let cutoff_norm_simd =
                f32x4::from_slice(&self.scratch_cutoff_mult[offset..offset + LANES]);
            let gain_simd = f32x4::from_slice(&self.scratch_gain_vca[offset..offset + LANES]);

            // Clamp Parameters
            let clamped_cutoff_norm_simd = cutoff_norm_simd.simd_clamp(simd_zero, simd_one);
            let clamped_gain_simd = gain_simd.simd_max(simd_zero);

            // Calculate Filter Coefficient
            let alpha_simd = Self::normalized_cutoff_to_alpha_simd(clamped_cutoff_norm_simd);

            // Generate Noise
            let noise_simd = match self.noise_type {
                NoiseType::White => self.get_white_noise_simd(),
                NoiseType::Pink => self.get_pink_noise_simd(),
                NoiseType::Brownian => self.get_brownian_noise_simd(),
            };

            // Apply Filter
            let filtered_noise = self.apply_filter_simd(noise_simd, alpha_simd);

            // Apply DC Offset
            let offset_noise = filtered_noise + dc_offset_simd;

            // Apply Gain
            let result_simd = offset_noise * clamped_gain_simd;

            // Write Output
            result_simd.copy_to_slice(&mut output_buffer[offset..offset + LANES]);
        }

        // --- 3) Scalar Remainder ---
        let remainder_start = chunks * LANES;
        if remainder_start < buffer_size {
            for i in remainder_start..buffer_size {
                // Load FINAL combined parameters
                let cutoff_norm_scalar = self.scratch_cutoff_mult[i];
                let gain_scalar = self.scratch_gain_vca[i];

                // Clamp Parameters
                let clamped_cutoff_norm_scalar = cutoff_norm_scalar.clamp(0.0, 1.0);
                let clamped_gain_scalar = gain_scalar.max(0.0);

                // Calculate Filter Coefficient
                let alpha_scalar =
                    Self::normalized_cutoff_to_alpha_scalar(clamped_cutoff_norm_scalar);

                // Generate Noise
                let noise_scalar = match self.noise_type {
                    NoiseType::White => self.get_white_noise_scalar(),
                    NoiseType::Pink => self.get_pink_noise_scalar(),
                    NoiseType::Brownian => self.get_brownian_noise_scalar(),
                };

                // Apply Filter
                let filtered_noise = self.apply_filter_scalar(noise_scalar, alpha_scalar);

                // Apply DC Offset
                let offset_noise = filtered_noise + self.dc_offset;

                // Apply Gain
                let result_scalar = offset_noise * clamped_gain_scalar;

                // Write Output
                output_buffer[i] = result_scalar;
            }
        }
    } // end process

    fn reset(&mut self) {
        self.reset_noise_state();
        let initial_cutoff_hz = self.sample_rate * Self::MAX_FREQUENCY_HZ_FACTOR;
        self.base_cutoff_normalized = Self::hz_to_normalized(initial_cutoff_hz, self.sample_rate);
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
    }
    fn node_type(&self) -> &str {
        "noise_generator"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::AudioNode;
    use std::collections::HashMap;

    const TEST_SAMPLE_RATE: f32 = 44100.0;
    const TEST_BUFFER_SIZE: usize = 1024;
    const NUM_BUFFERS_TO_PROCESS: usize = 50;
    const AMPLITUDE_THRESHOLD: f32 = 0.90;

    fn run_noise_test(noise_type: NoiseType) -> f32 {
        let mut gen = NoiseGenerator::new(TEST_SAMPLE_RATE);

        gen.set_noise_type(noise_type);
        gen.set_base_gain(1.0);
        let max_cutoff_hz = TEST_SAMPLE_RATE * NoiseGenerator::MAX_FREQUENCY_HZ_FACTOR;
        gen.set_base_cutoff(max_cutoff_hz);
        gen.set_dc_offset(0.0);
        gen.set_active(true);

        let mut output_buffer = vec![0.0f32; TEST_BUFFER_SIZE];
        let inputs: HashMap<PortId, Vec<ModulationSource>> = HashMap::new();
        // Removed HashMap declaration from here

        let mut max_abs_peak = 0.0f32;

        for _ in 0..NUM_BUFFERS_TO_PROCESS {
            // --- FIX: Recreate the HashMap inside the loop ---
            // This ensures the HashMap and its contained borrow only live for one iteration.
            let mut outputs: HashMap<PortId, &mut [f32]> = HashMap::new();
            outputs.insert(PortId::AudioOutput0, &mut output_buffer);

            // Pass the locally scoped HashMap to process
            gen.process(&inputs, &mut outputs, TEST_BUFFER_SIZE);

            // Read from output_buffer after process is done (immutable borrow is fine)
            for &sample in output_buffer.iter() {
                max_abs_peak = max_abs_peak.max(sample.abs());
            }
            // `outputs` goes out of scope here, releasing the mutable borrow of `output_buffer`.
        }

        println!(
            "Max peak amplitude observed for {:?}: {}",
            noise_type, max_abs_peak
        );
        max_abs_peak
    }

    #[test]
    fn test_white_noise_amplitude() {
        let peak = run_noise_test(NoiseType::White);
        assert!(
            peak > AMPLITUDE_THRESHOLD,
            "White noise peak ({}) was below threshold ({})",
            peak,
            AMPLITUDE_THRESHOLD
        );
    }

    #[test]
    fn test_pink_noise_amplitude() {
        let peak = run_noise_test(NoiseType::Pink);
        // Expect failure initially due to PINK_OUTPUT_SCALE
        assert!(
            peak > AMPLITUDE_THRESHOLD,
            "Pink noise peak ({}) was below threshold ({})",
            peak,
            AMPLITUDE_THRESHOLD
        );
    }

    #[test]
    fn test_brownian_noise_amplitude() {
        let peak = run_noise_test(NoiseType::Brownian);
        // Expect failure initially due to BROWN_*_SCALE constants
        assert!(
            peak > AMPLITUDE_THRESHOLD,
            "Brownian noise peak ({}) was below threshold ({})",
            peak,
            AMPLITUDE_THRESHOLD
        );
    }

    #[test]
    fn test_white_noise_filtered_amplitude() {
        let mut gen = NoiseGenerator::new(TEST_SAMPLE_RATE);
        gen.set_noise_type(NoiseType::White);
        gen.set_base_gain(1.0);
        gen.set_base_cutoff(1000.0); // Low cutoff
        gen.set_dc_offset(0.0);
        gen.set_active(true);

        let mut output_buffer = vec![0.0f32; TEST_BUFFER_SIZE];
        let inputs: HashMap<PortId, Vec<ModulationSource>> = HashMap::new();
        // Removed HashMap declaration from here
        let mut max_abs_peak = 0.0f32;

        for _ in 0..NUM_BUFFERS_TO_PROCESS {
            // --- FIX: Apply the same fix here - recreate HashMap ---
            let mut outputs: HashMap<PortId, &mut [f32]> = HashMap::new();
            outputs.insert(PortId::AudioOutput0, &mut output_buffer);

            gen.process(&inputs, &mut outputs, TEST_BUFFER_SIZE);

            for &sample in output_buffer.iter() {
                max_abs_peak = max_abs_peak.max(sample.abs());
            }
            // `outputs` goes out of scope here, releasing the mutable borrow.
        }
        println!(
            "Max peak amplitude observed for Filtered White Noise (1kHz): {}",
            max_abs_peak
        );
        // No assertion here, just observation
    }
}
