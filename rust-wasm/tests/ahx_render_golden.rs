//! Bit-exact render goldens for `ahx::engine::AhxEngine`.
//!
//! The expected values in `tests/golden/*.txt` are not hand-derived: they are
//! produced by compiling the vendored C reference
//! (`.ai/ahx/references/hvl_replay.c`) natively and running it over the real
//! fixtures in `public/demos/ahx/` (`tests/golden/gen_goldens.sh`, harness in
//! `tests/golden/hvl_golden.c`). Each golden line is the FNV-1a-64 of the
//! interleaved little-endian `i16` stereo stream `hvl_DecodeFrame` produced
//! for a 50-frame chunk (one second at 50 Hz), so a single wrong sample
//! anywhere in the 20-60 s of audio fails the chunk it lives in.
//!
//! Coverage (from the harness's `coverage` line, voice-frames): karma.ahx
//! exercises hard-cut release, square sweep, noise, filter sweep and vibrato;
//! illuminated.hvl exercises PList ring modulation (commands 7/8) -- only at
//! its native 6 channels, hence `with_channel_cap`; sliding_away.hvl exercises
//! tone portamento; the 4-channel-truncated HVL cases exercise HVL's second
//! effect column under the fixed-4 default.

use audio_processor::ahx::engine::{AhxEngine, EngineError, ENGINE_CHANNELS};
use audio_processor::ahx::format;
use audio_processor::ahx::voice::{panning_left, panning_right};
use audio_processor::ahx::waveform::WAVES;
use std::fs;
use std::path::{Path, PathBuf};

fn root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).to_path_buf()
}

