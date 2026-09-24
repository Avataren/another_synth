//! One SID chip: three voices, sync/ring coupling, the filter with its
//! routing, master volume, OSC3/ENV3 readback, and the render loop that turns
//! the cycle-counted digital core into output samples.
//!
//! Sources (GPL-free): MOS 6581/8580 datasheet register map and bit
//! descriptions ($D400-$D41C); public hardware notes on sync timing.
//!
//! Register map (offsets from the chip base, write-only unless noted):
//!   voice n (n = 0..2) at 7n: +0 FREQ LO, +1 FREQ HI, +2 PW LO,
//!     +3 PW HI (bits 0-3), +4 CONTROL, +5 ATTACK/DECAY, +6 SUSTAIN/RELEASE
//!   $15 FC LO (bits 0-2), $16 FC HI, $17 RES (bits 4-7) / FILTEX, FILT3-1
//!   (bits 3..0), $18 3OFF (bit 7) / HP BP LP (bits 6-4) / VOL (bits 3-0)
//!   read: $19 POTX, $1A POTY, $1B OSC3, $1C ENV3
//!
//! Per chip cycle (INFERRED ordering; the hardware does it all in one
//! clock, and this is the order that gives the documented results):
//!   1. every accumulator advances (or is held at 0 under TEST), and each
//!      voice latches whether its MSB went 0 -> 1 this cycle;
//!   2. sync: a voice with SYNC set is reset to 0 when its source's MSB rose
//!      this cycle. Sources per the datasheet: voice 1 <- 3, 2 <- 1, 3 <- 2.
//!      Only the rising edge counts. The source's own wrap (MSB 1 -> 0) does
//!      not sync. INFERRED from public hardware notes: a source that is
//!      itself being sync-reset this cycle does not propagate its MSB rise,
//!      because its MSB never presents as 1;
//!   3. noise clock, envelope clock, waveform latch (ring mod reads the
//!      source accumulator after step 2).
//! TEST on a sync source holds it at 0, so its MSB never rises and its
//! destination runs free (oscillator lockout). TEST on a destination holds
//! it at 0, and sync resets are then no-ops.
//!
//! Routing (datasheet): FILTn = 1 sends voice n through the filter, else it
//! goes straight to the output. The filter output is the sum of the selected
//! LP/BP/HP taps; with no mode bit set the filtered voices vanish. 3OFF
//! removes voice 3 from the direct path only (datasheet: "Setting Voice 3
//! to bypass the Filter (FILT 3 = 0) and setting 3 OFF to a one prevents
//! Voice 3 from reaching the audio output"). A filtered voice 3 is
//! unaffected. FILTEX routes the external input, which is not modelled
//! (silent). Master volume scales the mix. On the 8580 it is linear, VOL / 15
//! (INFERRED: 8580 volume DAC treated as linear, no 6581-style volume DC
//! step). The 6581's DAC is nonlinear (S5.15, below).
//!
//! Readback (datasheet): OSC3 = the upper 8 bits of voice 3's waveform
//! output (including combined waveforms, ring mod and a held waveform 0),
//! ENV3 = voice 3's envelope level. Both work whether or not voice 3 is
//! audible. POTX/POTY and the write-only registers read 0 here (INFERRED
//! simplification: the real chip returns paddle counts, or a decaying copy of
//! the last bus value for write-only registers).
//!
//! Sample-rate model (plan §1.1): the digital core above is cycle-counted
//! at PAL 985 248 Hz. Each output sample is the boxcar average of the ~22.34
//! (44.1 kHz) or ~20.53 (48 kHz) cycles it spans, a cheap anti-alias
//! decimator whose first null sits at the output rate. The filter,
//! volume and output coupling then run at the output rate. Register writes
//! land between chip cycles, but callers can only interleave them with
//! `render` at sample boundaries. This is a sample-rate approximation of the
//! analog path over an exact digital core, not cycle-exact audio.
//!
//! Output stage, 6581 (S2). Public knowledge: the 6581's output carries a
//! large DC level. Part of it is per voice and envelope-scaled (`voice.rs`).
//! Part of it sits in the mixer/volume stage: the volume DAC scales a
//! standing DC. That second part is what makes the classic "$D418 volume
//! digi" loud on a 6581 and near-silent on an 8580. Modelled as
//!   x = (filter + direct + MIX_DC_6581) * level(VOL) * CHIP_GAIN_6581
//! (S2 had level(VOL) = VOL / 15; S5.15's table is below).
//! INFERRED: MIX_DC_6581 = 0.5 (half a full-scale voice) is a tuning guess.
//! The output coupling (16 Hz DC blocker, shared with the 8580) removes any
//! steady DC. So both DC terms are heard only as transients: a volume write
//! gives a step of MIX_DC * dlevel * gain that decays as r^n (r =
//! e^(-2 pi 16 / fs)), and a note-on gives a VOICE_DC-sized thump.
//! Gain calibration: the 6581 gain is derived, not guessed, from the S0/S1
//! headroom rule. With every DC term at its worst, the 6581's peak equals
//! the 8580's three full-scale voices:
//!   CHIP_GAIN_6581 = CHIP_GAIN * 3 / (3 * (1 + VOICE_DC_6581) + MIX_DC_6581)
//!                  = 0.28 * 3 / (3.75 + 0.5) = 0.84 / 4.25 = 0.197647
//! The same waveform is therefore 20 log10(0.197647 / 0.28) = -3.03 dB
//! quieter on the 6581. The rule is a derivation; the DC values it rests on
//! are the INFERRED guesses above. Level balance is an ears-gate item.
//!
//! Die revision (S5.15). The DC values, the gain rule's inputs, the cutoff
//! anchors and the volume DAC are revision data: they live in
//! `revision::RevisionProfile`, and the 6581 plays `revision::profile_6581()`
//! (6581R4AR). The constants below are aliases of that profile. The volume
//! DAC is the one new trait: level(VOL) comes from the profile's INFERRED
//! bit weights (monotonic, within 0.01 of VOL / 15, exact at 0 and 15;
//! disclosure at `revision::R4AR`). It scales the tone and the mixer DC
//! alike, so a $D418 write steps the DC by MIX_DC * dlevel * gain.
//!
//! Per-voice taps (S4, the app's per-track scopes and spectrum): `render_taps`
//! also writes each voice's own signal, the decimated voice output before
//! the filter, times volume and the model's gain, through a DC blocker of its
//! own. INFERRED/approximate by construction: the filter is shared and (on the
//! 6581) nonlinear, so a filtered voice's tap shows it unfiltered; the mix
//! itself is unchanged (`render` and `render_taps` produce the same samples).
//! A voice mask (`set_voice_mask`, the tracker's mute/solo) drops voices from
//! the mix and their taps; all three on is the datasheet chip.

