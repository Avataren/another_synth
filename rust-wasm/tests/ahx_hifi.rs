//! Band-limited ("hi-fi") oscillators (`ahx::hifi`, `AhxEngine::set_hifi`).
//!
//! Three claims, each with its own tests:
//!
//! 1. **Off is the reference.** Never touching the switch, or flipping it on
//!    and back off, renders the same bytes; the corpus-wide proof is the render
//!    goldens, which also run a hi-fi-toggled-off engine.
//! 2. **On removes fold-back.** A synthetic probe -- the highest note on the
//!    shortest tables, where the reference is at its worst -- has a known
//!    fundamental, so everything that is not one of its harmonics is aliasing
//!    (or hi-fi's own error). Robocop iii (the song that prompted this) is
//!    measured on its real high-pitched passages, one solo'd voice at a time.
//! 3. **On keeps the music.** Same timing, same loudness, and the same note.

use audio_processor::ahx::engine::AhxEngine;
use audio_processor::ahx::format::{self, Envelope, Instrument, PList, PListEntry, Position, Song, Step};
use audio_processor::ahx::voice::{WAVEFORM_NOISE, WAVEFORM_SAWTOOTH, WAVEFORM_SQUARE};
use rustfft::{num_complex::Complex, FftPlanner};
use std::fs;
use std::path::Path;

const RATE: u32 = 44100;
const BLOCKS: [usize; 4] = [128, 1, 333, 882];

fn fixture(name: &str) -> Vec<u8> {
    fs::read(Path::new(env!("CARGO_MANIFEST_DIR")).join("../public/demos/ahx").join(name)).unwrap()
}

fn engine_of(song: Song) -> AhxEngine {
    AhxEngine::new(song, RATE, 2).unwrap()
}

fn engine(name: &str) -> AhxEngine {
    engine_of(format::parse(&fixture(name)).unwrap())
}

fn render(e: &mut AhxEngine, frames: usize, blocks: &[usize]) -> Vec<i16> {
    let mut out = Vec::with_capacity(frames * 2);
    let mut done = 0;
    let mut k = 0;
    while done < frames {
        let n = blocks[k % blocks.len()].min(frames - done);
        let at = out.len();
        out.resize(at + n * 2, 0);
        e.render_block(&mut out[at..]);
        done += n;
        k += 1;
    }
    out
}

// ---------------------------------------------------------------------------
// 1. Off is the reference.
// ---------------------------------------------------------------------------

#[test]
fn hifi_off_is_bit_identical_to_never_touching_it() {
    for name in ["karma.ahx", "sunspots.hvl", "robocop_iii_j_tel.ahx"] {
        let frames = RATE as usize * 6;
        let plain = render(&mut engine(name), frames, &BLOCKS);
        assert!(plain.iter().any(|&s| s != 0), "{name}: silent");

        let mut off = engine(name);
        off.set_hifi(false);
        assert!(!off.hifi_enabled());
        assert_eq!(render(&mut off, frames, &BLOCKS), plain, "{name}: explicit off");

        let mut cycled = engine(name);
        cycled.set_hifi(true);
        cycled.set_hifi(false);
        assert_eq!(render(&mut cycled, frames, &BLOCKS), plain, "{name}: on then off before the first sample");
    }
}

#[test]
fn hifi_switched_off_mid_song_rejoins_the_reference_exactly() {
    // Song state, timing and every voice's position are independent of the
    // switch, so once it is off again the output is the reference's, sample
    // for sample -- there is nothing for hi-fi to leave behind.
    let name = "robocop_iii_j_tel.ahx";
    let head = RATE as usize * 3;
    let tail = RATE as usize * 3;
    let plain = render(&mut engine(name), head * 2 + tail, &BLOCKS);

    let mut e = engine(name);
    let a = render(&mut e, head, &BLOCKS);
    e.set_hifi(true);
    let mid = render(&mut e, head, &BLOCKS);
    e.set_hifi(false);
    let b = render(&mut e, tail, &BLOCKS);

    assert_eq!(a[..], plain[..head * 2]);
    assert_ne!(mid[..], plain[head * 2..head * 4], "hi-fi on changed nothing at all");
    assert_eq!(b[..], plain[head * 4..]);
}

