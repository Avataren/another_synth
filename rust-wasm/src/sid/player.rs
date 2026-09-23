//! The SID song player, S3 of `.ai/plan-sid-tracking.md`: plays a `SidSong`
//! (`song.rs`, the file the app's `SidDoc` saves) on one `Chip`, built with
//! the song's own model (the per-song tag S2 deferred), by writing the chip's
//! registers once per frame, as a C64 playroutine does.
//!
//! Timing: one frame is 1/50 s times 1/`speed_multiplier` (PAL frames, the
//! plan's "PList rows at 50 Hz", GoatTracker's multispeed). INFERRED: exactly
//! 50 Hz, not the PAL raster's 50.125 Hz (985 248 / 19 656); a 0.25 % tempo
//! difference, kept for round numbers and to match the TS engine's clock
//! (`sidDocTiming`). A row lasts `tempo` frames; the tempo is global. Frames
//! land on output-sample boundaries (the chip's own write granularity,
//! `chip.rs`), accumulated fractionally, so no frame drifts.
//!
//! Per frame, in this order (INFERRED ordering, a plain playroutine's):
//!   1. on the row's first frame, every channel reads its row: an instrument
//!      number selects the instrument; a note 1..=93 (transposed by the
//!      orderlist entry, clamped into the table) triggers it: the
//!      instrument's AD/SR, waveform, pulse width and table pointers are
//!      loaded, the gate goes on and the first-frame waveform (if any) is
//!      written this frame; key off clears the gate, key on sets it; then
//!      the row's command;
//!   2. continuous commands (1, 2, 3, 4) and the instrument vibrato, the
//!      wave and pulse tables per channel, then the (global) filter table;
//!   3. the hard restart: `gate_timer` frames before a row that triggers a
//!      note, the gate is cleared, and with `hard_restart` AD/SR go to 0;
//!   4. every register is written: per voice frequency (+ vibrato), pulse
//!      width, AD, SR, then control (waveform | gate); then cutoff,
//!      resonance/routing and mode/volume.
//!
//! Commands (the row's command nibble and parameter; GoatTracker's command
//! set, from its format documentation, interpreted here, not copied):
//!   0 none; 1/2 portamento up/down and 3 tone portamento at the 16-bit
//!   register speed held in speed-table row `param` (left<<8 | right);
//!   4 vibrato with speed-table row `param` (left = frames per half-swing,
//!   right = register step per frame); 5 AD = param; 6 SR = param;
//!   7 waveform = param; 8/9/A start the wave/pulse/filter table at row
//!   `param`; B resonance/routing ($17) = param; C cutoff high byte = param;
//!   D master volume = param & 15; E funktempo: not modelled (ignored);
//!   F tempo = param & 0x7F when it is at least 1. A row with command 3 and
//!   a note glides to it instead of triggering; with parameter 0 (GT's
//!   tie-note, readme §3.2) the pitch moves to it at once, still without a
//!   trigger (pinned in S5 against the `.sng` corpus).
//!
//! Tables (1-based rows; left 0xFF = jump to row `right`, 0 = stop; one
//! jump per frame):
//!   wave: left 0x01..=0x0F waits that many frames, then sets the row's note
//!     (the row lasts left + 1 frames; pinned in S5); 0x10..=0xDF
//!     sets the waveform, 0xE0..=0xEF the waveform `left & 0x0F`, 0x00 keeps
//!     it, 0xF0..=0xFE (GT's table commands) is not modelled and only
//!     advances. right: 0x00..=0x5F note up from the triggered note,
//!     0x60..=0x7F down (right - 0x80), 0x80 no change, 0x81..=0xDF the
//!     absolute note `right & 0x7F`. This right column is the arpeggio;
//!   pulse: left 0x80..=0xFE sets the width to (left & 0x0F)<<8 | right;
//!     0x01..=0x7F adds the signed `right` to it for `left` frames;
//!   filter: left 0x00 sets the cutoff high byte to `right`; 0x01..=0x7F
//!     adds the signed `right` to it for `left` frames; 0x80..=0xF0 sets the
//!     mode to (left >> 4) & 7 (LP 1, BP 2, HP 4) and $17 (resonance<<4 |
//!     routing) to `right`;
//!   speed: data only, read by commands 1-4 and the instrument vibrato.
//! INFERRED throughout, from GoatTracker's documented table semantics; S5
//! pins them against real `.sng` files and adjusts this header with them.
//! No reference recording exists for a SID song played here (the S0-S2
//! caveat): what this player is proven to do is what its tests assert.
//!
//! S4 (the browser worklet, `wasm.rs`) adds what a transport needs:
//!   - the song row: rows started since the top (`song_row`), and the song's
//!     length in rows (`song_rows`, the longest channel's first pass, the
//!     app's grid length, `projectSidPatterns`);
//!   - `seek_row`: a fresh sequencer replayed to the row frame by frame
//!     without rendering (cheap: no chip cycles), then given the chip that was
//!     running. The registers are right at the row, and a note that sounded
//!     before carries on until a row retriggers it; the envelopes of notes
//!     started during the replay are NOT advanced (they start from wherever the
//!     running chip's are), so a seek lands "cold" on held notes;
//!   - a row-range loop (`set_loop_rows`, the tracker's "play pattern"): at
//!     the range's end the player seeks back to its start on the same chip;
//!   - a preview voice (`set_preview`): no sequencer; channel 1 is played by
//!     `preview_note_on` / `preview_note_off` with the song's instruments,
//!     tables and vibrato running as they do for a song note;
//!   - per-voice taps and mute/solo (`render_taps`, `Chip::set_voice_mask`).

