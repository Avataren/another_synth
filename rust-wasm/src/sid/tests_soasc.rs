//! The measured 6581 profiles, `R3` and `R4` (SOASC real-chip recordings,
//! `.ai/sid-soasc/NOTES.md`): their cutoff curves and the per-profile
//! ceiling that lets them open past GoatTracker's 4 kHz.

use super::filter::{cutoff_hz_6581_with, CUTOFF_CEILING_DELTA_HZ};
use super::revision::{DieRevision, RevisionProfile, GT_REF, R3, R4, R4AR};
use super::*;

/// Cutoff at FC_HI `hi` with FC_LO 0, the register SIDBENCH swept.
fn at_hi(p: &RevisionProfile, hi: u16) -> f64 {
    cutoff_hz_6581_with(p, hi << 3)
}

#[test]
fn r3_and_r4_are_revisions_a_chip_can_take() {
    assert_eq!(DieRevision::R3.profile(), &R3);
    assert_eq!(DieRevision::R4.profile(), &R4);
    assert_eq!(R3.revision, DieRevision::R3);
    assert_eq!(R4.revision, DieRevision::R4);
    let c = Chip::with_profile(SidModel::Sid6581, DEFAULT_SAMPLE_RATE, &R3).unwrap();
    assert_eq!(c.filter().cutoff(), cutoff_hz_6581_with(&R3, 0));
}

#[test]
fn r4_hits_the_sidbench_measurement() {
    // LP/HP crossover of SOASC's R4 sweeps, median of three voices, Hz.
    // The anchors are a smoothed fit: within 10% of each raw point.
    for (hi, hz) in [(14u16, 297.0), (62, 294.0), (110, 452.0), (146, 1_193.0), (170, 3_689.0), (194, 8_276.0), (218, 13_196.0)] {
        let got = at_hi(&R4, hi);
        assert!((got / hz - 1.0).abs() < 0.10, "FC_HI {hi}: {got} vs {hz}");
    }
}

#[test]
fn measured_curves_rise_without_the_step_at_0x400() {
    for p in [&R3, &R4] {
        let mut last = 0.0;
        for reg in 0..0x800u16 {
            let hz = cutoff_hz_6581_with(p, reg);
            assert!(hz >= last * 0.995, "{:?} reg {reg:#05x}: {hz} after {last}", p.revision);
            last = hz;
        }
    }
}

#[test]
fn r3_is_r4_shifted_brighter_by_880() {
    // R3's fit: R4's curve read 880 register steps higher. Checked where both
    // are inside the measured range, allowing the anchors' interpolation.
    for reg in (0..0x480u16).step_by(0x20) {
        let want = cutoff_hz_6581_with(&R4, reg + 880);
        let got = cutoff_hz_6581_with(&R3, reg);
        assert!((got / want - 1.0).abs() < 0.10, "reg {reg:#05x}: {got} vs {want}");
    }
    // The order the recordings showed at every register: R4 darkest, R3 brightest.
    for reg in (0x100..0x400u16).step_by(0x40) {
        assert!(cutoff_hz_6581_with(&R3, reg) > cutoff_hz_6581_with(&R4, reg) * 2.0, "reg {reg:#05x}");
    }
}

#[test]
fn only_the_measured_profiles_open_past_the_gt_ceiling() {
    let top = |m, p| {
        let mut c = Chip::with_profile(m, DEFAULT_SAMPLE_RATE, p).unwrap();
        c.write(0x15, 0x07);
        c.write(0x16, 0xFF);
        c.filter().effective_cutoff()
    };
    for p in [&GT_REF, &R4AR] {
        assert_eq!(p.cutoff_ceiling_hz, CUTOFF_CEILING_DELTA_HZ);
        assert_eq!(top(SidModel::Sid6581, p), CUTOFF_CEILING_DELTA_HZ);
    }
    for p in [&R3, &R4] {
        assert_eq!(p.cutoff_ceiling_hz, f64::INFINITY);
        let want = cutoff_hz_6581_with(p, 0x7FF).min(DEFAULT_SAMPLE_RATE * 0.49);
        assert_eq!(top(SidModel::Sid6581, p), want);
        assert!(want > 15_000.0);
    }
    // The 8580 keeps the ceiling whatever profile the chip was built with.
    assert_eq!(top(SidModel::Sid8580, &R3), CUTOFF_CEILING_DELTA_HZ);
}

#[test]
fn measured_profiles_take_everything_but_the_cutoff_from_gt_ref() {
    for p in [&R3, &R4] {
        assert_eq!(p.resonance, GT_REF.resonance);
        assert_eq!(p.sat, GT_REF.sat);
        assert_eq!(p.gain_trim, GT_REF.gain_trim);
        assert_eq!(p.volume_bit_weights, GT_REF.volume_bit_weights);
        assert_eq!(p.voice_dc, GT_REF.voice_dc);
        assert_eq!(p.mix_dc, GT_REF.mix_dc);
    }
}
