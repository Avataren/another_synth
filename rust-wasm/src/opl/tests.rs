//! O0 gate: every golden script, sample for sample against ymfm's YMF262.

use super::chip::Chip;
use std::path::{Path, PathBuf};

fn golden_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("src/opl/golden")
}

/// Replay a script (`w <reg> <val>` hex, `s <n>` samples) through the chip,
/// returning interleaved L/R like the oracle writes.
fn render_script(script: &str) -> Vec<i16> {
    let mut chip = Chip::new();
    let mut out = Vec::new();
    for line in script.lines() {
        let mut parts = line.split_whitespace();
        match parts.next() {
            Some("w") => {
                let reg = u16::from_str_radix(parts.next().unwrap(), 16).unwrap();
                let val = u8::from_str_radix(parts.next().unwrap(), 16).unwrap();
                chip.write(reg, val);
            }
            Some("s") => {
                let n: usize = parts.next().unwrap().parse().unwrap();
                for _ in 0..n {
                    let (l, r) = chip.clock_sample();
                    out.push(l);
                    out.push(r);
                }
            }
            _ => {}
        }
    }
    out
}

fn read_i16(path: &Path) -> Vec<i16> {
    std::fs::read(path)
        .unwrap()
        .chunks_exact(2)
        .map(|b| i16::from_le_bytes([b[0], b[1]]))
        .collect()
}

fn golden_names() -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(golden_dir())
        .unwrap()
        .filter_map(|e| {
            let name = e.unwrap().file_name().into_string().unwrap();
            name.strip_suffix(".txt").map(str::to_owned)
        })
        .collect();
    names.sort();
    names
}

#[test]
fn every_golden_script_matches_ymfm_sample_for_sample() {
    let names = golden_names();
    assert!(names.len() >= 8, "golden scripts missing: {names:?}");
    let mut failures = Vec::new();
    for name in &names {
        let script = std::fs::read_to_string(golden_dir().join(format!("{name}.txt"))).unwrap();
        let expected = read_i16(&golden_dir().join(format!("{name}.i16")));
        let actual = render_script(&script);
        assert_eq!(actual.len(), expected.len(), "{name}: length");
        if let Some(i) = actual.iter().zip(&expected).position(|(a, e)| a != e) {
            let (frame, side) = (i / 2, if i % 2 == 0 { 'L' } else { 'R' });
            let diffs = actual.iter().zip(&expected).filter(|(a, e)| a != e).count();
            failures.push(format!(
                "{name}: first mismatch at frame {frame} {side}: got {} want {} ({diffs} of {} values differ)",
                actual[i],
                expected[i],
                expected.len()
            ));
        }
    }
    assert!(failures.is_empty(), "\n{}", failures.join("\n"));
}

/// Listening aid, not a gate: render the script at `$OPL_SCRIPT` to a 16-bit
/// stereo WAV at the native rate, at `$OPL_WAV`.
///
///   OPL_SCRIPT=x.txt OPL_WAV=x.wav cargo test --lib opl::tests::render_script_to_wav -- --ignored
#[test]
#[ignore]
fn render_script_to_wav() {
    let script = std::fs::read_to_string(std::env::var("OPL_SCRIPT").expect("OPL_SCRIPT")).unwrap();
    let samples = render_script(&script);
    let spec = hound::WavSpec {
        channels: 2,
        sample_rate: super::NATIVE_RATE.round() as u32,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut wav = hound::WavWriter::create(std::env::var("OPL_WAV").expect("OPL_WAV"), spec).unwrap();
    for s in samples {
        wav.write_sample(s).unwrap();
    }
    wav.finalize().unwrap();
}

/// The goldens must actually exercise something: sound, silence after the
/// release, and a real stereo split under NEW=1.
#[test]
fn the_goldens_are_not_trivial() {
    let adsr = read_i16(&golden_dir().join("02-envelope-adsr.i16"));
    assert!(adsr.iter().any(|&s| s.abs() > 4000), "ADSR golden never gets loud");
    assert!(adsr[adsr.len() - 2000..].iter().all(|&s| s == 0), "ADSR golden never releases to silence");

    let stereo = read_i16(&golden_dir().join("06-opl3-stereo-waveforms.i16"));
    let (l, r): (Vec<i16>, Vec<i16>) = stereo.chunks_exact(2).map(|p| (p[0], p[1])).unzip();
    assert_ne!(l, r, "NEW=1 golden is not stereo");
    assert!(l.iter().any(|&s| s != 0) && r.iter().any(|&s| s != 0));

    let chord = read_i16(&golden_dir().join("05-nine-voice-chord.i16"));
    assert!(chord.iter().any(|&s| s == i16::MAX || s == i16::MIN), "chord golden never clamps");
}