use super::chip::{Chip, REG_FC_HI, REG_FC_LO, REG_MODE_VOL, REG_RES_FILT};
use super::song::{
    Instrument, Row, SidSong, TableRow, NOTE_FIRST, NOTE_KEY_OFF, NOTE_KEY_ON, NOTE_LAST,
    SID_CHANNELS,
};
use super::waveform::GATE;
use super::{gt_note_freq_reg, SidError, SidModel, GT_NOTE_COUNT};

/// PAL frames per second at multispeed 1.
pub const FRAME_HZ: f64 = 50.0;

#[derive(Debug, Clone, Default)]
struct Channel {
    // Sequencer.
    order: usize,
    repeat_left: u8,
    pattern: usize,
    row: usize,
    transpose: i8,
    // Voice.
    instrument: usize,
    base_note: u8,
    freq: u16,
    target: Option<u16>,
    gate: bool,
    waveform: u8,
    ad: u8,
    sr: u8,
    pulse_width: u16,
    first_frame: bool,
    first_wave: u8,
    cmd: u8,
    param: u8,
    // Tables.
    wave_ptr: u8,
    wave_wait: u8,
    pulse_ptr: u8,
    pulse_time: u8,
    pulse_speed: i8,
    // Vibrato (the command's or the instrument's).
    vib_delay: u8,
    vib_count: u8,
    vib_up: bool,
    vib_offset: i32,
}

/// Plays one subsong of a `SidSong` on a chip of the song's model.
#[derive(Debug, Clone)]
pub struct SidSongPlayer {
    song: SidSong,
    subsong: usize,
    chip: Chip,
    channels: [Channel; SID_CHANNELS],
    tempo: u8,
    tick: u8,
    frames: u64,
    looped: bool,
    samples_per_frame: f64,
    samples_to_frame: f64,
    // Global filter state.
    filter_ptr: u8,
    filter_time: u8,
    filter_speed: i8,
    cutoff: u16,
    res_filt: u8,
    mode: u8,
    volume: u8,
    // Transport (S4).
    song_rows: u64,
    rows_played: u64,
    loop_rows: Option<(u64, u64)>,
    preview: bool,
}

