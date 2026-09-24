//! S5.16 tests: what GoatTracker leaves alone on a note, and two filter-table
//! rows the player mis-read. Checked against GT's own playroutine (gplay.c) on
//! "Coconut Conundrum", register by register.
//!
//! The pulse width carries across notes, as in GoatTracker.
//!
//! GT sets a channel's pulse width only from its pulse table (gplay.c:375-381,
//! 868-873), never on a note, so an instrument with no pulse table plays at
//! whatever width the channel last had. A GT instrument has no width of its
//! own (the importer writes 0), so a doc instrument with `pulse_width` 0 keeps
//! the channel's. Found in "Coconut Conundrum" (Stinsen): its bass alternates
//! an instrument with a pulse table and one without, and the second restarted
//! at width 0 (a pulse of width 0 is DC) and was heard as a "tock".

use super::player::SidSongPlayer;
use super::song::*;
use super::*;

const SPF: usize = 882;

fn t(l: u8, r: u8) -> TableRow {
    TableRow { left: l, right: r }
}

fn row(note: u8, instrument: u8) -> Row {
    Row { note, instrument, command: 0, param: 0 }
}

/// Instrument 1 sets the width to 0x640 with its pulse table (row 1: left
/// 0x86 = set, high nibble 6, right 0x40); instrument 2 has a pulse waveform
/// and no pulse table, like GT's; instrument 3 is the doc-native kind, with a
/// width of its own (0x200) and no table.
fn song(rows: Vec<Row>) -> SidSong {
    let n = rows.len();
    let base = |wave_ptr: u8, pulse_ptr: u8, pulse_width: u16| Instrument {
        name: b"t".to_vec(),
        sustain: 15,
        first_wave: 0x09,
        pulse_width,
        wave_ptr,
        pulse_ptr,
        ..Default::default()
    };
    let list = |pattern: u8| Orderlist { entries: vec![OrderEntry { pattern, transpose: 0, repeat: 1 }], restart: 0 };
    let s = SidSong {
        version: SONG_FILE_VERSION,
        model: SidModel::Sid8580,
        channels: 3,
        speed_multiplier: 1,
        tempo: 6,
        name: b"s516".to_vec(),
        author: Vec::new(),
        copyright: Vec::new(),
        subsongs: vec![Subsong { orderlists: vec![list(0), list(1), list(1)] }],
        patterns: vec![Pattern { rows }, Pattern { rows: vec![Row::default(); n] }],
        instruments: vec![base(1, 1, 0), base(3, 0, 0), base(1, 0, 0x200)],
        tables: Tables {
            // Row 1: pulse wave, note 0, stop. Row 3 is the same for instrument 2.
            wave: vec![t(0x41, 0x00), t(0xFF, 0x00), t(0x41, 0x00), t(0xFF, 0x00)],
            pulse: vec![t(0x86, 0x40), t(0xFF, 0x00)],
            ..Default::default()
        },
    };
    SidSong::parse(&s.to_bytes()).expect("parses")
}

/// Voice 1's pulse width register at the end of each frame of `frames`.
fn widths(s: &SidSong, frames: usize) -> Vec<u16> {
    let mut p = SidSongPlayer::new(s.clone(), DEFAULT_SAMPLE_RATE).expect("player builds");
    let mut out = vec![0.0f32; SPF];
    (0..frames)
        .map(|_| {
            p.render(&mut out);
            p.chip().voice(0).pulse_width()
        })
        .collect()
}

#[test]
fn an_instrument_without_a_pulse_table_keeps_the_channels_width() {
    // Tempo 6: row r starts at frame 6r. Row 0 (instrument 1) sets 0x640 via
    // its table; row 1 (instrument 2, no width, no table) must leave it.
    let w = widths(&song(vec![row(49, 1), row(49, 2)]), 12);
    assert_eq!(w[5], 0x640, "instrument 1's table set the width");
    assert_eq!(w[11], 0x640, "instrument 2 has none, so the channel keeps it (GT)");
}

