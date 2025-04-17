use crate::graph::{ModulationProcessor, ModulationSource};
use crate::traits::{AudioNode, PortId};
use rustc_hash::FxHashMap;
use std::any::Any;
use std::simd::num::SimdFloat;
use std::simd::StdFloat;
use std::simd::{f32x4, Simd};
use wasm_bindgen::prelude::wasm_bindgen;

/// The type of noise to generate.
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum NoiseType {
    White = 0,
    Pink = 1,
    Brownian = 2,
}

/// External update struct (e.g. from UI).
#[wasm_bindgen]
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct NoiseUpdate {
    pub noise_type: NoiseType,
    pub cutoff: f32,
    pub gain: f32,
    pub enabled: bool,
}

// --- Noise Constants ---
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

/// A noise generator node using SIMD and a simple RNG.
pub struct NoiseGenerator {
    sample_rate: f32,
    enabled: bool,
    base_gain: f32,
    noise_type: NoiseType,
    base_cutoff_normalized: f32,
    dc_offset: f32,

    // RNG state (xorshift-like)
    rng_state: [u32; 4],

    // Filter state
    lp_state: f32x4,
    lp_state_scalar: f32,
    pink_b: [f32x4; 6],
    pink_b_scalar: [f32; 6],
    brown_state: f32x4,
    brown_state_scalar: f32,

    // Scratch buffers for modulation
    scratch_cutoff_add: Vec<f32>,
    scratch_cutoff_mult: Vec<f32>,
    scratch_gain_add: Vec<f32>,
    scratch_gain_vca: Vec<f32>,
}

impl ModulationProcessor for NoiseGenerator {}

impl NoiseGenerator {
    const MIN_FREQUENCY_HZ: f32 = 10.0;
    const MAX_FREQUENCY_HZ_FACTOR: f32 = 0.499;
    const INITIAL_RNG_SEED: u32 = 123;
    const MAX_FILTER_ALPHA: f32 = 0.999;

    #[inline(always)]
    fn hz_to_normalized(hz: f32, sr: f32) -> f32 {
        let max_hz = sr * Self::MAX_FREQUENCY_HZ_FACTOR;
        let clamped = hz.clamp(Self::MIN_FREQUENCY_HZ, max_hz);
        (clamped - Self::MIN_FREQUENCY_HZ) / (max_hz - Self::MIN_FREQUENCY_HZ)
    }

    pub fn new(sample_rate: f32) -> Self {
        assert!(sample_rate > 0.0);
        let cap = 128;
        let init_cut = sample_rate * Self::MAX_FREQUENCY_HZ_FACTOR;
        let norm = Self::hz_to_normalized(init_cut, sample_rate);

        NoiseGenerator {
            sample_rate,
            enabled: true,
            base_gain: 1.0,
            noise_type: NoiseType::White,
            base_cutoff_normalized: norm,
            dc_offset: 0.0,
            rng_state: [Self::INITIAL_RNG_SEED, 362436069, 521288629, 88675123],
            lp_state: f32x4::splat(0.0),
            lp_state_scalar: 0.0,
            pink_b: [f32x4::splat(0.0); 6],
            pink_b_scalar: [0.0; 6],
            brown_state: f32x4::splat(0.0),
            brown_state_scalar: 0.0,
            scratch_cutoff_add: vec![0.0; cap],
            scratch_cutoff_mult: vec![1.0; cap],
            scratch_gain_add: vec![0.0; cap],
            scratch_gain_vca: vec![1.0; cap],
        }
    }

    fn ensure_scratch(&mut self, size: usize) {
        let grow = |v: &mut Vec<f32>, val: f32| {
            if v.len() < size {
                v.resize(size, val);
            }
        };
        grow(&mut self.scratch_cutoff_add, 0.0);
        grow(&mut self.scratch_cutoff_mult, 1.0);
        grow(&mut self.scratch_gain_add, 0.0);
        grow(&mut self.scratch_gain_vca, 1.0);
    }

