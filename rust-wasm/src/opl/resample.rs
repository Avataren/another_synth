//! Native-rate (≈ 49 716 Hz) stereo to the output rate: a polyphase
//! windowed-sinc interpolator (plan decision D5: the chip always runs at its
//! own rate, so envelope and LFO timing never depend on the output rate).
//!
//! Kaiser window (β 8.6, ≈ 86 dB stopband), cutoff at 90 % of the lower of
//! the two Nyquist rates: flat to 80 % of the output Nyquist, and the chip's
//! content between the output Nyquist and its own is removed rather than
//! folded back. 64 taps when the rates are close, scaled up as the output
//! rate drops so the transition band keeps its width relative to the output
//! (66 at 48 kHz, 72 at 44.1 kHz, 144 at 22.05 kHz: about the same
//! multiply-adds per second at every rate). Latency is half the taps
//! (≈ 0.7 ms at 48 kHz, 1.4 ms at 22.05 kHz).

const BASE_TAPS: f64 = 64.0;
const PHASES: usize = 512;
const KAISER_BETA: f64 = 8.6;
const CUTOFF: f64 = 0.9;

/// Zeroth-order modified Bessel function of the first kind (series).
fn bessel_i0(x: f64) -> f64 {
    let (mut sum, mut term, q) = (1.0, 1.0, x * x / 4.0);
    for k in 1..64 {
        term *= q / (k * k) as f64;
        sum += term;
        if term < sum * 1e-17 {
            break;
        }
    }
    sum
}

pub struct Resampler {
    taps: usize,
    /// Input samples advanced per output sample.
    step: f64,
    /// Read position past the window's centre, 0 ≤ pos < 1 after refilling.
    pos: f64,
    /// (PHASES + 1) rows of `taps` coefficients; row p is the kernel at
    /// fractional offset p / PHASES, the extra row lets phases interpolate.
    table: Vec<f32>,
    /// Ring of the last `taps` input frames, stored twice so every window is
    /// contiguous.
    ring: Vec<[f32; 2]>,
    head: usize,
}

impl Resampler {
    pub fn new(in_rate: f64, out_rate: f64) -> Resampler {
        let ratio = (out_rate / in_rate).min(1.0);
        let fc = CUTOFF * ratio;
        let half = ((BASE_TAPS / ratio) / 2.0).ceil() as usize;
        let taps = 2 * half;
        let norm = bessel_i0(KAISER_BETA);
        let mut table = vec![0f32; (PHASES + 1) * taps];
        let mut coeffs = vec![0f64; taps];
        for p in 0..=PHASES {
            let frac = p as f64 / PHASES as f64;
            let row = &mut table[p * taps..(p + 1) * taps];
            let mut sum = 0.0;
            for (j, c) in coeffs.iter_mut().enumerate() {
                // Distance from input sample j of the window to the read point.
                let d = j as f64 - (half - 1) as f64 - frac;
                let x = d / half as f64;
                let window = if x.abs() >= 1.0 {
                    0.0
                } else {
                    bessel_i0(KAISER_BETA * (1.0 - x * x).sqrt()) / norm
                };
                let arg = std::f64::consts::PI * fc * d;
                let sinc = if arg.abs() < 1e-12 {
                    1.0
                } else {
                    arg.sin() / arg
                };
                *c = fc * sinc * window;
                sum += *c;
            }
            // Unity gain at DC for every phase, so no phase adds ripple.
            for (dst, c) in row.iter_mut().zip(&coeffs) {
                *dst = (c / sum) as f32;
            }
        }
        Resampler {
            taps,
            step: in_rate / out_rate,
            pos: 0.0,
            table,
            ring: vec![[0.0; 2]; 2 * taps],
            head: 0,
        }
    }

    fn push(&mut self, frame: [f32; 2]) {
        self.ring[self.head] = frame;
        self.ring[self.head + self.taps] = frame;
        self.head = (self.head + 1) % self.taps;
    }

