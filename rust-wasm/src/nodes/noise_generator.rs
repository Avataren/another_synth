//! A SIMD-optimized noise generator that produces white, pink, or brownian noise.
//! Supports modulation for cutoff (interpreted as frequency) and gain parameters.

use once_cell::sync::Lazy; // For TANH_LUT if used, though not used in this version
use std::any::Any;
use std::collections::HashMap;
use std::simd::num::SimdFloat;
use std::simd::{f32x4, Simd}; // Use Simd directly for clarity
use wasm_bindgen::prelude::wasm_bindgen; // If NoiseType enum needs JS export

// Import necessary types
use crate::graph::{
    ModulationProcessor, ModulationSource, ModulationTransformation, ModulationType,
};
use crate::traits::{AudioNode, PortId};

// Using wasm_bindgen here suggests this might be exposed to JavaScript.
// If not, wasm_bindgen can be removed.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NoiseType {
    White = 0,
    Pink = 1,
    Brownian = 2,
}

// Structure for external updates (e.g., from UI or automation)
// Wasm_bindgen might be needed here too if it's created in JS.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseUpdate {
    pub noise_type: NoiseType,
    pub cutoff: f32, // Now interpreted as frequency (Hz) for the lowpass filter
    pub gain: f32,   // Amplitude gain (0.0 to 1.0 typical)
    pub enabled: bool,
}

/// A noise generator node using SIMD for optimization.
pub struct NoiseGenerator {
    // Parameters
    sample_rate: f32, // Store sample rate for filter calculations
    enabled: bool,
    base_gain: f32, // Base amplitude gain
    noise_type: NoiseType,
    base_cutoff: f32, // Base cutoff frequency (Hz) for the lowpass filter
    dc_offset: f32,   // DC offset (-1.0 to 1.0)

    // Random number generator state (simple Xorshift)
    rng_state: [u32; 4],

    // Lowpass Filter state (one per SIMD lane)
    lp_state: f32x4,      // State for the one-pole lowpass filter (SIMD)
    lp_state_scalar: f32, // Separate scalar lowpass state for remainder

    // Pink noise state (using Paul Kellett's method, SIMD optimized)
    pink_b: [f32x4; 7], // State variables b0 through b6

    // Brownian noise state (one per SIMD lane)
    brown_state: f32x4,

    // Smoothed parameter state
    smoothed_cutoff: f32,
    smoothing_factor: f32, // For cutoff smoothing

    // === Scratch Buffers ===
    mod_scratch_add: Vec<f32>,
    mod_scratch_mult: Vec<f32>,
    scratch_cutoff_add: Vec<f32>,  // Additive modulation (Hz offset)
    scratch_cutoff_mult: Vec<f32>, // Multiplicative modulation (factor)
    scratch_gain_add: Vec<f32>,
    scratch_gain_mult: Vec<f32>,
}

impl NoiseGenerator {
    // Constants
    const CUTOFF_SMOOTHING_DEFAULT: f32 = 0.05; // Smoothing factor for cutoff changes
    const MIN_FREQUENCY: f32 = 10.0; // Minimum filter cutoff frequency

    /// Creates a new noise generator.
    pub fn new(sample_rate: f32) -> Self {
        assert!(sample_rate > 0.0, "Sample rate must be positive");
        let initial_capacity = 128;
        let initial_cutoff = sample_rate * 0.5; // Start with filter wide open

        Self {
            sample_rate,
            enabled: true,
            base_gain: 1.0,
            noise_type: NoiseType::White,
            base_cutoff: initial_cutoff,
            dc_offset: 0.0,

            // Initialize RNG with arbitrary non-zero values
            rng_state: [12345, 67890, 13579, 24680],

            lp_state: f32x4::splat(0.0),
            lp_state_scalar: 0.0, // Initialize scalar state

            pink_b: [f32x4::splat(0.0); 7], // Initialize pink noise state to zero

            brown_state: f32x4::splat(0.0),

            smoothed_cutoff: initial_cutoff,
            smoothing_factor: Self::CUTOFF_SMOOTHING_DEFAULT,

            // Initialize scratch buffers
            mod_scratch_add: vec![0.0; initial_capacity],
            mod_scratch_mult: vec![1.0; initial_capacity],
            scratch_cutoff_add: vec![0.0; initial_capacity],
            scratch_cutoff_mult: vec![1.0; initial_capacity],
            scratch_gain_add: vec![0.0; initial_capacity],
            scratch_gain_mult: vec![1.0; initial_capacity],
        }
    }