/// The note table index of row note `note` under `transpose`, clamped into
/// the table (`sidNoteIndex` in the app's projection does the same).
pub fn note_index(note: u8, transpose: i8) -> u8 {
    let i = note as i32 - NOTE_FIRST as i32 + transpose as i32;
    i.clamp(0, GT_NOTE_COUNT as i32 - 1) as u8
}

fn table_row(table: &[TableRow], ptr: u8) -> Option<TableRow> {
    if ptr == 0 {
        None
    } else {
        table.get(ptr as usize - 1).copied()
    }
}

impl SidSongPlayer {
    /// A player for subsong 0 at `sample_rate`, on a chip of the song's model.
    pub fn new(song: SidSong, sample_rate: f64) -> Result<SidSongPlayer, SidError> {
        let model = song.model;
        SidSongPlayer::with_model(song, model, sample_rate, 0)
    }

    /// A player for `subsong` on a chip of `model` (the song's own unless a
    /// caller overrides it, e.g. to compare the two chips on one song).
    pub fn with_model(
        song: SidSong,
        model: SidModel,
        sample_rate: f64,
        subsong: usize,
    ) -> Result<SidSongPlayer, SidError> {
        let chip = Chip::with_sample_rate(model, sample_rate)?;
        let subsong = subsong.min(song.subsongs.len().saturating_sub(1));
        let mut channels: [Channel; SID_CHANNELS] = Default::default();
        for (c, ch) in channels.iter_mut().enumerate() {
            ch.order = usize::MAX;
            let list = &song.subsongs[subsong].orderlists[c];
            Self::enter_order(ch, list, 0, &song);
        }
        let samples_per_frame = sample_rate / (FRAME_HZ * song.speed_multiplier as f64);
        let tempo = song.tempo;
        let song_rows = Self::first_pass_rows(&song, subsong);
        Ok(SidSongPlayer {
            song,
            subsong,
            chip,
            channels,
            tempo,
            tick: 0,
            frames: 0,
            looped: false,
            samples_per_frame,
            samples_to_frame: 0.0,
            filter_ptr: 0,
            filter_time: 0,
            filter_speed: 0,
            cutoff: 0,
            res_filt: 0,
            mode: 0,
            volume: 15,
            song_rows,
            rows_played: 0,
            loop_rows: None,
            preview: false,
        })
    }

    /// Rows of the longest channel's first pass through `subsong`'s orderlist.
    fn first_pass_rows(song: &SidSong, subsong: usize) -> u64 {
        song.subsongs[subsong]
            .orderlists
            .iter()
            .map(|list| {
                list.entries
                    .iter()
                    .map(|e| {
                        let pattern = (e.pattern as usize).min(song.patterns.len() - 1);
                        song.patterns[pattern].rows.len() as u64 * e.repeat as u64
                    })
                    .sum::<u64>()
            })
            .max()
            .unwrap_or(0)
    }

    /// The song's length in rows: the longest channel's first pass, where the
    /// app's grid ends (`projectSidPatterns`). Shorter channels loop within it.
    pub fn song_rows(&self) -> u64 {
        self.song_rows
    }

    /// The row the player is on, counted from the top of the subsong (it
    /// keeps counting past `song_rows` as the song loops on).
    pub fn song_row(&self) -> u64 {
        self.rows_played
    }

    /// The subsong this player plays.
    pub fn subsong(&self) -> usize {
        self.subsong
    }

    /// Moves to the start of song row `row` (see the header: sequencer replay,
    /// same chip). The next frame reads that row. A row loop stays set.
    pub fn seek_row(&mut self, row: u64) {
        let sample_rate = self.chip.sample_rate();
        let model = self.chip.model();
        let Ok(mut fresh) = SidSongPlayer::with_model(self.song.clone(), model, sample_rate, self.subsong) else {
            return;
        };
        while fresh.rows_played < row {
            fresh.frame();
        }
        fresh.loop_rows = self.loop_rows;
        fresh.preview = self.preview;
        std::mem::swap(&mut fresh.chip, &mut self.chip);
        *self = fresh;
    }

