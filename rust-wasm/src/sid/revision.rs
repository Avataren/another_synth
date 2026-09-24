//! 6581 die-revision profiles (S5.15). Every characteristic that could
//! differ between 6581 die revisions lives here, in one `RevisionProfile`,
//! so a later pass can add a revision (R3) by adding a profile and changing
//! `SID6581_REVISION`. Nothing else in the engine names a revision.
//!
//! Selection is engine-side: `SidModel::Sid6581` always plays
//! `profile_6581()`. No .sng/.sid field encodes the die revision, so there
//! is nothing in the file format to read it from.
//!
//! Sources (GPL-free; `.ai/sid-r4ar-research-notes.md`):
//! - Wikipedia, "MOS Technology 6581", Revisions: the 6581 went through R2,
//!   R3, R4 and R4AR with "no substantial alterations", only input-pin
//!   protection/buffering, silicon grade and packaging changes.
//! - C64-Wiki, "SID": 6581R4AR was produced 22/1986-06/1987, the last 6581.
//!   Trivia: every write to the 6581's volume register gave an audible click
//!   (the $D418 sample trick); on the 8580 "samples were inaudible".
//!
//! Trait classification. Only the volume DAC is new in S5.15; the rest is
//! earlier work moved here unchanged:
//! - Cutoff curve: GENERIC-6581. The public record gives 6581-vs-8580
//!   nonlinearity but no per-revision anchors. The R4AR profile carries the
//!   S5.12 measured-anchor curve as is. The published nominal curve's range
//!   (220 Hz..18 kHz) is quoted for the 6581 generally — the record does not
//!   break it down per die revision; R4AR is consistent with it.
//! - FC_HI $7F -> $80 step: GENERIC-6581. It is the 0x3FF -> 0x400 drop
//!   between the two anchor sets. No revision-specific position or shape is
//!   invented.
//! - Output DC (voice DC, mixer DC) and the gain derived from them:
//!   GENERIC-6581. They keep S2's INFERRED values (`voice.rs`, `chip.rs`).
//! - Volume DAC: GENERIC-6581 vs 8580. The 8580 stays linear, VOL / 15. See
//!   `R4AR` for the INFERRED 6581 table.

/// A 6581 die revision the engine can play.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DieRevision {
    /// 6581R4AR (1986-1987), the last and most common 6581.
    R4AR,
    /// Not a chip: the 6581 filter response GoatTracker's default playback
    /// has (classic reSID), measured and fitted in S5.16
    /// (`.ai/sid-6581-gt-fit-notes.md`). It differs from `R4AR` in the filter
    /// only (cutoff curve, resonance map, soft limit); every other trait is
    /// R4AR's. Named here because a GT song is mixed against that filter.
    GtRef,
}

impl DieRevision {
    pub const fn profile(self) -> &'static RevisionProfile {
        match self {
            DieRevision::R4AR => &R4AR,
            DieRevision::GtRef => &GT_REF,
        }
    }
}

/// The revision `SidModel::Sid6581` plays. The one swap point.
pub const SID6581_REVISION: DieRevision = DieRevision::GtRef;

/// The profile `SidModel::Sid6581` plays.
pub const fn profile_6581() -> &'static RevisionProfile {
    SID6581_REVISION.profile()
}

/// How the resonance nibble maps to Q: both start at Butterworth, 0.707.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum ResonanceMap {
    /// Q = 0.707 * 2^(res / divisor). R4AR's (S2, INFERRED), divisor 12.
    Exponential { divisor: f64 },
    /// Q = 0.707 + slope * res. The measured GT response (S5.16).
    Linear { slope: f64 },
}

impl ResonanceMap {
    pub fn q(self, res: u8) -> f64 {
        let r = (res & 0xF) as f64;
        match self {
            ResonanceMap::Exponential { divisor } => 0.707 * 2f64.powf(r / divisor),
            ResonanceMap::Linear { slope } => 0.707 + slope * r,
        }
    }
}

/// Everything revision-specific about a 6581.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RevisionProfile {
    pub revision: DieRevision,
    /// Cutoff anchors (register, Hz), low piece: 0..=0x3FF (FC_HI bit 7
    /// clear). Log-linear between anchors (`filter::cutoff_hz_6581_with`).
    pub cutoff_anchors_lo: &'static [(u16, f64)],
    /// Cutoff anchors, high piece: 0x400..=0x7FF (FC_HI bit 7 set).
    pub cutoff_anchors_hi: &'static [(u16, f64)],
    /// Resonance nibble -> Q.
    pub resonance: ResonanceMap,
    /// Soft limit of the band-pass state, in voice units (`filter.rs`):
    /// s <- sat * tanh(s / sat). Large = near linear.
    pub sat: f64,
    /// Weights of VOL bits 0..3 in the volume DAC. The level of VOL v is
    /// the sum of the weights of v's set bits over the sum of all four, so
    /// VOL 0 = 0 and VOL 15 = 1 whatever the weights.
    pub volume_bit_weights: [f64; 4],
    /// Per-voice DAC DC in voice units, envelope-scaled (`voice.rs`).
    pub voice_dc: f64,
    /// Mixer/volume-stage DC in voice units (`chip.rs`).
    pub mix_dc: f64,
}

