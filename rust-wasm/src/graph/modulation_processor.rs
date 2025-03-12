use super::ModulationSource;
use crate::graph::{ModulationTransformation, ModulationType};
use core::simd::{LaneCount, Simd, SupportedLaneCount};

pub struct ModulationResult {
    pub additive: Vec<f32>,
    pub multiplicative: Vec<f32>,
}

pub trait ModulationProcessor {
    fn process_modulations(
        &self,
        buffer_size: usize,
        sources: Option<&Vec<ModulationSource>>,
        initial_value: f32,
    ) -> Vec<f32> {
        // Convert Option<&Vec<...>> to Option<&[...]>
        let sources_slice = sources.map(|v| v.as_slice());
        let (add, mult) = Self::accumulate_modulations(buffer_size, sources_slice);
        add.into_iter()
            .zip(mult.into_iter())
            .map(|(a, m)| (a + initial_value) * m)
            .collect()
    }

    fn process_modulations_ex(
        &self,
        buffer_size: usize,
        sources: Option<&Vec<ModulationSource>>,
    ) -> ModulationResult {
        // Convert Option<&Vec<...>> to Option<&[...]>
        let sources_slice = sources.map(|v| v.as_slice());
        let (add, mult) = Self::accumulate_modulations(buffer_size, sources_slice);
        ModulationResult {
            additive: add,
            multiplicative: mult,
        }
    }

    #[inline(always)]
    fn accumulate_modulations(
        buffer_size: usize,
        sources: Option<&[ModulationSource]>,
    ) -> (Vec<f32>, Vec<f32>) {
        let mut mult = vec![1.0f32; buffer_size];
        let mut add = vec![0.0f32; buffer_size];

        if let Some(sources) = sources {
            for source in sources {
                let buf = &source.buffer;
                let amt = source.amount;
                let transform = source.transformation;
                match source.mod_type {
                    ModulationType::VCA => {
                        Self::apply_mul(buf, &mut mult, amt, transform);
                    }
                    ModulationType::Bipolar => {
                        Self::apply_bipolar(buf, &mut mult, amt, transform);
                    }
                    ModulationType::Additive => {
                        Self::apply_add(buf, &mut add, amt, transform);
                    }
                }
            }
        }
        (add, mult)
    }

    // This helper computes the transformation in SIMD.
    #[inline(always)]
    fn transform_simd<const LANES: usize>(
        x: Simd<f32, LANES>,
        transform: ModulationTransformation,
        one: Simd<f32, LANES>,
    ) -> Simd<f32, LANES>
    where
        LaneCount<LANES>: SupportedLaneCount,
    {
        match transform {
            ModulationTransformation::None => x,
            ModulationTransformation::Invert => one - x,
            ModulationTransformation::Square => x * x,
            ModulationTransformation::Cube => x * x * x,
        }
    }

    // Scalar version of the transformation.
    #[inline(always)]
    fn transform_scalar(x: f32, transform: ModulationTransformation) -> f32 {
        match transform {
            ModulationTransformation::None => x,
            ModulationTransformation::Invert => 1.0 - x,
            ModulationTransformation::Square => x * x,
            ModulationTransformation::Cube => x * x * x,
        }
    }

    // Generic SIMD loop helper that processes LANES samples at a time,
    // then processes any remainder scalarly.
    #[inline(always)]
    fn simd_process<const LANES: usize, F, FS>(
        source: &[f32],
        target: &mut [f32],
        amt: f32,
        transform: ModulationTransformation,
        update: F,
        update_scalar: FS,
    ) where
        F: Fn(Simd<f32, LANES>, Simd<f32, LANES>, Simd<f32, LANES>) -> Simd<f32, LANES>,
        FS: Fn(f32, f32, f32) -> f32,
        LaneCount<LANES>: SupportedLaneCount,
    {
        let simd_amt = Simd::<f32, LANES>::splat(amt);
        let simd_one = Simd::<f32, LANES>::splat(1.0);

        for (src_chunk, tgt_chunk) in source
            .chunks_exact(LANES)
            .zip(target.chunks_exact_mut(LANES))
        {
            let src = Simd::<f32, LANES>::from_slice(src_chunk);
            let weighted = Self::transform_simd(src, transform, simd_one) * simd_amt;
            let mut tgt = Simd::<f32, LANES>::from_slice(tgt_chunk);
            tgt = update(tgt, weighted, simd_one);
            tgt_chunk.copy_from_slice(&tgt.to_array());
        }

        // Process the remainder scalarly.
        let remainder = source.chunks_exact(LANES).remainder();
        let start = source.len() - remainder.len();
        for i in 0..remainder.len() {
            let s = source[start + i];
            let weighted = Self::transform_scalar(s, transform) * amt;
            target[start + i] = update_scalar(target[start + i], weighted, 1.0);
        }
    }

    // Optimized modulation helper functions.
    #[inline(always)]
    fn apply_mul(
        source: &[f32],
        target: &mut [f32],
        amt: f32,
        transform: ModulationTransformation,
    ) {
        Self::simd_process::<4, _, _>(
            source,
            target,
            amt,
            transform,
            |t, w, _one| t * w,
            |t, w, _one| t * w,
        );
    }

    #[inline(always)]
    fn apply_bipolar(
        source: &[f32],
        target: &mut [f32],
        amt: f32,
        transform: ModulationTransformation,
    ) {
        Self::simd_process::<4, _, _>(
            source,
            target,
            amt,
            transform,
            |t, w, one| t * (one + w),
            |t, w, one| t * (one + w),
        );
    }

    #[inline(always)]
    fn apply_add(
        source: &[f32],
        target: &mut [f32],
        amt: f32,
        transform: ModulationTransformation,
    ) {
        Self::simd_process::<4, _, _>(
            source,
            target,
            amt,
            transform,
            |t, w, _one| t + w,
            |t, w, _one| t + w,
        );
    }
}
