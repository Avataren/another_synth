//! Golden-value tests for `ahx::format` against the real fixtures vendored
//! at `.ai/ahx/references/fixtures/` and copied to `public/demos/ahx/` (see
//! `.ai/p0-report.md`). Expected values were derived by hand-tracing
//! `hvl_load_ahx`/`hvl_load_hvl` (`.ai/ahx/references/hvl_replay.c`) against
//! the raw bytes, independently of this Rust implementation, then
//! cross-checked with a throwaway Python port of the same byte offsets --
//! both arrived at human-readable song/instrument names, which is strong
//! evidence the offsets are right (garbage offsets don't decode to
//! `"never gonna give you up"`).

use audio_processor::ahx::format::{self, SongFormat};
use std::fs;
use std::path::{Path, PathBuf};

fn demos_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/demos/ahx")
}

fn load(name: &str) -> Vec<u8> {
    fs::read(demos_dir().join(name)).unwrap_or_else(|e| panic!("reading fixture {name}: {e}"))
}

#[test]
fn looks_like_ahx_or_hvl_sniffs_every_fixture() {
    for name in [
        "karma.ahx",
        "chiprolled.hvl",
        "doobrey_gubbins.hvl",
        "drainage_proble.hvl",
        "illuminated.hvl",
        "moderate_sellotaping.hvl",
        "sliding_away.hvl",
        "sunspots.hvl",
    ] {
        let bytes = load(name);
        assert!(
            format::looks_like_ahx_or_hvl(&bytes),
            "{name} should sniff as AHX/HVL"
        );
    }
    assert!(!format::looks_like_ahx_or_hvl(b"not an ahx file"));
    assert!(!format::looks_like_ahx_or_hvl(b""));
}

#[test]
fn karma_ahx_header_decodes() {
    let bytes = load("karma.ahx");
    let song = format::parse(&bytes).expect("karma.ahx should parse");

    assert_eq!(song.format, SongFormat::Ahx);
    assert_eq!(song.version, 1);
    assert_eq!(song.name, "Karma");
    assert_eq!(song.channels, 4);
    assert_eq!(song.position_nr, 38);
    assert_eq!(song.restart, 0);
    assert_eq!(song.speed_multiplier, 1);
    assert_eq!(song.track_length, 64);
    assert_eq!(song.track_nr, 74);
    assert_eq!(song.instrument_nr, 31);
    assert_eq!(song.subsong_nr, 0);
    assert!(song.subsongs.is_empty());
    assert_eq!(song.mixgain_raw, None);
    assert_eq!(song.defstereo, None);

    // Position/track/instrument table sizes are 1-past-max-index sized
    // (index 0 reserved), matching `ht_Tracks[0..=trkn]` /
    // `ht_Instruments[0..=insn]` in the reference.
    assert_eq!(song.positions.len(), 38);
    assert_eq!(song.tracks.len(), 75);
    assert_eq!(song.instruments.len(), 32);
}

#[test]
fn karma_ahx_first_position_decodes() {
    let bytes = load("karma.ahx");
    let song = format::parse(&bytes).unwrap();

    let pos0 = &song.positions[0];
    assert_eq!(pos0.track, vec![12, 13, 23, 56]);
    assert_eq!(pos0.transpose, vec![0, 0, 0, 0]);
}

#[test]
fn karma_ahx_instrument_one_decodes() {
    let bytes = load("karma.ahx");
    let song = format::parse(&bytes).unwrap();

    let ins = &song.instruments[1];
    assert_eq!(ins.name, "#Oxide/Sonik");
    assert_eq!(ins.volume, 38);
    assert_eq!(ins.wave_length, 3);
    assert_eq!(ins.filter_speed, 0);
    assert_eq!(
        ins.envelope,
        format::Envelope {
            a_frames: 3,
            a_volume: 64,
            d_frames: 3,
            d_volume: 40,
            s_frames: 1,
            r_frames: 101,
            r_volume: 14,
        }
    );
    assert_eq!(ins.filter_lower_limit, 0);
    assert_eq!(ins.filter_upper_limit, 0);
    assert_eq!(ins.vibrato_delay, 17);
    assert_eq!(ins.vibrato_speed, 8);
    assert_eq!(ins.vibrato_depth, 2);
    assert!(!ins.hard_cut_release);
    assert_eq!(ins.hard_cut_release_frames, 1);
    assert_eq!(ins.square_lower_limit, 4);
    assert_eq!(ins.square_upper_limit, 63);
    assert_eq!(ins.square_speed, 2);

    // PList: 3 entries, speed 3. First entry carries a note offset and two
    // FX slots (the AHX 3-bit-with-remap encoding: raw nibble 3 and 4 stay
    // 3 and 4, neither hits the 6->12/7->15 remap here).
    assert_eq!(ins.plist.speed, 3);
    assert_eq!(ins.plist.entries.len(), 3);
    assert_eq!(
        ins.plist.entries[0],
        format::PListEntry {
            note: 1,
            waveform: 1,
            fixed: false,
            fx: [3, 4],
            fx_param: [63, 0],
        }
    );
    assert_eq!(ins.plist.entries[1], format::PListEntry::default());
    assert_eq!(ins.plist.entries[2], format::PListEntry::default());
}

#[test]
fn karma_ahx_every_instrument_has_a_plist() {
    // The reference source's PList-space precompute pass
    // (`hvl_load_ahx:148-152`) walks every instrument's `bptr[21]` before
    // any allocation happens; if per-instrument PList length were decoded
    // wrong, this walk and the later fill pass would disagree and produce
    // garbage for instruments past the first mismatch. All 31 real
    // instruments in this fixture carry a non-empty PList, so this is a
    // whole-file consistency check, not just an instrument-1 spot check.
    let bytes = load("karma.ahx");
    let song = format::parse(&bytes).unwrap();

    assert_eq!(song.instruments.len() - 1, 31);
    for (i, ins) in song.instruments.iter().enumerate().skip(1) {
        assert!(
            !ins.plist.entries.is_empty(),
            "instrument {i} ({}) expected a non-empty PList",
            ins.name
        );
    }
}