use super::filter::Filter;
use super::revision::{profile_6581, RevisionProfile};
use super::voice::Voice;
use super::waveform::SYNC;
use super::{SidError, SidModel, DEFAULT_SAMPLE_RATE, PAL_CLOCK_HZ};

/// Headroom constant: three full-scale voices at volume 15 peak at 3.0; the
/// resonant filter can add ~+8 dB on top. INFERRED tuning (carried from S0).
pub const CHIP_GAIN: f64 = 0.28;

/// 6581 mixer/volume-stage DC in voice units. INFERRED tuning (header),
/// from the revision profile.
pub const MIX_DC_6581: f64 = profile_6581().mix_dc;

/// 6581 output gain, from the headroom rule in the header.
pub const CHIP_GAIN_6581: f64 = profile_6581().chip_gain(CHIP_GAIN);

/// Corner of the output AC coupling (the C64's output capacitor), Hz.
/// INFERRED tuning (carried from S0).
pub const DC_BLOCK_HZ: f64 = 16.0;

/// Register offsets.
pub const REG_FC_LO: u8 = 0x15;
pub const REG_FC_HI: u8 = 0x16;
pub const REG_RES_FILT: u8 = 0x17;
pub const REG_MODE_VOL: u8 = 0x18;
pub const REG_POTX: u8 = 0x19;
pub const REG_POTY: u8 = 0x1A;
pub const REG_OSC3: u8 = 0x1B;
pub const REG_ENV3: u8 = 0x1C;

/// $18 bit 7.
pub const VOICE3_OFF: u8 = 0x80;

/// Sync/ring source of voice `i`.
#[inline]
pub const fn source_of(i: usize) -> usize {
    (i + 2) % 3
}

#[derive(Debug, Clone)]
pub struct Chip {
    model: SidModel,
    sample_rate: f64,
    voices: [Voice; 3],
    filter: Filter,
    fc: u16,
    res_filt: u8,
    mode_vol: u8,
    cycles_per_sample: f64,
    cycle_frac: f64,
    cycles: u64,
    dc_x: f64,
    dc_y: f64,
    dc_r: f64,
    voice_mask: u8,
    tap_x: [f64; 3],
    tap_y: [f64; 3],
    volume_dac: [f64; 16],
    /// Register writes waiting for their cycle (`write_after`): (chip cycle,
    /// register, value), in the order they were scheduled.
    pending: Vec<(u64, u8, u8)>,
}

/// All three voices heard: the mask of a powered-on chip.
pub const ALL_VOICES: u8 = 0x07;

impl Chip {
    /// A powered-on chip at 44.1 kHz output.
    pub fn new(model: SidModel) -> Result<Chip, SidError> {
        Chip::with_sample_rate(model, DEFAULT_SAMPLE_RATE)
    }

