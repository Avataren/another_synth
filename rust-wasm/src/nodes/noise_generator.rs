//! A SIMD-optimized noise generator that produces white, pink, or brownian noise.
//! Supports modulation for cutoff (interpreted as frequency) and gain parameters.

use std::any::Any;
use std::collections::HashMap;
use std::simd::num::SimdFloat;
use std::simd::{f32x4, u32x4, LaneCount, Simd, SupportedLaneCount}; // Added u32x4, LaneCount, SupportedLaneCount for modulation trait usage
use wasm_bindgen::prelude::wasm_bindgen;

// Import necessary types from graph and traits
// NOTE: Adjust the path `crate::graph` and `crate::traits` if your project structure differs.
use crate::graph::{
    ModulationProcessor, ModulationSource, ModulationTransformation, ModulationType,
};
use crate::traits::{AudioNode, PortId};

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
    /// The desired noise type.
    pub noise_type: NoiseType,
    /// Base cutoff frequency (Hz) for the lowpass filter.
    pub cutoff: f32,
    /// Base amplitude gain (0.0 to 1.0 typical).
    pub gain: f32,
    /// Whether the node is enabled.
    pub enabled: bool,
}

// --- Noise Generation Constants ---
// Pink Noise Constants (Paul Kellett approx.) - Reverted Scale
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
const PINK_W5: f32 = 0.0168980; // Using positive W5 from standard Kellett
const PINK_W6_FACTOR: f32 = 0.115926;
const PINK_FINAL_WHITE_FACTOR: f32 = 0.5362;
const PINK_OUTPUT_SCALE: f32 = 0.25; // Reverted to old scale

// Brownian Noise Constants - Derived from old algorithm & scale
const BROWN_DECAY: f32 = 1.0 / 1.02; // Approx 0.98039
const BROWN_WHITE_INPUT_SCALE: f32 = 0.02 / 1.02; // Approx 0.0196
const BROWN_OUTPUT_SCALE: f32 = 8.0; // Reverted to old scale

/// A noise generator node using SIMD for optimization.
/// Combines the newer structure (Hz cutoff, scratch buffers, scalar path)
/// with the older, previously working core noise generation logic.
pub struct NoiseGenerator {
    // Parameters
    sample_rate: f32,
    enabled: bool,
    base_gain: f32,
    noise_type: NoiseType,
    base_cutoff: f32, // Hz
    dc_offset: f32,   // Scalar dc offset

    // --- State ---
    // RNG State (using 4 u32 like old version for its algorithm)
    rng_state: [u32; 4],

    // Lowpass Filter state (new structure)
    lp_state: f32x4,      // SIMD
    lp_state_scalar: f32, // Scalar

    // Pink noise state (new structure with separate scalar)
    pink_b: [f32x4; 7],      // SIMD state vars b0-b6
    pink_b_scalar: [f32; 7], // Scalar

    // Brownian noise state (new structure with separate scalar)
    brown_state: f32x4,      // SIMD
    brown_state_scalar: f32, // Scalar

    // Smoothed parameter state (new structure)
    smoothed_cutoff: f32, // Hz
    smoothing_factor: f32,

    // Scratch Buffers (new structure)
    mod_scratch_add: Vec<f32>,  // Temp buffer for accumulation in process()
    mod_scratch_mult: Vec<f32>, // Temp buffer for accumulation in process()
    scratch_cutoff_add: Vec<f32>,
    scratch_cutoff_mult: Vec<f32>,
    scratch_gain_add: Vec<f32>,
    scratch_gain_vca: Vec<f32>, // Using VCA buffer for multiplicative results
}

impl NoiseGenerator {
    /// Default smoothing factor for cutoff changes.
    const CUTOFF_SMOOTHING_DEFAULT: f32 = 0.05;
    /// Minimum filter cutoff frequency (Hz).
    const MIN_FREQUENCY: f32 = 10.0;
    /// Initial seed for the random number generator (matches old version).
    const INITIAL_RNG_SEED: u32 = 123;