#[test]
fn a_doc_instrument_with_its_own_width_still_sets_it_on_every_note() {
    let w = widths(&song(vec![row(49, 1), row(49, 3)]), 12);
    assert_eq!(w[5], 0x640);
    assert_eq!(w[11], 0x200, "a non-zero doc width is applied on the note, as before");
}

#[test]
fn the_first_note_of_a_song_still_starts_at_width_0() {
    // GT's channel starts at 0 and nothing has set it yet.
    let w = widths(&song(vec![row(49, 2)]), 6);
    assert_eq!(w[5], 0);
}

/// Like `song`, but with instrument 1's pulse table modulating for 16 frames
/// (+0x10 a frame) and instrument 2 (no pulse table) on the second row.
fn modulating_song(rows: Vec<Row>) -> SidSong {
    let mut s = song(rows);
    s.tables.pulse = vec![t(0x86, 0x40), t(0x10, 0x10), t(0xFF, 0x00)];
    SidSong::parse(&s.to_bytes()).expect("parses")
}

#[test]
fn an_instrument_without_a_pulse_table_leaves_the_running_one_going() {
    // GT sets a channel's pulse pointer only from an instrument that has a
    // table (gplay.c:375-378), so instrument 2's note keeps instrument 1's
    // modulation running: the width goes on rising through row 1 (frames
    // 6..11). Before S5.16 the pointer was cleared and the width froze.
    let w = widths(&modulating_song(vec![row(49, 1), row(49, 2)]), 12);
    assert!(w[5] >= 0x640, "instrument 1's table set the width and started modulating");
    for f in 7..12 {
        assert!(w[f] > w[f - 1], "frame {f}: the width keeps rising under instrument 2 ({:#x} -> {:#x})", w[f - 1], w[f]);
    }
}

/// Instrument 1 with a filter table of `rows`; channel 1 plays it once.
fn filter_song(rows: Vec<TableRow>) -> SidSong {
    let mut s = song(vec![row(49, 1)]);
    s.instruments[0].filter_ptr = 1;
    s.tables.filter = rows;
    SidSong::parse(&s.to_bytes()).expect("parses")
}

/// The filter's (cutoff register, resonance nibble, mode bits) after `frames`.
fn filter_after(s: &SidSong, frames: usize) -> (u16, u8, u8) {
    let mut p = SidSongPlayer::new(s.clone(), DEFAULT_SAMPLE_RATE).expect("player builds");
    let mut out = vec![0.0f32; SPF];
    for _ in 0..frames {
        p.render(&mut out);
    }
    let f = p.chip().filter();
    (f.cutoff_reg(), f.resonance(), f.mode())
}

#[test]
fn a_filter_set_row_takes_any_left_byte_from_0x80_to_0xfe() {
    // Only 0xFF is a jump (gplay.c:265). 0xF1 sets mode (0xF1 & 0x70 = LP+BP+HP)
    // and resonance 3 / voice 1; the player used to skip it (its range ended at
    // 0xF0), leaving the resonance of whatever instrument came before.
    let (_, res, mode) = filter_after(&filter_song(vec![t(0xF1, 0x31), t(0xFF, 0x00)]), 1);
    assert_eq!(res, 3);
    assert_eq!(mode, 0x70);
}

#[test]
fn a_cutoff_row_straight_after_a_set_row_is_taken_on_the_same_frame() {
    // gplay.c:271-275 ("Can be combined with cutoff set"): set + cutoff in one
    // frame, so the cutoff is 0x25 << 3 after frame 0, not a frame later.
    let (cutoff, res, mode) = filter_after(&filter_song(vec![t(0x91, 0xF1), t(0x00, 0x25), t(0xFF, 0x00)]), 1);
    assert_eq!((cutoff, res, mode), (0x25 << 3, 15, 0x10));
}