    pub fn update(&mut self, upd: NoiseUpdate) {
        let old = self.noise_type;
        self.noise_type = upd.noise_type;
        self.base_cutoff_normalized = Self::hz_to_normalized(upd.cutoff, self.sample_rate);
        self.base_gain = upd.gain.max(0.0);
        self.enabled = upd.enabled;
        if old != self.noise_type {
            self.reset_noise_state();
        }
    }

    pub fn set_seed(&mut self, seed: u32) {
        self.rng_state[0] = if seed == 0 { 1 } else { seed };
        self.reset_noise_state();
    }

    pub fn set_dc_offset(&mut self, off: f32) {
        self.dc_offset = off.clamp(-1.0, 1.0);
    }

    fn reset_noise_state(&mut self) {
        self.lp_state = f32x4::splat(0.0);
        self.lp_state_scalar = 0.0;
        self.pink_b = [f32x4::splat(0.0); 6];
        self.pink_b_scalar = [0.0; 6];
        self.brown_state = f32x4::splat(0.0);
        self.brown_state_scalar = 0.0;
    }

    // --- RNG ---
    #[inline(always)]
    fn next_rand_scalar(&mut self) -> f32 {
        let t = self.rng_state[1].wrapping_mul(5);
        let tmp = (t << 7 | t >> 25).wrapping_mul(9);
        let shift = self.rng_state[1] << 9;
        self.rng_state[2] ^= self.rng_state[0];
        self.rng_state[3] ^= self.rng_state[1];
        self.rng_state[1] ^= self.rng_state[2];
        self.rng_state[0] ^= self.rng_state[3];
        self.rng_state[2] ^= shift;
        self.rng_state[3] = self.rng_state[3].rotate_left(11);
        (tmp as f32 / u32::MAX as f32) * 2.0 - 1.0
    }

    #[inline(always)]
    fn next_rand_simd(&mut self) -> f32x4 {
        f32x4::from_array([
            self.next_rand_scalar(),
            self.next_rand_scalar(),
            self.next_rand_scalar(),
            self.next_rand_scalar(),
        ])
    }

    // --- Noise generators ---
    #[inline(always)]
    fn white_simd(&mut self) -> f32x4 {
        self.next_rand_simd()
    }
    #[inline(always)]
    fn white_scalar(&mut self) -> f32 {
        self.next_rand_scalar()
    }

    #[inline(always)]
    fn pink_simd(&mut self) -> f32x4 {
        let w = self.white_simd();
        for i in 0..6 {
            let (p, wt) = match i {
                0 => (PINK_P0, PINK_W0),
                1 => (PINK_P1, PINK_W1),
                2 => (PINK_P2, PINK_W2),
                3 => (PINK_P3, PINK_W3),
                4 => (PINK_P4, PINK_W4),
                5 => (PINK_P5, PINK_W5),
                _ => unreachable!(),
            };
            let pb = &mut self.pink_b[i];
            *pb = Simd::splat(p).mul_add(*pb, Simd::splat(wt) * w);
        }
        let sum = self.pink_b.iter().copied().reduce(|a, b| a + b).unwrap()
            + Simd::splat(PINK_W6_FACTOR) * w
            + Simd::splat(PINK_FINAL_WHITE_FACTOR) * w;
        sum * Simd::splat(PINK_OUTPUT_SCALE)
    }
    #[inline(always)]
    fn pink_scalar(&mut self) -> f32 {
        let w = self.white_scalar();
        for i in 0..6 {
            let (p, wt) = match i {
                0 => (PINK_P0, PINK_W0),
                1 => (PINK_P1, PINK_W1),
                2 => (PINK_P2, PINK_W2),
                3 => (PINK_P3, PINK_W3),
                4 => (PINK_P4, PINK_W4),
                5 => (PINK_P5, PINK_W5),
                _ => unreachable!(),
            };
            self.pink_b_scalar[i] = p.mul_add(self.pink_b_scalar[i], wt * w);
        }
        let sum = self.pink_b_scalar.iter().copied().sum::<f32>()
            + PINK_W6_FACTOR * w
            + PINK_FINAL_WHITE_FACTOR * w;
        sum * PINK_OUTPUT_SCALE
    }

