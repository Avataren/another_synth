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
fn hifi_in_preview_mode_is_locked_at_once_and_note_on_prewarms_the_pressed_instrument() {
    let mut p = preview_player("karma.ahx");
    p.set_hifi(true);
    // No song walk, and no building on the render path: locked and empty.
    assert!(p.hifi_locked());
    assert_eq!(p.hifi_table_count(), 0);
    let mut heard = 0;
    for instrument in 1..=31usize {
        for note in [30, 44] {
            assert!(p.preview_note_on(instrument, note, 127));
            let built = p.hifi_table_count();
            let (attack, ..) = render(&mut p, 0.4);
            // A held note (long enough for envelope, sweeps and vibrato), then its release.
            render(&mut p, 3.0);
            p.preview_note_off();
            render(&mut p, 6.0);
            if attack > 0.0 {
                heard += 1;
            }
            assert_eq!(p.hifi_table_count(), built, "instrument {instrument} note {note}: render built a table");
            assert_eq!(p.hifi_miss_count(), 0.0, "instrument {instrument} note {note}: render missed a table");
        }
    }
    assert!(heard > 0, "no instrument made a sound");
    assert!(p.hifi_table_count() > 0, "note-on prewarmed nothing");
    assert!(p.hifi_locked());
}

#[test]
fn hifi_is_locked_whichever_way_round_preview_and_hifi_are_switched_on() {
    let mut p = AhxPlayer::new(&fixture("karma.ahx"), RATE as u32, 2).unwrap();
    p.set_hifi(true);
    p.enable_preview();
    assert!(p.hifi_locked());
    // (What the song walk built before the switch stays; it is just unused.)
    assert!(p.preview_note_on(1, 30, 127));
    render(&mut p, 1.0);
    assert_eq!(p.hifi_miss_count(), 0.0);
}

#[test]
fn a_held_note_outlasts_the_envelope_and_a_released_one_does_not() {
    use audio_processor::ahx::engine::AhxEngine;
    use audio_processor::ahx::format::parse;

    fn peak_after(engine: &mut AhxEngine, seconds: f32) -> i32 {
        let mut buf = vec![0i16; (seconds * RATE as f32) as usize * 2];
        engine.render_block(&mut buf);
        buf.iter().map(|&x| (x as i32).abs()).max().unwrap()
    }

    // Instrument 1 of karma: a+d+s+r is 108 ticks (2.2 s at 50 Hz), so its own
    // envelope is over long before 4 s; only a key held down keeps it going.
    for instrument in [1usize, 2, 4] {
        // Sustain 0 releases right after the decay in a song; on the keyboard the
        // hold makes it a drone for as long as the key is down (a deliberate
        // difference, see `AhxEngine::live_tick`), so both must stay up.
        for s_frames in [None, Some(0u8)] {
            let mut song = parse(&fixture("karma.ahx")).unwrap();
            if let Some(s) = s_frames {
                song.instruments[instrument].envelope.s_frames = s;
            }
            let mut held = AhxEngine::new(song.clone(), RATE as u32, 2).unwrap();
            held.enable_live();
            held.live_note_on(instrument, 30, 127);
            assert!(peak_after(&mut held, 0.3) > 0, "instrument {instrument} is silent");
            assert!(peak_after(&mut held, 3.7) > 0, "instrument {instrument} died while held (s_frames {s_frames:?})");

            let mut released = AhxEngine::new(song, RATE as u32, 2).unwrap();
            released.enable_live();
            released.live_note_on(instrument, 30, 127);
            assert!(peak_after(&mut released, 0.3) > 0);
            released.live_note_off();
            peak_after(&mut released, 2.6);
            assert_eq!(peak_after(&mut released, 1.1), 0, "instrument {instrument} kept sounding after note-off");
        }
    }
}
