//! The A2M replay engine (batch O7 of `.ai/plan-opl.md`): song position,
//! rows, ticks, effects and macros, producing OPL3 register writes.
//!
//! Adlib Tracker II's source is GPL 3+ and AdPlug's port of its player is
//! LGPL; neither was read (plan decision D1). Every behaviour here was pinned
//! by running AdPlug's `Ca2mv2Player` as a black box on corpus modules and on
//! synthetic ones (`oracle/craft_a2m.py`), and comparing its register writes
//! tick by tick (`oracle/trace-oracle.cpp`). "MEASURED" marks a rule read off
//! those traces.

use super::model::{A2mSong, Cell, FmMacroStep};

/// OPL channel of each track (MEASURED: the reset keys off in this order, and
/// track 1's instrument lands on channel 3's operators). 4-op pairs (tracks
/// 1+2, 3+4, 5+6, 10+11, ...) sit on the chip's pairs (3+0, 4+1, 5+2, ...).
pub const TRACK_CHANNEL: [usize; 18] =
    [3, 0, 4, 1, 5, 2, 6, 7, 8, 12, 9, 13, 10, 14, 11, 15, 16, 17];

/// The same with percussion mode on (MEASURED: the reset's key-off order).
/// Tracks 7-9 move to the second bank so that 16-20 get channels 6-8, the
/// chip's rhythm channels: BD on 6, SD and HH on 7, TT and TC on 8.
pub const TRACK_CHANNEL_PERC: [usize; 20] = [
    3, 0, 4, 1, 5, 2, 15, 16, 17, 12, 9, 13, 10, 14, 11, 6, 7, 8, 8, 7,
];

/// Modulator operator offset of channel `ch % 9`; the carrier is 3 higher.
const OP_OFFSET: [u16; 9] = [0x00, 0x01, 0x02, 0x08, 0x09, 0x0a, 0x10, 0x11, 0x12];

/// F-numbers of C..B (MEASURED: note 1 is C in block 0 at 0x157).
pub const FNUM: [u16; 12] = [
    0x157, 0x16b, 0x181, 0x198, 0x1b0, 0x1ca, 0x1e5, 0x202, 0x220, 0x241, 0x263, 0x287,
];

/// Slide range within a block, and the lowest and highest frequency
/// (MEASURED: a slide below 0x156 moves down a block adding 0x158, above
/// 0x2AE up a block subtracting it, and stops at block 0 0x157 and block 7
/// 0x2AE). The document gives 156h and 2AEh as "octave frequency start/end".
const FREQ_LO: u16 = 0x156;
const FREQ_HI: u16 = 0x2ae;
const FREQ_MIN: u16 = 0x157;
const FREQ_MAX: u16 = 7 << 10 | 0x2ae;

/// The document's default vibrato/tremolo table: half a sine, 32 steps.
const VIB_TABLE: [u8; 32] = [
    0, 24, 49, 74, 97, 120, 141, 161, 180, 197, 212, 224, 235, 244, 250, 253, 255, 253, 250, 244,
    235, 224, 212, 197, 180, 161, 141, 120, 97, 74, 49, 24,
];

mod fx {
    pub const ARPEGGIO: u8 = 0x00;
    pub const SLIDE_UP: u8 = 0x01;
    pub const SLIDE_DOWN: u8 = 0x02;
    pub const PORTA: u8 = 0x03;
    pub const VIBRATO: u8 = 0x04;
    pub const PORTA_VSLIDE: u8 = 0x05;
    pub const VIB_VSLIDE: u8 = 0x06;
    pub const FINE_UP: u8 = 0x07;
    pub const FINE_DOWN: u8 = 0x08;
    pub const SET_MOD_VOL: u8 = 0x09;
    pub const VSLIDE: u8 = 0x0a;
    pub const POS_JUMP: u8 = 0x0b;
    pub const SET_INS_VOL: u8 = 0x0c;
    pub const PAT_BREAK: u8 = 0x0d;
    pub const SET_TEMPO: u8 = 0x0e;
    pub const SET_SPEED: u8 = 0x0f;
    pub const PORTA_VSLIDE_FINE: u8 = 0x10;
    pub const VIB_VSLIDE_FINE: u8 = 0x11;
    pub const SET_CAR_VOL: u8 = 0x12;
    pub const SET_WAVEFORM: u8 = 0x13;
    pub const VSLIDE_FINE: u8 = 0x14;
    pub const RETRIG: u8 = 0x15;
    pub const TREMOLO: u8 = 0x16;
    pub const TREMOR: u8 = 0x17;
    pub const ARP_VSLIDE: u8 = 0x18;
    pub const ARP_VSLIDE_FINE: u8 = 0x19;
    pub const MULTI_RETRIG: u8 = 0x1a;
    pub const SLIDE_UP_VSLIDE: u8 = 0x1b;
    pub const SLIDE_DOWN_VSLIDE: u8 = 0x1c;
    pub const FINE_UP_VSLIDE: u8 = 0x1d;
    pub const FINE_DOWN_VSLIDE: u8 = 0x1e;
    pub const SLIDE_UP_VSLIDE_FINE: u8 = 0x1f;
    pub const SLIDE_DOWN_VSLIDE_FINE: u8 = 0x20;
    pub const FINE_UP_VSLIDE_FINE: u8 = 0x21;
    pub const FINE_DOWN_VSLIDE_FINE: u8 = 0x22;
    pub const EXTENDED: u8 = 0x23;
    pub const EXTENDED2: u8 = 0x24;
    pub const GLOBAL_VOL: u8 = 0x25;
    pub const SWAP_ARP: u8 = 0x26;
    pub const SWAP_VIB: u8 = 0x27;
    pub const FORCE_INS_VOL: u8 = 0x28;
    pub const EXTENDED3: u8 = 0x29;
    pub const EXTRA_FINE_ARP: u8 = 0x2a;
    pub const EXTRA_FINE_VIB: u8 = 0x2b;
    pub const EXTRA_FINE_TREM: u8 = 0x2c;
    pub const CUSTOM_SPEED_TAB: u8 = 0x2d;
    pub const GLOBAL_SLIDE_UP: u8 = 0x2e;
    pub const GLOBAL_SLIDE_DOWN: u8 = 0x2f;
}

/// Where a register write goes.
pub trait RegisterSink {
    fn write(&mut self, reg: u16, val: u8);
}

impl RegisterSink for Vec<(u16, u8)> {
    fn write(&mut self, reg: u16, val: u8) {
        self.push((reg, val));
    }
}

/// One effect column's running state.
#[derive(Debug, Clone, Copy, Default)]
struct Column {
    /// This row's effect and parameter.
    fx: u8,
    param: u8,
    porta_speed: u8,
    vib_speed: u8,
    vib_depth: u8,
    vib_pos: u8,
    trem_speed: u8,
    trem_depth: u8,
    trem_pos: u8,
    arp_phase: u8,
    /// Shared amount of the frequency slides (set by 01, 02, 07 and 08,
    /// used by the combined slides; MEASURED).
    slide_mem: u8,
    /// The last plain arpeggio's parameter, for 18 and 19.
    arp_mem: u8,
    /// The previous row's effect and parameter.
    last_fx: u8,
    last_param: u8,
}

