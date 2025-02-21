use getrandom::getrandom;
use rand::rngs::StdRng;
use rand::Rng;
use rand::SeedableRng;

/// A biquad low‑pass filter with a Butterworth‑like Q (~0.707) for a natural spectral roll‑off.
struct BiquadLPF {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl BiquadLPF {
    fn new(cutoff: f32, sample_rate: f32) -> Self {
        let q = 0.707; // Butterworth Q
        let cutoff = cutoff.clamp(20.0, 20_000.0);
        let sample_rate = sample_rate.clamp(1.0, 192_000.0);
        let w0 = 2.0 * std::f32::consts::PI * cutoff / sample_rate;
        let cos_w0 = w0.cos();
        let sin_w0 = w0.sin();
        let alpha = sin_w0 / (2.0 * q);
        let b0 = (1.0 - cos_w0) / 2.0;
        let b1 = 1.0 - cos_w0;
        let b2 = (1.0 - cos_w0) / 2.0;
        let a0 = 1.0 + alpha;
        let a1 = -2.0 * cos_w0;
        let a2 = 1.0 - alpha;
        Self {
            b0: b0 / a0,
            b1: b1 / a0,
            b2: b2 / a0,
            a1: a1 / a0,
            a2: a2 / a0,
            z1: 0.0,
            z2: 0.0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let output = self.b0 * input + self.z1;
        self.z1 = self.b1 * input - self.a1 * output + self.z2;
        self.z2 = self.b2 * input - self.a2 * output;
        output
    }
}

/// A simple all‑pass filter for diffusion.
struct AllPass {
    feedback: f32,
    buffer: Vec<f32>,
    index: usize,
}

impl AllPass {
    fn new(feedback: f32, delay_samples: usize) -> Self {
        Self {
            feedback,
            // Ensure at least one sample of delay.
            buffer: vec![0.0; delay_samples.max(1)],
            index: 0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let buffered = self.buffer[self.index];
        let output = -input + buffered;
        self.buffer[self.index] = input + buffered * self.feedback;
        self.index = (self.index + 1) % self.buffer.len();
        output
    }
}

/// Utility function to finalize an impulse response:
/// removes DC offset, performs energy normalization, and then peak normalization.
fn finalize_ir(ir: &mut [f32]) {
    // Remove DC offset.
    let sum: f32 = ir.iter().sum();
    if sum != 0.0 {
        let dc_offset = sum / (ir.len() as f32);
        for sample in ir.iter_mut() {
            *sample -= dc_offset;
        }
    }

    // Energy normalization.
    let energy: f32 = ir.iter().map(|x| x * x).sum();
    if energy > 0.0 {
        let compensation = 1.0 / energy.sqrt();
        for sample in ir.iter_mut() {
            *sample *= compensation;
        }
    }

    // Peak normalization.
    let max = ir.iter().map(|x| x.abs()).fold(0.0, f32::max);
    if max > 0.0 && max.is_finite() {
        let scale = 1.0 / max;
        for sample in ir.iter_mut() {
            *sample *= scale;
        }
    }
}

/// A public utility function that takes an impulse response, processes it,
/// and returns a new, normalized version.
pub fn process_impulse_response(mut ir: Vec<f32>) -> Vec<f32> {
    finalize_ir(&mut ir);
    ir
}

/// The impulse response generator.
pub struct ImpulseResponseGenerator {
    sample_rate: f32,
}

impl ImpulseResponseGenerator {
    pub fn new(sample_rate: f32) -> Self {
        Self { sample_rate }
    }

    /// Generate an enhanced plate reverb impulse response.
    pub fn plate(&self, decay_time: f32, diffusion: f32) -> Vec<f32> {
        // Clamp and validate parameters.
        let decay_time = decay_time.clamp(0.1, 10.0);
        let diffusion = diffusion.clamp(0.0, 1.0);
        let sample_rate = self.sample_rate.clamp(1.0, 192_000.0);
        let num_samples = ((decay_time * sample_rate) as usize).clamp(1, 60 * 48000);

        // Initialize WASM‑friendly RNG.
        let mut seed = [0u8; 32];
        let _ = getrandom(&mut seed);
        let mut rng = StdRng::from_seed(seed);

        // Generate white noise modulated by an exponential decay envelope.
        let mut ir: Vec<f32> = (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate;
                let envelope = (-4.0 * t / decay_time).exp();
                envelope * rng.gen_range(-1.0_f32..1.0_f32)
            })
            .collect();

        // --- Diffusion Stage: All‑Pass Filter Chain ---
        if diffusion > 0.0 {
            // Define delay times in seconds for the all‑pass filters.
            let delay_times = [0.010, 0.012, 0.015, 0.017];
            let mut allpass_chain: Vec<AllPass> = delay_times
                .iter()
                .map(|&dt| AllPass::new(diffusion, (dt * sample_rate) as usize))
                .collect();

            // Process each sample through the all‑pass chain.
            for sample in ir.iter_mut() {
                let mut processed = *sample;
                for ap in allpass_chain.iter_mut() {
                    processed = ap.process(processed);
                }
                *sample = processed;
            }
        }

        // --- Spectral Shaping: Biquad Low‑Pass Filter ---
        // Choose a cutoff that decreases with higher diffusion.
        let cutoff = (5000.0 - 4500.0 * diffusion).clamp(20.0, 20000.0);
        let mut lpf = BiquadLPF::new(cutoff, sample_rate);
        for sample in ir.iter_mut() {
            *sample = lpf.process(*sample);
        }

        // --- Early Reflection Simulation ---
        // Add a few delayed copies of the IR to simulate early reflections.
        let early_reflections = [
            ((0.005 * sample_rate) as usize, 0.7 * diffusion),
            ((0.012 * sample_rate) as usize, 0.5 * diffusion),
            ((0.020 * sample_rate) as usize, 0.3 * diffusion),
        ];
        let mut ir_with_reflections = ir.clone();
        for (delay, gain) in early_reflections.iter() {
            for i in 0..ir.len().saturating_sub(*delay) {
                ir_with_reflections[i + delay] += gain * ir[i];
            }
        }
        ir = ir_with_reflections;

        // --- Tail Fade-Out ---
        // Apply a linear fade to the final 10% of samples to smooth the end.
        let fade_len = (num_samples as f32 * 0.1) as usize;
        for i in (num_samples - fade_len)..num_samples {
            let fade = (num_samples - i) as f32 / fade_len as f32;
            ir[i] *= fade;
        }

        // --- Final Processing: Remove DC, energy normalize, and peak normalize ---
        finalize_ir(&mut ir);

        ir
    }
}
