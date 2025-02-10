//! A SIMD-optimized noise generator that produces white, pink, or brownian noise.
//! Supports multiple noise types with modulation for cutoff and gain parameters.

use std::any::Any;
use std::collections::HashMap;
use std::simd::f32x4;

use crate::graph::{ModulationProcessor, ModulationSource, ModulationType};
use crate::traits::{AudioNode, PortId};

/// The type of noise to generate
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NoiseType {
    White = 0,
    Pink = 1,
    Brownian = 2,
}

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseUpdate {
    pub noise_type: NoiseType,
    pub cutoff: f32,
    pub gain: f32,
    pub enabled: bool,
}

/// A noise generator that uses SIMD operations for efficient processing
pub struct NoiseGenerator {
    enabled: bool,
    gain: f32,
    noise_type: NoiseType,

    // Random number generator state
    rng_state: [u32; 4],

    // Filter parameters
    current_cutoff: f32,
    target_cutoff: f32,
    previous_output: f32x4,
    filter_coeff: f32,
    dc_offset: f32x4,

    // Pink noise state (SIMD optimized)
    pink_state: [f32x4; 7],

    // Brownian noise state
    brown_state: f32x4,

    // Cached constants for SIMD operations
    const_pink_scale: f32x4,
    const_brown_scale: f32x4,

    // Filter coefficient lookup table
    cutoff_table: Vec<f32>,
}

impl NoiseGenerator {
    // Constants for filter behavior
    const CUTOFF_SMOOTHING: f32 = 0.1;
    const MIN_FREQUENCY: f32 = 20.0;
    const CUTOFF_TABLE_SIZE: usize = 2048;

    /// Creates a new noise generator with the specified sample rate
    ///
    /// # Arguments
    /// * `sample_rate` - The audio sample rate in Hz (must be > 0)
    ///
    /// # Panics
    /// Panics if sample_rate is 0 or negative
    pub fn new(sample_rate: f32) -> Self {
        assert!(sample_rate > 0.0, "Sample rate must be positive");

        let max_frequency = sample_rate * 0.5;

        // Pre-compute cutoff frequency lookup table
        let mut cutoff_table = Vec::with_capacity(Self::CUTOFF_TABLE_SIZE);
        for i in 0..Self::CUTOFF_TABLE_SIZE {
            let x = i as f32 / (Self::CUTOFF_TABLE_SIZE - 1) as f32;
            let freq = Self::MIN_FREQUENCY * (max_frequency / Self::MIN_FREQUENCY).powf(x);
            let freq = freq.clamp(Self::MIN_FREQUENCY, max_frequency);

            let rc = 1.0 / (2.0 * std::f32::consts::PI * freq);
            let dt = 1.0 / sample_rate;
            cutoff_table.push(dt / (rc + dt));
        }

        Self {
            enabled: true,
            gain: 1.0,
            noise_type: NoiseType::White,
            rng_state: [123, 362436069, 521288629, 88675123],
            current_cutoff: 1.0,
            target_cutoff: 1.0,
            previous_output: f32x4::splat(0.0),
            filter_coeff: 0.0,
            dc_offset: f32x4::splat(0.0),
            pink_state: [f32x4::splat(0.0); 7],
            brown_state: f32x4::splat(0.0),
            const_pink_scale: f32x4::splat(0.25), // Pink noise scaling factor
            const_brown_scale: f32x4::splat(8.0), // Brownian noise scaling factor
            cutoff_table,
        }
    }

    pub fn update(&mut self, update: NoiseUpdate) {
        self.noise_type = update.noise_type;
        self.target_cutoff = update.cutoff.clamp(0.0, 1.0);
        self.gain = update.gain.clamp(0.0, 1.0);
    }

    /// Sets the type of noise to generate
    pub fn set_noise_type(&mut self, noise_type: NoiseType) {
        self.noise_type = noise_type;
    }

    /// Returns the current noise type
    pub fn noise_type(&self) -> NoiseType {
        self.noise_type
    }

    /// Sets the random number generator seed
    pub fn set_seed(&mut self, seed: u32) {
        self.rng_state = [seed, 362436069, 521288629, 88675123];
    }

    /// Sets the DC offset (-1.0 to 1.0)
    pub fn set_dc_offset(&mut self, offset: f32) {
        self.dc_offset = f32x4::splat(offset.clamp(-1.0, 1.0));
    }

    /// Returns the current cutoff frequency as a normalized value (0.0 to 1.0)
    pub fn current_cutoff(&self) -> f32 {
        self.current_cutoff
    }

    fn update_filter_coefficient(&mut self, cutoff_mod: f32) {
        // Apply modulation to base cutoff
        let target = (self.target_cutoff * cutoff_mod).clamp(0.0, 1.0);
        self.current_cutoff += (target - self.current_cutoff) * Self::CUTOFF_SMOOTHING;

        // Use lookup table for filter coefficient
        let index = (self.current_cutoff * (Self::CUTOFF_TABLE_SIZE - 1) as f32) as usize;
        self.filter_coeff = self.cutoff_table[index];
    }