#[derive(Debug, Clone, Copy, Default)]
struct Track {
    /// Instrument register image: AM/VIB/EG/KSR/MULT, KSL/TL, AR/DR, SL/RR,
    /// WS for modulator then carrier, and FB/CON (the file's order).
    fm: [u8; 11],
    /// 1-based instrument number, 0 before any.
    instrument: u8,
    /// Current volume as a total level, 0 loud .. 63 silent.
    vol_mod: u8,
    vol_car: u8,
    /// Base frequency: F-number (bits 0-9) and block (bits 10-12).
    freq: u16,
    /// Frequency last written to the chip (with arpeggio or vibrato).
    out_freq: u16,
    /// Tone portamento target.
    porta_target: u16,
    key_on: bool,
    /// 0 centre, 1 left, 2 right.
    panning: u8,
    finetune: i8,
    note: u8,
    cols: [Column; 2],
    fm_macro: MacroState,
    arp_macro: MacroState,
    vib_macro: MacroState,
    /// A note off or ZF0 happened since the last key-on.
    keyed_off: bool,
    /// ZF2/ZF3: an instrument does not reset the volume.
    vol_lock: bool,
    /// ZF9/ZFA: an instrument does not set the panning.
    pan_lock: bool,
    /// Volume slides act on: 0 the default (carrier, both when additive),
    /// 1 the carrier, 2 the modulator, 3 both (lock flags bits 2-3; ZF6-8).
    vslide_mode: u8,
    /// The next instrument reloads in full and writes its volume twice
    /// (after ZF0 or an empty instrument; MEASURED).
    forced_reload: bool,
    /// &2x: this row's note waits x ticks; &3x cuts it after x ticks.
    note_delay: u8,
    delayed_note: u8,
    note_cut: u8,
    /// &4x/&5x: added to this row's note only.
    fine_once: i8,
    /// ZC/ZD pattern loop: start row and remaining count.
    loop_row: usize,
    loop_count: u8,
    /// Pitch the vibrato table's offsets apply to: the note's, and after a
    /// key-off the pitch at that moment (MEASURED).
    vib_base: u16,
    /// Arpeggio and vibrato macro tables in use (1-based, 0 none).
    arp_table: u8,
    vib_table: u8,
}

/// A running instrument macro (FM register, arpeggio or vibrato table).
#[derive(Debug, Clone, Copy, Default)]
struct MacroState {
    active: bool,
    /// 1-based step.
    pos: u8,
    /// Ticks counted towards the next step.
    count: u16,
    /// Vibrato tables: ticks still to wait before the first step.
    delay: u8,
    /// Set by a key-off: the macro has left its pre-key-off part.
    released: bool,
    /// Step to take next instead of the usual one (a key-off's jump).
    jump: u8,
}

/// Next step of a macro with this length, loop and key-off position, or
/// None when it stops (MEASURED on FM, arpeggio and vibrato tables alike):
/// the loop wraps at `loop_begin + loop_length - 1`; before a key-off,
/// reaching the key-off position stops the macro; past the length stops it.
fn macro_next(
    m: &MacroState,
    length: u8,
    loop_begin: u8,
    loop_length: u8,
    keyoff: u8,
) -> Option<u8> {
    if m.jump != 0 {
        return (m.jump <= length || m.released).then_some(m.jump);
    }
    let loop_end = (loop_begin as u16 + loop_length as u16).saturating_sub(1);
    let next = if loop_length > 0 && loop_begin > 0 && m.pos as u16 == loop_end {
        loop_begin
    } else {
        m.pos.checked_add(1)?
    };
    if !m.released && keyoff > 0 && next >= keyoff {
        return None;
    }
    if next > length {
        return None;
    }
    Some(next)
}

pub struct A2Engine {
    /// Reproduce AdPlug's known departures from Adlib Tracker II, for the
    /// register-trace gate only (see the O7 landing record). Off for play.
    pub adplug_quirks: bool,
    song: A2mSong,
    tracks: [Track; 20],
    order_pos: usize,
    pattern: usize,
    row: usize,
    speed: u8,
    tempo: u8,
    tick: u8,
    macro_tick: u16,
    global_volume: u8,
    /// Set by a position jump or pattern break on this row.
    jump: Option<(usize, usize)>,
    ended: bool,
    /// Current 0xBD value (depth bits and rhythm).
    bd: u8,
    /// Row ticks since the start; the extra-fine effects run when it is 3
    /// mod 4 (MEASURED).
    row_ticks: u32,
    /// Ticks the current row lasts: speed, plus pattern delays.
    row_len: u16,
    row_tick: u16,
    /// Order, pattern and row of the next row to play.
    next_pos: (usize, usize, usize),
    /// Times the song has passed an order marker.
    loops: u32,
}

impl A2Engine {
    pub fn new(song: A2mSong) -> A2Engine {
        let mut e = A2Engine {
            adplug_quirks: false,
            speed: song.speed,
            tempo: song.tempo,
            song,
            tracks: [Track::default(); 20],
            order_pos: 0,
            pattern: 0,
            row: 0,
            tick: 0,
            macro_tick: 0,
            global_volume: 63,
            jump: None,
            ended: false,
            bd: 0,
            row_ticks: 0,
            row_len: 0,
            row_tick: 0,
            next_pos: (0, 0, 0),
            loops: 0,
        };
        match e.resolve_order(0) {
            Some((order, pattern, _)) => e.next_pos = (order, pattern, 0),
            None => e.ended = true,
        }
        e
    }

    pub fn song(&self) -> &A2mSong {
        &self.song
    }

    /// Timer rate in Hz: tempo × macro speed-up (MEASURED against AdPlug's
    /// `getrefresh` over the corpus; tempo 18 means the PIT's slowest rate,
    /// 18.2 Hz).
    pub fn refresh(&self) -> f64 {
        let tempo = if self.tempo == 18 {
            18.2
        } else {
            self.tempo as f64
        };
        tempo * self.song.macro_speedup.max(1) as f64
    }

    pub fn position(&self) -> (usize, usize, usize) {
        (self.order_pos, self.pattern, self.row)
    }

    pub fn ended(&self) -> bool {
        self.ended
    }

    /// Times the song has come round (passed an order marker).
    pub fn loops(&self) -> u32 {
        self.loops
    }

    fn tracks_in_use(&self) -> usize {
        if self.percussion() {
            20
        } else {
            18
        }
    }

    /// Song flag bit 6, "percussion track extension".
    fn percussion(&self) -> bool {
        self.song.flags & 0x40 != 0
    }

    fn channel(&self, t: usize) -> usize {
        if self.percussion() {
            TRACK_CHANNEL_PERC[t]
        } else {
            TRACK_CHANNEL[t]
        }
    }

    /// 0xBD: tremolo depth (flag bit 3), vibrato depth (bit 4) and rhythm
    /// mode (bit 6) (MEASURED from the reset writes).
    fn bd_value(&self) -> u8 {
        let f = self.song.flags;
        (f & 0x08) << 4 | (f & 0x10) << 2 | (f & 0x40) >> 1
    }

    /// 0x104: the 4-op pairs (MEASURED: the track-extension flags byte, six
    /// bits, is written as is).
    fn four_op_value(&self) -> u8 {
        self.song.four_op_tracks & 0x3f
    }

    /// The writes that put the chip into the state the player starts from
    /// (MEASURED: AdPlug's rewind, in this order).
    pub fn reset(&mut self, out: &mut impl RegisterSink) {
        out.write(0x001, 0x00);
        for t in 0..18 {
            out.write(0xb0 + reg_channel(self.channel(t)), 0);
        }
        for op in (0x00..0x0e).chain(0x10..0x16) {
            out.write(0x80 + op, 0xff);
        }
        out.write(0x001, 0x20);
        out.write(0x008, 0x40);
        out.write(0x105, 0x01);
        out.write(0x104, self.four_op_value());
        for t in [16, 17] {
            let ch = reg_channel(self.channel(t));
            out.write(0xa0 + ch, 0);
            out.write(0xb0 + ch, 0);
        }
        self.bd = self.bd_value();
        out.write(0x0bd, self.bd);
    }

