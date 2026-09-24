//! 8580 filter: a zero-delay-feedback (topology-preserving transform)
//! state-variable filter at the output sample rate. 2 poles, 12 dB/oct LP/HP,
//! 6 dB/oct BP; the three taps are summed per the mode bits ($D418 bits 4-6).
//!
//! Sources (GPL-free): MOS 6581/8580 datasheet (12 dB/oct LP/HP, 6 dB/oct BP
//! from one filter, 30 Hz..12 kHz cutoff range, 4-bit resonance, summable
//! modes); public descriptions of the 8580 filter as near-linear with
//! clean, moderate, non-self-oscillating resonance.
//!
//! Why an SVF (kept from the accepted S0 spike): the SID filter is a
//! two-integrator-loop state-variable filter. Its LP/BP/HP taps and
//! resonance-by-damping are the datasheet's modes exactly, and summing the
//! taps gives the notch (LP+HP) and the other combinations for free. TPT is
//! stable for any cutoff below Nyquist and keeps the resonance peak in
//! place at high cutoffs, which a naive Chamberlin SVF does not. On the
//! plan's "3-pole" wording, see `.ai/sid-voice-core-verdict.md`: the
//! datasheet's slopes fix 2 poles, and no third pole is added.
//!
//! Register maps (8580): both are INFERRED tuning choices, not
//! measurements. They are carried unchanged from S0 and are ears-gate items.
//! - Cutoff: 11-bit register (FC_LO bits 0-2, FC_HI bits 0-7). The 8580 curve
//!   is documented as near-linear over the datasheet range, so
//!   fc = 30 + reg * (12000 - 30) / 2047 Hz (5.85 Hz per step).
//! - Resonance: Q = 0.707 * 2^(res / 8). Butterworth at 0, +8.3 dB peak at 15.
//! - Ceiling (S5.12, both models): `Filter::set` clamps the mapped cutoff to
//!   4 kHz, the limit GoatTracker 2's reSID playback applies
//!   (`CUTOFF_CEILING_DELTA_HZ`). The maps themselves stay unclamped.
//! Linear: no saturation. The 8580 is "clean", not perfectly so.
//!
//! 6581 (S2, plan §1.2 "static nonlinear remap of the cutoff register +
//! level-dependent peak gain"). Same SVF, same taps, same mode bits; three
//! things differ, all gated on `SidModel::Sid6581`:
//! - Cutoff map (S5.16; the S5.12 log-linear anchor chords replaced). Public
//!   knowledge (C64 community measurements of many chips): the 6581 cutoff is
//!   strongly nonlinear in the register. The bottom of the range barely
//!   moves and the floor sits in the low hundreds of Hz rather than at the
//!   datasheet's 30 Hz. It also varies a lot from chip to chip. The
//!   measured curve's landmarks: FC_HI bit 7 has its own DAC weight, so the
//!   curve steps DOWN from ~6 kHz at 0x3FF to ~4.6 kHz at 0x400 and then
//!   rises again to 18 kHz. Modelled (S5.16) as a drive-segmented map: the
//!   register drives the kinked 11-bit f0 DAC of the measured R4AR
//!   parameter set (2R/R 2.20, no bit-0 termination), whose output biases
//!   the filter VCRs; between the 8 measured anchors the VCR square law is
//!   fitted to each anchor pair, so every anchor is hit exactly and the
//!   DAC's real bit-boundary discontinuities (~6% dips from 0x10 up,
//!   including the $7F -> $80 step) survive the map. See the disclosure at
//!   `cutoff_hz_6581_driven` and `CUTOFF_ANCHORS_6581_LO`. The old map was
//!   2-3x too dark across FC_HI $50-$7F (report §6.3). Ears-gate.
//! - Resonance map: Q = 0.707 * 2^(res / 12) (Butterworth at 0, Q 1.68 =
//!   +4.5 dB at 15). INFERRED from the public description of the 6581's
//!   resonance as clearly weaker and rounder than the 8580's; the exponent
//!   is a tuning guess. Ears-gate.
//! - Level-dependent peak gain. The 6581 filter's integrators are not
//!   linear at the levels real mixes drive them to (public: the "gritty",
//!   distorting 6581 filter, strongest at high resonance and with several
//!   voices filtered). Modelled as a soft limit on the band-pass
//!   integrator state after each update:
//!     s1 <- SAT * tanh(s1 / SAT)
//!   Small signals are untouched (tanh(u) = u - u^3/3 + ...: the relative
//!   change is ~u^2/3, under 1e-3 for states below 0.05), so the
//!   small-signal peak is still Q.
//!   At full level the band-pass state is clamped below SAT, the resonant
//!   peak compresses and the output picks up odd harmonics. The band-pass
//!   state carries no DC, so the 6581's DC offsets (`voice.rs`) do not bias
//!   it. INFERRED: the placement (one limiter on the resonant state) and
//!   SAT = 1.0 (one full-scale voice) are tuning choices. Ears-gate.
//!   Not modelled: the real filter's input-dependent cutoff shift. The plan
//!   approximates it by the static remap, which is what this is.

