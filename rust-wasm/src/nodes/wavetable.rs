use rustfft::{num_complex::Complex, FftPlanner};
use wasm_bindgen::prelude::*;

//--- Waveform definitions and wavetable bank

#[wasm_bindgen]
#[derive(Copy, Clone, PartialEq, Eq, Hash, Debug)]
pub enum Waveform {
    Sine,
    Saw,
    Square,
    Triangle,
    Custom, // Placeholder for custom waveforms.
}

/// One band‑limited wavetable.
/// The samples vector length is table_size + 1 so that the first sample is duplicated for proper interpolation.
pub struct Wavetable {
    pub samples: Vec<f32>,
    pub table_size: usize,
    pub top_freq: f32,
}

/// A bank of wavetables for one waveform.
pub struct WavetableBank {
    pub tables: Vec<Wavetable>,
}

impl WavetableBank {
    /// Create a bank for the given waveform.
    /// max_table_size (e.g. 2048) is the starting table length.
    /// sample_rate is the audio sample rate.
    pub fn new(waveform: Waveform, max_table_size: usize, sample_rate: f32) -> Self {
        let mut tables = Vec::new();
        let mut table_size = max_table_size;
        while table_size >= 32 {
            let samples = generate_waveform_table(waveform, table_size);
            // For square waves, use a multiplier (2.0) to shift top_freq upward.
            let multiplier = match waveform {
                Waveform::Square => 2.0,
                _ => 1.0,
            };
            let top_freq = multiplier * sample_rate / (table_size as f32);
            tables.push(Wavetable {
                samples,
                table_size,
                top_freq,
            });
            table_size /= 2;
        }
        Self { tables }
    }

    /// Select the table such that effective frequency < top_freq.
    pub fn select_table(&self, frequency: f32) -> &Wavetable {
        for table in &self.tables {
            if frequency < table.top_freq {
                return table;
            }
        }
        self.tables.last().unwrap()
    }
}

/// Generate a single wavetable via inverse FFT.
/// For Square, mimic the C# approach:
/// – Zero the real parts and assign only to the imaginary parts for odd harmonics:
///   For n odd in [1, table_size/2], set:
///     spectrum[n].im = -1.0/(n)
///     spectrum[table_size - n].im = 1.0/(n)
/// Then perform the IFFT, divide by table_size, normalize, and duplicate the first sample.
fn generate_waveform_table(waveform: Waveform, table_size: usize) -> Vec<f32> {
    let mut spectrum = vec![Complex { re: 0.0, im: 0.0 }; table_size];

    match waveform {
        Waveform::Square => {
            for n in (1..=(table_size >> 1)).step_by(2) {
                spectrum[n] = Complex {
                    re: 0.0,
                    im: -1.0 / (n as f32),
                };
                spectrum[table_size - n] = Complex {
                    re: 0.0,
                    im: 1.0 / (n as f32),
                };
            }
        }
        Waveform::Sine => {
            if table_size > 1 {
                spectrum[1] = Complex { re: 0.0, im: -0.5 };
                spectrum[table_size - 1] = Complex { re: 0.0, im: 0.5 };
            }
        }
        Waveform::Saw => {
            for n in 1..(table_size >> 1) {
                let amplitude =
                    2.0 / ((n as f32) * std::f32::consts::PI) * if n % 2 == 0 { -1.0 } else { 1.0 };
                spectrum[n] = Complex {
                    re: 0.0,
                    im: -amplitude / 2.0,
                };
                spectrum[table_size - n] = Complex {
                    re: 0.0,
                    im: amplitude / 2.0,
                };
            }
        }
        Waveform::Triangle => {
            let mut i = 0;
            for n in (1..(table_size >> 1)).filter(|&n| n % 2 == 1) {
                let amplitude = 8.0
                    / (std::f32::consts::PI * std::f32::consts::PI * (n as f32).powi(2))
                    * if i % 2 == 0 { 1.0 } else { -1.0 };
                spectrum[n] = Complex {
                    re: 0.0,
                    im: -amplitude / 2.0,
                };
                spectrum[table_size - n] = Complex {
                    re: 0.0,
                    im: amplitude / 2.0,
                };
                i += 1;
            }
        }
        Waveform::Custom => {
            // Custom waveform generation would go here.
        }
    }

    let mut planner = FftPlanner::<f32>::new();
    let ifft = planner.plan_fft_inverse(table_size);
    let mut buffer = spectrum.clone();
    ifft.process(&mut buffer);

    let mut samples: Vec<f32> = buffer
        .into_iter()
        .map(|c| c.re / (table_size as f32))
        .collect();

    // Normalize to ensure the max absolute amplitude is 1.
    if let Some(max_amp) = samples
        .iter()
        .map(|&x| x.abs())
        .max_by(|a, b| a.partial_cmp(b).unwrap())
    {
        if max_amp > 0.0 {
            for s in samples.iter_mut() {
                *s /= max_amp;
            }
        }
    }

    // Append the first sample at the end for proper wrap-around in interpolation.
    samples.push(samples[0]);
    samples
}
