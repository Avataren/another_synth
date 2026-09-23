//! SID waveform generator output: the 12-bit value presented to a voice's
//! waveform DAC, as a pure function of the control register, the voice's
//! 24-bit phase accumulator, its sync/ring source's accumulator, the
//! pulse-width register and the noise LFSR output.
//!
//! Model: combinational logic over the accumulator bits, one evaluation per
//! chip cycle.
//!
//! Sources (GPL-free): MOS 6581/8580 datasheet (control register bits,
//! "SYNC", "RING MOD", "TEST" descriptions); Bob Yannes' published interview
//! on the SID design (saw = upper 12 accumulator bits, triangle = MSB-folded
//! lower bits, pulse = 12-bit comparator, selected waveforms are wired
//! together on the same output lines); public C64 community hardware notes.
//!
//! - Sawtooth: accumulator bits 23..12. Exact.
//! - Triangle: bits 22..11, XOR-folded by the fold signal, output LSB 0.
//!   Without ring mod the fold signal is the voice's own MSB. Exact.
//! - Ring mod (control bit 2): the fold signal becomes
//!   `MSB(own) XOR NOT MSB(source)` (plan §1.2's wording, "triangle output XOR
//!   NOT MSB(osc B)"). INFERRED from the public die-level description that
//!   ring mod swaps the triangle's MSB for an XOR with the source MSB; the
//!   NOT is the plan's specified polarity. On its own it only shifts a
//!   static triangle by half a period (an inverted triangle is the same
//!   wave delayed by half a cycle). The ring-mod sound comes from the XOR.
//!   Ring mod touches only the triangle function. It has no effect unless
//!   TRI is selected, and in a combined waveform the triangle component is
//!   the ring-modulated one.
//! - Pulse: all ones when `acc[23:12] >= PW`, else zero. Exact. TEST forces
//!   the pulse output high. The datasheet says "the Pulse waveform output is
//!   held at a DC level"; the level being all ones is INFERRED from public
//!   hardware notes (the C64 "test-bit digi" technique relies on it).
//! - Noise: supplied by `noise.rs` (8 LFSR taps on DAC bits 11..4).
//! - Combined waveforms, 8580: the selected outputs share the waveform bit
//!   lines, so the combination is the bitwise AND of the selected 12-bit
//!   outputs (the public combinational-logic "wired-AND" view). INFERRED:
//!   the real 8580 is documented as much closer to this ideal AND than the
//!   6581 (whose combined waveforms are strongly attenuated), but not
//!   identical: neighbouring bit lines pull each other down a little. That
//!   residual is NOT modelled, because no GPL-free measured data for it was
//!   available. Treat it as an ears-gate item. Noise in a combination
//!   also writes zeros back into the LFSR (see `noise.rs`).
//! - Combined waveforms, 6581 (S2). Public knowledge: the 6581's combined
//!   waveforms come out far weaker than the ideal AND. Saw+tri is mostly
//!   silent, and pulse+saw keeps only the upper part of the ramp. The
//!   public explanation is the same shared-bit-line picture, with stronger
//!   coupling on the 6581: a line held low by one waveform also drags its
//!   neighbours low, and the effect falls off with distance. Modelled as a
//!   pass over the ideal AND `a`:
//!     pull(i) = sum over bits j != i with a_j = 0 of 2^(11 - |i - j|)
//!     out bit i = a_i AND pull(i) < 1536
//!   The weight halves per bit of distance (a zero next door pulls 1024, one
//!   two bits away 512, ...), and the threshold 1536 = 0.75 * 2048. So an
//!   isolated one-bit inside the word always vanishes (a zero on each side
//!   = 2048). An edge bit (11 or 0) has only one neighbour. It vanishes
//!   when a long enough run of zeros follows it (e.g. 0x800 alone: 2047),
//!   but survives sparse zeros (bit 0 of 0x555: 1365). The bottom bit of a
//!   run that sits on a long run of zeros is eaten ("run-down"). Long runs
//!   of ones survive.
//!   All ones and all zeros are fixed points. The pass is not iterated, and
//!   it uses only the AND, not which waveforms made it.
//!   INFERRED: the neighbour-pull rule, its 2^-d weights and the 0.75
//!   threshold are my own tuning to match the qualitative description. No
//!   measured 6581 combined-waveform table was used: the published ones sit
//!   inside GPL emulators. It applies only when two or more waveforms are
//!   selected, so a single waveform is untouched. Precomputed into a
//!   4096-entry table (`COMBINED_6581`) because it runs every chip cycle.
//!   Ears-gate.
//! - No waveform selected ("waveform 0"): the DAC input floats and keeps
//!   the last output. INFERRED from public hardware notes. `waveform_output`
//!   returns `None` and the voice keeps its previous value. On the 8580 the
//!   slow leak of the held value is not modelled. On the 6581 (S2) the held
//!   value fades to 0 after a fixed time; see `voice.rs`. The TEST bit
//!   does not drive the DAC when no waveform is selected, so TEST with
//!   waveform 0 changes nothing here: the held value stays, and on the 6581
//!   its fade keeps running.

