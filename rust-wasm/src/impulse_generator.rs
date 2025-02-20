use rand::Rng;

struct SinglePoleLPF {
    a0: f32,
    b1: f32,
    z: f32,
}

impl SinglePoleLPF {
    fn new(cutoff: f32, sample_rate: f32) -> Self {
        let cutoff = cutoff.clamp(20.0, 20_000.0);
        let sample_rate = sample_rate.clamp(1.0, 192_000.0);

        let rc = 1.0 / (2.0 * std::f32::consts::PI * cutoff);
        let dt = 1.0 / sample_rate;
        let alpha = dt / (rc + dt).max(1e-9);

        Self {
            a0: alpha.clamp(0.0, 1.0),
            b1: (1.0 - alpha).clamp(0.0, 1.0),
            z: 0.0,
        }
    }

    fn process(&mut self, input: f32) -> f32 {
        let input = input.clamp(-1.0, 1.0);
        self.z = (input * self.a0 + self.z * self.b1).clamp(-1.0, 1.0);
        self.z
    }
}

pub struct ImpulseResponseGenerator {
    sample_rate: f32,
}

impl ImpulseResponseGenerator {
    pub fn new(sample_rate: f32) -> Self {
        Self { sample_rate }
    }

    /// Generate an exponentially decaying impulse response
    pub fn exponential_decay(&self, length_ms: f32, decay_rate: f32) -> Vec<f32> {
        let num_samples = (length_ms * 0.001 * self.sample_rate) as usize;
        let mut ir = Vec::with_capacity(num_samples);

        for i in 0..num_samples {
            let t = i as f32 / self.sample_rate;
            ir.push((-decay_rate * t).exp());
        }

        ir
    }

    /// Generate a sine-modulated decay impulse response
    pub fn sine_decay(&self, length_ms: f32, freq: f32, decay_rate: f32) -> Vec<f32> {
        let num_samples = (length_ms * 0.001 * self.sample_rate) as usize;
        let mut ir = Vec::with_capacity(num_samples);

        for i in 0..num_samples {
            let t = i as f32 / self.sample_rate;
            let decay = (-decay_rate * t).exp();
            let sine = (2.0 * std::f32::consts::PI * freq * t).sin();
            ir.push(decay * sine);
        }

        ir
    }

    /// Generate a comb filter impulse response
    pub fn comb(&self, delay_ms: f32, feedback: f32, length_ms: f32) -> Vec<f32> {
        let num_samples = (length_ms * 0.001 * self.sample_rate) as usize;
        let delay_samples = (delay_ms * 0.001 * self.sample_rate) as usize;
        let mut ir = vec![0.0; num_samples];

        let mut amplitude = 1.0;
        let mut pos = 0;

        while pos < num_samples && amplitude > 0.001 {
            ir[pos] = amplitude;
            amplitude *= feedback;
            pos += delay_samples;
        }

        ir
    }

    /// Generate an early reflection pattern (simple room simulation)
    pub fn early_reflections(&self, room_size: f32, num_reflections: usize) -> Vec<f32> {
        use rand::rngs::OsRng;
        use rand::Rng; // More WASM-friendly than thread_rng

        let speed_of_sound = 343.0; // meters per second
        let max_delay = (room_size * 2.0 / speed_of_sound * 1000.0) as f32; // in ms
        let ir_length = (max_delay * 1.5) as f32; // add some extra length

        let mut ir = self.exponential_decay(ir_length, 4.0);

        // Add some random early reflections
        let mut rng = OsRng; // Uses system randomness through JavaScript's crypto API
        for _ in 0..num_reflections {
            let delay = (rng.gen::<f32>() * max_delay * 0.001 * self.sample_rate) as usize;
            let amplitude = rng.gen::<f32>() * 0.5 + 0.5;
            if delay < ir.len() {
                ir[delay] += amplitude;
            }
        }

        ir
    }

    /// Generate a basic plate reverb simulation
    pub fn plate(&self, decay_time: f32, diffusion: f32) -> Vec<f32> {
        use getrandom::getrandom;
        use rand::rngs::StdRng;
        use rand::Rng;
        use rand::SeedableRng;

        // Clamp and validate parameters.
        let decay_time = decay_time.clamp(0.1, 10.0);
        let diffusion = diffusion.clamp(0.0, 1.0);
        let sample_rate = self.sample_rate.clamp(1.0, 192000.0);
        let num_samples = ((decay_time * sample_rate) as usize).clamp(1, 60 * 48000);

        // Initialize WASM-friendly RNG.
        let mut seed = [0u8; 32];
        let _ = getrandom(&mut seed);
        let mut rng = StdRng::from_seed(seed);

        // Generate white noise modulated by an exponential decay envelope.
        let mut ir: Vec<f32> = (0..num_samples)
            .map(|i| {
                let t = i as f32 / sample_rate;
                let envelope = (-t / decay_time).exp();
                envelope * rng.gen_range(-1.0_f32..1.0_f32)
            })
            .collect();

        // Apply recursive (IIR) smoothing for diffusion.
        // This reduces rapid fluctuations without the periodicity a moving average might introduce.
        if diffusion > 0.0 {
            // The smoothing factor controls how much neighboring samples influence each other.
            let smoothing_coeff = diffusion * 0.1; // tweak this factor as needed
            for i in 1..num_samples {
                ir[i] = (1.0 - smoothing_coeff) * ir[i - 1] + smoothing_coeff * ir[i];
            }
        }

        // Apply a single-pole low-pass filter to mimic natural spectral roll-off.
        let cutoff = (5000.0_f32 - 4500.0_f32 * diffusion).clamp(20.0_f32, 20000.0_f32);
        let mut filter = SinglePoleLPF::new(cutoff, sample_rate);
        for sample in ir.iter_mut() {
            *sample = filter.process(*sample);
        }

        // Normalize the impulse response so that its peak amplitude is 1.
        let max_val = ir.iter().fold(1e-9_f32, |max, &x| max.max(x.abs()));
        for sample in ir.iter_mut() {
            *sample /= max_val;
        }

        ir
    }

    /// Normalize an impulse response to have a peak amplitude of 1.0
    pub fn normalize(mut ir: Vec<f32>) -> Vec<f32> {
        if let Some(max) = ir
            .iter()
            .map(|x| x.abs())
            .max_by(|a, b| a.partial_cmp(b).unwrap())
        {
            if max > 0.0 {
                for sample in ir.iter_mut() {
                    *sample /= max;
                }
            }
        }
        ir
    }
}