    /// Ensure all scratch buffers have at least `size` capacity.
    fn ensure_scratch_buffers(&mut self, size: usize) {
        let mut resize_if_needed = |buf: &mut Vec<f32>, default_val: f32| {
            if buf.len() < size {
                buf.resize(size, default_val);
            }
        };
        resize_if_needed(&mut self.mod_scratch_add, 0.0);
        resize_if_needed(&mut self.mod_scratch_mult, 1.0);
        resize_if_needed(&mut self.scratch_cutoff_add, 0.0);
        resize_if_needed(&mut self.scratch_cutoff_mult, 1.0);
        resize_if_needed(&mut self.scratch_gain_add, 0.0);
        resize_if_needed(&mut self.scratch_gain_mult, 1.0);
    }

    // --- Parameter Setters ---
    pub fn update(&mut self, update: NoiseUpdate) {
        let old_type = self.noise_type;
        self.noise_type = update.noise_type;
        self.base_cutoff = update
            .cutoff
            .clamp(Self::MIN_FREQUENCY, self.sample_rate * 0.49);
        self.base_gain = update.gain.max(0.0);
        self.enabled = update.enabled;
        if old_type != self.noise_type {
            self.reset_noise_state(); // Reset internal noise state if type changed
        }
    }

    pub fn set_noise_type(&mut self, noise_type: NoiseType) {
        if noise_type != self.noise_type {
            self.noise_type = noise_type;
            self.reset_noise_state(); // Reset state on type change
        }
    }

    pub fn set_base_cutoff(&mut self, cutoff_hz: f32) {
        self.base_cutoff = cutoff_hz.clamp(Self::MIN_FREQUENCY, self.sample_rate * 0.49);
    }

    pub fn set_base_gain(&mut self, gain: f32) {
        self.base_gain = gain.max(0.0);
    }

    pub fn set_seed(&mut self, seed: u32) {
        self.rng_state[0] = seed.wrapping_add(1);
        self.rng_state[1] = seed.wrapping_mul(1664525).wrapping_add(1013904223);
        self.rng_state[2] = seed.rotate_left(16).wrapping_add(1);
        self.rng_state[3] = seed.reverse_bits().wrapping_add(1);
    }

    pub fn set_dc_offset(&mut self, offset: f32) {
        self.dc_offset = offset.clamp(-1.0, 1.0);
    }

    /// Resets only the noise generation state (pink, brown, filter).
    fn reset_noise_state(&mut self) {
        self.lp_state = f32x4::splat(0.0);
        self.lp_state_scalar = 0.0; // Reset scalar state
        self.pink_b = [f32x4::splat(0.0); 7];
        self.brown_state = f32x4::splat(0.0);
    }

    // --- Noise Generation Methods (SIMD) ---

    /// Generates 4 pseudo-random numbers in [-1.0, 1.0) using Xorshift128.
    #[inline(always)]
    fn generate_random_numbers(&mut self) -> f32x4 {
        let mut s1 = Simd::from_array(self.rng_state);
        let s0 = s1.rotate_elements_right::<1>();

        s1 ^= s1 << 23;
        s1 ^= s1 >> 17;
        s1 ^= s0;
        s1 ^= s0 >> 26;

        self.rng_state = s1.to_array();

        const SCALE: f32 = 2.0 / (u32::MAX as f32);
        f32x4::from_array([
            (self.rng_state[0] as f32) * SCALE - 1.0,
            (self.rng_state[1] as f32) * SCALE - 1.0,
            (self.rng_state[2] as f32) * SCALE - 1.0,
            (self.rng_state[3] as f32) * SCALE - 1.0,
        ])
    }

    /// Get 4 samples of white noise.
    #[inline(always)]
    fn get_white_noise(&mut self) -> f32x4 {
        self.generate_random_numbers()
    }