    /// A powered-on chip rendering at `sample_rate` Hz. Each instance keeps
    /// its model for life; build another chip to switch models.
    pub fn with_sample_rate(model: SidModel, sample_rate: f64) -> Result<Chip, SidError> {
        Chip::with_profile(model, sample_rate, profile_6581())
    }

    /// A chip whose 6581 filter plays `profile` (the cutoff curve, resonance
    /// map and soft limit; DC, gain and the volume DAC are the default
    /// profile's, which every profile so far shares). An 8580 ignores it.
    pub fn with_profile(model: SidModel, sample_rate: f64, profile: &'static RevisionProfile) -> Result<Chip, SidError> {
        if let Some(reason) = model.unimplemented_reason() {
            return Err(SidError::ModelNotImplemented { model, reason });
        }
        if !(sample_rate.is_finite() && (8_000.0..=192_000.0).contains(&sample_rate)) {
            return Err(SidError::UnsupportedSampleRate(sample_rate));
        }
        Ok(Chip {
            model,
            sample_rate,
            voices: [Voice::new(model); 3],
            filter: Filter::with_profile(model, profile, sample_rate),
            fc: 0,
            res_filt: 0,
            mode_vol: 0,
            cycles_per_sample: PAL_CLOCK_HZ / sample_rate,
            cycle_frac: 0.0,
            cycles: 0,
            dc_x: 0.0,
            dc_y: 0.0,
            dc_r: (-2.0 * std::f64::consts::PI * DC_BLOCK_HZ / sample_rate).exp(),
            voice_mask: ALL_VOICES,
            pending: Vec::new(),
            tap_x: [0.0; 3],
            tap_y: [0.0; 3],
            volume_dac: match model {
                SidModel::Sid8580 => std::array::from_fn(|v| v as f64 / 15.0),
                SidModel::Sid6581 => profile_6581().volume_table(),
            },
        })
    }

    /// Which voices reach the output (bit `i` = voice `i`; `ALL_VOICES` is the
    /// real chip). A masked voice still runs (sync, ring mod and OSC3/ENV3
    /// are unaffected); only its contribution to the mix and its tap drop.
    pub fn set_voice_mask(&mut self, mask: u8) {
        self.voice_mask = mask & ALL_VOICES;
    }

    pub fn voice_mask(&self) -> u8 {
        self.voice_mask
    }

    /// The volume DAC's level for VOL `vol` (low nibble), 0..=1: VOL / 15 on
    /// the 8580, the revision profile's table on the 6581.
    pub fn volume_level(&self, vol: u8) -> f64 {
        self.volume_dac[(vol & 0x0F) as usize]
    }

    pub fn model(&self) -> SidModel {
        self.model
    }

    pub fn sample_rate(&self) -> f64 {
        self.sample_rate
    }

    /// Voice `i` (0..=2), read-only.
    pub fn voice(&self, i: usize) -> &Voice {
        &self.voices[i]
    }

    pub fn filter(&self) -> &Filter {
        &self.filter
    }

    /// Chip cycles clocked since power-on.
    pub fn cycles(&self) -> u64 {
        self.cycles
    }

    /// Write a register (offset 0x00..=0x18 from the chip base; higher bits
    /// of `reg` are ignored, read-only offsets are ignored).
    /// Schedules a register write `delay` chip cycles from now; `render`
    /// applies it when the cycle arrives, in scheduling order for equal
    /// cycles. A player uses this to space a frame's writes the way a real
    /// playroutine does (a `lda`/`sta` pair per register), which matters
    /// because the envelope's rate counter keeps running between them (the
    /// ADSR delay bug, `envelope.rs`).
    pub fn write_after(&mut self, delay: u64, reg: u8, val: u8) {
        self.pending.push((self.cycles + delay, reg, val));
    }

    /// Applies every scheduled write at once, whatever its cycle: for a caller
    /// that steps a player without rendering audio and reads the registers.
    pub fn flush_writes(&mut self) {
        for (_, reg, val) in std::mem::take(&mut self.pending) {
            self.write(reg, val);
        }
    }

    /// Applies every scheduled write whose cycle has come.
    #[inline]
    fn apply_due_writes(&mut self) {
        let now = self.cycles;
        let mut i = 0;
        while i < self.pending.len() {
            if self.pending[i].0 <= now {
                let (_, reg, val) = self.pending.remove(i);
                self.write(reg, val);
            } else {
                i += 1;
            }
        }
    }

