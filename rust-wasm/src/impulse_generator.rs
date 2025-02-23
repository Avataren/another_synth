use getrandom::getrandom;
use rand::rngs::StdRng;
use rand::{Rng, SeedableRng}; // available on stable if you opt‑in to std::simd

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

/// A comb filter for the hall reverb.
struct CombFilter {
    feedback: f32,
    buffer: Vec<f32>,
    index: usize,
}

impl CombFilter {
    fn new(delay_samples: usize, feedback: f32) -> Self {
        Self {
            feedback,
            buffer: vec![0.0; delay_samples.max(1)],
            index: 0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let out = self.buffer[self.index];
        self.buffer[self.index] = input + out * self.feedback;
        self.index = (self.index + 1) % self.buffer.len();
        out
    }
}

/// Finalizes an impulse response by removing DC offset, energy normalization,
/// and then peak normalization. The loops here are written in a vectorizable way,
/// so that with the proper WASM/SIMD target the compiler can optimize them.
fn finalize_ir(ir: &mut [f32]) {
    // Remove DC offset.
    let sum: f32 = ir.iter().copied().sum();
    let dc_offset = sum / (ir.len() as f32);
    for sample in ir.iter_mut() {
        *sample -= dc_offset;
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
        // Clamp parameters.
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
            // Use a chain of all‑pass filters with fixed delay times.
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
        for &(delay, gain) in early_reflections.iter() {
            for i in 0..ir.len().saturating_sub(delay) {
                ir[i + delay] += gain * ir[i];
            }
        }

        // --- Tail Fade-Out ---
        // Apply a linear fade to the final 10% of samples.
        let fade_len = (num_samples as f32 * 0.1) as usize;
        for i in (num_samples - fade_len)..num_samples {
            let fade = (num_samples - i) as f32 / fade_len as f32;
            ir[i] *= fade;
        }

        // --- Final Processing ---
        finalize_ir(&mut ir);
        ir
    }

    /// Generate a hall reverb impulse response using parallel comb filters
    /// and a series all‑pass filter chain for diffusion.
    pub fn hall(&self, decay_time: f32, room_size: f32) -> Vec<f32> {
        // Clamp parameters.
        let decay_time = decay_time.clamp(0.1, 10.0);
        // room_size in [0.1, 1.0]: higher values mean a larger room.
        let room_size = room_size.clamp(0.1, 1.0);
        let sample_rate = self.sample_rate.clamp(1.0, 192_000.0);
        let num_samples = ((decay_time * sample_rate) as usize).clamp(1, 60 * 48000);

        let mut seed = [0u8; 32];
        let _ = getrandom(&mut seed);
        let mut rng = StdRng::from_seed(seed);

        // Generate noise input with an exponential decay envelope.
        let noise: Vec<f32> = (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate;
                let envelope = (-4.0 * t / decay_time).exp();
                envelope * rng.gen_range(-1.0_f32..1.0_f32)
            })
            .collect();

        // --- Parallel Comb Filters ---
        // Define base delay times (in seconds) typical for hall reverb.
        let base_delays = [0.0297, 0.0371, 0.0411, 0.0437];
        // Scale delays by room_size.
        let comb_delays: Vec<usize> = base_delays
            .iter()
            .map(|&d| ((d * room_size) * sample_rate) as usize)
            .collect();
        // Compute feedback for each comb filter using a T60 decay formula.
        let comb_filters: Vec<CombFilter> = comb_delays
            .iter()
            .map(|&delay_samples| {
                let delay_secs = delay_samples as f32 / sample_rate;
                // Feedback computed so that energy decays ~60 dB over decay_time.
                let feedback = (-6.9078 * delay_secs / decay_time).exp();
                CombFilter::new(delay_samples, feedback)
            })
            .collect();

        // Process the noise through each comb filter in parallel and sum the outputs.
        let mut comb_outputs = vec![0.0_f32; num_samples];
        let mut combs: Vec<CombFilter> = comb_filters;
        for i in 0..num_samples {
            let input = noise[i];
            let mut sum = 0.0;
            for comb in combs.iter_mut() {
                sum += comb.process(input);
            }
            comb_outputs[i] = sum;
        }

        // --- Diffusion Stage: Series All‑Pass Filter Chain ---
        // Use a short all‑pass chain to smooth the comb output.
        let allpass_delays = [0.005, 0.007];
        let mut allpass_chain: Vec<AllPass> = allpass_delays
            .iter()
            .map(|&dt| AllPass::new(0.5, (dt * sample_rate) as usize))
            .collect();
        for sample in comb_outputs.iter_mut() {
            let mut processed = *sample;
            for ap in allpass_chain.iter_mut() {
                processed = ap.process(processed);
            }
            *sample = processed;
        }

        // --- Spectral Shaping: Biquad Low‑Pass Filter ---
        // For hall reverb, a higher cutoff preserves more high frequencies.
        let cutoff = (7000.0 - 6000.0 * (room_size - 0.1) / 0.9).clamp(200.0, 20000.0);
        let mut lpf = BiquadLPF::new(cutoff, sample_rate);
        for sample in comb_outputs.iter_mut() {
            *sample = lpf.process(*sample);
        }

        // --- Tail Fade-Out ---
        let fade_len = (num_samples as f32 * 0.1) as usize;
        for i in (num_samples - fade_len)..num_samples {
            let fade = (num_samples - i) as f32 / fade_len as f32;
            comb_outputs[i] *= fade;
        }

        // --- Final Processing ---
        finalize_ir(&mut comb_outputs);
        comb_outputs
    }
}
