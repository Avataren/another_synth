//! 6581 die-revision profiles (S5.15, extended S5.16). Every characteristic
//! that could differ between 6581 die revisions lives here, in one
//! `RevisionProfile`, so adding a revision is adding a profile and changing
//! `SID6581_REVISION`. Nothing else in the engine names a revision.
//!
//! Selection is engine-side: `SidModel::Sid6581` always plays
//! `profile_6581()`. No .sng/.sid field encodes the die revision, so there
//! is nothing in the file format to read it from.
//!
//! Sources (GPL-free; `.ai/sid-r4ar-research-notes.md`,
//! `.ai/sid-r3-research-notes.md`):
//! - Wikipedia, "MOS Technology 6581", Revisions: R1 was a prototype; then
//!   R2, R3, R4 and R4AR with "no substantial alterations", only input-pin
//!   protection/buffering, silicon grade and packaging changes.
//! - C64-Wiki, "SID": 6581R3 was produced 42/1985-07/1986, 6581R4AR
//!   22/1986-06/1987, the last 6581. Trivia: every write to the 6581's
//!   volume register gave an audible click (the $D418 sample trick); on the
//!   8580 "samples were inaudible".
//!
//! S5.16 R3 classification (`.ai/sid-r3-research-notes.md`): the public
//! record carries NO R3-specific measured trait. reSID/reSIDfp have no
//! die-revision parameterization at all; the only 6581 whose filter parts
//! were measured is the R4AR 0687 14. The R3 profile therefore inherits the
//! full measured model from R4AR and differs from it only in the
//! discriminant. It is marked on every field as INHERITED (not SPEC: the
//! measurements were not taken on an R3, and not INFERRED: nothing is
//! guessed beyond what R4AR already carries).
//!
//! Trait classification:
//! - Cutoff curve (S5.16): the anchor points are the S5.12 measured
//!   community figures, and the register->Hz map is now driven through the
//!   kinked 11-bit f0 DAC and the VCR drive law of the measured R4AR
//!   parameter set (`filter::cutoff_hz_6581`). The kink parameters, DAC
//!   bias/scale, VCR threshold and voice DC below are SPEC (values measured
//!   on 6581R4AR 0687 14 and published in the reference engines).
//! - FC_HI $7F -> $80 step: now emerges from the model. In the kinked DAC
//!   the sum of the low ten bits outweighs the top bit, so the map drops
//!   there; the measured anchor pair (6000 -> 4600 Hz) stays the
//!   calibration skeleton.
//! - Output DC (voice DC, mixer DC) and the gain derived from them:
//!   GENERIC-6581. They keep S2's INFERRED values (`voice.rs`, `chip.rs`).
//! - Volume DAC: GENERIC-6581 vs 8580. The 8580 stays linear, VOL / 15. See
//!   `R4AR` for the INFERRED 6581 table. S5.16 research found no measured
//!   per-bit volume-DAC data for ANY 6581 revision (both reference engines
//!   model the volume DAC as ideal), so the table stays INFERRED.

/// A 6581 die revision the engine can play.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DieRevision {
    /// 6581R3 (1985-1986). The revision most real SID songs were written
    /// for (Morten, S5.16): it was in production through the C64's peak
    /// years, before the short R4/R4AR run.
    R3,
    /// 6581R4AR (1986-1987), the last and most common late 6581, and the
    /// chip whose filter parts the reference engines measured.
    R4AR,
}

impl DieRevision {
    pub const fn profile(self) -> &'static RevisionProfile {
        match self {
            DieRevision::R3 => &R3,
            DieRevision::R4AR => &R4AR,
        }
    }
}

/// The revision `SidModel::Sid6581` plays. The one swap point.
pub const SID6581_REVISION: DieRevision = DieRevision::R3;

/// The profile `SidModel::Sid6581` plays.
pub const fn profile_6581() -> &'static RevisionProfile {
    SID6581_REVISION.profile()
}

/// Everything revision-specific about a 6581.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct RevisionProfile {
    pub revision: DieRevision,
    /// Cutoff anchors (register, Hz), low piece: 0..=0x3FF (FC_HI bit 7
    /// clear). S5.16: the measured calibration skeleton that the drive
    /// map (`filter::cutoff_hz_6581`) hits exactly; no longer an
    /// interpolation table.
    pub cutoff_anchors_lo: [(u16, f64); 4],
    /// Cutoff anchors, high piece: 0x400..=0x7FF (FC_HI bit 7 set).
    pub cutoff_anchors_hi: [(u16, f64); 4],
    /// Kinked 11-bit f0 DAC, R over 2R mismatch (SPEC: 2.20 for the 6581,
    /// adopted from the measured R4AR parameter set; the 8580 measures
    /// 2.00). Higher means the ladder's upper bits weigh relatively less.
    pub f0_dac_2r_div_r: f64,
    /// Kinked 11-bit f0 DAC termination (SPEC: the 6581 ladder has NO 2R
    /// termination at bit 0; the 8580 has one).
    pub f0_dac_terminated: bool,
    /// f0 DAC bias (SPEC: 6.65 V, measured R4AR parameter set): the DAC
    /// output voltage at register 0.
    pub f0_dac_zero: f64,
    /// f0 DAC scale (SPEC: 2.63 V over the 11-bit range, measured R4AR).
    pub f0_dac_scale: f64,
    /// VCR threshold voltage (SPEC: 1.31 V, measured R4AR parameter set).
    pub vcr_vth: f64,
    /// VCR reference voltage: the DC level the filter integrator rides at
    /// (SPEC: 5.0 V, the measured R4AR voice DC voltage). The VCR drive is
    /// the excess Vw - vcr_vth - vcr_vx.
    pub vcr_vx: f64,
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
/// `filter::CUTOFF_ANCHORS_6581_LO`; since S5.16 they calibrate the
/// drive-segmented map instead of a log-linear interpolation. The kink and
/// VCR parameters are the measured R4AR set (SPEC, `RevisionProfile` doc).
/// Output DC: S2's voice DC 0.25 and mixer DC 0.5, both INFERRED tuning
/// (`voice.rs`, `chip.rs` headers).
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
    f0_dac_2r_div_r: 2.20,
    f0_dac_terminated: false,
    f0_dac_zero: 6.65,
    f0_dac_scale: 2.63,
    vcr_vth: 1.31,
    vcr_vx: 5.0,
    volume_bit_weights: [1.0, 2.0, 3.9, 7.6],
    voice_dc: 0.25,
    mix_dc: 0.5,
};

/// 6581R3.
///
/// EVERY field is INHERITED from `R4AR` (S5.16 research: the public record
/// has no R3-specific measurement — see the module header and
/// `.ai/sid-r3-research-notes.md`). The discriminant is the only
/// difference. The cutoff map, the volume DAC and the DC terms all play
/// exactly as R4AR's; when a measured R3 trait surfaces, its field moves
/// here and the INHERITED mark comes off.
pub const R3: RevisionProfile = RevisionProfile {
    revision: DieRevision::R3,
    cutoff_anchors_lo: R4AR.cutoff_anchors_lo,
    cutoff_anchors_hi: R4AR.cutoff_anchors_hi,
    f0_dac_2r_div_r: R4AR.f0_dac_2r_div_r,
    f0_dac_terminated: R4AR.f0_dac_terminated,
    f0_dac_zero: R4AR.f0_dac_zero,
    f0_dac_scale: R4AR.f0_dac_scale,
    vcr_vth: R4AR.vcr_vth,
    vcr_vx: R4AR.vcr_vx,
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