use super::revision::{profile_6581, RevisionProfile};
use super::SidModel;
use std::f64::consts::PI;

/// Mode bits of $D418.
pub const LP: u8 = 0x10;
pub const BP: u8 = 0x20;
pub const HP: u8 = 0x40;

/// 8580 cutoff register -> Hz.
pub fn cutoff_hz(reg: u16) -> f64 {
    30.0 + (reg & 0x7FF) as f64 * (12_000.0 - 30.0) / 2047.0
}

/// 8580 resonance nibble -> Q.
pub fn resonance_q(res: u8) -> f64 {
    0.707 * 2f64.powf((res & 0xF) as f64 / 8.0)
}

/// 6581 cutoff floor (register 0), Hz.
pub const F_LO_6581: f64 = CUTOFF_ANCHORS_6581_LO[0].1;
/// Soft limit of the 6581 band-pass state (one full-scale voice). INFERRED.
pub const SAT_6581: f64 = 1.0;

/// 6581 cutoff anchors (register, Hz), low piece: registers 0..=0x3FF
/// (FC_HI bit 7 clear).
///
/// MEASURED-VALUE DISCLOSURE (S5.12 R2, extended S5.16).
/// - Measured facts (SPEC): every anchor is a figure quoted in
///   `.ai/sid-chip-comparison-report.md` §6.3 and the S5.12 brief, which
///   summarise the published 6581 cutoff measurements (Antti Lankila's
///   6581 filter / cutoff measurement write-ups, bel.fi/~ankila/, as cited
///   in the brief): ~420 Hz at 0x200, ~1.6 kHz at 0x300, ~6 kHz at 0x3FF,
///   a step DOWN to ~4.6 kHz at 0x400 (FC_HI $7F -> $80), ~9.5 kHz at
///   0x500, ~14.5 kHz at 0x600, 220 Hz at 0 and 18 kHz at 0x7FF (the
///   published range of the nominal curve). Since S5.16 these anchors are
///   hit EXACTLY by the drive-segmented map below (the old log-linear
///   chords passed them only within ±5%).
/// - S5.15: the anchors are revision data and live in the 6581 revision
///   profile (`revision::R4AR`, inherited by `R3`).
pub const CUTOFF_ANCHORS_6581_LO: [(u16, f64); 4] = profile_6581().cutoff_anchors_lo;
/// 6581 cutoff anchors, high piece: registers 0x400..=0x7FF (FC_HI bit 7
/// set). Disclosure at `CUTOFF_ANCHORS_6581_LO`.
pub const CUTOFF_ANCHORS_6581_HI: [(u16, f64); 4] = profile_6581().cutoff_anchors_hi;

/// 6581 cutoff register -> Hz, S5.16: the measured anchors hit exactly by
/// a drive-segmented map.
///
/// - The register drives the kinked 11-bit f0 DAC (`f0_dac_11`), whose
///   output voltage biases the filter's VCRs; the drive is the squared
///   excess over VCR threshold + voice DC (`drive_sq`).
/// - Between two measured anchors the map is the VCR square law fitted to
///   that anchor pair: fc = f0 + a*(drive(reg) - drive(r0)), a chosen so
///   the segment ENDS exactly on the measured pair. Every anchor is hit
///   exactly (the old log-linear chords passed them only within ±5%).
/// - The kinked DAC's own discontinuities survive: the map dips where the
///   DAC dips (~6% at each FC_HI bit boundary from 0x10 up, including
///   0x400), and the measured 6000 -> 4600 Hz drop at $7F -> $80 is the
///   anchor pair itself.
/// - Derived (ears-gate): the within-segment curvature and the dip
///   magnitudes between anchors. Only the 8 anchors are measurements; the
///   old log-linear map was equally derived between them. The pure
///   drive-law curve WITHOUT per-segment fitting misfits the measured
///   middle anchors by 2-3x (verdict: the static map's chip-variant
///   spread is not reproducible from one parameter set), so the anchors
///   stay the calibration skeleton.
pub fn cutoff_hz_6581(reg: u16) -> f64 {
    cutoff_hz_6581_driven(reg)
}