#[test]
fn hifi_setting_survives_a_rewind() {
    let mut e = engine("karma.ahx");
    e.set_hifi(true);
    assert!(e.init_subsong(0));
    assert!(e.hifi_enabled());
}

// ---------------------------------------------------------------------------
// 2. On removes fold-back.
// ---------------------------------------------------------------------------

/// A one-note song: instrument 1 sustaining at full volume on `waveform`
/// (`waveform` as `PListEntry` encodes it, 1 = triangle .. 4 = noise) with
/// tables of `4 << wave_length` bytes, `note` held for the whole run on
/// voice 0. Everything the instrument could modulate (vibrato, filter, PWM
/// sweep, envelope) is switched off, so the pitch is exactly constant.
/// `square_pos` is the raw `9xx` parameter (PWM duty; ignored off-square).
fn probe_song(waveform: u8, wave_length: u8, note: u8, square_pos: u8) -> Song {
    let mut song = format::parse(&fixture("karma.ahx")).unwrap();
    song.speed_multiplier = 1;
    song.position_nr = 1;
    song.restart = 0;
    song.positions = vec![Position { track: vec![1, 0, 0, 0], transpose: vec![0; 4] }];
    let mut steps = vec![Step::default(); song.track_length as usize];
    // Effect 9 sets the square position (PWM duty) directly; without it a
    // square starts at its narrowest, which is a constant at short lengths.
    steps[0] = Step { note, instrument: 1, fx: 0x9, fx_param: square_pos, ..Step::default() };
    song.tracks[1] = steps;
    song.tracks[0] = vec![Step::default(); song.track_length as usize];
    song.instruments[1] = Instrument {
        name: "probe".into(),
        volume: 64,
        wave_length,
        envelope: Envelope { a_frames: 1, a_volume: 64, d_frames: 1, d_volume: 64, s_frames: 255, r_frames: 1, r_volume: 0 },
        plist: PList { speed: 1, entries: vec![PListEntry { waveform, ..PListEntry::default() }] },
        ..Instrument::default()
    };
    song
}

/// Left channel of a stretch of `frames` frames, after `skip` frames.
fn left(out: &[i16], skip: usize, frames: usize) -> Vec<f64> {
    (skip..skip + frames).map(|i| out[2 * i] as f64).collect()
}

/// Power spectrum of a Hann-windowed block, `len` a power of two.
fn power_spectrum(x: &[f64]) -> Vec<f64> {
    let n = x.len().next_power_of_two();
    let mut buf: Vec<Complex<f64>> = (0..n)
        .map(|i| {
            if i < x.len() {
                let w = 0.5 - 0.5 * (2.0 * std::f64::consts::PI * i as f64 / x.len() as f64).cos();
                Complex::new(x[i] * w, 0.0)
            } else {
                Complex::new(0.0, 0.0)
            }
        })
        .collect();
    FftPlanner::new().plan_fft_forward(n).process(&mut buf);
    buf[..n / 2].iter().map(|c| c.norm_sqr()).collect()
}

/// Energy that is not within `guard` Hz of a true harmonic of `f0`, as a
/// fraction of the total (DC excluded).
fn inharmonic_fraction(x: &[f64], f0: f64, guard: f64) -> f64 {
    let p = power_spectrum(x);
    let n = x.len().next_power_of_two();
    let bin_hz = RATE as f64 / n as f64;
    let (mut bad, mut total) = (0.0, 0.0);
    for (k, &e) in p.iter().enumerate().skip(2) {
        let hz = k as f64 * bin_hz;
        let nearest = (hz / f0).round().max(1.0) * f0;
        total += e;
        if (hz - nearest).abs() > guard {
            bad += e;
        }
    }
    bad / total
}

/// Fundamental of voice `v` right now, Hz (bytes of the 0x280 buffer per
/// output sample, over the `4 << wave_length` bytes in a cycle).
fn voice_f0(e: &AhxEngine, v: usize) -> f64 {
    let voice = e.voice(v);
    let n = 4usize << voice.wave_length;
    voice.delta as f64 / 65536.0 / n as f64 * RATE as f64
}