    /// One timer tick. Row ticks come every `macro_speedup`-th tick; the
    /// first row plays on the `speed`-th row tick (MEASURED: tick
    /// `(speed - 1) × speedup`), and each row lasts its speed plus any
    /// pattern delay. Effects run on every row tick, the row's own
    /// included; macros on every tick, after them.
    pub fn update(&mut self, out: &mut impl RegisterSink) {
        if self.ended {
            return;
        }
        let speedup = self.song.macro_speedup.max(1);
        if self.macro_tick == 0 {
            if self.row_len == 0 {
                self.tick += 1;
                if self.tick >= self.speed {
                    self.start_row(out);
                }
            } else {
                self.row_tick += 1;
                if self.row_tick >= self.row_len {
                    self.start_row(out);
                }
            }
            if self.row_len != 0 {
                let xf = self.row_ticks % 4 == 3;
                for t in 0..self.tracks_in_use() {
                    self.tick_effects(t, xf, out);
                }
                // MEASURED: the next position is settled on the row's own
                // tick (a restart's writes land there).
                if self.row_tick == 0 {
                    self.after_row(out);
                }
            }
            self.row_ticks += 1;
        }
        for t in 0..self.tracks_in_use() {
            self.run_macros(t, out);
        }
        self.macro_tick = (self.macro_tick + 1) % speedup;
    }

    fn start_row(&mut self, out: &mut impl RegisterSink) {
        self.row_tick = 0;
        self.row_len = self.speed.max(1) as u16;
        (self.order_pos, self.pattern, self.row) = self.next_pos;
        self.play_row(out);
    }

    fn play_row(&mut self, out: &mut impl RegisterSink) {
        let tracks = self.tracks_in_use();
        let cells: Vec<Cell> = (0..tracks)
            .map(|t| *self.song.patterns[self.pattern].cell(self.row, t))
            .collect();
        for (t, cell) in cells.iter().enumerate() {
            for (c, &(fx, param)) in cell.effects.iter().enumerate() {
                let col = &mut self.tracks[t].cols[c];
                col.last_fx = col.fx;
                col.last_param = col.param;
                col.fx = fx;
                col.param = param;
                // MEASURED: an arpeggio, vibrato or tremolo starts from its
                // first step when the column enters it from another effect
                // (04 → 06 → 11 carries on; 0A → 04 restarts).
                if group(fx) != group(col.last_fx) {
                    col.arp_phase = 0;
                    col.vib_pos = 0;
                    col.trem_pos = 0;
                }
                match fx {
                    fx::SLIDE_UP | fx::SLIDE_DOWN | fx::FINE_UP | fx::FINE_DOWN => {
                        col.slide_mem = param
                    }
                    fx::ARPEGGIO if param != 0 => col.arp_mem = param,
                    _ => {}
                }
            }
        }
        for t in 0..tracks {
            let tr = &mut self.tracks[t];
            tr.note_delay = 0;
            tr.note_cut = 0;
            tr.fine_once = 0;
        }
        for (t, cell) in cells.iter().enumerate() {
            if cell.instrument != 0 {
                self.set_instrument(t, cell.instrument, out);
            }
        }
        // MEASURED: the first effect column of every track, then the second.
        for c in 0..2 {
            for (t, cell) in cells.iter().enumerate() {
                self.row_effect(t, c, cell, out);
            }
        }
        for (t, cell) in cells.iter().enumerate() {
            if cell.note != 0 {
                if self.tracks[t].note_delay != 0 {
                    self.tracks[t].delayed_note = cell.note;
                } else {
                    self.play_note(t, cell.note, out);
                }
            }
            self.note_pass_effects(t, out);
        }
    }

    /// Works out the position after this row. Passing an order marker
    /// back to order 0 from a later one restarts the song: the global volume returns to full
    /// and the levels are rewritten (MEASURED); any marker ends a pass.
    fn after_row(&mut self, out: &mut impl RegisterSink) {
        let (mut order, mut row) = (self.order_pos, self.row + 1);
        if let Some((o, r)) = self.jump.take() {
            order = o;
            row = r;
        } else if row >= self.song.pattern_len as usize {
            row = 0;
            order += 1;
        }
        let Some((order, pattern, marker)) = self.resolve_order(order) else {
            self.ended = true;
            return;
        };
        if row >= self.song.pattern_len as usize {
            row = 0;
        }
        if marker {
            self.loops += 1;
            // MEASURED: not when the song is one order long (0 → 0).
            if order == 0 && self.order_pos > 0 {
                self.global_volume = 63;
                self.write_global_levels(out);
            }
        }
        self.next_pos = (order, pattern, row);
    }

    /// The order entry at or after `order` that holds a pattern, following
    /// markers (0x80 + n: continue at n), and whether a marker was taken.
    fn resolve_order(&self, mut order: usize) -> Option<(usize, usize, bool)> {
        let mut marker = false;
        for _ in 0..=128 {
            if order >= 128 {
                order = 0;
                marker = true;
            }
            let o = self.song.order[order];
            if o < 0x80 {
                return ((o as usize) < self.song.patterns.len())
                    .then_some((order, o as usize, marker));
            }
            order = (o & 0x7f) as usize;
            marker = true;
        }
        None
    }

    fn set_instrument(&mut self, t: usize, ins: u8, out: &mut impl RegisterSink) {
        let Some(data) = self.song.instruments.get(ins as usize - 1).cloned() else {
            return;
        };
        // MEASURED: an instrument with nothing in it (finetune included)
        // silences the channel first, like ZF0, and always reloads.
        let empty =
            data.fm == [0; 11] && data.panning == 0 && data.finetune == 0 && data.voice_type == 0;
        if empty {
            self.release_sound(t, out);
        }
        let forced = self.tracks[t].forced_reload;
        let reload = self.tracks[t].instrument != ins || forced;
        let tr = &mut self.tracks[t];
        tr.forced_reload = false;
        if reload {
            tr.instrument = ins;
            tr.fm = data.fm;
            if !tr.pan_lock {
                tr.panning = data.panning;
            }
            tr.finetune = data.finetune;
            self.load_fm(t, out);
        }
        let tr = &mut self.tracks[t];
        if !tr.vol_lock || reload {
            tr.vol_mod = data.fm[2] & 0x3f;
            tr.vol_car = data.fm[3] & 0x3f;
        }
        if reload {
            self.write_volume(t, out);
        }
        if (!reload && !self.tracks[t].vol_lock) || forced {
            self.write_volume(t, out);
        }
    }

    /// ZF0 "release sustaining sound": silence both operators, key off,
    /// fastest envelope, and forget the instrument (MEASURED writes).
    fn release_sound(&mut self, t: usize, out: &mut impl RegisterSink) {
        let (m, c) = op_regs(self.channel(t));
        let ch = reg_channel(self.channel(t));
        out.write(0x40 + m, 0x3f);
        out.write(0x40 + c, 0x3f);
        out.write(0xb0 + ch, 0);
        out.write(0x60 + m, 0xff);
        out.write(0x60 + c, 0xff);
        out.write(0x80 + m, 0xff);
        out.write(0x80 + c, 0xff);
        let f = self.tracks[t].freq;
        out.write(0xa0 + ch, f as u8);
        out.write(0xb0 + ch, (f >> 8) as u8);
        self.tracks[t].key_on = false;
        self.tracks[t].keyed_off = true;
        self.tracks[t].forced_reload = true;
    }

    /// The 20/23, C0 and 40/43 writes that follow a change of connection,
    /// feedback, panning or an operator's flags (MEASURED order).
    fn write_connection_group(&mut self, t: usize, out: &mut impl RegisterSink) {
        let (m, c) = op_regs(self.channel(t));
        let fm = self.tracks[t].fm;
        out.write(0x20 + m, fm[0]);
        out.write(0x20 + c, fm[1]);
        out.write(
            0xc0 + reg_channel(self.channel(t)),
            fm[10] | pan_bits(self.tracks[t].panning),
        );
        self.write_volume(t, out);
    }

