// wavetable.rs

use rustfft::{num_complex::Complex, FftPlanner};
use wasm_bindgen::prelude::*;
use web_sys::console;

#[wasm_bindgen]
#[repr(u32)]
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum Waveform {
    Sine = 0,
    Saw = 1,
    Square = 2,
    Triangle = 3,
    Custom = 4,
}

/// A single wavetable: time–domain samples plus the “top frequency” (Hz) that table can safely cover.
pub struct Wavetable {
    pub samples: Vec<f32>,
    pub table_size: usize,
    pub top_freq_hz: f32,
}

/// A bank of wavetables, each covering a different frequency range.
pub struct WavetableBank {
    pub tables: Vec<Wavetable>,
}

/// Helper: Given frequency–domain arrays, find the highest harmonic that exceeds a small threshold.
fn compute_max_harmonic(freq_re: &[f32], freq_im: &[f32], num_samples: usize) -> usize {
    let min_val = 0.000001; // threshold (–120 dB)
    let mut max_harmonic = num_samples / 2; // Nyquist index
    while max_harmonic > 0 && (freq_re[max_harmonic].abs() + freq_im[max_harmonic].abs() < min_val)
    {
        max_harmonic -= 1;
    }
    max_harmonic
}

/// Generates a bank of mipmapped tables by taking a full–cycle base table (in time domain),
/// computing its FFT, and then successively discarding higher partials.
/// This function is now used for all waveform types.
pub fn generate_mipmapped_bank_dynamic(
    mut base_samples: Vec<f32>,
    base_size: usize,
    sample_rate: f32,
) -> Result<WavetableBank, Box<dyn std::error::Error>> {
    // If base_samples contains an extra wrap–around sample, remove it.
    if base_samples.len() == base_size + 1 {
        base_samples.truncate(base_size);
    } else if base_samples.len() != base_size {
        return Err(format!(
            "Expected base_samples length {} but got {}",
            base_size,
            base_samples.len()
        )
        .into());
    }

    // Convert the base cycle into the frequency domain.
    let mut spectrum: Vec<Complex<f32>> = base_samples
        .iter()
        .map(|&s| Complex { re: s, im: 0.0 })
        .collect();

    console::log_1(&format!("Generated base table of length {}", base_size).into());
    let mut planner = FftPlanner::new();
    let fft = planner.plan_fft_forward(base_size);
    console::log_1(&format!("Planned FFT of length {}", base_size).into());
    fft.process(&mut spectrum);
    console::log_1(&format!("FFT processed base table of length {}", base_size).into());

    // Separate the real and imaginary parts.
    let freq_re: Vec<f32> = spectrum.iter().map(|c| c.re).collect();
    let freq_im: Vec<f32> = spectrum.iter().map(|c| c.im).collect();

    // Determine the highest significant harmonic.
    let mut max_harmonic = compute_max_harmonic(&freq_re, &freq_im, base_size);
    if max_harmonic == 0 {
        return Err("No significant harmonics found in the waveform".into());
    }

    // Compute the initial top frequency (in Hz).
    // (The strict non-aliasing condition is f0 <= 1/(2*max_harmonic), but we allow a little extra.)
    let mut top_freq = (2.0 / 3.0 / (max_harmonic as f32)) * sample_rate;

    let mut tables = Vec::new();
    let mut current_max_harmonic = max_harmonic;

    // Generate mip–levels until there are no harmonics left.
    while current_max_harmonic > 0 {
        console::log_1(
            &format!(
                "Generating mip level with {} harmonics",
                current_max_harmonic
            )
            .into(),
        );
        // Create a new (zero–filled) frequency buffer.
        let mut level_spectrum = vec![Complex { re: 0.0, im: 0.0 }; base_size];

        // Copy harmonics 1..=current_max_harmonic (and the corresponding symmetric bins).
        for idx in 1..=current_max_harmonic {
            level_spectrum[idx] = spectrum[idx];
            level_spectrum[base_size - idx] = spectrum[base_size - idx];
        }

        // Inverse FFT to get the time–domain wavetable.
        let ifft = planner.plan_fft_inverse(base_size);
        let mut time_domain = level_spectrum.clone();
        ifft.process(&mut time_domain);

        // Normalize and extract real parts.
        let mut table: Vec<f32> = time_domain
            .iter()
            .map(|c| c.re / base_size as f32)
            .collect();
        // Append a wrap–around sample for continuity.
        table.push(table[0]);

        tables.push(Wavetable {
            samples: table,
            table_size: base_size,
            top_freq_hz: top_freq,
        });

        // For the next level, double the top frequency and halve the number of harmonics.
        top_freq *= 2.0;
        current_max_harmonic /= 2;
    }

    Ok(WavetableBank { tables })
}