use super::SidModel;

/// Control register ($D404/$D40B/$D412) bits.
pub const GATE: u8 = 0x01;
pub const SYNC: u8 = 0x02;
pub const RING: u8 = 0x04;
pub const TEST: u8 = 0x08;
pub const TRI: u8 = 0x10;
pub const SAW: u8 = 0x20;
pub const PULSE: u8 = 0x40;
pub const NOISE: u8 = 0x80;

const MSB: u32 = 0x80_0000;

/// Sawtooth: the upper 12 bits of the accumulator, verbatim.
#[inline]
pub fn sawtooth(acc: u32) -> u16 {
    ((acc >> 12) & 0xFFF) as u16
}

/// Triangle with an explicit fold signal: accumulator bits 22..12 become
/// output bits 11..1 (inverted when `fold`), output bit 0 is always 0.
#[inline]
pub fn triangle_folded(acc: u32, fold: bool) -> u16 {
    let bits = if fold { acc ^ 0x7F_FFFF } else { acc };
    ((bits >> 11) & 0xFFE) as u16
}

/// Plain triangle: folded by the voice's own MSB.
#[inline]
pub fn triangle(acc: u32) -> u16 {
    triangle_folded(acc, acc & MSB != 0)
}

/// Ring-modulated triangle: fold = MSB(own) XOR NOT MSB(source).
#[inline]
pub fn triangle_ring(acc: u32, source_acc: u32) -> u16 {
    let own = acc & MSB != 0;
    let src = source_acc & MSB != 0;
    triangle_folded(acc, own ^ !src)
}

/// Pulse: 12-bit comparator, all ones when `acc[23:12] >= pw`.
#[inline]
pub fn pulse(acc: u32, pw: u16) -> u16 {
    if sawtooth(acc) >= (pw & 0xFFF) {
        0xFFF
    } else {
        0
    }
}

/// The 12-bit waveform DAC input for one voice, or `None` when no waveform
/// is selected (the voice then holds its previous output).
///
/// `noise_out` is the LFSR's 12-bit output (`Noise::output`).
#[inline]
pub fn waveform_output(
    model: SidModel,
    control: u8,
    acc: u32,
    source_acc: u32,
    pw: u16,
    noise_out: u16,
) -> Option<u16> {
    let sel = control & 0xF0;
    if sel == 0 {
        return None;
    }
    let mut out = 0xFFFu16;
    if sel & TRI != 0 {
        out &= if control & RING != 0 {
            triangle_ring(acc, source_acc)
        } else {
            triangle(acc)
        };
    }
    if sel & SAW != 0 {
        out &= sawtooth(acc);
    }
    if sel & PULSE != 0 {
        out &= if control & TEST != 0 { 0xFFF } else { pulse(acc, pw) };
    }
    if sel & NOISE != 0 {
        out &= noise_out;
    }
    match model {
        // Wired-AND is the whole 8580 combined-waveform model (see header).
        SidModel::Sid8580 => Some(out),
        SidModel::Sid6581 if sel.count_ones() >= 2 => Some(COMBINED_6581[out as usize]),
        SidModel::Sid6581 => Some(out),
    }
}

