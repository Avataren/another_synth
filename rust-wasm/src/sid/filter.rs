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
//! Register maps: both are INFERRED tuning choices, not measurements. They
//! are carried unchanged from S0 and are ears-gate items.
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
//! - Cutoff map. Public knowledge (C64 community measurements of many
//!   chips): the 6581 cutoff is strongly nonlinear in the register. The
//!   bottom of the range barely moves, the middle sweeps fast, the top
//!   flattens, and the floor sits in the low hundreds of Hz rather than at
//!   the datasheet's 30 Hz. It also varies a lot from chip to chip. The shape
//!   is modelled as a logistic curve in log-frequency, normalised to hit both
//!   endpoints exactly:
//!     x = reg / 2047,  sig(u) = 1 / (1 + e^-u)
//!     s(x) = (sig(K (x - 1/2)) - sig(-K/2)) / (sig(K/2) - sig(-K/2))
//!     fc = F_LO * (F_HI / F_LO)^s(x)
//!   s(0) = 0, s(1) = 1, s strictly increasing, and s(1 - x) = 1 - s(x), so
//!   fc(reg) * fc(2047 - reg) = F_LO * F_HI: the curve is geometrically
//!   symmetric about sqrt(F_LO * F_HI) = 1989.97 Hz.
//!   INFERRED: the logistic form, F_LO = 220 Hz, F_HI = 18 kHz and K = 7
//!   are tuning guesses for "one representative chip", chosen to match the
//!   qualitative description above. No measured curve was used (the
//!   published ones are per-chip and sit inside GPL emulators). Ears-gate.
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

/// 6581 cutoff floor (register 0), Hz. INFERRED tuning (see header).
pub const F_LO_6581: f64 = 220.0;
/// 6581 cutoff ceiling (register 0x7FF), Hz. INFERRED tuning.
pub const F_HI_6581: f64 = 18_000.0;
/// Steepness of the 6581 logistic cutoff curve. INFERRED tuning.
pub const K_6581: f64 = 7.0;
/// Soft limit of the 6581 band-pass state (one full-scale voice). INFERRED.
pub const SAT_6581: f64 = 1.0;

#[inline]
fn sigmoid(u: f64) -> f64 {
    1.0 / (1.0 + (-u).exp())
}

/// 6581 cutoff register -> Hz: the normalised log-logistic curve (header).
pub fn cutoff_hz_6581(reg: u16) -> f64 {
    let x = (reg & 0x7FF) as f64 / 2047.0;
    let lo = sigmoid(-K_6581 / 2.0);
    let hi = sigmoid(K_6581 / 2.0);
    let s = ((sigmoid(K_6581 * (x - 0.5)) - lo) / (hi - lo)).clamp(0.0, 1.0);
    F_LO_6581 * (F_HI_6581 / F_LO_6581).powf(s)
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
    fn map_6581_endpoints_symmetry_and_a_hand_point() {
        // s(0) = 0 -> F_LO; s(1) = 1 -> F_HI (exact up to rounding).
        assert!((cutoff_hz_6581(0) - 220.0).abs() < 1e-9);
        assert!((cutoff_hz_6581(0x7FF) - 18_000.0).abs() < 1e-6);
        assert_eq!(cutoff_hz_6581(0x800), cutoff_hz_6581(0)); // 11 bits only
        // Geometric symmetry: fc(r) * fc(2047 - r) = 220 * 18000 = 3.96e6.
        for r in (0..=2047u16).step_by(97) {
            let p = cutoff_hz_6581(r) * cutoff_hz_6581(2047 - r);
            assert!((p / 3.96e6 - 1.0).abs() < 1e-12, "reg {r}: {p}");
        }
        // Hand point, reg 0x200: x = 512/2047 = 0.250122.
        //   sig(7 * (0.250122 - 0.5)) = sig(-1.749145) = 1/(1 + 5.74983) = 0.148152
        //   sig(-3.5) = 1/(1 + 33.11545) = 0.029312; sig(3.5) = 0.970688
        //   s = (0.148152 - 0.029312) / 0.941376 = 0.126241
        //   fc = 220 * 81.8182^0.126241 = 220 * e^(0.126241 * 4.404499)
        //      = 220 * e^0.556027 = 220 * 1.743762 = 383.63 Hz
        // The 8580 map puts the same register at 30 + 512 * 5.84758 = 3023.96 Hz.
        assert!((cutoff_hz_6581(0x200) - 383.63).abs() < 0.05, "{}", cutoff_hz_6581(0x200));
        assert!((cutoff_hz(0x200) - 3023.96).abs() < 0.01);
    }

    #[test]
    fn map_6581_is_strictly_monotonic_and_unlike_the_8580() {
        for r in 0..2047u16 {
            assert!(cutoff_hz_6581(r + 1) > cutoff_hz_6581(r), "reg {r}");
        }
        // Bottom quarter: the 6581 barely moves (220 -> ~384 Hz) where the
        // 8580 sweeps 30 -> ~3 kHz; the top ends 18 kHz vs 12 kHz.
        assert!(cutoff_hz_6581(0x200) / cutoff_hz_6581(0) < 1.8);
        assert!(cutoff_hz(0x200) / cutoff_hz(0) > 100.0);
        // Hand values: reg 0 -> 220 vs 30 (x7.3); 0x100 -> ~263 vs 1527
        // (x5.8); 0x200 -> 384 vs 3024 (x7.9); 0x7FF -> 18000 vs 12000 (x1.5).
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
        // the same 2 % the 8580 test uses.
        let reg = 0x400;
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