/// Bits of the 11-bit f0 DAC ($D415/$D416). Structural, not revision data.
pub const F0_DAC_BITS: u32 = 11;

/// Raw sum of the kinked f0 DAC's set-bit contributions for register
/// `reg`, in units of the full bit voltage (re-derived circuit math; SPEC
/// parameters, GPL structure not copied). The ladder sums to 1.0000 at
/// all bits set with the adopted 2.20/no-termination parameters.
fn f0_dac_raw(profile: &RevisionProfile, reg: u16) -> f64 {
    let r = 1.0;
    let r2 = profile.f0_dac_2r_div_r * r;
    let mut acc = 0.0;
    for bit in 0..F0_DAC_BITS {
        if reg >> bit & 1 == 0 {
            continue;
        }
        // Tail resistance from bit `bit` down to bit 0: repeated
        // parallel substitution along the R line. Without the bit-0
        // termination the tail starts open.
        let mut tail = if profile.f0_dac_terminated { r2 } else { f64::INFINITY };
        for _ in 0..bit {
            tail = if tail.is_infinite() {
                r + r2
            } else {
                r + r2 * tail / (r2 + tail)
            };
        }
        // Source transformation of (bit voltage, tail) onto the 2R branch.
        let (mut v, mut r_out) = if tail.is_infinite() {
            // Open tail: the full bit voltage drives the branch.
            (1.0, r2)
        } else {
            let r_par = r2 * tail / (r2 + tail);
            (r_par / r2, r_par)
        };
        // Walk the output line up to the top bit.
        for _ in bit + 1..F0_DAC_BITS {
            r_out += r;
            let i = v / r_out;
            r_out = r2 * r_out / (r2 + r_out);
            v = r_out * i;
        }
        acc += v;
    }
    acc
}

/// Output of the 6581 family's kinked 11-bit f0 DAC for register `reg`,
/// normalized so the all-bits-set value reads exactly 2047 (the adopted
/// parameters sum to 1.0, so this is also the reference engine's integer
/// scale).
///
/// SPEC values: an R-2R ladder whose 2R/R ratio is the profile's
/// `f0_dac_2r_div_r` (2.20, measured 6581R4AR), the bit-0 2R termination
/// missing (all 6581 DACs), bit 0 at the unterminated end. Per-bit
/// effective weights, normalized to bit 0: [1.0000, 1.4545, 2.5702,
/// 4.8542, ...] — the published figures (the "kink": upper bits weigh
/// relatively less than a factor of 2, converging to a factor of ~1.94).
pub fn f0_dac_11(profile: &RevisionProfile, reg: u16) -> f64 {
    2047.0 * f0_dac_raw(profile, reg) / f0_dac_raw(profile, (1 << F0_DAC_BITS) - 1)
}

/// DAC output voltage for register `reg`: bias + scale over the 11-bit
/// range (SPEC: 6.65 V at register 0, 2.63 V full scale).
fn f0_dac_vw(profile: &RevisionProfile, reg: u16) -> f64 {
    profile.f0_dac_zero + profile.f0_dac_scale * f0_dac_11(profile, reg) / 2048.0
}

/// Squared VCR drive for register `reg`: the excess of the DAC voltage
/// over the VCR threshold plus the voice DC the integrator rides at.
/// In the VCR's triode/strong-inversion region the integrator's cutoff
/// is proportional to this square (w0 ~ Ids/C, Ids ~ (Vg - Vt - Vx)^2).
fn drive_sq(profile: &RevisionProfile, reg: u16) -> f64 {
    let x = f0_dac_vw(profile, reg) - profile.vcr_vth - profile.vcr_vx;
    x * x
}

