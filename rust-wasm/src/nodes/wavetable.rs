// wavetable.rs

use rustfft::{num_complex::Complex, FftPlanner};
use wasm_bindgen::prelude::*;
use web_sys::console;

/// Example waveforms.
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

/// One wavetable: time-domain samples plus the "top frequency" in Hz it can handle.
pub struct Wavetable {
    pub samples: Vec<f32>,
    pub table_size: usize,
    pub top_freq_hz: f32,
}

/// A set of multiple wavetables covering different frequency ranges.
pub struct WavetableBank {
    pub tables: Vec<Wavetable>,
}

/// Fixed number of tables we want to build:
const N_TABLES: usize = 11;

impl WavetableBank {
    /// Build a bank of N = N_TABLES tables from largest to smallest size,
    /// doubling top frequency each time.
    ///
    /// - `waveform`: Sine, Saw, Square, Triangle, etc.
    /// - `max_table_size`: e.g. 2048 or 4096.
    /// - `min_table_size`: e.g. 64.
    /// - `lowest_top_freq_hz`: the largest fundamental freq handled by the biggest table. e.g. 20.0 Hz
    /// - `sample_rate`: your audio sample rate.
    pub fn new(
        waveform: Waveform,
        max_table_size: usize,
        min_table_size: usize,
        lowest_top_freq_hz: f32,
        sample_rate: f32,
    ) -> Self {
        let mut tables = Vec::new();

        // Start with the largest table and a low top frequency (e.g. 20 Hz).
        let mut table_size = max_table_size;
        let mut top_freq_hz = lowest_top_freq_hz;

        for i in 0..N_TABLES {
            // Ensure we don't go below min_table_size.
            if table_size < min_table_size {
                table_size = min_table_size;
            }

            // partial_limit = floor((Nyquist) / top_freq_hz)
            let partial_limit = ((sample_rate * 0.5) / top_freq_hz).floor() as usize;

            // Build the table
            let samples = generate_waveform_table(waveform, table_size, partial_limit);

            console::log_1(
                &format!(
                    "Table {:2}: size={:4}, partial_limit={:4}, top_freq_hz={:.2}",
                    i, table_size, partial_limit, top_freq_hz
                )
                .into(),
            );

            tables.push(Wavetable {
                samples,
                table_size,
                top_freq_hz,
            });

            // For the next iteration: halve table size, double the top frequency.
            // Even if we stay at `min_table_size`, we can keep going to fill all 16 tables.
            table_size >>= 1; // e.g. 2048 -> 1024 -> 512 ...
            top_freq_hz *= 2.0; // e.g. 20 Hz -> 40 Hz -> 80 Hz ...
        }

        // Aascending top_freq order for easier selection logic,
        // We'll assume table[0] covers up to 20 Hz,
        // table[1] covers up to 40 Hz, etc. Then in `select_table`, we pick
        // the first table whose top_freq_hz >= requested frequency.

        WavetableBank { tables }
    }

    /// Pick the first table whose `top_freq_hz` >= `frequency`.
    /// If none found, return the last table.
    pub fn select_table(&self, frequency: f32) -> &Wavetable {
        for (i, t) in self.tables.iter().enumerate() {
            if frequency <= t.top_freq_hz {
                return t;
            }
        }
        let last_index = self.tables.len() - 1;
        &self.tables[last_index]
    }
}

/// Generate one time-domain table by discarding partials above `max_harmonic`.
fn generate_waveform_table(waveform: Waveform, table_size: usize, max_harmonic: usize) -> Vec<f32> {
    let (freq_re, freq_im) = generate_full_spectrum(waveform, table_size);

    // Prepare arrays for "band-limited" partials
    let mut limited_re = vec![0.0; table_size];
    let mut limited_im = vec![0.0; table_size];

    let max_h = max_harmonic.min(table_size >> 1);

    // Copy partials 1..=max_h
    for i in 1..=max_h {
        limited_re[i] = freq_re[i];
        limited_im[i] = freq_im[i];

        let neg = table_size - i;
        limited_re[neg] = freq_re[neg];
        limited_im[neg] = freq_im[neg];
    }

    let mut spectrum: Vec<Complex<f32>> = limited_re
        .into_iter()
        .zip(limited_im.into_iter())
        .map(|(re, im)| Complex { re, im })
        .collect();

    let mut planner = FftPlanner::new();
    let ifft = planner.plan_fft_inverse(table_size);
    ifft.process(&mut spectrum);

    // Normalize by table_size
    let mut samples: Vec<f32> = spectrum.iter().map(|c| c.re / table_size as f32).collect();

    // Optional amplitude normalize
    if let Some(&max_val) = samples
        .iter()
        .max_by(|a, b| a.abs().partial_cmp(&b.abs()).unwrap())
    {
        let peak = max_val.abs();
        if peak > 1e-12 {
            for s in &mut samples {
                *s /= peak;
            }
        }
    }

    // Add wrap-around sample
    samples.push(samples[0]);
    samples
}

/// Generate the *ideal* full spectrum (real & imag) for one cycle of a waveform.
fn generate_full_spectrum(waveform: Waveform, table_size: usize) -> (Vec<f32>, Vec<f32>) {
    let mut freq_re = vec![0.0; table_size];
    let mut freq_im = vec![0.0; table_size];

    match waveform {
        Waveform::Sine => {
            // Single partial at n=1
            freq_im[1] = -0.5;
            freq_im[table_size - 1] = 0.5;
        }
        Waveform::Saw => {
            for n in 1..=(table_size >> 1) {
                freq_im[n] = -1.0 / (n as f32);
                freq_im[table_size - n] = -freq_im[n];
            }
        }
        Waveform::Square => {
            for n in (1..=(table_size >> 1)).step_by(2) {
                freq_im[n] = 1.0 / (n as f32);
                freq_im[table_size - n] = -freq_im[n];
            }
        }
        Waveform::Triangle => {
            let mut i = 0;
            for n in (1..=(table_size >> 1)).step_by(2) {
                let amplitude = if i % 2 == 0 { 1.0 } else { -1.0 };
                freq_im[n] = amplitude / (n * n) as f32;
                freq_im[table_size - n] = -freq_im[n];
                i += 1;
            }
        }
        Waveform::Custom => {
            // Fill your custom partials here...
        }
    }

    // Zero out DC and Nyquist
    freq_re[0] = 0.0;
    freq_im[0] = 0.0;
    let half = table_size >> 1;
    freq_re[half] = 0.0;
    freq_im[half] = 0.0;

    (freq_re, freq_im)
}