#[test]
fn chiprolled_hvl_header_decodes() {
    let bytes = load("chiprolled.hvl");
    let song = format::parse(&bytes).expect("chiprolled.hvl should parse");

    assert_eq!(song.format, SongFormat::Hvl);
    assert_eq!(song.version, 0);
    assert_eq!(song.name, "never gonna give you up");
    // HVL packs a channel count into the header and it is not always 4 --
    // this fixture alone contradicts `verdict.md`'s "AHX is always 4
    // channels" framing for the HVL half of the format family. See
    // `.ai/p0-report.md`.
    assert_eq!(song.channels, 6);
    assert_eq!(song.position_nr, 196);
    assert_eq!(song.restart, 0);
    assert_eq!(song.speed_multiplier, 2);
    assert_eq!(song.track_length, 16);
    assert_eq!(song.track_nr, 84);
    assert_eq!(song.instrument_nr, 11);
    assert_eq!(song.subsong_nr, 0);
    assert_eq!(song.mixgain_raw, Some(86));
    assert_eq!(song.defstereo, Some(2));

    let pos0 = &song.positions[0];
    assert_eq!(pos0.track, vec![1, 3, 0, 0, 6, 45]);
    assert_eq!(pos0.transpose, vec![0, 0, 0, 0, 0, 0]);
}

#[test]
fn chiprolled_hvl_instrument_one_decodes() {
    let bytes = load("chiprolled.hvl");
    let song = format::parse(&bytes).unwrap();

    let ins = &song.instruments[1];
    assert_eq!(ins.name, "i think i just");
    assert_eq!(ins.volume, 64);
    assert_eq!(ins.wave_length, 5);
    assert_eq!(
        ins.envelope,
        format::Envelope {
            a_frames: 1,
            a_volume: 64,
            d_frames: 1,
            d_volume: 64,
            s_frames: 1,
            r_frames: 12,
            r_volume: 0,
        }
    );
    assert_eq!(ins.filter_lower_limit, 1);
    assert_eq!(ins.filter_upper_limit, 31);
    assert_eq!(ins.square_lower_limit, 32);
    assert_eq!(ins.square_upper_limit, 63);
    assert_eq!(ins.square_speed, 3);

    // PList: 2 entries, speed 1 -- HVL's direct 4-bit FX codes (fx=4 needs
    // no 6/7 remap the way AHX's 3-bit encoding would).
    assert_eq!(ins.plist.speed, 1);
    assert_eq!(ins.plist.entries.len(), 2);
    assert_eq!(
        ins.plist.entries[0],
        format::PListEntry {
            note: 1,
            waveform: 3,
            fixed: false,
            fx: [4, 0],
            fx_param: [0, 17],
        }
    );
    assert_eq!(
        ins.plist.entries[1],
        format::PListEntry {
            note: 0,
            waveform: 0,
            fixed: false,
            fx: [3, 0],
            fx_param: [32, 0],
        }
    );
}

/// Every `.hvl` fixture in the corpus should parse with a sane header and a
/// song name that decodes to readable text -- a strong signal the name-table
/// offset arithmetic (and therefore everything before it: header, position
/// list, tracks, instrument core) landed on the right bytes, since a wrong
/// offset produces binary garbage, not a filename-matching phrase.
#[test]
fn hvl_corpus_decodes_with_matching_names() {
    let expected = [
        ("chiprolled.hvl", "never gonna give you up", 6usize),
        ("doobrey_gubbins.hvl", "doobrey gubbins", 11),
        ("drainage_proble.hvl", "drainage problem", 7),
        ("illuminated.hvl", "illuminated", 6),
        ("moderate_sellotaping.hvl", "moderate sellotaping", 8),
        ("sliding_away.hvl", "sliding away", 6),
        ("sunspots.hvl", "sunspots", 6),
    ];

    for (file, name, channels) in expected {
        let bytes = load(file);
        let song = format::parse(&bytes).unwrap_or_else(|e| panic!("{file}: {e}"));
        assert_eq!(song.name, name, "{file} song name");
        assert_eq!(song.channels, channels, "{file} channel count");
        assert_eq!(song.format, SongFormat::Hvl);
        assert_eq!(song.positions.len(), song.position_nr);
        assert_eq!(song.tracks.len(), song.track_nr as usize + 1);
        assert_eq!(song.instruments.len(), song.instrument_nr as usize + 1);
        for track in &song.tracks {
            assert_eq!(track.len(), song.track_length as usize);
        }
    }
}

#[test]
fn rejects_bad_magic() {
    assert_eq!(
        format::parse(b"not an ahx file at all, sixteen bytes plus"),
        Err(format::AhxParseError::BadMagic)
    );
}

#[test]
fn rejects_too_short() {
    assert_eq!(format::parse(b"THX"), Err(format::AhxParseError::TooShort));
    assert_eq!(format::parse(b""), Err(format::AhxParseError::TooShort));
}

#[test]
fn rejects_truncated_header() {
    let bytes = load("karma.ahx");
    // Cut off partway through the position list: past the fixed header, so
    // TooShort doesn't fire, but short enough that a position/track/
    // instrument read runs off the end.
    let truncated = &bytes[..100];
    let err = format::parse(truncated).expect_err("truncated file should not parse");
    assert!(matches!(err, format::AhxParseError::Truncated { .. }));
}
