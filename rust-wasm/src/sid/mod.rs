//! MOS SID (6581/8580) voice core, S1 of `.ai/plan-sid-tracking.md`.
//!
//! Model: a cycle-counted digital core (phase accumulators, waveform bit
//! logic, sync, ring mod, test bit, noise LFSR, envelope generators) at the
//! PAL clock of 985 248 Hz, under a sample-rate analog path (boxcar
//! decimation, 2-pole state-variable filter, volume, output coupling) at
//! 44.1 kHz (or another output rate). This is the plan §1.1 approximation, not
//! cycle-exact audio. See `chip.rs` for the sample-rate caveats.
//!
//! Both revisions are implemented, chosen per `Chip` instance. The 8580 is
//! S1. The 6581 is S2's character pass over the same skeleton: every 6581
//! behaviour is gated on the model, so the 8580 paths are unchanged
//! (pinned bit-exactly by `tests_s2::pin_8580_render_is_bit_identical_to_s1`).
//! S2's record is `.ai/sid-6581-verdict.md`.
//!
//! Sources: the MOS 6581/8580 datasheet, Bob Yannes' published interview,
//! and public C64 community hardware measurements and notes. No GPL
//! emulator code or tables were consulted or copied (plan §8.3). Each
//! module's header lists its sources and marks every INFERRED choice.
//! Grown from the accepted S0 spike (`.ai/sid-spike-verdict.md`). S1's record
//! is `.ai/sid-voice-core-verdict.md`.

pub mod chip;
pub mod envelope;
pub mod filter;
pub mod noise;
pub mod voice;
pub mod waveform;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_s2;

pub use chip::Chip;

use std::fmt;

/// PAL C64 system clock (phi2), Hz. C64 Programmer's Reference Guide.
pub const PAL_CLOCK_HZ: f64 = 985_248.0;
/// Default output sample rate.
pub const DEFAULT_SAMPLE_RATE: f64 = 44_100.0;
/// 24-bit phase accumulator.
pub const ACC_MASK: u32 = 0x00FF_FFFF;

/// Which SID revision a chip models.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SidModel {
    /// MOS 8580 (S1).
    Sid8580,
    /// MOS 6581 (S2): the 8580 skeleton plus the 6581's nonlinear cutoff
    /// map and saturating resonance (`filter.rs`), pulled-down combined
    /// waveforms and the waveform-0 fade (`waveform.rs`, `voice.rs`), the
    /// attack-shape lag (`voice.rs`), and the DAC/mixer DC offsets with
    /// their gain calibration (`voice.rs`, `chip.rs`). An approximation of
    /// one representative chip; real 6581s vary widely (plan §1.1).
    Sid6581,
}

impl SidModel {
    /// Why this model cannot be instantiated, or `None` if it can. Both
    /// models construct since S2; kept so callers can keep asking.
    pub fn unimplemented_reason(self) -> Option<&'static str> {
        match self {
            SidModel::Sid8580 | SidModel::Sid6581 => None,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum SidError {
    ModelNotImplemented { model: SidModel, reason: &'static str },
    UnsupportedSampleRate(f64),
}

impl fmt::Display for SidError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            SidError::ModelNotImplemented { reason, .. } => f.write_str(reason),
            SidError::UnsupportedSampleRate(sr) => {
                write!(f, "unsupported sample rate {sr} Hz (8000..=192000)")
            }
        }
    }
}

impl std::error::Error for SidError {}

/// Oscillator frequency in Hz for a 16-bit frequency register, per the SID
/// datasheet: `Fout = Fn * Fclk / 2^24`.
pub fn freq_reg_to_hz(reg: u16) -> f64 {
    reg as f64 * PAL_CLOCK_HZ / 16_777_216.0
}

/// Nearest frequency register value for a pitch in Hz (clamped to 16 bits).
pub fn hz_to_freq_reg(hz: f64) -> u16 {
    (hz * 16_777_216.0 / PAL_CLOCK_HZ).round().clamp(0.0, 65_535.0) as u16
}

/// Register value for a MIDI note (69 = A-4 = 440 Hz, equal temperament).
pub fn note_to_freq_reg(midi: i32) -> u16 {
    hz_to_freq_reg(440.0 * 2f64.powf((midi - 69) as f64 / 12.0))
}