/// Threshold of the 6581 neighbour pull, 0.75 in units of 2048.
pub const PULL_THRESHOLD_6581: u32 = 1536;

/// The 6581 neighbour-pull pass over one ideal wired-AND value (header).
pub const fn combined_6581(and: u16) -> u16 {
    let mut out = 0u16;
    let mut i = 0;
    while i < 12 {
        if (and >> i) & 1 != 0 {
            let mut pull = 0u32;
            let mut j = 0;
            while j < 12 {
                if j != i && (and >> j) & 1 == 0 {
                    let d = if i > j { i - j } else { j - i };
                    pull += 1 << (11 - d);
                }
                j += 1;
            }
            if pull < PULL_THRESHOLD_6581 {
                out |= 1 << i;
            }
        }
        i += 1;
    }
    out
}

/// `combined_6581` for every 12-bit AND value.
pub static COMBINED_6581: [u16; 4096] = {
    let mut t = [0u16; 4096];
    let mut a = 0;
    while a < 4096 {
        t[a] = combined_6581(a as u16);
        a += 1;
    }
    t
};

#[cfg(test)]
mod tests {
    use super::*;

    const M: SidModel = SidModel::Sid8580;

    #[test]
    fn sawtooth_is_upper_twelve_bits() {
        assert_eq!(sawtooth(0x00_0000), 0x000);
        assert_eq!(sawtooth(0x00_0FFF), 0x000); // lower 12 bits ignored
        assert_eq!(sawtooth(0x00_1000), 0x001);
        assert_eq!(sawtooth(0x80_0000), 0x800);
        assert_eq!(sawtooth(0xFF_FFFF), 0xFFF);
    }

    #[test]
    fn triangle_folds_on_msb_and_has_even_output() {
        // Rising half: acc 0x400000 -> bits 22..11 = 0x800.
        assert_eq!(triangle(0x00_0000), 0x000);
        assert_eq!(triangle(0x40_0000), 0x800);
        assert_eq!(triangle(0x7F_FFFF), 0xFFE); // peak, LSB always 0
        // MSB set: 0x800000 ^ 0x7FFFFF = 0xFFFFFF -> bits 22..11 = 0xFFE.
        assert_eq!(triangle(0x80_0000), 0xFFE);
        // 0xC00000 ^ 0x7FFFFF = 0xBFFFFF -> (>>11) & 0xFFE = 0x7FE.
        assert_eq!(triangle(0xC0_0000), 0x7FE);
        assert_eq!(triangle(0xFF_FFFF), 0x000);
        for a in (0..0x80_0000u32).step_by(0x1_2345) {
            assert_eq!(triangle(a), triangle(0xFF_FFFF - a));
            assert_eq!(triangle(a) & 1, 0);
        }
    }

    #[test]
    fn pulse_compares_upper_bits_against_width() {
        assert_eq!(pulse(0x7F_F000, 0x800), 0);
        assert_eq!(pulse(0x7F_FFFF, 0x800), 0);
        assert_eq!(pulse(0x80_0000, 0x800), 0xFFF);
        for a in [0u32, 0x12_3456, 0xFF_FFFF] {
            assert_eq!(pulse(a, 0x000), 0xFFF, "pw 0 is always high");
        }
        assert_eq!(pulse(0xFF_EFFF, 0xFFF), 0);
        assert_eq!(pulse(0xFF_F000, 0xFFF), 0xFFF);
        assert_eq!(pulse(0x80_0000, 0x1800), pulse(0x80_0000, 0x800));
    }

    #[test]
    fn pulse_duty_cycle_over_a_full_sweep() {
        for (pw, want) in [(0x400u16, 0.75), (0x800, 0.5), (0xC00, 0.25)] {
            let high = (0..4096u32).filter(|u| pulse(u << 12, pw) != 0).count();
            assert_eq!(high as f64 / 4096.0, want);
        }
    }