// ---------------------------------------------------------------------------
// The GT-reference 6581 profile (`revision::GT_REF`) and R4AR beside it
// ---------------------------------------------------------------------------

use super::filter::{cutoff_hz_6581_with, resonance_q_6581_with};
use super::revision::{DieRevision, GT_REF, R4AR};
use super::Chip;

#[test]
fn the_default_6581_is_the_gt_reference_and_r4ar_is_still_a_profile_a_chip_can_take() {
    let d = Chip::new(SidModel::Sid6581).unwrap();
    let r = Chip::with_profile(SidModel::Sid6581, DEFAULT_SAMPLE_RATE, &R4AR).unwrap();
    let g = Chip::with_profile(SidModel::Sid6581, DEFAULT_SAMPLE_RATE, &GT_REF).unwrap();
    for c in [&d, &g] {
        assert_eq!(c.filter().cutoff(), cutoff_hz_6581_with(&GT_REF, 0));
    }
    assert_eq!(r.filter().cutoff(), cutoff_hz_6581_with(&R4AR, 0));
    assert_eq!(GT_REF.revision, DieRevision::GtRef);
}

#[test]
fn gt_ref_cutoff_hits_the_measured_points_and_stays_below_r4ars_chords_at_the_low_end() {
    // Measured f0 of GT's 6581 low-pass (two-pole fit, res 0), Hz.
    for (reg, hz) in [(0u16, 219.0), (0x100, 248.0), (0x200, 417.0), (0x280, 778.0), (0x300, 1_628.0), (0x380, 3_331.0)] {
        assert!((cutoff_hz_6581_with(&GT_REF, reg) - hz).abs() < 1e-9, "reg {reg:#05x}");
    }
    // Between anchors it is log-linear: 0x160 is sqrt(266 * 299).
    assert!((cutoff_hz_6581_with(&GT_REF, 0x160) - (266.0f64 * 299.0).sqrt()).abs() < 1e-9);
    // R4AR's four chords ran 15-25% high across 0x080..=0x1C0; GtRef is under them.
    for reg in [0x080u16, 0x0C0, 0x100, 0x140, 0x180, 0x1C0] {
        assert!(cutoff_hz_6581_with(&GT_REF, reg) < cutoff_hz_6581_with(&R4AR, reg) * 0.95, "reg {reg:#05x}");
    }
    // Above the measurement the high piece is R4AR's.
    assert_eq!(cutoff_hz_6581_with(&GT_REF, 0x500), cutoff_hz_6581_with(&R4AR, 0x500));
}

#[test]
fn gt_ref_resonance_is_linear_and_r4ars_is_the_old_exponential() {
    // Measured Q: 0.72 at 0, 1.76 at 15, linear in between.
    assert!((resonance_q_6581_with(&GT_REF, 0) - 0.707).abs() < 1e-12);
    assert!((resonance_q_6581_with(&GT_REF, 15) - (0.707 + 15.0 * 0.0698)).abs() < 1e-12);
    for r in 1..16u8 {
        let step = resonance_q_6581_with(&GT_REF, r) - resonance_q_6581_with(&GT_REF, r - 1);
        assert!((step - 0.0698).abs() < 1e-12, "res {r}");
    }
    // R4AR keeps 0.707 * 2^(res/12): 1.414 at 12.
    assert!((resonance_q_6581_with(&R4AR, 12) - 1.414).abs() < 1e-12);
}

#[test]
fn an_8580_ignores_the_profile() {
    let a = Chip::with_profile(SidModel::Sid8580, DEFAULT_SAMPLE_RATE, &R4AR).unwrap();
    let b = Chip::with_profile(SidModel::Sid8580, DEFAULT_SAMPLE_RATE, &GT_REF).unwrap();
    assert_eq!(a.filter().cutoff(), b.filter().cutoff());
    assert_eq!(a.filter().q(), b.filter().q());
}
