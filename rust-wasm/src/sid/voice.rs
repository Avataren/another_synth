//! One SID voice: 24-bit phase accumulator, waveform latch, noise LFSR,
//! envelope and the waveform x envelope DAC product.
//!
//! The voice is driven by `Chip`, which owns the per-cycle ordering because
//! sync and ring mod couple voices together (see `chip.rs`). Everything a
//! caller can observe is exposed read-only here. Writes go through the
//! chip's register interface.
//!
//! Sources (GPL-free): MOS 6581/8580 datasheet (frequency/pulse-width
//! registers, control bits, "Fout = Fn * Fclk / 2^24"); public hardware notes.
//!
//! - Accumulator: `acc = (acc + freq) mod 2^24` each cycle. Exact.
//! - TEST bit: the accumulator is reset to 0 and held there while TEST is
//!   set (datasheet: "resets and locks Oscillator 1 at zero until the TEST
//!   bit is cleared"). Exact. For its effect on noise and pulse see
//!   `noise.rs` and `waveform.rs`.
//! - DAC (8580): linear, zero point at the waveform midpoint, so the voice
//!   output is `(wave - 0x800) / 0x800 * env / 255`. INFERRED from the
//!   8580 being documented as having near-linear DACs and none of the
//!   6581's large per-voice DC offset.

use super::envelope::{Envelope, Stage};
use super::noise::Noise;
use super::waveform::{waveform_output, GATE, NOISE, TEST};
use super::{SidModel, ACC_MASK};

const MSB: u32 = 0x80_0000;
const NOISE_CLOCK_BIT: u32 = 0x08_0000; // accumulator bit 19

#[derive(Debug, Clone, Copy)]
pub struct Voice {
    acc: u32,
    freq: u16,
    pw: u16,
    control: u8,
    noise: Noise,
    env: Envelope,
    /// The 12-bit waveform DAC input (held when no waveform is selected).
    wave: u16,
    /// Accumulator value at the start of the current cycle.
    prev_acc: u32,
    /// The MSB went 0 -> 1 during the current cycle.
    msb_rising: bool,
}

impl Default for Voice {
    fn default() -> Self {
        Voice {
            acc: 0,
            freq: 0,
            pw: 0,
            control: 0,
            noise: Noise::default(),
            env: Envelope::default(),
            wave: 0,
            prev_acc: 0,
            msb_rising: false,
        }
    }
}

impl Voice {
    /// 24-bit phase accumulator.
    #[inline]
    pub fn accumulator(&self) -> u32 {
        self.acc
    }

    #[inline]
    pub fn frequency(&self) -> u16 {
        self.freq
    }

    /// 12-bit pulse width.
    #[inline]
    pub fn pulse_width(&self) -> u16 {
        self.pw
    }

    #[inline]
    pub fn control(&self) -> u8 {
        self.control
    }

    /// The 12-bit value on the waveform DAC input (what OSC3 reads the top
    /// 8 bits of for voice 3).
    #[inline]
    pub fn waveform(&self) -> u16 {
        self.wave
    }

    #[inline]
    pub fn envelope_level(&self) -> u8 {
        self.env.level()
    }

    #[inline]
    pub fn envelope_stage(&self) -> Stage {
        self.env.stage()
    }

    /// 15-bit envelope rate counter.
    #[inline]
    pub fn envelope_rate_counter(&self) -> u16 {
        self.env.rate_counter()
    }

    /// 23-bit noise LFSR.
    #[inline]
    pub fn noise_register(&self) -> u32 {
        self.noise.register()
    }

    /// Envelope-scaled output, normalised to about -1..1.
    #[inline]
    pub fn output(&self) -> f64 {
        (self.wave as f64 - 2048.0) / 2048.0 * (self.env.level() as f64 / 255.0)
    }

    pub(super) fn set_freq_lo(&mut self, v: u8) {
        self.freq = (self.freq & 0xFF00) | v as u16;
    }

    pub(super) fn set_freq_hi(&mut self, v: u8) {
        self.freq = (self.freq & 0x00FF) | ((v as u16) << 8);
    }

    pub(super) fn set_pw_lo(&mut self, v: u8) {
        self.pw = (self.pw & 0x0F00) | v as u16;
    }

    pub(super) fn set_pw_hi(&mut self, v: u8) {
        self.pw = (self.pw & 0x00FF) | (((v & 0x0F) as u16) << 8);
    }

    pub(super) fn set_ad(&mut self, v: u8) {
        self.env.set_ad(v);
    }

    pub(super) fn set_sr(&mut self, v: u8) {
        self.env.set_sr(v);
    }

    /// Control register write. Like every register write here, it lands
    /// between chip cycles; TEST's resets happen on the next cycle.
    pub(super) fn set_control(&mut self, v: u8) {
        self.control = v;
        self.env.set_gate(v & GATE != 0);
    }

    /// Cycle phase 1: advance the accumulator (or hold it at 0 under TEST)
    /// and latch whether the MSB rose.
    #[inline]
    pub(super) fn clock_accumulator(&mut self) {
        self.prev_acc = self.acc;
        self.acc = if self.control & TEST != 0 {
            0
        } else {
            (self.acc + self.freq as u32) & ACC_MASK
        };
        self.msb_rising = self.prev_acc & MSB == 0 && self.acc & MSB != 0;
    }

    #[inline]
    pub(super) fn msb_rising(&self) -> bool {
        self.msb_rising
    }

    #[inline]
    pub(super) fn has_control(&self, bit: u8) -> bool {
        self.control & bit != 0
    }

    /// Cycle phase 2 (sync): reset the accumulator to 0. The cycle's own
    /// increment is discarded, and a reset accumulator has no MSB rise.
    #[inline]
    pub(super) fn sync_reset(&mut self) {
        self.acc = 0;
        self.msb_rising = false;
    }

    /// Cycle phase 3: noise clock, envelope, waveform latch. `source_acc` is
    /// the ring-mod source's accumulator after phases 1-2.
    #[inline]
    pub(super) fn finish_cycle(&mut self, model: SidModel, source_acc: u32) {
        if self.control & TEST != 0 {
            self.noise.test_reset();
        } else if self.prev_acc & NOISE_CLOCK_BIT == 0 && self.acc & NOISE_CLOCK_BIT != 0 {
            if self.control & NOISE != 0 && self.control & 0x70 != 0 {
                if let Some(w) = self.select(model, source_acc) {
                    self.noise.write_back(w);
                }
            }
            self.noise.shift();
        }
        self.env.clock();
        if let Some(w) = self.select(model, source_acc) {
            self.wave = w;
        }
    }

    #[inline]
    fn select(&self, model: SidModel, source_acc: u32) -> Option<u16> {
        waveform_output(model, self.control, self.acc, source_acc, self.pw, self.noise.output())
    }
}
