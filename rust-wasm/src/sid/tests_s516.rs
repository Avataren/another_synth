//! S5.16 tests: the pulse width carries across notes, as in GoatTracker.
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