    /// AR/DR, SL/RR and waveform of one operator (0 modulator, 1 carrier).
    fn write_envelope_group(&mut self, t: usize, op: usize, out: &mut impl RegisterSink) {
        let (m, c) = op_regs(self.channel(t));
        let r = if op == 0 { m } else { c };
        let fm = self.tracks[t].fm;
        out.write(0x60 + r, fm[4 + op]);
        out.write(0x80 + r, fm[6 + op]);
        out.write(0xe0 + r, fm[8 + op]);
    }

    fn write_global_levels(&mut self, out: &mut impl RegisterSink) {
        for u in 0..self.tracks_in_use() {
            if self.tracks[u].instrument != 0 {
                if self.additive(u) {
                    self.write_mod_level(u, out);
                }
                self.write_car_level(u, out);
            }
        }
    }

    fn global_volume_slide(&mut self, by: i32, out: &mut impl RegisterSink) {
        self.global_volume = (self.global_volume as i32 + by).clamp(0, 63) as u8;
        self.write_global_levels(out);
    }

    fn load_fm(&mut self, t: usize, out: &mut impl RegisterSink) {
        let ch = self.channel(t);
        let (m, c) = op_regs(ch);
        let fm = self.tracks[t].fm;
        out.write(0x20 + m, fm[0]);
        out.write(0x20 + c, fm[1]);
        out.write(0x40 + m, fm[2] | 0x3f);
        out.write(0x40 + c, fm[3] | 0x3f);
        out.write(0x60 + m, fm[4]);
        out.write(0x60 + c, fm[5]);
        out.write(0x80 + m, fm[6]);
        out.write(0x80 + c, fm[7]);
        out.write(0xe0 + m, fm[8]);
        out.write(0xe0 + c, fm[9]);
        out.write(
            0xc0 + reg_channel(ch),
            fm[10] | pan_bits(self.tracks[t].panning),
        );
    }

    fn additive(&self, t: usize) -> bool {
        self.tracks[t].fm[10] & 1 != 0
    }

    /// Scales a total level by the global volume (MEASURED:
    /// `63 - round((63 - tl) × gv / 63)`).
    fn scaled(&self, tl: u8) -> u8 {
        scale_level(tl, self.global_volume)
    }

    fn write_volume(&mut self, t: usize, out: &mut impl RegisterSink) {
        let tr = self.tracks[t];
        self.write_levels(t, tr.vol_mod, tr.vol_car, out);
    }

    fn write_levels(&mut self, t: usize, tl_mod: u8, tl_car: u8, out: &mut impl RegisterSink) {
        let (m, c) = op_regs(self.channel(t));
        let tr = self.tracks[t];
        let vm = if self.additive(t) {
            self.scaled(tl_mod)
        } else {
            tl_mod
        };
        out.write(0x40 + m, (tr.fm[2] & 0xc0) | vm);
        out.write(0x40 + c, (tr.fm[3] & 0xc0) | self.scaled(tl_car));
    }

    /// Writes the levels that follow the global volume: the carrier, then
    /// the modulator when the connection is additive (MEASURED order).
    fn write_scaled_levels(&mut self, t: usize, out: &mut impl RegisterSink) {
        self.write_car_level(t, out);
        if self.additive(t) {
            self.write_mod_level(t, out);
        }
    }

    fn write_mod_level(&mut self, t: usize, out: &mut impl RegisterSink) {
        let (m, _) = op_regs(self.channel(t));
        let tr = self.tracks[t];
        let vm = if self.additive(t) {
            self.scaled(tr.vol_mod)
        } else {
            tr.vol_mod
        };
        out.write(0x40 + m, (tr.fm[2] & 0xc0) | vm);
    }

    fn write_car_level(&mut self, t: usize, out: &mut impl RegisterSink) {
        let (_, c) = op_regs(self.channel(t));
        let tr = self.tracks[t];
        out.write(0x40 + c, (tr.fm[3] & 0xc0) | self.scaled(tr.vol_car));
    }

    fn note_freq(&self, t: usize, note: u8) -> u16 {
        let n = (note & 0x7f) as usize - 1;
        let fnum = (FNUM[n % 12] as i32 + self.tracks[t].finetune as i32) as u16;
        fnum | (((n / 12) as u16) << 10)
    }

    fn is_porta(fx: u8) -> bool {
        matches!(fx, fx::PORTA | fx::PORTA_VSLIDE | fx::PORTA_VSLIDE_FINE)
    }

    fn play_note(&mut self, t: usize, note: u8, out: &mut impl RegisterSink) {
        let ch = reg_channel(self.channel(t));
        if note == 0xff {
            let f = self.tracks[t].freq;
            out.write(0xa0 + ch, f as u8);
            out.write(0xb0 + ch, (f >> 8) as u8);
            self.tracks[t].key_on = false;
            self.tracks[t].keyed_off = true;
            self.release_macros(t);
            return;
        }
        let freq = {
            let f = self.note_freq(t, note);
            (f as i32 + self.tracks[t].fine_once as i32) as u16
        };
        let cols = self.tracks[t].cols;
        if cols.iter().any(|c| Self::is_porta(c.fx)) {
            // MEASURED: a portamento note sets the target. After a key-off
            // (note off or ZF0) it first keys on again at the track's last
            // note, which it leaves as the last note; otherwise it becomes
            // the last note (silently, on a track that never played).
            self.tracks[t].porta_target = freq;
            if self.tracks[t].keyed_off {
                let last = self.tracks[t].note;
                if last != 0 {
                    let f = self.note_freq(t, last);
                    self.key_on_at(t, f, out);
                }
            } else {
                self.tracks[t].note = note;
            }
            return;
        }
        self.tracks[t].note = note;
        self.key_on_at(t, freq, out);
    }

    fn key_on_at(&mut self, t: usize, freq: u16, out: &mut impl RegisterSink) {
        let ch = reg_channel(self.channel(t));
        let tr = &mut self.tracks[t];
        tr.keyed_off = false;
        tr.freq = freq;
        tr.key_on = true;
        tr.out_freq = freq;
        // MEASURED: a note restarts an arpeggio but not a tremolo.
        for c in tr.cols.iter_mut() {
            c.arp_phase = 0;
        }
        out.write(0xb0 + ch, 0);
        out.write(0xa0 + ch, freq as u8);
        out.write(0xb0 + ch, 0x20 | (freq >> 8) as u8);
        self.start_macros(t);
    }

    fn start_macros(&mut self, t: usize) {
        let ins = self.tracks[t].instrument as usize;
        let tr = &mut self.tracks[t];
        tr.fm_macro = MacroState::default();
        tr.arp_macro = MacroState::default();
        tr.vib_macro = MacroState::default();
        let Some(m) = self.song.fm_macros.get(ins.wrapping_sub(1)) else {
            return;
        };
        tr.arp_table = m.arpeggio_table;
        tr.vib_table = m.vibrato_table;
        tr.vib_base = tr.freq;
        if m.length > 0 {
            tr.fm_macro = MacroState {
                active: true,
                pos: 0,
                ..Default::default()
            };
        }
        if let Some(a) = self
            .song
            .arpeggio_macros
            .get((tr.arp_table as usize).wrapping_sub(1))
        {
            if a.length > 0 {
                tr.arp_macro = MacroState {
                    active: true,
                    ..Default::default()
                };
            }
        }
        if let Some(v) = self
            .song
            .vibrato_macros
            .get((tr.vib_table as usize).wrapping_sub(1))
        {
            if v.length > 0 {
                tr.vib_macro = MacroState {
                    active: true,
                    delay: v.delay,
                    ..Default::default()
                };
            }
        }
    }