    #[test]
    fn ring_mod_truth_table() {
        // Hand derivation. Accumulator low bits fixed at 0x400000 (rising
        // quarter: bits 22..11 = 0x800) or 0xC00000 (bits 22..11 = 0x800
        // too, own MSB set). Folding XORs bits 22..0 with ones, turning
        // bits 22..11 = 0x800 into 0x7FF, masked to 0x7FE.
        //   fold = own ^ !src
        //   own src | fold | acc      -> out
        //    0   0  |  1   | 0x400000 -> 0x7FE
        //    0   1  |  0   | 0x400000 -> 0x800
        //    1   0  |  0   | 0xC00000 -> 0x800
        //    1   1  |  1   | 0xC00000 -> 0x7FE
        // Ring off: fold = own -> 0x400000 -> 0x800, 0xC00000 -> 0x7FE.
        let lo = 0x40_0000u32;
        let hi = 0xC0_0000u32;
        let src0 = 0x00_0000u32;
        let src1 = 0x80_0000u32;
        let ring = TRI | RING;
        let w = |c, a, s| waveform_output(M, c, a, s, 0, 0).unwrap();
        assert_eq!(w(ring, lo, src0), 0x7FE);
        assert_eq!(w(ring, lo, src1), 0x800);
        assert_eq!(w(ring, hi, src0), 0x800);
        assert_eq!(w(ring, hi, src1), 0x7FE);
        assert_eq!(w(TRI, lo, src0), 0x800);
        assert_eq!(w(TRI, lo, src1), 0x800);
        assert_eq!(w(TRI, hi, src0), 0x7FE);
        assert_eq!(w(TRI, hi, src1), 0x7FE);
        // Ring mod is a triangle-only function: saw and pulse ignore it.
        for s in [src0, src1] {
            assert_eq!(w(SAW | RING, hi, s), 0xC00);
            assert_eq!(w(PULSE | RING, hi, s), 0xFFF);
        }
        // Flipping the fold flips output bits 11..1: ring output with a
        // source MSB of 0 is the plain triangle XOR 0xFFE, for any phase.
        for a in (0..0x100_0000u32).step_by(0x3_1415) {
            assert_eq!(w(ring, a, src0), triangle(a) ^ 0xFFE);
            assert_eq!(w(ring, a, src1), triangle(a));
        }
    }

    #[test]
    fn combined_waveforms_are_the_wired_and() {
        // acc 0x600000: saw = 0x600; tri (own MSB 0) = bits 22..11 of
        // 0x600000 = 0xC00; pulse(pw 0x400) = 0xFFF (0x600 >= 0x400).
        //   saw & tri         = 0x600 & 0xC00 = 0x400
        //   pulse & saw       = 0x600
        //   pulse & tri       = 0xC00
        //   pulse & saw & tri = 0x400
        // With pw 0x800 the pulse is low (0x600 < 0x800), so every pulse
        // combination is 0.
        let a = 0x60_0000u32;
        let w = |c, pw| waveform_output(M, c, a, 0, pw, 0xFF0).unwrap();
        assert_eq!(w(SAW | TRI, 0x400), 0x400);
        assert_eq!(w(PULSE | SAW, 0x400), 0x600);
        assert_eq!(w(PULSE | TRI, 0x400), 0xC00);
        assert_eq!(w(PULSE | SAW | TRI, 0x400), 0x400);
        for c in [PULSE | SAW, PULSE | TRI, PULSE | SAW | TRI] {
            assert_eq!(w(c, 0x800), 0);
        }
        // Noise 0xFF0 AND saw 0x600 = 0x600; low nibble of noise is 0.
        assert_eq!(w(NOISE | SAW, 0x400), 0x600);
        assert_eq!(waveform_output(M, NOISE | SAW, 0x60_F000, 0, 0, 0xFF0), Some(0x600));
    }

