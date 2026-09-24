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
//!   (220 Hz..18 kHz) is quoted for 6581R4AR, which fits.
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
}

impl DieRevision {
    pub const fn profile(self) -> &'static RevisionProfile {
        match self {
            DieRevision::R4AR => &R4AR,
        }
    }
}

/// The revision `SidModel::Sid6581` plays. The one swap point.
pub const SID6581_REVISION: DieRevision = DieRevision::R4AR;

/// The profile `SidModel::Sid6581` plays.
pub const fn profile_6581() -> &'static RevisionProfile {
    SID6581_REVISION.profile()
}

/// Everything revision-specific about a 6581.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RevisionProfile {
    pub revision: DieRevision,
    /// Cutoff anchors (register, Hz), low piece: 0..=0x3FF (FC_HI bit 7
    /// clear). Log-linear between anchors (`filter::cutoff_hz_6581`).
    pub cutoff_anchors_lo: [(u16, f64); 4],
    /// Cutoff anchors, high piece: 0x400..=0x7FF (FC_HI bit 7 set).
    pub cutoff_anchors_hi: [(u16, f64); 4],
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
    cutoff_anchors_lo: [
        (0, 220.0),
        (0x200, 420.0),
        (0x300, 1_600.0),
        (0x3FF, 6_000.0),
    ],
    cutoff_anchors_hi: [
        (0x400, 4_600.0),
        (0x500, 9_500.0),
        (0x600, 14_500.0),
        (0x7FF, 18_000.0),
    ],
    volume_bit_weights: [1.0, 2.0, 3.9, 7.6],
    voice_dc: 0.25,
    mix_dc: 0.5,
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