    /// A key-off sends each running macro to its key-off position, taken
    /// when the current step's time is up (MEASURED). A vibrato table also
    /// restarts from there (from the top when it has none), even if it had
    /// finished, around the pitch of the moment.
    fn release_macros(&mut self, t: usize) {
        let ins = self.tracks[t].instrument as usize;
        let tr = &mut self.tracks[t];
        let jump = |st: &mut MacroState, keyoff: u8| {
            if st.active && keyoff > 0 {
                st.jump = keyoff;
                st.released = true;
            }
        };
        if let Some(m) = self.song.fm_macros.get(ins.wrapping_sub(1)) {
            jump(&mut tr.fm_macro, m.keyoff_pos);
        }
        if let Some(a) = self
            .song
            .arpeggio_macros
            .get((tr.arp_table as usize).wrapping_sub(1))
        {
            jump(&mut tr.arp_macro, a.keyoff_pos);
        }
        if let Some(v) = self
            .song
            .vibrato_macros
            .get((tr.vib_table as usize).wrapping_sub(1))
        {
            if v.length > 0 {
                tr.vib_macro.active = true;
                tr.vib_macro.released = true;
                tr.vib_macro.jump = v.keyoff_pos.max(1);
                tr.vib_base = tr.freq;
            }
        }
    }

    fn write_freq(&mut self, t: usize, freq: u16, out: &mut impl RegisterSink) {
        let ch = reg_channel(self.channel(t));
        let key = if self.tracks[t].key_on { 0x20 } else { 0 };
        self.tracks[t].out_freq = freq;
        out.write(0xa0 + ch, freq as u8);
        out.write(0xb0 + ch, key | (freq >> 8) as u8);
    }

    /// Effects applied once, when the row is read, before its notes.
    fn row_effect(&mut self, t: usize, c: usize, cell: &Cell, out: &mut impl RegisterSink) {
        let (fx, param) = cell.effects[c];
        match fx {
            fx::SET_MOD_VOL => {
                self.tracks[t].vol_mod = 63 - (param & 0x3f);
                self.write_mod_level(t, out);
            }
            fx::SET_CAR_VOL => {
                self.tracks[t].vol_car = 63 - (param & 0x3f);
                self.write_car_level(t, out);
            }
            fx::SET_INS_VOL => {
                let tl = 63 - (param & 0x3f);
                self.tracks[t].vol_car = tl;
                if self.additive(t) {
                    self.tracks[t].vol_mod = tl;
                    self.write_volume(t, out);
                } else {
                    self.write_car_level(t, out);
                }
            }
            fx::FORCE_INS_VOL => {
                // MEASURED: the carrier gets 63 - v; the modulator too when
                // additive, else the instrument's own modulator level scaled
                // by v.
                let v = param & 0x3f;
                let ins_mod = self.tracks[t].fm[2] & 0x3f;
                let tr = &mut self.tracks[t];
                tr.vol_car = 63 - v;
                tr.vol_mod = if tr.fm[10] & 1 != 0 {
                    63 - v
                } else {
                    scale_level(ins_mod, v)
                };
                self.write_volume(t, out);
            }
            fx::SET_WAVEFORM => {
                // MEASURED: high nibble carrier, low nibble modulator; 8 and
                // up leave it alone. Each goes out with its operator's AR/DR
                // and SL/RR, carrier first.
                let (m, car) = op_regs(self.channel(t));
                if param >> 4 < 8 {
                    let tr = &mut self.tracks[t];
                    tr.fm[9] = param >> 4;
                    out.write(0x60 + car, tr.fm[5]);
                    out.write(0x80 + car, tr.fm[7]);
                    out.write(0xe0 + car, tr.fm[9]);
                }
                if param & 15 < 8 {
                    let tr = &mut self.tracks[t];
                    tr.fm[8] = param & 15;
                    out.write(0x60 + m, tr.fm[4]);
                    out.write(0x80 + m, tr.fm[6]);
                    out.write(0xe0 + m, tr.fm[8]);
                }
            }
            fx::GLOBAL_VOL => {
                self.global_volume = param & 0x3f;
                self.write_global_levels(out);
            }
            fx::EXTENDED => self.extended(t, c, param, out),
            fx::EXTENDED2 => match param >> 4 {
                0x0 => self.row_len += (param & 15) as u16,
                0x1 => self.row_len += self.speed as u16 * (param & 15) as u16,
                0x2 => self.tracks[t].note_delay = param & 15,
                0x3 => self.tracks[t].note_cut = param & 15,
                0x4 => self.tracks[t].fine_once = (param & 15) as i8,
                0x5 => self.tracks[t].fine_once = -((param & 15) as i8),
                _ => {}
            },
            fx::EXTENDED3 => {
                let v = param & 15;
                let tr = &mut self.tracks[t];
                let set = |b: &mut u8, mask: u8, val: u8| *b = (*b & !mask) | (val & mask);
                match param >> 4 {
                    0x0 => set(&mut tr.fm[10], 0x01, v),
                    0x1 => set(&mut tr.fm[0], 0x0f, v),
                    0x2 => set(&mut tr.fm[2], 0xc0, v << 6),
                    0x3 => set(&mut tr.fm[0], 0x80, v << 7),
                    0x4 => set(&mut tr.fm[0], 0x40, v << 6),
                    0x5 => set(&mut tr.fm[0], 0x10, v << 4),
                    0x6 => set(&mut tr.fm[0], 0x20, v << 5),
                    0x7 => set(&mut tr.fm[1], 0x0f, v),
                    0x8 => set(&mut tr.fm[3], 0xc0, v << 6),
                    0x9 => set(&mut tr.fm[1], 0x80, v << 7),
                    0xa => set(&mut tr.fm[1], 0x40, v << 6),
                    0xb => set(&mut tr.fm[1], 0x10, v << 4),
                    0xc => set(&mut tr.fm[1], 0x20, v << 5),
                    _ => return,
                }
                self.write_connection_group(t, out);
            }
            fx::SWAP_ARP => self.tracks[t].arp_table = param,
            fx::SWAP_VIB => self.tracks[t].vib_table = param,
            fx::SET_SPEED => {
                if param != 0 {
                    self.speed = param;
                }
            }
            fx::SET_TEMPO => {
                if param != 0 {
                    self.tempo = param;
                }
            }
            fx::POS_JUMP => {
                self.jump = Some(((param & 0x7f) as usize, 0));
            }
            fx::PAT_BREAK => {
                self.jump = Some((self.order_pos + 1, param as usize));
            }
            fx::PORTA => {
                if param != 0 {
                    self.tracks[t].cols[c].porta_speed = param;
                }
            }
            fx::VIBRATO | fx::EXTRA_FINE_VIB => {
                let col = &mut self.tracks[t].cols[c];
                if param >> 4 != 0 {
                    col.vib_speed = param >> 4;
                }
                if param & 15 != 0 {
                    col.vib_depth = param & 15;
                }
            }
            fx::TREMOLO | fx::EXTRA_FINE_TREM => {
                let col = &mut self.tracks[t].cols[c];
                if param >> 4 != 0 {
                    col.trem_speed = param >> 4;
                }
                if param & 15 != 0 {
                    col.trem_depth = param & 15;
                }
            }
            _ => {}
        }
    }

    /// Steps the track's macros by one timer tick (every tick, at the macro
    /// speed-up rate; MEASURED after all effects of the tick).
    fn run_macros(&mut self, t: usize, out: &mut impl RegisterSink) {
        self.run_fm_macro(t, out);
        self.run_arp_macro(t, out);
        self.run_vib_macro(t, out);
    }