    /// Loops song rows `start..end` (`end` exclusive): reaching `end`, the
    /// player seeks back to `start`. `None` (or an empty range) plays on.
    pub fn set_loop_rows(&mut self, range: Option<(u64, u64)>) {
        self.loop_rows = range.filter(|(start, end)| end > start);
    }

    /// Preview mode: the sequencer stops; `preview_note_on` plays channel 1.
    pub fn set_preview(&mut self, on: bool) {
        self.preview = on;
        if on {
            for ch in self.channels.iter_mut() {
                ch.gate = false;
                ch.cmd = 0;
                ch.param = 0;
            }
        }
    }

    pub fn preview(&self) -> bool {
        self.preview
    }

    /// Preview mode: triggers instrument `instrument` (1-based) at note table
    /// index `note` on channel 1. `false` (nothing changed) outside preview
    /// mode or for an instrument the song lacks.
    pub fn preview_note_on(&mut self, instrument: usize, note: u8) -> bool {
        if !self.preview || instrument == 0 || instrument > self.song.instruments.len() {
            return false;
        }
        let ch = &mut self.channels[0];
        ch.instrument = instrument;
        ch.cmd = 0;
        ch.param = 0;
        self.trigger(0, note.min(GT_NOTE_COUNT - 1));
        true
    }

    /// Preview mode: releases the preview note (the instrument's release).
    pub fn preview_note_off(&mut self) {
        if self.preview {
            self.channels[0].gate = false;
        }
    }

    fn enter_order(ch: &mut Channel, list: &super::song::Orderlist, index: usize, song: &SidSong) {
        let entry = list.entries[index];
        ch.order = index;
        ch.pattern = (entry.pattern as usize).min(song.patterns.len() - 1);
        ch.transpose = entry.transpose;
        ch.repeat_left = entry.repeat;
        ch.row = 0;
    }

    pub fn chip(&self) -> &Chip {
        &self.chip
    }

    /// The chip, for what is not the song's to decide (the voice mask).
    pub fn chip_mut(&mut self) -> &mut Chip {
        &mut self.chip
    }

    pub fn song(&self) -> &SidSong {
        &self.song
    }

    /// Frames played so far.
    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// Output samples per frame (fractional).
    pub fn samples_per_frame(&self) -> f64 {
        self.samples_per_frame
    }

    /// Whether any channel's orderlist has wrapped to its restart.
    pub fn looped(&self) -> bool {
        self.looped
    }

    pub fn tempo(&self) -> u8 {
        self.tempo
    }

    /// Channel `c`'s place: (orderlist entry, row) of the row it plays next
    /// or is playing.
    pub fn position(&self, c: usize) -> (usize, usize) {
        (self.channels[c].order, self.channels[c].row)
    }

    /// The frequency register channel `c` holds before vibrato.
    pub fn channel_freq(&self, c: usize) -> u16 {
        self.channels[c].freq
    }

    /// The note table index channel `c` last triggered.
    pub fn channel_note(&self, c: usize) -> u8 {
        self.channels[c].base_note
    }

    /// Fill `out` with the song, frame by frame.
    pub fn render(&mut self, out: &mut [f32]) {
        self.render_inner(out, None);
    }

    /// `render`, and each voice's own signal into `taps` (`Chip::render_taps`).
    /// Every tap must be at least `out.len()` long.
    pub fn render_taps(&mut self, out: &mut [f32], taps: [&mut [f32]; 3]) {
        self.render_inner(out, Some(taps));
    }

    fn render_inner(&mut self, out: &mut [f32], mut taps: Option<[&mut [f32]; 3]>) {
        let mut i = 0;
        while i < out.len() {
            if self.samples_to_frame <= 0.0 {
                self.frame_with_loop();
                self.samples_to_frame += self.samples_per_frame;
            }
            let n = (self.samples_to_frame.ceil() as usize).clamp(1, out.len() - i);
            match taps.as_mut() {
                Some([a, b, c]) => self.chip.render_taps(
                    &mut out[i..i + n],
                    [&mut a[i..i + n], &mut b[i..i + n], &mut c[i..i + n]],
                ),
                None => self.chip.render(&mut out[i..i + n]),
            }
            self.samples_to_frame -= n as f64;
            i += n;
        }
    }

