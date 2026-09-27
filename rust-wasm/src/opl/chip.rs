//! The OPL3 (YMF262) chip at its native rate, one sample per `clock`.
//!
//! A port of ymfm's `fm_engine_base` / `fm_channel` / `ymf262` path
//! (`ymfm_fm.ipp`, `ymfm_opl.cpp`). OPL2 music runs on it in compatibility
//! mode (NEW, 0x105 bit 0, clear), which is what a Sound Blaster Pro 2 or
//! SB16 owner heard: 9 of the 18 channels addressable, waveforms 0..3, both
//! outputs on, no YM3014 DAC quantisation.
//!
//! O0 scope (`.ai/plan-opl.md` §5): 2-op channels, all 18, both modes,
//! LFO AM/PM. Not yet: 4-op connections (0x104) and rhythm mode (0xBD bit 5),
//! both O1; timers and status are never needed for playback.

use super::operator::{EnvState, OpRegs, Operator};
use super::tables::{build_waveforms, WAVEFORM_LENGTH};

/// YMF262 master clock (Hz) and the divider to one output sample.
pub const OPL3_CLOCK: f64 = 14_318_180.0;
pub const OPL3_CLOCK_DIVIDER: f64 = 288.0;
/// ≈ 49 715.9 Hz.
pub const NATIVE_RATE: f64 = OPL3_CLOCK / OPL3_CLOCK_DIVIDER;

pub const CHANNELS: usize = 18;
pub const OPERATORS: usize = 36;

/// Register offset of channel `ch` (0..17).
#[inline]
fn channel_offset(ch: usize) -> usize {
    (ch % 9) + 0x100 * (ch / 9)
}

/// Register offset of operator `op` (0..35).
#[inline]
fn operator_offset(op: usize) -> usize {
    (op % 18) + 2 * ((op % 18) / 6) + 0x100 * (op / 18)
}

/// The two operators of 2-op channel `ch`.
#[inline]
fn channel_operators(ch: usize) -> [usize; 2] {
    let (bank, c) = (ch / 9, ch % 9);
    let first = c + 3 * (c / 3);
    [first + 18 * bank, first + 3 + 18 * bank]
}

#[derive(Clone, Copy, Default, Debug)]
struct Channel {
    feedback: [i16; 2],
    feedback_in: i16,
    active: bool,
}

pub struct Chip {
    regs: [u8; 0x200],
    ops: Vec<Operator>,
    chans: [Channel; CHANNELS],
    waveforms: Box<[[u16; WAVEFORM_LENGTH]; 8]>,
    env_counter: u32,
    modified: bool,
    prepare_count: u32,
    lfo_am_counter: u16,
    lfo_pm_counter: u16,
    lfo_am: u8,
    noise_lfsr: u32,
    /// Bit per channel: 1 plays, 0 mutes (the chip still runs).
    channel_mask: u32,
}

impl Default for Chip {
    fn default() -> Self {
        Self::new()
    }
}

impl Chip {
    pub fn new() -> Chip {
        Chip {
            regs: [0; 0x200],
            ops: vec![Operator::default(); OPERATORS],
            chans: [Channel::default(); CHANNELS],
            waveforms: build_waveforms(),
            env_counter: 0,
            modified: true,
            prepare_count: 0,
            lfo_am_counter: 0,
            lfo_pm_counter: 0,
            lfo_am: 0,
            noise_lfsr: 1,
            channel_mask: (1 << CHANNELS) - 1,
        }
    }

    #[inline]
    fn newflag(&self) -> bool {
        self.regs[0x105] & 1 != 0
    }

    /// Write a register, 0x000..0x1FF. In compatibility mode the second bank
    /// aliases the first, except 0x105 itself (ymfm `write_address_hi`,
    /// "tests reveal").
    pub fn write(&mut self, reg: u16, val: u8) {
        let mut reg = (reg & 0x1ff) as usize;
        if reg & 0x100 != 0 && !self.newflag() && reg != 0x105 {
            reg &= 0xff;
        }
        self.modified = true;
        // The mode register ignores its low bits when bit 7 (IRQ reset) is set.
        if reg == 0x04 && val & 0x80 != 0 {
            self.regs[reg] |= 0x80;
        } else {
            self.regs[reg] = val;
        }
        if reg & 0xf0 == 0xb0 && reg & 0x0f < 9 {
            let ch = (reg & 0x0f) + 9 * (reg >> 8);
            let on = (val >> 5) & 1;
            for op in channel_operators(ch) {
                self.ops[op].keyon_live = on as u32;
            }
        }
    }

    /// The last value written to a register.
    pub fn written(&self, reg: u16) -> u8 {
        self.regs[(reg & 0x1ff) as usize]
    }

    pub fn set_channel_mask(&mut self, mask: u32) {
        self.channel_mask = mask & ((1 << CHANNELS) - 1);
    }

    fn op_regs(&self, ch: usize, op: usize) -> OpRegs {
        let (co, oo) = (channel_offset(ch), operator_offset(op));
        let block_freq = (((self.regs[0xb0 + co] & 0x1f) as u32) << 8) | self.regs[0xa0 + co] as u32;
        OpRegs {
            r20: self.regs[0x20 + oo],
            r40: self.regs[0x40 + oo],
            r60: self.regs[0x60 + oo],
            r80: self.regs[0x80 + oo],
            re0: self.regs[0xe0 + oo],
            block_freq,
            note_select: ((self.regs[0x08] >> 6) & 1) as u32,
            waveform_bits: if self.newflag() { 3 } else { 2 },
        }
    }