/// 6581 cutoff register -> Hz, S5.16: the measured anchors hit exactly by
/// a drive-segmented map.
///
/// - The register drives the kinked 11-bit f0 DAC (`f0_dac_11`), whose
///   output voltage biases the filter's VCRs; the drive is the squared
///   excess over VCR threshold + voice DC (`drive_sq`).
/// - Between two measured anchors the map is the VCR square law fitted to
///   that anchor pair: fc = f0 + a*(drive(reg) - drive(r0)), a chosen so
///   the segment ENDS exactly on the measured pair. Every anchor is hit
///   exactly (the old log-linear chords passed them only within ±5%).
/// - The kinked DAC's own discontinuities survive: the map dips where the
///   DAC dips (~6% at each FC_HI bit boundary from 0x10 up, including
///   0x400), and the measured 6000 -> 4600 Hz drop at $7F -> $80 is the
///   anchor pair itself.
/// - Derived (ears-gate): the within-segment curvature and the dip
///   magnitudes between anchors. Only the 8 anchors are measurements; the
///   old log-linear map was equally derived between them. The pure
///   drive-law curve WITHOUT per-segment fitting misfits the measured
///   middle anchors by 2-3x (verdict: the static map's chip-variant
///   spread is not reproducible from one parameter set), so the anchors
///   stay the calibration skeleton.
pub fn cutoff_hz_6581_driven(reg: u16) -> f64 {
    let profile = profile_6581();
    let reg = reg & 0x7FF;
    let piece = if reg < 0x400 {
        &profile.cutoff_anchors_lo
    } else {
        &profile.cutoff_anchors_hi
    };
    for pair in piece.windows(2) {
        let (r0, f0) = pair[0];
        let (r1, f1) = pair[1];
        if reg <= r1 {
            if reg == r1 {
                return f1;
            }
            let x0 = drive_sq(profile, r0);
            let x1 = drive_sq(profile, r1);
            let a = (f1 - f0) / (x1 - x0);
            return f0 + a * (drive_sq(profile, reg) - x0);
        }
    }
    piece[piece.len() - 1].1
}

/// 6581 resonance nibble -> Q.
pub fn resonance_q_6581(res: u8) -> f64 {
    0.707 * 2f64.powf((res & 0xF) as f64 / 12.0)
}

/// Effective cutoff ceiling, Hz, both models (S5.12). GoatTracker 2 plays
/// through classic reSID in its delta-clock mode (default SAMPLE_FAST,
/// gsound.c:216 -> gsid.cpp:77-80), where reSID limits the filter cutoff to
/// 4 kHz (reSID filter.cpp:259-265, applied via filter.h:461); GT2 songs
/// were mixed by ear against it. The value is that ceiling, a fact read from
/// the cited code's behaviour; no GPL text copied. The maps above stay
/// unclamped; only `Filter::set` applies it.
pub const CUTOFF_CEILING_DELTA_HZ: f64 = 4000.0;

/// Cutoff map of `model`.
pub fn cutoff_hz_for(model: SidModel, reg: u16) -> f64 {
    match model {
        SidModel::Sid8580 => cutoff_hz(reg),
        SidModel::Sid6581 => cutoff_hz_6581(reg),
    }
}

/// Resonance map of `model`.
pub fn resonance_q_for(model: SidModel, res: u8) -> f64 {
    match model {
        SidModel::Sid8580 => resonance_q(res),
        SidModel::Sid6581 => resonance_q_6581(res),
    }
}

#[derive(Debug, Clone, Copy)]
pub struct Filter {
    s1: f64,
    s2: f64,
    g: f64,
    k: f64,
    h: f64,
    fc: f64,
    cutoff_reg: u16,
    res: u8,
    mode: u8,
    sample_rate: f64,
    model: SidModel,
}

impl Filter {
    /// An 8580 filter.
    pub fn new(sample_rate: f64) -> Self {
        Filter::with_model(SidModel::Sid8580, sample_rate)
    }

    /// A filter with `model`'s maps and (6581) its saturating resonance.
    pub fn with_model(model: SidModel, sample_rate: f64) -> Self {
        let mut f = Filter {
            s1: 0.0,
            s2: 0.0,
            g: 0.0,
            k: 0.0,
            h: 0.0,
            fc: 0.0,
            cutoff_reg: 0,
            res: 0,
            mode: 0,
            sample_rate,
            model,
        };
        f.set(0, 0);
        f
    }

