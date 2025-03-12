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

    // SIMD transformation function remains unchanged.
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

    // Unsafe SIMD loop that uses pointer arithmetic and replaces write_to_slice with copy_from_slice.
    #[inline(always)]
    unsafe fn simd_process_unchecked<const LANES: usize, F, FS>(
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
        let len = source.len();
        let chunks = len / LANES;
        let remainder = len % LANES;

        let src_ptr = source.as_ptr();
        let tgt_ptr = target.as_mut_ptr();

        for i in 0..chunks {
            let offset = i * LANES;
            let src_chunk = std::slice::from_raw_parts(src_ptr.add(offset), LANES);
            let tgt_chunk = std::slice::from_raw_parts_mut(tgt_ptr.add(offset), LANES);
            let src_simd = Simd::<f32, LANES>::from_slice(src_chunk);
            let weighted = Self::transform_simd(src_simd, transform, simd_one) * simd_amt;
            let mut tgt_simd = Simd::<f32, LANES>::from_slice(tgt_chunk);
            tgt_simd = update(tgt_simd, weighted, simd_one);
            // Replace write_to_slice with a conversion to array and copy_from_slice.
            tgt_chunk.copy_from_slice(&tgt_simd.to_array());
        }

        // Process any remaining elements scalarly.
        if remainder > 0 {
            let start = len - remainder;
            for i in 0..remainder {
                let s = *src_ptr.add(start + i);
                let weighted = Self::transform_scalar(s, transform) * amt;
                let old = *tgt_ptr.add(start + i);
                *tgt_ptr.add(start + i) = update_scalar(old, weighted, 1.0);
            }
        }
    }

    // Safe wrapper that calls the unsafe version.
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
        unsafe {
            Self::simd_process_unchecked::<LANES, F, FS>(
                source,
                target,
                amt,
                transform,
                update,
                update_scalar,
            )
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