    fn run_fm_macro(&mut self, t: usize, out: &mut impl RegisterSink) {
        let st = self.tracks[t].fm_macro;
        if !st.active {
            return;
        }
        let ins = self.tracks[t].instrument as usize - 1;
        let m = &self.song.fm_macros[ins];
        // A step lasts its duration in ticks; a zero duration is skipped
        // but still takes a tick (MEASURED).
        let dur = if st.pos == 0 {
            0
        } else {
            m.steps[st.pos as usize - 1].duration as u16
        };
        if st.pos != 0 && st.count + 1 < dur {
            self.tracks[t].fm_macro.count += 1;
            return;
        }
        let (pos, count) =
            match macro_next(&st, m.length, m.loop_begin, m.loop_length, m.keyoff_pos) {
                Some(p) => (p, 0),
                None => {
                    self.tracks[t].fm_macro.active = false;
                    return;
                }
            };
        let tr = &mut self.tracks[t].fm_macro;
        tr.pos = pos;
        tr.count = count;
        tr.jump = 0;
        let step = m.steps[pos as usize - 1];
        if step.duration > 0 {
            self.apply_fm_step(t, ins, &step, out);
        }
    }

    fn apply_fm_step(
        &mut self,
        t: usize,
        ins: usize,
        step: &FmMacroStep,
        out: &mut impl RegisterSink,
    ) {
        let off = self
            .song
            .disabled_fm_columns
            .get(ins)
            .copied()
            .unwrap_or([0; 28]);
        let on = |col: usize| off[col] == 0;
        let (m, c) = op_regs(self.channel(t));
        // The step's level column is a volume: 63 is loudest (MEASURED, and
        // the corpus agrees: instruments at TL 0 carry 63 there).
        if on(5) {
            self.tracks[t].vol_mod = 63 - (step.fm[2] & 0x3f);
            self.write_mod_level(t, out);
        }
        if on(17) {
            self.tracks[t].vol_car = 63 - (step.fm[3] & 0x3f);
            self.write_car_level(t, out);
        }
        let tr = &mut self.tracks[t];
        let mut merge = |byte: usize, col: usize, mask: u8| {
            if on(col) {
                tr.fm[byte] = (tr.fm[byte] & !mask) | (step.fm[byte] & mask);
            }
        };
        for (op, base) in [(0usize, 0usize), (1, 12)] {
            merge(4 + op, base, 0xf0);
            merge(4 + op, base + 1, 0x0f);
            merge(6 + op, base + 2, 0xf0);
            merge(6 + op, base + 3, 0x0f);
            merge(8 + op, base + 4, 0x07);
            merge(2 + op, base + 6, 0xc0);
            merge(op, base + 7, 0x0f);
            merge(op, base + 8, 0x80);
            merge(op, base + 9, 0x40);
            merge(op, base + 10, 0x10);
            merge(op, base + 11, 0x20);
        }
        merge(10, 24, 0x01);
        merge(10, 25, 0x0e);
        if on(27) {
            tr.panning = step.panning;
        }
        let fm = tr.fm;
        out.write(0x60 + m, fm[4]);
        out.write(0x80 + m, fm[6]);
        out.write(0xe0 + m, fm[8]);
        out.write(0x60 + c, fm[5]);
        out.write(0x80 + c, fm[7]);
        out.write(0xe0 + c, fm[9]);
        out.write(0x20 + m, fm[0]);
        out.write(0x20 + c, fm[1]);
        let pan = pan_bits(self.tracks[t].panning);
        out.write(0xc0 + reg_channel(self.channel(t)), (fm[10] & 0x0f) | pan);
        self.write_volume(t, out);
        if step.fm[10] & 0x80 != 0 {
            let ch = reg_channel(self.channel(t));
            if self.tracks[t].key_on {
                let note = self.tracks[t].note;
                let f = if note != 0 {
                    self.note_freq(t, note)
                } else {
                    self.tracks[t].freq
                };
                self.tracks[t].freq = f;
                self.tracks[t].out_freq = f;
                out.write(0xb0 + ch, 0);
                out.write(0xa0 + ch, f as u8);
                out.write(0xb0 + ch, 0x20 | (f >> 8) as u8);
            } else {
                let f = self.tracks[t].freq;
                self.write_freq(t, f, out);
            }
        }
        if on(26) && step.freq_slide != 0 {
            self.slide(t, step.freq_slide as i32, out);
        }
    }

    fn run_arp_macro(&mut self, t: usize, out: &mut impl RegisterSink) {
        let st = self.tracks[t].arp_macro;
        if !st.active {
            return;
        }
        let a = &self.song.arpeggio_macros[self.tracks[t].arp_table as usize - 1];
        let tr = &mut self.tracks[t].arp_macro;
        tr.count += 1;
        if a.speed == 0 || tr.count < a.speed as u16 {
            return;
        }
        tr.count = 0;
        let Some(pos) = macro_next(&st, a.length, a.loop_begin, a.loop_length, a.keyoff_pos) else {
            tr.active = false;
            return;
        };
        tr.pos = pos;
        tr.jump = 0;
        let v = a.data[pos as usize - 1];
        // AdPlug tests element `pos` but adds element `pos + 1` for a
        // relative step (an off-by-one: a table 0, 3, 7 plays 0, 7, 0; the
        // corpus's chord tables show AT2 means 0, 3, 7). Fixed notes line up.
        let add = if self.adplug_quirks {
            a.data.get(pos as usize).copied().unwrap_or(0)
        } else {
            v
        };
        let note = self.tracks[t].note & 0x7f;
        let f = if v & 0x80 != 0 {
            self.note_freq(t, (v & 0x7f).clamp(1, 96))
        } else if v == 0 || add == 0 || note == 0 {
            self.arp_freq(t, 0)
        } else {
            self.note_freq(t, (note + (add & 0x7f)).min(96))
        };
        self.tracks[t].freq = f;
        self.write_freq(t, f, out);
    }

    fn run_vib_macro(&mut self, t: usize, out: &mut impl RegisterSink) {
        let st = self.tracks[t].vib_macro;
        if !st.active {
            return;
        }
        let v = &self.song.vibrato_macros[self.tracks[t].vib_table as usize - 1];
        let tr = &mut self.tracks[t].vib_macro;
        if tr.delay > 0 {
            tr.delay -= 1;
            return;
        }
        tr.count += 1;
        if v.speed == 0 || tr.count < v.speed as u16 {
            return;
        }
        tr.count = 0;
        let Some(pos) = macro_next(&st, v.length, v.loop_begin, v.loop_length, v.keyoff_pos) else {
            tr.active = false;
            return;
        };
        tr.pos = pos;
        tr.jump = 0;
        let by = v.data[pos as usize - 1] as i32;
        let f = step_freq(self.tracks[t].vib_base, by);
        self.tracks[t].freq = f;
        self.write_freq(t, f, out);
    }