fn fnv(mut h: u64, bytes: &[u8]) -> u64 {
    for &b in bytes {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    h
}

const FNV_BASIS: u64 = 0xcbf29ce484222325;

struct Golden {
    waves: u64,
    panning: u64,
    channels: usize,
    /// `songend` line: (song_end_reached, pos_nr, note_nr) after the last frame.
    end: (bool, i32, i32),
    chunks: Vec<(usize, u64)>,
}

fn load_golden(name: &str) -> Golden {
    let text = fs::read_to_string(root().join("tests/golden").join(name))
        .unwrap_or_else(|e| panic!("reading golden {name}: {e}"));
    let mut g = Golden { waves: 0, panning: 0, channels: 0, end: (false, 0, 0), chunks: Vec::new() };
    for line in text.lines() {
        let f: Vec<&str> = line.split_whitespace().collect();
        match f.as_slice() {
            ["waves", h] => g.waves = u64::from_str_radix(h, 16).unwrap(),
            ["panning", h] => g.panning = u64::from_str_radix(h, 16).unwrap(),
            ["channels", n, ..] => g.channels = n.parse().unwrap(),
            [frame, h] if frame.chars().all(|c| c.is_ascii_digit()) => {
                g.chunks.push((frame.parse().unwrap(), u64::from_str_radix(h, 16).unwrap()));
            }
            ["songend", e, "posnr", p, "notenr", n] => {
                g.end = (*e != "0", p.parse().unwrap(), n.parse().unwrap());
            }
            _ => {}
        }
    }
    assert!(!g.chunks.is_empty(), "golden {name} has no chunk lines");
    g
}

fn song(fixture: &str) -> format::Song {
    let bytes = fs::read(root().join("../public/demos/ahx").join(fixture))
        .unwrap_or_else(|e| panic!("reading fixture {fixture}: {e}"));
    format::parse(&bytes).unwrap_or_else(|e| panic!("parsing {fixture}: {e}"))
}

/// Renders the case and compares every chunk hash against the golden.
/// `cap == 0` means "engine default" (the fixed-4 constant).
fn check(fixture: &str, freq: u32, defstereo: u8, cap: usize, golden: &str, expect_channels: usize) {
    let g = load_golden(golden);
    let s = song(fixture);
    let mult = s.speed_multiplier as usize;
    let mut engine = if cap == 0 {
        AhxEngine::new(s, freq, defstereo)
    } else {
        AhxEngine::with_channel_cap(s, freq, defstereo, cap)
    }
    .expect("engine builds");
    assert_eq!(engine.channels(), expect_channels, "{golden}: channel count");
    assert_eq!(g.channels, expect_channels, "{golden}: reference channel count");

    // One hvl_DecodeFrame = `mult` ticks of `freq/50/mult` samples each.
    let frame_samples = engine.samples_per_tick() * mult;
    let mut prev = 0usize;
    let mut buf = Vec::new();
    for &(upto, want) in &g.chunks {
        let frames = (upto - prev) * frame_samples;
        buf.clear();
        buf.resize(frames * 2, 0i16);
        engine.render_block(&mut buf);
        let bytes: Vec<u8> = buf.iter().flat_map(|s| s.to_le_bytes()).collect();
        let got = fnv(FNV_BASIS, &bytes);
        assert_eq!(
            got, want,
            "{golden}: render diverges from the C reference in DecodeFrames {prev}..{upto} \
             (got {got:016x}, want {want:016x})"
        );
        prev = upto;
    }
    // Transport state after the last frame: covers the song-end / restart
    // path (and its `>=` divergence from the reference's `==`) whenever the
    // golden is long enough to loop.
    assert_eq!(
        (engine.song_end_reached(), engine.pos_nr(), engine.note_nr()),
        g.end,
        "{golden}: (song_end_reached, pos_nr, note_nr) after the last frame"
    );
}

#[test]
fn waves_table_matches_reference_bit_for_bit() {
    let g = load_golden("karma.44100.s2.cap0.txt");
    let bytes: Vec<u8> = WAVES.iter().map(|&b| b as u8).collect();
    assert_eq!(fnv(FNV_BASIS, &bytes), g.waves);
}

#[test]
fn panning_tables_match_reference_bit_for_bit() {
    let g = load_golden("karma.44100.s2.cap0.txt");
    let mut h = FNV_BASIS;
    for i in 0..256 {
        h = fnv(h, &(panning_left(i) as u32).to_le_bytes());
    }
    for i in 0..256 {
        h = fnv(h, &(panning_right(i) as u32).to_le_bytes());
    }
    assert_eq!(h, g.panning);
}

#[test]
fn karma_ahx_44100_matches_reference() {
    check("karma.ahx", 44100, 2, 0, "karma.44100.s2.cap0.txt", 4);
}

#[test]
fn karma_ahx_48000_other_stereo_matches_reference() {
    check("karma.ahx", 48000, 0, 0, "karma.48000.s0.cap0.txt", 4);
}

#[test]
fn hvl_truncated_to_fixed_four_matches_reference() {
    check("chiprolled.hvl", 44100, 2, 0, "chiprolled.44100.s2.cap4.txt", ENGINE_CHANNELS);
    check("moderate_sellotaping.hvl", 44100, 2, 0, "moderate_sellotaping.44100.s2.cap4.txt", ENGINE_CHANNELS);
    check("sunspots.hvl", 44100, 2, 0, "sunspots.44100.s2.cap4.txt", ENGINE_CHANNELS);
    check("drainage_proble.hvl", 44100, 2, 0, "drainage_proble.44100.s2.cap4.txt", ENGINE_CHANNELS);
}

#[test]
fn illuminated_wraps_past_last_position_and_matches_reference() {
    // The natural restart branch of `play_irq` (`pos_nr == position_nr` ->
    // `song_end_reached`, `pos_nr = restart`, `hvl_replay.c:1683-1688`).
    // The golden runs 64 s; the reference first wraps at 57.6 s.
    let g = load_golden("illuminated.44100.s2.cap4.txt");
    assert!(g.end.0, "golden must reach song end to cover the restart path");
    check("illuminated.hvl", 44100, 2, 0, "illuminated.44100.s2.cap4.txt", ENGINE_CHANNELS);
}

#[test]
fn sunspots_loops_via_position_jump_and_matches_reference() {
    // sunspots is the shortest song (12 positions); its golden runs 60 s and
    // reaches song end through a Bxx loop-back (`hvl_replay.c:680-683`), then
    // keeps playing from the jump target. It never walks off the last
    // position, so it does not cover the natural-wrap branch above.
    let g = load_golden("sunspots.44100.s2.cap4.txt");
    assert!(g.end.0, "golden must reach song end to cover the restart path");
    check("sunspots.hvl", 44100, 2, 0, "sunspots.44100.s2.cap4.txt", ENGINE_CHANNELS);
}

#[test]
fn drainage_proble_seven_channels_truncates_to_first_four() {
    let s = song("drainage_proble.hvl");
    assert_eq!(s.channels, 7);
    let e = AhxEngine::new(s, 44100, 2).unwrap();
    assert_eq!(e.channels(), ENGINE_CHANNELS);
    assert_eq!(e.dropped_channels(), 3);
}

#[test]
fn zero_channel_cap_is_rejected() {
    let r = AhxEngine::with_channel_cap(song("karma.ahx"), 44100, 2, 0);
    assert_eq!(r.err(), Some(EngineError::InvalidChannelCap));
}

#[test]
fn hvl_ring_modulation_full_channels_matches_reference() {
    check("illuminated.hvl", 44100, 2, 6, "illuminated.44100.s2.cap0.txt", 6);
}

#[test]
fn hvl_tone_portamento_full_channels_matches_reference() {
    check("sliding_away.hvl", 44100, 2, 6, "sliding_away.44100.s2.cap0.txt", 6);
}

#[test]
fn hvl_eleven_channels_matches_reference() {
    check("doobrey_gubbins.hvl", 44100, 2, 11, "doobrey_gubbins.44100.s2.cap0.txt", 11);
}

#[test]
fn default_engine_is_fixed_four_and_reports_dropped_channels() {
    let e = AhxEngine::new(song("illuminated.hvl"), 44100, 2).unwrap();
    assert_eq!(e.channels(), ENGINE_CHANNELS);
    assert_eq!(e.dropped_channels(), 2);
    let e = AhxEngine::new(song("karma.ahx"), 44100, 2).unwrap();
    assert_eq!(e.dropped_channels(), 0);
}

#[test]
fn render_is_independent_of_block_size() {
    // Odd block sizes split ticks mid-way; the result must not care.
    let total = 44100 / 50 * 200;
    let mut whole = AhxEngine::new(song("karma.ahx"), 44100, 2).unwrap();
    let mut a = vec![0i16; total * 2];
    whole.render_block(&mut a);

    let mut split = AhxEngine::new(song("karma.ahx"), 44100, 2).unwrap();
    let mut b = vec![0i16; total * 2];
    let mut at = 0usize;
    for size in [1usize, 7, 333, 882, 1000, 4099].iter().cycle() {
        if at >= total {
            break;
        }
        let n = (*size).min(total - at);
        split.render_block(&mut b[at * 2..(at + n) * 2]);
        at += n;
    }
    assert_eq!(a, b);
}

#[test]
fn karma_first_row_is_audible_and_not_clipped_flat() {
    // Sanity that the goldens are not all-zero streams: two seconds of karma
    // must contain non-silent samples in both channels.
    let mut e = AhxEngine::new(song("karma.ahx"), 44100, 2).unwrap();
    let mut out = vec![0i16; 44100 * 2 * 2];
    e.render_block(&mut out);
    assert!(out.iter().step_by(2).any(|&s| s != 0), "left silent");
    assert!(out.iter().skip(1).step_by(2).any(|&s| s != 0), "right silent");
}