    #[inline(always)]
    fn brown_simd(&mut self) -> f32x4 {
        let w = self.white_simd();
        self.brown_state = Simd::splat(BROWN_DECAY)
            .mul_add(self.brown_state, Simd::splat(BROWN_WHITE_INPUT_SCALE) * w);
        self.brown_state * Simd::splat(BROWN_OUTPUT_SCALE)
    }
    #[inline(always)]
    fn brown_scalar(&mut self) -> f32 {
        let w = self.white_scalar();
        self.brown_state_scalar =
            BROWN_DECAY.mul_add(self.brown_state_scalar, BROWN_WHITE_INPUT_SCALE * w);
        self.brown_state_scalar * BROWN_OUTPUT_SCALE
    }

    #[inline(always)]
    fn normalized_cutoff_to_alpha_simd(n: f32x4) -> f32x4 {
        (n * n).simd_clamp(Simd::splat(0.0), Simd::splat(Self::MAX_FILTER_ALPHA))
    }
    #[inline(always)]
    fn normalized_cutoff_to_alpha_scalar(n: f32) -> f32 {
        (n * n).clamp(0.0, Self::MAX_FILTER_ALPHA)
    }

    #[inline(always)]
    fn apply_filter_simd(&mut self, input: f32x4, alpha: f32x4) -> f32x4 {
        let a = alpha.simd_clamp(Simd::splat(0.0), Simd::splat(Self::MAX_FILTER_ALPHA));
        self.lp_state = a.mul_add(input, (Simd::splat(1.0) - a) * self.lp_state);
        self.lp_state
    }
    #[inline(always)]
    fn apply_filter_scalar(&mut self, input: f32, alpha: f32) -> f32 {
        let a = alpha.clamp(0.0, Self::MAX_FILTER_ALPHA);
        self.lp_state_scalar = a.mul_add(input, (1.0 - a) * self.lp_state_scalar);
        self.lp_state_scalar
    }

    /// Core block-processing entry.
    pub fn process_block(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        if !self.enabled {
            if let Some(buf) = outputs.get_mut(&PortId::AudioOutput0) {
                buf[..buffer_size].fill(0.0);
            }
            return;
        }
        let out = match outputs.get_mut(&PortId::AudioOutput0) {
            Some(b) => b,
            None => return,
        };

        self.ensure_scratch(buffer_size);

        // 1) Accumulate modulation
        let cs = inputs.get(&PortId::CutoffMod).map(|v| v.as_slice());
        let gs = inputs.get(&PortId::GainMod).map(|v| v.as_slice());

        Self::accumulate_modulations_inplace(
            buffer_size,
            cs,
            &mut self.scratch_cutoff_add,
            &mut self.scratch_cutoff_mult,
        );

        Self::accumulate_modulations_inplace(
            buffer_size,
            gs,
            &mut self.scratch_gain_add,
            &mut self.scratch_gain_vca,
        );

        // 2) Combine
        // Combine cutoff:
        for i in 0..buffer_size {
            let base = self.base_cutoff_normalized + self.scratch_cutoff_add[i];
            let m = self.scratch_cutoff_mult[i];
            self.scratch_cutoff_mult[i] = base * m;
        }

        // Combine gain:
        for i in 0..buffer_size {
            let base = self.base_gain + self.scratch_gain_add[i];
            let vca = self.scratch_gain_vca[i];
            self.scratch_gain_vca[i] = base * vca;
        }

        // 3) Pick noise fns once
        let (n4, n1): (fn(&mut _) -> f32x4, fn(&mut _) -> f32) = match self.noise_type {
            NoiseType::White => (Self::white_simd, Self::white_scalar),
            NoiseType::Pink => (Self::pink_simd, Self::pink_scalar),
            NoiseType::Brownian => (Self::brown_simd, Self::brown_scalar),
        };

        // 4) SIMD loop
        let lanes = 4;
        let chunks = buffer_size / lanes;
        let dc4 = Simd::splat(self.dc_offset);
        for i in 0..chunks {
            let idx = i * lanes;
            let cut_v = Simd::from_slice(&self.scratch_cutoff_mult[idx..][..lanes])
                .simd_clamp(Simd::splat(0.0), Simd::splat(1.0));
            let gain_v =
                Simd::from_slice(&self.scratch_gain_vca[idx..][..lanes]).simd_max(Simd::splat(0.0));
            let alpha = Self::normalized_cutoff_to_alpha_simd(cut_v);
            let noise = n4(self);
            let filt = self.apply_filter_simd(noise, alpha) + dc4;
            let outv = filt * gain_v;
            outv.copy_to_slice(&mut out[idx..][..lanes]);
        }

        // 5) Remainder
        let start = chunks * lanes;
        for i in start..buffer_size {
            let cut = self.scratch_cutoff_mult[i].clamp(0.0, 1.0);
            let gain = self.scratch_gain_vca[i].max(0.0);
            let alpha = Self::normalized_cutoff_to_alpha_scalar(cut);
            let noise = n1(self);
            let filt = self.apply_filter_scalar(noise, alpha) + self.dc_offset;
            out[i] = filt * gain;
        }
    }
}