    /// Get 4 samples of pink noise using Paul Kellett's method.
    #[inline(always)]
    fn get_pink_noise(&mut self) -> f32x4 {
        const P0: f32 = 0.99886;
        const P1: f32 = 0.99332;
        const P2: f32 = 0.96900;
        const P3: f32 = 0.86650;
        const P4: f32 = 0.55000;
        const P5: f32 = -0.76160;
        const W0: f32 = 0.0555179;
        const W1: f32 = 0.0750759;
        const W2: f32 = 0.1538520;
        const W3: f32 = 0.3104856;
        const W4: f32 = 0.5329522;
        const W5: f32 = -0.0168980;
        // Removed const_pink_scale, apply scaling at the end

        let white = self.get_white_noise();

        let p0 = f32x4::splat(P0);
        let w0 = f32x4::splat(W0);
        let p1 = f32x4::splat(P1);
        let w1 = f32x4::splat(W1);
        let p2 = f32x4::splat(P2);
        let w2 = f32x4::splat(W2);
        let p3 = f32x4::splat(P3);
        let w3 = f32x4::splat(W3);
        let p4 = f32x4::splat(P4);
        let w4 = f32x4::splat(W4);
        let p5 = f32x4::splat(P5);
        let w5 = f32x4::splat(W5);
        // Pre-calculate factors for b6 and final white sum
        let w6_factor = f32x4::splat(0.115926);
        let final_white_factor = f32x4::splat(0.5362);

        self.pink_b[0] = p0 * self.pink_b[0] + w0 * white;
        self.pink_b[1] = p1 * self.pink_b[1] + w1 * white;
        self.pink_b[2] = p2 * self.pink_b[2] + w2 * white;
        self.pink_b[3] = p3 * self.pink_b[3] + w3 * white;
        self.pink_b[4] = p4 * self.pink_b[4] + w4 * white;
        self.pink_b[5] = p5 * self.pink_b[5] + w5 * white;
        // b6 = w6_factor * white; // Calculate separately for sum

        let b6 = w6_factor * white;

        let pink_sum = self.pink_b[0]
            + self.pink_b[1]
            + self.pink_b[2]
            + self.pink_b[3]
            + self.pink_b[4]
            + self.pink_b[5]
            + b6
            + white * final_white_factor;

        // Apply final scaling (e.g., 1/16 = 0.0625)
        pink_sum * f32x4::splat(0.0625)
    }

    /// Get 4 samples of brownian noise (random walk).
    #[inline(always)]
    fn get_brownian_noise(&mut self) -> f32x4 {
        let white = self.get_white_noise();
        const DECAY: f32 = 0.995;
        const SCALE: f32 = 0.05;
        // Removed const_brown_scale, apply scaling at the end if needed

        let decay_simd = f32x4::splat(DECAY);
        let scale_simd = f32x4::splat(SCALE);

        self.brown_state = decay_simd * self.brown_state + scale_simd * white;

        // Brownian noise can drift significantly. Scaling might be required.
        self.brown_state * f32x4::splat(1.0) // Adjust output scaling factor here if needed
    }

    /// Apply a simple one-pole lowpass filter (SIMD version).
    #[inline(always)]
    fn apply_filter_simd(&mut self, input_noise: f32x4, coeff: f32) -> f32x4 {
        let alpha = f32x4::splat(coeff);
        let one_minus_alpha = f32x4::splat(1.0 - coeff); // Precalculate
        self.lp_state = alpha * input_noise + one_minus_alpha * self.lp_state;
        self.lp_state
    }

    /// Apply a simple one-pole lowpass filter (Scalar version).
    #[inline(always)]
    fn apply_filter_scalar(&mut self, input_noise: f32, coeff: f32) -> f32 {
        let one_minus_alpha = 1.0 - coeff; // Precalculate
        self.lp_state_scalar = coeff * input_noise + one_minus_alpha * self.lp_state_scalar;
        self.lp_state_scalar
    }
}

// Implement the modulation processor trait
impl ModulationProcessor for NoiseGenerator {}