    fn generate_random_numbers(&mut self) -> f32x4 {
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
            self.rng_state[3] = (self.rng_state[3] << 11) | (self.rng_state[3] >> 21);

            *result = (temp as f32 / u32::MAX as f32) * 2.0 - 1.0;
        }

        f32x4::from_array(results)
    }

    #[inline]
    fn get_white_noise(&mut self) -> f32x4 {
        self.generate_random_numbers()
    }

    fn get_pink_noise(&mut self) -> f32x4 {
        let white = self.get_white_noise();

        // Update pink noise state using SIMD operations
        // Reuse vectors to minimize allocations
        let mut pink = f32x4::splat(0.0);

        self.pink_state[0] =
            self.pink_state[0] * f32x4::splat(0.99886) + white * f32x4::splat(0.0555179);
        pink += self.pink_state[0];

        self.pink_state[1] =
            self.pink_state[1] * f32x4::splat(0.99332) + white * f32x4::splat(0.0750759);
        pink += self.pink_state[1];

        self.pink_state[2] =
            self.pink_state[2] * f32x4::splat(0.96900) + white * f32x4::splat(0.1538520);
        pink += self.pink_state[2];

        self.pink_state[3] =
            self.pink_state[3] * f32x4::splat(0.86650) + white * f32x4::splat(0.3104856);
        pink += self.pink_state[3];

        self.pink_state[4] =
            self.pink_state[4] * f32x4::splat(0.55000) + white * f32x4::splat(0.5329522);
        pink += self.pink_state[4];

        self.pink_state[5] =
            self.pink_state[5] * f32x4::splat(-0.7616) - white * f32x4::splat(0.0168980);
        pink += self.pink_state[5];

        self.pink_state[6] = white * f32x4::splat(0.115926);
        pink += self.pink_state[6] + white * f32x4::splat(0.5362);

        pink * self.const_pink_scale
    }

    fn get_brownian_noise(&mut self) -> f32x4 {
        let white = self.get_white_noise();
        self.brown_state = (self.brown_state + (white * f32x4::splat(0.02))) / f32x4::splat(1.02);
        self.brown_state * self.const_brown_scale
    }

    #[inline]
    fn apply_filter(&mut self, input_noise: f32x4) -> f32x4 {
        let coeff = f32x4::splat(self.filter_coeff);
        let output = input_noise * coeff + self.previous_output * (f32x4::splat(1.0) - coeff);
        self.previous_output = output;
        output
    }
}

impl ModulationProcessor for NoiseGenerator {
    fn get_modulation_type(&self, port: PortId) -> ModulationType {
        match port {
            PortId::CutoffMod => ModulationType::VCA,
            PortId::GainMod => ModulationType::VCA,
            _ => ModulationType::VCA,
        }
    }
}

impl AudioNode for NoiseGenerator {
    fn get_ports(&self) -> HashMap<PortId, bool> {
        let mut ports = HashMap::new();
        ports.insert(PortId::AudioOutput0, true); // Mono output
        ports.insert(PortId::CutoffMod, false); // Cutoff modulation
        ports.insert(PortId::GainMod, false); // Gain modulation
        ports
    }

    fn process(
        &mut self,
        inputs: &HashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut HashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        let cutoff_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::CutoffMod),
            1.0,
            PortId::CutoffMod,
        );

        let gain_mod = self.process_modulations(
            buffer_size,
            inputs.get(&PortId::GainMod),
            1.0,
            PortId::GainMod,
        );

        if let Some(output) = outputs.get_mut(&PortId::AudioOutput0) {
            // Process in SIMD chunks of 4 samples
            for i in (0..buffer_size).step_by(4) {
                let end = (i + 4).min(buffer_size);
                let chunk_size = end - i;

                // Update filter coefficient less frequently (every 4 samples)
                self.update_filter_coefficient(cutoff_mod[i]);

                // Generate noise based on type
                let noise = match self.noise_type {
                    NoiseType::White => self.get_white_noise(),
                    NoiseType::Pink => self.get_pink_noise(),
                    NoiseType::Brownian => self.get_brownian_noise(),
                };

                // Apply filter and gain modulation
                let gain_chunk = {
                    let mut chunk = [1.0; 4];
                    chunk[0..chunk_size].copy_from_slice(&gain_mod[i..end]);
                    f32x4::from_array(chunk)
                };

                let filtered = self.apply_filter(noise);
                let result = (filtered + self.dc_offset) * gain_chunk * f32x4::splat(self.gain);

                // Write output
                output[i..end].copy_from_slice(&result.to_array()[0..chunk_size]);
            }
        }
    }

    fn reset(&mut self) {
        self.previous_output = f32x4::splat(0.0);
        self.pink_state = [f32x4::splat(0.0); 7];
        self.brown_state = f32x4::splat(0.0);
        self.current_cutoff = 1.0;
        self.target_cutoff = 1.0;
        self.filter_coeff = 0.0;
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