    /// One frame; then, when it ended the row loop's last row, straight back
    /// to the loop's start (so `song_row` never reports the row past it).
    fn frame_with_loop(&mut self) {
        self.frame();
        if let Some((start, end)) = self.loop_rows {
            if self.tick == 0 && !self.preview && self.rows_played >= end {
                let carried = self.samples_to_frame;
                self.seek_row(start);
                self.samples_to_frame = carried;
            }
        }
    }

    /// Plays one frame: sequencer, effects, tables, register writes.
    pub fn frame(&mut self) {
        if self.tick == 0 && !self.preview {
            for c in 0..SID_CHANNELS {
                let row = self.current_row(c);
                self.read_row(c, row);
            }
        }
        for c in 0..SID_CHANNELS {
            self.continuous(c);
            self.wave_step(c);
            self.pulse_step(c);
            self.hard_restart(c);
        }
        self.filter_step();
        self.write_registers();
        for ch in self.channels.iter_mut() {
            ch.first_frame = false;
        }
        self.frames += 1;
        if self.preview {
            return;
        }
        self.tick += 1;
        if self.tick >= self.tempo {
            self.tick = 0;
            self.rows_played += 1;
            for c in 0..SID_CHANNELS {
                self.advance_row(c);
            }
        }
    }

    fn current_row(&self, c: usize) -> Row {
        let ch = &self.channels[c];
        self.song.patterns[ch.pattern].rows.get(ch.row).copied().unwrap_or_default()
    }

    /// The row channel `c` reads at the next row start, without moving it.
    fn next_row(&self, c: usize) -> Row {
        let ch = &self.channels[c];
        let rows = &self.song.patterns[ch.pattern].rows;
        if ch.row + 1 < rows.len() {
            return rows[ch.row + 1];
        }
        let list = &self.song.subsongs[self.subsong].orderlists[c];
        let pattern = if ch.repeat_left > 1 {
            ch.pattern
        } else {
            let next = if ch.order + 1 < list.entries.len() { ch.order + 1 } else { list.restart as usize };
            list.entries[next].pattern as usize
        };
        self.song.patterns[pattern.min(self.song.patterns.len() - 1)].rows[0]
    }

    fn advance_row(&mut self, c: usize) {
        let len = self.song.patterns[self.channels[c].pattern].rows.len();
        let ch = &mut self.channels[c];
        ch.row += 1;
        if ch.row < len {
            return;
        }
        if ch.repeat_left > 1 {
            ch.repeat_left -= 1;
            ch.row = 0;
            return;
        }
        let list = &self.song.subsongs[self.subsong].orderlists[c];
        let next = if ch.order + 1 < list.entries.len() {
            ch.order + 1
        } else {
            self.looped = true;
            list.restart as usize
        };
        Self::enter_order(ch, list, next, &self.song);
    }

    fn instrument(&self, c: usize) -> Option<&Instrument> {
        let n = self.channels[c].instrument;
        if n == 0 {
            None
        } else {
            self.song.instruments.get(n - 1)
        }
    }

    fn speed_row(&self, ptr: u8) -> Option<TableRow> {
        table_row(&self.song.tables.speed, ptr)
    }