impl AudioNode for NoiseGenerator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        [
            (PortId::CutoffMod, false),
            (PortId::GainMod, false),
            (PortId::AudioOutput0, true),
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
        // --- 0) Early exit and Buffer Preparation ---
        if !self.enabled {
            if let Some(output_buffer) = outputs.get_mut(&PortId::AudioOutput0) {
                output_buffer[..buffer_size].fill(0.0);
            }
            return;
        }
        self.ensure_scratch_buffers(buffer_size);
        let output_buffer = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(buffer) => buffer,
            None => return,
        };

        // --- 1) Process Modulation Inputs ---
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
            PortId::GainMod,
            &mut self.scratch_gain_add,
            &mut self.scratch_gain_mult,
            0.0,
            1.0,
        );

        // --- 2) Main Processing Loop (SIMD) ---
        let dc_offset_simd = f32x4::splat(self.dc_offset);
        let base_gain_simd = f32x4::splat(self.base_gain);
        let zero_simd = f32x4::splat(0.0);
        let nyquist_limit = self.sample_rate * 0.499;
        let min_freq = Self::MIN_FREQUENCY;
        let dt_over_sr = 1.0 / self.sample_rate;
        let pi_2 = 2.0 * std::f32::consts::PI; // Precompute 2*PI

        let chunks = buffer_size / 4;
        for i in 0..chunks {
            let offset = i * 4;

            // --- Calculate Smoothed Filter Coefficient ---
            let target_cutoff_hz = (self.base_cutoff + self.scratch_cutoff_add[offset])
                * self.scratch_cutoff_mult[offset];
            let target_cutoff_clamped = target_cutoff_hz.clamp(min_freq, nyquist_limit);
            self.smoothed_cutoff +=
                self.smoothing_factor * (target_cutoff_clamped - self.smoothed_cutoff);
            self.smoothed_cutoff = self.smoothed_cutoff.clamp(min_freq, nyquist_limit);

            // Calculate one-pole filter coefficient (alpha)
            let rc = 1.0 / (pi_2 * self.smoothed_cutoff); // Avoid recalculating pi*2
            let filter_coeff = dt_over_sr / (rc + dt_over_sr);

            // --- Generate Noise ---
            let noise_simd = match self.noise_type {
                NoiseType::White => self.get_white_noise(),
                NoiseType::Pink => self.get_pink_noise(),
                NoiseType::Brownian => self.get_brownian_noise(),
            };

            // --- Apply Filter (SIMD) ---
            let filtered_simd = self.apply_filter_simd(noise_simd, filter_coeff);

            // --- Apply Gain ---
            let gain_add_simd = f32x4::from_slice(&self.scratch_gain_add[offset..offset + 4]);
            let gain_mult_simd = f32x4::from_slice(&self.scratch_gain_mult[offset..offset + 4]);
            let effective_gain_simd = (base_gain_simd + gain_add_simd) * gain_mult_simd;

            // Apply DC offset and gain
            let result_simd =
                (filtered_simd + dc_offset_simd) * effective_gain_simd.simd_max(zero_simd);

            // Store result
            result_simd.copy_to_slice(&mut output_buffer[offset..offset + 4]);
        } // End SIMD Loop

        // --- 3) Scalar Remainder ---
        let remainder_start = chunks * 4;
        if remainder_start < buffer_size {
            // Recalculate coefficient for the remainder section
            let target_cutoff_hz = (self.base_cutoff + self.scratch_cutoff_add[remainder_start])
                * self.scratch_cutoff_mult[remainder_start];
            let target_cutoff_clamped = target_cutoff_hz.clamp(min_freq, nyquist_limit);
            self.smoothed_cutoff +=
                self.smoothing_factor * (target_cutoff_clamped - self.smoothed_cutoff);
            self.smoothed_cutoff = self.smoothed_cutoff.clamp(min_freq, nyquist_limit);
            let rc = 1.0 / (pi_2 * self.smoothed_cutoff);
            let filter_coeff = dt_over_sr / (rc + dt_over_sr);

            for i in remainder_start..buffer_size {
                // Generate single noise sample
                let white_scalar = {
                    self.rng_state[0] ^= self.rng_state[0] << 13;
                    self.rng_state[0] ^= self.rng_state[0] >> 17;
                    self.rng_state[0] ^= self.rng_state[0] << 5;
                    (self.rng_state[0] as f32 / u32::MAX as f32) * 2.0 - 1.0
                };
                // TODO: Scalar Pink/Brown for remainder if needed
                let noise_scalar = match self.noise_type {
                    NoiseType::White => white_scalar,
                    NoiseType::Pink | NoiseType::Brownian => white_scalar, // Placeholder
                };

                // Apply filter (Scalar)
                let filtered_scalar = self.apply_filter_scalar(noise_scalar, filter_coeff);

                // Apply gain
                let gain_add = self.scratch_gain_add[i];
                let gain_mult = self.scratch_gain_mult[i];
                let effective_gain = (self.base_gain + gain_add) * gain_mult;

                output_buffer[i] = (filtered_scalar + self.dc_offset) * effective_gain.max(0.0);
            }
        } // End Scalar Remainder
    } // End process fn

    // --- reset and other trait methods ---
    fn reset(&mut self) {
        self.reset_noise_state();
        self.smoothed_cutoff = self.base_cutoff;
        // Maybe reset RNG?
        // self.set_seed(12345);
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
            self.reset_noise_state();
        }
    }
    fn node_type(&self) -> &str {
        "noise_generator"
    }
} // End impl AudioNode
