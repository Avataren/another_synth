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
//! Linear: no saturation. The 8580 is "clean", not perfectly so.

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

#[derive(Debug, Clone, Copy)]
pub struct Filter {
    s1: f64,
    s2: f64,
    g: f64,
    k: f64,
    h: f64,
    cutoff_reg: u16,
    res: u8,
    mode: u8,
    sample_rate: f64,
}

impl Filter {
    pub fn new(sample_rate: f64) -> Self {
        let mut f = Filter {
            s1: 0.0,
            s2: 0.0,
            g: 0.0,
            k: 0.0,
            h: 0.0,
            cutoff_reg: 0,
            res: 0,
            mode: 0,
            sample_rate,
        };
        f.set(0, 0);
        f
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
        let fc = cutoff_hz(self.cutoff_reg).min(self.sample_rate * 0.49);
        self.g = (PI * fc / self.sample_rate).tan();
        self.k = 1.0 / resonance_q(self.res);
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
}