    fn read_row(&mut self, c: usize, row: Row) {
        if row.instrument > 0 {
            self.channels[c].instrument = row.instrument as usize;
        }
        let tone_porta = row.command == 3;
        if (NOTE_FIRST..=NOTE_LAST).contains(&row.note) {
            let note = note_index(row.note, self.channels[c].transpose);
            if tone_porta {
                let target = gt_note_freq_reg(note);
                let ch = &mut self.channels[c];
                ch.base_note = note;
                if row.param == 0 {
                    // Tie-note: "$00 ... move pitch instantly to target note"
                    // (GT readme §3.2 3XY). Pinned in S5: 4791 rows of 56 of
                    // the 61 GTS5 corpus songs are `3 00` legato notes.
                    ch.freq = target;
                    ch.target = None;
                } else {
                    ch.target = Some(target);
                }
            } else {
                self.trigger(c, note);
            }
        } else if row.note == NOTE_KEY_OFF {
            self.channels[c].gate = false;
        } else if row.note == NOTE_KEY_ON {
            self.channels[c].gate = true;
        }
        let p = row.param;
        let ch = &mut self.channels[c];
        ch.cmd = row.command;
        ch.param = p;
        match row.command {
            0x5 => ch.ad = p,
            0x6 => ch.sr = p,
            0x7 => ch.waveform = p & !GATE,
            0x8 => {
                ch.wave_ptr = p;
                ch.wave_wait = 0;
            }
            0x9 => {
                ch.pulse_ptr = p;
                ch.pulse_time = 0;
            }
            0xA => {
                self.filter_ptr = p;
                self.filter_time = 0;
            }
            0xB => self.res_filt = p,
            0xC => self.cutoff = (p as u16) << 3,
            0xD => self.volume = p & 0x0F,
            0xF => {
                if p & 0x7F >= 1 {
                    self.tempo = p & 0x7F;
                }
            }
            _ => {}
        }
    }

    fn trigger(&mut self, c: usize, note: u8) {
        let ins = self.instrument(c).cloned();
        let bit = 1u8 << c;
        let ch = &mut self.channels[c];
        ch.base_note = note;
        ch.freq = gt_note_freq_reg(note);
        ch.target = None;
        ch.gate = true;
        ch.first_frame = true;
        ch.vib_offset = 0;
        ch.vib_up = true;
        ch.vib_count = 0;
        let Some(ins) = ins else {
            ch.first_wave = 0;
            return;
        };
        ch.ad = ins.ad();
        ch.sr = ins.sr();
        ch.waveform = ins.waveform & !GATE;
        ch.pulse_width = ins.pulse_width;
        ch.first_wave = ins.first_wave;
        ch.wave_ptr = ins.wave_ptr;
        ch.wave_wait = 0;
        ch.pulse_ptr = ins.pulse_ptr;
        ch.pulse_time = 0;
        ch.vib_delay = ins.vibrato_delay;
        if ins.filter.enabled {
            self.res_filt |= bit;
        } else {
            self.res_filt &= !bit;
        }
        if ins.filter_ptr > 0 {
            self.filter_ptr = ins.filter_ptr;
            self.filter_time = 0;
        } else if ins.filter.enabled {
            self.cutoff = ins.filter.cutoff;
            self.res_filt = (ins.filter.resonance << 4) | (self.res_filt & 0x0F);
            self.mode = ins.filter.mode;
        }
    }

    fn vibrato(ch: &mut Channel, speed: u8, depth: u8) {
        let half = speed.max(1);
        if ch.vib_count == 0 && ch.vib_offset == 0 && ch.vib_up {
            // Centre the swing: the first half-swing is half as long.
            ch.vib_count = half / 2;
        }
        ch.vib_offset += if ch.vib_up { depth as i32 } else { -(depth as i32) };
        ch.vib_count += 1;
        if ch.vib_count >= half {
            ch.vib_count = 0;
            ch.vib_up = !ch.vib_up;
        }
    }