    /// The Z (0x23) commands.
    fn extended(&mut self, t: usize, c: usize, param: u8, out: &mut impl RegisterSink) {
        let v = param & 15;
        match param >> 4 {
            // MEASURED: each sets its own depth bit and takes the other
            // from the song flags, not from the last write.
            0x0 => {
                self.bd = (self.bd_value() & !0x80) | (v & 1) << 7;
                out.write(0xbd, self.bd);
            }
            0x1 => {
                self.bd = (self.bd_value() & !0x40) | (v & 1) << 6;
                out.write(0xbd, self.bd);
            }
            0x2..=0x9 => {
                // AR, DR, SL, RR of the modulator, then of the carrier.
                let n = (param >> 4) - 2;
                let op = (n / 4) as usize;
                let byte = if n % 4 < 2 { 4 + op } else { 6 + op };
                let tr = &mut self.tracks[t];
                tr.fm[byte] = if n % 2 == 0 {
                    (tr.fm[byte] & 0x0f) | v << 4
                } else {
                    (tr.fm[byte] & 0xf0) | v
                };
                self.write_envelope_group(t, op, out);
            }
            0xa => {
                let tr = &mut self.tracks[t];
                tr.fm[10] = (tr.fm[10] & !0x0e) | (v & 7) << 1;
                self.write_connection_group(t, out);
            }
            0xb => {
                self.tracks[t].panning = v.min(2);
                self.write_connection_group(t, out);
            }
            0xc | 0xd => {
                let tr = &mut self.tracks[t];
                if v == 0 {
                    tr.loop_row = self.row;
                } else if tr.loop_count == 0 {
                    tr.loop_count = v;
                    self.jump = Some((self.order_pos, tr.loop_row));
                } else {
                    tr.loop_count -= 1;
                    if tr.loop_count > 0 {
                        self.jump = Some((self.order_pos, tr.loop_row));
                    }
                }
                let _ = c;
            }
            0xe => {
                if v == 4 {
                    // Restart the envelope: key off and on at the pitch.
                    let ch = reg_channel(self.channel(t));
                    let f = self.tracks[t].freq;
                    out.write(0xb0 + ch, 0);
                    out.write(0xa0 + ch, f as u8);
                    out.write(0xb0 + ch, 0x20 | (f >> 8) as u8);
                    self.tracks[t].key_on = true;
                }
            }
            _ => match v {
                0x0 => self.release_sound(t, out),
                0x1 => {
                    let ins = self.tracks[t].instrument as usize;
                    if let Some(d) = self.song.instruments.get(ins.wrapping_sub(1)) {
                        self.tracks[t].vol_mod = d.fm[2] & 0x3f;
                        self.tracks[t].vol_car = d.fm[3] & 0x3f;
                        self.write_volume(t, out);
                    }
                }
                0x2 => self.tracks[t].vol_lock = true,
                0x3 => self.tracks[t].vol_lock = false,
                0x6 => self.tracks[t].vslide_mode = 2,
                0x7 => self.tracks[t].vslide_mode = 1,
                0x8 => self.tracks[t].vslide_mode = 0,
                0x9 => self.tracks[t].pan_lock = true,
                0xa => self.tracks[t].pan_lock = false,
                0xb => {
                    let f = self.tracks[t].freq;
                    self.write_freq(t, f, out);
                }
                0xc => self.write_volume(t, out),
                _ => {}
            },
        }
    }

    /// Effect parts that run once per row, right after the track's note
    /// (MEASURED: they land between this track's key-on and the next
    /// track's): fine slides and fine volume slides.
    fn note_pass_effects(&mut self, t: usize, out: &mut impl RegisterSink) {
        for c in 0..2 {
            let Column { fx, param, .. } = self.tracks[t].cols[c];
            let mem = self.tracks[t].cols[c].slide_mem as i32;
            match fx {
                fx::FINE_UP => self.slide(t, param as i32, out),
                fx::FINE_DOWN => self.slide(t, -(param as i32), out),
                fx::VSLIDE_FINE
                | fx::PORTA_VSLIDE_FINE
                | fx::VIB_VSLIDE_FINE
                | fx::ARP_VSLIDE_FINE
                | fx::SLIDE_UP_VSLIDE_FINE
                | fx::SLIDE_DOWN_VSLIDE_FINE => self.vslide(t, param, out),
                fx::FINE_UP_VSLIDE => self.slide(t, mem, out),
                fx::FINE_DOWN_VSLIDE => self.slide(t, -mem, out),
                fx::FINE_UP_VSLIDE_FINE => {
                    self.slide(t, mem, out);
                    self.vslide(t, param, out);
                }
                fx::FINE_DOWN_VSLIDE_FINE => {
                    self.slide(t, -mem, out);
                    self.vslide(t, param, out);
                }
                _ => {}
            }
        }
    }

    /// Effects run on every row tick, the row's own included. The order of
    /// the parts inside a combined effect is MEASURED per effect.
    fn tick_effects(&mut self, t: usize, xf: bool, out: &mut impl RegisterSink) {
        for c in 0..2 {
            let col = self.tracks[t].cols[c];
            let (fx, param) = (col.fx, col.param);
            let first = self.row_tick == 0;
            // MEASURED: when a plain arpeggio (00xy) gives way to any other
            // effect, the note's pitch comes back on the next row's first
            // tick if the last step left it elsewhere, and that counts as a
            // step.
            let was_arp =
                matches!(col.last_fx, fx::ARPEGGIO | fx::EXTRA_FINE_ARP) && col.last_param != 0;
            let is_arp = matches!(fx, fx::ARPEGGIO | fx::EXTRA_FINE_ARP) && param != 0;
            if first && was_arp && !is_arp {
                let base = self.arp_freq(t, 0);
                if self.tracks[t].out_freq != base {
                    let col = &mut self.tracks[t].cols[c];
                    col.arp_phase = (col.arp_phase + 1) % 3;
                    self.write_freq(t, base, out);
                }
            }
            let mem = col.slide_mem as i32;
            let arp_param = col.arp_mem;
            if c == 0 {
                let tr = self.tracks[t];
                if tr.note_delay != 0 && self.row_tick == tr.note_delay as u16 {
                    self.tracks[t].note_delay = 0;
                    self.play_note(t, tr.delayed_note, out);
                }
                if tr.note_cut != 0 && self.row_tick == tr.note_cut as u16 {
                    self.tracks[t].note_cut = 0;
                    let f = tr.freq;
                    self.tracks[t].key_on = false;
                    self.write_freq(t, f, out);
                }
            }
            match fx {
                fx::EXTENDED2 => match param >> 4 {
                    0x6 => self.global_volume_slide((param & 15) as i32, out),
                    0x7 => self.global_volume_slide(-((param & 15) as i32), out),
                    0x8 if first => self.global_volume_slide((param & 15) as i32, out),
                    0x9 if first => self.global_volume_slide(-((param & 15) as i32), out),
                    0xa if xf => self.global_volume_slide((param & 15) as i32, out),
                    0xb if xf => self.global_volume_slide(-((param & 15) as i32), out),
                    0xc if xf => self.vslide(t, (param & 15) << 4, out),
                    0xd if xf => self.vslide(t, param & 15, out),
                    0xe if xf => self.slide(t, (param & 15) as i32, out),
                    0xf if xf => self.slide(t, -((param & 15) as i32), out),
                    _ => {}
                },
                fx::EXTRA_FINE_ARP if xf => self.arpeggio(t, c, param, out),
                fx::EXTRA_FINE_VIB if xf => self.vibrato(t, c, out),
                fx::EXTRA_FINE_TREM if xf => self.tremolo(t, c, out),
                fx::GLOBAL_SLIDE_UP | fx::GLOBAL_SLIDE_DOWN => {
                    let by = if fx == fx::GLOBAL_SLIDE_UP {
                        param as i32
                    } else {
                        -(param as i32)
                    };
                    for u in 0..self.tracks_in_use() {
                        if self.tracks[u].freq != 0 {
                            self.slide(u, by, out);
                        }
                    }
                }
                fx::ARPEGGIO if param != 0 => self.arpeggio(t, c, param, out),
                fx::SLIDE_UP => self.slide(t, param as i32, out),
                fx::SLIDE_DOWN => self.slide(t, -(param as i32), out),
                fx::PORTA | fx::PORTA_VSLIDE_FINE => self.porta(t, c, out),
                fx::VIBRATO | fx::VIB_VSLIDE_FINE => self.vibrato(t, c, out),
                fx::PORTA_VSLIDE => {
                    self.vslide(t, param, out);
                    self.porta(t, c, out);
                }
                fx::VIB_VSLIDE => {
                    self.vslide(t, param, out);
                    self.vibrato(t, c, out);
                }
                fx::TREMOLO => self.tremolo(t, c, out),
                fx::VSLIDE | fx::FINE_UP_VSLIDE | fx::FINE_DOWN_VSLIDE => {
                    self.vslide(t, param, out)
                }
                fx::ARP_VSLIDE => {
                    self.vslide(t, param, out);
                    self.arpeggio(t, c, arp_param, out);
                }
                fx::ARP_VSLIDE_FINE => self.arpeggio(t, c, arp_param, out),
                fx::SLIDE_UP_VSLIDE => {
                    self.slide(t, mem, out);
                    self.vslide(t, param, out);
                }
                fx::SLIDE_DOWN_VSLIDE => {
                    self.slide(t, -mem, out);
                    self.vslide(t, param, out);
                }
                fx::SLIDE_UP_VSLIDE_FINE => self.slide(t, mem, out),
                fx::SLIDE_DOWN_VSLIDE_FINE => self.slide(t, -mem, out),
                _ => {}
            }
        }
    }