    /// Creates a new noise generator.
    ///
    /// # Arguments
    /// * `sample_rate` - The audio sample rate in Hz.
    ///
    /// # Panics
    /// Panics if `sample_rate` is not positive.
    pub fn new(sample_rate: f32) -> Self {
        assert!(sample_rate > 0.0, "Sample rate must be positive");
        let initial_capacity = 128; // Default capacity for scratch buffers
        let initial_cutoff = sample_rate * 0.5; // Start with filter wide open (Hz)

        Self {
            sample_rate,
            enabled: true,
            base_gain: 1.0,
            noise_type: NoiseType::White,
            base_cutoff: initial_cutoff,
            dc_offset: 0.0,
            rng_state: [Self::INITIAL_RNG_SEED, 362436069, 521288629, 88675123], // Old initial state
            lp_state: f32x4::splat(0.0),
            lp_state_scalar: 0.0,
            pink_b: [f32x4::splat(0.0); 7],
            pink_b_scalar: [0.0; 7],
            brown_state: f32x4::splat(0.0),
            brown_state_scalar: 0.0,
            smoothed_cutoff: initial_cutoff,
            smoothing_factor: Self::CUTOFF_SMOOTHING_DEFAULT,
            mod_scratch_add: vec![0.0; initial_capacity],
            mod_scratch_mult: vec![1.0; initial_capacity],
            scratch_cutoff_add: vec![0.0; initial_capacity],
            scratch_cutoff_mult: vec![1.0; initial_capacity],
            scratch_gain_add: vec![0.0; initial_capacity],
            scratch_gain_vca: vec![1.0; initial_capacity],
        }
    }