    fn continuous(&mut self, c: usize) {
        if self.channels[c].first_frame {
            return;
        }
        let (cmd, param) = (self.channels[c].cmd, self.channels[c].param);
        let speed = self.speed_row(param).map(|r| (r.left as u16) << 8 | r.right as u16);
        match cmd {
            0x1 => {
                if let Some(s) = speed {
                    let ch = &mut self.channels[c];
                    ch.freq = ch.freq.saturating_add(s);
                }
            }
            0x2 => {
                if let Some(s) = speed {
                    let ch = &mut self.channels[c];
                    ch.freq = ch.freq.saturating_sub(s);
                }
            }
            0x3 => {
                let ch = &mut self.channels[c];
                if let (Some(t), Some(s)) = (ch.target, speed) {
                    ch.freq = if ch.freq < t { ch.freq.saturating_add(s).min(t) } else { ch.freq.saturating_sub(s).max(t) };
                    if ch.freq == t {
                        ch.target = None;
                    }
                }
            }
            0x4 => {
                if let Some(r) = self.speed_row(param) {
                    Self::vibrato(&mut self.channels[c], r.left, r.right);
                }
            }
            _ => {}
        }
        if cmd != 0x4 {
            let vib = self.instrument(c).map(|i| i.speed_ptr).unwrap_or(0);
            if let Some(r) = self.speed_row(vib) {
                let ch = &mut self.channels[c];
                if ch.vib_delay > 0 {
                    ch.vib_delay -= 1;
                } else {
                    Self::vibrato(ch, r.left, r.right);
                }
            }
        }
    }

    fn wave_step(&mut self, c: usize) {
        let ch = &self.channels[c];
        if ch.first_frame && ch.first_wave != 0 {
            return;
        }
        let table = &self.song.tables.wave;
        let ch = &mut self.channels[c];
        let mut jumped = false;
        while let Some(row) = table_row(table, ch.wave_ptr) {
            match row.left {
                0xFF => {
                    if jumped || row.right == 0 || row.right as usize > table.len() {
                        ch.wave_ptr = 0;
                        return;
                    }
                    ch.wave_ptr = row.right;
                    jumped = true;
                    continue;
                }
                0x01..=0x0F => {
                    // A delayed step (pinned in S5): `left` frames of waiting,
                    // then the step's note on the next, so the row lasts
                    // left + 1 frames (GT readme §3.4.1's "02 03 ... Each step
                    // takes 3 ticks"). Note after the wait, not before:
                    // INFERRED from §1.1 note 5 (a delay as a program's first
                    // step "may result in missing notes").
                    if ch.wave_wait == 0 {
                        ch.wave_wait = row.left + 1;
                    }
                    ch.wave_wait -= 1;
                    if ch.wave_wait == 0 {
                        Self::wave_note(ch, row.right);
                        ch.wave_ptr = ch.wave_ptr.wrapping_add(1);
                    }
                }
                l => {
                    match l {
                        0x10..=0xDF => ch.waveform = l & !GATE,
                        0xE0..=0xEF => ch.waveform = l & 0x0E,
                        _ => {}
                    }
                    Self::wave_note(ch, row.right);
                    ch.wave_ptr = ch.wave_ptr.wrapping_add(1);
                }
            }
            break;
        }
        if ch.wave_ptr as usize > table.len() {
            ch.wave_ptr = 0;
        }
    }

    /// A wave-table row's right column: the note it sets, unless a portamento runs.
    fn wave_note(ch: &mut Channel, right: u8) {
        let note = match right {
            0x80 => None,
            r @ 0x00..=0x5F => Some(ch.base_note as i32 + r as i32),
            r @ 0x60..=0x7F => Some(ch.base_note as i32 + r as i32 - 0x80),
            r => Some((r & 0x7F) as i32),
        };
        let porta = matches!(ch.cmd, 0x1..=0x3);
        if let (Some(n), false) = (note, porta) {
            ch.freq = gt_note_freq_reg(n.clamp(0, GT_NOTE_COUNT as i32 - 1) as u8);
        }
    }