impl AudioNode for NoiseGenerator {
    fn get_ports(&self) -> FxHashMap<PortId, bool> {
        [
            (PortId::AudioOutput0, true),
            (PortId::CutoffMod, false),
            (PortId::GainMod, false),
        ]
        .iter()
        .copied()
        .collect()
    }

    fn process(
        &mut self,
        inputs: &FxHashMap<PortId, Vec<ModulationSource>>,
        outputs: &mut FxHashMap<PortId, &mut [f32]>,
        buffer_size: usize,
    ) {
        self.process_block(inputs, outputs, buffer_size);
    }

    fn reset(&mut self) {
        self.reset_noise_state();
        let hf = self.sample_rate * Self::MAX_FREQUENCY_HZ_FACTOR;
        self.base_cutoff_normalized = Self::hz_to_normalized(hf, self.sample_rate);
    }

    fn as_any(&self) -> &dyn Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn Any {
        self
    }
    fn is_active(&self) -> bool {
        self.enabled
    }
    fn set_active(&mut self, a: bool) {
        self.enabled = a;
    }
    fn node_type(&self) -> &str {
        "noise_generator"
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::traits::AudioNode;
    const SR: f32 = 44_100.0;
    const BS: usize = 1024;
    const LOOPS: usize = 50;
    const TH: f32 = 0.90;

    fn run(nt: NoiseType) -> f32 {
        let mut gen = NoiseGenerator::new(SR);
        gen.update(NoiseUpdate {
            noise_type: nt,
            cutoff: SR * NoiseGenerator::MAX_FREQUENCY_HZ_FACTOR,
            gain: 1.0,
            enabled: true,
        });
        let mut buf = vec![0.0f32; BS];
        let inputs = FxHashMap::default();
        let mut peak: f32 = 0.0;
        for _ in 0..LOOPS {
            let mut outs: FxHashMap<PortId, &mut [f32]> = FxHashMap::default();
            outs.insert(PortId::AudioOutput0, &mut buf);
            gen.process(&inputs, &mut outs, BS);
            for &s in &buf {
                peak = peak.max(s.abs())
            }
        }
        peak
    }

    #[test]
    fn white_peak() {
        assert!(run(NoiseType::White) > TH);
    }
    #[test]
    fn pink_peak() {
        assert!(run(NoiseType::Pink) > TH);
    }
    #[test]
    fn brown_peak() {
        assert!(run(NoiseType::Brownian) > TH);
    }
}