    /// Advance the noise LFSR and both LFOs; returns the raw PM value.
    fn clock_noise_and_lfo(&mut self) -> i32 {
        let l = self.noise_lfsr << 1;
        self.noise_lfsr = l | (((l >> 23) ^ (l >> 9) ^ (l >> 8) ^ (l >> 1)) & 1);

        // AM: a 210×64-step triangle, ≈ 3.7 Hz.
        let am_counter = self.lfo_am_counter as u32;
        self.lfo_am_counter = self.lfo_am_counter.wrapping_add(1);
        if am_counter >= 210 * 64 - 1 {
            self.lfo_am_counter = 0;
        }
        let am_depth = ((self.regs[0xbd] >> 7) & 1) as u32;
        let shift = 9 - 2 * am_depth;
        let tri = if am_counter < 105 * 64 { am_counter } else { 210 * 64 + 63 - am_counter };
        self.lfo_am = (tri >> shift) as u8;

        // PM: 8 steps of 1024 samples, ≈ 6.1 Hz.
        let pm_counter = self.lfo_pm_counter as u32;
        self.lfo_pm_counter = self.lfo_pm_counter.wrapping_add(1);
        const PM_SCALE: [i32; 8] = [8, 4, 0, -4, -8, -4, 0, 4];
        let pm_depth = ((self.regs[0xbd] >> 6) & 1) as u32;
        PM_SCALE[((pm_counter >> 10) & 7) as usize] >> (pm_depth ^ 1)
    }

    /// Advance one native-rate sample (ymfm `fm_engine_base::clock`).
    fn clock(&mut self) {
        if self.modified || {
            let due = self.prepare_count >= 4096;
            self.prepare_count += 1;
            due
        } {
            for ch in 0..CHANNELS {
                let mut active = false;
                for op in channel_operators(ch) {
                    let r = self.op_regs(ch, op);
                    active |= self.ops[op].prepare(&r);
                }
                self.chans[ch].active = active;
            }
            self.modified = false;
            self.prepare_count = 0;
        }

        self.env_counter = self.env_counter.wrapping_add(4);
        let lfo_raw_pm = self.clock_noise_and_lfo();

        for ch in 0..CHANNELS {
            let c = &mut self.chans[ch];
            c.feedback[0] = c.feedback[1];
            c.feedback[1] = c.feedback_in;
            for op in channel_operators(ch) {
                self.ops[op].clock(self.env_counter >> 2, lfo_raw_pm);
            }
        }
    }

    /// One 2-op channel's contribution (ymfm `output_2op`, OPL3: no
    /// modulator delay). Returns the value and which outputs it feeds.
    fn output_2op(&mut self, ch: usize) -> Option<(i32, bool, bool)> {
        let co = channel_offset(ch);
        let c0 = self.regs[0xc0 + co];
        let am_offset = self.lfo_am as u32;
        let [m, cr] = channel_operators(ch);

        let feedback = ((c0 >> 1) & 7) as u32;
        let mut opmod = 0i32;
        if feedback != 0 {
            let c = &self.chans[ch];
            opmod = (c.feedback[0] as i32 + c.feedback[1] as i32) >> (10 - feedback);
        }
        let mo = &self.ops[m];
        let op1 = mo.compute_volume(mo.phase_index().wrapping_add(opmod as u32), am_offset, &self.waveforms);
        self.chans[ch].feedback_in = op1 as i16;

        let (left, right) = if self.newflag() { (c0 & 0x10 != 0, c0 & 0x20 != 0) } else { (true, true) };
        let any = if self.newflag() { c0 & 0xf0 != 0 } else { true };
        if !any {
            return None;
        }

        let co = &self.ops[cr];
        let result = if c0 & 1 == 0 {
            let opmod = op1 >> 1;
            co.compute_volume(co.phase_index().wrapping_add(opmod as u32), am_offset, &self.waveforms)
        } else {
            let sum = op1 + co.compute_volume(co.phase_index(), am_offset, &self.waveforms);
            sum.clamp(-32768, 32767)
        };
        Some((result, left, right))
    }

    /// Render one native-rate stereo sample, clamped to 16 bits as the
    /// YMF262's serial output is.
    pub fn clock_sample(&mut self) -> (i16, i16) {
        self.clock();
        let (mut l, mut r) = (0i32, 0i32);
        for ch in 0..CHANNELS {
            if !self.chans[ch].active {
                continue;
            }
            if let Some((v, to_l, to_r)) = self.output_2op(ch) {
                if self.channel_mask & (1 << ch) == 0 {
                    continue;
                }
                if to_l {
                    l += v;
                }
                if to_r {
                    r += v;
                }
            }
        }
        (l.clamp(-32768, 32767) as i16, r.clamp(-32768, 32767) as i16)
    }

    /// Envelope state of operator `op`, for tests and scopes.
    pub fn operator_envelope(&self, op: usize) -> (EnvState, u32) {
        (self.ops[op].env_state, self.ops[op].env_attenuation)
    }
}
