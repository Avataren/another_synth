//! Live (keyboard preview) mode of `AhxPlayer`: one mono voice played by
//! note-on / note-off with the song's own instruments. The song player's
//! output is pinned by the goldens (`ahx_render_golden.rs`); this only covers
//! what live mode adds.

use audio_processor::ahx::player::AhxPlayer;
use std::fs;
use std::path::Path;

const RATE: usize = 44100;

fn fixture(name: &str) -> Vec<u8> {
    fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/demos/ahx").join(name)).unwrap()
}

fn preview_player(name: &str) -> AhxPlayer {
    let mut p = AhxPlayer::new(&fixture(name), RATE as u32, 2).unwrap();
    p.enable_preview();
    p
}

/// Renders `seconds` and returns `(peak, left, right)`.
fn render(p: &mut AhxPlayer, seconds: f32) -> (f32, Vec<f32>, Vec<f32>) {
    let frames = (seconds * RATE as f32) as usize;
    let (mut l, mut r) = (vec![0f32; frames], vec![0f32; frames]);
    for start in (0..frames).step_by(128) {
        let end = (start + 128).min(frames);
        p.render(&mut l[start..end], &mut r[start..end]);
    }
    let peak = l.iter().chain(r.iter()).fold(0f32, |m, s| m.max(s.abs()));
    (peak, l, r)
}

fn crossings(x: &[f32]) -> usize {
    x.windows(2).filter(|w| (w[0] < 0.0) != (w[1] < 0.0)).count()
}

#[test]
fn a_preview_player_is_silent_until_a_note_is_played() {
    let mut p = preview_player("karma.ahx");
    assert!(p.preview_enabled());
    assert_eq!(render(&mut p, 0.3).0, 0.0);
}

#[test]
fn note_on_is_refused_outside_preview_mode_and_for_missing_instruments() {
    let mut song = AhxPlayer::new(&fixture("karma.ahx"), RATE as u32, 2).unwrap();
    assert!(!song.preview_note_on(1, 30, 127));
    let mut p = preview_player("karma.ahx");
    assert!(!p.preview_note_on(0, 30, 127));
    assert!(!p.preview_note_on(200, 30, 127));
    assert!(p.preview_note_on(1, 30, 127));
}

#[test]
fn a_held_note_sustains_and_note_off_releases_to_silence() {
    let mut p = preview_player("karma.ahx");
    let mut heard = 0;
    for instrument in 1..=8usize {
        assert!(p.preview_note_on(instrument, 30, 127));
        let (attack, ..) = render(&mut p, 0.3);
        if attack == 0.0 {
            p.preview_note_off();
            render(&mut p, 6.0);
            continue;
        }
        heard += 1;
        // Held for a good while longer than any sustain the file sets: still sounding.
        render(&mut p, 2.0);
        let (held, ..) = render(&mut p, 0.2);
        assert!(held > 0.0, "instrument {instrument} died while its key was down");
        p.preview_note_off();
        // Release frames top out at 255 ticks (5.1 s at 50 Hz).
        render(&mut p, 6.0);
        let (after, ..) = render(&mut p, 0.2);
        assert_eq!(after, 0.0, "instrument {instrument} still sounds after its release");
    }
    assert!(heard > 0, "no instrument made a sound");
}

#[test]
fn pitch_follows_the_note_an_octave_up_doubles_the_frequency() {
    let mut p = preview_player("karma.ahx");
    let mut checked = false;
    for instrument in 1..=8usize {
        p.preview_note_on(instrument, 25, 127);
        render(&mut p, 0.4);
        let (peak, low, _) = render(&mut p, 0.5);
        if peak == 0.0 {
            p.preview_note_off();
            render(&mut p, 6.0);
            continue;
        }
        p.preview_note_off();
        render(&mut p, 6.0);
        p.preview_note_on(instrument, 37, 127);
        render(&mut p, 0.4);
        let (_, high, _) = render(&mut p, 0.5);
        p.preview_note_off();
        render(&mut p, 6.0);
        let (lo, hi) = (crossings(&low), crossings(&high));
        // Zero crossings are a rough pitch read (filters, PList notes and
        // vibrato smear it), so only require clearly higher, not exactly 2x.
        if lo > 20 && hi > lo * 3 / 2 {
            checked = true;
            break;
        }
    }
    assert!(checked, "no instrument rose in pitch with the note");
}

#[test]
fn velocity_scales_the_level() {
    let mut p = preview_player("karma.ahx");
    for instrument in 1..=8usize {
        p.preview_note_on(instrument, 30, 127);
        let (loud, ..) = render(&mut p, 0.5);
        p.preview_note_off();
        render(&mut p, 6.0);
        if loud == 0.0 {
            continue;
        }
        p.preview_note_on(instrument, 30, 32);
        let (soft, ..) = render(&mut p, 0.5);
        assert!(soft < loud * 0.6, "velocity 32 ({soft}) not clearly quieter than 127 ({loud})");
        return;
    }
    panic!("no instrument made a sound");
}

#[test]
fn the_preview_voice_is_centred() {
    let mut p = preview_player("karma.ahx");
    for instrument in 1..=8usize {
        p.preview_note_on(instrument, 30, 127);
        let (peak, l, r) = render(&mut p, 0.5);
        if peak == 0.0 {
            p.preview_note_off();
            render(&mut p, 6.0);
            continue;
        }
        assert_eq!(l, r, "a centred mono voice is the same in both channels");
        return;
    }
    panic!("no instrument made a sound");
}

#[test]
fn hifi_in_preview_mode_builds_lazily_and_still_sounds() {
    let mut p = preview_player("karma.ahx");
    p.set_hifi(true);
    // No song walk: nothing is built until a note asks for it.
    assert_eq!(p.hifi_table_count(), 0);
    assert!(!p.hifi_locked());
    for instrument in 1..=8usize {
        p.preview_note_on(instrument, 30, 127);
        let (peak, ..) = render(&mut p, 0.5);
        if peak > 0.0 {
            assert!(p.hifi_table_count() > 0);
            return;
        }
    }
    panic!("no instrument made a sound");
}