/// 6581R4AR.
///
/// Cutoff: the S5.12 R2 anchors, disclosure at
/// `filter::CUTOFF_ANCHORS_6581_LO`. Output DC: S2's voice DC 0.25 and
/// mixer DC 0.5, both INFERRED tuning (`voice.rs`, `chip.rs` headers).
///
/// Volume DAC, INFERRED. Public record: a $D418 write clicks loudly on a
/// 6581 and not on an 8580. The loudness comes from the mixer DC the DAC
/// scales (`mix_dc`, kept from S2). No verified per-bit weights of the
/// 6581's 4-bit volume DAC exist in the public record, so the weights are
/// a disclosed guess, [1.0, 2.0, 3.9, 7.6]: a binary-weighted DAC whose two
/// upper bits run a little under their ideal 4 and 8, the usual shape of an
/// untrimmed NMOS DAC. The result stays monotonic. Its largest error is at
/// the midscale 7 -> 8 transition, +/-0.0092 of full scale (level(7) =
/// 0.4759 vs 0.4667, level(8) = 0.5241 vs 0.5333). There, the 7 -> 8 step
/// is 0.0483 instead of 1/15 = 0.0667. VOL 15 is exactly 1, so every
/// full-volume render is unchanged. Ears-gate item.
pub const R4AR: RevisionProfile = RevisionProfile {
    revision: DieRevision::R4AR,
    cutoff_anchors_lo: &[
        (0, 220.0),
        (0x200, 420.0),
        (0x300, 1_600.0),
        (0x3FF, 6_000.0),
    ],
    cutoff_anchors_hi: &R4AR_ANCHORS_HI,
    resonance: ResonanceMap::Exponential { divisor: 12.0 },
    sat: 1.0,
    volume_bit_weights: [1.0, 2.0, 3.9, 7.6],
    voice_dc: 0.25,
    mix_dc: 0.5,
};

const R4AR_ANCHORS_HI: [(u16, f64); 4] = [
    (0x400, 4_600.0),
    (0x500, 9_500.0),
    (0x600, 14_500.0),
    (0x7FF, 18_000.0),
];

/// The GoatTracker-reference 6581 filter (S5.16). Filter traits only; the
/// output DC, gain and volume DAC are R4AR's, since feeding GT's register
/// stream to both chips gave matching overall levels (RMS ratio 0.97-1.00).
///
/// MEASURED, not published: a two-pole fit (0.03-0.06 dB RMS) of GT 2.72's
/// default 6581 low-pass, noise through the filter, per register and per
/// resonance setting (data and method in `.ai/sid-6581-gt-fit-notes.md`).
/// - Cutoff: 14 low-piece anchors, flat near 220 Hz up to 0x100 then
///   climbing; R4AR's four chords ran 15-25% high across 0x080-0x1C0. Above
///   the 4 kHz ceiling the high piece is R4AR's, untouched.
/// - Resonance: Q = 0.707 + 0.0698 * res (measured 0.72 at 0, 1.76 at 15).
/// - Soft limit: GT's filter core is linear; see `sat` for the level kept.
pub const GT_REF: RevisionProfile = RevisionProfile {
    revision: DieRevision::GtRef,
    cutoff_anchors_lo: &[
        (0, 219.0),
        (0x080, 229.0),
        (0x100, 248.0),
        (0x140, 266.0),
        (0x180, 299.0),
        (0x1C0, 339.0),
        (0x200, 417.0),
        (0x240, 550.0),
        (0x280, 778.0),
        (0x2C0, 1_139.0),
        (0x300, 1_628.0),
        (0x340, 2_329.0),
        (0x380, 3_331.0),
        (0x3FF, 6_000.0),
    ],
    cutoff_anchors_hi: &R4AR_ANCHORS_HI,
    resonance: ResonanceMap::Linear { slope: 0.0698 },
    sat: 4.0,
    volume_bit_weights: R4AR.volume_bit_weights,
    voice_dc: R4AR.voice_dc,
    mix_dc: R4AR.mix_dc,
};

impl RevisionProfile {
    /// Output gain from the S2 headroom rule (`chip.rs` header): with every
    /// DC term at its worst, the peak equals the 8580's three full-scale
    /// voices. CHIP_GAIN * 3 / (3 * (1 + voice_dc) + mix_dc).
    pub const fn chip_gain(&self, chip_gain_8580: f64) -> f64 {
        chip_gain_8580 * 3.0 / (3.0 * (1.0 + self.voice_dc) + self.mix_dc)
    }

    /// Volume DAC level of VOL `vol` (low nibble), 0..=1.
    pub fn volume_level(&self, vol: u8) -> f64 {
        let w = &self.volume_bit_weights;
        let set = (0..4)
            .filter(|b| vol >> b & 1 != 0)
            .fold(0.0, |a, b| a + w[b]);
        set / w.iter().fold(0.0, |a, x| a + x)
    }

    /// `volume_level` for every VOL value.
    pub fn volume_table(&self) -> [f64; 16] {
        std::array::from_fn(|v| self.volume_level(v as u8))
    }
}