    pub fn model(&self) -> SidModel {
        self.model
    }

    /// The current cutoff in Hz from this model's map (before the 4 kHz
    /// ceiling and the 0.49 * sample-rate clamp).
    pub fn cutoff(&self) -> f64 {
        cutoff_hz_for(self.model, self.cutoff_reg)
    }

    /// The cutoff in Hz the coefficients were computed for: the map, then
    /// `CUTOFF_CEILING_DELTA_HZ`, then 0.49 * sample rate.
    pub fn effective_cutoff(&self) -> f64 {
        self.fc
    }

    /// The current Q from this model's resonance map.
    pub fn q(&self) -> f64 {
        resonance_q_for(self.model, self.res)
    }

    pub fn cutoff_reg(&self) -> u16 {
        self.cutoff_reg
    }

    pub fn resonance(&self) -> u8 {
        self.res
    }

    pub fn mode(&self) -> u8 {
        self.mode
    }

    /// Mode bits (LP/BP/HP); other bits are ignored.
    pub fn set_mode(&mut self, mode: u8) {
        self.mode = mode & (LP | BP | HP);
    }

    /// Set cutoff register and resonance nibble; recomputes coefficients.
    pub fn set(&mut self, cutoff_reg: u16, res: u8) {
        self.cutoff_reg = cutoff_reg & 0x7FF;
        self.res = res & 0xF;
        let fc = self.cutoff().min(CUTOFF_CEILING_DELTA_HZ).min(self.sample_rate * 0.49);
        self.fc = fc;
        self.g = (PI * fc / self.sample_rate).tan();
        self.k = 1.0 / self.q();
        self.h = 1.0 / (1.0 + self.g * (self.g + self.k));
    }

