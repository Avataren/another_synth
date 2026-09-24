//! S5.16 tests: DieRevision::R3 as the played 6581 revision (profile fully
//! inherited from R4AR) and the S5.16 cutoff map — the measured anchors hit
//! exactly, the kinked f0 DAC adopted and its discontinuities inherited.
//!
//! RED-FIRST record: on the fit_6581-lineage log-linear map the hand-point
//! and dip pins below fail (`checks-s516-red-*.txt`); the anchor and f0-DAC
//! pins pass against both maps by construction.

use super::filter;
use super::revision::{profile_6581, DieRevision, R3, R4AR, SID6581_REVISION};

#[test]
fn sid6581_plays_r3_and_r3_is_inherited_from_r4ar() {
    // The one swap point (Morten, S5.16: most real SID songs were written
    // for R3). R4AR stays intact and selectable.
    assert_eq!(SID6581_REVISION, DieRevision::R3);
    assert_eq!(profile_6581(), &R3);
    assert_eq!(DieRevision::R3.profile(), &R3);
    assert_eq!(R3.revision, DieRevision::R3);
    assert_eq!(DieRevision::R4AR.profile(), &R4AR);
    // S5.16 research found NO R3-specific measurement anywhere in the
    // public record (`.ai/sid-r3-research-notes.md`), so every field is
    // INHERITED: the discriminant is the only difference.
    assert_eq!(R3.cutoff_anchors_lo, R4AR.cutoff_anchors_lo);
    assert_eq!(R3.cutoff_anchors_hi, R4AR.cutoff_anchors_hi);
    assert!((R3.f0_dac_2r_div_r - R4AR.f0_dac_2r_div_r).abs() == 0.0);
    assert_eq!(R3.f0_dac_terminated, R4AR.f0_dac_terminated);
    assert!((R3.f0_dac_zero - R4AR.f0_dac_zero).abs() == 0.0);
    assert!((R3.f0_dac_scale - R4AR.f0_dac_scale).abs() == 0.0);
    assert!((R3.vcr_vth - R4AR.vcr_vth).abs() == 0.0);
    assert!((R3.vcr_vx - R4AR.vcr_vx).abs() == 0.0);
    assert_eq!(R3.volume_bit_weights, R4AR.volume_bit_weights);
    assert!((R3.voice_dc - R4AR.voice_dc).abs() == 0.0);
    assert!((R3.mix_dc - R4AR.mix_dc).abs() == 0.0);
}

#[test]
fn f0_dac_weights_are_the_published_kinked_ladder() {
    // SPEC (measured 6581R4AR parameter set): 2R/R = 2.20, no bit-0
    // termination. Per-bit effective weights normalized to bit 0 — the
    // published figures [1.000, 1.4545, 2.5702, 4.8542, ...] (the "kink"):
    // upper bits weigh relatively less than 2x, converging to ~1.94x.
    let p = profile_6581();
    let w = |reg: u16| filter::f0_dac_11(p, reg);
    assert_eq!(w(0), 0.0);
    assert_eq!(w(0x7FF), 2047.0);
    let w0 = w(1);
    for (bit, want) in [
        (1usize, 1.4545),
        (2, 2.5702),
        (3, 4.8542),
    ] {
        let got = w(1 << bit) / w0;
        assert!((got - want).abs() < 1e-3, "bit {bit}: {got} vs {want}");
    }
    // Converged kink factor for the top bits: 1.9387 (vs the ideal 2).
    let top = w(0x400) / w(0x200);
    assert!((top - 1.9387).abs() < 1e-3, "{top}");
}

#[test]
fn cutoff_map_hits_the_measured_anchors_exactly() {
    // SPEC: the S5.12 measured community figures are the calibration
    // skeleton; the S5.16 map passes through every one of them (the old
    // log-linear chords did only within ±5%).
    for &(reg, hz) in profile_6581().cutoff_anchors_lo.iter().chain(profile_6581().cutoff_anchors_hi.iter()) {
        assert!((filter::cutoff_hz_6581(reg) - hz).abs() < 1e-6, "reg {reg:#05x}");
    }
}