    #[test]
    fn test_bit_forces_pulse_high_and_nothing_else() {
        // pw 0xFFF at acc 0: comparator low; TEST forces all ones.
        assert_eq!(waveform_output(M, PULSE, 0, 0, 0xFFF, 0), Some(0));
        assert_eq!(waveform_output(M, PULSE | TEST, 0, 0, 0xFFF, 0), Some(0xFFF));
        assert_eq!(waveform_output(M, SAW | TEST, 0x60_0000, 0, 0, 0), Some(0x600));
    }

    #[test]
    fn combined_6581_pull_down_hand_values() {
        // Weights: a zero at distance d pulls 2^(11 - d); keep if < 1536.
        //  0xFFF: no zeros -> kept. 0x000: nothing to keep.
        //  0x400 (bit 10 alone): zeros at 11 and 9 (1024 each) -> gone.
        //  0x800 (bit 11 alone): zeros 10..0, d 1..11: 2047 -> gone.
        //  0xC00: bit 11 sees zeros 9..0 at d 2..11: 1023 -> kept;
        //         bit 10 sees zeros 9..0 at d 1..10: 2046 -> gone. -> 0x800
        //  0xE00: bit 9: 2044 gone; bit 10: 1022 kept; bit 11: 511 kept -> 0xC00
        //  0xFF0: bit 4: zeros 3..0 at d 1..4 = 1920 gone; bit 5: d 2..5 =
        //         960 kept; higher bits smaller -> 0xFE0
        //  0x7FE: bit 1: zero 0 (1024) + zero 11 (d 10, 2) = 1026 kept;
        //         bit 10 symmetric -> 0x7FE unchanged
        //  0x555: bits 2..10 have zeros on both sides (2048) -> gone; bit 0
        //         is an edge bit: zero 1 (1024) + zeros 3,5,7,9,11 (256 + 64
        //         + 16 + 4 + 1) = 1365 -> kept. -> 0x001
        //         (first derivation said 0 and missed the edge; the test
        //         caught it)
        //  0x600: bit 10: zero 11 (1024) + zeros 8..0 at d 2..10 (1022) =
        //         2046 gone; bit 9: zeros 8..0 at d 1..9 (2044) gone -> 0
        for (a, want) in [(0xFFFu16, 0xFFFu16), (0, 0), (0x400, 0), (0x800, 0),
            (0xC00, 0x800), (0xE00, 0xC00), (0xFF0, 0xFE0), (0x7FE, 0x7FE),
            (0x555, 0x001), (0x600, 0)] {
            assert_eq!(combined_6581(a), want, "{a:#05x}");
            assert_eq!(COMBINED_6581[a as usize], want);
        }
    }

    #[test]
    fn combined_6581_only_removes_bits_and_only_for_combinations() {
        for a in 0..4096u16 {
            assert_eq!(COMBINED_6581[a as usize] & !a, 0, "{a:#05x} gained bits");
        }
        // Single waveforms are identical on both models at every phase.
        let m6 = SidModel::Sid6581;
        for acc in (0..0x100_0000u32).step_by(0x1_0001) {
            for c in [TRI, SAW, PULSE, NOISE, TRI | RING, PULSE | TEST] {
                assert_eq!(
                    waveform_output(m6, c, acc, 0x80_0000, 0x800, 0xA50),
                    waveform_output(M, c, acc, 0x80_0000, 0x800, 0xA50)
                );
            }
        }
        // Saw+tri at acc 0x600000: 8580 AND 0x400, 6581 0 (hand: 0x400 row).
        assert_eq!(waveform_output(m6, SAW | TRI, 0x60_0000, 0, 0, 0), Some(0));
        assert_eq!(waveform_output(M, SAW | TRI, 0x60_0000, 0, 0, 0), Some(0x400));
    }

    #[test]
    fn no_waveform_selected_is_none() {
        for c in [0u8, GATE, SYNC | RING | TEST | GATE] {
            assert_eq!(waveform_output(M, c, 0x60_0000, 0, 0, 0xFF0), None);
        }
    }
}