    /// One sample in, the selected sum of LP/BP/HP out. With no mode bit set
    /// the output is silent (the datasheet: filtered voices then vanish).
    #[inline]
    pub fn process(&mut self, x: f64) -> f64 {
        let hp = (x - (self.k + self.g) * self.s1 - self.s2) * self.h;
        let v1 = self.g * hp;
        let bp = v1 + self.s1;
        self.s1 = bp + v1;
        if self.model == SidModel::Sid6581 {
            self.s1 = SAT_6581 * (self.s1 / SAT_6581).tanh();
        }
        let v2 = self.g * bp;
        let lp = v2 + self.s2;
        self.s2 = lp + v2;
        let mut y = 0.0;
        if self.mode & LP != 0 {
            y += lp;
        }
        if self.mode & BP != 0 {
            y += bp;
        }
        if self.mode & HP != 0 {
            y += hp;
        }
        y
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SR: f64 = 44_100.0;

    /// Steady-state gain of a sine at `hz` through the selected mode.
    fn sine_gain(mode: u8, cutoff: u16, res: u8, hz: f64) -> f64 {
        let mut f = Filter::new(SR);
        f.set_mode(mode);
        f.set(cutoff, res);
        let n = 44_100;
        let mut peak: f64 = 0.0;
        for i in 0..n {
            let y = f.process((2.0 * PI * hz * i as f64 / SR).sin());
            if i > n / 2 {
                peak = peak.max(y.abs());
            }
        }
        peak
    }

    #[test]
    fn register_maps() {
        assert_eq!(cutoff_hz(0), 30.0);
        assert!((cutoff_hz(0x7FF) - 12_000.0).abs() < 1e-9);
        assert_eq!(cutoff_hz(0x800), cutoff_hz(0)); // 11 bits only
        assert!((resonance_q(0) - 0.707).abs() < 1e-12);
        assert!((resonance_q(8) - 1.414).abs() < 1e-12);
        for r in 0..15 {
            assert!(resonance_q(r + 1) > resonance_q(r));
        }
    }

    #[test]
    fn effective_cutoff_has_gts_4_khz_delta_mode_ceiling_on_both_models() {
        // GT2 plays through reSID in its delta-clock mode, which limits the
        // cutoff to 4 kHz; the maps stay unclamped (register_maps and
        // map_6581_endpoints pin 12 kHz / 18 kHz at 0x7FF).
        for model in [SidModel::Sid8580, SidModel::Sid6581] {
            for sr in [44_100.0, 48_000.0] {
                let mut f = Filter::with_model(model, sr);
                f.set(0x7FF, 0);
                assert_eq!(f.effective_cutoff(), 4000.0, "{model:?} sr {sr} reg 0x7FF");
                assert!(f.cutoff() > 4000.0, "{model:?}: the map itself is unclamped");
                // First register whose map exceeds 4 kHz clamps; below passes.
                let over = (0..=0x7FFu16).find(|&r| cutoff_hz_for(model, r) > 4000.0).unwrap();
                f.set(over, 0);
                assert_eq!(f.effective_cutoff(), 4000.0, "{model:?} reg {over:#x}");
                f.set(over - 1, 0);
                assert_eq!(f.effective_cutoff(), cutoff_hz_for(model, over - 1), "{model:?} reg {:#x}", over - 1);
            }
        }
    }

    #[test]
    fn impulse_response_is_stable_and_decays_for_every_setting() {
        for sr in [44_100.0, 48_000.0] {
            for cutoff in [0u16, 100, 1024, 2047] {
                for res in 0..16u8 {
                    let mut f = Filter::new(sr);
                    f.set_mode(LP | BP | HP);
                    f.set(cutoff, res);
                    f.process(1.0);
                    let mut tail: f64 = 0.0;
                    for i in 0..200_000 {
                        let y = f.process(0.0);
                        assert!(y.is_finite());
                        if i > 190_000 {
                            tail = tail.max(y.abs());
                        }
                    }
                    assert!(tail < 1e-9, "sr {sr} cutoff {cutoff} res {res}: {tail}");
                }
            }
        }
    }

    #[test]
    fn step_response_settles_to_unity_dc_gain() {
        let mut f = Filter::new(SR);
        f.set_mode(LP);
        f.set(0x200, 15);
        let ys: Vec<f64> = (0..44_100).map(|_| f.process(1.0)).collect();
        let overshoot = ys.iter().fold(0.0f64, |m, &y| m.max(y));
        assert!((ys[ys.len() - 1] - 1.0).abs() < 1e-6);
        assert!(overshoot > 1.2, "{overshoot}");
        let mut f = Filter::new(SR);
        f.set_mode(LP);
        f.set(0x200, 0);
        let mut ov0: f64 = 0.0;
        for _ in 0..44_100 {
            ov0 = ov0.max(f.process(1.0));
        }
        assert!(ov0 < 1.06, "{ov0}"); // analog Butterworth: 4.3 %
    }

    #[test]
    fn resonance_peak_grows_with_the_register() {
        // |H_LP(fc)| = Q for the analog SVF; the prewarped TPT keeps fc exact.
        let reg = 0x155; // ~2 kHz
        let fc = cutoff_hz(reg);
        let mut last = 0.0;
        for res in 0..16u8 {
            let g = sine_gain(LP, reg, res, fc);
            assert!(g > last, "res {res}: {g} <= {last}");
            assert!((g / resonance_q(res) - 1.0).abs() < 0.02, "res {res}: {g}");
            last = g;
        }
    }

    #[test]
    fn slopes_are_twelve_and_six_db_per_octave() {
        // Two octaves above/below fc the asymptotes hold within 1.5 dB.
        let reg = 0x80; // ~780 Hz
        let fc = cutoff_hz(reg);
        let lp = 20.0 * (sine_gain(LP, reg, 0, fc * 4.0) / sine_gain(LP, reg, 0, fc * 8.0)).log10();
        assert!((lp - 12.0).abs() < 1.5, "LP {lp} dB/oct");
        let reg = 0x400; // ~6 kHz, so fc/8 is well above the DC region
        let fc = cutoff_hz(reg);
        let hp = 20.0 * (sine_gain(HP, reg, 0, fc / 4.0) / sine_gain(HP, reg, 0, fc / 8.0)).log10();
        assert!((hp - 12.0).abs() < 1.5, "HP {hp} dB/oct");
        let bp = 20.0 * (sine_gain(BP, reg, 0, fc / 4.0) / sine_gain(BP, reg, 0, fc / 8.0)).log10();
        assert!((bp - 6.0).abs() < 1.0, "BP {bp} dB/oct");
    }

    #[test]
    fn no_mode_bit_is_silent_and_lp_plus_hp_notches() {
        let reg = 0x155;
        let fc = cutoff_hz(reg);
        assert_eq!(sine_gain(0, reg, 0, fc), 0.0);
        // LP + HP of an SVF is a notch at fc: 1 - k*BP -> 0 at fc.
        assert!(sine_gain(LP | HP, reg, 0, fc) < 0.01);
        assert!(sine_gain(LP | HP, reg, 0, fc / 8.0) > 0.95);
    }

    /// Steady-state gain of a sine of amplitude `amp` at `hz`, 6581 filter.
    fn sine_gain_6581(mode: u8, cutoff: u16, res: u8, hz: f64, amp: f64) -> f64 {
        let mut f = Filter::with_model(SidModel::Sid6581, SR);
        f.set_mode(mode);
        f.set(cutoff, res);
        let n = 44_100;
        let mut peak: f64 = 0.0;
        for i in 0..n {
            let y = f.process(amp * (2.0 * PI * hz * i as f64 / SR).sin());
            if i > n / 2 {
                peak = peak.max(y.abs());
            }
        }
        peak / amp
    }

    #[test]
    fn map_6581_endpoints_anchors_and_a_hand_point() {
        // Endpoints: 220 Hz floor at 0, 18 kHz at 0x7FF.
        assert!((cutoff_hz_6581(0) - 220.0).abs() < 1e-9);
        assert!((cutoff_hz_6581(0x7FF) - 18_000.0).abs() < 1e-6);
        assert_eq!(cutoff_hz_6581(0x800), cutoff_hz_6581(0)); // 11 bits only
        assert_eq!(cutoff_hz_6581(0xFFFF), cutoff_hz_6581(0x7FF));
        // Measured anchors, hit EXACTLY (S5.16: the drive-segmented map
        // ends every segment on the measured pair; the S5.12 log-linear
        // chords passed them only within ±5%).
        for (reg, want) in [
            (0x200u16, 420.0),
            (0x300, 1_600.0),
            (0x3FF, 6_000.0),
            (0x400, 4_600.0),
            (0x500, 9_500.0),
            (0x600, 14_500.0),
        ] {
            let got = cutoff_hz_6581(reg);
            assert!(
                (got - want).abs() < 1e-6,
                "reg {reg:#05x}: {got} Hz, want {want}"
            );
        }
        // Hand point, reg 0x280 (S5.16): the kinked-DAC-driven map puts it
        // at 985.861 Hz; the S5.12 log-linear chord had 819.756. The 8580
        // map still puts the same register at 30 + 640 * 5.84758 = 3772.45 Hz.
        assert!(
            (cutoff_hz_6581(0x280) - 985.860_948).abs() < 1e-3,
            "{}",
            cutoff_hz_6581(0x280)
        );
        assert!((cutoff_hz(0x280) - 3772.45).abs() < 0.01);
    }

    #[test]
    fn map_6581_follows_the_kinked_dac_and_keeps_the_fc_hi_step() {
        // S5.16: the map rises wherever the kinked f0 DAC rises and dips
        // where it dips (~6% at each FC_HI bit boundary from 0x10 up);
        // the measured $7F -> $80 drop (6000 -> 4600 Hz, -23%) is the
        // anchor pair itself. The S5.12 map was strictly monotonic per
        // piece — its per-piece monotonicity is superseded by the DAC's
        // real discontinuities (red record: checks-s516-red-1.txt).
        for r in 0..0x7FFu16 {
            if f0_dac_11(profile_6581(), r + 1) >= f0_dac_11(profile_6581(), r) {
                assert!(cutoff_hz_6581(r + 1) > cutoff_hz_6581(r), "reg {r:#05x}");
            }
        }
        assert!(cutoff_hz_6581(0x400) < cutoff_hz_6581(0x3FF) * 0.85);
        // Bottom quarter: the 6581 barely moves (220 -> ~420 Hz) where the
        // 8580 sweeps 30 -> ~3 kHz; the top ends 18 kHz vs 12 kHz.
        assert!(cutoff_hz_6581(0x200) / cutoff_hz_6581(0) < 2.0);
        assert!(cutoff_hz(0x200) / cutoff_hz(0) > 100.0);
        // Hand values: reg 0 -> 220 vs 30 (x7.3); 0x100 -> 298.6 vs 1527
        // (x5.1); 0x200 -> 420 vs 3024 (x7.2); 0x7FF -> 18000 vs 12000 (x1.5).
        for r in [0u16, 0x100, 0x200, 0x7FF] {
            let (a, b) = (cutoff_hz_6581(r), cutoff_hz(r));
            assert!((a / b).max(b / a) > 1.45, "reg {r}: 6581 {a} vs 8580 {b}");
        }
        assert_eq!(cutoff_hz_for(SidModel::Sid8580, 0x333), cutoff_hz(0x333));
        assert_eq!(cutoff_hz_for(SidModel::Sid6581, 0x333), cutoff_hz_6581(0x333));
    }

    #[test]
    fn resonance_6581_is_weaker_than_the_8580() {
        // Q = 0.707 * 2^(res/12): 0 -> 0.707, 12 -> 1.414, 15 -> 0.707 * 2^1.25
        // = 0.707 * 2.378414 = 1.681539. The 8580 reaches 2.6 at 15.
        assert!((resonance_q_6581(0) - 0.707).abs() < 1e-12);
        assert!((resonance_q_6581(12) - 1.414).abs() < 1e-12);
        assert!((resonance_q_6581(15) - 1.681539).abs() < 1e-6);
        for r in 1..16u8 {
            assert!(resonance_q_6581(r) > resonance_q_6581(r - 1));
            assert!(resonance_q_6581(r) < resonance_q(r));
        }
    }

    #[test]
    fn filter_6581_is_stable_even_when_overdriven() {
        for sr in [44_100.0, 48_000.0] {
            for cutoff in [0u16, 100, 1024, 2047] {
                for res in [0u8, 7, 15] {
                    for amp in [1.0, 10.0] {
                        let mut f = Filter::with_model(SidModel::Sid6581, sr);
                        f.set_mode(LP | BP | HP);
                        f.set(cutoff, res);
                        f.process(amp);
                        let mut tail: f64 = 0.0;
                        for i in 0..200_000 {
                            let y = f.process(0.0);
                            assert!(y.is_finite());
                            if i > 190_000 {
                                tail = tail.max(y.abs());
                            }
                        }
                        assert!(tail < 1e-9, "sr {sr} cutoff {cutoff} res {res} amp {amp}");
                    }
                }
            }
        }
    }

    #[test]
    fn filter_6581_small_signal_peak_is_q_and_compresses_with_level() {
        // Small signal: tanh is linear to ~u^2/3, so |H_LP(fc)| = Q within
        // the same 2 % the 8580 test uses. Reg 0x300 (~1.6 kHz) keeps the
        // map below the 4 kHz ceiling, so the probe sits on the real fc.
        let reg = 0x300;
        let fc = cutoff_hz_6581(reg);
        for res in [0u8, 8, 15] {
            let g = sine_gain_6581(LP, reg, res, fc, 0.01);
            assert!((g / resonance_q_6581(res) - 1.0).abs() < 0.02, "res {res}: {g}");
        }
        // Level-dependent peak gain: the band-pass state is clamped below
        // SAT = 1, so the resonant peak must fall as the level rises. At
        // amplitude 1 and Q 1.68 the linear state would reach ~Q; the limit
        // takes a clear bite. The 8580 stays linear at every level.
        let small = sine_gain_6581(LP, reg, 15, fc, 0.01);
        let full = sine_gain_6581(LP, reg, 15, fc, 1.0);
        let hot = sine_gain_6581(LP, reg, 15, fc, 3.0);
        assert!(full < small * 0.95, "{full} vs {small}");
        assert!(hot < full, "{hot} vs {full}");
        let lin_small = sine_gain(LP, 0x155, 15, cutoff_hz(0x155));
        let mut f = Filter::new(SR);
        f.set_mode(LP);
        f.set(0x155, 15);
        let mut peak: f64 = 0.0;
        for i in 0..44_100 {
            let y = f.process(3.0 * (2.0 * PI * cutoff_hz(0x155) * i as f64 / SR).sin());
            if i > 22_050 {
                peak = peak.max(y.abs());
            }
        }
        assert!((peak / 3.0 / lin_small - 1.0).abs() < 1e-9);
    }
}