    /// Ensure all scratch buffers have at least `size` capacity.
    fn ensure_scratch_buffers(&mut self, size: usize) {
        let mut resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
            if buf.len() < size {
                buf.resize(size, default_val);
            }
        };
        resize_if_needed(&mut self.mod_scratch_add, 0.0); // Still needed as temp in process()
        resize_if_needed(&mut self.mod_scratch_mult, 1.0); // Still needed as temp in process()
        resize_if_needed(&mut self.scratch_cutoff_add, 0.0);
        resize_if_needed(&mut self.scratch_cutoff_mult, 1.0);
        resize_if_needed(&mut self.scratch_gain_add, 0.0);
        resize_if_needed(&mut self.scratch_gain_vca, 1.0);
    }

    /// Update node parameters from an `NoiseUpdate` struct.
    pub fn update(&mut self, update: NoiseUpdate) {
        let old_type = self.noise_type;
        self.noise_type = update.noise_type;
        self.base_cutoff = update
            .cutoff
            .clamp(Self::MIN_FREQUENCY, self.sample_rate * 0.499); // Clamp Hz
        self.base_gain = update.gain.max(0.0); // Ensure non-negative gain
        self.enabled = update.enabled;
        if old_type != self.noise_type {
            self.reset_noise_state(); // Reset internal state if type changes
        }
    }

    /// Sets the type of noise to generate.
    pub fn set_noise_type(&mut self, noise_type: NoiseType) {
        if noise_type != self.noise_type {
            self.noise_type = noise_type;
            self.reset_noise_state();
        }
    }

    /// Sets the base cutoff frequency in Hz for the lowpass filter.
    pub fn set_base_cutoff(&mut self, cutoff_hz: f32) {
        self.base_cutoff = cutoff_hz.clamp(Self::MIN_FREQUENCY, self.sample_rate * 0.499);
    }

    /// Sets the base gain (amplitude multiplier).
    pub fn set_base_gain(&mut self, gain: f32) {
        self.base_gain = gain.max(0.0);
    }

    /// Sets the random number generator seed using the old initialization scheme.
    pub fn set_seed(&mut self, seed: u32) {
        self.rng_state = [seed.max(1), 362436069, 521288629, 88675123]; // Ensure seed > 0
        self.reset_noise_state(); // Reset filter/noise state when seed changes
    }

    /// Sets the DC offset (-1.0 to 1.0).
    pub fn set_dc_offset(&mut self, offset: f32) {
        self.dc_offset = offset.clamp(-1.0, 1.0);
    }

    /// Resets internal filter and noise-specific state variables.
    fn reset_noise_state(&mut self) {
        self.lp_state = f32x4::splat(0.0);
        self.lp_state_scalar = 0.0;
        self.pink_b = [f32x4::splat(0.0); 7];
        self.pink_b_scalar = [0.0; 7];
        self.brown_state = f32x4::splat(0.0);
        self.brown_state_scalar = 0.0;
        // Does not reset RNG state here by default, call set_seed() for that.
    }

    // --- Noise Generation Methods (Using Reverted Logic) ---

    /// Generates 4 pseudo-random numbers using the logic from the old working version.
    #[inline(always)]
    fn generate_random_numbers_simd(&mut self) -> f32x4 {
        let mut results = [0.0f32; 4];
        // This loop runs the state update 4 times sequentially for one f32x4 output
        for result in results.iter_mut() {
            let t1 = self.rng_state[1].wrapping_mul(5);
            let temp = (t1 << 7 | t1 >> 25).wrapping_mul(9);
            let t = self.rng_state[1] << 9;
            self.rng_state[2] ^= self.rng_state[0];
            self.rng_state[3] ^= self.rng_state[1];
            self.rng_state[1] ^= self.rng_state[2];
            self.rng_state[0] ^= self.rng_state[3];
            self.rng_state[2] ^= t;
            self.rng_state[3] = (self.rng_state[3] << 11) | (self.rng_state[3] >> 21);
            *result = (temp as f32 / u32::MAX as f32) * 2.0 - 1.0; // Map to [-1.0, 1.0]
        }
        f32x4::from_array(results)
    }

    /// Generates 1 pseudo-random number (for scalar remainder) using the old logic.
    #[inline(always)]
    fn generate_random_number_scalar(&mut self) -> f32 {
        // Run the old RNG logic once
        let t1 = self.rng_state[1].wrapping_mul(5);
        let temp = (t1 << 7 | t1 >> 25).wrapping_mul(9);
        let t = self.rng_state[1] << 9;
        self.rng_state[2] ^= self.rng_state[0];
        self.rng_state[3] ^= self.rng_state[1];
        self.rng_state[1] ^= self.rng_state[2];
        self.rng_state[0] ^= self.rng_state[3];
        self.rng_state[2] ^= t;
        self.rng_state[3] = (self.rng_state[3] << 11) | (self.rng_state[3] >> 21);
        (temp as f32 / u32::MAX as f32) * 2.0 - 1.0 // Map to [-1.0, 1.0]
    }

    /// Get 4 samples of white noise.
    #[inline(always)]
    fn get_white_noise_simd(&mut self) -> f32x4 {
        self.generate_random_numbers_simd()
    }
    /// Get 1 sample of white noise.
    #[inline(always)]
    fn get_white_noise_scalar(&mut self) -> f32 {
        self.generate_random_number_scalar()
    }

    /// Get 4 samples of pink noise using Paul Kellett's method (reverted output scale).
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
        let output_scale = f32x4::splat(PINK_OUTPUT_SCALE); // Reverted scale

        self.pink_b[0] = p0 * self.pink_b[0] + w0 * white;
        self.pink_b[1] = p1 * self.pink_b[1] + w1 * white;
        self.pink_b[2] = p2 * self.pink_b[2] + w2 * white;
        self.pink_b[3] = p3 * self.pink_b[3] + w3 * white;
        self.pink_b[4] = p4 * self.pink_b[4] + w4 * white;
        self.pink_b[5] = p5 * self.pink_b[5] + w5 * white;
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

    /// Get 1 sample of pink noise (reverted output scale).
    #[inline(always)]
    fn get_pink_noise_scalar(&mut self) -> f32 {
        let white = self.get_white_noise_scalar();
        self.pink_b_scalar[0] = PINK_P0 * self.pink_b_scalar[0] + PINK_W0 * white;
        self.pink_b_scalar[1] = PINK_P1 * self.pink_b_scalar[1] + PINK_W1 * white;
        self.pink_b_scalar[2] = PINK_P2 * self.pink_b_scalar[2] + PINK_W2 * white;
        self.pink_b_scalar[3] = PINK_P3 * self.pink_b_scalar[3] + PINK_W3 * white;
        self.pink_b_scalar[4] = PINK_P4 * self.pink_b_scalar[4] + PINK_W4 * white;
        self.pink_b_scalar[5] = PINK_P5 * self.pink_b_scalar[5] + PINK_W5 * white;
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

    /// Get 4 samples of brownian noise (reverted algorithm parameters and scale).
    #[inline(always)]
    fn get_brownian_noise_simd(&mut self) -> f32x4 {
        let white = self.get_white_noise_simd();
        let decay_simd = f32x4::splat(BROWN_DECAY);
        let input_scale_simd = f32x4::splat(BROWN_WHITE_INPUT_SCALE);
        let output_scale = f32x4::splat(BROWN_OUTPUT_SCALE);
        self.brown_state = decay_simd * self.brown_state + input_scale_simd * white;
        self.brown_state * output_scale
    }

    /// Get 1 sample of brownian noise (reverted algorithm parameters and scale).
    #[inline(always)]
    fn get_brownian_noise_scalar(&mut self) -> f32 {
        let white = self.get_white_noise_scalar();
        self.brown_state_scalar =
            BROWN_DECAY * self.brown_state_scalar + BROWN_WHITE_INPUT_SCALE * white;
        self.brown_state_scalar * BROWN_OUTPUT_SCALE
    }

    // --- Filters (Using New Implementation) ---

    /// Apply a simple one-pole lowpass filter (SIMD version).
    #[inline(always)]
    fn apply_filter_simd(&mut self, input_noise: f32x4, coeff: f32) -> f32x4 {
        let alpha = f32x4::splat(coeff);
        let one_minus_alpha = f32x4::splat((1.0 - coeff).max(0.0)); // Prevent instability
        self.lp_state = alpha * input_noise + one_minus_alpha * self.lp_state;
        self.lp_state
    }

    /// Apply a simple one-pole lowpass filter (Scalar version).
    #[inline(always)]
    fn apply_filter_scalar(&mut self, input_noise: f32, coeff: f32) -> f32 {
        let one_minus_alpha = (1.0 - coeff).max(0.0); // Prevent instability
        self.lp_state_scalar = coeff * input_noise + one_minus_alpha * self.lp_state_scalar;
        self.lp_state_scalar
    }
}