#[test]
fn cutoff_map_is_the_driven_map_in_production() {
    // The production path IS the drive-segmented map.
    for reg in [0u16, 1, 0x80, 0x1FF, 0x200, 0x280, 0x2FF, 0x300, 0x3F0, 0x3FF, 0x400, 0x480, 0x4F0, 0x500, 0x580, 0x600, 0x6FF, 0x700, 0x780, 0x7FF] {
        assert!(
            (filter::cutoff_hz_6581(reg) - filter::cutoff_hz_6581_driven(reg)).abs() < 1e-9,
            "reg {reg:#05x}"
        );
    }
}

#[test]
fn driven_map_hand_points() {
    // Computed from the adopted SPEC set (kinked DAC 2.20/no-term, bias
    // 6.65 V, scale 2.63 V, VCR threshold 1.31 V, voice DC 5.0 V) through
    // the per-segment VCR square law; see `.ai/sid-r3-verdict.md`.
    for (reg, want) in [
        (0x080u16, 254.027_473),
        (0x100, 298.623_915),
        (0x1FF, 439.874_569),
        (0x280, 985.860_948),
        (0x2FF, 1_688.847_821),
        (0x380, 3_599.873_601),
        (0x3F0, 5_655.837_039),
        (0x480, 7_011.225_292),
        (0x6FF, 16_188.546_615),
        (0x780, 16_977.678_206),
    ] {
        let got = filter::cutoff_hz_6581(reg);
        assert!((got - want).abs() < 1e-3, "reg {reg:#05x}: {got} vs {want}");
    }
}

#[test]
fn driven_map_inherits_the_kinked_dac_dips() {
    // The kinked DAC weighs each FC_HI bit under its ideal 2x, so the DAC
    // output DROPS at every bit boundary from 0x10 up (~6%); the map
    // inherits the dips. The measured $7F -> $80 drop (6000 -> 4600 Hz,
    // -23.3%) is the anchor pair itself. RED on the old map: it was
    // strictly monotonic within each piece, so 0x1FF -> 0x200 rose.
    let fc = filter::cutoff_hz_6581;
    assert!(fc(0x0FF) > fc(0x100), "{:#06x}", 0x100);
    assert!(fc(0x1FF) > fc(0x200), "{:#06x}", 0x200);
    assert!(fc(0x2FF) > fc(0x300), "{:#06x}", 0x300);
    assert!(fc(0x3FF) > fc(0x400), "{:#06x}", 0x400);
    // Magnitudes: ~4.5% at 0x200, ~5.3% at 0x300, the measured -23.3%
    // at $7F -> $80.
    assert!((fc(0x1FF) / fc(0x200) - 1.0).abs() > 0.03);
    assert!(fc(0x1FF) / fc(0x200) < 1.06, "{}", fc(0x1FF) / fc(0x200));
    assert!(fc(0x3FF) / fc(0x400) > 1.2, "{}", fc(0x3FF) / fc(0x400));
    // And wherever the kinked DAC does NOT regress, the map rises.
    let p = profile_6581();
    for r in 0..0x7FFu16 {
        if filter::f0_dac_11(p, r + 1) >= filter::f0_dac_11(p, r) {
            assert!(
                fc(r + 1) > fc(r),
                "reg {r:#05x}: DAC monotone but map dips, {} -> {}",
                fc(r),
                fc(r + 1)
            );
        }
    }
}

#[test]
fn driven_map_bottom_quarter_and_8580_contrast() {
    let fc = filter::cutoff_hz_6581;
    // Bottom quarter barely moves (measured anchors): 220 -> 420 Hz.
    assert!(fc(0x200) / fc(0) < 2.0);
    // vs the 8580's linear sweep: the 6581 is ~7x DARKER at 0, ~7x darker
    // at 0x200, and reaches higher at the top.
    for r in [0u16, 0x100, 0x200, 0x7FF] {
        let (a, b) = (fc(r), filter::cutoff_hz(r));
        assert!((a / b).max(b / a) > 1.45, "reg {r}: 6581 {a} vs 8580 {b}");
    }
    assert!(fc(0x200) / filter::cutoff_hz(0x200) < 1.0);
    // 11-bit wrap and the register clamp behaviour are unchanged.
    assert_eq!(fc(0x800), fc(0));
    assert_eq!(fc(0xFFFF), fc(0x7FF));
}