#[test]
fn a_high_probe_note_folds_back_in_the_reference_and_not_in_hifi() {
    // Note 60 is the top of the period table; on 8- and 16-byte tables that
    // is a fundamental of ~3.6 kHz and ~1.8 kHz with partials running far
    // past Nyquist.
    for (waveform, wave_length, label) in [
        (WAVEFORM_SQUARE as u8 + 1, 1u8, "square wl1"),
        (WAVEFORM_SAWTOOTH as u8 + 1, 1, "sawtooth wl1"),
        (WAVEFORM_SQUARE as u8 + 1, 2, "square wl2"),
        (WAVEFORM_SAWTOOTH as u8 + 1, 0, "sawtooth wl0"),
    ] {
        let song = probe_song(waveform, wave_length, 60, 0x10);
        let mut reference = engine_of(song.clone());
        let mut hifi = engine_of(song);
        hifi.set_hifi(true);
        let frames = RATE as usize;
        let r = render(&mut reference, frames, &BLOCKS);
        let h = render(&mut hifi, frames, &BLOCKS);

        let f0 = voice_f0(&reference, 0);
        assert!(f0 > 1000.0 && f0 < 8000.0, "{label}: f0 {f0}");
        let (rx, hx) = (left(&r, 8820, 16384), left(&h, 8820, 16384));
        let guard = 3.0 * RATE as f64 / 16384.0; // a few bins around each harmonic (Hann main lobe)
        let (rf, hf) = (inharmonic_fraction(&rx, f0, guard), inharmonic_fraction(&hx, f0, guard));
        eprintln!("{label}: f0 {f0:.1} Hz, inharmonic energy: reference {:.2} dB, hifi {:.2} dB", 10.0 * rf.log10(), 10.0 * hf.log10());
        assert!(rf > 1e-4, "{label}: the probe does not alias in the reference ({rf:e}); it proves nothing");
        assert!(hf < rf * 0.01, "{label}: hifi inharmonic {hf:e} not >20 dB under the reference's {rf:e}");
    }
}

#[test]
fn hifi_keeps_the_probe_at_the_same_pitch_and_level() {
    let song = probe_song(WAVEFORM_SQUARE as u8 + 1, 3, 30, 0x10);
    let mut reference = engine_of(song.clone());
    let mut hifi = engine_of(song);
    hifi.set_hifi(true);
    let frames = RATE as usize;
    let r = left(&render(&mut reference, frames, &BLOCKS), 8820, 16384);
    let h = left(&render(&mut hifi, frames, &BLOCKS), 8820, 16384);
    let f0 = voice_f0(&reference, 0);

    let (pr, ph) = (power_spectrum(&r), power_spectrum(&h));
    let bin_hz = RATE as f64 / 16384.0;
    let peak = |p: &[f64]| p.iter().enumerate().skip(2).max_by(|a, b| a.1.total_cmp(b.1)).map(|(k, _)| k as f64 * bin_hz).unwrap();
    // Strongest partial is the same one, within a bin.
    assert!((peak(&pr) - peak(&ph)).abs() <= 2.0 * bin_hz, "peak {} vs {}", peak(&pr), peak(&ph));
    // Level: RMS within 1.5 dB.
    let rms = |x: &[f64]| (x.iter().map(|v| v * v).sum::<f64>() / x.len() as f64).sqrt();
    let db = 20.0 * (rms(&h) / rms(&r)).log10();
    eprintln!("f0 {f0:.1} Hz: rms hifi vs reference {db:+.2} dB");
    assert!(db.abs() < 1.5, "level moved by {db} dB");
}

#[test]
fn a_low_note_is_left_essentially_alone() {
    // Nothing folds at low pitch, so the two renders should agree to within
    // the reference's own 8-bit rounding: a hi-fi that changes bass would be
    // changing the music, not the aliasing.
    let song = probe_song(WAVEFORM_SAWTOOTH as u8 + 1, 5, 20, 0);
    let mut reference = engine_of(song.clone());
    let mut hifi = engine_of(song);
    hifi.set_hifi(true);
    let r = left(&render(&mut reference, RATE as usize, &BLOCKS), 4410, 16384);
    let h = left(&render(&mut hifi, RATE as usize, &BLOCKS), 4410, 16384);
    let rms = |x: &[f64]| (x.iter().map(|v| v * v).sum::<f64>() / x.len() as f64).sqrt();
    let diff: Vec<f64> = r.iter().zip(&h).map(|(a, b)| a - b).collect();
    let rel = rms(&diff) / rms(&r);
    eprintln!("low note: rms(hifi - reference) / rms(reference) = {rel:.4}");
    assert!(rel < 0.10, "a low note moved by {rel}");
}