// --- ModulationProcessor / AudioNode Implementations ---

// Implement the modulation processor trait (uses default implementation provided in the trait)
impl ModulationProcessor for NoiseGenerator {}

impl AudioNode for NoiseGenerator {
    /// Get the input and output ports for this node.
    fn get_ports(&self) -> HashMap<PortId, bool> {
        [
            (PortId::AudioOutput0, true), // Single audio output
            (PortId::CutoffMod, false),   // Cutoff modulation input
            (PortId::GainMod, false),     // Gain modulation input
        ]
        .iter()
        .cloned()
        .collect()
    }

    // process method
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
        // NO buffer prep needed if only writing raw noise
        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buffer) => buffer,
            None => return,
        };

        // --- 1) SKIP MODULATION PROCESSING ---

        // --- 2) Main Processing Loop (SIMD) ---
        let chunks = buffer_size / 4;
        for i in 0..chunks {
            let offset = i * 4;

            // --- SKIP FILTER CALC ---

            // --- Generate Noise (Calls REVERTED SIMD methods) ---
            let noise_simd = match self.noise_type {
                NoiseType::White => self.get_white_noise_simd(),
                NoiseType::Pink => self.get_pink_noise_simd(),
                NoiseType::Brownian => self.get_brownian_noise_simd(),
            };

            // --- SKIP FILTER ---

            // --- SKIP GAIN ---
            let result_simd = noise_simd; // Output raw noise directly

            result_simd.copy_to_slice(&mut output_buffer[offset..offset + 4]);
        }

        // --- 3) Scalar Remainder ---
        let remainder_start = chunks * 4;
        if remainder_start < buffer_size {
            for i in remainder_start..buffer_size {
                // --- SKIP FILTER CALC ---

                // --- Generate Noise (Calls REVERTED scalar method) ---
                let noise_scalar = match self.noise_type {
                    NoiseType::White => self.get_white_noise_scalar(),
                    NoiseType::Pink => self.get_pink_noise_scalar(),
                    NoiseType::Brownian => self.get_brownian_noise_scalar(),
                };

                // --- SKIP FILTER ---
                // --- SKIP GAIN ---
                output_buffer[i] = noise_scalar; // Output raw noise directly
            }
        }
    } // end process
    /// Reset internal state (filter, noise types) and smoothed cutoff.
    fn reset(&mut self) {
        self.reset_noise_state();
        self.smoothed_cutoff = self
            .base_cutoff
            .clamp(Self::MIN_FREQUENCY, self.sample_rate * 0.499);
        // Consider whether to reset RNG state on full reset
        // self.rng_state = [Self::INITIAL_RNG_SEED, 362436069, 521288629, 88675123];
    }

    /// Get a mutable reference to the node as `Any`.
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }

    /// Get an immutable reference to the node as `Any`.
    fn as_any(&self) -> &dyn Any {
        self
    }

    /// Check if the node is currently enabled.
    fn is_active(&self) -> bool {
        self.enabled
    }

    /// Enable or disable the node.
    fn set_active(&mut self, active: bool) {
        self.enabled = active;
        // Optionally reset state when disabled
        // if !active { self.reset(); }
    }

    /// Get the type identifier string for this node.
    fn node_type(&self) -> &str {
        "noise_generator"
    }
}
