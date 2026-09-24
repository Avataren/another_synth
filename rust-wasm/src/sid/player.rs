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
//!      orderlist entry as GT's u8 arithmetic does, never clamped: S5.10,
//!      `note_index`) triggers it: the
//!      instrument's AD/SR, waveform, pulse width and table pointers are
//!      loaded, the gate goes on and the first-frame waveform (if any) is
//!      written this frame; key off clears the gate, key on sets it; then
//!      the row's command;
//!   2. per channel the wave table, then, unless a wave step set a note
//!      (GT ends the frame there, gplay.c:722), the running command (1, 2,
//!      3, 4, or 0's instrument vibrato); the pulse table; then the (global)
//!      filter table;
//!   3. the hard restart: `gate_timer` frames before a row that triggers a
//!      note, the gate is cleared, and with `hard_restart` AD/SR go to 0;
//!   4. every register is written: per voice frequency, pulse
//!      width, AD, SR, then control (`waveform & gate mask`, below); then
//!      cutoff, resonance/routing and mode/volume.
//!
//! The control byte (S5.9, GT2 source): the waveform is a whole control
//! byte, gate bit included, as GoatTracker keeps it (`cptr->wave`), and the
//! channel's gate is a MASK over it, 0xFF on, 0xFE off (gplay.c:129, 148,
//! 362, 916, 918, 926); the register is `waveform & mask` (gplay.c:945). So
//! a wave-table row or command 7 with the gate bit clear releases the note
//! even while the channel's gate is on (the classic drum ending, `$80` noise
//! or `$40` pulse), a gate-set row after it retriggers, and after a key off
//! no waveform byte raises the gate. An instrument's own `waveform` is the
//! doc's gate-clear control byte (`song.rs`): a trigger stores it with the
//! gate bit set, so it sounds as it always has.
//!
//! Commands (the row's command nibble and parameter; GoatTracker's command
//! set, from its format documentation, interpreted here, not copied):
//!   0 none; 1/2 portamento up/down and 3 tone portamento at the 16-bit
//!   register speed held in speed-table row `param` (left<<8 | right);
//!   4 vibrato with speed-table row `param`, GoatTracker's (S5.10,
//!   `vibrato`: left = turn value, $80 up fine mode, right = register step);
//!   5 AD = param; 6 SR = param;
//!   7 waveform = param (the whole byte, gate bit included, gplay.c:433);
//!   8/9/A start the wave/pulse/filter table at row
//!   `param`; B resonance/routing ($17) = param; C cutoff high byte = param;
//!   D master volume = param & 15; E funktempo: not modelled (ignored);
//!   F tempo = param & 0x7F when it is at least 1. A row with command 3 and
//!   a note glides to it instead of triggering; with parameter 0 (GT's
//!   tie-note, readme §3.2) the pitch jumps to it on the row's second frame
//!   (tick 1; GT's realtime optimisation skips tick 0, goattrk2.c:55,
//!   gplay.c:728) and is re-asserted every tick the command stands
//!   (gplay.c:807-811), still without a trigger; wave-table note rows pass
//!   through under it and win their frame (gplay.c:714-722, 722). Pinned in
//!   S5, phase and passthrough aligned in S5.6 against the `.sng` corpus and
//!   the GT2 source.
//!   S5.10, GT's running command (gplay.c:351-358, 397-428): a new note sets
//!   it to 0 with the instrument's speed row and vibrato delay; commands 0-4
//!   replace it; 5-F leave it, so a vibrato or a slide runs on under them.
//!   Command 0 runs the instrument vibrato: a delay of 0 never, above 1
//!   counting down, at 1 swinging (gplay.c:767-772). The vibrato skips tick
//!   0 as GT's realtime optimisation does (gplay.c:728); commands 1-3 do
//!   not yet (pre-existing, unchanged here).
//!
//! Tables (1-based rows; left 0xFF = jump to row `right`, 0 = stop; one
//! jump per frame):
//!   wave: left 0x01..=0x0F waits that many frames, then sets the row's note
//!     (the row lasts left + 1 frames; pinned in S5); 0x10..=0xDF
//!     sets the waveform to `left` whole, 0xE0..=0xEF to `left & 0x0F`, the
//!     gate bit kept in both (gplay.c:525, 527; S5.9), 0x00 keeps it,
//!     0xF0..=0xFE (GT's table commands) is not modelled and only advances
//!     (its right column is not a note). right, GT's arithmetic
//!     (S5.10, gplay.c:714-721): 0x00..=0x7F added to the channel's note,
//!     0x80 no change, 0x81..=0xFF the absolute note, then `& 0x7F`, into the
//!     128-entry table (96 notes, then zeros: `gt_note_freq_reg`). This right
//!     column is the arpeggio;
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
    /// GT's `cptr->note`: the row note's index under the transpose, a u8
    /// that wraps (gplay.c:350, 921), unmasked.
    base_note: u8,
    /// GT's `cptr->lastnote`: the 7-bit index last played (gplay.c:721),
    /// for the fine vibrato's step.
    last_note: u8,
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
    /// GT's running `command`/`cmddata` (gplay.c:351-358, 397-428): set by a
    /// new note (0 and the instrument's speed row) and by commands 0-4; 5-F
    /// leave them. The tick effects (portamento, vibrato) read these.
    run_cmd: u8,
    run_param: u8,
    // Tables.
    wave_ptr: u8,
    wave_wait: u8,
    pulse_ptr: u8,
    pulse_time: u8,
    pulse_speed: i8,
    // Vibrato (the command's or the instrument's): GT's `vibdelay` and u8
    // `vibtime` (gplay.c:352, 615-640).
    vib_delay: u8,
    vib_time: u8,
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