/// Generate the *ideal* full spectrum (real & imaginary parts) for one cycle of a waveform,
/// with Fourier coefficients scaled so that after the inverse FFT (which divides by `table_size`)
/// the resulting waveform has the intended amplitude.
fn generate_full_spectrum(waveform: Waveform, table_size: usize) -> (Vec<f32>, Vec<f32>) {
    let mut freq_re = vec![0.0; table_size];
    let mut freq_im = vec![0.0; table_size];

    // For a sine wave (and similarly for other waveforms), the proper Fourier series
    // coefficients (assuming an inverse FFT scaling by 1/table_size) are:
    //   X[1] = -i * table_size/2,  X[table_size-1] = i * table_size/2.
    // This ensures that:
    //   x[n] = 1/table_size * (X[1]*exp(i*2pi*n/table_size) + X[table_size-1]*exp(-i*2pi*n/table_size))
    // equals sin(2pi*n/table_size) with peak amplitude ~1.
    let scale = table_size as f32 / 2.0;

    match waveform {
        Waveform::Sine => {
            // Only one partial: n=1 (and its symmetric counterpart).
            freq_im[1] = -scale;
            freq_im[table_size - 1] = scale;
        }
        Waveform::Saw => {
            // Sawtooth: all harmonics up to Nyquist with amplitude ~1/n.
            for n in 1..=(table_size >> 1) {
                freq_im[n] = -scale / (n as f32);
                freq_im[table_size - n] = scale / (n as f32);
            }
        }
        Waveform::Square => {
            // Square: only odd harmonics.
            for n in (1..=(table_size >> 1)).step_by(2) {
                freq_im[n] = scale / (n as f32);
                freq_im[table_size - n] = -scale / (n as f32);
            }
        }
        Waveform::Triangle => {
            // Triangle: only odd harmonics with amplitudes decaying as 1/n².
            let mut i = 0;
            for n in (1..=(table_size >> 1)).step_by(2) {
                let amplitude = if i % 2 == 0 { scale } else { -scale };
                freq_im[n] = amplitude / ((n * n) as f32);
                freq_im[table_size - n] = -freq_im[n];
                i += 1;
            }
        }
        Waveform::Custom => {
            // Implement your custom waveform coefficients here.
        }
    }

    // Zero out the DC and Nyquist bins.
    freq_re[0] = 0.0;
    freq_im[0] = 0.0;
    let half = table_size >> 1;
    freq_re[half] = 0.0;
    freq_im[half] = 0.0;

    (freq_re, freq_im)
}

/// Generate a base cycle (time–domain) from the full–spectrum ideal waveform.
/// The result is a table that spans one period, with a duplicate sample appended at the end.
fn generate_base_samples(waveform: Waveform, table_size: usize) -> Vec<f32> {
    let (freq_re, freq_im) = generate_full_spectrum(waveform, table_size);
    let mut spectrum: Vec<Complex<f32>> = freq_re
        .into_iter()
        .zip(freq_im.into_iter())
        .map(|(re, im)| Complex { re, im })
        .collect();

    let mut planner = FftPlanner::new();
    let ifft = planner.plan_fft_inverse(table_size);
    ifft.process(&mut spectrum);
    let mut samples: Vec<f32> = spectrum.iter().map(|c| c.re / table_size as f32).collect();
    samples.push(samples[0]); // wrap–around sample for seamless looping
    samples
}

impl WavetableBank {
    /// Create a bank of wavetables for the given waveform using the dynamic mip–mapping approach.
    /// - `waveform`: which waveform to build (Sine, Saw, Square, Triangle, or Custom).
    /// - `max_table_size`: size of the base (full–spectrum) table (e.g. 2048 or 4096).
    /// - `sample_rate`: the audio sample rate.
    ///
    /// (Note: since the mip–mapping process may fail if no significant harmonics are found,
    /// this method returns a `Result`.)
    pub fn new(
        waveform: Waveform,
        max_table_size: usize,
        sample_rate: f32,
    ) -> Result<Self, Box<dyn std::error::Error>> {
        // Generate a full–cycle (base) table with all available harmonics.
        let base_samples = generate_base_samples(waveform, max_table_size);
        // Now build the mip–mapped bank from the base table.
        console::log_1(&format!("Generating mipmapped bank for {:?} waveform", waveform).into());
        generate_mipmapped_bank_dynamic(base_samples, max_table_size, sample_rate)
    }

    /// Select the first table whose `top_freq_hz` is greater than or equal to the given frequency.
    /// If no such table exists, the last (lowest–quality) table is returned.
    pub fn select_table(&self, frequency: f32) -> &Wavetable {
        for t in &self.tables {
            if frequency <= t.top_freq_hz {
                return t;
            }
        }
        self.tables.last().unwrap()
    }
}