/// Robocop iii, measured per voice on what it actually plays.
///
/// The song is rendered tick by tick in lockstep as reference and hi-fi,
/// each with one voice soloed. Every run of ticks where that voice holds one
/// steady high pitch (no slide, not noise) is a window; a steady note has no
/// energy between DC and its fundamental, so anything in `[150 Hz, 0.7 f0]`
/// is fold-back (or envelope splatter, which both renders share). The test
/// asserts hi-fi cuts that energy across the song's high passages.
#[test]
fn robocop_iii_high_passages_fold_back_less_in_hifi() {
    const MIN_F0: f64 = 1500.0;
    const RUN_TICKS: usize = 3;
    let tick = RATE as usize / 50;
    let ticks = 50 * 40; // 40 s
    let mut low = [0.0f64; 2]; // [reference, hifi]
    let mut total = [0.0f64; 2];
    let mut windows = 0;

    for voice in 0..4 {
        let song = format::parse(&fixture("robocop_iii_j_tel.ahx")).unwrap();
        let mut e = [engine_of(song.clone()), engine_of(song)];
        e[1].set_hifi(true);
        for x in e.iter_mut() {
            x.set_mute_solo(0, 1 << voice);
        }
        let mut chunk = [vec![0i16; tick * 2], vec![0i16; tick * 2]];
        let mut history: Vec<(f64, [Vec<f64>; 2])> = Vec::new();

        for t in 0..ticks {
            for k in 0..2 {
                e[k].render_block(&mut chunk[k]);
            }
            let v = e[0].voice(voice);
            let steady = v.track_on && v.voice_volume > 8 && v.waveform != WAVEFORM_NOISE as i32;
            let f0 = if steady { voice_f0(&e[0], voice) } else { 0.0 };
            let this = (f0, [left(&chunk[0], 0, tick), left(&chunk[1], 0, tick)]);
            let breaks = f0 < MIN_F0 || history.last().is_some_and(|h| (h.0 - f0).abs() > f0 * 0.005);
            if breaks {
                flush(&mut history, &mut low, &mut total, &mut windows);
            }
            if f0 >= MIN_F0 {
                history.push(this);
            }
            let _ = t;
        }
        flush(&mut history, &mut low, &mut total, &mut windows);
    }

    let (r, h) = (low[0] / total[0], low[1] / total[1]);
    eprintln!(
        "robocop iii: {windows} steady high windows; energy in [150 Hz, 0.7 f0]: reference {:.2} dB, hifi {:.2} dB of the window energy ({:.1} dB lower)",
        10.0 * r.log10(),
        10.0 * h.log10(),
        10.0 * (r / h).log10()
    );

    fn flush(history: &mut Vec<(f64, [Vec<f64>; 2])>, low: &mut [f64; 2], total: &mut [f64; 2], windows: &mut usize) {
        if history.len() >= RUN_TICKS {
            let f0 = history.iter().map(|h| h.0).sum::<f64>() / history.len() as f64;
            for k in 0..2 {
                let x: Vec<f64> = history.iter().flat_map(|h| h.1[k].iter().copied()).collect();
                let p = power_spectrum(&x);
                let bin_hz = RATE as f64 / x.len().next_power_of_two() as f64;
                for (i, &e) in p.iter().enumerate().skip(1) {
                    let hz = i as f64 * bin_hz;
                    total[k] += e;
                    if (150.0..0.7 * f0).contains(&hz) {
                        low[k] += e;
                    }
                }
            }
            *windows += 1;
        }
        history.clear();
    }

    assert!(windows >= 8, "only {windows} steady high windows found; the measurement is too thin to mean anything");
    assert!(h < r * 0.5, "hifi low-band energy {h:e} is not at least 3 dB under the reference's {r:e}");
}