/// The note index of row note `note` under `transpose`, as GoatTracker
/// computes it: `newnote = (u8)(note + trans)`, `cptr->note = (u8)(newnote -
/// FIRSTNOTE)` (gplay.c:921, 350), so it WRAPS: G#7 +5 is 97, C-0 -1 is 255.
/// Never clamped (S5.10; the old clamp to G#7 played up to 5 semitones flat).
/// The table reads it `& 0x7f` (`gt_note_freq_reg`). The app's display
/// (`sidNoteIndex`) still clamps: a grid cell can only name C-0..G#7.
pub fn note_index(note: u8, transpose: i8) -> u8 {
    (note as i32 - NOTE_FIRST as i32 + transpose as i32) as u8
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
                ch.run_cmd = 0;
                ch.run_param = 0;
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
        self.new_note(0, note.min(GT_NOTE_COUNT - 1));
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

    /// The frequency register channel `c` holds (vibrato included: GT's
    /// vibrato moves `cptr->freq` itself, gplay.c:636-639).
    pub fn channel_freq(&self, c: usize) -> u16 {
        self.channels[c].freq
    }

    /// The note index channel `c` last triggered (GT's `cptr->note`, unmasked).
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
            // GT runs the wave table first; a step that sets a note ends the
            // channel's frame before the tick effects (gplay.c:714-722
            // `goto PULSEEXEC`), so that frame neither slides nor vibrates.
            if !self.wave_step(c) {
                self.continuous(c);
            }
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
            self.new_note(c, note);
            if tone_porta {
                // Tie-note and glide rows: no trigger, and no tick-0 pitch
                // write. GT's realtime optimisation (goattrk2.c:55
                // optimizerealtime = 1) skips the tick-N effects on tick 0
                // (gplay.c:728), so the `3 00` instant jump ("$00 ... move
                // pitch instantly to target note", readme §3.2; gplay.c:807-811,
                // "ST = 00 slides instantly", commands PDF p.1) lands on tick 1
                // and is re-asserted every tick the command stands (see
                // continuous, command 3). Pinned in S5: 4791 raw pattern rows
                // (not orderlist-expanded) in 56 of the 61 GTS5 corpus songs
                // are `3 00` with a real note (4930 with key-offs). Phase
                // aligned in S5.6 (.ai/sid-crosscheck-verdict.md (a), 1).
                let ch = &mut self.channels[c];
                ch.target = Some(gt_note_freq_reg(note));
            } else {
                self.trigger(c, note);
            }
        } else if row.note == NOTE_KEY_OFF {
            self.channels[c].gate = false;
        } else if row.note == NOTE_KEY_ON {
            self.channels[c].gate = true;
        }
        let p = row.param;
        let speed_ptr = self.instrument(c).map(|i| i.speed_ptr).unwrap_or(0);
        let ch = &mut self.channels[c];
        ch.cmd = row.command;
        ch.param = p;
        match row.command {
            // GT's tick-0 commands (gplay.c:397-428): 0 hands the tick
            // effects to the instrument's vibrato (its speed row, on the
            // instrument the channel now has); 1 and 2 restart the vibrato
            // phase; 1-4 take over. 5-F below leave the running command.
            0x0 => {
                ch.run_cmd = 0;
                ch.run_param = speed_ptr;
            }
            0x1 | 0x2 => {
                ch.vib_time = 0;
                ch.run_cmd = row.command;
                ch.run_param = p;
            }
            0x3 | 0x4 => {
                ch.run_cmd = row.command;
                ch.run_param = p;
            }
            0x5 => ch.ad = p,
            0x6 => ch.sr = p,
            // CMD_SETWAVE (gcommon.h:11): the whole byte (gplay.c:433).
            0x7 => ch.waveform = p,
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

    /// GT's new-note init (gplay.c:348-358), glide or trigger alike: the
    /// note, and the running command back to 0 with the instrument's speed
    /// row and vibrato delay.
    fn new_note(&mut self, c: usize, note: u8) {
        let (speed_ptr, delay) = self.instrument(c).map(|i| (i.speed_ptr, i.vibrato_delay)).unwrap_or((0, 0));
        let ch = &mut self.channels[c];
        ch.base_note = note;
        ch.run_cmd = 0;
        ch.run_param = speed_ptr;
        ch.vib_delay = delay;
    }

    fn trigger(&mut self, c: usize, note: u8) {
        let ins = self.instrument(c).cloned();
        let bit = 1u8 << c;
        let ch = &mut self.channels[c];
        // The pitch GT's wave table sets on the note's first step (a row
        // with note column $00 is `cptr->note & 0x7f`, vibtime 0,
        // gplay.c:714-721); set here at once, and again by that step.
        ch.last_note = note & 0x7F;
        ch.freq = gt_note_freq_reg(note);
        ch.target = None;
        ch.gate = true;
        ch.first_frame = true;
        ch.vib_time = 0;
        let Some(ins) = ins else {
            ch.first_wave = 0;
            return;
        };
        ch.ad = ins.ad();
        ch.sr = ins.sr();
        // The doc's instrument waveform has no gate bit (`song.rs`); under the
        // AND-mask write it carries one, so the note sounds until a table row,
        // command 7, key off or hard restart says otherwise. S5.9 kept this
        // byte what the player wrote before (0x01 for an imported GT
        // instrument, whose table sets the waveform); GT itself would hold the
        // first-frame byte here (gplay.c:361), see the verdict.
        ch.waveform = ins.waveform | GATE;
        ch.pulse_width = ins.pulse_width;
        ch.first_wave = ins.first_wave;
        ch.wave_ptr = ins.wave_ptr;
        ch.wave_wait = 0;
        ch.pulse_ptr = ins.pulse_ptr;
        ch.pulse_time = 0;
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

    /// One vibrato frame, GoatTracker's (gplay.c:615-640, 776-799): speed
    /// row `ptr` gives the turn value (left) and the register step (right);
    /// a left of $80 up is the fine mode, whose step is the gap from the
    /// last note to the next, shifted right by `right`. `vibtime` is a u8:
    /// past the turn value (and below $80) it flips to its complement, then
    /// steps by 2; odd goes down, even up. A turn value k gives a first swing
    /// of k/2 + 1 frames, then k + 2 frames each way (even k).
    fn vibrato(&mut self, c: usize, ptr: u8) {
        let (mut turn, mut step) = self.speed_row(ptr).map(|r| (r.left, r.right as u16)).unwrap_or((0, 0));
        let ch = &mut self.channels[c];
        if turn >= 0x80 {
            turn &= 0x7F;
            let at = |i: u8| if i < 0x80 { gt_note_freq_reg(i) } else { 0 };
            let shift = self.song.tables.speed.get(ptr as usize - 1).map(|r| r.right).unwrap_or(0);
            step = at(ch.last_note + 1).wrapping_sub(at(ch.last_note)).checked_shr(shift as u32).unwrap_or(0);
        }
        if ch.vib_time < 0x80 && ch.vib_time > turn {
            ch.vib_time ^= 0xFF;
        }
        ch.vib_time = ch.vib_time.wrapping_add(2);
        ch.freq = if ch.vib_time & 1 != 0 { ch.freq.wrapping_sub(step) } else { ch.freq.wrapping_add(step) };
    }

    fn continuous(&mut self, c: usize) {
        if self.channels[c].first_frame {
            return;
        }
        let (cmd, param) = (self.channels[c].run_cmd, self.channels[c].run_param);
        let speed = self.speed_row(param).map(|r| (r.left as u16) << 8 | r.right as u16);
        // GT's realtime optimisation skips the tick effects on tick 0
        // (goattrk2.c:55, gplay.c:728). Applied to the vibrato here (S5.10);
        // the portamentos 1-3 still slide on tick 0 (a pre-existing
        // difference, not this batch's). The preview voice has no rows.
        let tick0 = self.tick == 0 && !self.preview;
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
                if ch.run_param == 0 {
                    // Tie-note pitch, GT phase (S5.6): the tick effects run
                    // from tick 1 (tick 0 is skipped by the realtime
                    // optimisation, goattrk2.c:55 + gplay.c:728) and re-assert
                    // the last note's table frequency every tick command 3
                    // stands (gplay.c:802-811: cmddata == 0 → freq =
                    // freqtbl[cptr->note], vibtime = 0; cptr->note is the
                    // persistent last note, gplay.c:350 — a `3 00` on a rest
                    // or key-off row snaps back to it too). A wave-table note
                    // row wins its own frame (gplay.c:714-722 jumps past the
                    // effects); the wave step runs after this and overwrites
                    // the same way.
                    if self.tick != 0 {
                        ch.freq = gt_note_freq_reg(ch.base_note);
                    }
                } else if let (Some(t), Some(s)) = (ch.target, speed) {
                    ch.freq = if ch.freq < t { ch.freq.saturating_add(s).min(t) } else { ch.freq.saturating_sub(s).max(t) };
                    if ch.freq == t {
                        ch.target = None;
                    }
                }
            }
            0x4 if !tick0 => self.vibrato(c, param),
            // The instrument vibrato is command 0's fall-through into 4
            // (gplay.c:767-772): no speed row or a delay of 0 never
            // vibrates; a delay above 1 counts down a frame; at 1 it swings.
            0x0 if !tick0 => {
                let ch = &mut self.channels[c];
                if param == 0 || ch.vib_delay == 0 {
                    return;
                }
                if ch.vib_delay > 1 {
                    ch.vib_delay -= 1;
                    return;
                }
                self.vibrato(c, param);
            }
            _ => {}
        }
    }

    /// The wave table's frame; `true` when a step set a note (or ran a
    /// table command), which ends GT's frame before the tick effects.
    fn wave_step(&mut self, c: usize) -> bool {
        let ch = &self.channels[c];
        if ch.first_frame && ch.first_wave != 0 {
            return false;
        }
        let table = &self.song.tables.wave;
        let ch = &mut self.channels[c];
        let mut jumped = false;
        let mut noted = false;
        while let Some(row) = table_row(table, ch.wave_ptr) {
            match row.left {
                0xFF => {
                    if jumped || row.right == 0 || row.right as usize > table.len() {
                        ch.wave_ptr = 0;
                        return false;
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
                    // CONFIRMED by GT2 gplay.c:693-722 (the delay branch skips
                    // to the tick effects until the wait ends, then the row's
                    // note is applied as the pointer advances).
                    if ch.wave_wait == 0 {
                        ch.wave_wait = row.left + 1;
                    }
                    ch.wave_wait -= 1;
                    if ch.wave_wait == 0 {
                        noted = Self::wave_note(ch, row.right);
                        ch.wave_ptr = ch.wave_ptr.wrapping_add(1);
                    }
                }
                l => {
                    match l {
                        // The gate bit is the row's (gplay.c:525, 527): a row
                        // with it clear releases the note (S5.9).
                        0x10..=0xDF => ch.waveform = l,
                        0xE0..=0xEF => ch.waveform = l & 0x0F,
                        _ => {}
                    }
                    // $F0-$FE run a table command (not modelled): its right
                    // column is the command's parameter, not a note, and GT
                    // skips the tick effects that frame (gplay.c:704-710).
                    noted = if l >= 0xF0 { true } else { Self::wave_note(ch, row.right) };
                    ch.wave_ptr = ch.wave_ptr.wrapping_add(1);
                }
            }
            break;
        }
        if ch.wave_ptr as usize > table.len() {
            ch.wave_ptr = 0;
        }
        noted
    }

    /// A wave-table row's right column: the note it sets, under any command.
    /// GT's wave-note path has no command check (gplay.c:714-722): the note
    /// applies while a portamento stands too, and that frame skips the tick
    /// effects (gplay.c:722), so the wave note wins it. S5.6: the S3-era
    /// suppression under commands 1-3 is removed. S5.10: GT's arithmetic,
    /// mod 128 (gplay.c:714-721): $00-$7F is added to the channel's note
    /// ($7F is one down, $60 is 32 down only when that stays above C-0),
    /// $81-$FF is the absolute note `right & 0x7f`, then `& 0x7f`; never
    /// clamped. The step resets the vibrato phase and is the fine vibrato's
    /// last note. `false`: $80, no note.
    fn wave_note(ch: &mut Channel, right: u8) -> bool {
        if right == 0x80 {
            return false;
        }
        let note = if right < 0x80 { ch.base_note.wrapping_add(right) } else { right } & 0x7F;
        ch.freq = gt_note_freq_reg(note);
        ch.vib_time = 0;
        ch.last_note = note;
        true
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
            self.chip.write(base, (ch.freq & 0xFF) as u8);
            self.chip.write(base + 1, (ch.freq >> 8) as u8);
            self.chip.write(base + 2, (ch.pulse_width & 0xFF) as u8);
            self.chip.write(base + 3, (ch.pulse_width >> 8) as u8);
            self.chip.write(base + 5, ch.ad);
            self.chip.write(base + 6, ch.sr);
            let control = if ch.first_frame && ch.first_wave != 0 {
                ch.first_wave
            } else {
                // `wave & gate` (gplay.c:945): the channel's gate is a mask.
                ch.waveform & if ch.gate { 0xFF } else { !GATE }
            };
            self.chip.write(base + 4, control);
        }
        self.chip.write(REG_FC_LO, (self.cutoff & 0x07) as u8);
        self.chip.write(REG_FC_HI, (self.cutoff >> 3) as u8);
        self.chip.write(REG_RES_FILT, self.res_filt);
        self.chip.write(REG_MODE_VOL, (self.mode << 4) | self.volume);
    }
}