    fn arpeggio(&mut self, t: usize, c: usize, param: u8, out: &mut impl RegisterSink) {
        let phase = self.tracks[t].cols[c].arp_phase;
        let add = match phase {
            0 => 0,
            1 => param >> 4,
            _ => param & 15,
        };
        self.tracks[t].cols[c].arp_phase = (phase + 1) % 3;
        let f = self.arp_freq(t, add);
        self.write_freq(t, f, out);
    }

    /// The row note's pitch plus `add` semitones (MEASURED: an arpeggio
    /// works from the note, even when a portamento has moved the pitch).
    fn arp_freq(&self, t: usize, add: u8) -> u16 {
        let tr = &self.tracks[t];
        if tr.note == 0 {
            return tr.freq;
        }
        let n = (tr.note & 0x7f) + add;
        self.note_freq(t, n.min(96))
    }

    fn slide(&mut self, t: usize, by: i32, out: &mut impl RegisterSink) {
        let f = step_freq(self.tracks[t].freq, by);
        self.tracks[t].freq = f;
        self.write_freq(t, f, out);
    }

    fn porta(&mut self, t: usize, c: usize, out: &mut impl RegisterSink) {
        let speed = self.tracks[t].cols[c].porta_speed as i32;
        let (cur, target) = (self.tracks[t].freq, self.tracks[t].porta_target);
        if target == 0 || cur == 0 {
            return;
        }
        if cur == target {
            return;
        }
        let f = if cur < target {
            step_freq(cur, speed).min(target)
        } else {
            step_freq(cur, -speed).max(target)
        };
        self.tracks[t].freq = f;
        self.write_freq(t, f, out);
    }

    fn vibrato(&mut self, t: usize, c: usize, out: &mut impl RegisterSink) {
        let col = &mut self.tracks[t].cols[c];
        col.vib_pos = col.vib_pos.wrapping_add(col.vib_speed) & 63;
        let amount = (VIB_TABLE[(col.vib_pos & 31) as usize] as i32 * col.vib_depth as i32) >> 7;
        let by = if col.vib_pos & 32 == 0 {
            -amount
        } else {
            amount
        };
        let f = step_freq(self.tracks[t].freq, by);
        self.write_freq(t, f, out);
    }

    fn tremolo(&mut self, t: usize, c: usize, out: &mut impl RegisterSink) {
        let col = &mut self.tracks[t].cols[c];
        col.trem_pos = col.trem_pos.wrapping_add(col.trem_speed) & 63;
        let amount = (VIB_TABLE[(col.trem_pos & 31) as usize] as i32 * col.trem_depth as i32) >> 7;
        let by = if col.trem_pos & 32 == 0 {
            amount
        } else {
            -amount
        };
        let tr = self.tracks[t];
        let m = (tr.vol_mod as i32 + by).clamp(0, 63) as u8;
        let car = (tr.vol_car as i32 + by).clamp(0, 63) as u8;
        let (mr, cr) = op_regs(self.channel(t));
        out.write(0x40 + cr, (tr.fm[3] & 0xc0) | self.scaled(car));
        if self.additive(t) {
            out.write(0x40 + mr, (tr.fm[2] & 0xc0) | self.scaled(m));
        }
    }

    /// Volume slide: high nibble up (louder), else low nibble down. It
    /// moves the carrier, and the modulator too when additive, unless ZF6-8
    /// or the track's lock flags choose (MEASURED: carrier written first).
    fn vslide(&mut self, t: usize, param: u8, out: &mut impl RegisterSink) {
        let by = if param >> 4 != 0 {
            -((param >> 4) as i32)
        } else if param & 15 != 0 {
            (param & 15) as i32
        } else {
            return;
        };
        let additive = self.additive(t);
        let (car, modu) = match self.tracks[t].vslide_mode {
            1 => (true, false),
            2 => (false, true),
            3 => (true, true),
            _ => (true, additive),
        };
        let tr = &mut self.tracks[t];
        if car {
            tr.vol_car = (tr.vol_car as i32 + by).clamp(0, 63) as u8;
            self.write_car_level(t, out);
        }
        if modu {
            let tr = &mut self.tracks[t];
            tr.vol_mod = (tr.vol_mod as i32 + by).clamp(0, 63) as u8;
            self.write_mod_level(t, out);
        }
    }
}

/// Effects that share running state: an arpeggio, vibrato or tremolo
/// carries on across rows while the column stays inside its group.
fn group(fx: u8) -> u8 {
    match fx {
        fx::ARPEGGIO | fx::ARP_VSLIDE | fx::ARP_VSLIDE_FINE => 1,
        fx::VIBRATO | fx::VIB_VSLIDE | fx::VIB_VSLIDE_FINE => 2,
        fx::TREMOLO => 3,
        _ => 0x80 | fx,
    }
}

/// `63 - round((63 - tl) × vol / 63)`: a total level at volume `vol` (0..63).
fn scale_level(tl: u8, vol: u8) -> u8 {
    let v = (63 - tl.min(63) as u16) * vol.min(63) as u16;
    63 - ((v + 31) / 63) as u8
}

/// Moves a frequency by `by` F-number steps, changing block at the slide
/// range's edges and stopping at its ends.
fn step_freq(freq: u16, by: i32) -> u16 {
    let mut block = (freq >> 10) as i32;
    let mut fnum = (freq & 0x3ff) as i32 + by;
    if by > 0 {
        while fnum > FREQ_HI as i32 {
            if block == 7 {
                return FREQ_MAX;
            }
            block += 1;
            fnum -= (FREQ_HI - FREQ_LO) as i32;
        }
    } else {
        while fnum <= FREQ_LO as i32 {
            if block == 0 {
                return FREQ_MIN;
            }
            block -= 1;
            fnum += (FREQ_HI - FREQ_LO) as i32;
        }
    }
    (block << 10 | fnum) as u16
}

/// Register offset of channel `ch` (0..17) for the A0/B0/C0 groups.
fn reg_channel(ch: usize) -> u16 {
    ((ch / 9) << 8 | (ch % 9)) as u16
}

/// Modulator and carrier register offsets of channel `ch`.
fn op_regs(ch: usize) -> (u16, u16) {
    let m = ((ch / 9) << 8) as u16 | OP_OFFSET[ch % 9];
    (m, m + 3)
}

/// C0 output bits for a panning value (MEASURED: 1 → 0x10, 2 → 0x20).
fn pan_bits(pan: u8) -> u8 {
    match pan {
        1 => 0x10,
        2 => 0x20,
        _ => 0x30,
    }
}