    pub fn write(&mut self, reg: u8, val: u8) {
        let reg = reg & 0x1F;
        match reg {
            0x00..=0x14 => {
                let v = &mut self.voices[(reg / 7) as usize];
                match reg % 7 {
                    0 => v.set_freq_lo(val),
                    1 => v.set_freq_hi(val),
                    2 => v.set_pw_lo(val),
                    3 => v.set_pw_hi(val),
                    4 => v.set_control(val),
                    5 => v.set_ad(val),
                    _ => v.set_sr(val),
                }
            }
            REG_FC_LO => {
                self.fc = (self.fc & 0x7F8) | (val & 0x07) as u16;
                self.filter.set(self.fc, self.res_filt >> 4);
            }
            REG_FC_HI => {
                self.fc = (self.fc & 0x007) | ((val as u16) << 3);
                self.filter.set(self.fc, self.res_filt >> 4);
            }
            REG_RES_FILT => {
                self.res_filt = val;
                self.filter.set(self.fc, val >> 4);
            }
            REG_MODE_VOL => {
                self.mode_vol = val;
                self.filter.set_mode(val);
            }
            _ => {}
        }
    }

    /// Read a register. Only OSC3 and ENV3 carry chip state here.
    pub fn read(&self, reg: u8) -> u8 {
        match reg & 0x1F {
            REG_OSC3 => (self.voices[2].waveform() >> 4) as u8,
            REG_ENV3 => self.voices[2].envelope_level(),
            _ => 0,
        }
    }

    /// Advance the digital core by one chip cycle.
    #[inline]
    pub fn clock(&mut self) {
        if !self.pending.is_empty() {
            self.apply_due_writes();
        }
        for v in self.voices.iter_mut() {
            v.clock_accumulator();
        }
        let raw: [bool; 3] = std::array::from_fn(|i| {
            self.voices[i].has_control(SYNC) && self.voices[source_of(i)].msb_rising()
        });
        for (i, &sync) in raw.iter().enumerate() {
            if sync && !raw[source_of(i)] {
                self.voices[i].sync_reset();
            }
        }
        let accs: [u32; 3] = std::array::from_fn(|i| self.voices[i].accumulator());
        for (i, v) in self.voices.iter_mut().enumerate() {
            v.finish_cycle(accs[source_of(i)]);
        }
        self.cycles += 1;
    }

    /// Advance the digital core by `n` chip cycles (no audio produced).
    pub fn clock_cycles(&mut self, n: u64) {
        for _ in 0..n {
            self.clock();
        }
    }

    /// Fill `out` with samples at the chip's sample rate, clocking the core
    /// through the cycles each sample spans.
    pub fn render(&mut self, out: &mut [f32]) {
        self.render_inner(out, None);
    }

    /// `render`, and each voice's own signal into `taps[i]` (see the header).
    /// Every tap must be at least `out.len()` long. The mix is the one
    /// `render` produces, sample for sample.
    pub fn render_taps(&mut self, out: &mut [f32], taps: [&mut [f32]; 3]) {
        self.render_inner(out, Some(taps));
    }

    fn render_inner(&mut self, out: &mut [f32], mut taps: Option<[&mut [f32]; 3]>) {
        let filt_bits = self.res_filt & 0x07;
        let voice3_direct = self.mode_vol & VOICE3_OFF == 0;
        let volume = self.volume_level(self.mode_vol);
        let mask = self.voice_mask;
        let tap_gain = volume
            * match self.model {
                SidModel::Sid8580 => CHIP_GAIN,
                SidModel::Sid6581 => CHIP_GAIN_6581,
            };
        for (k, o) in out.iter_mut().enumerate() {
            self.cycle_frac += self.cycles_per_sample;
            let n = self.cycle_frac as u32;
            self.cycle_frac -= n as f64;
            let mut sum = [0.0f64; 3];
            for _ in 0..n {
                self.clock();
                for (s, v) in sum.iter_mut().zip(self.voices.iter()) {
                    *s += v.output();
                }
            }
            let mut filt_in = 0.0;
            let mut direct = 0.0;
            for (i, s) in sum.iter().enumerate() {
                let x = s / n.max(1) as f64;
                if let Some(taps) = taps.as_mut() {
                    let t = if mask & (1 << i) != 0 { x * tap_gain } else { 0.0 };
                    let y = t - self.tap_x[i] + self.dc_r * self.tap_y[i];
                    self.tap_x[i] = t;
                    self.tap_y[i] = y;
                    taps[i][k] = y as f32;
                }
                if mask & (1 << i) == 0 {
                    continue;
                }
                if filt_bits & (1 << i) != 0 {
                    filt_in += x;
                } else if i != 2 || voice3_direct {
                    direct += x;
                }
            }
            let x = match self.model {
                SidModel::Sid8580 => (self.filter.process(filt_in) + direct) * volume * CHIP_GAIN,
                SidModel::Sid6581 => {
                    (self.filter.process(filt_in) + direct + MIX_DC_6581) * volume * CHIP_GAIN_6581
                }
            };
            let y = x - self.dc_x + self.dc_r * self.dc_y;
            self.dc_x = x;
            self.dc_y = y;
            *o = y as f32;
        }
    }
}