    fn pulse_step(&mut self, c: usize) {
        let table = &self.song.tables.pulse;
        let ch = &mut self.channels[c];
        let modulate = |ch: &mut Channel| {
            ch.pulse_width = ((ch.pulse_width as i32 + ch.pulse_speed as i32) & 0xFFF) as u16;
            ch.pulse_time -= 1;
        };
        if ch.pulse_time > 0 {
            modulate(ch);
            return;
        }
        let mut jumped = false;
        while let Some(row) = table_row(table, ch.pulse_ptr) {
            match row.left {
                0xFF => {
                    if jumped || row.right == 0 || row.right as usize > table.len() {
                        ch.pulse_ptr = 0;
                        return;
                    }
                    ch.pulse_ptr = row.right;
                    jumped = true;
                    continue;
                }
                0x80..=0xFE => ch.pulse_width = ((row.left as u16 & 0x0F) << 8) | row.right as u16,
                0x01..=0x7F => {
                    ch.pulse_time = row.left;
                    ch.pulse_speed = row.right as i8;
                    modulate(ch);
                }
                _ => {}
            }
            ch.pulse_ptr = ch.pulse_ptr.wrapping_add(1);
            break;
        }
        if ch.pulse_ptr as usize > table.len() {
            ch.pulse_ptr = 0;
        }
    }

    fn filter_step(&mut self) {
        let table = &self.song.tables.filter;
        let bump = |cutoff: u16, speed: i8| -> u16 { ((cutoff as i32 + ((speed as i32) << 3)).clamp(0, 0x7FF)) as u16 };
        if self.filter_time > 0 {
            self.cutoff = bump(self.cutoff, self.filter_speed);
            self.filter_time -= 1;
            return;
        }
        let mut jumped = false;
        while let Some(row) = table_row(table, self.filter_ptr) {
            match row.left {
                0xFF => {
                    if jumped || row.right == 0 || row.right as usize > table.len() {
                        self.filter_ptr = 0;
                        return;
                    }
                    self.filter_ptr = row.right;
                    jumped = true;
                    continue;
                }
                0x00 => self.cutoff = (row.right as u16) << 3,
                0x01..=0x7F => {
                    self.filter_time = row.left - 1;
                    self.filter_speed = row.right as i8;
                    self.cutoff = bump(self.cutoff, self.filter_speed);
                }
                0x80..=0xF0 => {
                    self.mode = (row.left >> 4) & 0x07;
                    self.res_filt = row.right;
                }
                _ => {}
            }
            self.filter_ptr = self.filter_ptr.wrapping_add(1);
            break;
        }
        if self.filter_ptr as usize > table.len() {
            self.filter_ptr = 0;
        }
    }

    fn hard_restart(&mut self, c: usize) {
        let Some((timer, hr)) = self.instrument(c).map(|i| (i.gate_timer, i.hard_restart)) else {
            return;
        };
        if timer == 0 || timer >= self.tempo || self.tick != self.tempo - timer {
            return;
        }
        let next = self.next_row(c);
        if !(NOTE_FIRST..=NOTE_LAST).contains(&next.note) || next.command == 3 {
            return;
        }
        let ch = &mut self.channels[c];
        ch.gate = false;
        if hr {
            ch.ad = 0;
            ch.sr = 0;
        }
    }

    fn write_registers(&mut self) {
        for (c, ch) in self.channels.iter().enumerate() {
            let base = (c * 7) as u8;
            let f = (ch.freq as i32 + ch.vib_offset).clamp(0, 0xFFFF) as u16;
            self.chip.write(base, (f & 0xFF) as u8);
            self.chip.write(base + 1, (f >> 8) as u8);
            self.chip.write(base + 2, (ch.pulse_width & 0xFF) as u8);
            self.chip.write(base + 3, (ch.pulse_width >> 8) as u8);
            self.chip.write(base + 5, ch.ad);
            self.chip.write(base + 6, ch.sr);
            let control = if ch.first_frame && ch.first_wave != 0 {
                ch.first_wave
            } else {
                ch.waveform | if ch.gate { GATE } else { 0 }
            };
            self.chip.write(base + 4, control);
        }
        self.chip.write(REG_FC_LO, (self.cutoff & 0x07) as u8);
        self.chip.write(REG_FC_HI, (self.cutoff >> 3) as u8);
        self.chip.write(REG_RES_FILT, self.res_filt);
        self.chip.write(REG_MODE_VOL, (self.mode << 4) | self.volume);
    }
}