    /// One output frame, pulling native frames from `source` as needed.
    #[inline]
    pub fn next(&mut self, mut source: impl FnMut() -> [f32; 2]) -> [f32; 2] {
        while self.pos >= 1.0 {
            self.push(source());
            self.pos -= 1.0;
        }
        let phase = self.pos * PHASES as f64;
        let p = (phase as usize).min(PHASES - 1);
        let t = (phase - p as f64) as f32;
        let n = self.taps;
        let (a, b) = (
            &self.table[p * n..(p + 1) * n],
            &self.table[(p + 1) * n..(p + 2) * n],
        );
        let window = &self.ring[self.head..self.head + n];
        let (mut l, mut r) = (0f32, 0f32);
        for ((&x, &ca), &cb) in window.iter().zip(a).zip(b) {
            let c = ca + (cb - ca) * t;
            l += x[0] * c;
            r += x[1] * c;
        }
        self.pos += self.step;
        [l, r]
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::opl::NATIVE_RATE;

    /// Level (relative to full scale) of `freq` in a signal, by projecting
    /// onto sine and cosine over a whole number of periods-ish span.
    fn level_at(signal: &[f32], rate: f64, freq: f64) -> f64 {
        let w = 2.0 * std::f64::consts::PI * freq / rate;
        let (mut s, mut c) = (0.0, 0.0);
        for (n, &x) in signal.iter().enumerate() {
            s += x as f64 * (w * n as f64).sin();
            c += x as f64 * (w * n as f64).cos();
        }
        2.0 * (s * s + c * c).sqrt() / signal.len() as f64
    }

    fn resample_tone(freq: f64, out_rate: f64, frames: usize) -> Vec<f32> {
        let mut rs = Resampler::new(NATIVE_RATE, out_rate);
        let mut n = 0u64;
        let w = 2.0 * std::f64::consts::PI * freq / NATIVE_RATE;
        let mut out = Vec::with_capacity(frames);
        for _ in 0..frames {
            let [l, _] = rs.next(|| {
                let x = (w * n as f64).sin() as f32;
                n += 1;
                [x, x]
            });
            out.push(l);
        }
        // Skip the filter's start-up.
        out.split_off(256)
    }

    #[test]
    fn passband_is_flat_at_every_output_rate() {
        for out_rate in [48_000.0, 44_100.0, 22_050.0] {
            let top = 0.8 * out_rate / 2.0;
            for freq in [100.0, 1000.0, 5000.0, top] {
                let out = resample_tone(freq, out_rate, 40_000);
                let db = 20.0 * level_at(&out, out_rate, freq).log10();
                assert!(
                    db.abs() < 0.1,
                    "{out_rate} Hz out, {freq} Hz tone: {db:.3} dB"
                );
            }
        }
    }

    #[test]
    fn content_above_the_output_nyquist_does_not_fold_back() {
        // 23.5 kHz native would alias to 20.6 kHz at 44.1 kHz; 13 kHz would
        // alias to 9.05 kHz at 22.05 kHz.
        for (out_rate, freq) in [(44_100.0, 23_500.0), (22_050.0, 13_000.0)] {
            let out = resample_tone(freq, out_rate, 40_000);
            let alias = out_rate - freq;
            let db = 20.0 * level_at(&out, out_rate, alias).log10();
            assert!(
                db < -70.0,
                "{freq} Hz into {out_rate} Hz: alias at {alias} Hz is {db:.1} dB"
            );
        }
    }

    #[test]
    fn output_length_tracks_the_rate_ratio() {
        let mut rs = Resampler::new(NATIVE_RATE, 48_000.0);
        let mut pulled = 0u64;
        for _ in 0..48_000 {
            rs.next(|| {
                pulled += 1;
                [0.0, 0.0]
            });
        }
        assert!(
            (pulled as f64 - NATIVE_RATE).abs() <= 2.0,
            "pulled {pulled} native frames for 1 s"
        );
    }
}
