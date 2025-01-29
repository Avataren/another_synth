use crate::graph::ModulationType;
use std::simd::f32x4;

type ModulationFn = fn(&ModulationProcessor, &[f32], &[f32], f32x4, &mut [f32]);

pub struct ModulationProcessor {
    one: f32x4,
    vca_fn: ModulationFn,
    bipolar_fn: ModulationFn,
    additive_fn: ModulationFn,
    ring_fn: ModulationFn,
}

impl ModulationProcessor {
    pub fn new() -> Self {
        Self {
            one: f32x4::splat(1.0),
            vca_fn: Self::process_vca,
            bipolar_fn: Self::process_bipolar,
            additive_fn: Self::process_additive,
            ring_fn: Self::process_ring,
        }
    }

    #[inline(always)]
    pub fn get_processor_fn(&self, mod_type: ModulationType) -> ModulationFn {
        match mod_type {
            ModulationType::VCA => self.vca_fn,
            ModulationType::Bipolar => self.bipolar_fn,
            ModulationType::Additive => self.additive_fn,
            ModulationType::Ring => self.ring_fn,
        }
    }

    #[inline(always)]
    fn process_vca(
        _processor: &ModulationProcessor,
        carrier: &[f32],
        modulator: &[f32],
        amount: f32x4,
        output: &mut [f32],
    ) {
        for i in (0..carrier.len()).step_by(4) {
            let carrier_vec = f32x4::from_slice(&carrier[i..]);
            let modulator_vec = f32x4::from_slice(&modulator[i..]);
            let result = carrier_vec * modulator_vec * amount;
            result.copy_to_slice(&mut output[i..]);
        }
    }

    #[inline(always)]
    fn process_bipolar(
        processor: &ModulationProcessor,
        carrier: &[f32],
        modulator: &[f32],
        amount: f32x4,
        output: &mut [f32],
    ) {
        for i in (0..carrier.len()).step_by(4) {
            let carrier_vec = f32x4::from_slice(&carrier[i..]);
            let modulator_vec = f32x4::from_slice(&modulator[i..]);
            let result = carrier_vec * (processor.one + (modulator_vec * amount));
            result.copy_to_slice(&mut output[i..]);
        }
    }

    #[inline(always)]
    fn process_additive(
        _processor: &ModulationProcessor,
        carrier: &[f32],
        modulator: &[f32],
        amount: f32x4,
        output: &mut [f32],
    ) {
        for i in (0..carrier.len()).step_by(4) {
            let carrier_vec = f32x4::from_slice(&carrier[i..]);
            let modulator_vec = f32x4::from_slice(&modulator[i..]);
            let result = carrier_vec + (modulator_vec * amount);
            result.copy_to_slice(&mut output[i..]);
        }
    }

    #[inline(always)]
    fn process_ring(
        _processor: &ModulationProcessor,
        carrier: &[f32],
        modulator: &[f32],
        amount: f32x4,
        output: &mut [f32],
    ) {
        for i in (0..carrier.len()).step_by(4) {
            let carrier_vec = f32x4::from_slice(&carrier[i..]);
            let modulator_vec = f32x4::from_slice(&modulator[i..]);
            let result = carrier_vec * modulator_vec * amount;
            result.copy_to_slice(&mut output[i..]);
        }
    }
}
